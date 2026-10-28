import type { Indicator } from "./types";

/**
 * Average True Range со сглаживанием Уайлдера.
 * TR[0] = high − low; TR[i] = max(high − low, |high − close[i−1]|, |low − close[i−1]|).
 * Первое значение — среднее первых `period` TR (индекс period − 1).
 */
export function atr(period: number): Indicator {
  if (!Number.isInteger(period) || period < 1) throw new RangeError(`ATR period must be a positive integer, got ${period}`);
  return {
    id: `atr(${period})`,
    warmup: period,
    compute(candles) {
      const out: (number | null)[] = new Array(candles.length).fill(null);
      let sum = 0;
      let prev = 0;
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i]!;
        const prevClose = i > 0 ? candles[i - 1]!.close : undefined;
        const tr =
          prevClose === undefined
            ? c.high - c.low
            : Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
        if (i < period) {
          sum += tr;
          if (i === period - 1) out[i] = prev = sum / period;
        } else {
          out[i] = prev = (prev * (period - 1) + tr) / period;
        }
      }
      return out;
    },
  };
}
