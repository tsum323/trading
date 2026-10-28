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

/**
 * Часовой пояс отображения. Данные и расчёты остаются в UTC (свечи Binance
 * выровнены по UTC); меняется только то, как время показывается человеку.
 */
export const DISPLAY_TIME_ZONE = "Europe/Moscow";
export const DISPLAY_TZ_LABEL = "МСК";

const displayFormatters = new Map<string, Intl.DateTimeFormat>();

function displayFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let f = displayFormatters.get(key);
  // sv-SE даёт ISO-подобный вид: 2026-10-28 22:15
  if (!f) displayFormatters.set(key, (f = new Intl.DateTimeFormat("sv-SE", { timeZone: DISPLAY_TIME_ZONE, hourCycle: "h23", ...options })));
  return f;
}

/** «2026-10-28 22:15» в часовом поясе отображения. */
export function formatDateTime(t: UnixMs): string {
  return displayFormatter({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(t);
}

/** «22:15» в часовом поясе отображения. */
export function formatClock(t: UnixMs): string {
  return displayFormatter({ hour: "2-digit", minute: "2-digit" }).format(t);
}

/** «28.10» в часовом поясе отображения — подписи дней на шкале времени. */
export function formatDayMonth(t: UnixMs): string {
  const parts = displayFormatter({ day: "2-digit", month: "2-digit" }).formatToParts(t);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}.${get("month")}`;
}
