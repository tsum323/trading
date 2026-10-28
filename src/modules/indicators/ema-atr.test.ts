import { describe, expect, it } from "vitest";
import { expectCausal } from "@/test/causality";
import { makeCandles, sawtooth } from "@/test/fixtures";
import type { Candle } from "@/modules/market-data";
import { atr } from "./atr";
import { ema } from "./ema";

describe("ema", () => {
  it("seeds with the SMA and then smooths with alpha = 2/(n+1)", () => {
    const out = ema(3).compute(makeCandles([2, 4, 6, 8]));
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toBe(4);
    expect(out[3]).toBeCloseTo(0.5 * 8 + 0.5 * 4);
  });

  it("is causal", () => {
    expectCausal(ema(5), makeCandles(sawtooth(40)));
  });
});

describe("atr", () => {
  const bar = (high: number, low: number, close: number): Pick<Candle, "high" | "low" | "close"> => ({ high, low, close });

  it("uses true range including gaps from the previous close", () => {
    const base = makeCandles([10, 10, 10]);
    const candles = [bar(11, 9, 10), bar(15, 13, 14), bar(14, 12, 13)].map((b, i) => ({ ...base[i]!, ...b, open: b.close }));
    // TR: 2, max(2, 5, 3) = 5, max(2, 0, 2) = 2
    const out = atr(2).compute(candles);
    expect(out[0]).toBeNull();
    expect(out[1]).toBe(3.5);
    expect(out[2]).toBeCloseTo((3.5 * 1 + 2) / 2);
  });

  it("is causal", () => {
    expectCausal(atr(5), makeCandles(sawtooth(40)));
  });
});
