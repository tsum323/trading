import { TIMEFRAME_MS } from "@/core/time";
import { atr, ema } from "@/modules/indicators";
import { resample } from "@/modules/market-data";
import type { SignalDraft, Strategy } from "../types";
import { paramsVersion } from "../version";

/** Параметры из docs/strategy-spec.md §4. */
export interface TrendPullbackParams {
  trendEma: number;
  /** На сколько часовых свечей назад сравнивать EMA тренда (наклон). */
  trendSlopeBars: number;
  pullbackEma: number;
  pullbackWindow: number;
  atrPeriod: number;
  /** Окно перцентиля ATR в свечах рабочего таймфрейма (30 дней × 96). */
  atrRankWindow: number;
  atrRankMin: number;
  atrRankMax: number;
  stopBufferAtr: number;
  minStopAtr: number;
  maxStopAtr: number;
  targetR: number;
  expiryBars: number;
}

export const DEFAULT_PARAMS: TrendPullbackParams = {
  trendEma: 50,
  trendSlopeBars: 5,
  pullbackEma: 20,
  pullbackWindow: 6,
  atrPeriod: 14,
  atrRankWindow: 30 * 96,
  atrRankMin: 0.2,
  atrRankMax: 0.8,
  stopBufferAtr: 0.25,
  minStopAtr: 0.5,
  maxStopAtr: 3,
  targetR: 2,
  expiryBars: 16,
};

export const STRATEGY_ID = "trend-pullback";
export const BASE_VERSION = "0.1.0";

/** Версия включает отличия от параметров по умолчанию: разные наборы не смешиваются в статистике. */
export function versionFor(params: TrendPullbackParams): string {
  return paramsVersion(BASE_VERSION, DEFAULT_PARAMS, params);
}

/**
 * Исследовательская стратегия trend-pullback (docs/strategy-spec.md §3).
 * Рабочий таймфрейм 15m; тренд — по 1h-свечам, собранным из тех же 15m.
 * Окно отката включает текущую свечу.
 */
export function trendPullback(overrides: Partial<TrendPullbackParams> = {}): Strategy {
  const p: TrendPullbackParams = { ...DEFAULT_PARAMS, ...overrides };
  const pullbackEma = ema(p.pullbackEma);
  const trendEma = ema(p.trendEma);
  const atrInd = atr(p.atrPeriod);
  const tf = "15m" as const;
  const hourMs = TIMEFRAME_MS["1h"];
  const warmup = p.atrRankWindow + p.atrPeriod;

  return {
    id: STRATEGY_ID,
    version: versionFor(p),
    timeframe: tf,
    warmup,
    lookback: warmup,
    evaluate(ctx): SignalDraft | null {
      const candles = ctx.candles;
      const n = candles.length;
      const cur = candles[n - 1];
      const prev = candles[n - 2];
      if (!cur || !prev || n < warmup) return null;

      // 1. Тренд по 1h.
      const hours = resample(candles, "1h");
      const lastHour = hours.at(-1);
      if (!lastHour || lastHour.closeTime < ctx.decisionTime - hourMs) return null; // часовые данные устарели
      const trend = trendEma.compute(hours);
      const trendNow = trend.at(-1);
      const trendThen = trend.at(-1 - p.trendSlopeBars);
      if (trendNow == null || trendThen == null) return null;
      const direction =
        trendNow > trendThen && lastHour.close > trendNow ? "long"
        : trendNow < trendThen && lastHour.close < trendNow ? "short"
        : null;
      if (!direction) return null;
      const sign = direction === "long" ? 1 : -1;

      // 2–3. Откат к EMA и триггер.
      const fast = pullbackEma.compute(candles);
      const fastNow = fast[n - 1];
      if (fastNow == null) return null;
      const window = candles.slice(n - p.pullbackWindow);
      const touched = window.some((c, k) => {
        const e = fast[n - p.pullbackWindow + k];
        return e != null && (sign > 0 ? c.low <= e : c.high >= e);
      });
      const triggered = sign * (cur.close - fastNow) > 0 && sign * (cur.close - (sign > 0 ? prev.high : prev.low)) > 0;
      if (!touched || !triggered) return null;

      // 4. Волатильность: перцентиль текущего ATR в окне.
      const atrSeries = atrInd.compute(candles);
      const atrNow = atrSeries[n - 1];
      if (atrNow == null || atrNow <= 0) return null;
      const rankWindow = atrSeries.slice(n - p.atrRankWindow);
      if (rankWindow.some((v) => v == null)) return null;
      const rank = rankWindow.filter((v) => v! <= atrNow).length / rankWindow.length;
      if (rank < p.atrRankMin || rank > p.atrRankMax) return null;

      // 6–7. Стоп и цель от опорной цены (close текущей свечи).
      const ref = cur.close;
      const extreme = sign > 0 ? Math.min(...window.map((c) => c.low)) : Math.max(...window.map((c) => c.high));
      const stop = extreme - sign * p.stopBufferAtr * atrNow;
      const risk = sign * (ref - stop);
      if (risk < p.minStopAtr * atrNow || risk > p.maxStopAtr * atrNow) return null;
      const target = ref + sign * p.targetR * risk;
      if (!(target > 0 && stop > 0)) return null;

      return {
        basisCloseTime: cur.closeTime,
        direction,
        entry: { type: "next-open", referencePrice: ref },
        stopLoss: stop,
        takeProfits: [target],
        // 8. Свеча входа открывается в closeTime текущей; окно — expiryBars свечей.
        expiresAt: cur.closeTime + p.expiryBars * TIMEFRAME_MS[tf],
        features: {
          ema20: fastNow,
          ema50_1h: trendNow,
          ema50_1h_slope: trendNow - trendThen,
          atr14: atrNow,
          atr_pct_rank: rank,
          pullback_depth_atr: (sign * (fastNow - extreme)) / atrNow,
          stop_distance_atr: risk / atrNow,
        },
        rule: `${direction}: 1h EMA${p.trendEma} trend, pullback to EMA${p.pullbackEma} in ${p.pullbackWindow} bars, close beyond prev ${sign > 0 ? "high" : "low"}`,
      };
    },
  };
}
