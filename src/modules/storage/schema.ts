/**
 * Схема SQLite. Время — INTEGER (UTC ms), цены — REAL (double).
 * Версия схемы хранится в PRAGMA user_version; миграции добавляются по порядку.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE candles (
    source      TEXT    NOT NULL,
    symbol      TEXT    NOT NULL,
    timeframe   TEXT    NOT NULL,
    open_time   INTEGER NOT NULL,
    close_time  INTEGER NOT NULL,
    open        REAL    NOT NULL,
    high        REAL    NOT NULL,
    low         REAL    NOT NULL,
    close       REAL    NOT NULL,
    volume      REAL    NOT NULL,
    is_closed   INTEGER NOT NULL CHECK (is_closed IN (0, 1)),
    fetched_at  INTEGER NOT NULL,
    PRIMARY KEY (source, symbol, timeframe, open_time)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE signals (
    id                TEXT    PRIMARY KEY,
    strategy_id       TEXT    NOT NULL,
    strategy_version  TEXT    NOT NULL,
    source            TEXT    NOT NULL,
    symbol            TEXT    NOT NULL,
    timeframe         TEXT    NOT NULL,
    created_at        INTEGER NOT NULL,
    basis_close_time  INTEGER NOT NULL CHECK (basis_close_time <= created_at),
    direction         TEXT    NOT NULL CHECK (direction IN ('long', 'short')),
    entry_type        TEXT    NOT NULL,
    entry_ref_price   REAL    NOT NULL,
    stop_loss         REAL    NOT NULL,
    take_profits      TEXT    NOT NULL, -- JSON number[]
    expires_at        INTEGER NOT NULL,
    features          TEXT    NOT NULL, -- JSON Record<string, number>
    rule              TEXT    NOT NULL,
    -- 'live' — сформирован в реальном времени (перспективный тест), 'replay' — на истории
    mode              TEXT    NOT NULL CHECK (mode IN ('live', 'replay')),
    recorded_at       INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX signals_by_strategy ON signals (strategy_id, strategy_version, created_at);

  CREATE TABLE signal_outcomes (
    signal_id     TEXT    PRIMARY KEY REFERENCES signals (id),
    status        TEXT    NOT NULL CHECK (status IN ('target', 'stop', 'expired', 'ambiguous', 'no-entry')),
    entry_time    INTEGER,
    entry_price   REAL,
    exit_time     INTEGER,
    exit_price    REAL,
    r_multiple    REAL,
    mfe_r         REAL,
    mae_r         REAL,
    evaluated_at  INTEGER NOT NULL,
    evaluator_version TEXT NOT NULL
  ) STRICT;
  `,
  // v2: статус 'data-gap' и причина 'no-entry'. SQLite не меняет CHECK на месте — пересоздаём таблицу с копированием строк.
  `
  CREATE TABLE signal_outcomes_v2 (
    signal_id     TEXT    PRIMARY KEY REFERENCES signals (id),
    status        TEXT    NOT NULL CHECK (status IN ('target', 'stop', 'expired', 'ambiguous', 'no-entry', 'data-gap')),
    reason        TEXT,
    entry_time    INTEGER,
    entry_price   REAL,
    exit_time     INTEGER,
    exit_price    REAL,
    r_multiple    REAL,
    mfe_r         REAL,
    mae_r         REAL,
    evaluated_at  INTEGER NOT NULL,
    evaluator_version TEXT NOT NULL
  ) STRICT;
  INSERT INTO signal_outcomes_v2 (signal_id, status, entry_time, entry_price, exit_time, exit_price,
    r_multiple, mfe_r, mae_r, evaluated_at, evaluator_version)
  SELECT signal_id, status, entry_time, entry_price, exit_time, exit_price,
    r_multiple, mfe_r, mae_r, evaluated_at, evaluator_version
  FROM signal_outcomes;
  DROP TABLE signal_outcomes;
  ALTER TABLE signal_outcomes_v2 RENAME TO signal_outcomes;
  `,
];
