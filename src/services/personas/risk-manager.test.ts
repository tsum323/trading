import { describe, expect, it } from "vitest";
import { curveAt, managerCurve, managerWeights, type ManagerRebalance } from "./manager-trader";
import { decideRisk, riskState, RISK_RULES, type ClosedTrade } from "./risk-manager";
import { INITIAL_EQUITY, type ManagerPersonaDef } from "./roster";

/** Старт счетов в тестах. */
const START = Date.UTC(2026, 9, 1);
const H = 3_600_000;
const D = 24 * H;
const T = START + 30 * D;

const trade = (exitTime: number, pnlUsd: number, extra: Partial<ClosedTrade> = {}): ClosedTrade => ({
  symbol: "BTC/USDT", direction: "long", exitTime, pnlUsd, r: pnlUsd / 100, ...extra,
});

describe("risk manager", () => {
  it("risks 1% normally and less in drawdown", () => {
    expect(riskState([], T)).toMatchObject({ status: "normal", riskFraction: 0.01, drawdown: 0 });
    // +1000, затем −1650: просадка 15% от 11 000.
    const dd15 = [trade(T - 10 * D, 1000), trade(T - 5 * D, -1650)];
    expect(riskState(dd15, T)).toMatchObject({ status: "cautious", riskFraction: 0.005 });
    const dd25 = [trade(T - 10 * D, 1000), trade(T - 5 * D, -2750)];
    expect(riskState(dd25, T)).toMatchObject({ status: "defensive", riskFraction: 0.0025 });
  });

  it("ignores trades whose outcome is not known yet", () => {
    expect(riskState([trade(T + H, -5000)], T).equity).toBe(INITIAL_EQUITY);
  });

  it("stops new trades for the day after losing 3% in 24 hours", () => {
    const closed = [trade(T - 2 * H, -200), trade(T - H, -150)];
    expect(riskState(closed, T).status).toBe("daily-stop");
    expect(decideRisk({ closed, t: T, symbol: "ETH/USDT", direction: "long", openRiskUsd: 0, adaptive: false }).skip).toBe("daily-stop");
    // Через сутки убытки выпадают из окна.
    expect(riskState(closed, T + D).status).not.toBe("daily-stop");
  });

  it("pauses for a week when the drawdown crosses 30%", () => {
    const closed = [trade(T - 20 * D, -3100)];
    expect(riskState(closed, T - 20 * D + H).status).toBe("paused");
    expect(riskState(closed, T - 20 * D + 8 * D)).toMatchObject({ status: "defensive", pausedUntil: null });
  });

  it("cools a coin and direction after recent losses, only for adaptive personas", () => {
    const losses = [1, 2, 3].map((k) => trade(T - k * D, -20, { symbol: "SOL/USDT", direction: "short", r: -1 }));
    const args = { closed: losses, t: T, symbol: "SOL/USDT", direction: "short" as const, openRiskUsd: 0 };
    const adaptive = decideRisk({ ...args, adaptive: true });
    const control = decideRisk({ ...args, adaptive: false });
    if (adaptive.skip || control.skip) throw new Error("unexpected skip");
    expect(adaptive.riskFraction).toBeCloseTo(control.riskFraction * RISK_RULES.coolingFactor, 12);
    expect(adaptive.notes.join()).toContain("охлаждение");
    // Другая монета не охлаждается.
    const other = decideRisk({ ...args, symbol: "BTC/USDT", adaptive: true });
    expect(other.skip === null && other.riskFraction).toBeCloseTo(control.riskFraction, 12);
  });

  it("caps the total open risk at 3% of equity", () => {
    const cut = decideRisk({ closed: [], t: T, symbol: "BTC/USDT", direction: "long", openRiskUsd: 250, adaptive: false });
    expect(cut.skip === null && cut.riskFraction).toBeCloseTo(0.005, 12);
    expect(decideRisk({ closed: [], t: T, symbol: "BTC/USDT", direction: "long", openRiskUsd: 290, adaptive: false }).skip).toBe("risk-cap");
  });
});

describe("manager", () => {
  const manager: ManagerPersonaDef = {
    id: "m", name: "M", emoji: "🧠", tagline: "", rules: [], kind: "manager", candidates: ["a", "b", "c"],
    lookbackDays: 28, maxWeight: 0.4, timeframe: "1d", symbols: [],
  };
  const linear = (from: number, to: number): [number, number][] =>
    Array.from({ length: 31 }, (_, k) => [START + k * D, from + ((to - from) * k) / 30]);
  const curves = new Map([
    ["a", linear(10_000, 12_000)],
    ["b", linear(10_000, 10_500)],
    ["c", linear(10_000, 9_000)],
  ]);
  const names = new Map([["a", "A"], ["b", "B"], ["c", "C"]]);

  it("splits equally at the start and then favours recent winners, capped at 40%", () => {
    expect(managerWeights(manager, curves, START, names, START).weights).toEqual({ a: 1 / 3, b: 1 / 3, c: 1 / 3 });
    const w = managerWeights(manager, curves, START + 30 * D, names, START);
    expect(Object.keys(w.weights).sort()).toEqual(["a", "b"]);
    expect(w.weights.a).toBe(0.4);
    // Окно 28 дней: со 2-го по 30-й день.
    const from = START + 2 * D;
    const ret = (id: string) => curveAt(curves.get(id)!, START + 30 * D) / curveAt(curves.get(id)!, from) - 1;
    expect(w.weights.b).toBeCloseTo(ret("b") / (ret("a") + ret("b")), 12);
    expect(w.note).toContain("A +");
  });

  it("follows the allocated personas' equity and pays costs on reallocation", () => {
    const log: ManagerRebalance[] = [{ at: START, weights: { a: 0.5, c: 0.5 }, scores: {}, note: "", recordedAt: 0, codeCommit: null, mode: "replay" }];
    const grid = [START, START + 30 * D];
    const m = managerCurve(log, curves, grid);
    const afterCost = INITIAL_EQUITY - m.costs[0]!;
    expect(m.costs[0]).toBeCloseTo(INITIAL_EQUITY * 0.0012, 9);
    expect(m.curve[1]![1]).toBeCloseTo((afterCost / 2) * 1.2 + (afterCost / 2) * 0.9, 6);
    expect(curveAt(curves.get("a")!, START - 1)).toBe(INITIAL_EQUITY);
  });
});
