import { createRng, quantile } from "@/core/random";
import type { OutcomeStatus, SignalOutcome } from "./outcome";

const DAY = 86_400_000;
const R_STATUSES: ReadonlySet<OutcomeStatus> = new Set(["target", "stop", "expired", "ambiguous"]);

export interface TradeStats {
  byStatus: Record<OutcomeStatus, number>;
  /** Сделки с результатом в R (target, stop, expired, ambiguous). */
  trades: number;
  totalR: number;
  expectancyR: number;
  /** 95% интервал матожидания, блоковый бутстреп по UTC-дням входа; null, если сделок < 2. */
  ci95: [number, number] | null;
  winRate: number;
  avgWinR: number;
  avgLossR: number;
  profitFactor: number;
  maxDrawdownR: number;
  /** Доля суммарного R, приходящаяся на лучший месяц (при totalR > 0), иначе null. */
  topMonthShare: number | null;
}

export function summarize(outcomes: readonly SignalOutcome[], opts: { iterations?: number; seed?: number } = {}): TradeStats {
  const byStatus: Record<OutcomeStatus, number> = { target: 0, stop: 0, expired: 0, ambiguous: 0, "no-entry": 0, "data-gap": 0 };
  for (const o of outcomes) byStatus[o.status]++;

  const rated = outcomes
    .filter((o) => R_STATUSES.has(o.status) && o.rMultiple !== undefined)
    .sort((a, b) => a.entryTime! - b.entryTime!);
  const rs = rated.map((o) => o.rMultiple!);
  const totalR = rs.reduce((s, r) => s + r, 0);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const grossLoss = -losses.reduce((s, r) => s + r, 0);

  let peak = 0;
  let equity = 0;
  let maxDrawdownR = 0;
  for (const r of rs) {
    equity += r;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }

  const byMonth = new Map<string, number>();
  for (const o of rated) {
    const key = new Date(o.entryTime!).toISOString().slice(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? 0) + o.rMultiple!);
  }

  return {
    byStatus,
    trades: rs.length,
    totalR,
    expectancyR: rs.length ? totalR / rs.length : Number.NaN,
    ci95: bootstrapByDay(rated, opts.iterations ?? 2000, opts.seed ?? 1),
    winRate: rs.length ? wins.length / rs.length : Number.NaN,
    avgWinR: wins.length ? wins.reduce((s, r) => s + r, 0) / wins.length : Number.NaN,
    avgLossR: losses.length ? -grossLoss / losses.length : Number.NaN,
    profitFactor: grossLoss > 0 ? wins.reduce((s, r) => s + r, 0) / grossLoss : Number.POSITIVE_INFINITY,
    maxDrawdownR,
    topMonthShare: totalR > 0 ? Math.max(...byMonth.values()) / totalR : null,
  };
}

/** Блоковый бутстреп: дни выбираются с возвращением, чтобы учесть автокорреляцию сделок внутри дня. */
function bootstrapByDay(rated: readonly SignalOutcome[], iterations: number, seed: number): [number, number] | null {
  if (rated.length < 2) return null;
  const days = new Map<number, number[]>();
  for (const o of rated) {
    const d = Math.floor(o.entryTime! / DAY);
    days.set(d, [...(days.get(d) ?? []), o.rMultiple!]);
  }
  const blocks = [...days.values()];
  const rng = createRng(seed);
  const means: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    let count = 0;
    for (let k = 0; k < blocks.length; k++) {
      const block = blocks[Math.floor(rng() * blocks.length)]!;
      for (const r of block) sum += r;
      count += block.length;
    }
    means.push(sum / count);
  }
  means.sort((a, b) => a - b);
  return [quantile(means, 0.025), quantile(means, 0.975)];
}
