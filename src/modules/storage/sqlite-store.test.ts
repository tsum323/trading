import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_SOURCE, makeCandles } from "@/test/fixtures";
import type { SignalOutcome } from "@/modules/backtest";
import type { TradingSignal } from "@/modules/strategies";
import { MIGRATIONS } from "./schema";
import { SqliteStore } from "./sqlite-store";

describe("migrations", () => {
  it("upgrades a v1 database and keeps existing outcomes", () => {
    const dir = mkdtempSync(join(tmpdir(), "trading-migr-"));
    const path = join(dir, "v1.db");
    try {
      const v1 = new DatabaseSync(path);
      v1.exec(MIGRATIONS[0]!);
      v1.exec("PRAGMA user_version = 1");
      v1.exec(`INSERT INTO signals VALUES ('s', 'st', '0', 'src', 'X/Y', '1m', 10, 10, 'long', 'next-open', 1, 0.5, '[2]', 20, '{}', 'r', 'replay', 10)`);
      v1.exec(`INSERT INTO signal_outcomes (signal_id, status, r_multiple, evaluated_at, evaluator_version) VALUES ('s', 'stop', -1, 30, '0')`);
      v1.close();

      const store = new SqliteStore(path);
      expect(store.getOutcome("s")).toEqual({ signalId: "s", status: "stop", rMultiple: -1, evaluatedAt: 30, evaluatorVersion: "0" });
      const { user_version } = store.db.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(user_version).toBe(MIGRATIONS.length);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

  it("round-trips outcomes and replaces them on re-evaluation", () => {
    store.insertSignal(signal, "replay", 0);
    const outcome: SignalOutcome = {
      signalId: signal.id, status: "target", entryTime: 60_000, entryPrice: 100, exitTime: 180_000, exitPrice: 102,
      rMultiple: 2, mfeR: 2, maeR: -0.5, evaluatedAt: 1, evaluatorVersion: "1",
    };
    store.saveOutcome(outcome);
    expect(store.getOutcome(signal.id)).toEqual(outcome);

    const noEntry: SignalOutcome = { signalId: signal.id, status: "no-entry", reason: "entry-candle-missing", evaluatedAt: 2, evaluatorVersion: "2" };
    store.saveOutcome(noEntry);
    expect(store.getOutcome(signal.id)).toEqual(noEntry);
  });

  it("rejects an outcome for an unknown signal", () => {
    expect(() => store.saveOutcome({ signalId: "missing", status: "stop", evaluatedAt: 0, evaluatorVersion: "1" })).toThrow();
  });

  it("enforces basisCloseTime <= createdAt at the schema level", () => {
    expect(() => store.insertSignal({ ...signal, id: "bad", basisCloseTime: signal.createdAt + 1 }, "live", 0)).toThrow();
  });
});
