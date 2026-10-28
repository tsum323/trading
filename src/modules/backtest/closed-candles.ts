import type { UnixMs } from "@/core/time";
import type { Candle } from "@/modules/market-data";

/**
 * Единственный разрешённый способ получить данные «на момент» решения.
 *
 * Возвращает свечи, закрытые не позже `asOf` (closeTime <= asOf), в исходном
 * порядке. Флаг `isClosed` источника игнорируется: в реплее история целиком
 * помечена закрытой, и только сравнение со временем решения отсекает будущее.
 * Результат заморожен, чтобы потребитель не мог подмешать данные.
 */
export function closedCandlesAsOf(candles: readonly Candle[], asOf: UnixMs): readonly Candle[] {
  // Ряд отсортирован по openTime, поэтому достаточно найти правую границу.
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid]!.closeTime <= asOf) lo = mid + 1;
    else hi = mid;
  }
  return Object.freeze(candles.slice(0, lo));
}
