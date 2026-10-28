import { describe, expect, it } from "vitest";
import { expectCausal } from "@/test/causality";
import { makeCandles, sawtooth } from "@/test/fixtures";
import { sma } from "./sma";

describe("sma", () => {
  it("returns null during warmup and the mean afterwards", () => {
    expect(sma(3).compute(makeCandles([1, 2, 3, 4, 5]))).toEqual([null, null, 2, 3, 4]);
  });

  it("is causal (no future data)", () => {
    expectCausal(sma(5), makeCandles(sawtooth(40)));
  });

  it("rejects invalid periods", () => {
    expect(() => sma(0)).toThrow(RangeError);
    expect(() => sma(2.5)).toThrow(RangeError);
  });
});
