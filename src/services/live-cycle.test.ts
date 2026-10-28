import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SignalOutcome } from "@/modules/backtest";
import type { Candle, MarketDataSource } from "@/modules/market-data";
import { FileArchive } from "@/modules/storage";
import type { Strategy } from "@/modules/strategies";
import { FIXTURE_SOURCE } from "@/test/fixtures";
import { outcomesLog, runLiveCycle, signalsLog, type LiveSignalRecord } from "./live-cycle";
import { renderLiveReport } from "./live-report";

const M = 60_000;
const T0 = Date.UTC(2024, 0, 1);

/**
 * СИНТЕТИЧЕСКИЙ «рынок» 1m: цена 100, а свеча с индексом из `spikes` даёт high 103.
 * Источник отдаёт свечи, открытые к моменту now(); текущая — незакрытая, как у биржи.
 */
function fixtureMarket(clock: { now: number }, spikes: Set<number> = new Set()): MarketDataSource {
  const candle = (i: number): Candle => ({
    source: FIXTURE_SOURCE, symbol: "TEST/USDT", timeframe: "1m",
    openTime: T0 + i * M, closeTime: T0 + (i + 1) * M,
    open: 100, high: spikes.has(i) ? 103 : 101, low: 99, close: 100, volume: 1,
    isClosed: T0 + (i + 1) * M <= clock.now,
  });
  return {
    id: FIXTURE_SOURCE,
    async fetchCandles(q) {
      const out: Candle[] = [];
      for (let t = Math.max(q.from ?? T0, T0); t < Math.min(q.to ?? Infinity, clock.now) && out.length < (q.limit ?? 1000); t += M) {
        out.push(candle((t - T0) / M));
      }
      return out;
    },
    async listSymbols() {
      return ["TEST/USDT"];
    },
  };
}

/** Тестовая стратегия: лонг на каждой свече, стоп −2%, цель +2%, срок 3 свечи. Не торговая идея. */
const everyBar: Strategy = {
  id: "test-every-bar", version: "0", timeframe: "1m", warmup: 2, lookback: 3,
  evaluate(ctx) {
    const c = ctx.candles.at(-1)!;
    return {
      basisCloseTime: c.closeTime, direction: "long",
      entry: { type: "next-open", referencePrice: c.close },
      stopLoss: 98, takeProfits: [102], expiresAt: c.closeTime + 3 * M, features: {}, rule: "test",
    };
  },
};

describe("runLiveCycle", () => {
  let dir: string;
  let archive: FileArchive;
  const clock = { now: 0 };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trading-live-"));
    archive = new FileArchive(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cycle = (source: MarketDataSource, at: number) => {
    clock.now = at;
    return runLiveCycle({ source, archive, strategy: everyBar, symbols: ["TEST/USDT"], now: () => clock.now, codeCommit: "abc", sleep: async () => {} });
  };
  const signals = () => archive.readJsonl<LiveSignalRecord>(signalsLog(everyBar));
  const outcomes = () => archive.readJsonl<SignalOutcome>(outcomesLog(everyBar));

  it("bootstraps history without producing signals (that would be a replay)", async () => {
    const [r] = await cycle(fixtureMarket(clock), T0 + 10 * M + 5_000);
    expect(r).toMatchObject({ bootstrap: true, newSignals: [] });
    expect(archive.lastCandle(FIXTURE_SOURCE, "TEST/USDT", "1m")!.closeTime).toBe(T0 + 10 * M);
    expect(signals()).toEqual([]);
  });

  it("records signals only for decisions after the previous cycle, on time and with the commit", async () => {
    const source = fixtureMarket(clock);
    await cycle(source, T0 + 10 * M + 5_000);
    const [r] = await cycle(source, T0 + 11 * M + 5_000);
    expect(r!.newSignals.map((s) => s.createdAt)).toEqual([T0 + 11 * M]);
    expect(signals()).toEqual([
      { signal: r!.newSignals[0], recordedAt: T0 + 11 * M + 5_000, codeCommit: "abc", late: false },
    ]);
  });

  it("keeps one open signal, resolves it later and marks catch-up signals as late", async () => {
    const source = fixtureMarket(clock, new Set([13]));
    await cycle(source, T0 + 10 * M + 5_000);
    await cycle(source, T0 + 11 * M + 5_000); // сигнал в 11:00, вход в свече №11
    const [r] = await cycle(source, T0 + 20 * M + 5_000); // пропущенные запуски: догоняем 9 свечей

    // Первый сигнал: в свече №13 high 103 ≥ цели 102 → target, exit = close свечи №13 (T0+14m).
    expect(outcomes()[0]).toMatchObject({ signalId: signals()[0]!.signal.id, status: "target", exitTime: T0 + 14 * M });
    // Следующие — не раньше выхода предыдущего: 14 → истёк в 17 → 17 → истёк в 20 → 20.
    expect(signals().map((s) => s.signal.createdAt)).toEqual([T0 + 11 * M, T0 + 14 * M, T0 + 17 * M, T0 + 20 * M]);
    expect(outcomes().slice(1).map((o) => o.status)).toEqual(["expired", "expired"]);
    expect(r!.skippedOverlap).toBe(6);
    expect(r!.openSignals.map((s) => s.createdAt)).toEqual([T0 + 20 * M]);
    // Записаны в 20:05: решения 14 и 17 — запоздалые, решение 20 — вовремя.
    expect(signals().map((s) => s.late)).toEqual([false, true, true, false]);
  });

  it("is idempotent when nothing new has closed", async () => {
    const source = fixtureMarket(clock);
    await cycle(source, T0 + 10 * M + 5_000);
    await cycle(source, T0 + 11 * M + 5_000);
    const before = [signals(), outcomes()];
    await cycle(source, T0 + 11 * M + 30_000);
    expect([signals(), outcomes()]).toEqual(before);
  });

  it("renders a report that excludes late signals from statistics", async () => {
    const source = fixtureMarket(clock, new Set([13]));
    await cycle(source, T0 + 10 * M + 5_000);
    await cycle(source, T0 + 11 * M + 5_000);
    const reports = await cycle(source, T0 + 20 * M + 5_000);
    const md = renderLiveReport(archive, everyBar, reports, clock.now);
    // Вовремя: решение 11 (target) и решение 20 (ещё открыт); запоздалые истёкшие в статистику не входят.
    expect(md).toContain("Сигналов всего: 4, вовремя: 2, запоздалых: 2");
    expect(md).toContain("target 1, stop 0, expired 0");
    expect(md).toMatch(/Сделок с результатом: 1,/);
  });
});
