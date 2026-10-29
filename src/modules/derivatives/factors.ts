import type { UnixMs } from "@/core/time";
import type { MarketSymbol } from "@/modules/market-data";

/**
 * Факторы позиционирования на фьючерсах Binance USDⓈ-M (публичный архив
 * data.binance.vision), по часам. Это не цены спота: отдельный источник,
 * который описывает, как распределены позиции участников.
 */
export interface FactorRow {
  /** Начало часа (UTC). */
  openTime: UnixMs;
  /** Открытый интерес в USDT на конец часа. */
  oiUsd: number | null;
  /** Соотношение лонгов к шортам у крупных трейдеров (по числу счетов), конец часа. */
  topLongShort: number | null;
  /** Соотношение лонгов к шортам у всех счетов, конец часа. */
  longShort: number | null;
  /** Объём агрессивных покупок к продажам, среднее за час. */
  takerRatio: number | null;
  /** Премия фьючерса к индексу спота (из неё считается funding), close часа. */
  premium: number | null;
}

export const FACTOR_SOURCE = "binance-um";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Архив публикует файл за день D примерно в 08–11 UTC дня D+1. Для расчётов
 * значение часа считается известным с D+1 14:00 UTC — с запасом; так история
 * и живая торговля видят данные одинаково поздно.
 */
export const FACTOR_PUBLICATION_LAG_MS = DAY + 14 * HOUR;

export function factorAvailableAt(openTime: UnixMs): UnixMs {
  return Math.floor(openTime / DAY) * DAY + FACTOR_PUBLICATION_LAG_MS;
}

/** Строки, известные к моменту t (ряд по возрастанию openTime). */
export function factorsAsOf(rows: readonly FactorRow[], t: UnixMs): readonly FactorRow[] {
  // Доступность монотонна по openTime: достаточно правой границы.
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (factorAvailableAt(rows[mid]!.openTime) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo === rows.length ? rows : rows.slice(0, lo);
}

/** Факторы по символам; стратегии получают их при создании. */
export type FactorBook = ReadonlyMap<MarketSymbol, readonly FactorRow[]>;

export const EMPTY_FACTORS: FactorBook = new Map();

const num = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === "") return null;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
};

/** Сводит 5-минутные метрики (`*-metrics-YYYY-MM-DD.csv`) в часовые строки. */
export function parseMetricsCsv(csv: string): Omit<FactorRow, "premium">[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0]!.split(",");
  const col = (name: string) => header.indexOf(name);
  const iTime = col("create_time");
  const iOi = col("sum_open_interest_value");
  const iTop = col("count_toptrader_long_short_ratio");
  const iLs = col("count_long_short_ratio");
  const iTaker = col("sum_taker_long_short_vol_ratio");
  if ([iTime, iOi, iTop, iLs, iTaker].some((i) => i < 0)) throw new Error("metrics: unexpected header");
  const hours = new Map<UnixMs, { last: Omit<FactorRow, "openTime" | "premium" | "takerRatio">; lastAt: UnixMs; taker: number[] }>();
  for (const line of lines.slice(1)) {
    const f = line.split(",");
    const t = Date.parse(`${f[iTime]!.replace(" ", "T")}Z`);
    if (!Number.isFinite(t)) continue;
    // Снимок в 00:00…00:55 — к часу 00:00 того же дня: строка не выходит за день своего
    // файла, иначе её доступность считалась бы по дню, опубликованному раньше.
    const h = Math.floor(t / HOUR) * HOUR;
    const cur = hours.get(h) ?? { last: { oiUsd: null, topLongShort: null, longShort: null }, lastAt: -1, taker: [] };
    if (t >= cur.lastAt) {
      cur.last = { oiUsd: num(f[iOi]), topLongShort: num(f[iTop]), longShort: num(f[iLs]) };
      cur.lastAt = t;
    }
    const taker = num(f[iTaker]);
    if (taker !== null) cur.taker.push(taker);
    hours.set(h, cur);
  }
  return [...hours.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([openTime, v]) => ({
      openTime,
      ...v.last,
      takerRatio: v.taker.length === 0 ? null : v.taker.reduce((s, x) => s + x, 0) / v.taker.length,
    }));
}

/** Часовые свечи премии (`premiumIndexKlines/.../1h`): close по openTime. */
export function parsePremiumCsv(csv: string): Map<UnixMs, number> {
  const out = new Map<UnixMs, number>();
  for (const line of csv.trim().split(/\r?\n/)) {
    const f = line.split(",");
    const t = Number(f[0]);
    const close = num(f[4]);
    if (Number.isFinite(t) && close !== null) out.set(t, close);
  }
  return out;
}

export const FACTOR_CSV_HEADER = "openTime,oiUsd,topLongShort,longShort,takerRatio,premium";

export function factorCsvPath(symbol: MarketSymbol, month: string): string {
  return `factors/${FACTOR_SOURCE}/${symbol.replace("/", "-")}/1h/${month}.csv`;
}

export function formatFactorRows(rows: readonly FactorRow[]): string {
  const v = (x: number | null) => (x === null ? "" : String(x));
  return `${FACTOR_CSV_HEADER}\n${rows.map((r) => [r.openTime, v(r.oiUsd), v(r.topLongShort), v(r.longShort), v(r.takerRatio), v(r.premium)].join(",")).join("\n")}\n`;
}

export function parseFactorCsv(csv: string): FactorRow[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines[0] !== FACTOR_CSV_HEADER) throw new Error("factors: unexpected header");
  return lines.slice(1).map((line) => {
    const f = line.split(",");
    return { openTime: Number(f[0]), oiUsd: num(f[1]), topLongShort: num(f[2]), longShort: num(f[3]), takerRatio: num(f[4]), premium: num(f[5]) };
  });
}
