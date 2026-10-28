# Архитектура

Личный аналитический терминал для исследования внутридневного крипторынка.
**Исполнение ордеров исключено**: в системе нет кода, который отправляет ордера,
и нет мест для торговых API-ключей. Используются только публичные рыночные данные.

## Принципы

1. **Детерминированное ядро, AI на периферии.** Сигналы формируются только
   кодом стратегий, который можно воспроизвести на истории. AI-модуль лишь
   объясняет готовый сигнал и не влияет на его уровни.
2. **Время решения — главный инвариант.** Любое решение принимается в момент
   `decisionTime` и видит только свечи с `closeTime <= decisionTime`.
3. **Неизменяемость результатов.** Закрытые свечи и записанные сигналы не
   перезаписываются; исходы хранятся отдельно от сигналов.
4. **Никаких выдуманных данных.** Синтетические свечи существуют только в
   тестах (`src/test/fixtures.ts`, источник `test-fixture`) и не попадают в
   хранилище приложения или UI.
5. **Минимум зависимостей.** SQLite — встроенный `node:sqlite`, без нативных
   модулей.

## Компоненты и поток данных

```
 Публичный REST/WebSocket биржи
            │
            ▼
 ┌──────────────────┐   validateCandle / validateSeries
 │   market-data    │── нормализация, проверка, без ключей
 └────────┬─────────┘
          │ Candle[]
          ▼
 ┌──────────────────┐
 │     storage      │  SQLite: candles, signals, signal_outcomes
 └────────┬─────────┘
          │ Candle[] (по возрастанию openTime)
          ▼
 ┌──────────────────┐   closedCandlesAsOf(candles, decisionTime)
 │ backtest/replay  │── единственная точка «среза» по времени
 └────────┬─────────┘
          │ StrategyContext (только закрытые свечи)
          ▼
 ┌──────────────────┐     ┌──────────────┐
 │    strategies    │────▶│  indicators  │  чистые каузальные функции
 └────────┬─────────┘     └──────────────┘
          │ SignalDraft → TradingSignal (validateSignal)
          ▼
 ┌──────────────────┐
 │       risk       │  размер позиции по доле риска (условный капитал)
 └────────┬─────────┘
          │
          ├──────────▶ storage.signals (mode = live | replay)
          │
          ▼
 ┌──────────────────┐
 │   ai-analysis    │  текстовое объяснение + сценарии отмены
 └────────┬─────────┘
          ▼
       UI (Next.js)

 Позже: outcome-evaluator читает свечи ПОСЛЕ сигнала → storage.signal_outcomes
```

Онлайн-режим и реплей используют один и тот же код стратегии; различается
только источник `decisionTime` (часы против closeTime исторической свечи).

## Границы модулей

| Модуль | Отвечает за | Не делает | Зависит от |
|---|---|---|---|
| `core` | время (UTC ms), таймфреймы | — | — |
| `market-data` | тип `Candle`, интерфейс `MarketDataSource`, валидация свечей и рядов | не хранит, не заполняет пропуски, не принимает ключи | core |
| `indicators` | чистые функции `Candle[] → (number\|null)[]` | не обращается к сети/БД, не видит время решения | market-data (типы) |
| `strategies` | интерфейс `Strategy`, типы сигналов, `validateSignal` | не получает данные сам, не исполняет сделки | market-data, indicators |
| `risk` | размер позиции, риск на сделку, ограничения | не знает о реальном счёте | strategies (типы) |
| `backtest` | срез «на момент», пошаговый реплей, оценка исходов (`evaluateSignal`) | не подгружает данные сам | market-data, strategies, risk |
| `ai-analysis` | интерфейс `MarketExplainer` | не создаёт и не меняет сигналы, не участвует в бэктесте | strategies (типы) |
| `storage` | схема SQLite, миграции, чтение/запись | не содержит бизнес-логики | market-data, strategies (типы) |
| `services` | сценарии, связывающие модули: загрузка истории (`ingestHistory`) | не содержит доменной логики индикаторов/стратегий | market-data, storage |

### Источник данных: Binance Spot

`BinanceSpotSource` (`market-data/binance-spot.ts`) обращается к
`https://data-api.binance.vision` — публичному эндпоинту только для рыночных
данных. Нормализация: `BTC/USDT` ↔ `BTCUSDT`; Binance отдаёт `closeTime` как
последнюю миллисекунду интервала, в системе он исключительный (`+1`); цены
из строк в `number`. Свеча считается закрытой, если `closeTime + 2 с` (запас
на расхождение часов) не позже текущего времени. Каждая свеча проходит
`validateCandle`; невалидный ответ — ошибка, а не запись в базу.

`ingestHistory` (`services/ingest-history.ts`) загружает диапазон страницами,
повторяет запрос при 429/5xx/сетевых ошибках (с учётом `Retry-After`), не
повторяет при 418 и в конце строит отчёт `findGaps` по закрытым свечам в
хранилище.

Правило зависимостей: модули импортируют друг друга только через `index.ts`;
`indicators` и `strategies` не импортируют `storage`, `market-data`-реализации
или сеть — это обеспечивает воспроизводимость.

## Минимальные интерфейсы

Код: `src/modules/*/types.ts`.

```ts
interface MarketDataSource {
  id: string;
  fetchCandles(q: CandleQuery, signal?: AbortSignal): Promise<Candle[]>;
  listSymbols(signal?: AbortSignal): Promise<string[]>;
}

interface Indicator {
  id: string; warmup: number;
  compute(candles: readonly Candle[]): (number | null)[]; // value[i] зависит только от candles[0..i]
}

interface Strategy {
  id: string; version: string; timeframe: Timeframe; warmup: number; lookback: number;
  evaluate(ctx: StrategyContext): SignalDraft | null;     // чистая функция
}

interface MarketExplainer {
  explain(req: ExplanationRequest): Promise<Explanation>;
}
```

## Формат хранения

Схема: `src/modules/storage/schema.ts`. Время — `INTEGER` UTC ms, цены —
`REAL`. Версия схемы — `PRAGMA user_version`.

**candles** — ключ `(source, symbol, timeframe, open_time)`.
Свеча покрывает `[open_time, close_time)`. `is_closed = 0` — свеча ещё
формируется; её можно обновлять. Закрытую свечу повторная запись не меняет.
`fetched_at` — когда данные получены (для аудита).

**signals** — один сигнал = одна неизменяемая строка. `basis_close_time <=
created_at` проверяется `CHECK`. `mode`: `live` (сформирован в реальном
времени — перспективный тест) или `replay` (на истории). `recorded_at` —
момент записи; для `live` должен быть близок к `created_at`, это доказывает,
что сигнал не дописан задним числом. `take_profits` и `features` — JSON.

**signal_outcomes** — исход сигнала, вычисленный позже по свечам после
`created_at`: `target | stop | expired | ambiguous | no-entry | data-gap`,
причина `no-entry` (`reason`), цена и время входа/выхода, результат в R,
MFE/MAE в R, версия оценщика. Исход — производная величина: повторная оценка
(новой версией оценщика) заменяет запись. Правила оценки — `validation-plan.md`
§3, реализация — `backtest/outcome.ts`.

Символы нормализуются как `BASE/QUOTE` (`BTC/USDT`), источник — строка вида
`binance-spot`.

## Тесты против утечки будущего

Обязательны для каждого нового индикатора/стратегии (образцы — в `*.test.ts`):

| Тест | Что гарантирует | Где |
|---|---|---|
| Свеча включается ровно при `closeTime == asOf` и исключается при `asOf - 1` | граница закрытия | `backtest/closed-candles.test.ts` |
| Флаг `isClosed` источника игнорируется при срезе | нельзя «закрыть» свечу заранее | там же |
| Реплей не принимает решение на незакрытой свече | нет решений по формирующейся свече | `backtest/replay.test.ts` |
| Максимальный `closeTime` в контексте стратегии == `decisionTime` | стратегия не видит будущего | там же |
| Искажение будущих свечей не меняет прошлые сигналы | инвариантность к будущему | там же |
| Сигнал с `basisCloseTime > decisionTime` → `LookaheadError` | защита от «обхода» среза | там же |
| Индикатор на префиксе == префикс полного расчёта; искажение будущего не меняет прошлое | причинность индикатора | `indicators/sma.test.ts` (`expectCausal`) |
| `validateCandle(c, now)` ловит `isClosed` при `closeTime > now` | ошибку источника | `market-data/validation.test.ts` |
| Схема отвергает `basis_close_time > created_at` | защиту на уровне БД | `storage/sqlite-store.test.ts` |
| Вход по open свечи после `basisCloseTime`; свечи до входа и после выхода не меняют исход | оценщик не видит лишнего | `backtest/outcome.test.ts` |
| Свеча, закрытая после `asOf`, не используется → `pending` | оценка не опережает данные | там же |
| Стоп и цель в одной свече → `ambiguous` (как стоп) | консервативность | там же |
