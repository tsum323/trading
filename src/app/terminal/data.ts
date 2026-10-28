import { TIMEFRAME_MS, type Timeframe } from "@/core/time";
import {
  BinanceSpotSource,
  candleCsvPath,
  fetchCandleRange,
  parseCandleCsv,
  resample,
  type Candle,
  type MarketDataSource,
} from "@/modules/market-data";
import { DataBranchReader } from "@/services/data-branch";
import { fmtTime } from "./format";

/**
 * Загрузка данных прямо из браузера — так экран работает и как статический
 * сайт (GitHub Pages), и локально. Адреса можно переопределить при сборке:
 * NEXT_PUBLIC_BINANCE_BASE_URL, NEXT_PUBLIC_DATA_BRANCH_URL.
 */
export interface CandleLoad {
  candles: Candle[];
  fetchedAt: number;
  origin: "binance" | "data-branch";
  /** Пояснение, если данные не с Binance напрямую. */
  notice: string | null;
}

export interface DataDeps {
  source: MarketDataSource;
  reader: DataBranchReader;
  now: () => number;
}

export function defaultDeps(): DataDeps {
  const binanceUrl = process.env.NEXT_PUBLIC_BINANCE_BASE_URL;
  return {
    source: new BinanceSpotSource(binanceUrl ? { baseUrl: binanceUrl } : {}),
    reader: new DataBranchReader(process.env.NEXT_PUBLIC_DATA_BRANCH_URL || undefined),
    now: Date.now,
  };
}

const ARCHIVE_TF: Timeframe = "15m";

function monthsBetween(from: number, to: number): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), 1));
  while (d.getTime() <= to) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

/**
 * Свечи с публичного API Binance. Если он недоступен из браузера (CORS,
 * блокировка сети или страны), — реальные 15m-свечи из ветки `data`
 * (обновляются перспективным тестом), при необходимости собранные в старший
 * таймфрейм. Котировки никогда не подставляются: нет данных — ошибка.
 */
export async function loadCandles(
  symbol: string,
  timeframe: Timeframe,
  count: number,
  deps: DataDeps = defaultDeps(),
  signal?: AbortSignal,
): Promise<CandleLoad> {
  const size = TIMEFRAME_MS[timeframe];
  const now = deps.now();
  const from = Math.floor(now / size) * size - (count - 1) * size;
  let binanceError: string;
  try {
    const candles = await fetchCandleRange(deps.source, { symbol, timeframe, from, to: now + size }, signal ? { signal } : {});
    if (candles.length > 0) return { candles, fetchedAt: now, origin: "binance", notice: null };
    binanceError = "пустой ответ";
  } catch (e) {
    if (signal?.aborted) throw e;
    binanceError = e instanceof Error ? e.message : String(e);
  }

  const texts = await Promise.all(
    monthsBetween(from, now).map((m) => deps.reader.readText(candleCsvPath(deps.source.id, symbol, ARCHIVE_TF, m), signal)),
  );
  const base = texts
    .flatMap((t) => (t === null ? [] : parseCandleCsv(t, deps.source.id, symbol, ARCHIVE_TF)))
    .filter((c) => c.openTime >= from)
    .sort((a, b) => a.openTime - b.openTime);
  const candles = timeframe === ARCHIVE_TF ? base : resample(base, timeframe);
  if (candles.length === 0) {
    throw new Error(`Binance недоступен (${binanceError}), а в ветке data нет свечей ${symbol}`);
  }
  return {
    candles,
    fetchedAt: now,
    origin: "data-branch",
    notice:
      `Binance недоступен из этого браузера (${binanceError}). Показаны реальные свечи из ветки data — ` +
      `последняя закрытая ${fmtTime(candles.at(-1)!.closeTime)} UTC. Там хранятся только символы перспективного теста, ` +
      "и обновляются они, пока тот запускается.",
  };
}
