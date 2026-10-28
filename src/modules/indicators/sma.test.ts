import { describe, expect, it } from "vitest";
import { makeCandles, sawtooth } from "@/test/fixtures";
import { sma } from "./sma";
import type { Indicator } from "./types";

/** Общая проверка причинности: должна проходить для любого индикатора. */
function expectCausal(indicator: Indicator, closes: number[]) {
  const candles = makeCandles(closes);
  const full = indicator.compute(candles);
  expect(full).toHaveLength(candles.length);

  for (let k = 1; k <= candles.length; k++) {
    // 1. Расчёт на префиксе совпадает с префиксом полного расчёта.
    expect(indicator.compute(candles.slice(0, k))).toEqual(full.slice(0, k));

    // 2. Искажение будущих свечей не меняет прошлые значения.
    const perturbed = makeCandles([...closes.slice(0, k), ...closes.slice(k).map((c) => c * 3)]);
    expect(indicator.compute(perturbed).slice(0, k)).toEqual(full.slice(0, k));
  }
}

describe("sma", () => {
  it("returns null during warmup and the mean afterwards", () => {
    expect(sma(3).compute(makeCandles([1, 2, 3, 4, 5]))).toEqual([null, null, 2, 3, 4]);
  });

  it("is causal (no future data)", () => {
    expectCausal(sma(5), sawtooth(40));
  });

  it("rejects invalid periods", () => {
    expect(() => sma(0)).toThrow(RangeError);
    expect(() => sma(2.5)).toThrow(RangeError);
  });
});
