import { describe, expect, it } from "vitest";
import { makeCandles, sawtooth } from "@/test/fixtures";
import type { Strategy, StrategyContext } from "@/modules/strategies";
import { LookaheadError, replaySignals } from "./replay";

/** Тестовая стратегия: лонг, если close выше close предыдущей свечи. Не торговая идея. */
function upTick(onEvaluate?: (ctx: StrategyContext) => void): Strategy {
  return {
    id: "test-uptick",
    version: "0",
    timeframe: "1m",
    warmup: 2,
    lookback: 5,
    evaluate(ctx) {
      onEvaluate?.(ctx);
      const last = ctx.candles.at(-1)!;
      const prev = ctx.candles.at(-2)!;
      if (last.close <= prev.close) return null;
      return {
        basisCloseTime: last.closeTime,
        direction: "long",
        entry: { type: "next-open", referencePrice: last.close },
        stopLoss: last.close * 0.99,
        takeProfits: [last.close * 1.02],
        expiresAt: ctx.decisionTime + 10 * 60_000,
        features: { delta: last.close - prev.close },
        rule: "close > prev.close",
      };
    },
  };
}

describe("replaySignals", () => {
  it("never shows the strategy a candle closed after the decision time", () => {
    const seen: Array<{ decision: number; maxClose: number; count: number }> = [];
    replaySignals(
      upTick((ctx) =>
        seen.push({ decision: ctx.decisionTime, maxClose: Math.max(...ctx.candles.map((c) => c.closeTime)), count: ctx.candles.length }),
      ),
      makeCandles(sawtooth(30)),
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.maxClose).toBe(s.decision);
      expect(s.count).toBeLessThanOrEqual(5);
    }
  });

  it("produces identical past signals when future candles change", () => {
    const closes = sawtooth(40);
    const k = 25;
    const base = replaySignals(upTick(), makeCandles(closes));
    const perturbed = replaySignals(upTick(), makeCandles([...closes.slice(0, k), ...closes.slice(k).map((c) => c * 2)]));
    const cutoff = makeCandles(closes)[k - 1]!.closeTime;
    expect(perturbed.filter((s) => s.createdAt <= cutoff)).toEqual(base.filter((s) => s.createdAt <= cutoff));
  });

  it("does not make a decision on an unclosed candle", () => {
    const candles = makeCandles([1, 2, 3, 4], { lastOpen: true });
    const decisions: number[] = [];
    replaySignals(upTick((ctx) => decisions.push(ctx.decisionTime)), candles);
    expect(decisions).not.toContain(candles[3]!.closeTime);
    expect(decisions.at(-1)).toBe(candles[2]!.closeTime);
  });

  it("rejects a strategy that claims to use a future candle", () => {
    const cheating: Strategy = {
      ...upTick(),
      evaluate(ctx) {
        const draft = upTick().evaluate(ctx);
        return draft && { ...draft, basisCloseTime: ctx.decisionTime + 60_000 };
      },
    };
    expect(() => replaySignals(cheating, makeCandles([1, 2, 3, 4]))).toThrow(LookaheadError);
  });

  it("rejects unsorted input", () => {
    const c = makeCandles([1, 2, 3]);
    expect(() => replaySignals(upTick(), [c[0]!, c[2]!, c[1]!])).toThrow(/ascending/);
  });
});
