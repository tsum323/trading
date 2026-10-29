import { describe, expect, it } from "vitest";
import { DEFAULT_COSTS } from "@/modules/backtest";
import type { Candle } from "@/modules/market-data";
import { FIXTURE_SOURCE } from "@/test/fixtures";
import { mondays, runRotationResearch } from "./rotation-research";

const D = 86_400_000;
const T0 = Date.UTC(2025, 0, 6); // понедельник

/** СИНТЕТИЧЕСКИЕ дневные свечи: цена — функция номера дня. Не рыночные данные. */
function daily(symbol: string, days: number, price: (d: number) => number): Candle[] {
  return Array.from({ length: days }, (_, d) => ({
    source: FIXTURE_SOURCE, symbol, timeframe: "1d" as const, openTime: T0 + d * D, closeTime: T0 + (d + 1) * D,
    open: price(d), close: price(d + 1), high: Math.max(price(d), price(d + 1)), low: Math.min(price(d), price(d + 1)), volume: 1, isClosed: true,
  }));
}

describe("rotation research", () => {
  it("uses only whole weeks inside the segment, starting on Mondays", () => {
    const w = mondays(T0 + D, T0 + 22 * D);
    expect(w).toEqual([T0 + 7 * D, T0 + 14 * D]);
    // Неделя, которая кончается ровно на границе части, не берётся: её конечная цена — уже в следующей части.
    expect(mondays(T0, T0 + 14 * D)).toEqual([T0]);
    expect(new Date(w[0]!).getUTCDay()).toBe(1);
  });

  const range = { from: T0 + 35 * D, to: T0 + 35 * D + 30 * 7 * D };
  const days = 35 + 31 * 7;

  it("holds the two strongest coins with positive momentum and pays costs on turnover", () => {
    const set = new Map([
      ["UP/USDT", daily("UP/USDT", days, (d) => 100 * 1.01 ** d)],
      ["MID/USDT", daily("MID/USDT", days, (d) => 100 * 1.002 ** d)],
      ["DOWN/USDT", daily("DOWN/USDT", days, (d) => 100 * 0.995 ** d)],
      ["FLAT/USDT", daily("FLAT/USDT", days, () => 100)],
    ]);
    const r = runRotationResearch({ daily: set, range, segment: "research", symbols: [...set.keys()], runs: 200 });
    expect(r.weeks).toHaveLength(29);
    expect(Object.keys(r.weeks[0]!.weights).sort()).toEqual(["MID/USDT", "UP/USDT"]);
    // Первая неделя покупает с нуля: издержки на весь объём.
    expect(r.weeks[0]!.costPct).toBeCloseTo(DEFAULT_COSTS.feeRate + DEFAULT_COSTS.slippage, 12);
    // Дальше переставляется только дрейф долей — копейки.
    expect(r.weeks[5]!.costPct).toBeLessThan(0.0005);
    expect(r.stats.meanWeekly).toBeGreaterThan(r.baseline.p95);
    // Почти весь прирост — от одной монеты: критерий концентрации не пройден.
    expect(r.checks.find((c) => c.name === "not concentrated in one coin")!.passed).toBe(false);
    expect(r.verdict).toBe("insufficient-data"); // 29 недель < 52
  });

  it("stays in cash when nothing has positive momentum", () => {
    const set = new Map([
      ["A/USDT", daily("A/USDT", days, (d) => 100 * 0.99 ** d)],
      ["B/USDT", daily("B/USDT", days, (d) => 100 * 0.995 ** d)],
    ]);
    const r = runRotationResearch({ daily: set, range, segment: "research", symbols: [...set.keys()], runs: 50 });
    expect(r.weeks.every((w) => Object.keys(w.weights).length === 0 && w.ret === 0)).toBe(true);
  });

  it("decides on closes known at the decision time only", () => {
    // B взлетает в день решения (свеча понедельника ещё не закрыта): решение его не видит.
    const first = mondays(range.from, range.to)[0]!;
    const jumpDay = (first - T0) / D;
    const set = new Map([
      ["A/USDT", daily("A/USDT", days, (d) => 100 * 1.002 ** d)],
      ["B/USDT", daily("B/USDT", days, (d) => (d > jumpDay ? 200 : 100))],
    ]);
    const r = runRotationResearch({ daily: set, range, segment: "research", symbols: [...set.keys()], runs: 20 });
    expect(Object.keys(r.weeks[0]!.weights)).toEqual(["A/USDT"]);
  });
});
