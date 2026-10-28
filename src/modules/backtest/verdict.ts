import type { BaselineResult } from "./baseline";
import type { TradeStats } from "./stats";

export const MIN_TRADES = 100;
export const MAX_TOP_MONTH_SHARE = 0.5;

export type Verdict = "insufficient-data" | "rejected" | "not-rejected";

export interface VerdictReport {
  verdict: Verdict;
  checks: { name: string; passed: boolean; detail: string }[];
}

/**
 * Критерии отказа от гипотезы (docs/strategy-spec.md §6). «not-rejected»
 * не означает прибыльность: вывод действителен только на отложенной выборке
 * и в перспективном тесте (docs/validation-plan.md §2, §6).
 */
export function judge(stats: TradeStats, baseline: BaselineResult): VerdictReport {
  const fmt = (x: number) => x.toFixed(3);
  const checks = [
    {
      name: "enough trades",
      passed: stats.trades >= MIN_TRADES,
      detail: `${stats.trades} trades (need >= ${MIN_TRADES})`,
    },
    {
      name: "CI lower bound > 0",
      passed: stats.ci95 !== null && stats.ci95[0] > 0,
      detail: stats.ci95 ? `95% CI [${fmt(stats.ci95[0])}, ${fmt(stats.ci95[1])}] R` : "no CI",
    },
    {
      name: "beats random baseline p95",
      passed: baseline.runs > 0 && stats.expectancyR > baseline.p95,
      detail: `expectancy ${fmt(stats.expectancyR)} R vs baseline p95 ${fmt(baseline.p95)} R (${baseline.runs} runs)`,
    },
    {
      name: "not concentrated in one month",
      passed: stats.topMonthShare !== null && stats.topMonthShare <= MAX_TOP_MONTH_SHARE,
      detail: stats.topMonthShare === null ? "total R <= 0" : `top month = ${(stats.topMonthShare * 100).toFixed(0)}% of total R`,
    },
  ];
  const verdict: Verdict = !checks[0]!.passed ? "insufficient-data" : checks.every((c) => c.passed) ? "not-rejected" : "rejected";
  return { verdict, checks };
}
