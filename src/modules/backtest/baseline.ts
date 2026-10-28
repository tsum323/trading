import { createRng, quantile } from "@/core/random";
import type { Candle } from "@/modules/market-data";
import { DEFAULT_COSTS, evaluateSignal, type ExecutionCosts } from "./outcome";
import { windowBars, type Trade } from "./run";

export interface BaselineResult {
  runs: number;
  /** Матожидание в R каждого прогона, по возрастанию. */
  expectancies: number[];
  p50: number;
  p95: number;
  /** Сумма R и число сделок каждого прогона в порядке прогонов — для объединения символов. */
  perRun: { sum: number; count: number }[];
}

/**
 * Объединяет базовые линии нескольких символов: прогон i — это сделки
 * прогона i каждого символа вместе. Прогоны символов независимы, поэтому
 * складывать их по номеру корректно (а отсортированные квантили — нет).
 */
export function combineBaselines(parts: readonly BaselineResult[]): BaselineResult {
  const runs = Math.max(0, ...parts.map((p) => p.perRun.length));
  const perRun = Array.from({ length: runs }, (_, i) =>
    parts.reduce((acc, p) => ({ sum: acc.sum + (p.perRun[i]?.sum ?? 0), count: acc.count + (p.perRun[i]?.count ?? 0) }), { sum: 0, count: 0 }),
  );
  return fromPerRun(perRun);
}

function fromPerRun(perRun: { sum: number; count: number }[]): BaselineResult {
  const expectancies = perRun.filter((r) => r.count > 0).map((r) => r.sum / r.count).sort((a, b) => a - b);
  return { runs: expectancies.length, expectancies, p50: quantile(expectancies, 0.5), p95: quantile(expectancies, 0.95), perRun };
}

/**
 * Случайная базовая линия (validation-plan §4): в каждом прогоне для каждой
 * сделки стратегии берётся случайная закрытая свеча из того же периода, и
 * от её close строится сигнал с тем же направлением, теми же относительными
 * расстояниями до стопа и цели и тем же сроком. Исход — тем же оценщиком.
 */
export function randomBaseline(
  trades: readonly Trade[],
  candles: readonly Candle[],
  opts: { runs?: number; seed?: number; costs?: ExecutionCosts; from?: number } = {},
): BaselineResult {
  const runs = opts.runs ?? 1000;
  const costs = opts.costs ?? DEFAULT_COSTS;
  const rng = createRng(opts.seed ?? 1);
  const closed = candles.filter((c) => c.isClosed);
  const asOf = closed.at(-1)?.closeTime ?? 0;
  const first = opts.from === undefined ? 0 : closed.findIndex((c) => c.closeTime >= opts.from!);

  const templates = trades
    .filter((t) => t.outcome.rMultiple !== undefined)
    .map(({ signal }) => {
      const ref = signal.entry.referencePrice;
      return {
        signal,
        stopPct: (signal.stopLoss - ref) / ref,
        targetPct: (signal.takeProfits[0]! - ref) / ref,
        duration: signal.expiresAt - signal.basisCloseTime,
        bars: windowBars(signal),
      };
    });

  const perRun: { sum: number; count: number }[] = [];
  if (templates.length === 0 || first < 0) return fromPerRun(perRun);

  for (let run = 0; run < runs; run++) {
    let sum = 0;
    let count = 0;
    for (const t of templates) {
      const last = closed.length - 1 - t.bars;
      if (last <= first) continue;
      const i = first + Math.floor(rng() * (last - first));
      const basis = closed[i]!;
      const ref = basis.close;
      const outcome = evaluateSignal(
        {
          ...t.signal,
          id: `baseline:${run}:${i}`,
          createdAt: basis.closeTime,
          basisCloseTime: basis.closeTime,
          entry: { type: "next-open", referencePrice: ref },
          stopLoss: ref * (1 + t.stopPct),
          takeProfits: [ref * (1 + t.targetPct)],
          expiresAt: basis.closeTime + t.duration,
        },
        closed.slice(i + 1, i + 2 + t.bars),
        asOf,
        costs,
      );
      if (outcome.status !== "pending" && outcome.rMultiple !== undefined) {
        sum += outcome.rMultiple;
        count++;
      }
    }
    perRun.push({ sum, count });
  }
  return fromPerRun(perRun);
}
