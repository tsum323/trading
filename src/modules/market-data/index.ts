export type { Candle, CandleQuery, MarketDataSource, MarketDataSourceId, MarketSymbol } from "./types";
export { validateCandle, validateSeries, type CandleIssue, type SeriesIssue } from "./validation";
export { findGaps, type Gap } from "./coverage";
export {
  BinanceSpotSource,
  BINANCE_MAX_LIMIT,
  BINANCE_PUBLIC_DATA_URL,
  MarketDataError,
  toBinanceSymbol,
  type BinanceSpotOptions,
} from "./binance-spot";
