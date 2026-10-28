import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TIMEFRAME_MS, type Timeframe } from "@/core/time";
import type { Candle, CandleQuery, MarketDataSourceId, MarketSymbol } from "@/modules/market-data";

const CSV_HEADER = "open_time,open,high,low,close,volume";

/**
 * Текстовый архив для хранения в git (ветка `data`):
 *
 *   candles/<source>/<BASE-QUOTE>/<tf>/<YYYY-MM>.csv   закрытые свечи по месяцам
 *   <name>.jsonl                                       журналы (сигналы, исходы)
 *
 * Текст вместо бинарной SQLite: частые коммиты дают маленькие дельты.
 * Хранятся только закрытые свечи; уже записанная свеча не перезаписывается.
 * Интерфейс upsertCandles/getCandles совместим с SqliteStore.
 */
export class FileArchive {
  constructor(readonly root: string) {}

  private seriesDir(source: MarketDataSourceId, symbol: MarketSymbol, tf: Timeframe): string {
    return join(this.root, "candles", source, symbol.replace("/", "-"), tf);
  }

  private months(source: MarketDataSourceId, symbol: MarketSymbol, tf: Timeframe): string[] {
    const dir = this.seriesDir(source, symbol, tf);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}\.csv$/.test(f))
      .map((f) => f.slice(0, 7))
      .sort();
  }

  private readMonth(source: MarketDataSourceId, symbol: MarketSymbol, tf: Timeframe, month: string): Candle[] {
    const path = join(this.seriesDir(source, symbol, tf), `${month}.csv`);
    if (!existsSync(path)) return [];
    const size = TIMEFRAME_MS[tf];
    return readFileSync(path, "utf8")
      .split("\n")
      .slice(1)
      .filter((line) => line.length > 0)
      .map((line) => {
        const [t, o, h, l, c, v] = line.split(",").map(Number) as [number, number, number, number, number, number];
        return { source, symbol, timeframe: tf, openTime: t, closeTime: t + size, open: o, high: h, low: l, close: c, volume: v, isClosed: true };
      });
  }

  /**
   * Добавляет закрытые свечи; незакрытые отбрасываются, уже записанные не меняются.
   * Время получения не хранится: в git его фиксирует коммит.
   */
  upsertCandles(candles: readonly Candle[]): void {
    const groups = new Map<string, Candle[]>();
    for (const c of candles) {
      if (!c.isClosed) continue;
      const key = JSON.stringify([c.source, c.symbol, c.timeframe, new Date(c.openTime).toISOString().slice(0, 7)]);
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    for (const [key, group] of groups) {
      const [source, symbol, tf, month] = JSON.parse(key) as [string, string, Timeframe, string];
      const byOpen = new Map<number, Candle>();
      for (const c of group) byOpen.set(c.openTime, c);
      for (const c of this.readMonth(source, symbol, tf, month)) byOpen.set(c.openTime, c); // записанное не меняется
      const rows = [...byOpen.values()]
        .sort((a, b) => a.openTime - b.openTime)
        .map((c) => [c.openTime, c.open, c.high, c.low, c.close, c.volume].join(","));
      const path = join(this.seriesDir(source, symbol, tf), `${month}.csv`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${CSV_HEADER}\n${rows.join("\n")}\n`);
    }
  }

  getCandles(source: MarketDataSourceId, query: CandleQuery): Candle[] {
    const from = query.from ?? Number.NEGATIVE_INFINITY;
    const to = query.to ?? Number.POSITIVE_INFINITY;
    const monthOf = (t: number) => (Number.isFinite(t) ? new Date(t).toISOString().slice(0, 7) : undefined);
    const fromMonth = monthOf(from) ?? "";
    const toMonth = monthOf(to) ?? "9999-99";
    const out: Candle[] = [];
    for (const m of this.months(source, query.symbol, query.timeframe)) {
      if (m < fromMonth || m > toMonth) continue;
      for (const c of this.readMonth(source, query.symbol, query.timeframe, m)) {
        if (c.openTime >= from && c.openTime < to) out.push(c);
      }
    }
    return query.limit === undefined ? out : out.slice(0, query.limit);
  }

  lastCandle(source: MarketDataSourceId, symbol: MarketSymbol, tf: Timeframe): Candle | undefined {
    const months = this.months(source, symbol, tf);
    for (let i = months.length - 1; i >= 0; i--) {
      const last = this.readMonth(source, symbol, tf, months[i]!).at(-1);
      if (last) return last;
    }
    return undefined;
  }

  readJsonl<T>(name: string): T[] {
    const path = join(this.root, `${name}.jsonl`);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as T);
  }

  appendJsonl(name: string, records: readonly unknown[]): void {
    if (records.length === 0) return;
    const path = join(this.root, `${name}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
  }

  writeText(name: string, content: string): void {
    const path = join(this.root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}
