import { describe, expect, it } from "vitest";
import { makeCandles } from "@/test/fixtures";
import { findGaps } from "./coverage";

const M = 60_000;
const T0 = Date.UTC(2024, 0, 1);

describe("findGaps", () => {
  const all = makeCandles([1, 2, 3, 4, 5, 6], { start: T0 });

  it("reports nothing for full coverage", () => {
    expect(findGaps(all, "1m", T0, T0 + 6 * M)).toEqual([]);
  });

  it("reports leading, middle and trailing gaps", () => {
    const partial = [all[1]!, all[2]!, all[4]!];
    expect(findGaps(partial, "1m", T0, T0 + 6 * M)).toEqual([
      { from: T0, to: T0 + M, missing: 1 },
      { from: T0 + 3 * M, to: T0 + 4 * M, missing: 1 },
      { from: T0 + 5 * M, to: T0 + 6 * M, missing: 1 },
    ]);
  });

  it("aligns an unaligned range to timeframe boundaries", () => {
    // [T0+30s, T0+2m+30s) ожидает свечи T0+1m и T0+2m
    expect(findGaps([all[1]!], "1m", T0 + 30_000, T0 + 2 * M + 30_000)).toEqual([
      { from: T0 + 2 * M, to: T0 + 3 * M, missing: 1 },
    ]);
  });

  it("reports the whole range when empty", () => {
    expect(findGaps([], "1m", T0, T0 + 3 * M)).toEqual([{ from: T0, to: T0 + 3 * M, missing: 3 }]);
  });
});
