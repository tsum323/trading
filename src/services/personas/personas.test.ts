import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TIMEFRAME_MS } from "@/core/time";
import { DEFAULT_COSTS } from "@/modules/backtest";
import type { Candle } from "@/modules/market-data";
import { lossPerUnit } from "@/modules/risk";
import { FileArchive } from "@/modules/storage";
import type { Strategy } from "@/modules/strategies";
import { FIXTURE_SOURCE } from "@/test/fixtures";
import { rebalanceTimes, runPortfolioTrader, targetWeights, type Rebalance } from "./portfolio-trader";
import { INITIAL_EQUITY, MAX_POSITION_SHARE, RISK_PER_TRADE, type PortfolioPersonaDef, type SignalPersonaDef } from "./roster";
import { personaPath, runSignalTrader, type PersonaEntry, type PersonaExit } from "./signal-trader";

/** Старт счетов в тестах. */
const START = Date.UTC(2026, 9, 1);
const H = TIMEFRAME_MS["1h"];
const D = TIMEFRAME_MS["1d"];

/** СИНТЕТИЧЕСКИЕ свечи для тестов: цена по формуле, не рыночные данные. */
function candles(symbol: string, timeframe: "1h" | "1d", from: number, n: number, price: (i: number) => number): Candle[] {
  const size = TIMEFRAME_MS[timeframe];
  return Array.from({ length: n }, (_, i) => {
    const open = price(i);
    const close = price(i + 1);
    return {
      source: FIXTURE_SOURCE, symbol, timeframe, openTime: from + i * size, closeTime: from + (i + 1) * size,
      open, close, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, volume: 1, isClosed: true,
    };
  });
}

/** Тестовая стратегия: лонг на каждой свече, стоп −1%, цель +1%, срок 3 свечи. Не торговая идея. */
const everyBar: Strategy = {
  id: "test-every-bar", version: "0", timeframe: "1h", warmup: 2, lookback: 3,
  evaluate(ctx) {
    const c = ctx.candles.at(-1)!;
    return {
      basisCloseTime: c.closeTime, direction: "long", entry: { type: "next-open", referencePrice: c.close },
      stopLoss: c.close * 0.99, takeProfits: [c.close * 1.01], expiresAt: c.closeTime + 3 * H, features: {}, rule: "test",
    };
  },
};

const signalPersona: SignalPersonaDef = {
  id: "t", name: "T", emoji: "🧪", tagline: "", rules: [], kind: "signals", strategyKey: "-", adaptive: false, timeframe: "1h", symbols: ["A/USDT"],
};

describe("personas", () => {
  let dir: string;
  let archive: FileArchive;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trading-personas-"));
    archive = new FileArchive(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe("signal trader", () => {
    // Рост 0,3% за час: каждая сделка доходит до цели +1% за несколько свечей.
    const up = (i: number) => 100 * 1.003 ** i;

    it("replays from the start, keeps one position per symbol and sizes by 1% risk", () => {
      archive.upsertCandles(candles("A/USDT", "1h", START - 5 * H, 30, up));
      const now = START + 25 * H + 1;
      const r = runSignalTrader({ archive, sourceId: FIXTURE_SOURCE, persona: signalPersona, strategy: everyBar, start: START, now, codeCommit: "abc" });
      expect(r.newEntries.length).toBeGreaterThan(2);
      expect(r.skippedBusy).toBeGreaterThan(0);
      expect(r.newEntries.every((e) => e.signal.createdAt > START)).toBe(true);
      // До запуска (минус одна свеча) — реплей; последняя свеча перед запуском уже «вовремя».
      expect(r.newEntries.every((e) => e.mode === (e.signal.createdAt + H < now ? "replay" : "live"))).toBe(true);

      // Не пересекаются: следующая сделка — не раньше выхода предыдущей.
      const exits = new Map(r.newExits.map((x) => [x.signalId, x]));
      for (let i = 1; i < r.newEntries.length; i++) {
        const prevExit = exits.get(r.newEntries[i - 1]!.signal.id)!;
        expect(r.newEntries[i]!.signal.createdAt).toBeGreaterThanOrEqual(prevExit.exitTime!);
      }

      // Размер: 1% риска, но номинал не больше 20% капитала (стоп −1% → упираемся в 20%).
      const first = r.newEntries[0]!;
      const ref = first.signal.entry.referencePrice;
      const unit = lossPerUnit("long", ref, first.signal.stopLoss, DEFAULT_COSTS.feeRate);
      expect(first.equityAtEntry).toBe(INITIAL_EQUITY);
      expect(first.qty).toBeCloseTo(Math.min((INITIAL_EQUITY * RISK_PER_TRADE) / unit, (INITIAL_EQUITY * MAX_POSITION_SHARE) / ref), 9);

      // Капитал следующей сделки включает результат закрытой.
      const firstExit = exits.get(first.signal.id)!;
      expect(firstExit.status).toBe("target");
      expect(firstExit.pnlUsd).toBeGreaterThan(0);
      expect(r.newEntries[1]!.equityAtEntry).toBeCloseTo(INITIAL_EQUITY + firstExit.pnlUsd, 9);
    });

    it("only appends: a repeated cycle without new candles records nothing", () => {
      archive.upsertCandles(candles("A/USDT", "1h", START - 5 * H, 30, up));
      const now = START + 25 * H + 1;
      runSignalTrader({ archive, sourceId: FIXTURE_SOURCE, persona: signalPersona, strategy: everyBar, start: START, now, codeCommit: null });
      const before = archive.readJsonl<PersonaEntry>(personaPath("t", "entries")).length;
      const again = runSignalTrader({ archive, sourceId: FIXTURE_SOURCE, persona: signalPersona, strategy: everyBar, start: START, now: now + 60_000, codeCommit: null });
      expect(again.newEntries).toEqual([]);
      expect(again.newExits).toEqual([]);
      expect(archive.readJsonl<PersonaEntry>(personaPath("t", "entries")).length).toBe(before);
    });

    it("marks decisions after launch as live, and exits are recorded once", () => {
      const all = candles("A/USDT", "1h", START - 5 * H, 40, up);
      archive.upsertCandles(all.slice(0, 20));
      const launch = all[19]!.closeTime + 1;
      runSignalTrader({ archive, sourceId: FIXTURE_SOURCE, persona: signalPersona, strategy: everyBar, start: START, now: launch, codeCommit: null });
      archive.upsertCandles(all.slice(20, 30));
      const later = all[29]!.closeTime + 1;
      const r = runSignalTrader({ archive, sourceId: FIXTURE_SOURCE, persona: signalPersona, strategy: everyBar, start: START, now: later, codeCommit: null });
      expect(r.newEntries.length).toBeGreaterThan(0);
      // Каждое из этих решений записано позже чем через час — late, но не replay.
      expect(r.newEntries.every((e) => e.mode !== "replay")).toBe(true);

      const exits = archive.readJsonl<PersonaExit>(personaPath("t", "exits"));
      expect(new Set(exits.map((x) => x.signalId)).size).toBe(exits.length);
    });
  });

  describe("portfolio trader", () => {
    it("schedules the start and every Monday 00:00 UTC", () => {
      expect(rebalanceTimes("once", null, START + 30 * D, START)).toEqual([START]);
      expect(rebalanceTimes("once", START, START + 30 * D, START)).toEqual([]);
      // 2026-10-01 — четверг; понедельники — 5 и 12 октября.
      expect(rebalanceTimes("weekly", null, Date.UTC(2026, 9, 12), START)).toEqual([START, Date.UTC(2026, 9, 5), Date.UTC(2026, 9, 12)]);
      expect(rebalanceTimes("weekly", Date.UTC(2026, 9, 5), Date.UTC(2026, 9, 18), START)).toEqual([Date.UTC(2026, 9, 12)]);
    });

    const rotator: PortfolioPersonaDef = {
      id: "rot", name: "R", emoji: "🔄", tagline: "", rules: [], kind: "portfolio", schedule: "weekly",
      allocation: { type: "momentum", lookbackDays: 3, top: 2 }, timeframe: "1d", symbols: ["A/USDT", "B/USDT", "C/USDT"],
    };

    it("picks the strongest coins with positive momentum", () => {
      const daily = new Map([
        ["A/USDT", candles("A/USDT", "1d", START - 10 * D, 10, (i) => 100 + i)],
        ["B/USDT", candles("B/USDT", "1d", START - 10 * D, 10, (i) => 100 + 3 * i)],
        ["C/USDT", candles("C/USDT", "1d", START - 10 * D, 10, (i) => 100 - i)],
      ]);
      expect(targetWeights(rotator, daily, START).weights).toEqual({ "B/USDT": 0.5, "A/USDT": 0.5 });
      // Свечи, закрытые после момента решения, не учитываются: за 8 дней до старта истории ещё мало.
      expect(targetWeights(rotator, daily, START - 8 * D).weights).toEqual({});
    });

    it("waits for the execution candle when the start is not on an hour boundary", () => {
      const holder: PortfolioPersonaDef = {
        id: "hold2", name: "H", emoji: "💎", tagline: "", rules: [], kind: "portfolio", schedule: "once",
        allocation: { type: "fixed", weights: { "A/USDT": 1 } }, timeframe: "1d", symbols: ["A/USDT"],
      };
      const start = START + 15 * 60_000;
      archive.upsertCandles(candles("A/USDT", "1h", START, 1, () => 200));
      expect(runPortfolioTrader({ archive, sourceId: FIXTURE_SOURCE, persona: holder, start, now: start + 30 * 60_000, codeCommit: null })).toEqual([]);
      archive.upsertCandles(candles("A/USDT", "1h", START + H, 1, () => 210));
      const [r] = runPortfolioTrader({ archive, sourceId: FIXTURE_SOURCE, persona: holder, start, now: START + 2 * H, codeCommit: null }) as [Rebalance];
      expect(r.at).toBe(start);
      expect(r.prices["A/USDT"]).toBe(210);
    });

    it("buys at the next hourly open and pays fees and slippage", () => {
      const holder: PortfolioPersonaDef = {
        id: "hold", name: "H", emoji: "💎", tagline: "", rules: [], kind: "portfolio", schedule: "once",
        allocation: { type: "fixed", weights: { "A/USDT": 1 } }, timeframe: "1d", symbols: ["A/USDT"],
      };
      archive.upsertCandles(candles("A/USDT", "1h", START, 5, (i) => 200 + i));
      const [r] = runPortfolioTrader({ archive, sourceId: FIXTURE_SOURCE, persona: holder, start: START, now: START + 5 * H, codeCommit: null }) as [Rebalance];
      expect(r.prices["A/USDT"]).toBe(200);
      const cost = INITIAL_EQUITY * (DEFAULT_COSTS.feeRate + DEFAULT_COSTS.slippage);
      expect(r.costUsd).toBeCloseTo(cost, 9);
      expect(r.holdings["A/USDT"]! * 200).toBeCloseTo(INITIAL_EQUITY - cost, 6);
      expect(r.cash).toBeCloseTo(0, 6);
      expect(runPortfolioTrader({ archive, sourceId: FIXTURE_SOURCE, persona: holder, start: START, now: START + 6 * H, codeCommit: null })).toEqual([]);
    });
  });
});
