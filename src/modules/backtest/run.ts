import { TIMEFRAME_MS, type UnixMs } from "@/core/time";
import type { Candle } from "@/modules/market-data";
import type { Strategy, TradingSignal } from "@/modules/strategies";
import { DEFAULT_COSTS, evaluateSignal, type ExecutionCosts, type SignalOutcome } from "./outcome";
import { replaySignals } from "./replay";

export interface Trade {
  signal: TradingSignal;
  outcome: SignalOutcome;
}

export interface BacktestResult {
  strategyId: string;
  strategyVersion: string;
  /** Все сигналы стратегии в периоде, до фильтра пересечений. */
  signals: TradingSignal[];
  /** Принятые сигналы с определённым исходом. */
  trades: Trade[];
  /** Отброшены: на символе уже был открытый сигнал (strategy-spec §3.9). */
  skippedOverlap: number;
  /** Исход ещё не определён к концу данных. */
  pending: number;
  /** Момент, до которого есть закрытые свечи. */
  asOf: UnixMs;
}

export interface BacktestOptions {
  costs?: ExecutionCosts;
  /** Учитывать только сигналы с createdAt >= from (свечи до него — прогрев). */
  from?: UnixMs;
}

/**
 * Реплей стратегии и оценка исходов. Не больше одного открытого сигнала:
 * новый сигнал принимается, только если предыдущий принятый уже завершился
 * (его exitTime <= createdAt нового) — это известно в момент решения.
 */
export function runBacktest(strategy: Strategy, candles: readonly Candle[], opts: BacktestOptions = {}): BacktestResult {
  const costs = opts.costs ?? DEFAULT_COSTS;
  const closed = candles.filter((c) => c.isClosed);
  const asOf = closed.at(-1)?.closeTime ?? Number.NEGATIVE_INFINITY;
  const indexByOpen = new Map(closed.map((c, i) => [c.openTime, i]));

  const signals = replaySignals(strategy, closed).filter((s) => opts.from === undefined || s.createdAt >= opts.from);
  const trades: Trade[] = [];
  let busyUntil = Number.NEGATIVE_INFINITY;
  let skippedOverlap = 0;
  let pending = 0;

  for (const signal of signals) {
    if (signal.createdAt < busyUntil) {
      skippedOverlap++;
      continue;
    }
    // Оценщику нужны только свечи окна сделки, начиная со свечи входа.
    const start = indexByOpen.get(signal.basisCloseTime) ?? lowerBound(closed, signal.basisCloseTime);
    const evaluation = evaluateSignal(signal, closed.slice(start, start + windowBars(signal) + 1), asOf, costs);
    if (evaluation.status === "pending") {
      pending++;
      busyUntil = Number.POSITIVE_INFINITY;
      continue;
    }
    trades.push({ signal, outcome: evaluation });
    if (evaluation.status === "data-gap") busyUntil = signal.expiresAt;
    else if (evaluation.exitTime !== undefined) busyUntil = evaluation.exitTime;
  }

  return { strategyId: strategy.id, strategyVersion: strategy.version, signals, trades, skippedOverlap, pending, asOf };
}

/** Число свечей в окне сделки: от свечи входа до истечения. */
export function windowBars(signal: TradingSignal): number {
  return Math.ceil((signal.expiresAt - signal.basisCloseTime) / TIMEFRAME_MS[signal.timeframe]);
}

function lowerBound(candles: readonly Candle[], openTime: UnixMs): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid]!.openTime < openTime) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
