import { donchianBreakout } from "./donchian-breakout";
import { trendPullback } from "./trend-pullback";
import type { Strategy } from "./types";

/** Стратегии с параметрами по умолчанию — для CLI и workflow (`--strategy <id>`). */
const STRATEGIES: Record<string, () => Strategy> = {
  "trend-pullback": () => trendPullback(),
  "donchian-breakout": () => donchianBreakout(),
  "donchian-breakout-4h": () => donchianBreakout({ timeframe: "4h" }),
  "donchian-breakout-4h-long": () => donchianBreakout({ timeframe: "4h", longOnly: true }),
};

export const STRATEGY_IDS = Object.keys(STRATEGIES);

export function getStrategy(id: string): Strategy {
  const make = STRATEGIES[id];
  if (!make) throw new Error(`Unknown strategy "${id}". Known: ${STRATEGY_IDS.join(", ")}`);
  return make();
}
