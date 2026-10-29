import type { FactorBook } from "@/modules/derivatives";
import { crowding, withOiFilter } from "./crowding";
import { donchianBreakout } from "./donchian-breakout";
import { meanReversion } from "./mean-reversion";
import { randomEntry } from "./random-entry";
import { trendPullback } from "./trend-pullback";
import type { Strategy } from "./types";

/** Данные помимо свечей, которые нужны части стратегий. */
export interface StrategyDeps {
  /** Факторы фьючерсов по символам (docs/strategy-crowding.md). */
  factors?: FactorBook;
}

/** Стратегии с параметрами по умолчанию — для CLI и workflow (`--strategy <id>`). */
const STRATEGIES: Record<string, (deps: StrategyDeps) => Strategy> = {
  "trend-pullback": () => trendPullback(),
  "donchian-breakout": () => donchianBreakout(),
  "donchian-breakout-4h": () => donchianBreakout({ timeframe: "4h" }),
  "donchian-breakout-4h-long": () => donchianBreakout({ timeframe: "4h", longOnly: true }),
  "mean-reversion": () => meanReversion(),
  "random-entry": () => randomEntry(),
  crowding: (d) => crowding(d.factors),
  "donchian-breakout-4h-oi": (d) => withOiFilter(donchianBreakout({ timeframe: "4h" }), d.factors, "donchian-breakout-oi"),
};

export const STRATEGY_IDS = Object.keys(STRATEGIES);

/** Стратегии, которым нужны факторы фьючерсов: без них сигналов не дают. */
export const FACTOR_STRATEGY_IDS: ReadonlySet<string> = new Set(["crowding", "donchian-breakout-4h-oi"]);

export function getStrategy(id: string, deps: StrategyDeps = {}): Strategy {
  const make = STRATEGIES[id];
  if (!make) throw new Error(`Unknown strategy "${id}". Known: ${STRATEGY_IDS.join(", ")}`);
  return make(deps);
}
