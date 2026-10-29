import { TIMEFRAME_MS, type Timeframe } from "@/core/time";
import { atr } from "@/modules/indicators";
import type { SignalDraft, Strategy } from "../types";
import { paramsVersion } from "../version";

/**
 * Контрольная «стратегия»: вход в случайный момент в случайную сторону с теми же
 * выходами, что у пробоя Дончиана (стоп 2·ATR, цель 3R, срок 72 свечи).
 * Случайность детерминирована — хеш символа и времени решения, поэтому
 * результат воспроизводим и не зависит от будущего.
 */
export interface RandomEntryParams {
  timeframe: Timeframe;
  /** Вероятность входа на свече (если по символу нет открытой позиции). */
  probability: number;
  atrPeriod: number;
  stopAtr: number;
  targetR: number;
  expiryBars: number;
  seed: number;
}

export const DEFAULT_PARAMS: RandomEntryParams = {
  timeframe: "4h",
  probability: 0.05,
  atrPeriod: 24,
  stopAtr: 2,
  targetR: 3,
  expiryBars: 72,
  seed: 1,
};

export const STRATEGY_ID = "random-entry";
export const BASE_VERSION = "0.1.0";

export function versionFor(params: RandomEntryParams): string {
  return paramsVersion(BASE_VERSION, DEFAULT_PARAMS, params);
}

/** FNV-1a → [0, 1). */
export function hashUnit(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 2 ** 32;
}

export function randomEntry(overrides: Partial<RandomEntryParams> = {}): Strategy {
  const p: RandomEntryParams = { ...DEFAULT_PARAMS, ...overrides };
  const atrInd = atr(p.atrPeriod);
  const tf = p.timeframe;
  const lookback = p.atrPeriod * 3;

  return {
    id: STRATEGY_ID,
    version: versionFor(p),
    timeframe: tf,
    warmup: lookback,
    lookback,
    evaluate(ctx): SignalDraft | null {
      const candles = ctx.candles;
      const n = candles.length;
      const cur = candles[n - 1];
      if (!cur || n < lookback) return null;
      const key = `${p.seed}:${ctx.symbol}:${ctx.decisionTime}`;
      if (hashUnit(key) >= p.probability) return null;
      const direction = hashUnit(`${key}:side`) < 0.5 ? "long" : "short";
      const sign = direction === "long" ? 1 : -1;

      const atrNow = atrInd.compute(candles)[n - 1];
      if (atrNow == null || atrNow <= 0) return null;
      const ref = cur.close;
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
        features: { atr: atrNow },
        rule: `${direction}: random entry (p=${p.probability}), stop ${p.stopAtr}·ATR, target ${p.targetR}R`,
      };
    },
  };
}
