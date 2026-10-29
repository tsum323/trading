import { createRng, quantile } from "@/core/random";
import { formatDateTime, type UnixMs } from "@/core/time";
import { DEFAULT_COSTS, type ExecutionCosts } from "@/modules/backtest";
import type { Candle, MarketSymbol } from "@/modules/market-data";
import type { CheckResult, JournalEntry, Segment, SplitPlan } from "./research";

/** Правила из docs/strategy-rotation.md §2. */
export const ROTATION_ID = "rotation";
export const ROTATION_VERSION = "0.1.0";
export const ROTATION_UNIVERSE: MarketSymbol[] = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT", "ADA/USDT", "DOGE/USDT", "TRX/USDT"];
export const ROTATION_PARAMS = { lookbackDays: 28, top: 2, minWeeks: 52, maxShare: 0.5 } as const;

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const MONDAY0 = Date.UTC(1970, 0, 5);

export interface RotationWeek {
  start: UnixMs;
  /** Доли на неделю (сумма ≤ 1, остаток — USDT). */
  weights: Record<MarketSymbol, number>;
  /** Сила монет на момент решения. */
  scores: Record<MarketSymbol, number>;
  /** Доходность недели после издержек. */
  ret: number;
  /** Доходность без издержек (диагностика). */
  grossRet: number;
  costPct: number;
  /** Вклад монеты в доходность недели. */
  contributions: Record<MarketSymbol, number>;
}

/** Цены, нужные ротации: open дневной свечи по времени открытия и close по времени закрытия. */
class DailyBook {
  private readonly open = new Map<MarketSymbol, Map<UnixMs, number>>();
  private readonly close = new Map<MarketSymbol, Map<UnixMs, number>>();

  constructor(daily: ReadonlyMap<MarketSymbol, readonly Candle[]>) {
    for (const [s, candles] of daily) {
      this.open.set(s, new Map(candles.filter((c) => c.isClosed).map((c) => [c.openTime, c.open])));
      this.close.set(s, new Map(candles.filter((c) => c.isClosed).map((c) => [c.closeTime, c.close])));
    }
  }

  openAt(s: MarketSymbol, t: UnixMs): number | undefined {
    return this.open.get(s)?.get(t);
  }

  closeAt(s: MarketSymbol, t: UnixMs): number | undefined {
    return this.close.get(s)?.get(t);
  }
}

export function mondays(from: UnixMs, to: UnixMs): UnixMs[] {
  const out: UnixMs[] = [];
  // Неделя целиком внутри части: и её open, и open следующего понедельника — до `to`.
  for (let t = MONDAY0 + Math.ceil((from - MONDAY0) / WEEK) * WEEK; t + WEEK < to; t += WEEK) out.push(t);
  return out;
}

/** Сила за lookbackDays по закрытым к t дневным свечам; undefined — нет полной истории. */
export function momentum(book: DailyBook, s: MarketSymbol, t: UnixMs, lookbackDays: number): number | undefined {
  const now = book.closeAt(s, t);
  const then = book.closeAt(s, t - lookbackDays * DAY);
  return now !== undefined && then !== undefined ? now / then - 1 : undefined;
}

type Picker = (weekIndex: number, t: UnixMs, tradable: MarketSymbol[], scores: Record<MarketSymbol, number>) => Record<MarketSymbol, number>;

/** Недельная симуляция портфеля с издержками перестановки. */
function simulate(book: DailyBook, symbols: readonly MarketSymbol[], weeks: readonly UnixMs[], pick: Picker, costs: ExecutionCosts): RotationWeek[] {
  const rate = costs.feeRate + costs.slippage;
  // Текущие доли в стоимости портфеля (после движения цен за прошлую неделю).
  let held: Record<MarketSymbol, number> = {};
  const out: RotationWeek[] = [];
  weeks.forEach((t, k) => {
    const end = t + WEEK;
    const tradable = symbols.filter((s) => book.openAt(s, t) !== undefined && book.openAt(s, end) !== undefined);
    const scores: Record<MarketSymbol, number> = {};
    for (const s of tradable) {
      const m = momentum(book, s, t, ROTATION_PARAMS.lookbackDays);
      if (m !== undefined) scores[s] = m;
    }
    const target = pick(k, t, tradable, scores);
    // Монета без цены на этой неделе (пропуск данных) выходит из портфеля по стоимости на конец прошлой недели.
    const keys = new Set([...Object.keys(held), ...Object.keys(target)]);
    const turnover = [...keys].reduce((sum, s) => sum + Math.abs((target[s] ?? 0) - (held[s] ?? 0)), 0);
    const cost = turnover * rate;
    const after = 1 - cost;
    let gross = 0;
    const contributions: Record<MarketSymbol, number> = {};
    let endValue = after * (1 - Object.values(target).reduce((a, w) => a + w, 0)); // USDT
    for (const [s, w] of Object.entries(target)) {
      const r = book.openAt(s, end)! / book.openAt(s, t)! - 1;
      gross += w * r;
      contributions[s] = after * w * r;
      endValue += after * w * (1 + r);
    }
    held = {};
    for (const [s, w] of Object.entries(target)) {
      const r = book.openAt(s, end)! / book.openAt(s, t)! - 1;
      held[s] = (after * w * (1 + r)) / endValue;
    }
    out.push({ start: t, weights: target, scores, ret: endValue - 1, grossRet: gross, costPct: cost, contributions });
  });
  return out;
}

/** Правило ротации: top-N по силе, только с силой > 0, поровну. */
export const momentumPicker: Picker = (_k, _t, _tradable, scores) => {
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, ROTATION_PARAMS.top).filter(([, m]) => m > 0);
  return Object.fromEntries(ranked.map(([s]) => [s, 1 / ROTATION_PARAMS.top]));
};

export interface RotationStats {
  weeks: number;
  meanWeekly: number;
  meanGrossWeekly: number;
  ci95: [number, number] | null;
  totalReturn: number;
  maxDrawdown: number;
  avgInvested: number;
}

export function weeklyStats(weeks: readonly RotationWeek[], seed = 1, resamples = 5000): RotationStats {
  const rets = weeks.map((w) => w.ret);
  const mean = (xs: readonly number[]) => (xs.length === 0 ? 0 : xs.reduce((a, x) => a + x, 0) / xs.length);
  let value = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const r of rets) {
    value *= 1 + r;
    peak = Math.max(peak, value);
    maxDrawdown = Math.min(maxDrawdown, value / peak - 1);
  }
  let ci95: [number, number] | null = null;
  if (rets.length >= 2) {
    const rng = createRng(seed);
    const means: number[] = [];
    for (let i = 0; i < resamples; i++) {
      let s = 0;
      for (let j = 0; j < rets.length; j++) s += rets[Math.floor(rng() * rets.length)]!;
      means.push(s / rets.length);
    }
    means.sort((a, b) => a - b);
    ci95 = [quantile(means, 0.025), quantile(means, 0.975)];
  }
  return {
    weeks: rets.length,
    meanWeekly: mean(rets),
    meanGrossWeekly: mean(weeks.map((w) => w.grossRet)),
    ci95,
    totalReturn: value - 1,
    maxDrawdown,
    avgInvested: mean(weeks.map((w) => Object.values(w.weights).reduce((a, x) => a + x, 0))),
  };
}

export interface RotationResult {
  segment: Segment;
  range: { from: UnixMs; to: UnixMs };
  symbols: MarketSymbol[];
  weeks: RotationWeek[];
  stats: RotationStats;
  baseline: { runs: number; p50: number; p95: number };
  equalWeight: RotationStats;
  btcHold: RotationStats;
  byMonth: { month: string; weeks: number; logReturn: number }[];
  byCoin: { symbol: MarketSymbol; weeksHeld: number; contribution: number }[];
  checks: CheckResult[];
  verdict: "rejected" | "not-rejected" | "insufficient-data";
}

/** Исследование ротации на одной части разбиения (docs/strategy-rotation.md). */
export function runRotationResearch(opts: {
  daily: ReadonlyMap<MarketSymbol, readonly Candle[]>;
  range: { from: UnixMs; to: UnixMs };
  segment: Segment;
  symbols?: readonly MarketSymbol[];
  runs?: number;
  seed?: number;
  costs?: ExecutionCosts;
}): RotationResult {
  const symbols = [...(opts.symbols ?? ROTATION_UNIVERSE)];
  const costs = opts.costs ?? DEFAULT_COSTS;
  const runs = opts.runs ?? 1000;
  const seed = opts.seed ?? 1;
  const book = new DailyBook(opts.daily);
  const weekStarts = mondays(opts.range.from, opts.range.to);

  const weeks = simulate(book, symbols, weekStarts, momentumPicker, costs);
  const stats = weeklyStats(weeks, seed);

  // Случайная ротация: столько же монет, сколько у стратегии на этой неделе.
  const counts = weeks.map((w) => Object.keys(w.weights).length);
  const rng = createRng(seed + 1);
  const means: number[] = [];
  for (let i = 0; i < runs; i++) {
    const random: Picker = (k, _t, tradable) => {
      const pool = [...tradable];
      const picked: Record<MarketSymbol, number> = {};
      for (let j = 0; j < Math.min(counts[k] ?? 0, pool.length); j++) {
        const s = pool.splice(Math.floor(rng() * pool.length), 1)[0]!;
        picked[s] = 1 / ROTATION_PARAMS.top;
      }
      return picked;
    };
    const w = simulate(book, symbols, weekStarts, random, costs);
    means.push(w.reduce((a, x) => a + x.ret, 0) / Math.max(1, w.length));
  }
  means.sort((a, b) => a - b);
  const baseline = { runs, p50: quantile(means, 0.5), p95: quantile(means, 0.95) };

  const equalWeight = weeklyStats(simulate(book, symbols, weekStarts, (_k, _t, tradable) => Object.fromEntries(tradable.map((s) => [s, 1 / tradable.length])), costs), seed);
  const btcHold = weeklyStats(simulate(book, ["BTC/USDT"], weekStarts, (_k, _t, tradable): Record<MarketSymbol, number> => (tradable.includes("BTC/USDT") ? { "BTC/USDT": 1 } : {}), costs), seed);

  const monthMap = new Map<string, { weeks: number; logReturn: number }>();
  for (const w of weeks) {
    const m = new Date(w.start).toISOString().slice(0, 7);
    const cur = monthMap.get(m) ?? { weeks: 0, logReturn: 0 };
    cur.weeks++;
    cur.logReturn += Math.log(1 + w.ret);
    monthMap.set(m, cur);
  }
  const byMonth = [...monthMap.entries()].sort().map(([month, v]) => ({ month, ...v }));
  const coinMap = new Map<MarketSymbol, { weeksHeld: number; contribution: number }>();
  for (const w of weeks) {
    for (const [s, c] of Object.entries(w.contributions)) {
      const cur = coinMap.get(s) ?? { weeksHeld: 0, contribution: 0 };
      cur.weeksHeld++;
      cur.contribution += c;
      coinMap.set(s, cur);
    }
  }
  const byCoin = [...coinMap.entries()].map(([symbol, v]) => ({ symbol, ...v })).sort((a, b) => b.contribution - a.contribution);

  const totalLog = byMonth.reduce((a, m) => a + m.logReturn, 0);
  const topMonth = totalLog > 0 ? Math.max(...byMonth.map((m) => m.logReturn)) / totalLog : null;
  const positive = byCoin.filter((c) => c.contribution > 0);
  const posSum = positive.reduce((a, c) => a + c.contribution, 0);
  const topCoin = posSum > 0 ? positive[0]!.contribution / posSum : null;
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const checks: CheckResult[] = [
    { name: "enough weeks", passed: stats.weeks >= ROTATION_PARAMS.minWeeks, detail: `${stats.weeks} weeks (need >= ${ROTATION_PARAMS.minWeeks})` },
    { name: "CI lower bound > 0", passed: stats.ci95 !== null && stats.ci95[0] > 0, detail: stats.ci95 ? `95% CI [${pct(stats.ci95[0])}, ${pct(stats.ci95[1])}] per week` : "no CI" },
    { name: "beats random rotation p95", passed: stats.meanWeekly > baseline.p95, detail: `mean ${pct(stats.meanWeekly)} vs random p95 ${pct(baseline.p95)} per week (${runs} runs)` },
    { name: "not concentrated in one month", passed: topMonth !== null && topMonth <= ROTATION_PARAMS.maxShare, detail: topMonth === null ? "total return <= 0" : `top month = ${(topMonth * 100).toFixed(0)}% of total log return` },
    { name: "not concentrated in one coin", passed: topCoin !== null && topCoin <= ROTATION_PARAMS.maxShare, detail: topCoin === null ? "no positive contributions" : `top coin = ${(topCoin * 100).toFixed(0)}% of positive contributions` },
  ];
  const verdict = !checks[0]!.passed ? "insufficient-data" : checks.every((c) => c.passed) ? "not-rejected" : "rejected";
  return { segment: opts.segment, range: opts.range, symbols, weeks, stats, baseline, equalWeight, btcHold, byMonth, byCoin, checks, verdict };
}

export function rotationJournalEntry(r: RotationResult, meta: { at: UnixMs; codeCommit: string | null; seed: number }): JournalEntry {
  return {
    at: meta.at,
    codeCommit: meta.codeCommit,
    strategyId: ROTATION_ID,
    strategyVersion: ROTATION_VERSION,
    segment: r.segment,
    from: r.range.from,
    to: r.range.to,
    symbols: r.symbols,
    seed: meta.seed,
    runs: r.baseline.runs,
    trades: r.stats.weeks,
    expectancyR: r.stats.meanWeekly,
    ci95: r.stats.ci95,
    grossExpectancyR: r.stats.meanGrossWeekly,
    baselineP95: r.baseline.p95,
    verdict: r.verdict,
    checks: r.checks,
    unit: "weekly-return",
  };
}

export function renderRotationReport(r: RotationResult, plan: SplitPlan, meta: { at: UnixMs; codeCommit: string | null }): string {
  const day = (t: UnixMs) => new Date(t).toISOString().slice(0, 10);
  const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
  const s = r.stats;
  const row = (name: string, x: RotationStats) =>
    `| ${name} | ${pct(x.meanWeekly)} | ${x.ci95 ? `[${pct(x.ci95[0])}, ${pct(x.ci95[1])}]` : "—"} | ${pct(x.totalReturn)} | ${pct(x.maxDrawdown)} | ${(x.avgInvested * 100).toFixed(0)}% |`;
  return `${[
    `# Исследование: ${ROTATION_ID}@${ROTATION_VERSION} — часть «${r.segment}»`,
    "",
    `Запуск: ${formatDateTime(meta.at)} МСК, код ${meta.codeCommit?.slice(0, 7) ?? "—"}.`,
    `Период части: ${day(r.range.from)} .. ${day(r.range.to)} (не включительно). Разбиение: research ${day(plan.from)}..${day(plan.researchEnd)}, validation ..${day(plan.validationEnd)}, holdout ..${day(plan.to)}.`,
    `Корзина: ${r.symbols.join(", ")}. Правила — docs/strategy-rotation.md.`,
    "",
    "> Исторический прогон — не доказательство прибыльности.",
    "",
    "## Итог",
    "",
    "| Вариант | Средняя неделя | 95% CI | Итого за период | Макс. просадка | В монетах, в среднем |",
    "|---|---|---|---|---|---|",
    row("Ротация (после издержек)", s),
    row("Корзина поровну (справка)", r.equalWeight),
    row("Удержание BTC (справка)", r.btcHold),
    "",
    `- Без издержек средняя неделя ${pct(s.meanGrossWeekly)}; издержки в среднем ${pct(r.weeks.reduce((a, w) => a + w.costPct, 0) / Math.max(1, r.weeks.length))} в неделю.`,
    `- Случайная ротация с той же долей в монетах: ${r.baseline.runs} прогонов, медиана ${pct(r.baseline.p50)}, p95 ${pct(r.baseline.p95)} в неделю.`,
    "",
    "## По монетам",
    "",
    "| Монета | Недель в портфеле | Вклад в доходность |",
    "|---|---|---|",
    ...r.byCoin.map((c) => `| ${c.symbol} | ${c.weeksHeld} | ${pct(c.contribution)} |`),
    "",
    "## По месяцам",
    "",
    "| Месяц | Недель | Лог-доходность |",
    "|---|---|---|",
    ...r.byMonth.map((m) => `| ${m.month} | ${m.weeks} | ${pct(m.logReturn)} |`),
    "",
    "## Критерии отказа (docs/strategy-rotation.md §4)",
    "",
    ...r.checks.map((c) => `- [${c.passed ? "x" : " "}] ${c.name}: ${c.detail}`),
    "",
    `**Вердикт: ${r.verdict}**`,
    "",
    "## Недели",
    "",
    "| Начало | Держит | Доходность |",
    "|---|---|---|",
    ...r.weeks.map((w) => `| ${day(w.start)} | ${Object.keys(w.weights).map((x) => x.split("/")[0]).join(", ") || "USDT"} | ${pct(w.ret)} |`),
  ].join("\n")}\n`;
}
