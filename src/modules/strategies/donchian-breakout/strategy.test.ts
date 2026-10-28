import { describe, expect, it } from "vitest";
import { TIMEFRAME_MS } from "@/core/time";
import { replaySignals } from "@/modules/backtest";
import { atr, ema } from "@/modules/indicators";
import type { Candle } from "@/modules/market-data";
import { FIXTURE_SOURCE } from "@/test/fixtures";
import { getStrategy } from "../registry";
import { BASE_VERSION, DEFAULT_PARAMS, donchianBreakout, versionFor } from "./strategy";

/**
 * СИНТЕТИЧЕСКИЙ детерминированный ряд 1h: тренд + колебания. Не рыночные данные —
 * только чтобы пробои канала происходили и правила можно было проверить.
 */
const H = TIMEFRAME_MS["1h"];
const T0 = Date.UTC(2024, 0, 1);

function series(n: number, slope: number): Candle[] {
  const out: Candle[] = [];
  let prev = 1000;
  for (let i = 0; i < n; i++) {
    const close = 1000 + slope * i + 15 * Math.sin(i / 9) + 4 * Math.sin(i / 2.1);
    const open = prev;
    const wick = 1.5 + Math.sin(i / 13) ** 2;
    out.push({
      source: FIXTURE_SOURCE, symbol: "TEST/USDT", timeframe: "1h", openTime: T0 + i * H, closeTime: T0 + (i + 1) * H,
      open, close, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, volume: 1, isClosed: true,
    });
    prev = close;
  }
  return out;
}

/** Уменьшенные окна, чтобы ряд в сотни свечей покрывал прогрев. */
const SMALL = { channel: 12, trendEma: 30, atrPeriod: 10, lookback: 120 };

describe("donchian-breakout: version and registry", () => {
  it("uses the base version for defaults and encodes overrides", () => {
    expect(donchianBreakout().version).toBe(BASE_VERSION);
    expect(versionFor({ ...DEFAULT_PARAMS, channel: 24 })).toBe(`${BASE_VERSION}+channel=24`);
  });

  it("is registered and works on 1h with a 1000-candle warmup by default", () => {
    const s = getStrategy("donchian-breakout");
    expect([s.id, s.timeframe, s.warmup, s.lookback]).toEqual(["donchian-breakout", "1h", 1000, 1000]);
    expect(() => getStrategy("nope")).toThrow(/Unknown strategy/);
  });

  it("registers the 4h variant with the same bar parameters (spec §8)", () => {
    const s = getStrategy("donchian-breakout-4h");
    expect([s.id, s.version, s.timeframe, s.warmup]).toEqual(["donchian-breakout", `${BASE_VERSION}+timeframe=4h`, "4h", 1000]);
  });

  it("registers the 4h long-only variant (spec §9)", () => {
    const s = getStrategy("donchian-breakout-4h-long");
    expect([s.id, s.version, s.timeframe]).toEqual(["donchian-breakout", `${BASE_VERSION}+timeframe=4h,longOnly=true`, "4h"]);
  });

  it("long-only emits no shorts and keeps the long signals of the same candles", () => {
    const candles = series(700, -0.6);
    const both = replaySignals(donchianBreakout(SMALL), candles);
    const longOnly = replaySignals(donchianBreakout({ ...SMALL, longOnly: true }), candles);
    expect(both.some((s) => s.direction === "short")).toBe(true);
    expect(longOnly.every((s) => s.direction === "long")).toBe(true);
    // Реплей без правила «одного открытого» — сигналы long совпадают по свечам.
    expect(longOnly.map((s) => s.basisCloseTime)).toEqual(both.filter((s) => s.direction === "long").map((s) => s.basisCloseTime));
  });

  it("scales expiry with the timeframe", () => {
    const s4 = donchianBreakout({ ...SMALL, timeframe: "4h" });
    const candles = series(700, 0.6).map((c, i) => ({ ...c, timeframe: "4h" as const, openTime: T0 + i * 4 * H, closeTime: T0 + (i + 1) * 4 * H }));
    const signals = replaySignals(s4, candles);
    expect(signals.length).toBeGreaterThan(0);
    for (const sig of signals) expect(sig.expiresAt - sig.basisCloseTime).toBe(72 * 4 * H);
  });

  it("rejects a lookback too short for its indicators", () => {
    expect(() => donchianBreakout({ lookback: 100 })).toThrow(RangeError);
  });
});

describe("donchian-breakout: signals", () => {
  const strategy = donchianBreakout(SMALL);
  const up = series(700, 0.6);
  const down = series(700, -0.6);
  const upSignals = replaySignals(strategy, up);
  const downSignals = replaySignals(strategy, down);

  it("produces signals on the synthetic series (otherwise the other checks are vacuous)", () => {
    expect(upSignals.length).toBeGreaterThan(3);
    expect(downSignals.length).toBeGreaterThan(3);
  });

  it("follows the channel, trend, stop, target and expiry rules", () => {
    for (const candles of [up, down]) {
      const trend = ema(SMALL.trendEma).compute(candles);
      const atrSeries = atr(SMALL.atrPeriod).compute(candles);
      for (const s of replaySignals(strategy, candles)) {
        const i = candles.findIndex((c) => c.closeTime === s.basisCloseTime);
        // Индикаторы стратегии считаются на окне lookback; EMA/ATR на всём ряду близки, но не равны.
        const window = candles.slice(i + 1 - SMALL.lookback, i + 1);
        const prior = window.slice(-1 - SMALL.channel, -1);
        const high = Math.max(...prior.map((c) => c.high));
        const low = Math.min(...prior.map((c) => c.low));
        const ref = candles[i]!.close;
        const sign = s.direction === "long" ? 1 : -1;

        expect(s.entry.referencePrice).toBe(ref);
        expect([s.features.channel_high, s.features.channel_low]).toEqual([high, low]);
        expect(sign * (ref - (sign > 0 ? high : low))).toBeGreaterThan(0);
        expect(sign * (ref - s.features.ema200!)).toBeGreaterThan(0);
        expect(s.features.ema200).toBeCloseTo(ema(SMALL.trendEma).compute(window).at(-1)!, 9);
        expect(s.features.atr24).toBeCloseTo(atr(SMALL.atrPeriod).compute(window).at(-1)!, 9);
        expect(trend[i]).not.toBeNull();
        expect(atrSeries[i]).not.toBeNull();

        const risk = 2 * s.features.atr24!;
        expect(s.stopLoss).toBeCloseTo(ref - sign * risk, 9);
        expect(s.takeProfits[0]).toBeCloseTo(ref + sign * 3 * risk, 9);
        expect(s.expiresAt).toBe(s.basisCloseTime + 72 * H);
      }
    }
  });

  it("does not use the current candle in the channel", () => {
    // Если бы текущая свеча входила в канал, её close не мог бы выйти за его границу.
    for (const [candles, signals] of [[up, upSignals], [down, downSignals]] as const) for (const s of signals) {
      const cur = candles.find((c) => c.closeTime === s.basisCloseTime)!;
      if (s.direction === "long") expect(cur.high).toBeGreaterThan(s.features.channel_high!);
      else expect(cur.low).toBeLessThan(s.features.channel_low!);
    }
  });

  it("does not change past signals when future candles change", () => {
    const k = 450;
    const perturbed = [...up.slice(0, k), ...series(700, -1.5).slice(k).map((c) => ({ ...c, open: c.open + 200, high: c.high + 200, low: c.low + 200, close: c.close + 200 }))];
    const cutoff = up[k - 1]!.closeTime;
    const past = (xs: typeof upSignals) => xs.filter((s) => s.createdAt <= cutoff);
    expect(past(replaySignals(strategy, perturbed))).toEqual(past(upSignals));
  });

  it("emits nothing before the warmup is covered", () => {
    expect(replaySignals(strategy, up.slice(0, SMALL.lookback - 1))).toEqual([]);
  });
});
