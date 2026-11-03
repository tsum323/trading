import type { UnixMs } from "@/core/time";
import { evaluateSignal, replaySignals, windowBars, type Evaluation, type SignalOutcome } from "@/modules/backtest";
import type { FactorBook } from "@/modules/derivatives";
import type { Candle, MarketDataSourceId, MarketSymbol } from "@/modules/market-data";
import type { FileArchive } from "@/modules/storage";
import type { TradingSignal } from "@/modules/strategies";
import { costsFor } from "../personas/roster";
import { lowerBound, personaPath } from "../personas/signal-trader";
import type { Skill } from "./skills";

/**
 * Тренировочная торговля навыка «в уме»: каждый сигнал, один открытый на символ,
 * результат в R по общему оценщику. Денег нет — поэтому нет и защиты капитала:
 * это честная статистика самого правила. Журналы только дописываются.
 */
export interface ShadowSignal {
  skillId: string;
  signal: TradingSignal;
  recordedAt: UnixMs;
}

export interface ShadowExit extends SignalOutcome {
  skillId: string;
  /** Результат без издержек — чтобы отличать «правило ошиблось» от «съели издержки». */
  grossR: number | null;
}

interface ShadowCursor {
  processed: Record<MarketSymbol, UnixMs>;
}

export const autoPath = (name: string) => personaPath("autonomous", name);
export const shadowPath = (skillId: string, name: string) => autoPath(`shadow/${skillId}/${name}`);

const NO_COSTS = { feeRate: 0, slippage: 0 };

function freeFrom(s: TradingSignal, e: Evaluation): UnixMs {
  if (e.status === "pending") return Number.POSITIVE_INFINITY;
  if (e.status === "no-entry") return s.createdAt;
  if (e.status === "data-gap") return s.expiresAt;
  return e.exitTime!;
}

/** Свечи по символу и таймфрейму, загружаются один раз за цикл. */
export class CandleCache {
  private readonly cache = new Map<string, Candle[]>();
  constructor(
    private readonly archive: FileArchive,
    private readonly sourceId: MarketDataSourceId,
    /** С какого момента читать ряд данного таймфрейма. */
    private readonly fromFor: (tf: TradingSignal["timeframe"]) => UnixMs,
  ) {}

  get(symbol: MarketSymbol, tf: TradingSignal["timeframe"]): Candle[] {
    const key = `${symbol}|${tf}`;
    let c = this.cache.get(key);
    if (!c) this.cache.set(key, (c = this.archive.getCandles(this.sourceId, { symbol, timeframe: tf, from: this.fromFor(tf) })));
    return c;
  }

  evaluate(s: TradingSignal, costs = costsFor(s.symbol)): Evaluation {
    const series = this.get(s.symbol, s.timeframe);
    const i = lowerBound(series, s.basisCloseTime);
    return evaluateSignal(s, series.slice(i, i + windowBars(s) + 1), series.at(-1)?.closeTime ?? 0, costs);
  }
}

/** Один цикл тренировочной торговли всех навыков. Возвращает сигналы, записанные впервые. */
export function runShadow(opts: {
  archive: FileArchive;
  candles: CandleCache;
  skills: readonly Skill[];
  factors: FactorBook;
  symbols: readonly MarketSymbol[];
  /** С какого момента навыки торгуют «в уме» (раньше старта бота — так он приходит не с нуля). */
  from: UnixMs;
  now: UnixMs;
}): { newSignals: ShadowSignal[]; newExits: ShadowExit[] } {
  const { archive, candles, now } = opts;
  const newSignals: ShadowSignal[] = [];
  const newExits: ShadowExit[] = [];
  for (const skill of opts.skills) {
    const strategy = skill.make(opts.factors);
    const tf = strategy.timeframe;
    const cursorPath = shadowPath(skill.id, "cursor.json");
    const cursor = archive.readJson<ShadowCursor>(cursorPath) ?? { processed: {} };
    const signals = archive.readJsonl<ShadowSignal>(shadowPath(skill.id, "signals"));
    const exits = new Map(archive.readJsonl<ShadowExit>(shadowPath(skill.id, "exits")).map((x) => [x.signalId, x]));
    const evals = new Map<string, Evaluation>();
    for (const r of signals) evals.set(r.signal.id, exits.get(r.signal.id) ?? candles.evaluate(r.signal));

    const fresh: TradingSignal[] = [];
    for (const symbol of opts.symbols) {
      const series = candles.get(symbol, tf);
      const after = Math.max(cursor.processed[symbol] ?? opts.from, opts.from);
      const window = series.slice(Math.max(0, lowerBound(series, after) - strategy.lookback));
      fresh.push(...replaySignals(strategy, window).filter((s) => s.createdAt > after));
      const last = series.at(-1)?.closeTime;
      if (last !== undefined && last > (cursor.processed[symbol] ?? 0)) cursor.processed[symbol] = last;
    }
    fresh.sort((a, b) => a.createdAt - b.createdAt || a.symbol.localeCompare(b.symbol));

    const all = [...signals];
    const added: ShadowSignal[] = [];
    for (const s of fresh) {
      if (all.some((r) => r.signal.symbol === s.symbol && freeFrom(r.signal, evals.get(r.signal.id)!) > s.createdAt)) continue;
      const rec = { skillId: skill.id, signal: s, recordedAt: now };
      all.push(rec);
      added.push(rec);
      evals.set(s.id, candles.evaluate(s));
    }
    const resolved: ShadowExit[] = [];
    for (const r of all) {
      if (exits.has(r.signal.id)) continue;
      const ev = evals.get(r.signal.id)!;
      if (ev.status === "pending") continue;
      const gross = candles.evaluate(r.signal, NO_COSTS);
      resolved.push({ ...ev, skillId: skill.id, grossR: gross.status !== "pending" ? (gross.rMultiple ?? null) : null });
    }
    archive.appendJsonl(shadowPath(skill.id, "signals"), added);
    archive.appendJsonl(shadowPath(skill.id, "exits"), resolved);
    archive.writeText(cursorPath, `${JSON.stringify(cursor)}\n`);
    newSignals.push(...added);
    newExits.push(...resolved);
  }
  return { newSignals, newExits };
}

/** Все тренировочные исходы навыков (для оценки и разборов). */
export function readShadowExits(archive: FileArchive, skills: readonly Skill[]): ShadowExit[] {
  return skills.flatMap((s) => archive.readJsonl<ShadowExit>(shadowPath(s.id, "exits")));
}

