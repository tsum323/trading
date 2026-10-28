/**
 * Время в системе — всегда UTC, миллисекунды Unix epoch (целое число).
 * Свеча с openTime = T и таймфреймом tf покрывает полуинтервал [T, T + tf).
 */
export type UnixMs = number;

export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

const MINUTE = 60_000;

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": MINUTE,
  "5m": 5 * MINUTE,
  "15m": 15 * MINUTE,
  "1h": 60 * MINUTE,
  "4h": 240 * MINUTE,
  "1d": 1440 * MINUTE,
};

export function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value);
}

/** Начало интервала таймфрейма, в который попадает момент `t`. */
export function alignToTimeframe(t: UnixMs, tf: Timeframe): UnixMs {
  const size = TIMEFRAME_MS[tf];
  return Math.floor(t / size) * size;
}

/** Момент закрытия свечи (исключительная граница интервала). */
export function candleCloseTime(openTime: UnixMs, tf: Timeframe): UnixMs {
  return openTime + TIMEFRAME_MS[tf];
}
