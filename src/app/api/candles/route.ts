import { TIMEFRAME_MS } from "@/core/time";
import { BinanceSpotSource, fetchCandleRange, MarketDataError } from "@/modules/market-data";
import { parseCandleRequest } from "@/app/terminal/model";

export const dynamic = "force-dynamic";

/**
 * Последние `count` свечей с публичного API Binance (без ключей). Последняя
 * свеча может быть незакрытой — флаг isClosed. Адрес API можно переопределить
 * переменной BINANCE_BASE_URL.
 */
export async function GET(request: Request) {
  const parsed = parseCandleRequest(new URL(request.url).searchParams);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });

  const source = new BinanceSpotSource(process.env.BINANCE_BASE_URL ? { baseUrl: process.env.BINANCE_BASE_URL } : {});
  const size = TIMEFRAME_MS[parsed.timeframe];
  const now = Date.now();
  try {
    const candles = await fetchCandleRange(source, {
      symbol: parsed.symbol,
      timeframe: parsed.timeframe,
      from: Math.floor(now / size) * size - (parsed.count - 1) * size,
      to: now + size,
    });
    return Response.json({ source: source.id, fetchedAt: now, candles });
  } catch (e) {
    const status = e instanceof MarketDataError && e.status ? e.status : 502;
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: status >= 500 ? 502 : status });
  }
}
