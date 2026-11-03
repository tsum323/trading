import type { FactorBook } from "@/modules/derivatives";
import { crowding, withOiFilter } from "@/modules/strategies/crowding";
import { donchianBreakout } from "@/modules/strategies/donchian-breakout";
import { meanReversion } from "@/modules/strategies/mean-reversion";
import { trendPullback } from "@/modules/strategies/trend-pullback";
import type { Strategy } from "@/modules/strategies";

/**
 * Навыки Автономного: варианты уже написанных стратегий с разными настройками.
 * Все торгуют «в уме» (без денег) непрерывно; деньги получают только те, что
 * показывают себя на свежих сделках. Набор фиксирован — новые навыки появляются
 * только с новой версией кода, не по результатам.
 */
export interface Skill {
  id: string;
  /** Подпись простыми словами. */
  label: string;
  make(factors: FactorBook): Strategy;
}

export const SKILLS: Skill[] = [
  { id: "breakout-4h-24", label: "Пробой короткого канала (4 дня), 4h", make: () => donchianBreakout({ timeframe: "4h", channel: 24 }) },
  { id: "breakout-4h-48", label: "Пробой канала 8 дней, 4h", make: () => donchianBreakout({ timeframe: "4h" }) },
  { id: "breakout-4h-96", label: "Пробой длинного канала (16 дней), 4h", make: () => donchianBreakout({ timeframe: "4h", channel: 96 }) },
  { id: "breakout-4h-wide", label: "Пробой 8 дней с широким стопом (3 ATR), 4h", make: () => donchianBreakout({ timeframe: "4h", stopAtr: 3, targetR: 2 }) },
  { id: "breakout-4h-long", label: "Пробой 8 дней, только лонг, 4h", make: () => donchianBreakout({ timeframe: "4h", longOnly: true }) },
  { id: "breakout-1h-48", label: "Пробой канала 2 дня, 1h", make: () => donchianBreakout() },
  { id: "breakout-4h-oi", label: "Пробой 8 дней при росте открытого интереса, 4h", make: (f) => withOiFilter(donchianBreakout({ timeframe: "4h" }), f, "donchian-breakout-oi") },
  { id: "pullback-15m", label: "Откат в тренде, 15m", make: () => trendPullback() },
  { id: "reversion-1h", label: "Возврат к среднему (Боллинджер 2σ, RSI 30/70), 1h", make: () => meanReversion() },
  { id: "reversion-1h-deep", label: "Возврат к среднему, только глубокие перекосы (2,5σ, RSI 25/75), 1h", make: () => meanReversion({ bandWidth: 2.5, rsiLow: 25, rsiHigh: 75 }) },
  { id: "reversion-4h", label: "Возврат к среднему, 4h", make: () => meanReversion({ timeframe: "4h", expiryBars: 12 }) },
  { id: "crowding-4h", label: "Против перегруженной толпы на фьючерсах, 4h", make: (f) => crowding(f) },
];

export const skillById = new Map(SKILLS.map((s) => [s.id, s]));
