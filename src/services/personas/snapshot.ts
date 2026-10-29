import { TIMEFRAME_MS, type UnixMs } from "@/core/time";
import { DEFAULT_COSTS } from "@/modules/backtest";
import type { Candle, MarketDataSourceId, MarketSymbol } from "@/modules/market-data";
import type { FileArchive } from "@/modules/storage";
import { getStrategy } from "@/modules/strategies/registry";
import { closedTrade } from "./journal-view";
import { managerCurve, type Curve, type ManagerRebalance } from "./manager-trader";
import type { Rebalance } from "./portfolio-trader";
import { recentBucketR, riskState, type ClosedTrade } from "./risk-manager";
import {
  INITIAL_EQUITY,
  MAX_POSITION_SHARE,
  PERSONA_SYMBOLS,
  PERSONAS,
  RISK_PER_TRADE,
  type ManagerPersonaDef,
  type PersonaDef,
  type PortfolioPersonaDef,
  type SignalPersonaDef,
} from "./roster";
import { lowerBound, personaPath, type PersonaCursor, type PersonaEntry, type PersonaExit, type PersonaSkip } from "./signal-trader";
import type { FeedEvent, PersonaHolding, PersonaSummary, PersonaTrade, PersonasSnapshot } from "./types";

const CURVE_STEP = TIMEFRAME_MS["4h"];
const MAX_HISTORY = 100;
const MAX_FEED = 200;

/** Цена по закрытым часовым свечам: close последней, закрытой к моменту t. */
class PriceBook {
  constructor(private readonly hourly: Map<MarketSymbol, Candle[]>) {}

  at(symbol: MarketSymbol, t: UnixMs): number | null {
    const series = this.hourly.get(symbol) ?? [];
    let lo = 0;
    let hi = series.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (series[mid]!.closeTime <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 ? series[lo - 1]!.close : null;
  }

  last(symbol: MarketSymbol): Candle | undefined {
    return this.hourly.get(symbol)?.at(-1);
  }
}

/** Точки кривой: старт, затем границы 4-часовых свечей, последняя — `until`. */
function curveGrid(start: UnixMs, until: UnixMs): UnixMs[] {
  const out: UnixMs[] = [start];
  for (let t = Math.floor(start / CURVE_STEP) * CURVE_STEP + CURVE_STEP; t < until; t += CURVE_STEP) out.push(t);
  out.push(until);
  return out;
}

function maxDrawdownPct(curve: Curve): number {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (const [, v] of curve) {
    peak = Math.max(peak, v);
    worst = Math.min(worst, v / peak - 1);
  }
  return worst;
}

const slip = (price: number, side: 1 | -1) => price * (1 + side * DEFAULT_COSTS.slippage);

function base(p: PersonaDef, launchedAt: UnixMs | null, curve: [UnixMs, number][]) {
  const equity = curve.at(-1)![1];
  return {
    id: p.id, name: p.name, emoji: p.emoji, tagline: p.tagline, rules: p.rules, kind: p.kind,
    timeframe: p.timeframe, symbols: p.symbols, launchedAt,
    equity, returnPct: equity / INITIAL_EQUITY - 1, maxDrawdownPct: maxDrawdownPct(curve), curve,
  };
}

function signalPersona(
  archive: FileArchive,
  sourceId: MarketDataSourceId,
  persona: SignalPersonaDef,
  prices: PriceBook,
  start: UnixMs,
  until: UnixMs,
  feed: FeedEvent[],
): PersonaSummary {
  const strategy = getStrategy(persona.strategyKey);
  const cursor = archive.readJson<PersonaCursor>(personaPath(persona.id, "cursor.json"));
  const entries = archive.readJsonl<PersonaEntry>(personaPath(persona.id, "entries"));
  const exits = new Map(archive.readJsonl<PersonaExit>(personaPath(persona.id, "exits")).map((x) => [x.signalId, x]));
  const skips = archive.readJsonl<PersonaSkip>(personaPath(persona.id, "skips"));
  const tf = strategy.timeframe;
  const series = new Map<MarketSymbol, Candle[]>();
  const candlesOf = (symbol: MarketSymbol) => {
    if (!series.has(symbol)) series.set(symbol, archive.getCandles(sourceId, { symbol, timeframe: tf, from: start }));
    return series.get(symbol)!;
  };

  const trades: PersonaTrade[] = entries.map((e) => {
    const s = e.signal;
    const sign = s.direction === "long" ? 1 : -1;
    const x = exits.get(s.id);
    if (x) return closedTrade(e, x);
    const common = {
      symbol: s.symbol, direction: s.direction, decidedAt: s.createdAt, entryTime: s.basisCloseTime,
      stop: s.stopLoss, target: s.takeProfits[0]!, expiresAt: s.expiresAt, qty: e.qty, riskUsd: e.riskUsd,
      riskFraction: e.riskFraction ?? e.riskUsd / e.equityAtEntry, notes: e.notes ?? [], mode: e.mode,
    };
    const c = candlesOf(s.symbol);
    const entryCandle = c[lowerBound(c, s.basisCloseTime)];
    if (!entryCandle || entryCandle.openTime !== s.basisCloseTime) {
      return { ...common, state: "waiting-entry", entryPrice: null, exitTime: null, exitPrice: null, pnlUsd: null, r: null };
    }
    const entryPrice = slip(entryCandle.open, sign as 1 | -1);
    const last = prices.at(s.symbol, until);
    const pnlUsd = last === null ? null : (sign * (last - entryPrice) - DEFAULT_COSTS.feeRate * entryPrice) * e.qty;
    return { ...common, state: "open", entryPrice, exitTime: null, exitPrice: null, pnlUsd, r: pnlUsd === null ? null : pnlUsd / e.riskUsd };
  });

  const curve: [UnixMs, number][] = curveGrid(start, until).map((t) => {
    let equity = INITIAL_EQUITY;
    for (const tr of trades) {
      if (tr.exitTime !== null && tr.exitTime <= t) {
        equity += tr.pnlUsd ?? 0;
      } else if (tr.entryPrice !== null && tr.entryTime <= t && (tr.state === "open" || (tr.exitTime !== null && tr.exitTime > t))) {
        const p = prices.at(tr.symbol, t);
        if (p !== null) equity += ((tr.direction === "long" ? 1 : -1) * (p - tr.entryPrice) - DEFAULT_COSTS.feeRate * tr.entryPrice) * tr.qty;
      }
    }
    return [t, equity];
  });

  for (const tr of trades) {
    if (tr.state === "no-entry") continue;
    feed.push({ t: tr.entryTime, personaId: persona.id, kind: "open", symbol: tr.symbol, direction: tr.direction, price: tr.entryPrice, stop: tr.stop, target: tr.target, mode: tr.mode });
    if (tr.exitTime !== null) {
      feed.push({ t: tr.exitTime, personaId: persona.id, kind: "close", symbol: tr.symbol, direction: tr.direction, state: tr.state, price: tr.exitPrice, pnlUsd: tr.pnlUsd ?? 0, r: tr.r, mode: tr.mode });
    }
  }
  for (const s of skips) {
    feed.push({ t: s.createdAt, personaId: persona.id, kind: "skip", symbol: s.symbol, direction: s.direction, reason: s.reason, drawdown: s.drawdown, mode: s.mode });
  }

  const closed = trades.filter((t) => t.exitTime !== null && t.state !== "no-entry" && t.state !== "data-gap");
  const closedForRisk: ClosedTrade[] = closed.map((t) => ({ symbol: t.symbol, direction: t.direction, exitTime: t.exitTime!, pnlUsd: t.pnlUsd ?? 0, r: t.r ?? 0 }));
  const rs = riskState(closedForRisk, until);
  const cooling = persona.adaptive
    ? persona.symbols.flatMap((sym) =>
        (["long", "short"] as const).filter((d) => (recentBucketR(closedForRisk, until, sym, d) ?? 0) < 0).map((d) => `${sym.split("/")[0]} ${d}`),
      )
    : [];
  return {
    ...base(persona, cursor?.launchedAt ?? null, curve),
    strategyKey: persona.strategyKey, strategyVersion: strategy.version,
    closedTrades: closed.length,
    wins: closed.filter((t) => (t.pnlUsd ?? 0) > 0).length,
    losses: closed.filter((t) => (t.pnlUsd ?? 0) <= 0).length,
    liveClosedTrades: closed.filter((t) => t.mode === "live").length,
    open: trades.filter((t) => t.state === "open" || t.state === "waiting-entry"),
    history: closed.slice(-MAX_HISTORY).reverse(),
    holdings: [], cash: null, rebalances: [], allocations: [],
    risk: {
      status: rs.status, riskFraction: rs.riskFraction, drawdownPct: rs.drawdown, pausedUntil: rs.pausedUntil,
      dayPnlPct: rs.dayPnlPct, cooling, skipped: skips.length,
    },
  };
}

function portfolioPersona(archive: FileArchive, persona: PortfolioPersonaDef, prices: PriceBook, start: UnixMs, until: UnixMs, feed: FeedEvent[]): PersonaSummary {
  const cursor = archive.readJson<{ launchedAt: UnixMs }>(personaPath(persona.id, "cursor.json"));
  const log = archive.readJsonl<Rebalance>(personaPath(persona.id, "rebalances"));
  const valueAt = (r: Rebalance | undefined, t: UnixMs) =>
    r === undefined ? INITIAL_EQUITY : r.cash + Object.entries(r.holdings).reduce((v, [s, q]) => v + q * (prices.at(s, t) ?? r.prices[s] ?? 0), 0);
  let i = -1;
  const curve: [UnixMs, number][] = curveGrid(start, until).map((t) => {
    while (i + 1 < log.length && log[i + 1]!.at <= t) i++;
    return [t, valueAt(log[i], t)];
  });
  const lastR = log.at(-1);
  const holdings: PersonaHolding[] = Object.entries(lastR?.holdings ?? {}).map(([symbol, qty]) => {
    const price = prices.at(symbol, until) ?? lastR!.prices[symbol] ?? 0;
    return { symbol, qty, price, value: qty * price };
  });
  for (const r of log) feed.push({ t: r.at, personaId: persona.id, kind: "rebalance", weights: r.weights, note: r.note, mode: r.mode });
  return {
    ...base(persona, cursor?.launchedAt ?? null, curve),
    strategyKey: null, strategyVersion: null,
    closedTrades: 0, wins: 0, losses: 0, liveClosedTrades: 0,
    open: [], history: [], holdings, cash: lastR?.cash ?? INITIAL_EQUITY,
    rebalances: log.slice(-20).reverse().map((r) => ({ at: r.at, weights: r.weights, costUsd: r.costUsd, note: r.note, mode: r.mode })),
    risk: null, allocations: [],
  };
}

export function managerSummary(
  archive: FileArchive,
  persona: ManagerPersonaDef,
  curves: ReadonlyMap<string, Curve>,
  start: UnixMs,
  until: UnixMs,
  feed: FeedEvent[],
): PersonaSummary {
  const cursor = archive.readJson<{ launchedAt: UnixMs }>(personaPath(persona.id, "cursor.json"));
  const log = archive.readJsonl<ManagerRebalance>(personaPath(persona.id, "rebalances"));
  const m = managerCurve(log, curves, curveGrid(start, until));
  for (const r of log) feed.push({ t: r.at, personaId: persona.id, kind: "rebalance", weights: r.weights, note: r.note, mode: r.mode });
  return {
    ...base(persona, cursor?.launchedAt ?? null, m.curve),
    strategyKey: null, strategyVersion: null,
    closedTrades: 0, wins: 0, losses: 0, liveClosedTrades: 0,
    open: [], history: [], holdings: [], cash: m.cash,
    rebalances: log.map((r, k) => ({ at: r.at, weights: r.weights, costUsd: m.costs[k] ?? 0, note: r.note, mode: r.mode })).slice(-20).reverse(),
    risk: null,
    allocations: Object.entries(m.allocations).map(([personaId, value]) => ({ personaId, value })),
  };
}

export interface PersonaBoard {
  prices: PriceBook;
  until: UnixMs;
  summaries: PersonaSummary[];
  feed: FeedEvent[];
  /** Последние закрытые часовые свечи по символам. */
  lastCandles: Map<MarketSymbol, Candle>;
}

/** Сводки персонажей, кроме Управляющего: ему нужны их кривые капитала. */
export function buildBoard(archive: FileArchive, sourceId: MarketDataSourceId, start: UnixMs): PersonaBoard {
  const symbols = [...new Set([...PERSONA_SYMBOLS, ...PERSONAS.flatMap((p) => p.symbols)])];
  const hourly = new Map(symbols.map((s) => [s, archive.getCandles(sourceId, { symbol: s, timeframe: "1h", from: start - TIMEFRAME_MS["1d"] })]));
  const prices = new PriceBook(hourly);
  // Последний момент, на который есть цены по всем символам.
  const until = Math.max(start, Math.min(...symbols.map((s) => prices.last(s)?.closeTime ?? start)));
  const feed: FeedEvent[] = [];
  const summaries = PERSONAS.flatMap((p) =>
    p.kind === "signals" ? [signalPersona(archive, sourceId, p, prices, start, until, feed)]
    : p.kind === "portfolio" ? [portfolioPersona(archive, p, prices, start, until, feed)]
    : [],
  );
  const lastCandles = new Map(symbols.flatMap((s) => {
    const c = prices.last(s);
    return c ? [[s, c] as const] : [];
  }));
  return { prices, until, summaries, feed, lastCandles };
}

export const curvesOf = (summaries: readonly PersonaSummary[]) => new Map(summaries.map((p) => [p.id, p.curve as Curve]));

/** Сводка для сайта: состояние счетов, кривые капитала и лента действий. Управляющие — по готовым кривым. */
export function buildPersonasSnapshot(
  archive: FileArchive,
  sourceId: MarketDataSourceId,
  start: UnixMs,
  now: UnixMs,
  codeCommit: string | null,
): PersonasSnapshot {
  const board = buildBoard(archive, sourceId, start);
  const curves = curvesOf(board.summaries);
  const managers = PERSONAS.filter((p): p is ManagerPersonaDef => p.kind === "manager").map((p) => managerSummary(archive, p, curves, start, board.until, board.feed));
  const byId = new Map([...board.summaries, ...managers].map((p) => [p.id, p]));
  return {
    generatedAt: now,
    startedAt: start,
    initialEquity: INITIAL_EQUITY,
    riskPerTrade: RISK_PER_TRADE,
    maxPositionShare: MAX_POSITION_SHARE,
    costs: { ...DEFAULT_COSTS },
    codeCommit,
    prices: Object.fromEntries([...board.lastCandles].map(([s, c]) => [s, { price: c.close, time: c.closeTime }])),
    personas: PERSONAS.map((p) => byId.get(p.id)!),
    feed: board.feed.sort((a, b) => b.t - a.t).slice(0, MAX_FEED),
  };
}
