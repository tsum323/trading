import { TIMEFRAME_MS, type Timeframe, type UnixMs } from "@/core/time";
import type { Candle, MarketDataSource, MarketSymbol } from "./types";

/**
 * Свечи [from, to) из источника постранично (по `pageLimit`), без хранилища.
 * Результат по возрастанию openTime; последняя свеча может быть незакрытой.
 */
export async function fetchCandleRange(
  source: MarketDataSource,
  query: { symbol: MarketSymbol; timeframe: Timeframe; from: UnixMs; to: UnixMs },
  opts: { pageLimit?: number; maxPages?: number; signal?: AbortSignal } = {},
): Promise<Candle[]> {
  const pageLimit = opts.pageLimit ?? 1000;
  const maxPages = opts.maxPages ?? 20;
  const size = TIMEFRAME_MS[query.timeframe];
  const out: Candle[] = [];
  let cursor = Math.ceil(query.from / size) * size;

  for (let page = 0; page < maxPages && cursor < query.to; page++) {
    const batch = await source.fetchCandles({ ...query, from: cursor, limit: pageLimit }, opts.signal);
    if (batch.length === 0) break;
    for (const c of batch) if (c.openTime >= cursor) out.push(c);
    const next = batch.at(-1)!.openTime + size;
    if (next <= cursor) break;
    cursor = next;
    if (batch.length < pageLimit) break;
  }
  return out;
}
