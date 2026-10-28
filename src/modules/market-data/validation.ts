import { TIMEFRAME_MS, type UnixMs } from "@/core/time";
import type { Candle } from "./types";

export type CandleIssue =
  | "non-finite-value"
  | "non-positive-price"
  | "negative-volume"
  | "high-below-body"
  | "low-above-body"
  | "close-time-mismatch"
  | "misaligned-open-time"
  | "closed-in-future";

/**
 * Проверяет внутреннюю согласованность свечи. `now` нужен, чтобы поймать
 * свечу, помеченную закрытой раньше своего closeTime.
 */
export function validateCandle(c: Candle, now?: UnixMs): CandleIssue[] {
  const issues: CandleIssue[] = [];
  const nums = [c.open, c.high, c.low, c.close, c.volume, c.openTime, c.closeTime];
  if (!nums.every(Number.isFinite)) return ["non-finite-value"];

  if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) issues.push("non-positive-price");
  if (c.volume < 0) issues.push("negative-volume");
  if (c.high < Math.max(c.open, c.close)) issues.push("high-below-body");
  if (c.low > Math.min(c.open, c.close)) issues.push("low-above-body");

  const size = TIMEFRAME_MS[c.timeframe];
  if (c.closeTime !== c.openTime + size) issues.push("close-time-mismatch");
  if (c.openTime % size !== 0) issues.push("misaligned-open-time");
  if (now !== undefined && c.isClosed && c.closeTime > now) issues.push("closed-in-future");

  return issues;
}

export type SeriesIssue =
  | { kind: "mixed-series"; index: number }
  | { kind: "not-ascending"; index: number }
  | { kind: "gap"; index: number; missing: number };

/**
 * Проверяет ряд свечей одного символа и таймфрейма: строгий рост openTime и
 * отсутствие пропусков. Пропуски не заполняются — о них только сообщается.
 */
export function validateSeries(candles: readonly Candle[]): SeriesIssue[] {
  const issues: SeriesIssue[] = [];
  const first = candles[0];
  if (!first) return issues;
  const size = TIMEFRAME_MS[first.timeframe];

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!;
    const cur = candles[i]!;
    if (cur.symbol !== first.symbol || cur.timeframe !== first.timeframe || cur.source !== first.source) {
      issues.push({ kind: "mixed-series", index: i });
      continue;
    }
    const delta = cur.openTime - prev.openTime;
    if (delta <= 0) issues.push({ kind: "not-ascending", index: i });
    else if (delta > size) issues.push({ kind: "gap", index: i, missing: delta / size - 1 });
  }
  return issues;
}
