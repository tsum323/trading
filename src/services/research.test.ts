import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Candle, MarketDataSource } from "@/modules/market-data";
import { FileArchive } from "@/modules/storage";
import type { Strategy } from "@/modules/strategies";
import { FIXTURE_SOURCE } from "@/test/fixtures";
import {
  assertHoldoutAllowed,
  HoldoutUsedError,
  journalEntry,
  planSplit,
  renderResearchReport,
  runResearch,
  segmentRange,
  type JournalEntry,
} from "./research";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

describe("planSplit", () => {
  it("splits 60/20/20 on UTC day boundaries", () => {
    const p = planSplit(T0 + 5 * 3_600_000, T0 + 100 * DAY + 1, 0);
    expect(p).toEqual({ from: T0, researchEnd: T0 + 60 * DAY, validationEnd: T0 + 80 * DAY, to: T0 + 100 * DAY, createdAt: 0 });
    expect(segmentRange(p, "validation")).toEqual({ from: T0 + 60 * DAY, to: T0 + 80 * DAY });
    expect(segmentRange(p, "holdout")).toEqual({ from: T0 + 80 * DAY, to: T0 + 100 * DAY });
  });

  it("rejects too short periods", () => {
    expect(() => planSplit(T0, T0 + 5 * DAY, 0)).toThrow(RangeError);
  });
});

describe("assertHoldoutAllowed", () => {
  const strategy = { id: "s", version: "1" } as Strategy;
  const entry = (segment: JournalEntry["segment"], version = "1") => ({ segment, strategyId: "s", strategyVersion: version, at: 0, verdict: "rejected" }) as JournalEntry;

  it("allows the first holdout run and any number of research/validation runs", () => {
    expect(() => assertHoldoutAllowed([entry("research"), entry("validation"), entry("research")], strategy)).not.toThrow();
  });

  it("refuses a second holdout run for the same version, allows a new version", () => {
    expect(() => assertHoldoutAllowed([entry("holdout")], strategy)).toThrow(HoldoutUsedError);
    expect(() => assertHoldoutAllowed([entry("holdout", "0")], strategy)).not.toThrow();
  });
});

/** СИНТЕТИЧЕСКИЕ ровные свечи 1h (high/low = 100 ± 1). Источник отдаёт только закрытые к now. */
function flatSource(now: number): MarketDataSource {
  return {
    id: FIXTURE_SOURCE,
    async fetchCandles(q) {
      const out: Candle[] = [];
      for (let t = q.from ?? T0; t < Math.min(q.to ?? Infinity, now) && out.length < (q.limit ?? 1000); t += 3_600_000) {
        out.push({
          source: FIXTURE_SOURCE, symbol: q.symbol, timeframe: q.timeframe, openTime: t, closeTime: t + 3_600_000,
          open: 100, high: 101, low: 99, close: 100, volume: 1, isClosed: t + 3_600_000 <= now,
        });
      }
      return out;
    },
    async listSymbols() {
      return [];
    },
  };
}

describe("runResearch", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trading-research-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads nothing after the segment end and pools symbols", async () => {
    const decisions: number[] = [];
    /** Тестовая стратегия: лонг каждые 6 часов, стоп/цель ±2% (не достигаются), срок 3 свечи. */
    const spy: Strategy = {
      id: "spy", version: "0", timeframe: "1h", warmup: 5, lookback: 5,
      evaluate(ctx) {
        decisions.push(...ctx.candles.map((c) => c.closeTime));
        const c = ctx.candles.at(-1)!;
        if ((c.closeTime / 3_600_000) % 6 !== 0) return null;
        return {
          basisCloseTime: c.closeTime, direction: "long", entry: { type: "next-open", referencePrice: 100 },
          stopLoss: 98, takeProfits: [102], expiresAt: c.closeTime + 3 * 3_600_000, features: {}, rule: "test",
        };
      },
    };
    const plan = planSplit(T0, T0 + 30 * DAY, 0);
    const now = T0 + 40 * DAY;
    const archive = new FileArchive(dir);
    const r = await runResearch({
      source: flatSource(now), archive, strategy: spy, symbols: ["A/USDT", "B/USDT"], plan, segment: "research",
      runs: 20, now: () => now, sleep: async () => {},
    });

    const range = segmentRange(plan, "research");
    expect(Math.max(...decisions)).toBeLessThanOrEqual(range.to);
    expect(archive.lastCandle(FIXTURE_SOURCE, "A/USDT", "1h")!.closeTime).toBe(range.to);
    expect(r.perSymbol.map((s) => s.symbol)).toEqual(["A/USDT", "B/USDT"]);
    expect(r.stats.trades).toBe(r.perSymbol[0]!.stats.trades + r.perSymbol[1]!.stats.trades);
    expect(r.stats.byStatus.expired).toBe(r.stats.trades); // ровный рынок: только истечения
    expect(r.report.checks.map((c) => c.name)).toContain("not concentrated in one symbol");

    const entry = journalEntry(r, { at: now, codeCommit: "abc", seed: 1, runs: 20 });
    expect(entry).toMatchObject({ segment: "research", from: range.from, to: range.to, symbols: ["A/USDT", "B/USDT"], trades: r.stats.trades });
    expect(renderResearchReport(r, plan, [entry], { at: now, codeCommit: "abc" })).toContain(`**Вердикт: ${r.report.verdict}**`);
  });

  it("refuses a segment that ends in the future", async () => {
    const plan = planSplit(T0, T0 + 30 * DAY, 0);
    await expect(
      runResearch({ source: flatSource(T0), archive: new FileArchive(dir), strategy: {} as Strategy, symbols: [], plan, segment: "holdout", now: () => T0 }),
    ).rejects.toThrow(/future/);
  });
});
