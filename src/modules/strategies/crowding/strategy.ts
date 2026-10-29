import { TIMEFRAME_MS, type Timeframe } from "@/core/time";
import { EMPTY_FACTORS, type FactorBook } from "@/modules/derivatives";
import { atr } from "@/modules/indicators";
import type { SignalDraft, Strategy } from "../types";
import { paramsVersion } from "../version";
import { crowdingFeatures } from "./features";

/**
 * «Против толпы» (docs/strategy-crowding.md): когда фьючерсы долго торгуются с
 * необычно высокой премией к споту (лонги платят funding) и открытый интерес
 * растёт — позиции перегружены в одну сторону, ставка на откат. Зеркально для шортов.
 */
export interface CrowdingParams {
  timeframe: Timeframe;
  historyDays: number;
  highPct: number;
  lowPct: number;
  minOiChange3d: number;
  atrPeriod: number;
  stopAtr: number;
  targetR: number;
  expiryBars: number;
}

export const DEFAULT_PARAMS: CrowdingParams = {
  timeframe: "4h",
  historyDays: 90,
  highPct: 0.9,
  lowPct: 0.1,
  minOiChange3d: 0.03,
  atrPeriod: 24,
  stopAtr: 2,
  targetR: 2,
  expiryBars: 42,
};

export const STRATEGY_ID = "crowding";
export const BASE_VERSION = "0.1.0";

export function versionFor(params: CrowdingParams): string {
  return paramsVersion(BASE_VERSION, DEFAULT_PARAMS, params);
}

export function crowding(factors: FactorBook = EMPTY_FACTORS, overrides: Partial<CrowdingParams> = {}): Strategy {
  const p: CrowdingParams = { ...DEFAULT_PARAMS, ...overrides };
  const atrInd = atr(p.atrPeriod);
  const tf = p.timeframe;
  const lookback = p.atrPeriod * 3;

  const side = (symbol: string, t: number) => {
    const f = crowdingFeatures(factors.get(symbol) ?? [], t, p.historyDays);
    if (!f || f.oiChange3d < p.minOiChange3d) return { f, dir: null };
    return { f, dir: f.premiumPct >= p.highPct ? ("short" as const) : f.premiumPct <= p.lowPct ? ("long" as const) : null };
  };

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
      const now = side(ctx.symbol, ctx.decisionTime);
      if (!now.dir || !now.f) return null;
      // Только новое событие: на предыдущей свече того же перекоса не было.
      if (side(ctx.symbol, ctx.decisionTime - TIMEFRAME_MS[tf]).dir === now.dir) return null;

      const atrNow = atrInd.compute(candles)[n - 1];
      if (atrNow == null || atrNow <= 0) return null;
      const sign = now.dir === "long" ? 1 : -1;
      const ref = cur.close;
      const risk = p.stopAtr * atrNow;
      const stop = ref - sign * risk;
      const target = ref + sign * p.targetR * risk;
      if (!(stop > 0 && target > 0)) return null;
      return {
        basisCloseTime: cur.closeTime,
        direction: now.dir,
        entry: { type: "next-open", referencePrice: ref },
        stopLoss: stop,
        takeProfits: [target],
        expiresAt: cur.closeTime + p.expiryBars * TIMEFRAME_MS[tf],
        features: {
          premium_3d: now.f.premium3d,
          premium_pct: now.f.premiumPct,
          oi_change_3d: now.f.oiChange3d,
          oi_change_7d: now.f.oiChange7d,
          factor_hour: now.f.lastFactorHour,
          atr: atrNow,
        },
        rule: `${now.dir}: 3-day premium at ${(now.f.premiumPct * 100).toFixed(0)}th pct of ${p.historyDays}d, OI +${(now.f.oiChange3d * 100).toFixed(1)}% in 3d — against the crowd`,
      };
    },
  };
}
