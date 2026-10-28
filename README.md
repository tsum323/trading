# trading

Личный аналитический терминал для исследования внутридневного крипторынка:
свечи, индикаторы, проверяемые сигналы, расчёт риска, AI-объяснения и учёт
результатов прогнозов.

> **Только исследование.** Исполнения ордеров нет, торговые API-ключи не
> запрашиваются и не хранятся. Используются только публичные рыночные данные.
> Ничто в проекте не утверждает прибыльность какой-либо стратегии.

Статус: каркас. Источник рыночных данных, стратегии и AI-модуль ещё не
реализованы — описаны интерфейсы и правила проверки.

## Требования

- Node.js **22.13+** (используется встроенный `node:sqlite`; версия для CI — в `.nvmrc`)
- npm 10+

## Установка и запуск

```bash
npm ci            # установка точных версий из package-lock.json
npm run dev       # http://localhost:3000
```

## Команды

| Команда | Что делает |
|---|---|
| `npm run dev` | dev-сервер Next.js |
| `npm run build` | production-сборка |
| `npm start` | запуск собранного приложения |
| `npm test` | все тесты Vitest один раз |
| `npm run test:watch` | тесты в режиме наблюдения |
| `npm run typecheck` | проверка типов (`tsc --noEmit`) |
| `npm run lint` | ESLint (конфигурация Next.js) |
| `npm run check` | typecheck + lint + test |

При тестах Node выводит `ExperimentalWarning: SQLite is an experimental
feature` — это ожидаемо для `node:sqlite` в Node 22.

## Структура

```
src/
  app/                 Next.js App Router (UI)
  core/time.ts         UTC-время и таймфреймы
  modules/
    market-data/       тип Candle, интерфейс MarketDataSource, валидация
    indicators/        каузальные индикаторы (эталон: SMA)
    strategies/        интерфейс Strategy, тип TradingSignal, validateSignal
    risk/              размер позиции по доле риска
    backtest/          срез «на момент» и пошаговый реплей
    ai-analysis/       интерфейс объяснения сигналов
    storage/           SQLite-схема и хранилище
  test/fixtures.ts     синтетические свечи ТОЛЬКО для тестов
docs/
  architecture.md      компоненты, поток данных, форматы хранения
  strategy-spec.md     первая исследовательская гипотеза
  validation-plan.md   правила исторического и перспективного тестирования
```

## Зависимости

| Пакет | Зачем |
|---|---|
| `next`, `react`, `react-dom` | UI-приложение |
| `typescript`, `@types/*` | типизация (TS 6.0 — максимум, поддерживаемый `typescript-eslint`) |
| `vitest` | тесты |
| `eslint`, `eslint-config-next` | линтинг (ESLint 9 — плагины `eslint-config-next` ещё не поддерживают 10) |

SQLite — встроенный модуль Node, отдельный пакет не нужен. Библиотека
графиков (планируется `lightweight-charts`) будет добавлена вместе с первым
экраном графика.

## CI

`.github/workflows/ci.yml`: `npm ci` → typecheck → lint → test → build на
каждый push в `main` и pull request.
