import type { UnixMs } from "@/core/time";
import { factorsAsOf, type FactorRow } from "@/modules/derivatives";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface CrowdingFeatures {
  /** Средняя премия фьючерса к споту за последние 3 дня. */
  premium3d: number;
  /** Место этой средней среди 3-дневных средних за предыдущие 90 дней (0..1). */
  premiumPct: number;
  /** Изменение открытого интереса за 3 дня. */
  oiChange3d: number;
  /** Изменение открытого интереса за 7 дней. */
  oiChange7d: number;
  /** Час последней известной строки. */
  lastFactorHour: UnixMs;
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * Признаки позиционирования на момент t — только по строкам, опубликованным к t
 * (factorsAsOf). null — данных мало или они устарели больше чем на 3 дня.
 */
export function crowdingFeatures(rows: readonly FactorRow[], t: UnixMs, historyDays = 90): CrowdingFeatures | null {
  const all = factorsAsOf(rows, t);
  // Нужны только последние historyDays + 10 дней: так расчёт не растёт с историей.
  const from = t - (historyDays + 10) * DAY;
  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (all[mid]!.openTime < from) lo = mid + 1;
    else hi = mid;
  }
  const known = all.slice(lo);
  const last = known.at(-1);
  if (!last || t - last.openTime > 3 * DAY + 2 * DAY) return null;

  // Средние премии по дням (UTC), только полные дни: не меньше 20 часов с премией.
  const byDay = new Map<number, number[]>();
  for (const r of known) {
    if (r.premium === null) continue;
    const d = Math.floor(r.openTime / DAY);
    byDay.set(d, [...(byDay.get(d) ?? []), r.premium]);
  }
  const days = [...byDay.entries()].filter(([, v]) => v.length >= 20).sort((a, b) => a[0] - b[0]);
  if (days.length < historyDays + 3) return null;
  const daily = days.map(([d, v]) => ({ d, v: mean(v) }));
  const rolling = daily.slice(2).map((x, i) => ({ d: x.d, v: (daily[i]!.v + daily[i + 1]!.v + x.v) / 3 }));
  const current = rolling.at(-1)!;
  // Окно сравнения — 90 предыдущих 3-дневных средних без текущей.
  const window = rolling.slice(-1 - historyDays, -1);
  const premiumPct = window.filter((x) => x.v <= current.v).length / window.length;

  const oiAt = (hoursBack: number): number | null => {
    const target = last.openTime - hoursBack * HOUR;
    for (let i = known.length - 1; i >= 0; i--) {
      const r = known[i]!;
      if (r.openTime <= target) return r.openTime >= target - 6 * HOUR ? r.oiUsd : null;
    }
    return null;
  };
  const oiNow = last.oiUsd;
  const oi3 = oiAt(72);
  const oi7 = oiAt(168);
  if (oiNow === null || !oi3 || !oi7) return null;
  return { premium3d: current.v, premiumPct, oiChange3d: oiNow / oi3 - 1, oiChange7d: oiNow / oi7 - 1, lastFactorHour: last.openTime };
}
