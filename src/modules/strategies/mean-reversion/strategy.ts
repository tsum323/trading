import { TIMEFRAME_MS, type Timeframe } from "@/core/time";
import { atr, rsi } from "@/modules/indicators";
import type { SignalDraft, Strategy } from "../types";
import { paramsVersion } from "../version";

/**
 * Возврат к среднему: вход против резкого движения, когда цена вышла за полосу
 * Боллинджера и RSI в зоне перепроданности/перекупленности. Цель — средняя линия.
 * Гипотеза для персонажа «Контрарианец», проверку на истории не проходила.
 */
export interface MeanReversionParams {
  timeframe: Timeframe;
  bandPeriod: number;
  bandWidth: number;
  rsiPeriod: number;
  rsiLow: number;
  rsiHigh: number;
  atrPeriod: number;
  stopAtr: number;
  expiryBars: number;
  lookback: number;
}

export const DEFAULT_PARAMS: MeanReversionParams = {
  timeframe: "1h",
  bandPeriod: 20,
  bandWidth: 2,
  rsiPeriod: 14,
  rsiLow: 30,
  rsiHigh: 70,
  atrPeriod: 14,
  stopAtr: 1.5,
  expiryBars: 24,
  lookback: 200,
};

export const STRATEGY_ID = "mean-reversion";
export const BASE_VERSION = "0.1.0";

export function versionFor(params: MeanReversionParams): string {
  return paramsVersion(BASE_VERSION, DEFAULT_PARAMS, params);
}

export function meanReversion(overrides: Partial<MeanReversionParams> = {}): Strategy {
  const p: MeanReversionParams = { ...DEFAULT_PARAMS, ...overrides };
  if (p.lookback < Math.max(p.bandPeriod, p.rsiPeriod + 1, p.atrPeriod)) {
    throw new RangeError("lookback must cover the band, RSI and ATR periods");
  }
  const rsiInd = rsi(p.rsiPeriod);
  const atrInd = atr(p.atrPeriod);
  const tf = p.timeframe;

  return {
    id: STRATEGY_ID,
    version: versionFor(p),
    timeframe: tf,
    warmup: p.lookback,
    lookback: p.lookback,
    evaluate(ctx): SignalDraft | null {
      const candles = ctx.candles;
      const n = candles.length;
      const cur = candles[n - 1];
      if (!cur || n < p.lookback) return null;

      // Полосы Боллинджера по close, включая текущую свечу.
      const closes = candles.slice(n - p.bandPeriod).map((c) => c.close);
      const mid = closes.reduce((s, x) => s + x, 0) / closes.length;
      const sd = Math.sqrt(closes.reduce((s, x) => s + (x - mid) ** 2, 0) / closes.length);
      const upper = mid + p.bandWidth * sd;
      const lower = mid - p.bandWidth * sd;

      const rsiNow = rsiInd.compute(candles)[n - 1];
      const atrNow = atrInd.compute(candles)[n - 1];
      if (rsiNow == null || atrNow == null || atrNow <= 0 || sd <= 0) return null;
      const ref = cur.close;
      const direction = ref < lower && rsiNow < p.rsiLow ? "long" : ref > upper && rsiNow > p.rsiHigh ? "short" : null;
      if (!direction) return null;
      const sign = direction === "long" ? 1 : -1;

      const stop = ref - sign * p.stopAtr * atrNow;
      const target = mid;
      if (!(stop > 0 && sign * (target - ref) > 0)) return null;

      return {
        basisCloseTime: cur.closeTime,
        direction,
        entry: { type: "next-open", referencePrice: ref },
        stopLoss: stop,
        takeProfits: [target],
        expiresAt: cur.closeTime + p.expiryBars * TIMEFRAME_MS[tf],
        features: { band_mid: mid, band_upper: upper, band_lower: lower, rsi: rsiNow, atr: atrNow, reward_risk: Math.abs(target - ref) / (p.stopAtr * atrNow) },
        rule: `${direction}: close ${sign > 0 ? "below lower" : "above upper"} Bollinger(${p.bandPeriod},${p.bandWidth}), RSI${p.rsiPeriod} ${sign > 0 ? "<" + p.rsiLow : ">" + p.rsiHigh}; target = middle band`,
      };
    },
  };
}
