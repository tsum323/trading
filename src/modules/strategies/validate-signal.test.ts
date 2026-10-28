import { describe, expect, it } from "vitest";
import type { TradingSignal } from "./types";
import { validateSignal } from "./validate-signal";

const base: TradingSignal = {
  id: "s1",
  strategyId: "test",
  strategyVersion: "0",
  source: "test-fixture",
  symbol: "TEST/USDT",
  timeframe: "5m",
  createdAt: 1_000_000,
  basisCloseTime: 1_000_000,
  direction: "long",
  entry: { type: "next-open", referencePrice: 100 },
  stopLoss: 98,
  takeProfits: [104],
  expiresAt: 2_000_000,
  features: {},
  rule: "test",
};

describe("validateSignal", () => {
  it("accepts a consistent long signal", () => {
    expect(validateSignal(base)).toEqual([]);
  });

  it("accepts a consistent short signal", () => {
    expect(validateSignal({ ...base, direction: "short", stopLoss: 102, takeProfits: [96] })).toEqual([]);
  });

  it("rejects levels on the wrong side", () => {
    expect(validateSignal({ ...base, stopLoss: 101 })).toContain("stop-on-wrong-side");
    expect(validateSignal({ ...base, takeProfits: [99] })).toContain("target-on-wrong-side");
  });

  it("rejects a basis candle closed after the decision", () => {
    expect(validateSignal({ ...base, basisCloseTime: base.createdAt + 1 })).toContain("basis-after-decision");
  });

  it("rejects missing targets and bad expiry", () => {
    expect(validateSignal({ ...base, takeProfits: [] })).toContain("no-targets");
    expect(validateSignal({ ...base, expiresAt: base.createdAt })).toContain("expires-before-created");
  });
});
