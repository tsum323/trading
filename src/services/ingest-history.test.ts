import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Candle, CandleQuery, MarketDataSource } from "@/modules/market-data";
import { MarketDataError } from "@/modules/market-data";
import { SqliteStore } from "@/modules/storage";
import { FIXTURE_SOURCE, makeCandles, sawtooth } from "@/test/fixtures";
import { ingestHistory } from "./ingest-history";

const M = 60_000;
const T0 = Date.UTC(2024, 0, 1);

/** Источник поверх тестовых свечей; повторяет семантику from/to/limit. */
function fixtureSource(candles: Candle[], failures: Array<MarketDataError | TypeError> = []): MarketDataSource & {
  calls: CandleQuery[];
} {
  const calls: CandleQuery[] = [];
  return {
    id: FIXTURE_SOURCE,
    calls,
    async fetchCandles(q) {
      calls.push(q);
      const failure = failures.shift();
      if (failure) throw failure;
      return candles
        .filter((c) => c.openTime >= (q.from ?? -Infinity) && c.openTime < (q.to ?? Infinity))
        .slice(0, q.limit);
    },
    async listSymbols() {
      return ["TEST/USDT"];
    },
  };
}

describe("ingestHistory", () => {
  let store: SqliteStore;
  beforeEach(() => {
    store = new SqliteStore(":memory:");
  });
  afterEach(() => store.close());

  const base = { symbol: "TEST/USDT", timeframe: "1m" as const, sleep: async () => {} };

  it("paginates until the range is covered and stores every candle", async () => {
    const candles = makeCandles(sawtooth(25), { start: T0 });
    const source = fixtureSource(candles);
    const report = await ingestHistory({
      ...base, source, store, from: T0, to: T0 + 25 * M, pageLimit: 10, now: () => T0 + 100 * M,
    });

    expect(source.calls.map((c) => c.from)).toEqual([T0, T0 + 10 * M, T0 + 20 * M]);
    expect(report).toMatchObject({ pages: 3, received: 25, storedClosed: 25, expected: 25, gaps: [] });
    expect(store.getCandles(FIXTURE_SOURCE, { symbol: "TEST/USDT", timeframe: "1m" })).toEqual(candles);
  });

  it("reports gaps from the source without filling them", async () => {
    const candles = makeCandles(sawtooth(10), { start: T0 }).filter((_, i) => i !== 3 && i !== 4);
    const report = await ingestHistory({
      ...base, source: fixtureSource(candles), store, from: T0, to: T0 + 10 * M, now: () => T0 + 100 * M,
    });
    expect(report.gaps).toEqual([{ from: T0 + 3 * M, to: T0 + 5 * M, missing: 2 }]);
    expect(report.storedClosed).toBe(8);
  });

  it("does not expect the still-forming candle and stores it as unclosed", async () => {
    const candles = makeCandles(sawtooth(5), { start: T0, lastOpen: true });
    const report = await ingestHistory({
      ...base, source: fixtureSource(candles), store, from: T0, to: T0 + 60 * M, now: () => T0 + 4 * M + 30_000,
    });
    expect(report).toMatchObject({ expectedUntil: T0 + 4 * M, expected: 4, storedClosed: 4, unclosedReceived: 1, gaps: [] });
  });

  it("retries rate limits and network errors with the hinted delay", async () => {
    const delays: number[] = [];
    const source = fixtureSource(makeCandles([1, 2], { start: T0 }), [
      new MarketDataError("rate", 429, 5_000),
      new TypeError("fetch failed"),
    ]);
    const report = await ingestHistory({
      ...base, source, store, from: T0, to: T0 + 2 * M, now: () => T0 + 10 * M,
      sleep: async (ms) => void delays.push(ms),
    });
    expect(delays).toEqual([5_000, 2_000]);
    expect(report.received).toBe(2);
  });

  it("does not retry an IP ban (418)", async () => {
    const source = fixtureSource([], [new MarketDataError("banned", 418)]);
    await expect(ingestHistory({ ...base, source, store, from: T0, to: T0 + M })).rejects.toMatchObject({ status: 418 });
    expect(source.calls).toHaveLength(1);
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      ingestHistory({ ...base, source: fixtureSource([]), store, from: T0, to: T0 + M, signal: controller.signal }),
    ).rejects.toThrow();
  });
});
