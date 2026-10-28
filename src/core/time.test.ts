import { describe, expect, it } from "vitest";
import { alignToTimeframe, candleCloseTime, isTimeframe } from "./time";

describe("time", () => {
  it("aligns timestamps to timeframe boundaries in UTC", () => {
    const t = Date.UTC(2024, 0, 1, 13, 47, 31);
    expect(alignToTimeframe(t, "15m")).toBe(Date.UTC(2024, 0, 1, 13, 45));
    expect(alignToTimeframe(t, "4h")).toBe(Date.UTC(2024, 0, 1, 12));
    expect(alignToTimeframe(t, "1d")).toBe(Date.UTC(2024, 0, 1));
  });

  it("computes exclusive close time", () => {
    expect(candleCloseTime(0, "1h")).toBe(3_600_000);
  });

  it("validates timeframe strings", () => {
    expect(isTimeframe("5m")).toBe(true);
    expect(isTimeframe("2m")).toBe(false);
  });
});
