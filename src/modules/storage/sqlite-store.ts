import { DatabaseSync } from "node:sqlite";
import type { Timeframe, UnixMs } from "@/core/time";
import type { Candle, CandleQuery, MarketDataSourceId } from "@/modules/market-data";
import type { TradingSignal } from "@/modules/strategies";
import { MIGRATIONS } from "./schema";

export type SignalMode = "live" | "replay";

interface CandleRow {
  source: string;
  symbol: string;
  timeframe: string;
  open_time: number;
  close_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  is_closed: number;
}

interface SignalRow {
  id: string;
  strategy_id: string;
  strategy_version: string;
  source: string;
  symbol: string;
  timeframe: string;
  created_at: number;
  basis_close_time: number;
  direction: string;
  entry_type: string;
  entry_ref_price: number;
  stop_loss: number;
  take_profits: string;
  expires_at: number;
  features: string;
  rule: string;
}

/**
 * Локальное хранилище на встроенном node:sqlite (без нативных зависимостей).
 * Используется только на сервере / в скриптах, никогда в браузере.
 */
export class SqliteStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    const { user_version: current } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
  }

  /**
   * Вставляет или обновляет свечи. Уже закрытая свеча неизменяема: повторная
   * запись поверх неё игнорируется, обновляется только незакрытая.
   */
  upsertCandles(candles: readonly Candle[], fetchedAt: UnixMs): void {
    const stmt = this.db.prepare(`
      INSERT INTO candles (source, symbol, timeframe, open_time, close_time, open, high, low, close, volume, is_closed, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source, symbol, timeframe, open_time) DO UPDATE SET
        close_time = excluded.close_time, open = excluded.open, high = excluded.high, low = excluded.low,
        close = excluded.close, volume = excluded.volume, is_closed = excluded.is_closed, fetched_at = excluded.fetched_at
      WHERE candles.is_closed = 0
    `);
    this.db.exec("BEGIN");
    try {
      for (const c of candles) {
        stmt.run(c.source, c.symbol, c.timeframe, c.openTime, c.closeTime, c.open, c.high, c.low, c.close, c.volume, c.isClosed ? 1 : 0, fetchedAt);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getCandles(source: MarketDataSourceId, query: CandleQuery): Candle[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM candles
        WHERE source = ? AND symbol = ? AND timeframe = ? AND open_time >= ? AND open_time < ?
        ORDER BY open_time ASC
        LIMIT ?
      `)
      .all(
        source,
        query.symbol,
        query.timeframe,
        query.from ?? Number.MIN_SAFE_INTEGER,
        query.to ?? Number.MAX_SAFE_INTEGER,
        query.limit ?? -1,
      ) as unknown as CandleRow[];
    return rows.map((r) => ({
      source: r.source,
      symbol: r.symbol,
      timeframe: r.timeframe as Timeframe,
      openTime: r.open_time,
      closeTime: r.close_time,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      isClosed: r.is_closed === 1,
    }));
  }

  /** Сигналы неизменяемы: повторная вставка с тем же id — ошибка. */
  insertSignal(s: TradingSignal, mode: SignalMode, recordedAt: UnixMs): void {
    this.db
      .prepare(`
        INSERT INTO signals (id, strategy_id, strategy_version, source, symbol, timeframe, created_at, basis_close_time,
          direction, entry_type, entry_ref_price, stop_loss, take_profits, expires_at, features, rule, mode, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        s.id, s.strategyId, s.strategyVersion, s.source, s.symbol, s.timeframe, s.createdAt, s.basisCloseTime,
        s.direction, s.entry.type, s.entry.referencePrice, s.stopLoss, JSON.stringify(s.takeProfits), s.expiresAt,
        JSON.stringify(s.features), s.rule, mode, recordedAt,
      );
  }

  getSignal(id: string): TradingSignal | undefined {
    const r = this.db.prepare("SELECT * FROM signals WHERE id = ?").get(id) as SignalRow | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      strategyId: r.strategy_id,
      strategyVersion: r.strategy_version,
      source: r.source,
      symbol: r.symbol,
      timeframe: r.timeframe as Timeframe,
      createdAt: r.created_at,
      basisCloseTime: r.basis_close_time,
      direction: r.direction as TradingSignal["direction"],
      entry: { type: "next-open", referencePrice: r.entry_ref_price },
      stopLoss: r.stop_loss,
      takeProfits: JSON.parse(r.take_profits) as number[],
      expiresAt: r.expires_at,
      features: JSON.parse(r.features) as Record<string, number>,
      rule: r.rule,
    };
  }

  close(): void {
    this.db.close();
  }
}
