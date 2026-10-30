import { TIMEFRAME_MS, type UnixMs } from "@/core/time";
import type { Candle, MarketDataSourceId, MarketSymbol } from "@/modules/market-data";
import type { FileArchive } from "@/modules/storage";
import { costsFor, INITIAL_EQUITY, type PortfolioPersonaDef } from "./roster";
import { lowerBound, personaPath } from "./signal-trader";
import type { TradeMode } from "./types";

const DAY = TIMEFRAME_MS["1d"];
const HOUR = TIMEFRAME_MS["1h"];
const WEEK = 7 * DAY;

/** Перестановка портфеля: решение в `at` по закрытым дневным свечам, исполнение по open первой часовой свечи с openTime >= at. */
export interface Rebalance {
  at: UnixMs;
  prices: Record<MarketSymbol, number>;
  /** Количество монет после перестановки. */
  holdings: Record<MarketSymbol, number>;
  cash: number;
  equityBefore: number;
  costUsd: number;
  weights: Record<MarketSymbol, number>;
  note: string;
  recordedAt: UnixMs;
  codeCommit: string | null;
  mode: TradeMode;
}

export interface PortfolioCursor {
  launchedAt: UnixMs;
  processedUntil: UnixMs | null;
}

/** Моменты перестановок в (after, until]: старт и (для weekly) каждый понедельник 00:00 UTC. */
export function rebalanceTimes(schedule: PortfolioPersonaDef["schedule"], after: UnixMs | null, until: UnixMs, start: UnixMs): UnixMs[] {
  const out: UnixMs[] = [];
  if (after === null && start <= until) out.push(start);
  if (schedule === "weekly") {
    // 1970-01-05 — понедельник.
    const monday0 = Date.UTC(1970, 0, 5);
    let t = monday0 + Math.ceil((Math.max(after ?? start, start) + 1 - monday0) / WEEK) * WEEK;
    for (; t <= until; t += WEEK) out.push(t);
  }
  return out;
}

/** Целевые доли по закрытым к `at` дневным свечам. */
export function targetWeights(
  persona: PortfolioPersonaDef,
  daily: Map<MarketSymbol, Candle[]>,
  at: UnixMs,
): { weights: Record<MarketSymbol, number>; note: string } {
  const a = persona.allocation;
  if (a.type === "fixed") return { weights: { ...a.weights }, note: "покупка на весь капитал" };
  const ranked: { symbol: MarketSymbol; ret: number }[] = [];
  for (const symbol of persona.symbols) {
    const closed = (daily.get(symbol) ?? []).filter((c) => c.closeTime <= at);
    const last = closed.at(-1);
    const base = closed.at(-1 - a.lookbackDays);
    // Нужны свежая свеча и полный период без пропусков.
    if (!last || !base || last.closeTime < at - DAY || last.closeTime - base.closeTime !== a.lookbackDays * DAY) continue;
    ranked.push({ symbol, ret: last.close / base.close - 1 });
  }
  ranked.sort((x, y) => y.ret - x.ret);
  const picked = ranked.slice(0, a.top).filter((r) => r.ret > 0);
  const weights = Object.fromEntries(picked.map((r) => [r.symbol, 1 / a.top]));
  const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
  const note = ranked.length === 0 ? "нет данных" : `рост за ${a.lookbackDays} дн.: ${ranked.map((r) => `${r.symbol.split("/")[0]} ${pct(r.ret)}`).join(", ")}`;
  return { weights, note };
}

/**
 * Один цикл персонажа-портфеля. Перестановка выполняется, только когда по всем
 * символам закрылась первая часовая свеча с openTime >= at — её open и есть цена
 * исполнения; до этого момента перестановка ждёт следующего цикла.
 */
export function runPortfolioTrader(opts: {
  archive: FileArchive;
  sourceId: MarketDataSourceId;
  persona: PortfolioPersonaDef;
  start: UnixMs;
  now: UnixMs;
  codeCommit: string | null;
}): Rebalance[] {
  const { archive, sourceId, persona, start, now } = opts;
  const cursorPath = personaPath(persona.id, "cursor.json");
  const cursor = archive.readJson<PortfolioCursor>(cursorPath) ?? { launchedAt: now, processedUntil: null };
  const log = personaPath(persona.id, "rebalances");
  const history = archive.readJsonl<Rebalance>(log);

  const hourly = new Map<MarketSymbol, Candle[]>();
  const daily = new Map<MarketSymbol, Candle[]>();
  for (const symbol of persona.symbols) {
    hourly.set(symbol, archive.getCandles(sourceId, { symbol, timeframe: "1h", from: start }));
    daily.set(symbol, archive.getCandles(sourceId, { symbol, timeframe: "1d", from: start - 60 * DAY }));
  }
  const readyUntil = Math.min(...persona.symbols.map((s) => hourly.get(s)!.at(-1)?.openTime ?? Number.NEGATIVE_INFINITY));
  const openAt = (symbol: MarketSymbol, at: UnixMs): number | undefined => {
    const series = hourly.get(symbol)!;
    const c = series[lowerBound(series, at)];
    return c && c.openTime < at + HOUR ? c.open : undefined;
  };

  const out: Rebalance[] = [];
  let prev = history.at(-1);
  for (const at of rebalanceTimes(persona.schedule, cursor.processedUntil, readyUntil, start)) {
    const prices: Record<MarketSymbol, number> = {};
    for (const s of persona.symbols) {
      const p = openAt(s, at);
      if (p !== undefined) prices[s] = p;
    }
    // Свеча исполнения ещё не закрылась хотя бы по одному символу — ждём следующего цикла.
    if (persona.symbols.some((s) => prices[s] === undefined && (hourly.get(s)!.at(-1)?.openTime ?? 0) < at + HOUR)) break;
    const { weights, note } = targetWeights(persona, daily, at);
    const holdings = prev?.holdings ?? {};
    const cash = prev?.cash ?? INITIAL_EQUITY;
    // Символ без цены исполнения: позицию не трогаем, новую не открываем.
    const tradable = (s: MarketSymbol) => prices[s] !== undefined;
    const equityBefore = cash + Object.entries(holdings).reduce((v, [s, q]) => v + q * (prices[s] ?? prev!.prices[s] ?? 0), 0);
    const costRate = (s: MarketSymbol) => costsFor(s).feeRate + costsFor(s).slippage;
    const current = (s: MarketSymbol) => (holdings[s] ?? 0) * (prices[s] ?? 0);
    const symbols = [...new Set([...Object.keys(holdings), ...Object.keys(weights)])].filter(tradable);
    // Издержки — с объёма перестановки по каждой монете, со своим проскальзыванием.
    const costUsd = symbols.reduce((v, s) => v + Math.abs((weights[s] ?? 0) * equityBefore - current(s)) * costRate(s), 0);
    const scale = (equityBefore - costUsd) / equityBefore;
    const next: Record<MarketSymbol, number> = {};
    for (const [s, q] of Object.entries(holdings)) if (!tradable(s) && q > 0) next[s] = q;
    let invested = 0;
    for (const s of symbols) {
      const notional = (weights[s] ?? 0) * equityBefore * scale;
      if (notional > 0) {
        next[s] = notional / prices[s]!;
        invested += notional;
      }
    }
    const kept = Object.entries(next).filter(([s]) => !tradable(s)).reduce((v, [s, q]) => v + q * (prev?.prices[s] ?? 0), 0);
    const mode: TradeMode = at + HOUR < cursor.launchedAt ? "replay" : now - at > 2 * HOUR ? "late" : "live";
    const r: Rebalance = {
      at, prices, holdings: next, cash: equityBefore - costUsd - invested - kept, equityBefore, costUsd, weights, note,
      recordedAt: now, codeCommit: opts.codeCommit, mode,
    };
    out.push(r);
    prev = r;
    cursor.processedUntil = at;
  }
  archive.appendJsonl(log, out);
  archive.writeText(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`);
  return out;
}
