import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UnixMs } from "@/core/time";
import type { MarketSymbol } from "@/modules/market-data";
import {
  factorCsvPath,
  formatFactorRows,
  parseFactorCsv,
  parseMetricsCsv,
  parsePremiumCsv,
  type FactorBook,
  type FactorRow,
} from "./factors";
import { unzipFirstText } from "./zip";

/** Публичный архив Binance: без ключей, CORS разрешён. */
export const BINANCE_VISION_URL = "https://data.binance.vision/data/futures/um";
const DAY = 86_400_000;

const dayStr = (t: UnixMs) => new Date(t).toISOString().slice(0, 10);
const monthStr = (t: UnixMs) => new Date(t).toISOString().slice(0, 7);
const pair = (symbol: MarketSymbol) => symbol.replace("/", "");

export interface VisionDeps {
  fetch?: typeof fetch;
  baseUrl?: string;
}

/** Текст CSV из zip; null — файла нет (ещё не опубликован или не существует). */
async function getZip(url: string, deps: VisionDeps): Promise<string | null> {
  const f = deps.fetch ?? globalThis.fetch.bind(globalThis);
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await f(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
      return unzipFirstText(new Uint8Array(await res.arrayBuffer()));
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/** Хранилище часовых факторов в ветке `data`: factors/binance-um/<BASE-QUOTE>/1h/<YYYY-MM>.csv. */
export class FactorArchive {
  constructor(readonly root: string) {}

  read(symbol: MarketSymbol, from: UnixMs = Number.NEGATIVE_INFINITY): FactorRow[] {
    const out: FactorRow[] = [];
    const start = Number.isFinite(from) ? from : Date.UTC(2019, 0, 1);
    for (let m = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1); m <= Date.now() + 40 * DAY; m = nextMonth(m)) {
      const path = join(this.root, factorCsvPath(symbol, monthStr(m)));
      if (existsSync(path)) out.push(...parseFactorCsv(readFileSync(path, "utf8")).filter((r) => r.openTime >= from));
    }
    return out;
  }

  /** Добавляет строки; час, пришедший заново, заменяет записанный (данные производные от файлов архива). */
  upsert(symbol: MarketSymbol, rows: readonly FactorRow[]): void {
    const byMonth = new Map<string, FactorRow[]>();
    for (const r of rows) byMonth.set(monthStr(r.openTime), [...(byMonth.get(monthStr(r.openTime)) ?? []), r]);
    for (const [month, group] of byMonth) {
      const path = join(this.root, factorCsvPath(symbol, month));
      const byHour = new Map<number, FactorRow>();
      if (existsSync(path)) for (const r of parseFactorCsv(readFileSync(path, "utf8"))) byHour.set(r.openTime, r);
      for (const r of group) byHour.set(r.openTime, r);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, formatFactorRows([...byHour.values()].sort((a, b) => a.openTime - b.openTime)));
    }
  }

  book(symbols: readonly MarketSymbol[], from?: UnixMs): FactorBook {
    return new Map(symbols.map((s) => [s, this.read(s, from)]));
  }
}

function nextMonth(t: UnixMs): UnixMs {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export interface FactorIngestReport {
  symbol: MarketSymbol;
  days: number;
  rows: number;
  /** Дни, которых в архиве нет (кроме ещё не опубликованных последних). */
  missingDays: string[];
  lastDay: string | null;
}

/**
 * Догружает факторы по дням с `from` до вчерашнего дня UTC: премию — месячными
 * файлами за прошлые месяцы и дневными за текущий, метрики — дневными.
 * Останавливается на первом ещё не опубликованном дне в конце.
 */
export async function ingestFactors(opts: {
  archive: FactorArchive;
  symbols: readonly MarketSymbol[];
  from: UnixMs;
  now?: UnixMs;
  concurrency?: number;
  deps?: VisionDeps;
}): Promise<FactorIngestReport[]> {
  const deps = opts.deps ?? {};
  const base = deps.baseUrl ?? BINANCE_VISION_URL;
  const now = opts.now ?? Date.now();
  const today = Math.floor(now / DAY) * DAY;
  const reports: FactorIngestReport[] = [];

  for (const symbol of opts.symbols) {
    const stored = opts.archive.read(symbol, opts.from);
    const lastStored = stored.at(-1)?.openTime;
    // Последний записанный день перечитываем, только если он неполный (нет часов или премии).
    let day = lastStored === undefined ? Math.floor(opts.from / DAY) * DAY : Math.floor(lastStored / DAY) * DAY;
    const lastDayRows = stored.filter((r) => r.openTime >= day);
    if (lastStored !== undefined && lastDayRows.length === 24 && lastDayRows.every((r) => r.premium !== null)) day += DAY;
    const days: UnixMs[] = [];
    for (; day < today; day += DAY) days.push(day);

    const premium = new Map<UnixMs, number>();
    const months = [...new Set(days.map(monthStr))];
    for (const m of months) {
      const monthStart = Date.parse(`${m}-01T00:00:00Z`);
      if (nextMonth(monthStart) <= today - DAY) {
        const text = await getZip(`${base}/monthly/premiumIndexKlines/${pair(symbol)}/1h/${pair(symbol)}-1h-${m}.zip`, deps);
        if (text) for (const [t, v] of parsePremiumCsv(text)) premium.set(t, v);
      }
    }

    const results = new Map<UnixMs, { metrics: string | null; premium: string | null }>();
    const queue = [...days];
    const worker = async () => {
      for (let d = queue.shift(); d !== undefined; d = queue.shift()) {
        const needPremium = ![...Array(24).keys()].every((h) => premium.has(d + h * 3_600_000));
        const [m, p] = await Promise.all([
          getZip(`${base}/daily/metrics/${pair(symbol)}/${pair(symbol)}-metrics-${dayStr(d)}.zip`, deps),
          needPremium ? getZip(`${base}/daily/premiumIndexKlines/${pair(symbol)}/1h/${pair(symbol)}-1h-${dayStr(d)}.zip`, deps) : Promise.resolve(null),
        ]);
        results.set(d, { metrics: m, premium: p });
      }
    };
    await Promise.all(Array.from({ length: opts.concurrency ?? 8 }, worker));

    // Хвост без метрик — ещё не опубликован; дни без метрик в середине — пропуски архива.
    let lastPublished = -1;
    days.forEach((d, i) => {
      if (results.get(d)?.metrics) lastPublished = i;
    });
    const rows: FactorRow[] = [];
    const missingDays: string[] = [];
    days.forEach((d, i) => {
      if (i > lastPublished) return;
      const r = results.get(d)!;
      if (r.premium) for (const [t, v] of parsePremiumCsv(r.premium)) premium.set(t, v);
      if (!r.metrics) {
        missingDays.push(dayStr(d));
        return;
      }
      for (const row of parseMetricsCsv(r.metrics)) {
        if (Math.floor(row.openTime / DAY) * DAY !== d) continue;
        rows.push({ ...row, premium: premium.get(row.openTime) ?? null });
      }
    });
    opts.archive.upsert(symbol, rows);
    reports.push({ symbol, days: lastPublished + 1, rows: rows.length, missingDays, lastDay: lastPublished >= 0 ? dayStr(days[lastPublished]!) : null });
  }
  return reports;
}
