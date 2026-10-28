import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_SOURCE, makeCandles } from "@/test/fixtures";
import { FileArchive } from "./file-archive";

describe("FileArchive", () => {
  let dir: string;
  let archive: FileArchive;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trading-archive-"));
    archive = new FileArchive(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const q = { symbol: "TEST/USDT", timeframe: "1h" as const };

  it("splits candles into monthly CSV files and reads them back in order", () => {
    // 2024-01-31 22:00 .. 2024-02-01 01:00 — пересекает границу месяца
    const candles = makeCandles([1, 2, 3, 4], { timeframe: "1h", start: Date.UTC(2024, 0, 31, 22) });
    archive.upsertCandles([...candles].reverse());
    expect(archive.getCandles(FIXTURE_SOURCE, q)).toEqual(candles);
    expect(readFileSync(join(dir, "candles", FIXTURE_SOURCE, "TEST-USDT", "1h", "2024-01.csv"), "utf8")).toBe(
      `open_time,open,high,low,close,volume\n${candles.slice(0, 2).map((c) => [c.openTime, c.open, c.high, c.low, c.close, c.volume].join(",")).join("\n")}\n`,
    );
    expect(archive.lastCandle(FIXTURE_SOURCE, "TEST/USDT", "1h")).toEqual(candles[3]);
  });

  it("stores only closed candles and never overwrites a stored one", () => {
    const [a, b] = makeCandles([10, 20], { timeframe: "1h", lastOpen: true });
    archive.upsertCandles([a!, b!]);
    expect(archive.getCandles(FIXTURE_SOURCE, q)).toEqual([a]);
    archive.upsertCandles([{ ...a!, close: 99, high: 100 }]);
    expect(archive.getCandles(FIXTURE_SOURCE, q)).toEqual([a]);
  });

  it("filters by [from, to) and limit", () => {
    const c = makeCandles([1, 2, 3, 4, 5], { timeframe: "1h" });
    archive.upsertCandles(c);
    expect(archive.getCandles(FIXTURE_SOURCE, { ...q, from: c[1]!.openTime, to: c[4]!.openTime })).toEqual(c.slice(1, 4));
    expect(archive.getCandles(FIXTURE_SOURCE, { ...q, from: c[1]!.openTime, limit: 2 })).toEqual(c.slice(1, 3));
  });

  it("round-trips float prices exactly", () => {
    const [c] = makeCandles([0.1 + 0.2], { timeframe: "1h" });
    archive.upsertCandles([{ ...c!, volume: 1 / 3 }]);
    expect(archive.getCandles(FIXTURE_SOURCE, q)[0]).toMatchObject({ close: 0.1 + 0.2, volume: 1 / 3 });
  });

  it("appends and reads JSONL logs", () => {
    archive.appendJsonl("signals/x", [{ a: 1 }]);
    archive.appendJsonl("signals/x", [{ a: 2 }, { a: 3 }]);
    archive.appendJsonl("signals/x", []);
    expect(archive.readJsonl("signals/x")).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(archive.readJsonl("missing")).toEqual([]);
  });
});
