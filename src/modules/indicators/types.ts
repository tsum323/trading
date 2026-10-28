import type { Candle } from "@/modules/market-data";

/**
 * Индикатор — чистая каузальная функция над закрытыми свечами.
 *
 * Контракт: результат имеет ту же длину, что и вход, и значение с индексом i
 * зависит только от candles[0..i]. Пока данных для расчёта недостаточно,
 * значение равно null (не 0 и не NaN). Проверяется тестом причинности:
 * compute(candles.slice(0, k)) должен совпадать с префиксом compute(candles).
 */
export interface Indicator {
  readonly id: string;
  /** Минимальное число свечей до появления первого не-null значения. */
  readonly warmup: number;
  compute(candles: readonly Candle[]): (number | null)[];
}
