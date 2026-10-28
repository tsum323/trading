import { TIMEFRAME_MS, type UnixMs } from "@/core/time";
import type { Candle, CandleQuery, MarketDataSource, MarketSymbol } from "./types";
import { validateCandle } from "./validation";

/**
 * Публичный эндпоинт Binance только для рыночных данных: торговых методов
 * на нём нет. Ключи не нужны и не принимаются.
 * Документация: https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints
 */
export const BINANCE_PUBLIC_DATA_URL = "https://data-api.binance.vision";
export const BINANCE_MAX_LIMIT = 1000;

export class MarketDataError extends Error {
  override name = "MarketDataError";
  constructor(
    message: string,
    readonly status?: number,
    /** Сколько ждать перед повтором, если биржа сообщила. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface BinanceSpotOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => UnixMs;
  /**
   * Запас на расхождение локальных часов с биржей: свеча считается закрытой,
   * только если closeTime + clockSkewMs <= now().
   */
  clockSkewMs?: number;
  timeoutMs?: number;
}

/** "BTC/USDT" → "BTCUSDT". */
export function toBinanceSymbol(symbol: MarketSymbol): string {
  const [base, quote, ...rest] = symbol.split("/");
  if (!base || !quote || rest.length > 0) throw new MarketDataError(`Symbol must be BASE/QUOTE, got "${symbol}"`);
  return `${base}${quote}`.toUpperCase();
}

/**
 * Строка ответа /api/v3/klines:
 * [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBase, takerQuote, ignore].
 * Цены и объёмы — строки, closeTime — последняя миллисекунда интервала (включительно).
 */
type BinanceKline = [number, string, string, string, string, string, number, ...unknown[]];

export class BinanceSpotSource implements MarketDataSource {
  readonly id = "binance-spot";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => UnixMs;
  private readonly clockSkewMs: number;
  private readonly timeoutMs: number;

  constructor(opts: BinanceSpotOptions = {}) {
    this.baseUrl = opts.baseUrl ?? BINANCE_PUBLIC_DATA_URL;
    // Без bind браузер бросает «Illegal invocation» при вызове сохранённого fetch.
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.clockSkewMs = opts.clockSkewMs ?? 2_000;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async fetchCandles(query: CandleQuery, signal?: AbortSignal): Promise<Candle[]> {
    const limit = query.limit ?? BINANCE_MAX_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > BINANCE_MAX_LIMIT) {
      throw new MarketDataError(`limit must be an integer in [1, ${BINANCE_MAX_LIMIT}]`);
    }
    const params = new URLSearchParams({
      symbol: toBinanceSymbol(query.symbol),
      interval: query.timeframe, // обозначения таймфреймов совпадают с Binance
      limit: String(limit),
    });
    if (query.from !== undefined) params.set("startTime", String(query.from));
    // У Binance endTime включительный, у нас `to` — исключительный.
    if (query.to !== undefined) params.set("endTime", String(query.to - 1));

    const rows = await this.getJson<unknown>(`/api/v3/klines?${params}`, signal);
    if (!Array.isArray(rows)) throw new MarketDataError("klines: expected an array");

    const now = this.now();
    const size = TIMEFRAME_MS[query.timeframe];
    return rows.map((row, i) => {
      const k = row as BinanceKline;
      if (!Array.isArray(k) || k.length < 7) throw new MarketDataError(`klines[${i}]: malformed row`);
      const openTime = Number(k[0]);
      if (Number(k[6]) !== openTime + size - 1) {
        throw new MarketDataError(`klines[${i}]: closeTime ${k[6]} does not match ${query.timeframe} at ${openTime}`);
      }
      const candle: Candle = {
        source: this.id,
        symbol: query.symbol,
        timeframe: query.timeframe,
        openTime,
        closeTime: openTime + size,
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        isClosed: openTime + size + this.clockSkewMs <= now,
      };
      const issues = validateCandle(candle, now);
      if (issues.length > 0) throw new MarketDataError(`klines[${i}] at ${openTime}: ${issues.join(", ")}`);
      return candle;
    });
  }

  async listSymbols(signal?: AbortSignal): Promise<MarketSymbol[]> {
    const info = await this.getJson<{ symbols?: { baseAsset: string; quoteAsset: string; status: string }[] }>(
      "/api/v3/exchangeInfo?permissions=SPOT",
      signal,
    );
    if (!Array.isArray(info.symbols)) throw new MarketDataError("exchangeInfo: missing symbols");
    return info.symbols.filter((s) => s.status === "TRADING").map((s) => `${s.baseAsset}/${s.quoteAsset}`);
  }

  async serverTime(signal?: AbortSignal): Promise<UnixMs> {
    const { serverTime } = await this.getJson<{ serverTime: number }>("/api/v3/time", signal);
    if (!Number.isFinite(serverTime)) throw new MarketDataError("time: missing serverTime");
    return serverTime;
  }

  private async getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new MarketDataError(
        `GET ${path.split("?")[0]} → HTTP ${res.status}${body ? `: ${body}` : ""}`,
        res.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      );
    }
    return (await res.json()) as T;
  }
}
