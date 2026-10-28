import { summarize, type SignalOutcome } from "@/modules/backtest";
import type { FileArchive } from "@/modules/storage";
import type { Strategy } from "@/modules/strategies";
import { outcomesLog, signalsLog, type LiveSignalRecord, type SymbolCycleReport } from "./live-cycle";

const iso = (t: number | null) => (t === null ? "—" : new Date(t).toISOString().slice(0, 16).replace("T", " "));
const r3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : String(x));

/** Markdown-отчёт перспективного теста. Запоздалые сигналы показаны, но в статистику не входят. */
export function renderLiveReport(archive: FileArchive, strategy: Strategy, cycle: SymbolCycleReport[], generatedAt: number): string {
  const records = archive.readJsonl<LiveSignalRecord>(signalsLog(strategy));
  const outcomes = new Map(archive.readJsonl<SignalOutcome>(outcomesLog(strategy)).map((o) => [o.signalId, o]));
  const onTime = records.filter((r) => !r.late);
  const versions = [...new Set(records.map((r) => r.signal.strategyVersion))];
  const stats = summarize(onTime.map((r) => outcomes.get(r.signal.id)).filter((o): o is SignalOutcome => o !== undefined));

  const lines = [
    `# Перспективный тест: ${strategy.id}@${strategy.version}`,
    "",
    `Обновлено: ${iso(generatedAt)} UTC. Сигналы формируются на живых публичных данных и только дописываются.`,
    "",
    "> Это не доказательство прибыльности. Минимум для выводов — 8 недель и 50 сигналов",
    "> (docs/validation-plan.md §6). Исполнения ордеров нет.",
    "",
    "## Данные",
    "",
    "| Символ | Последняя закрытая свеча | Получено за цикл | Пропуски | Новых сигналов | Пропущено (открыт другой) |",
    "|---|---|---|---|---|---|",
    ...cycle.map(
      (c) =>
        `| ${c.symbol} | ${iso(c.lastClose)} | ${c.received}${c.bootstrap ? " (прогрев)" : ""} | ${c.gaps.reduce((s, g) => s + g.missing, 0)} | ${c.newSignals.length} | ${c.skippedOverlap} |`,
    ),
    "",
    "## Статистика (без запоздалых)",
    "",
    `- Сигналов всего: ${records.length}, вовремя: ${onTime.length}, запоздалых: ${records.length - onTime.length}`,
    `- Версии стратегии в журнале: ${versions.join(", ") || "—"}`,
    `- Исходы: ${Object.entries(stats.byStatus).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    ...(stats.trades === 0
      ? ["- Сделок с результатом пока нет."]
      : [
          `- Сделок с результатом: ${stats.trades}, итого ${r3(stats.totalR)} R, матожидание ${r3(stats.expectancyR)} R` +
            (stats.ci95 ? `, 95% CI [${r3(stats.ci95[0])}, ${r3(stats.ci95[1])}]` : ""),
          `- Win rate ${r3(stats.winRate)}, PF ${r3(stats.profitFactor)}, макс. просадка ${r3(stats.maxDrawdownR)} R`,
        ]),
    "",
    "## Открытые сигналы",
    "",
  ];
  const open = cycle.flatMap((c) => c.openSignals);
  if (open.length === 0) lines.push("Нет.");
  else {
    lines.push("| Символ | Решение | Направление | Опорная цена | Стоп | Цель | Истекает |", "|---|---|---|---|---|---|---|");
    for (const s of open) {
      lines.push(`| ${s.symbol} | ${iso(s.createdAt)} | ${s.direction} | ${s.entry.referencePrice} | ${r3(s.stopLoss)} | ${r3(s.takeProfits[0]!)} | ${iso(s.expiresAt)} |`);
    }
  }
  lines.push("", "## Последние исходы", "");
  const recent = records.filter((r) => outcomes.has(r.signal.id)).slice(-10).reverse();
  if (recent.length === 0) lines.push("Пока нет.");
  else {
    lines.push("| Символ | Решение | Направление | Исход | R | Запоздал |", "|---|---|---|---|---|---|");
    for (const r of recent) {
      const o = outcomes.get(r.signal.id)!;
      lines.push(`| ${r.signal.symbol} | ${iso(r.signal.createdAt)} | ${r.signal.direction} | ${o.status} | ${o.rMultiple === undefined ? "—" : r3(o.rMultiple)} | ${r.late ? "да" : "нет"} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}
