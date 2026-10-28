import type { Timeframe, UnixMs } from "@/core/time";
import type { Candle, MarketDataSourceId, MarketSymbol } from "@/modules/market-data";

export type SignalDirection = "long" | "short";

/**
 * Исследовательский сигнал. Это гипотеза для последующей проверки, а не
 * приказ на сделку: система не исполняет ордера.
 */
export interface TradingSignal {
  id: string;
  strategyId: string;
  /** Версия логики и параметров; сигналы разных версий не смешиваются в статистике. */
  strategyVersion: string;
  source: MarketDataSourceId;
  symbol: MarketSymbol;
  timeframe: Timeframe;
  /** Момент принятия решения. */
  createdAt: UnixMs;
  /** closeTime последней свечи, использованной в расчёте. Всегда <= createdAt. */
  basisCloseTime: UnixMs;
  direction: SignalDirection;
  /**
   * Гипотетический вход по цене открытия следующей свечи после basisCloseTime.
   * Эта цена в момент решения неизвестна, поэтому referencePrice — close
   * опорной свечи; фактическую цену входа определяет оценщик исходов.
   */
  entry: { type: "next-open"; referencePrice: number };
  stopLoss: number;
  /** Цели по возрастанию удалённости от входа. */
  takeProfits: number[];
  /** После этого момента неотработавший сигнал считается истёкшим. */
  expiresAt: UnixMs;
  /** Числовой снимок признаков, на которых основано решение. */
  features: Record<string, number>;
  /** Короткое детерминированное описание правила, сработавшего в стратегии. */
  rule: string;
}

/** Данные, которые получает стратегия. Только закрытые на decisionTime свечи. */
export interface StrategyContext {
  source: MarketDataSourceId;
  symbol: MarketSymbol;
  timeframe: Timeframe;
  decisionTime: UnixMs;
  candles: readonly Candle[];
}

export type SignalDraft = Omit<
  TradingSignal,
  "id" | "strategyId" | "strategyVersion" | "source" | "symbol" | "timeframe" | "createdAt"
>;

export interface Strategy {
  readonly id: string;
  readonly version: string;
  readonly timeframe: Timeframe;
  /** Минимум закрытых свечей до первого возможного сигнала. */
  readonly warmup: number;
  /** Сколько последних закрытых свечей передавать в контекст (>= warmup). */
  readonly lookback: number;
  /** Чистая функция: одинаковый контекст — одинаковый результат. */
  evaluate(ctx: StrategyContext): SignalDraft | null;
}
