import { alignToTimeframe, TIMEFRAME_MS, type Timeframe, type UnixMs } from "@/core/time";
import { findGaps, MarketDataError, type Gap, type MarketDataSource, type MarketSymbol } from "@/modules/market-data";
import type { SqliteStore } from "@/modules/storage";

export interface IngestOptions {
  source: MarketDataSource;
  store: Pick<SqliteStore, "upsertCandles" | "getCandles">;
  symbol: MarketSymbol;
  timeframe: Timeframe;
  from: UnixMs;
  to: UnixMs;
  pageLimit?: number;
  maxAttempts?: number;
  now?: () => UnixMs;
  sleep?: (ms: number) => Promise<void>;
  onPage?: (info: { page: number; received: number; lastOpenTime: UnixMs }) => void;
  signal?: AbortSignal;
}

export interface IngestReport {
  source: string;
  symbol: MarketSymbol;
  timeframe: Timeframe;
  from: UnixMs;
  to: UnixMs;
  /** Граница, до которой ожидаются закрытые свечи: min(to, начало текущей свечи). */
  expectedUntil: UnixMs;
  pages: number;
  received: number;
  unclosedReceived: number;
  /** Закрытых свечей в хранилище в [from, expectedUntil). */
  storedClosed: number;
  expected: number;
  gaps: Gap[];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 429 и 5xx — временные; 418 (бан IP) и прочие 4xx — нет. */
function isRetryable(e: unknown): boolean {
  if (e instanceof MarketDataError) return e.status === 429 || (e.status !== undefined && e.status >= 500);
  return e instanceof TypeError; // сетевая ошибка fetch
}

/**
 * Постранично загружает свечи [from, to) из публичного источника в хранилище
 * и сообщает о пропусках. Пропуски не заполняются.
 */
export async function ingestHistory(opts: IngestOptions): Promise<IngestReport> {
  const { source, store, symbol, timeframe, from, to, signal } = opts;
  const pageLimit = opts.pageLimit ?? 1000;
  const maxAttempts = opts.maxAttempts ?? 4;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const size = TIMEFRAME_MS[timeframe];
  if (!(from < to)) throw new RangeError("from must be < to");

  let cursor = Math.ceil(from / size) * size;
  let pages = 0;
  let received = 0;
  let unclosedReceived = 0;

  while (cursor < to) {
    signal?.throwIfAborted();
    const page = await withRetry(
      () => source.fetchCandles({ symbol, timeframe, from: cursor, to, limit: pageLimit }, signal),
      maxAttempts,
      sleep,
    );
    pages++;
    if (page.length === 0) break;

    store.upsertCandles(page, now());
    received += page.length;
    unclosedReceived += page.filter((c) => !c.isClosed).length;

    const last = page.at(-1)!;
    opts.onPage?.({ page: pages, received: page.length, lastOpenTime: last.openTime });
    const next = last.openTime + size;
    if (next <= cursor) throw new MarketDataError(`Source did not advance past ${cursor}`);
    cursor = next;
    if (page.length < pageLimit) break;
  }

  const expectedUntil = Math.min(to, alignToTimeframe(now(), timeframe));
  const closed = store
    .getCandles(source.id, { symbol, timeframe, from, to: expectedUntil })
    .filter((c) => c.isClosed);
  const firstExpected = Math.ceil(from / size) * size;

  return {
    source: source.id,
    symbol,
    timeframe,
    from,
    to,
    expectedUntil,
    pages,
    received,
    unclosedReceived,
    storedClosed: closed.length,
    expected: Math.max(0, Math.ceil((expectedUntil - firstExpected) / size)),
    gaps: expectedUntil > from ? findGaps(closed, timeframe, from, expectedUntil) : [],
  };
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts: number, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= maxAttempts || !isRetryable(e)) throw e;
      const hinted = e instanceof MarketDataError ? e.retryAfterMs : undefined;
      await sleep(hinted ?? 1000 * 2 ** (attempt - 1));
    }
  }
}
