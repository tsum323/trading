import type { Timeframe, UnixMs } from "@/core/time";

/** Идентификатор публичного источника данных, например "binance-spot". */
export type MarketDataSourceId = string;

/** Символ в нормализованном виде: BASE/QUOTE, например "BTC/USDT". */
export type MarketSymbol = string;

/**
 * Свеча OHLCV.
 *
 * Инварианты (проверяются validateCandle):
 * - closeTime === openTime + длительность таймфрейма;
 * - low <= min(open, close) <= max(open, close) <= high;
 * - все цены > 0, volume >= 0, все числа конечны.
 *
 * `isClosed` фиксируется источником в момент получения. Стратегии и индикаторы
 * не доверяют этому флагу напрямую: закрытость определяется сравнением
 * closeTime с моментом принятия решения (см. backtest/closed-candles.ts).
 */
export interface Candle {
  source: MarketDataSourceId;
  symbol: MarketSymbol;
  timeframe: Timeframe;
  openTime: UnixMs;
  closeTime: UnixMs;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Объём в базовой валюте. */
  volume: number;
  isClosed: boolean;
}

export interface CandleQuery {
  symbol: MarketSymbol;
  timeframe: Timeframe;
  /** Включительная нижняя граница по openTime. */
  from?: UnixMs;
  /** Исключительная верхняя граница по openTime. */
  to?: UnixMs;
  limit?: number;
}

/**
 * Источник публичных рыночных данных. Только чтение, без аутентификации:
 * реализации не принимают и не хранят API-ключи.
 */
export interface MarketDataSource {
  readonly id: MarketDataSourceId;
  /** Свечи по возрастанию openTime. Может включать последнюю незакрытую свечу (isClosed = false). */
  fetchCandles(query: CandleQuery, signal?: AbortSignal): Promise<Candle[]>;
  /** Список символов, которые источник умеет отдавать. */
  listSymbols(signal?: AbortSignal): Promise<MarketSymbol[]>;
}
