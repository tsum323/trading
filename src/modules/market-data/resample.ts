import { alignToTimeframe, TIMEFRAME_MS, type Timeframe } from "@/core/time";
import type { Candle } from "./types";

/**
 * Собирает свечи старшего таймфрейма из младших (например, 4 × 15m → 1h).
 *
 * Выдаются только полные интервалы: все младшие свечи на месте и закрыты.
 * Незаконченный или имеющий пропуск интервал пропускается — так старшая свеча
 * не может «подсмотреть» будущее и не строится по неполным данным.
 * Вход — один ряд по возрастанию openTime.
 */
export function resample(candles: readonly Candle[], target: Timeframe): Candle[] {
  const first = candles[0];
  if (!first) return [];
  const sub = TIMEFRAME_MS[first.timeframe];
  const size = TIMEFRAME_MS[target];
  if (size % sub !== 0 || size <= sub) throw new RangeError(`Cannot resample ${first.timeframe} into ${target}`);
  const perBucket = size / sub;

  const out: Candle[] = [];
  let i = 0;
  while (i < candles.length) {
    const bucketOpen = alignToTimeframe(candles[i]!.openTime, target);
    let j = i;
    let complete = true;
    while (j < candles.length && candles[j]!.openTime < bucketOpen + size) {
      if (candles[j]!.openTime !== bucketOpen + (j - i) * sub || !candles[j]!.isClosed) complete = false;
      j++;
    }
    if (complete && j - i === perBucket) {
      const part = candles.slice(i, j);
      out.push({
        source: first.source,
        symbol: first.symbol,
        timeframe: target,
        openTime: bucketOpen,
        closeTime: bucketOpen + size,
        open: part[0]!.open,
        high: Math.max(...part.map((c) => c.high)),
        low: Math.min(...part.map((c) => c.low)),
        close: part.at(-1)!.close,
        volume: part.reduce((s, c) => s + c.volume, 0),
        isClosed: true,
      });
    }
    i = j;
  }
  return out;
}
