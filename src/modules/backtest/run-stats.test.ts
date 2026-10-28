import { describe, expect, it } from "vitest";
import type { Candle } from "@/modules/market-data";
import type { Strategy } from "@/modules/strategies";
import { FIXTURE_SOURCE, makeCandles } from "@/test/fixtures";
import { randomBaseline } from "./baseline";
import type { SignalOutcome } from "./outcome";
import { runBacktest } from "./run";
import { summarize } from "./stats";
import { judge } from "./verdict";

const M = 60_000;
const T0 = Date.UTC(2024, 0, 1);
const NO_COSTS = { feeRate: 0, slippage: 0 };

/**
 * Тестовая стратегия: лонг на каждой свече, стоп −2%, цель +2%, срок `bars` свечей. Не торговая идея.
 * На ровном ряде makeCandles (high/low = close ± 1) ни стоп, ни цель не достигаются.
 */
function everyBar(bars: number): Strategy {
  return {
    id: "test-every-bar", version: "0", timeframe: "1m", warmup: 1, lookback: 1,
    evaluate(ctx) {
      const c = ctx.candles.at(-1)!;
      return {
        basisCloseTime: c.closeTime, direction: "long",
        entry: { type: "next-open", referencePrice: c.close },
        stopLoss: c.close * 0.98, takeProfits: [c.close * 1.02],
        expiresAt: c.closeTime + bars * M, features: {}, rule: "test",
      };
    },
  };
}

const flat = (n: number): Candle[] => makeCandles(new Array(n).fill(100), { start: T0 });

describe("runBacktest", () => {
  it("keeps at most one open signal: the next one starts only after the previous exit", () => {
    const r = runBacktest(everyBar(3), flat(20), { costs: NO_COSTS });
    // Плоский рынок: каждая сделка истекает через 3 свечи (exitTime = close 3-й свечи окна).
    const created = r.trades.map((t) => t.signal.createdAt);
    for (let k = 1; k < r.trades.length; k++) {
      expect(created[k]!).toBeGreaterThanOrEqual(r.trades[k - 1]!.outcome.exitTime!);
    }
    expect(r.trades.every((t) => t.outcome.status === "expired")).toBe(true);
    expect(r.skippedOverlap).toBeGreaterThan(0);
    expect(r.trades.length + r.skippedOverlap + r.pending).toBe(r.signals.length);
  });

  it("marks the trade still open at the end of data as pending", () => {
    const r = runBacktest(everyBar(5), flat(12), { costs: NO_COSTS });
    expect(r.pending).toBe(1);
  });

  it("ignores signals before `from` (warmup period)", () => {
    const r = runBacktest(everyBar(1), flat(10), { from: T0 + 5 * M, costs: NO_COSTS });
    expect(r.signals.every((s) => s.createdAt >= T0 + 5 * M)).toBe(true);
  });
});

function outcome(r: number, day: number, status: SignalOutcome["status"] = r > 0 ? "target" : "stop"): SignalOutcome {
  const t = T0 + day * 86_400_000;
  return { signalId: `${day}:${r}`, status, entryTime: t, exitTime: t + M, rMultiple: r, evaluatedAt: 0, evaluatorVersion: "1" };
}

describe("summarize", () => {
  const outcomes = [outcome(2, 0), outcome(-1, 0), outcome(-1, 1), outcome(2, 2), outcome(-1, 3)];

  it("computes expectancy, win rate, profit factor and drawdown", () => {
    const s = summarize(outcomes);
    expect(s.trades).toBe(5);
    expect(s.totalR).toBe(1);
    expect(s.expectancyR).toBeCloseTo(0.2);
    expect(s.winRate).toBeCloseTo(0.4);
    expect(s.profitFactor).toBeCloseTo(4 / 3);
    expect(s.maxDrawdownR).toBe(2); // 2 → 1 → 0
    expect(s.byStatus).toMatchObject({ target: 2, stop: 3 });
  });

  it("excludes no-entry and data-gap from R statistics but counts them", () => {
    const s = summarize([...outcomes, { signalId: "x", status: "no-entry", evaluatedAt: 0, evaluatorVersion: "1" }]);
    expect(s.trades).toBe(5);
    expect(s.byStatus["no-entry"]).toBe(1);
  });

  it("gives a deterministic bootstrap interval containing the mean", () => {
    const a = summarize(outcomes, { seed: 7 });
    expect(a.ci95).toEqual(summarize(outcomes, { seed: 7 }).ci95);
    expect(a.ci95![0]).toBeLessThanOrEqual(a.expectancyR);
    expect(a.ci95![1]).toBeGreaterThanOrEqual(a.expectancyR);
  });

  it("reports month concentration", () => {
    expect(summarize([outcome(2, 0), outcome(1, 40), outcome(-1, 41)]).topMonthShare).toBe(1);
  });
});

describe("randomBaseline", () => {
  it("is deterministic for a seed and reuses direction, stop and target distances", () => {
    const candles = flat(200);
    const r = runBacktest(everyBar(3), candles.slice(0, 50), { costs: NO_COSTS });
    const a = randomBaseline(r.trades, candles, { runs: 20, seed: 3, costs: NO_COSTS });
    expect(a).toEqual(randomBaseline(r.trades, candles, { runs: 20, seed: 3, costs: NO_COSTS }));
    expect(a.runs).toBe(20);
    // Плоский рынок: каждая случайная сделка истекает с нулевым результатом.
    expect(a.p95).toBe(0);
  });
});

describe("judge", () => {
  const baseline = { runs: 100, expectancies: [], p50: 0, p95: 0.1 };
  const many = (r: number, n: number) => Array.from({ length: n }, (_, i) => outcome(r + (i % 2 ? 0.5 : -0.5), i));

  it("is insufficient-data below 100 trades", () => {
    expect(judge(summarize(many(1, 50)), baseline).verdict).toBe("insufficient-data");
  });

  it("rejects when the CI includes zero or the baseline is not beaten", () => {
    expect(judge(summarize(many(0, 120)), baseline).verdict).toBe("rejected");
  });

  it("does not reject when every criterion passes", () => {
    const r = judge(summarize(many(1, 120)), baseline);
    expect(r.checks.map((c) => c.passed)).toEqual([true, true, true, true]);
    expect(r.verdict).toBe("not-rejected");
  });

  it("uses only fixture data here", () => {
    expect(flat(1)[0]!.source).toBe(FIXTURE_SOURCE);
  });
});
