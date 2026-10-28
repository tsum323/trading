import { describe, expect, it } from "vitest";
import { BinanceSpotSource, MarketDataError, toBinanceSymbol } from "./binance-spot";

/**
 * СИНТЕТИЧЕСКИЕ ответы в формате /api/v3/klines из документации Binance.
 * Это не записанные рыночные данные: цены выбраны произвольно для проверки разбора.
 */
const H = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);
const row = (openTime: number, o: string, h: string, l: string, c: string, v = "1.5") => [
  openTime, o, h, l, c, v, openTime + H - 1, "0", 1, "0", "0", "0",
];

function fakeFetch(respond: (url: URL) => Response) {
  const calls: URL[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    return respond(url);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

describe("toBinanceSymbol", () => {
  it("maps BASE/QUOTE to Binance symbol", () => {
    expect(toBinanceSymbol("btc/usdt")).toBe("BTCUSDT");
    expect(() => toBinanceSymbol("BTCUSDT")).toThrow(MarketDataError);
  });
});

describe("BinanceSpotSource.fetchCandles", () => {
  it("builds the request with an inclusive endTime = to - 1", async () => {
    const f = fakeFetch(() => json([]));
    const src = new BinanceSpotSource({ fetch: f.impl, baseUrl: "https://example.test" });
    await src.fetchCandles({ symbol: "BTC/USDT", timeframe: "1h", from: T0, to: T0 + 10 * H, limit: 10 });

    const url = f.calls[0]!;
    expect(url.origin + url.pathname).toBe("https://example.test/api/v3/klines");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      symbol: "BTCUSDT",
      interval: "1h",
      limit: "10",
      startTime: String(T0),
      endTime: String(T0 + 10 * H - 1),
    });
  });

  it("normalizes rows: numbers, exclusive closeTime, source id", async () => {
    const f = fakeFetch(() => json([row(T0, "10", "12", "9", "11")]));
    const src = new BinanceSpotSource({ fetch: f.impl, now: () => T0 + 10 * H });
    const [c] = await src.fetchCandles({ symbol: "BTC/USDT", timeframe: "1h" });
    expect(c).toEqual({
      source: "binance-spot",
      symbol: "BTC/USDT",
      timeframe: "1h",
      openTime: T0,
      closeTime: T0 + H,
      open: 10,
      high: 12,
      low: 9,
      close: 11,
      volume: 1.5,
      isClosed: true,
    });
  });

  it("marks a candle unclosed until closeTime + clock skew has passed", async () => {
    const f = fakeFetch(() => json([row(T0, "10", "12", "9", "11")]));
    const at = (now: number) =>
      new BinanceSpotSource({ fetch: f.impl, now: () => now, clockSkewMs: 2_000 }).fetchCandles({
        symbol: "BTC/USDT",
        timeframe: "1h",
      });
    expect((await at(T0 + H - 1))[0]!.isClosed).toBe(false);
    expect((await at(T0 + H + 1_999))[0]!.isClosed).toBe(false);
    expect((await at(T0 + H + 2_000))[0]!.isClosed).toBe(true);
  });

  it("rejects rows whose closeTime does not match the timeframe", async () => {
    const bad = row(T0, "10", "12", "9", "11");
    bad[6] = T0 + 2 * H - 1;
    const src = new BinanceSpotSource({ fetch: fakeFetch(() => json([bad])).impl });
    await expect(src.fetchCandles({ symbol: "BTC/USDT", timeframe: "1h" })).rejects.toThrow(/closeTime/);
  });

  it("rejects inconsistent OHLC instead of storing it", async () => {
    const src = new BinanceSpotSource({ fetch: fakeFetch(() => json([row(T0, "10", "9", "8", "11")])).impl });
    await expect(src.fetchCandles({ symbol: "BTC/USDT", timeframe: "1h" })).rejects.toThrow(/high-below-body/);
  });

  it("surfaces HTTP status and Retry-After", async () => {
    const f = fakeFetch(() => new Response("too many", { status: 429, headers: { "retry-after": "3" } }));
    const err = await new BinanceSpotSource({ fetch: f.impl })
      .fetchCandles({ symbol: "BTC/USDT", timeframe: "1h" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketDataError);
    expect(err).toMatchObject({ status: 429, retryAfterMs: 3_000 });
  });

  it("validates limit", async () => {
    const src = new BinanceSpotSource({ fetch: fakeFetch(() => json([])).impl });
    await expect(src.fetchCandles({ symbol: "BTC/USDT", timeframe: "1h", limit: 1001 })).rejects.toThrow(/limit/);
  });
});

describe("BinanceSpotSource.listSymbols", () => {
  it("returns only TRADING symbols in BASE/QUOTE form", async () => {
    const f = fakeFetch(() =>
      json({
        symbols: [
          { baseAsset: "BTC", quoteAsset: "USDT", status: "TRADING" },
          { baseAsset: "OLD", quoteAsset: "USDT", status: "BREAK" },
        ],
      }),
    );
    expect(await new BinanceSpotSource({ fetch: f.impl }).listSymbols()).toEqual(["BTC/USDT"]);
  });
});
