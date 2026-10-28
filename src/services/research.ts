import { formatDateTime, TIMEFRAME_MS, type UnixMs } from "@/core/time";
import {
  combineBaselines,
  judge,
  randomBaseline,
  runBacktest,
  summarize,
  type BaselineResult,
  type SignalOutcome,
  type TradeStats,
  type VerdictReport,
} from "@/modules/backtest";
import type { Gap, MarketDataSource, MarketSymbol } from "@/modules/market-data";
import type { FileArchive } from "@/modules/storage";
import type { SignalDirection, Strategy } from "@/modules/strategies";
import { ingestHistory } from "./ingest-history";
import { configurationKey } from "./journal-key";

const DAY = 86_400_000;
const NO_COSTS = { feeRate: 0, slippage: 0 };

export const SEGMENTS = ["research", "validation", "holdout"] as const;
export type Segment = (typeof SEGMENTS)[number];

/** Хронологическое разбиение 60/20/20 (validation-plan §2). Фиксируется один раз. */
export interface SplitPlan {
  from: UnixMs;
  researchEnd: UnixMs;
  validationEnd: UnixMs;
  to: UnixMs;
  createdAt: UnixMs;
}

export const SPLIT_FILE = "research/split.json";
export const JOURNAL = "research/journal";

export function planSplit(from: UnixMs, to: UnixMs, createdAt: UnixMs): SplitPlan {
  const start = Math.floor(from / DAY) * DAY;
  const end = Math.floor(to / DAY) * DAY;
  if (end - start < 10 * DAY) throw new RangeError("Split period must be at least 10 days");
  const at = (share: number) => start + Math.round(((end - start) * share) / DAY) * DAY;
  return { from: start, researchEnd: at(0.6), validationEnd: at(0.8), to: end, createdAt };
}

export function segmentRange(plan: SplitPlan, segment: Segment): { from: UnixMs; to: UnixMs } {
  if (segment === "research") return { from: plan.from, to: plan.researchEnd };
  if (segment === "validation") return { from: plan.researchEnd, to: plan.validationEnd };
  return { from: plan.validationEnd, to: plan.to };
}

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

/** Запись журнала исследований (validation-plan §5): каждый прогон, включая неудачные. */
export interface JournalEntry {
  at: UnixMs;
  codeCommit: string | null;
  strategyId: string;
  strategyVersion: string;
  segment: Segment;
  from: UnixMs;
  to: UnixMs;
  symbols: MarketSymbol[];
  seed: number;
  runs: number;
  trades: number;
  expectancyR: number;
  ci95: [number, number] | null;
  /** Матожидание без издержек (диагностика); в старых записях может отсутствовать. */
  grossExpectancyR?: number;
  baselineP95: number;
  verdict: VerdictReport["verdict"];
  checks: CheckResult[];
}

export class HoldoutUsedError extends Error {
  override name = "HoldoutUsedError";
}

/**
 * Отложенная выборка проверяется один раз на версию стратегии. Повторная
 * проверка после изменений требует новой версии и новых данных.
 */
export function assertHoldoutAllowed(journal: readonly JournalEntry[], strategy: Strategy): void {
  const used = journal.find((e) => e.segment === "holdout" && e.strategyId === strategy.id && e.strategyVersion === strategy.version);
  if (used) {
    throw new HoldoutUsedError(
      `Holdout for ${strategy.id}@${strategy.version} was already evaluated at ${new Date(used.at).toISOString()} (verdict: ${used.verdict}). ` +
        "Change the strategy version and use fresh data (forward test) instead.",
    );
  }
}

export interface SymbolResearch {
  symbol: MarketSymbol;
  candles: number;
  gaps: Gap[];
  signals: number;
  skippedOverlap: number;
  /** Сделки, не завершившиеся до конца части, — не учитываются (данные после неё не читаются). */
  pending: number;
  stats: TradeStats;
  /** Диагностика: те же сделки без комиссий и проскальзывания — отделяет логику входа от издержек. */
  grossStats: TradeStats;
}

/** Разбивка по направлению (validation-plan §4) со своей случайной базовой линией. */
export interface DirectionBreakdown {
  direction: SignalDirection;
  stats: TradeStats;
  grossExpectancyR: number;
  /**
   * Случайные входы только этого направления (те же стоп, цель, срок). Если
   * стратегия не лучше их, результат объясняется движением рынка за период
   * (например, общим ростом для long), а не правилом входа.
   */
  baseline: BaselineResult;
}

export interface MonthBreakdown {
  month: string;
  trades: number;
  totalR: number;
  expectancyR: number;
}

export interface ResearchResult {
  strategyId: string;
  strategyVersion: string;
  segment: Segment;
  range: { from: UnixMs; to: UnixMs };
  perSymbol: SymbolResearch[];
  stats: TradeStats;
  grossStats: TradeStats;
  baseline: BaselineResult;
  topSymbolShare: number | null;
  report: VerdictReport;
  byDirection: DirectionBreakdown[];
  byMonth: MonthBreakdown[];
}

export interface ResearchOptions {
  source: MarketDataSource;
  archive: FileArchive;
  strategy: Strategy;
  symbols: MarketSymbol[];
  plan: SplitPlan;
  segment: Segment;
  runs?: number;
  seed?: number;
  now?: () => UnixMs;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Прогон стратегии на одной части разбиения. Свечи загружаются в архив с
 * прогревом до начала части; данные после конца части не читаются.
 */
export async function runResearch(opts: ResearchOptions): Promise<ResearchResult> {
  const { source, archive, strategy, symbols, plan, segment } = opts;
  const runs = opts.runs ?? 1000;
  const seed = opts.seed ?? 1;
  const now = opts.now ?? Date.now;
  const range = segmentRange(plan, segment);
  if (range.to > now()) throw new RangeError(`Segment ${segment} ends in the future (${new Date(range.to).toISOString()})`);
  const size = TIMEFRAME_MS[strategy.timeframe];
  const warmupFrom = range.from - strategy.lookback * size;

  const perSymbol: SymbolResearch[] = [];
  const outcomes: SignalOutcome[] = [];
  const gross: SignalOutcome[] = [];
  const baselines: BaselineResult[] = [];
  const totalBySymbol: number[] = [];
  const directionTrades: Record<SignalDirection, { net: SignalOutcome[]; gross: SignalOutcome[]; baselines: BaselineResult[] }> = {
    long: { net: [], gross: [], baselines: [] },
    short: { net: [], gross: [], baselines: [] },
  };

  for (const [k, symbol] of symbols.entries()) {
    const ingest = await ingestHistory({
      source, store: archive, symbol, timeframe: strategy.timeframe, from: warmupFrom, to: range.to, now,
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
    const candles = archive.getCandles(source.id, { symbol, timeframe: strategy.timeframe, from: warmupFrom, to: range.to });
    const result = runBacktest(strategy, candles, { from: range.from });
    const symbolOutcomes = result.trades.map((t) => t.outcome);
    const stats = summarize(symbolOutcomes, { seed });
    outcomes.push(...symbolOutcomes);
    const grossTrades = runBacktest(strategy, candles, { from: range.from, costs: NO_COSTS }).trades;
    const grossOutcomes = grossTrades.map((t) => t.outcome);
    gross.push(...grossOutcomes);
    baselines.push(randomBaseline(result.trades, candles, { runs, seed: seed + k, from: range.from }));
    for (const [d, direction] of (["long", "short"] as const).entries()) {
      const own = result.trades.filter((t) => t.signal.direction === direction);
      directionTrades[direction].net.push(...own.map((t) => t.outcome));
      directionTrades[direction].gross.push(...grossTrades.filter((t) => t.signal.direction === direction).map((t) => t.outcome));
      // Отдельные зёрна: общая базовая линия выше остаётся воспроизводимой.
      directionTrades[direction].baselines.push(randomBaseline(own, candles, { runs, seed: seed + 1000 * (d + 1) + k, from: range.from }));
    }
    totalBySymbol.push(stats.totalR);
    perSymbol.push({
      symbol,
      candles: candles.length,
      gaps: ingest.gaps.filter((g) => g.to > range.from),
      signals: result.signals.length,
      skippedOverlap: result.skippedOverlap,
      pending: result.pending,
      stats,
      grossStats: summarize(grossOutcomes, { seed }),
    });
  }

  const stats = summarize(outcomes, { seed });
  const grossStats = summarize(gross, { seed });
  const baseline = combineBaselines(baselines);
  const topSymbolShare = stats.totalR > 0 ? Math.max(...totalBySymbol) / stats.totalR : null;
  const report = judge(stats, baseline, symbols.length > 1 ? { topSymbolShare } : undefined);
  const byDirection = (["long", "short"] as const).map((direction) => ({
    direction,
    stats: summarize(directionTrades[direction].net, { seed }),
    grossExpectancyR: summarize(directionTrades[direction].gross, { seed }).expectancyR,
    baseline: combineBaselines(directionTrades[direction].baselines),
  }));
  return {
    strategyId: strategy.id, strategyVersion: strategy.version, segment, range, perSymbol, stats, grossStats, baseline, topSymbolShare, report,
    byDirection, byMonth: monthBreakdown(outcomes),
  };
}

/** Сделки по месяцу входа (UTC). */
export function monthBreakdown(outcomes: readonly SignalOutcome[]): MonthBreakdown[] {
  const months = new Map<string, number[]>();
  for (const o of outcomes) {
    if (o.rMultiple === undefined || o.entryTime === undefined) continue;
    const m = new Date(o.entryTime).toISOString().slice(0, 7);
    months.set(m, [...(months.get(m) ?? []), o.rMultiple]);
  }
  return [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, rs]) => {
      const totalR = rs.reduce((a, b) => a + b, 0);
      return { month, trades: rs.length, totalR, expectancyR: totalR / rs.length };
    });
}

export function journalEntry(r: ResearchResult, meta: { at: UnixMs; codeCommit: string | null; seed: number; runs: number }): JournalEntry {
  return {
    at: meta.at,
    codeCommit: meta.codeCommit,
    strategyId: r.strategyId,
    strategyVersion: r.strategyVersion,
    segment: r.segment,
    from: r.range.from,
    to: r.range.to,
    symbols: r.perSymbol.map((s) => s.symbol),
    seed: meta.seed,
    runs: meta.runs,
    trades: r.stats.trades,
    expectancyR: r.stats.expectancyR,
    ci95: r.stats.ci95,
    grossExpectancyR: r.grossStats.expectancyR,
    baselineP95: r.baseline.p95,
    verdict: r.report.verdict,
    checks: r.report.checks,
  };
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const r3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "—");

export function renderResearchReport(r: ResearchResult, plan: SplitPlan, journal: readonly JournalEntry[], meta: { at: UnixMs; codeCommit: string | null }): string {
  const lines = [
    `# Исследование: ${r.strategyId}@${r.strategyVersion} — часть «${r.segment}»`,
    "",
    `Запуск: ${formatDateTime(meta.at)} МСК, код ${meta.codeCommit?.slice(0, 7) ?? "—"}.`,
    `Период части: ${day(r.range.from)} .. ${day(r.range.to)} (не включительно).`,
    `Разбиение (зафиксировано ${day(plan.createdAt)}): research ${day(plan.from)}..${day(plan.researchEnd)}, ` +
      `validation ..${day(plan.validationEnd)}, holdout ..${day(plan.to)}.`,
    "",
    "> Исторический прогон — не доказательство прибыльности. Вывод действителен только для однократного",
    "> прогона отложенной части и подтверждения в перспективном тесте (docs/validation-plan.md §2, §6).",
    "",
    "## По символам",
    "",
    "| Символ | Свечей | Пропуски | Сигналов | Пропущено (открыт другой) | Не завершились | Сделок | Матожидание, R | Без издержек, R | Итого, R |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...r.perSymbol.map(
      (s) =>
        `| ${s.symbol} | ${s.candles} | ${s.gaps.reduce((a, g) => a + g.missing, 0)} | ${s.signals} | ${s.skippedOverlap} | ${s.pending} | ${s.stats.trades} | ${r3(s.stats.expectancyR)} | ${r3(s.grossStats.expectancyR)} | ${r3(s.stats.totalR)} |`,
    ),
    "",
    "## Итог по всем символам",
    "",
    `- Исходы: ${Object.entries(r.stats.byStatus).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    `- Сделок: ${r.stats.trades}, итого ${r3(r.stats.totalR)} R, матожидание ${r3(r.stats.expectancyR)} R` +
      (r.stats.ci95 ? `, 95% CI [${r3(r.stats.ci95[0])}, ${r3(r.stats.ci95[1])}]` : ""),
    `- Win rate ${r3(r.stats.winRate)}, средний выигрыш ${r3(r.stats.avgWinR)} R, средний проигрыш ${r3(r.stats.avgLossR)} R, PF ${r3(r.stats.profitFactor)}`,
    `- Без издержек (диагностика, не критерий): матожидание ${r3(r.grossStats.expectancyR)} R` +
      (r.grossStats.ci95 ? `, 95% CI [${r3(r.grossStats.ci95[0])}, ${r3(r.grossStats.ci95[1])}]` : ""),
    `- Макс. просадка ${r3(r.stats.maxDrawdownR)} R`,
    `- Случайные входы: ${r.baseline.runs} прогонов, медиана ${r3(r.baseline.p50)} R, p95 ${r3(r.baseline.p95)} R`,
    "",
    "## По направлениям",
    "",
    "| Направление | Сделок | Матожидание, R | 95% CI | Без издержек, R | Случайные того же направления: медиана / p95, R |",
    "|---|---|---|---|---|---|",
    ...r.byDirection.map(
      (d) =>
        `| ${d.direction} | ${d.stats.trades} | ${r3(d.stats.expectancyR)} | ${d.stats.ci95 ? `[${r3(d.stats.ci95[0])}, ${r3(d.stats.ci95[1])}]` : "—"} | ` +
        `${r3(d.grossExpectancyR)} | ${r3(d.baseline.p50)} / ${r3(d.baseline.p95)} |`,
    ),
    "",
    "Если матожидание направления не выше медианы случайных входов того же направления, результат объясняется",
    "движением рынка за период, а не правилом входа.",
    "",
    "## По месяцам (вход, UTC)",
    "",
    "| Месяц | Сделок | Итого, R | Матожидание, R |",
    "|---|---|---|---|",
    ...r.byMonth.map((m) => `| ${m.month} | ${m.trades} | ${r3(m.totalR)} | ${r3(m.expectancyR)} |`),
    "",
    "## Критерии отказа (strategy-spec §6)",
    "",
    ...r.report.checks.map((c) => `- [${c.passed ? "x" : " "}] ${c.name}: ${c.detail}`),
    "",
    `**Вердикт: ${r.report.verdict}**`,
    "",
    "## Журнал исследований",
    "",
    `Прогонов этой стратегии: ${journal.filter((e) => e.strategyId === r.strategyId).length} ` +
      `(версии: ${[...new Set(journal.filter((e) => e.strategyId === r.strategyId).map((e) => e.strategyVersion))].join(", ")}). ` +
      `Всего в журнале: ${journal.length} прогонов, ` +
      `${new Set(journal.map(configurationKey)).size} конфигураций (стратегия, версия и набор символов). ` +
      "Число испробованных конфигураций учитывается при оценке (validation-plan §5).",
  ];
  return `${lines.join("\n")}\n`;
}
