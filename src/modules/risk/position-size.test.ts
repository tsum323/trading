import { describe, expect, it } from "vitest";
import { positionSize } from "./position-size";

describe("positionSize", () => {
  it("sizes a long position so that the stop loses exactly the risk amount", () => {
    const r = positionSize({ equity: 10_000, riskFraction: 0.01, direction: "long", entry: 100, stopLoss: 95 });
    expect(r.riskAmount).toBe(100);
    expect(r.quantity).toBeCloseTo(20);
    expect(r.notional).toBeCloseTo(2_000);
  });

  it("includes round-trip fees in the loss per unit", () => {
    const r = positionSize({ equity: 10_000, riskFraction: 0.01, direction: "short", entry: 100, stopLoss: 105, feeRate: 0.001 });
    expect(r.lossPerUnit).toBeCloseTo(5 + 0.001 * 205);
    expect(r.quantity * r.lossPerUnit).toBeCloseTo(100);
  });

  it("rejects invalid inputs", () => {
    const ok = { equity: 1_000, riskFraction: 0.01, direction: "long" as const, entry: 100, stopLoss: 95 };
    expect(() => positionSize({ ...ok, stopLoss: 101 })).toThrow(/wrong side/);
    expect(() => positionSize({ ...ok, riskFraction: 0.5 })).toThrow(RangeError);
    expect(() => positionSize({ ...ok, equity: 0 })).toThrow(RangeError);
  });
});
