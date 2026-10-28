import { expect } from "vitest";
import type { Candle } from "@/modules/market-data";
import type { Indicator } from "@/modules/indicators";

/**
 * Проверка причинности индикатора: должна проходить для любого индикатора.
 * `perturb` искажает свечу так, чтобы изменились все её цены.
 */
export function expectCausal(
  indicator: Indicator,
  candles: Candle[],
  perturb: (c: Candle) => Candle = (c) => ({ ...c, open: c.open * 3, high: c.high * 3, low: c.low * 3, close: c.close * 3 }),
) {
  const full = indicator.compute(candles);
  expect(full).toHaveLength(candles.length);

  for (let k = 1; k <= candles.length; k++) {
    // 1. Расчёт на префиксе совпадает с префиксом полного расчёта.
    expect(indicator.compute(candles.slice(0, k))).toEqual(full.slice(0, k));

    // 2. Искажение будущих свечей не меняет прошлые значения.
    const perturbed = [...candles.slice(0, k), ...candles.slice(k).map(perturb)];
    expect(indicator.compute(perturbed).slice(0, k)).toEqual(full.slice(0, k));
  }
}
