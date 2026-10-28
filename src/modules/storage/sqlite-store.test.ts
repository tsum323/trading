import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_SOURCE, makeCandles } from "@/test/fixtures";
import type { TradingSignal } from "@/modules/strategies";
import { SqliteStore } from "./sqlite-store";

describe("SqliteStore", () => {
  let store: SqliteStore;
  beforeEach(() => {
    store = new SqliteStore(":memory:");
  });
  afterEach(() => store.close());

  it("round-trips candles in ascending order with [from, to) bounds", () => {
    const candles = makeCandles([1, 2, 3, 4]);
    store.upsertCandles([...candles].reverse(), 0);
    const q = { symbol: "TEST/USDT", timeframe: "1m" as const };
    expect(store.getCandles(FIXTURE_SOURCE, q)).toEqual(candles);
    expect(store.getCandles(FIXTURE_SOURCE, { ...q, from: candles[1]!.openTime, to: candles[3]!.openTime })).toEqual(
      candles.slice(1, 3),
    );
  });

  it("updates an unclosed candle but never overwrites a closed one", () => {
    const [open] = makeCandles([10], { lastOpen: true });
    const q = { symbol: "TEST/USDT", timeframe: "1m" as const };

    store.upsertCandles([open!], 0);
    store.upsertCandles([{ ...open!, close: 11, high: 12, isClosed: true }], 1);
    expect(store.getCandles(FIXTURE_SOURCE, q)[0]).toMatchObject({ close: 11, isClosed: true });

    store.upsertCandles([{ ...open!, close: 99, high: 100, isClosed: true }], 2);
    expect(store.getCandles(FIXTURE_SOURCE, q)[0]).toMatchObject({ close: 11, isClosed: true });
  });

  const signal: TradingSignal = {
    id: "test@0:TEST/USDT:1m:60000",
    strategyId: "test",
    strategyVersion: "0",
    source: FIXTURE_SOURCE,
    symbol: "TEST/USDT",
    timeframe: "1m",
    createdAt: 60_000,
    basisCloseTime: 60_000,
    direction: "long",
    entry: { type: "next-open", referencePrice: 100 },
    stopLoss: 99,
    takeProfits: [102, 104],
    expiresAt: 600_000,
    features: { sma: 99.5 },
    rule: "test",
  };

  it("round-trips signals and treats them as immutable", () => {
    store.insertSignal(signal, "replay", 0);
    expect(store.getSignal(signal.id)).toEqual(signal);
    expect(() => store.insertSignal(signal, "replay", 1)).toThrow();
  });

  it("enforces basisCloseTime <= createdAt at the schema level", () => {
    expect(() => store.insertSignal({ ...signal, id: "bad", basisCloseTime: signal.createdAt + 1 }, "live", 0)).toThrow();
  });
});
