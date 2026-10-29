import { TIMEFRAME_MS, type UnixMs } from "@/core/time";
import { DEFAULT_COSTS, evaluateSignal, replaySignals, windowBars, type Evaluation, type SignalOutcome } from "@/modules/backtest";
import type { Candle, MarketDataSourceId, MarketSymbol } from "@/modules/market-data";
import { lossPerUnit } from "@/modules/risk";
import type { FileArchive } from "@/modules/storage";
import type { Strategy, TradingSignal } from "@/modules/strategies";
import { decideRisk, type ClosedTrade, type SkipReason } from "./risk-manager";
import { MAX_POSITION_SHARE, PERSONA_START, type SignalPersonaDef } from "./roster";
import type { TradeMode } from "./types";

/** Сделка персонажа: сигнал и размер позиции, записанные в момент `recordedAt`. */
export interface PersonaEntry {
  signal: TradingSignal;
  qty: number;
  riskUsd: number;
  equityAtEntry: number;
  /** Доля капитала, которой рискует сделка, после защиты и адаптации. */
  riskFraction: number;
  /** Почему риск отличается от обычного. */
  notes: string[];
  recordedAt: UnixMs;
  codeCommit: string | null;
  mode: TradeMode;
}

export interface PersonaExit extends SignalOutcome {
  pnlUsd: number;
}

/** Сигнал, который персонаж пропустил ради защиты капитала. */
export interface PersonaSkip {
  signalId: string;
  symbol: MarketSymbol;
  direction: TradingSignal["direction"];
  createdAt: UnixMs;
  reason: SkipReason;
  drawdown: number;
  recordedAt: UnixMs;
  mode: TradeMode;
}

export interface PersonaCursor {
  /** Первый запуск персонажа; решения раньше него — реплей. */
  launchedAt: UnixMs;
  /** До какого момента решений обработан каждый символ. */
  processed: Record<MarketSymbol, UnixMs>;
}

export const personaPath = (id: string, name: string) => `personas/${id}/${name}`;

export interface SignalTraderReport {
  newEntries: PersonaEntry[];
  newExits: PersonaExit[];
  newSkips: PersonaSkip[];
  skippedBusy: number;
}

/** Первая свеча с openTime >= t (ряд по возрастанию openTime). */
export function lowerBound(candles: readonly Candle[], t: UnixMs): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid]!.openTime < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Результат сделки в долларах: R × размер × 1R на единицу при фактической цене входа. */
export function exitPnlUsd(signal: TradingSignal, qty: number, o: SignalOutcome): number {
  if (o.rMultiple === undefined || o.entryPrice === undefined) return 0;
  return o.rMultiple * qty * lossPerUnit(signal.direction, o.entryPrice, signal.stopLoss, DEFAULT_COSTS.feeRate);
}

/** Момент, с которого символ снова свободен; +∞ — сделка ещё идёт. */
function freeFrom(signal: TradingSignal, e: Evaluation): UnixMs {
  if (e.status === "pending") return Number.POSITIVE_INFINITY;
  if (e.status === "no-entry") return signal.createdAt;
  if (e.status === "data-gap") return signal.expiresAt;
  return e.exitTime!;
}

/**
 * Один цикл персонажа на сигналах стратегии:
 * 1. новые решения после прошлого цикла (при первом запуске — с PERSONA_START, это реплей);
 * 2. по символу не больше одной позиции;
 * 3. размер — по правилам защиты капитала (risk-manager): риск по просадке, дневной стоп, пауза,
 *    лимит открытого риска и (для адаптивных) охлаждение; номинал не больше MAX_POSITION_SHARE;
 * 4. исходы — тем же оценщиком, что и в исследованиях (вход по open следующей свечи, издержки).
 * Журналы только дописываются.
 */
export function runSignalTrader(opts: {
  archive: FileArchive;
  sourceId: MarketDataSourceId;
  persona: SignalPersonaDef;
  strategy: Strategy;
  now: UnixMs;
  codeCommit: string | null;
}): SignalTraderReport {
  const { archive, sourceId, persona, strategy, now } = opts;
  const tf = strategy.timeframe;
  const size = TIMEFRAME_MS[tf];
  const cursorPath = personaPath(persona.id, "cursor.json");
  const cursor = archive.readJson<PersonaCursor>(cursorPath) ?? { launchedAt: now, processed: {} };
  const entries = archive.readJsonl<PersonaEntry>(personaPath(persona.id, "entries"));
  const recordedExits = new Map(archive.readJsonl<PersonaExit>(personaPath(persona.id, "exits")).map((x) => [x.signalId, x]));

  const candles = new Map<MarketSymbol, Candle[]>();
  for (const symbol of persona.symbols) {
    candles.set(symbol, archive.getCandles(sourceId, { symbol, timeframe: tf, from: PERSONA_START - (strategy.lookback + 1) * size }));
  }
  const asOf = (symbol: MarketSymbol) => candles.get(symbol)!.at(-1)?.closeTime ?? 0;
  const evaluate = (s: TradingSignal): Evaluation => {
    const series = candles.get(s.symbol) ?? [];
    const i = lowerBound(series, s.basisCloseTime);
    return evaluateSignal(s, series.slice(i, i + windowBars(s) + 1), asOf(s.symbol));
  };

  const evals = new Map<string, Evaluation>();
  for (const e of entries) evals.set(e.signal.id, recordedExits.get(e.signal.id) ?? evaluate(e.signal));

  // 1. Новые решения по всем символам, по времени.
  const fresh: TradingSignal[] = [];
  for (const symbol of persona.symbols) {
    const series = candles.get(symbol)!;
    const after = cursor.processed[symbol] ?? PERSONA_START;
    const window = series.slice(Math.max(0, lowerBound(series, after) - strategy.lookback));
    fresh.push(...replaySignals(strategy, window).filter((s) => s.createdAt > after));
  }
  fresh.sort((a, b) => a.createdAt - b.createdAt || a.symbol.localeCompare(b.symbol));

  const all = [...entries];
  const newEntries: PersonaEntry[] = [];
  const newSkips: PersonaSkip[] = [];
  let skippedBusy = 0;
  for (const s of fresh) {
    // 2. Символ занят.
    if (all.some((e) => e.signal.symbol === s.symbol && freeFrom(e.signal, evals.get(e.signal.id)!) > s.createdAt)) {
      skippedBusy++;
      continue;
    }
    // 3. Только сделки, исход которых уже известен к моменту решения.
    const closed: ClosedTrade[] = [];
    let openRiskUsd = 0;
    for (const e of all) {
      const ev = evals.get(e.signal.id)!;
      if (ev.status !== "pending" && ev.exitTime !== undefined && ev.exitTime <= s.createdAt) {
        if (ev.rMultiple !== undefined) {
          closed.push({ symbol: e.signal.symbol, direction: e.signal.direction, exitTime: ev.exitTime, pnlUsd: exitPnlUsd(e.signal, e.qty, ev), r: ev.rMultiple });
        }
      } else if (ev.status !== "no-entry" && freeFrom(e.signal, ev) > s.createdAt) {
        openRiskUsd += e.riskUsd;
      }
    }
    const mode: TradeMode = s.createdAt + size < cursor.launchedAt ? "replay" : now - s.createdAt > size ? "late" : "live";
    const d = decideRisk({ closed, t: s.createdAt, symbol: s.symbol, direction: s.direction, openRiskUsd, adaptive: persona.adaptive });
    if (d.skip) {
      newSkips.push({ signalId: s.id, symbol: s.symbol, direction: s.direction, createdAt: s.createdAt, reason: d.skip, drawdown: d.state.drawdown, recordedAt: now, mode });
      continue;
    }
    const equity = d.state.equity;
    const ref = s.entry.referencePrice;
    const unit = lossPerUnit(s.direction, ref, s.stopLoss, DEFAULT_COSTS.feeRate);
    const qty = Math.min(d.riskUsd / unit, (equity * MAX_POSITION_SHARE) / ref);
    if (!(qty > 0)) continue;
    const notes = qty * unit < d.riskUsd * 0.999 ? [...d.notes, "урезано лимитом позиции 20% капитала"] : d.notes;
    const entry: PersonaEntry = {
      signal: s, qty, riskUsd: qty * unit, equityAtEntry: equity, riskFraction: (qty * unit) / equity, notes,
      recordedAt: now, codeCommit: opts.codeCommit, mode,
    };
    all.push(entry);
    newEntries.push(entry);
    evals.set(s.id, evaluate(s));
  }
  archive.appendJsonl(personaPath(persona.id, "entries"), newEntries);
  archive.appendJsonl(personaPath(persona.id, "skips"), newSkips);

  // 4. Определившиеся исходы.
  const newExits: PersonaExit[] = [];
  for (const e of all) {
    if (recordedExits.has(e.signal.id)) continue;
    const ev = evals.get(e.signal.id)!;
    if (ev.status === "pending") continue;
    newExits.push({ ...ev, pnlUsd: exitPnlUsd(e.signal, e.qty, ev) });
  }
  archive.appendJsonl(personaPath(persona.id, "exits"), newExits);

  for (const symbol of persona.symbols) {
    const t = asOf(symbol);
    if (t > (cursor.processed[symbol] ?? 0)) cursor.processed[symbol] = t;
  }
  archive.writeText(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`);
  return { newEntries, newExits, newSkips, skippedBusy };
}
