import type { Candle } from "@/modules/market-data";
import { validateSeries } from "@/modules/market-data";
import type { Strategy, TradingSignal } from "@/modules/strategies";
import { validateSignal } from "@/modules/strategies";
import { closedCandlesAsOf } from "./closed-candles";

export class LookaheadError extends Error {
  override name = "LookaheadError";
}

/**
 * Пошаговый реплей истории: решение принимается в момент закрытия каждой
 * свечи и видит только свечи, закрытые к этому моменту. Генерирует сигналы,
 * но не оценивает их исходы (это отдельный шаг).
 */
export function replaySignals(strategy: Strategy, candles: readonly Candle[]): TradingSignal[] {
  if (strategy.lookback < strategy.warmup) {
    throw new RangeError(`${strategy.id}: lookback (${strategy.lookback}) < warmup (${strategy.warmup})`);
  }
  const seriesIssues = validateSeries(candles);
  if (seriesIssues.some((i) => i.kind !== "gap")) {
    throw new Error(`Series is not a single ascending series: ${JSON.stringify(seriesIssues.slice(0, 3))}`);
  }

  const signals: TradingSignal[] = [];
  for (let i = 0; i < candles.length; i++) {
    const current = candles[i]!;
    // Незакрытая свеча (обычно последняя в ленте) — момент решения ещё не наступил.
    if (!current.isClosed) break;
    if (current.timeframe !== strategy.timeframe) continue;
    const decisionTime = current.closeTime;
    const windowStart = Math.max(0, i + 1 - strategy.lookback);
    const visible = closedCandlesAsOf(candles.slice(windowStart, i + 1), decisionTime);
    if (visible.length < strategy.warmup) continue;

    const draft = strategy.evaluate({
      source: current.source,
      symbol: current.symbol,
      timeframe: current.timeframe,
      decisionTime,
      candles: visible,
    });
    if (!draft) continue;

    const signal: TradingSignal = {
      ...draft,
      id: `${strategy.id}@${strategy.version}:${current.symbol}:${current.timeframe}:${decisionTime}`,
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      source: current.source,
      symbol: current.symbol,
      timeframe: current.timeframe,
      createdAt: decisionTime,
    };
    if (signal.basisCloseTime > decisionTime) {
      throw new LookaheadError(`${signal.id}: basisCloseTime ${signal.basisCloseTime} > decisionTime ${decisionTime}`);
    }
    const issues = validateSignal(signal);
    if (issues.length > 0) throw new Error(`${signal.id}: invalid signal: ${issues.join(", ")}`);
    signals.push(signal);
  }
  return signals;
}
