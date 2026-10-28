import { describe, expect, it } from "vitest";
import { TIMEFRAME_MS } from "@/core/time";
import { replaySignals } from "@/modules/backtest";
import type { Candle } from "@/modules/market-data";
import { ema } from "@/modules/indicators";
import { FIXTURE_SOURCE } from "@/test/fixtures";
import { BASE_VERSION, DEFAULT_PARAMS, trendPullback, versionFor } from "./strategy";

/**
 * СИНТЕТИЧЕСКИЙ детерминированный ряд 15m: тренд + колебания + переменная
 * ширина свечей. Не рыночные данные — только чтобы условия стратегии срабатывали.
 */
const Q = TIMEFRAME_MS["15m"];
const T0 = Date.UTC(2024, 0, 1);

function series(n: number, slope: number, start = T0): Candle[] {
  const out: Candle[] = [];
  let prevClose = 1000;
  for (let i = 0; i < n; i++) {
    const close = 1000 + slope * i + 6 * Math.sin(i / 3) + 2 * Math.sin(i / 1.3);
    const open = prevClose;
    const wick = 1 + 0.8 * Math.sin(i / 11) ** 2;
    out.push({
      source: FIXTURE_SOURCE, symbol: "TEST/USDT", timeframe: "15m",
      openTime: start + i * Q, closeTime: start + (i + 1) * Q,
      open, close, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, volume: 1, isClosed: true,
    });
    prevClose = close;
  }
  return out;
}

/** Уменьшенные окна, чтобы ряд в сотни свечей покрывал прогрев. */
const SMALL = { trendEma: 10, trendSlopeBars: 3, pullbackEma: 8, atrPeriod: 5, atrRankWindow: 60 };

describe("trend-pullback: version", () => {
  it("uses the base version for default params and encodes overrides", () => {
    expect(trendPullback().version).toBe(BASE_VERSION);
    expect(versionFor({ ...DEFAULT_PARAMS, trendEma: 10, targetR: 3 })).toBe(`${BASE_VERSION}+trendEma=10,targetR=3`);
  });

  it("requires 30 days of 15m candles plus ATR warmup by default", () => {
    expect(trendPullback().warmup).toBe(30 * 96 + 14);
  });
});

describe("trend-pullback: signals", () => {
  const strategy = trendPullback(SMALL);
  const up = series(900, 0.4);
  const down = series(900, -0.4);
  const upSignals = replaySignals(strategy, up);
  const downSignals = replaySignals(strategy, down);

  it("produces signals on the synthetic series (otherwise the other checks are vacuous)", () => {
    expect(upSignals.length).toBeGreaterThan(3);
    expect(downSignals.length).toBeGreaterThan(3);
  });

  it("trades only with the 1h trend", () => {
    expect(upSignals.every((s) => s.direction === "long")).toBe(true);
    expect(downSignals.every((s) => s.direction === "short")).toBe(true);
    for (const s of [...upSignals, ...downSignals]) {
      expect(Math.sign(s.features.ema50_1h_slope!)).toBe(s.direction === "long" ? 1 : -1);
    }
  });

  it("follows the trigger, stop, target and expiry rules", () => {
    for (const [candles, signals] of [[up, upSignals], [down, downSignals]] as const) {
      const fast = ema(SMALL.pullbackEma).compute(candles);
      for (const s of signals) {
        const i = candles.findIndex((c) => c.closeTime === s.basisCloseTime);
        const cur = candles[i]!;
        const prev = candles[i - 1]!;
        const sign = s.direction === "long" ? 1 : -1;
        const window = candles.slice(i - DEFAULT_PARAMS.pullbackWindow + 1, i + 1);
        const atrNow = s.features.atr14!;

        expect(s.entry.referencePrice).toBe(cur.close);
        expect(sign * (cur.close - fast[i]!)).toBeGreaterThan(0);
        expect(sign * (cur.close - (sign > 0 ? prev.high : prev.low))).toBeGreaterThan(0);
        expect(window.some((c, k) => (sign > 0 ? c.low <= fast[i - window.length + 1 + k]! : c.high >= fast[i - window.length + 1 + k]!))).toBe(true);

        const extreme = sign > 0 ? Math.min(...window.map((c) => c.low)) : Math.max(...window.map((c) => c.high));
        expect(s.stopLoss).toBeCloseTo(extreme - sign * 0.25 * atrNow, 9);
        const risk = sign * (s.entry.referencePrice - s.stopLoss);
        expect(risk / atrNow).toBeGreaterThanOrEqual(0.5);
        expect(risk / atrNow).toBeLessThanOrEqual(3);
        expect(s.takeProfits[0]).toBeCloseTo(s.entry.referencePrice + sign * 2 * risk, 9);
        expect(s.expiresAt).toBe(s.basisCloseTime + 16 * Q);
        expect(s.features.atr_pct_rank).toBeGreaterThanOrEqual(0.2);
        expect(s.features.atr_pct_rank).toBeLessThanOrEqual(0.8);
      }
    }
  });

  it("does not change past signals when future candles change", () => {
    const k = 600;
    const perturbed = [...up.slice(0, k), ...series(900, -0.5).slice(k)];
    const cutoff = up[k - 1]!.closeTime;
    const past = (xs: typeof upSignals) => xs.filter((s) => s.createdAt <= cutoff);
    expect(past(replaySignals(strategy, perturbed))).toEqual(past(upSignals));
  });

  it("emits nothing before the warmup is covered", () => {
    expect(replaySignals(strategy, up.slice(0, strategy.warmup - 1))).toEqual([]);
  });
});
