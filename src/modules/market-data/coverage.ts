import { TIMEFRAME_MS, type Timeframe, type UnixMs } from "@/core/time";
import type { Candle } from "./types";

export interface Gap {
  /** openTime первой отсутствующей свечи. */
  from: UnixMs;
  /** Исключительная граница: openTime первой свечи после пропуска (или первая граница таймфрейма >= конца диапазона). */
  to: UnixMs;
  missing: number;
}

/**
 * Пропуски в покрытии [from, to) свечами одного ряда. Ожидаемые openTime —
 * все границы таймфрейма в диапазоне. Ряд должен быть отсортирован по openTime.
 */
export function findGaps(candles: readonly Candle[], timeframe: Timeframe, from: UnixMs, to: UnixMs): Gap[] {
  const size = TIMEFRAME_MS[timeframe];
  const start = Math.ceil(from / size) * size;
  const gaps: Gap[] = [];
  let expected = start;

  const push = (until: UnixMs) => {
    if (until > expected) gaps.push({ from: expected, to: until, missing: (until - expected) / size });
  };

  for (const c of candles) {
    if (c.openTime < start || c.openTime >= to) continue;
    push(c.openTime);
    expected = Math.max(expected, c.openTime + size);
  }
  // Первая граница >= to: все ожидаемые openTime до неё лежат внутри [from, to).
  push(Math.ceil(to / size) * size);
  return gaps;
}
