import { describe, expect, it } from "vitest";
import { TIMEFRAME_MS } from "@/core/time";
import { replaySignals } from "@/modules/backtest";
import { rsi } from "@/modules/indicators";
import type { Candle } from "@/modules/market-data";
import { expectCausal } from "@/test/causality";
import { FIXTURE_SOURCE, makeCandles, sawtooth } from "@/test/fixtures";
import { hashUnit, randomEntry } from "../random-entry";
import { getStrategy } from "../registry";
import { meanReversion } from "./strategy";

const T0 = Date.UTC(2024, 0, 1);

/** СИНТЕТИЧЕСКИЙ ряд: колебания с редкими резкими провалами и всплесками. Не рыночные данные. */
function series(n: number, timeframe: "1h" | "4h" = "1h"): Candle[] {
  const size = TIMEFRAME_MS[timeframe];
  const out: Candle[] = [];
  let prev = 1000;
  for (let i = 0; i < n; i++) {
    const shock = i % 97 === 50 ? -60 : i % 89 === 40 ? 60 : 0;
    const close = 1000 + 10 * Math.sin(i / 7) + shock;
    const open = prev;
    out.push({
      source: FIXTURE_SOURCE, symbol: "TEST/USDT", timeframe, openTime: T0 + i * size, closeTime: T0 + (i + 1) * size,
      open, close, high: Math.max(open, close) + 2, low: Math.min(open, close) - 2, volume: 1, isClosed: true,
    });
    prev = close;
  }
  return out;
}

describe("rsi", () => {
  it("is 100 on a steady rise, 0 on a steady fall and causal", () => {
    expect(rsi(3).compute(makeCandles([1, 2, 3, 4, 5])).slice(0, 4)).toEqual([null, null, null, 100]);
    expect(rsi(3).compute(makeCandles([5, 4, 3, 2])).at(-1)).toBe(0);
    expectCausal(rsi(5), makeCandles(sawtooth(40)));
  });
});

describe("mean-reversion", () => {
  it("is registered", () => {
    expect(getStrategy("mean-reversion").id).toBe("mean-reversion");
  });

  it("buys sharp drops and sells sharp spikes, targeting the middle band", () => {
    const signals = replaySignals(meanReversion(), series(1200));
    expect(signals.some((s) => s.direction === "long")).toBe(true);
    expect(signals.some((s) => s.direction === "short")).toBe(true);
    for (const s of signals) {
      const sign = s.direction === "long" ? 1 : -1;
      expect(sign * (s.takeProfits[0]! - s.entry.referencePrice)).toBeGreaterThan(0);
      expect(sign * (s.entry.referencePrice - s.stopLoss)).toBeGreaterThan(0);
      expect(s.takeProfits[0]).toBeCloseTo(s.features.band_mid!, 9);
      expect(sign > 0 ? s.features.rsi! < 30 : s.features.rsi! > 70).toBe(true);
    }
  });
});

describe("random-entry", () => {
  it("is deterministic, enters with ~5% probability and uses the trend exits", () => {
    const candles = series(3000, "4h");
    const a = replaySignals(randomEntry(), candles);
    const b = replaySignals(randomEntry(), candles);
    expect(a).toEqual(b);
    const rate = a.length / (candles.length - randomEntry().warmup);
    expect(rate).toBeGreaterThan(0.03);
    expect(rate).toBeLessThan(0.07);
    expect(new Set(a.map((s) => s.direction)).size).toBe(2);
    for (const s of a) {
      const risk = Math.abs(s.entry.referencePrice - s.stopLoss);
      expect(Math.abs(s.takeProfits[0]! - s.entry.referencePrice)).toBeCloseTo(3 * risk, 6);
      expect(s.expiresAt - s.createdAt).toBe(72 * TIMEFRAME_MS["4h"]);
    }
  });

  it("hashes to [0, 1)", () => {
    for (let i = 0; i < 100; i++) {
      const u = hashUnit(`k${i}`);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });
});

