import type { Indicator } from "./types";

/** Простая скользящая средняя цены закрытия. Эталон для тестов контракта индикатора. */
export function sma(period: number): Indicator {
  if (!Number.isInteger(period) || period < 1) throw new RangeError(`SMA period must be a positive integer, got ${period}`);
  return {
    id: `sma(${period})`,
    warmup: period,
    compute(candles) {
      const out: (number | null)[] = new Array(candles.length).fill(null);
      let sum = 0;
      for (let i = 0; i < candles.length; i++) {
        sum += candles[i]!.close;
        if (i >= period) sum -= candles[i - period]!.close;
        if (i >= period - 1) out[i] = sum / period;
      }
      return out;
    },
  };
}
