import { TIMEFRAME_MS, type UnixMs } from "@/core/time";
import { DEFAULT_COSTS } from "@/modules/backtest";
import type { Candle, MarketDataSourceId, MarketSymbol } from "@/modules/market-data";
import type { FileArchive } from "@/modules/storage";
import { getStrategy } from "@/modules/strategies/registry";
import type { Rebalance } from "./portfolio-trader";
import { INITIAL_EQUITY, MAX_POSITION_SHARE, PERSONA_START, PERSONA_SYMBOLS, PERSONAS, RISK_PER_TRADE, type PersonaDef } from "./roster";
import { lowerBound, personaPath, type PersonaCursor, type PersonaEntry, type PersonaExit } from "./signal-trader";
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

function curveGrid(until: UnixMs): UnixMs[] {
  const out: UnixMs[] = [];
  for (let t = PERSONA_START; t < until; t += CURVE_STEP) out.push(t);
  out.push(until);
  return out;
}

function maxDrawdownPct(curve: [UnixMs, number][]): number {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (const [, v] of curve) {
    peak = Math.max(peak, v);
    worst = Math.min(worst, v / peak - 1);
  }
  return worst;
}

const slip = (price: number, side: 1 | -1) => price * (1 + side * DEFAULT_COSTS.slippage);

function signalPersona(
  archive: FileArchive,
  sourceId: MarketDataSourceId,
  persona: Extract<PersonaDef, { kind: "signals" }>,
  prices: PriceBook,
  until: UnixMs,
  feed: FeedEvent[],
): PersonaSummary {
  const strategy = getStrategy(persona.strategyKey);
  const cursor = archive.readJson<PersonaCursor>(personaPath(persona.id, "cursor.json"));
  const entries = archive.readJsonl<PersonaEntry>(personaPath(persona.id, "entries"));
  const exits = new Map(archive.readJsonl<PersonaExit>(personaPath(persona.id, "exits")).map((x) => [x.signalId, x]));
  const tf = strategy.timeframe;
  const series = new Map<MarketSymbol, Candle[]>();
  const candlesOf = (symbol: MarketSymbol) => {
    if (!series.has(symbol)) series.set(symbol, archive.getCandles(sourceId, { symbol, timeframe: tf, from: PERSONA_START }));
    return series.get(symbol)!;
  };

  const trades: PersonaTrade[] = entries.map((e) => {
    const s = e.signal;
    const sign = s.direction === "long" ? 1 : -1;
    const x = exits.get(s.id);
    const base = {
      symbol: s.symbol, direction: s.direction, decidedAt: s.createdAt, entryTime: s.basisCloseTime,
      stop: s.stopLoss, target: s.takeProfits[0]!, expiresAt: s.expiresAt, qty: e.qty, riskUsd: e.riskUsd, mode: e.mode,
    };
    if (x) {
      return {
        ...base, state: x.status, entryPrice: x.entryPrice ?? null, exitTime: x.exitTime ?? null, exitPrice: x.exitPrice ?? null,
        pnlUsd: x.pnlUsd, r: x.rMultiple ?? null,
      };
    }
    const c = candlesOf(s.symbol);
    const entryCandle = c[lowerBound(c, s.basisCloseTime)];
    if (!entryCandle || entryCandle.openTime !== s.basisCloseTime) {
      return { ...base, state: "waiting-entry", entryPrice: null, exitTime: null, exitPrice: null, pnlUsd: null, r: null };
    }
    const entryPrice = slip(entryCandle.open, sign as 1 | -1);
    const last = prices.at(s.symbol, until);
    const pnlUsd = last === null ? null : (sign * (last - entryPrice) - DEFAULT_COSTS.feeRate * entryPrice) * e.qty;
    return { ...base, state: "open", entryPrice, exitTime: null, exitPrice: null, pnlUsd, r: pnlUsd === null ? null : pnlUsd / e.riskUsd };
  });

  const curve: [UnixMs, number][] = curveGrid(until).map((t) => {
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

  const closed = trades.filter((t) => t.exitTime !== null && t.state !== "no-entry" && t.state !== "data-gap");
  const equity = curve.at(-1)![1];
  return {
    id: persona.id, name: persona.name, emoji: persona.emoji, tagline: persona.tagline, rules: persona.rules, kind: persona.kind,
    timeframe: tf, symbols: persona.symbols, strategyKey: persona.strategyKey, strategyVersion: strategy.version,
    launchedAt: cursor?.launchedAt ?? null,
    equity, returnPct: equity / INITIAL_EQUITY - 1, maxDrawdownPct: maxDrawdownPct(curve),
    closedTrades: closed.length,
    wins: closed.filter((t) => (t.pnlUsd ?? 0) > 0).length,
    losses: closed.filter((t) => (t.pnlUsd ?? 0) <= 0).length,
    liveClosedTrades: closed.filter((t) => t.mode === "live").length,
    curve,
    open: trades.filter((t) => t.state === "open" || t.state === "waiting-entry"),
    history: closed.slice(-MAX_HISTORY).reverse(),
    holdings: [], cash: null, rebalances: [],
  };
}

function portfolioPersona(
  archive: FileArchive,
  persona: Extract<PersonaDef, { kind: "portfolio" }>,
  prices: PriceBook,
  until: UnixMs,
  feed: FeedEvent[],
): PersonaSummary {
  const cursor = archive.readJson<{ launchedAt: UnixMs }>(personaPath(persona.id, "cursor.json"));
  const log = archive.readJsonl<Rebalance>(personaPath(persona.id, "rebalances"));
  const valueAt = (r: Rebalance | undefined, t: UnixMs) =>
    r === undefined ? INITIAL_EQUITY : r.cash + Object.entries(r.holdings).reduce((v, [s, q]) => v + q * (prices.at(s, t) ?? r.prices[s] ?? 0), 0);
  let i = -1;
  const curve: [UnixMs, number][] = curveGrid(until).map((t) => {
    while (i + 1 < log.length && log[i + 1]!.at <= t) i++;
    return [t, valueAt(log[i], t)];
  });
  const lastR = log.at(-1);
  const holdings: PersonaHolding[] = Object.entries(lastR?.holdings ?? {}).map(([symbol, qty]) => {
    const price = prices.at(symbol, until) ?? lastR!.prices[symbol] ?? 0;
    return { symbol, qty, price, value: qty * price };
  });
  for (const r of log) feed.push({ t: r.at, personaId: persona.id, kind: "rebalance", weights: r.weights, note: r.note, mode: r.mode });
  const equity = curve.at(-1)![1];
  return {
    id: persona.id, name: persona.name, emoji: persona.emoji, tagline: persona.tagline, rules: persona.rules, kind: persona.kind,
    timeframe: persona.timeframe, symbols: persona.symbols, strategyKey: null, strategyVersion: null,
    launchedAt: cursor?.launchedAt ?? null,
    equity, returnPct: equity / INITIAL_EQUITY - 1, maxDrawdownPct: maxDrawdownPct(curve),
    closedTrades: 0, wins: 0, losses: 0, liveClosedTrades: 0,
    curve, open: [], history: [], holdings, cash: lastR?.cash ?? INITIAL_EQUITY,
    rebalances: log.slice(-20).reverse().map((r) => ({ at: r.at, weights: r.weights, costUsd: r.costUsd, note: r.note, mode: r.mode })),
  };
}

/** Сводка для сайта: состояние счетов, кривые капитала и лента действий. */
export function buildPersonasSnapshot(archive: FileArchive, sourceId: MarketDataSourceId, now: UnixMs, codeCommit: string | null): PersonasSnapshot {
  const symbols = [...new Set([...PERSONA_SYMBOLS, ...PERSONAS.flatMap((p) => p.symbols)])];
  const hourly = new Map(symbols.map((s) => [s, archive.getCandles(sourceId, { symbol: s, timeframe: "1h", from: PERSONA_START - TIMEFRAME_MS["1d"] })]));
  const prices = new PriceBook(hourly);
  // Последний момент, на который есть цены по всем символам.
  const until = Math.max(PERSONA_START, Math.min(...symbols.map((s) => prices.last(s)?.closeTime ?? PERSONA_START)));
  const feed: FeedEvent[] = [];
  const personas = PERSONAS.map((p) =>
    p.kind === "signals" ? signalPersona(archive, sourceId, p, prices, until, feed) : portfolioPersona(archive, p, prices, until, feed),
  );
  return {
    generatedAt: now,
    startedAt: PERSONA_START,
    initialEquity: INITIAL_EQUITY,
    riskPerTrade: RISK_PER_TRADE,
    maxPositionShare: MAX_POSITION_SHARE,
    costs: { ...DEFAULT_COSTS },
    codeCommit,
    prices: Object.fromEntries(
      symbols.flatMap((s) => {
        const c = prices.last(s);
        return c ? [[s, { price: c.close, time: c.closeTime }]] : [];
      }),
    ),
    personas,
    feed: feed.sort((a, b) => b.t - a.t).slice(0, MAX_FEED),
  };
}
