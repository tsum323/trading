import { describe, expect, it } from "vitest";
import type { Candle } from "@/modules/market-data";
import { FIXTURE_SOURCE } from "@/test/fixtures";
import { BRAIN, classifyLoss, confidence, lessonAllows, reviewLesson, skillScores, trustedSkills } from "./brain";
import type { ShadowExit } from "./shadow";
import { lessonState, type LessonEvent } from "./trader";

const D = 86_400_000;
const T = Date.UTC(2026, 10, 1);

const exit = (skillId: string, daysAgo: number, r: number): ShadowExit => ({
  signalId: `${skillId}:${daysAgo}:${r}`, skillId, status: r > 0 ? "target" : "stop", exitTime: T - daysAgo * D, rMultiple: r,
  grossR: r, evaluatedAt: T, evaluatorVersion: "1",
});

describe("autonomous brain", () => {
  it("scores skills by recent training trades, shrunk towards zero", () => {
    const exits = [...Array.from({ length: 10 }, (_, i) => exit("good", i, 1)), exit("lucky", 1, 3), ...Array.from({ length: 10 }, (_, i) => exit("bad", i, -1))];
    const s = skillScores(exits, ["good", "lucky", "bad"], T);
    const good = s.find((x) => x.skillId === "good")!;
    const lucky = s.find((x) => x.skillId === "lucky")!;
    // Одна удачная сделка весит меньше десяти стабильных.
    expect(good.score).toBeGreaterThan(lucky.score);
    expect(lucky.score).toBeLessThan(3 / (1 + BRAIN.shrinkTrades) + 1e-9);
    // Только известные к моменту решения исходы.
    expect(skillScores(exits, ["good"], T - 5.5 * D)[0]!.trades).toBe(4); // закрытые 6–9 дней назад
    const trusted = trustedSkills(s, new Set()).map((x) => x.skillId);
    expect(trusted).toEqual(["good"]); // lucky — мало сделок, bad — в минусе
    expect(trustedSkills(s, new Set(["good"]))[0]!.score).toBeCloseTo(good.score * BRAIN.demoteFactor, 12);
  });

  it("older trades weigh less: a recent bad streak outweighs an old good one", () => {
    const exits = [...Array.from({ length: 10 }, (_, i) => exit("x", 100 + i, 1)), ...Array.from({ length: 10 }, (_, i) => exit("x", i, -1))];
    expect(skillScores(exits, ["x"], T)[0]!.score).toBeLessThan(0);
  });

  it("scales risk by confidence between a quarter and full", () => {
    expect(confidence(0.01)).toBe(0.25);
    expect(confidence(0.15)).toBeCloseTo(0.5, 12);
    expect(confidence(1)).toBe(1);
  });

  /** СИНТЕТИЧЕСКИЕ свечи после выхода — не рыночные данные. */
  const after = (highs: number[]): Candle[] =>
    highs.map((h, i) => ({ source: FIXTURE_SOURCE, symbol: "A/USDT", timeframe: "4h", openTime: T + i * 4 * 3_600_000, closeTime: T + (i + 1) * 4 * 3_600_000, open: 100, high: h, low: 95, close: 100, volume: 1, isClosed: true }));

  it("diagnoses losses: noise stops, trend, volatility, costs, instant stops", () => {
    const base = { direction: "long" as const, status: "stop", target: 110, entryTime: T - 40 * 3_600_000, exitTime: T, barMs: 4 * 3_600_000, netR: -1 };
    expect(classifyLoss({ ...base, grossR: -0.9, context: { trend: "long", atrRank: 0.5 }, after: after([105, 111]) })).toEqual(["noise-stop"]);
    expect(classifyLoss({ ...base, grossR: -0.9, context: { trend: "short", atrRank: 0.95 }, after: after([101]) })).toEqual(["against-trend", "high-volatility"]);
    expect(classifyLoss({ ...base, status: "expired", grossR: 0.1, netR: -0.2, context: { trend: "long", atrRank: 0.5 }, after: [] })).toEqual(["costs"]);
    expect(classifyLoss({ ...base, entryTime: T - 4 * 3_600_000, grossR: -1, context: { trend: null, atrRank: null }, after: [] })).toEqual(["instant"]);
  });

  it("applies lessons as filters", () => {
    const ctx = { trend: "short" as const, atrRank: 0.95 };
    expect(lessonAllows("trend-filter", { direction: "long", costShare: 0.1 }, ctx)).toBe(false);
    expect(lessonAllows("trend-filter", { direction: "short", costShare: 0.1 }, ctx)).toBe(true);
    expect(lessonAllows("calm-only", { direction: "short", costShare: 0.1 }, ctx)).toBe(false);
    expect(lessonAllows("cost-guard", { direction: "short", costShare: 0.25 }, ctx)).toBe(false);
  });

  it("revokes a lesson when the trades it blocked did better than the ones it let through", () => {
    expect(reviewLesson([1, 1, 1], [0])).toBeNull(); // мало данных
    expect(reviewLesson(Array(8).fill(0.5), Array(8).fill(-0.2))).toBe("revoke");
    expect(reviewLesson(Array(8).fill(-0.5), Array(8).fill(0.1))).toBe("keep");
  });

  it("folds the lesson journal into the state at a moment", () => {
    const events: LessonEvent[] = [
      { at: T, kind: "activate", lesson: "trend-filter", evidence: "" },
      { at: T + D, kind: "demote", skillId: "s", until: T + 10 * D, evidence: "" },
      { at: T + 2 * D, kind: "revoke", lesson: "trend-filter", evidence: "" },
    ];
    expect([...lessonState(events, T + D).filters.keys()]).toEqual(["trend-filter"]);
    expect(lessonState(events, T + 3 * D).filters.size).toBe(0);
    expect(lessonState(events, T + 3 * D).revokedAt.get("trend-filter")).toBe(T + 2 * D);
    expect(lessonState(events, T + 5 * D).demoted.has("s")).toBe(true);
    expect(lessonState(events, T + 11 * D).demoted.has("s")).toBe(false);
  });
});
