import { describe, expect, it } from "vitest";
import { makeCandles } from "@/test/fixtures";
import { validateCandle, validateSeries } from "./validation";

describe("validateCandle", () => {
  const [good] = makeCandles([100]);

  it("accepts a consistent candle", () => {
    expect(validateCandle(good!)).toEqual([]);
  });

  it("rejects inconsistent OHLC", () => {
    expect(validateCandle({ ...good!, high: 50 })).toContain("high-below-body");
    expect(validateCandle({ ...good!, low: 150 })).toContain("low-above-body");
    expect(validateCandle({ ...good!, close: Number.NaN })).toEqual(["non-finite-value"]);
  });

  it("rejects wrong closeTime and misaligned openTime", () => {
    expect(validateCandle({ ...good!, closeTime: good!.closeTime + 1 })).toContain("close-time-mismatch");
    expect(validateCandle({ ...good!, openTime: good!.openTime + 1, closeTime: good!.closeTime + 1 })).toContain(
      "misaligned-open-time",
    );
  });

  it("rejects a candle marked closed before its closeTime", () => {
    expect(validateCandle(good!, good!.closeTime - 1)).toContain("closed-in-future");
    expect(validateCandle(good!, good!.closeTime)).toEqual([]);
  });
});

describe("validateSeries", () => {
  it("reports gaps without filling them", () => {
    const c = makeCandles([1, 2, 3, 4]);
    const withGap = [c[0]!, c[1]!, c[3]!];
    expect(validateSeries(withGap)).toEqual([{ kind: "gap", index: 2, missing: 1 }]);
  });

  it("reports non-ascending and mixed series", () => {
    const c = makeCandles([1, 2]);
    expect(validateSeries([c[1]!, c[0]!])).toEqual([{ kind: "not-ascending", index: 1 }]);
    expect(validateSeries([c[0]!, { ...c[1]!, symbol: "OTHER/USDT" }])).toEqual([{ kind: "mixed-series", index: 1 }]);
  });
});
