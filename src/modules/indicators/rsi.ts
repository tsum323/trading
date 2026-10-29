import type { Indicator } from "./types";

/**
 * Relative Strength Index со сглаживанием Уайлдера (0..100).
 * Первое значение — на индексе `period`: средние первых `period` изменений close.
 */
export function rsi(period: number): Indicator {
  if (!Number.isInteger(period) || period < 1) throw new RangeError(`RSI period must be a positive integer, got ${period}`);
  return {
    id: `rsi(${period})`,
    warmup: period + 1,
    compute(candles) {
      const out: (number | null)[] = new Array(candles.length).fill(null);
      let gain = 0;
      let loss = 0;
      const value = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
      for (let i = 1; i < candles.length; i++) {
        const d = candles[i]!.close - candles[i - 1]!.close;
        const up = Math.max(d, 0);
        const down = Math.max(-d, 0);
        if (i <= period) {
          gain += up / period;
          loss += down / period;
          if (i === period) out[i] = value();
        } else {
          gain = (gain * (period - 1) + up) / period;
          loss = (loss * (period - 1) + down) / period;
          out[i] = value();
        }
      }
      return out;
    },
  };
}
