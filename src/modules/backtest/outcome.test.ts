import { describe, expect, it } from "vitest";
import type { Candle } from "@/modules/market-data";
import type { TradingSignal } from "@/modules/strategies";
import { FIXTURE_SOURCE } from "@/test/fixtures";
import { evaluateSignal, EVALUATOR_VERSION, type SignalOutcome } from "./outcome";

/** Синтетические свечи 1m с явными OHLC — только для тестов. */
const M = 60_000;
const T0 = Date.UTC(2024, 0, 1, 12);
const NO_COSTS = { feeRate: 0, slippage: 0 };

function candle(i: number, open: number, high: number, low: number, close: number): Candle {
  const openTime = T0 + i * M;
  return {
    source: FIXTURE_SOURCE, symbol: "TEST/USDT", timeframe: "1m",
    openTime, closeTime: openTime + M, open, high, low, close, volume: 1, isClosed: true,
  };
}

/** Опорная свеча закрылась в T0; вход — open свечи №0. Стоп 95, цель 110 (2R). */
function signal(overrides: Partial<TradingSignal> = {}): TradingSignal {
  return {
    id: "sig", strategyId: "test", strategyVersion: "0", source: FIXTURE_SOURCE, symbol: "TEST/USDT", timeframe: "1m",
    createdAt: T0, basisCloseTime: T0, direction: "long",
    entry: { type: "next-open", referencePrice: 100 },
    stopLoss: 95, takeProfits: [110], expiresAt: T0 + 5 * M, features: {}, rule: "test",
    ...overrides,
  };
}

const LATE = T0 + 60 * M;
const quiet = (i: number) => candle(i, 100, 101, 99, 100);
const evaluate = (candles: Candle[], s = signal(), asOf = LATE) => evaluateSignal(s, candles, asOf, NO_COSTS) as SignalOutcome;

describe("evaluateSignal: entry", () => {
  it("enters at the open of the candle following the basis close", () => {
    const o = evaluate([candle(0, 101, 102, 100, 101), quiet(1), quiet(2), quiet(3), quiet(4)]);
    expect(o).toMatchObject({ entryTime: T0, entryPrice: 101, evaluatorVersion: EVALUATOR_VERSION });
  });

  it("reports no-entry when the entry candle is missing from the data", () => {
    expect(evaluate([quiet(1), quiet(2)])).toMatchObject({ status: "no-entry", reason: "entry-candle-missing" });
  });

  it("reports no-entry when the entry open is already beyond the stop or the target", () => {
    expect(evaluate([candle(0, 94, 96, 93, 95)])).toMatchObject({ status: "no-entry", reason: "entry-beyond-stop" });
    expect(evaluate([candle(0, 111, 112, 109, 111)])).toMatchObject({ status: "no-entry", reason: "entry-beyond-target" });
  });

  it("reports no-entry when the signal expires before the entry candle closes", () => {
    expect(evaluate([quiet(0)], signal({ expiresAt: T0 + M - 1 }))).toMatchObject({
      status: "no-entry",
      reason: "expiry-before-entry-close",
    });
  });
});

describe("evaluateSignal: exits", () => {
  it("hits the target", () => {
    const o = evaluate([quiet(0), candle(1, 100, 111, 99, 108)]);
    expect(o).toMatchObject({ status: "target", exitPrice: 110, exitTime: T0 + 2 * M, rMultiple: 2 });
  });

  it("hits the stop at exactly -1R without costs", () => {
    expect(evaluate([quiet(0), candle(1, 100, 101, 94, 96)])).toMatchObject({ status: "stop", exitPrice: 95, rMultiple: -1 });
  });

  it("checks the entry candle itself after the open", () => {
    expect(evaluate([candle(0, 100, 101, 94, 96)])).toMatchObject({ status: "stop", exitTime: T0 + M });
  });

  it("treats stop and target in one candle as ambiguous, counted as a stop", () => {
    expect(evaluate([quiet(0), candle(1, 100, 112, 94, 100)])).toMatchObject({ status: "ambiguous", exitPrice: 95, rMultiple: -1 });
  });

  it("fills a gap through the stop at the open, worse than the stop", () => {
    expect(evaluate([quiet(0), candle(1, 90, 92, 89, 91)])).toMatchObject({ status: "stop", exitPrice: 90, rMultiple: -2 });
  });

  it("fills a gap through the target at the target, not the better open", () => {
    expect(evaluate([quiet(0), candle(1, 120, 121, 118, 119)])).toMatchObject({ status: "target", exitPrice: 110 });
  });

  it("expires at the close of the last candle closed by expiresAt and ignores later candles", () => {
    const candles = [quiet(0), quiet(1), quiet(2), quiet(3), candle(4, 100, 103, 99, 102), candle(5, 100, 101, 80, 85)];
    expect(evaluate(candles)).toMatchObject({ status: "expired", exitPrice: 102, exitTime: T0 + 5 * M, rMultiple: 0.4 });
  });

  it("mirrors the rules for a short", () => {
    const s = signal({ direction: "short", stopLoss: 105, takeProfits: [90] });
    expect(evaluate([quiet(0), candle(1, 100, 101, 89, 92)], s)).toMatchObject({ status: "target", rMultiple: 2 });
    expect(evaluate([quiet(0), candle(1, 110, 111, 108, 109)], s)).toMatchObject({ status: "stop", exitPrice: 110, rMultiple: -2 });
  });

  it("reports a data gap during the trade without a result", () => {
    const o = evaluate([quiet(0), quiet(2), quiet(3)]);
    expect(o.status).toBe("data-gap");
    expect(o.rMultiple).toBeUndefined();
  });

  it("clips MFE/MAE at the exit levels", () => {
    const o = evaluate([candle(0, 100, 104, 97, 100), candle(1, 100, 101, 80, 85)]);
    expect(o).toMatchObject({ status: "stop", mfeR: 0.8, maeR: -1 });
  });
});

describe("evaluateSignal: costs", () => {
  it("includes slippage on market fills and fees on both sides", () => {
    const costs = { feeRate: 0.001, slippage: 0.0002 };
    const stop = evaluateSignal(signal(), [quiet(0), candle(1, 100, 101, 94, 96)], LATE, costs) as SignalOutcome;
    const entry = 100 * 1.0002;
    const exit = 95 * 0.9998;
    const unit = entry - 95 + 0.001 * (entry + 95);
    expect(stop.entryPrice).toBeCloseTo(entry, 10);
    expect(stop.exitPrice).toBeCloseTo(exit, 10);
    expect(stop.rMultiple).toBeCloseTo((exit - entry - 0.001 * (entry + exit)) / unit, 10);
    expect(stop.rMultiple!).toBeLessThan(-1);

    const target = evaluateSignal(signal(), [quiet(0), candle(1, 100, 111, 99, 108)], LATE, costs) as SignalOutcome;
    expect(target.exitPrice).toBe(110); // лимитная заявка — без проскальзывания
    expect(target.rMultiple!).toBeLessThan(2);
  });
});

describe("evaluateSignal: no look-ahead", () => {
  it("is pending until the window has closed, ignoring candles closed after asOf", () => {
    const candles = [quiet(0), quiet(1), candle(2, 100, 111, 99, 108)];
    expect(evaluateSignal(signal(), candles, T0 + 2 * M, NO_COSTS)).toEqual({ status: "pending" });
    expect(evaluateSignal(signal(), candles, T0 + 3 * M - 1, NO_COSTS)).toEqual({ status: "pending" });
    expect(evaluateSignal(signal(), candles, T0 + 3 * M, NO_COSTS)).toMatchObject({ status: "target" });
  });

  it("does not read candles before the entry candle", () => {
    const after = [quiet(0), candle(1, 100, 111, 99, 108)];
    const before = [candle(-2, 100, 500, 1, 100), candle(-1, 100, 500, 1, 100)];
    expect(evaluate([...before, ...after])).toEqual(evaluate(after));
  });

  it("does not depend on candles after the exit", () => {
    const upToExit = [quiet(0), candle(1, 100, 111, 99, 108)];
    expect(evaluate([...upToExit, candle(2, 100, 101, 1, 2), candle(3, 2, 3, 1, 2)])).toEqual(evaluate(upToExit));
  });
});
