import { describe, expect, it } from "vitest";
import { makeCandles } from "@/test/fixtures";
import { closedCandlesAsOf } from "./closed-candles";

describe("closedCandlesAsOf", () => {
  const candles = makeCandles([1, 2, 3, 4, 5]);

  it("includes a candle exactly at its closeTime", () => {
    expect(closedCandlesAsOf(candles, candles[2]!.closeTime)).toHaveLength(3);
  });

  it("excludes a candle one millisecond before its closeTime", () => {
    expect(closedCandlesAsOf(candles, candles[2]!.closeTime - 1)).toHaveLength(2);
  });

  it("ignores the source isClosed flag and relies on time only", () => {
    const lying = candles.map((c) => ({ ...c, isClosed: true }));
    const asOf = lying[1]!.openTime + 1; // внутри второй свечи
    const visible = closedCandlesAsOf(lying, asOf);
    expect(visible.map((c) => c.close)).toEqual([1]);
  });

  it("returns an empty list before the first close", () => {
    expect(closedCandlesAsOf(candles, candles[0]!.openTime)).toEqual([]);
  });

  it("returns a frozen copy", () => {
    const visible = closedCandlesAsOf(candles, candles[4]!.closeTime);
    expect(Object.isFrozen(visible)).toBe(true);
    expect(visible).not.toBe(candles);
  });
});
