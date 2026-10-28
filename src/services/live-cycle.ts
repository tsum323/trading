import { TIMEFRAME_MS, alignToTimeframe, type UnixMs } from "@/core/time";
import { evaluateSignal, replaySignals, windowBars, type SignalOutcome } from "@/modules/backtest";
import type { Gap, MarketDataSource, MarketSymbol } from "@/modules/market-data";
import type { FileArchive } from "@/modules/storage";
import type { Strategy, TradingSignal } from "@/modules/strategies";
import { ingestHistory } from "./ingest-history";

/** Сигнал перспективного теста: записан в момент `recordedAt` кодом коммита `codeCommit`. */
export interface LiveSignalRecord {
  signal: TradingSignal;
  recordedAt: UnixMs;
  codeCommit: string | null;
  /**
   * Записан позже, чем через один таймфрейм после решения (например, задержка
   * планировщика). Не входит в статистику (validation-plan §6).
   */
  late: boolean;
}

export interface SymbolCycleReport {
  symbol: MarketSymbol;
  /** Первый запуск: только прогрев истории, сигналы не формируются. */
  bootstrap: boolean;
  /** Закрытых свечей получено за цикл (формирующаяся текущая не считается и не сохраняется). */
  received: number;
  lastClose: UnixMs | null;
  gaps: Gap[];
  newSignals: TradingSignal[];
  skippedOverlap: number;
  newOutcomes: SignalOutcome[];
  openSignals: TradingSignal[];
}

export interface LiveCycleOptions {
  source: MarketDataSource;
  archive: FileArchive;
  strategy: Strategy;
  symbols: MarketSymbol[];
  now?: () => UnixMs;
  codeCommit?: string | null;
  sleep?: (ms: number) => Promise<void>;
}

export const signalsLog = (strategy: Strategy) => `signals/${strategy.id}`;
export const outcomesLog = (strategy: Strategy) => `outcomes/${strategy.id}`;

/**
 * Один цикл перспективного теста (validation-plan §6) для каждого символа:
 * 1. догрузить закрытые свечи после последней сохранённой;
 * 2. сформировать сигналы только для решений ПОСЛЕ прошлого цикла — история,
 *    загруженная впервые, сигналов не даёт (иначе это был бы реплей);
 * 3. не больше одного открытого сигнала на символ;
 * 4. оценить исходы открытых сигналов и дописать определившиеся.
 * Записи только добавляются; существующие не меняются.
 */
export async function runLiveCycle(opts: LiveCycleOptions): Promise<SymbolCycleReport[]> {
  const { source, archive, strategy } = opts;
  const now = opts.now ?? Date.now;
  const tf = strategy.timeframe;
  const size = TIMEFRAME_MS[tf];
  const reports: SymbolCycleReport[] = [];

  for (const symbol of opts.symbols) {
    const prevLast = archive.lastCandle(source.id, symbol, tf);
    const bootstrap = prevLast === undefined;
    const from = prevLast ? prevLast.closeTime : alignToTimeframe(now(), tf) - (strategy.lookback + 1) * size;
    const ingest = await ingestHistory({
      source, store: archive, symbol, timeframe: tf, from, to: now() + size, now, ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
    const last = archive.lastCandle(source.id, symbol, tf);

    // Все записанные сигналы символа и их исходы.
    // Один журнал на id стратегии; версии (например, 1h и 4h) не смешиваются.
    const records = archive
      .readJsonl<LiveSignalRecord>(signalsLog(strategy))
      .filter((r) => r.signal.symbol === symbol && r.signal.source === source.id && r.signal.strategyVersion === strategy.version);
    const outcomes = new Map(archive.readJsonl<SignalOutcome>(outcomesLog(strategy)).map((o) => [o.signalId, o]));
    const known = new Set(records.map((r) => r.signal.id));

    // 2. Новые решения: closeTime свечи > конца архива до этого цикла.
    let fresh: TradingSignal[] = [];
    if (!bootstrap && last && last.closeTime > prevLast!.closeTime) {
      const window = archive.getCandles(source.id, { symbol, timeframe: tf, from: prevLast!.closeTime - strategy.lookback * size });
      fresh = replaySignals(strategy, window).filter((s) => s.createdAt > prevLast!.closeTime && !known.has(s.id));
    }

    // 3. Не больше одного открытого сигнала: как в runBacktest.
    const asOf = last?.closeTime ?? 0;
    const evaluate = (s: TradingSignal) =>
      evaluateSignal(s, archive.getCandles(source.id, { symbol, timeframe: tf, from: s.basisCloseTime, limit: windowBars(s) + 1 }), asOf);
    const busyUntilOf = (s: TradingSignal): number => {
      const o = outcomes.get(s.id) ?? evaluate(s);
      if (o.status === "pending") return Number.POSITIVE_INFINITY;
      if (o.status === "data-gap") return s.expiresAt;
      return o.exitTime ?? Number.NEGATIVE_INFINITY;
    };
    const latest = records.at(-1)?.signal;
    let busyUntil = latest ? busyUntilOf(latest) : Number.NEGATIVE_INFINITY;
    const accepted: LiveSignalRecord[] = [];
    let skippedOverlap = 0;
    const recordedAt = now();
    for (const s of fresh) {
      if (s.createdAt < busyUntil) {
        skippedOverlap++;
        continue;
      }
      accepted.push({ signal: s, recordedAt, codeCommit: opts.codeCommit ?? null, late: recordedAt - s.createdAt > size });
      busyUntil = busyUntilOf(s);
    }
    archive.appendJsonl(signalsLog(strategy), accepted);

    // 4. Исходы всех ещё не оценённых сигналов.
    const newOutcomes: SignalOutcome[] = [];
    const openSignals: TradingSignal[] = [];
    for (const { signal } of [...records, ...accepted]) {
      if (outcomes.has(signal.id)) continue;
      const e = evaluate(signal);
      if (e.status === "pending") openSignals.push(signal);
      else newOutcomes.push(e);
    }
    archive.appendJsonl(outcomesLog(strategy), newOutcomes);

    reports.push({
      symbol,
      bootstrap,
      received: ingest.received - ingest.unclosedReceived,
      lastClose: last?.closeTime ?? null,
      gaps: ingest.gaps,
      newSignals: accepted.map((r) => r.signal),
      skippedOverlap,
      newOutcomes,
      openSignals,
    });
  }
  return reports;
}
