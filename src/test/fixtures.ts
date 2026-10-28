import { TIMEFRAME_MS, type Timeframe } from "@/core/time";
import type { Candle } from "@/modules/market-data";

/**
 * ТЕСТОВЫЕ ДАННЫЕ. Детерминированные синтетические свечи для юнит-тестов.
 * Источник помечен как "test-fixture"; эти данные никогда не попадают в
 * хранилище приложения и не выдаются за рыночные.
 */
export const FIXTURE_SOURCE = "test-fixture";

export function makeCandles(
  closes: readonly number[],
  opts: { timeframe?: Timeframe; start?: number; symbol?: string; lastOpen?: boolean } = {},
): Candle[] {
  const timeframe = opts.timeframe ?? "1m";
  const size = TIMEFRAME_MS[timeframe];
  const start = opts.start ?? Date.UTC(2024, 0, 1);
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1]!;
    const openTime = start + i * size;
    return {
      source: FIXTURE_SOURCE,
      symbol: opts.symbol ?? "TEST/USDT",
      timeframe,
      openTime,
      closeTime: openTime + size,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: 10,
      isClosed: !(opts.lastOpen && i === closes.length - 1),
    };
  });
}

/** Детерминированная «пила» без случайности, чтобы тесты были воспроизводимы. */
export function sawtooth(n: number, base = 100): number[] {
  return Array.from({ length: n }, (_, i) => base + ((i * 7) % 13) - 6);
}
