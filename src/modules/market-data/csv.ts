import { TIMEFRAME_MS, type Timeframe } from "@/core/time";
import type { Candle, MarketDataSourceId, MarketSymbol } from "./types";

export const CANDLE_CSV_HEADER = "open_time,open,high,low,close,volume";

/** Путь месячного файла свечей в текстовом архиве (ветка `data`). */
export function candleCsvPath(source: MarketDataSourceId, symbol: MarketSymbol, tf: Timeframe, month: string): string {
  return `candles/${source}/${symbol.replace("/", "-")}/${tf}/${month}.csv`;
}

/** Разбор месячного CSV архива: в нём только закрытые свечи. */
export function parseCandleCsv(text: string, source: MarketDataSourceId, symbol: MarketSymbol, tf: Timeframe): Candle[] {
  const size = TIMEFRAME_MS[tf];
  return text
    .split("\n")
    .slice(1)
    .filter((line) => line.length > 0)
    .map((line) => {
      const [t, o, h, l, c, v] = line.split(",").map(Number) as [number, number, number, number, number, number];
      return { source, symbol, timeframe: tf, openTime: t, closeTime: t + size, open: o, high: h, low: l, close: c, volume: v, isClosed: true };
    });
}
