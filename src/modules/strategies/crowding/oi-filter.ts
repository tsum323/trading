import { EMPTY_FACTORS, type FactorBook } from "@/modules/derivatives";
import type { Strategy } from "../types";
import { crowdingFeatures } from "./features";

/**
 * Фильтр открытого интереса для любой стратегии (docs/strategy-crowding.md, гипотеза 2):
 * сигнал проходит, только если открытый интерес за 7 дней вырос — движение
 * поддержано новыми позициями. Версия стратегии получает суффикс `+oi7d`.
 */
export function withOiFilter(base: Strategy, factors: FactorBook = EMPTY_FACTORS, id = `${base.id}-oi`): Strategy {
  return {
    ...base,
    id,
    version: `${base.version}+oi7d`,
    evaluate(ctx) {
      const draft = base.evaluate(ctx);
      if (!draft) return null;
      const f = crowdingFeatures(factors.get(ctx.symbol) ?? [], ctx.decisionTime);
      if (!f || f.oiChange7d <= 0) return null;
      return {
        ...draft,
        features: { ...draft.features, oi_change_7d: f.oiChange7d, premium_pct: f.premiumPct },
        rule: `${draft.rule}; OI +${(f.oiChange7d * 100).toFixed(1)}% in 7d`,
      };
    },
  };
}
