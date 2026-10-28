import type { Indicator } from "./types";

/**
 * Экспоненциальная скользящая средняя цены закрытия, α = 2 / (period + 1).
 * Затравка — SMA первых `period` значений, поэтому первое значение на индексе period − 1.
 */
export function ema(period: number): Indicator {
  if (!Number.isInteger(period) || period < 1) throw new RangeError(`EMA period must be a positive integer, got ${period}`);
  const alpha = 2 / (period + 1);
  return {
    id: `ema(${period})`,
    warmup: period,
    compute(candles) {
      const out: (number | null)[] = new Array(candles.length).fill(null);
      let sum = 0;
      let prev = 0;
      for (let i = 0; i < candles.length; i++) {
        const close = candles[i]!.close;
        if (i < period) {
          sum += close;
          if (i === period - 1) out[i] = prev = sum / period;
        } else {
          out[i] = prev = alpha * close + (1 - alpha) * prev;
        }
      }
      return out;
    },
  };
}
