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

  const expectancies: number[] = [];
  if (templates.length === 0 || first < 0) return { runs: 0, expectancies, p50: Number.NaN, p95: Number.NaN };

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
    if (count > 0) expectancies.push(sum / count);
  }
  expectancies.sort((a, b) => a - b);
  return { runs: expectancies.length, expectancies, p50: quantile(expectancies, 0.5), p95: quantile(expectancies, 0.95) };
}
