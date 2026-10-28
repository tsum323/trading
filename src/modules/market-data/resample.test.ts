import { describe, expect, it } from "vitest";
import { makeCandles } from "@/test/fixtures";
import { resample } from "./resample";

const T0 = Date.UTC(2024, 0, 1);
const Q = 15 * 60_000;

describe("resample", () => {
  it("aggregates complete buckets", () => {
    const c = makeCandles([10, 12, 9, 11, 13, 14, 15, 16], { timeframe: "15m", start: T0 });
    const h = resample(c, "1h");
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({
      timeframe: "1h", openTime: T0, closeTime: T0 + 4 * Q,
      open: c[0]!.open, close: 11, high: Math.max(...c.slice(0, 4).map((x) => x.high)),
      low: Math.min(...c.slice(0, 4).map((x) => x.low)), volume: 40, isClosed: true,
    });
  });

  it("drops an incomplete trailing bucket (no peeking at the forming hour)", () => {
    const c = makeCandles([1, 2, 3, 4, 5, 6], { timeframe: "15m", start: T0 });
    expect(resample(c, "1h").map((x) => x.openTime)).toEqual([T0]);
  });

  it("drops a bucket containing an unclosed candle", () => {
    const c = makeCandles([1, 2, 3, 4], { timeframe: "15m", start: T0, lastOpen: true });
    expect(resample(c, "1h")).toEqual([]);
  });

  it("drops a bucket with a missing sub-candle and an unaligned leading bucket", () => {
    const c = makeCandles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { timeframe: "15m", start: T0 - 2 * Q });
    const withGap = c.filter((_, i) => i !== 7);
    // [T0-2Q, T0) — неполный; [T0, T0+4Q) — полный; [T0+4Q, T0+8Q) — с пропуском
    expect(resample(withGap, "1h").map((x) => x.openTime)).toEqual([T0]);
  });

  it("rejects impossible targets", () => {
    expect(() => resample(makeCandles([1], { timeframe: "1h" }), "15m")).toThrow(RangeError);
  });
});
