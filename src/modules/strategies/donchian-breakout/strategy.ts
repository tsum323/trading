import { TIMEFRAME_MS, type Timeframe } from "@/core/time";
import { atr, ema } from "@/modules/indicators";
import type { SignalDraft, Strategy } from "../types";
import { paramsVersion } from "../version";

/** Параметры из docs/strategy-donchian-breakout.md §3. */
export interface DonchianBreakoutParams {
  /** Таймфрейм; остальные параметры — в свечах этого таймфрейма (§8). */
  timeframe: Timeframe;
  /** Длина канала в свечах; текущая свеча в канал не входит. */
  channel: number;
  trendEma: number;
  atrPeriod: number;
  stopAtr: number;
  targetR: number;
  expiryBars: number;
  /** Окно расчёта; длинное, чтобы EMA не зависела от начального значения. */
  lookback: number;
  /** Только long-сигналы (§9). */
  longOnly: boolean;
}

export const DEFAULT_PARAMS: DonchianBreakoutParams = {
  timeframe: "1h",
  channel: 48,
  trendEma: 200,
  atrPeriod: 24,
  stopAtr: 2,
  targetR: 3,
  expiryBars: 72,
  lookback: 1000,
  longOnly: false,
};

export const STRATEGY_ID = "donchian-breakout";
export const BASE_VERSION = "0.1.0";

export function versionFor(params: DonchianBreakoutParams): string {
  return paramsVersion(BASE_VERSION, DEFAULT_PARAMS, params);
}

/**
 * Пробой канала Дончиана по закрытию свечи в направлении EMA тренда
 * (docs/strategy-donchian-breakout.md). По умолчанию 1h; вариант 4h — §8.
 */
export function donchianBreakout(overrides: Partial<DonchianBreakoutParams> = {}): Strategy {
  const p: DonchianBreakoutParams = { ...DEFAULT_PARAMS, ...overrides };
  if (p.lookback < Math.max(p.channel + 1, p.trendEma, p.atrPeriod)) {
    throw new RangeError("lookback must cover the channel, EMA and ATR periods");
  }
  const trendEma = ema(p.trendEma);
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

      // 1. Канал по предыдущим `channel` свечам.
      let high = Number.NEGATIVE_INFINITY;
      let low = Number.POSITIVE_INFINITY;
      for (let i = n - 1 - p.channel; i < n - 1; i++) {
        high = Math.max(high, candles[i]!.high);
        low = Math.min(low, candles[i]!.low);
      }

      // 2–3. Пробой в направлении тренда.
      const trend = trendEma.compute(candles)[n - 1];
      const atrNow = atrInd.compute(candles)[n - 1];
      if (trend == null || atrNow == null || atrNow <= 0) return null;
      const ref = cur.close;
      const direction = ref > high && ref > trend ? "long" : !p.longOnly && ref < low && ref < trend ? "short" : null;
      if (!direction) return null;
      const sign = direction === "long" ? 1 : -1;

      // 4–6. Стоп, цель, срок.
      const risk = p.stopAtr * atrNow;
      const stop = ref - sign * risk;
      const target = ref + sign * p.targetR * risk;
      if (!(stop > 0 && target > 0)) return null;

      return {
        basisCloseTime: cur.closeTime,
        direction,
        entry: { type: "next-open", referencePrice: ref },
        stopLoss: stop,
        takeProfits: [target],
        expiresAt: cur.closeTime + p.expiryBars * TIMEFRAME_MS[tf],
        features: {
          channel_high: high,
          channel_low: low,
          ema200: trend,
          atr24: atrNow,
          breakout_atr: (sign * (ref - (sign > 0 ? high : low))) / atrNow,
          ema_distance_atr: (sign * (ref - trend)) / atrNow,
        },
        rule: `${direction}: close beyond ${p.channel}-bar Donchian ${sign > 0 ? "high" : "low"}, ${sign > 0 ? "above" : "below"} EMA${p.trendEma}`,
      };
    },
  };
}
