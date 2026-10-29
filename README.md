# trading

Личный аналитический терминал для исследования внутридневного крипторынка:
свечи, индикаторы, проверяемые сигналы, расчёт риска, AI-объяснения и учёт
результатов прогнозов.

> **Только исследование.** Исполнения ордеров нет, торговые API-ключи не
> запрашиваются и не хранятся. Используются только публичные рыночные данные.
> Ничто в проекте не утверждает прибыльность какой-либо стратегии.

Статус: экран терминала, виртуальные трейдеры (бумажная торговля), загрузка
свечей и исторические прогоны работают. Обе проверенные гипотезы (`trend-pullback`, `donchian-breakout`)
отвергнуты на исследовательской части — торговых рекомендаций система не даёт.
AI-модуль пока только интерфейс.

## Требования

- Node.js **22.13+** (используется встроенный `node:sqlite`; версия для CI — в `.nvmrc`)
- npm 10+

## Установка и запуск

```bash
npm ci            # установка точных версий из package-lock.json
npm run dev       # http://localhost:3000
```

## Экран терминала

**Сайт:** https://tsum323.github.io/trading/ — публикуется автоматически при каждом
изменении `main` (`.github/workflows/pages.yml`). Однократная настройка репозитория:
Settings → Pages → Build and deployment → Source: **GitHub Actions**.

Локально: `npm run dev` (или `npm run build && npm start`) и открыть http://localhost:3000.

На экране:

- свечной график BTC, ETH, SOL, BNB, XRP на 15m / 1h / 4h / 1d с публичного API
  Binance; обновляется каждые 30 с, формирующаяся свеча показана приглушённо;
- EMA 50, EMA 200 и канал Дончиана 48 — только по закрытым свечам;
- сводка: цена, изменение за 24 ч, ATR и сколько R стоят издержки при стопе 2·ATR;
- отметки сигналов перспективного теста и их исходов (из ветки `data`);
- реплей стратегии на видимых свечах — визуальная проверка правил, не исследование;
- калькулятор размера позиции по доле риска с учётом комиссий;
- журнал исследований с вердиктами.

Данные загружает сам браузер: свечи — с публичного API Binance, журнал и
сигналы — из ветки `data` через raw.githubusercontent.com. Если Binance из
браузера недоступен, показываются реальные 15m-свечи символов перспективного
теста из ветки `data` (при необходимости собранные в 1h/4h/1d) с явным
предупреждением и временем последней свечи. Котировки не подставляются: если
данных нет нигде, график пуст и показана ошибка.

Переменные сборки (необязательные):

| Переменная | По умолчанию | Зачем |
|---|---|---|
| `NEXT_PUBLIC_BINANCE_BASE_URL` | `https://data-api.binance.vision` | другой адрес публичного API |
| `NEXT_PUBLIC_DATA_BRANCH_URL` | `https://raw.githubusercontent.com/tsum323/trading/data` | откуда читать журнал, сигналы и запасные свечи |
| `PAGES_BASE_PATH` | — | сборка статического сайта (`/trading` для GitHub Pages) |

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
| `npm run ingest -- …` | загрузка истории свечей в SQLite (см. ниже) |
| `npm run backtest -- …` | исторический прогон `trend-pullback` (см. ниже) |
| `npm run personas -- …` | один цикл виртуальных трейдеров (см. ниже) |
| `npm run live -- …` | один цикл перспективного теста одной стратегии |
| `npm run research -- …` | прогон на части разбиения 60/20/20 с журналом (см. ниже) |

## Загрузка истории

Источник — публичный эндпоинт `https://data-api.binance.vision` (только
рыночные данные, без ключей).

```bash
npm run ingest -- --symbol BTC/USDT --timeframe 15m --from 2024-01-01 --to 2024-02-01
```

| Параметр | Значение |
|---|---|
| `--symbol` | `BASE/QUOTE`, например `BTC/USDT` |
| `--timeframe` | `1m`, `5m`, `15m`, `1h`, `4h`, `1d` |
| `--from` | начало, ISO 8601 (`2024-01-01` = полночь UTC) |
| `--to` | конец, не включительно; по умолчанию — текущий момент |
| `--db` | путь к базе, по умолчанию `data/market.db` (в `.gitignore`) |
| `--base-url` | другой адрес API (например, `https://api.binance.com`) |

Скрипт загружает свечи страницами по 1000, повторяет запрос при 429/5xx и
сетевых ошибках, сразу останавливается при 418 (бан IP), а в конце печатает
отчёт о пропусках. **Пропуски не заполняются.** Повторный запуск безопасен:
закрытые свечи не перезаписываются, текущая незакрытая обновляется.

Если доступ в интернет идёт через HTTP-прокси, встроенный `fetch` Node
не использует его автоматически — запускайте с `NODE_USE_ENV_PROXY=1`.
Binance недоступен из некоторых юрисдикций (HTTP 451).

При тестах Node выводит `ExperimentalWarning: SQLite is an experimental
feature` — это ожидаемо для `node:sqlite` в Node 22.

## Исторический прогон

```bash
npm run ingest -- --symbol BTC/USDT --timeframe 15m --from 2023-12-01 --to 2024-07-01
npm run backtest -- --symbol BTC/USDT --from 2024-01-01 --to 2024-07-01
```

Прогон стратегии (`--strategy trend-pullback` или `donchian-breakout`, по умолчанию первая) по свечам из базы:
сигналы, исходы по правилам `docs/validation-plan.md` §3, матожидание в R с
95% интервалом (блоковый бутстреп по дням), сравнение с 1000 случайными
входами и проверка критериев отказа. Нужен прогрев до `--from`: 30 дней для trend-pullback, ~42 дня для donchian-breakout.
Параметры: `--db`, `--source` (по умолчанию `binance-spot`), `--runs`,
`--seed` (одинаковое зерно — одинаковый отчёт).

Отчёт — не доказательство прибыльности: вывод действителен только для
однократного прогона на отложенной выборке и перспективного теста.

### На GitHub Actions (по кнопке)

Actions → **Research backtest** → Run workflow, выбрать стратегию и часть: `research`,
`validation` или `holdout`. Workflow загружает историю BTC/USDT и ETH/USDT с
Binance, прогоняет стратегию на выбранной части разбиения 60/20/20 и
сохраняет в ветку `data`:

```
research/split.json        границы частей (создаются при первом запуске и не меняются)
research/journal.jsonl     журнал всех прогонов
reports/research/*.md      отчёт каждого прогона
```

Отчёт также показывается на странице запуска (Summary). Порядок: сначала
`research`, затем `validation`; `holdout` — один раз для зафиксированной
версии стратегии, повторный запуск будет отклонён. Локально:
`npm run research -- --archive <каталог> --strategy donchian-breakout --segment research`.

## Виртуальные трейдеры (автоматически)

Страница **«Трейдеры»** на сайте: девять персонажей торгуют на бумаге по разным
правилам на живых ценах Binance — рейтинг, кривые капитала, лента действий,
открытые позиции и история сделок. Цель каждого — вырастить счёт и не потерять
его: риск снижается в просадке, есть дневной стоп, пауза и охлаждение неудачных
монет, а Управляющий отдаёт деньги тем, у кого получается. Правила и учёт — в
`docs/personas.md`.

`.github/workflows/live.yml` запускается каждые 15 минут на GitHub Actions:
догружает закрытые свечи, даёт каждому персонажу принять решения, оценивает
исходы и коммитит всё в ветку **`data`**:

```
candles/binance-spot/<BASE-QUOTE>/<tf>/<YYYY-MM>.csv  закрытые свечи по месяцам
personas/<id>/entries.jsonl     сделки персонажа (только дописываются)
personas/<id>/exits.jsonl       исходы сделок
personas/<id>/skips.jsonl       сигналы, пропущенные ради защиты капитала
personas/<id>/rebalances.jsonl  перестановки портфеля (Ротатор, Холдер, Управляющий)
personas/<id>/cursor.json       до какой свечи обработаны решения
personas/state.json             сводка для сайта
factors/binance-um/<BASE-QUOTE>/1h/<YYYY-MM>.csv  факторы фьючерсов (открытый интерес,
                                long/short, taker, премия) из data.binance.vision
```

- Счета стартуют в момент первого запуска (`personas/start.json`) и дальше торгуют
  только в реальном времени; сайт показывает всё с момента старта. Между циклами
  сайт раз в 30 с переоценивает открытые позиции по текущим ценам Binance.
- Запустить вручную: Actions → Live forward test → Run workflow.
- Расписание GitHub срабатывает ненадёжно (запуски пропускаются или опаздывают);
  опоздавшие решения помечаются «с опозданием». Для регулярных запусков — внешний
  планировщик (ниже).
- GitHub отключает запланированные workflow в публичном репозитории после
  60 дней без активности в нём — тогда их включают снова на вкладке Actions.
- Локально тот же цикл: `npm run personas -- --archive <каталог>`.
- Прежний перспективный тест одной стратегии (`npm run live`) остаётся как CLI;
  его журналы `signals/`, `outcomes/` в ветке `data` больше не обновляются.

### Надёжный запуск каждые 15 минут (cron-job.org)

Внешний планировщик просит GitHub запустить workflow; GitHub выполняет его как
обычно. Токен хранится только у вас и у планировщика.

1. GitHub → Settings → Developer settings → Personal access tokens →
   **Fine-grained tokens** → Generate new token. Repository access: **Only select
   repositories** → `trading`. Permissions → Repository → **Actions: Read and
   write** (остальное не трогать). Срок действия — по желанию; скопировать токен.
2. https://cron-job.org → создать задачу:
   - URL: `https://api.github.com/repos/tsum323/trading/actions/workflows/live.yml/dispatches`
   - расписание: каждые 15 минут, минуты `2,17,32,47`;
   - Advanced → Request method **POST**, заголовки
     `Authorization: Bearer <токен>`, `Accept: application/vnd.github+json`,
     `X-GitHub-Api-Version: 2022-11-28`; тело запроса `{"ref":"main"}`.
3. Проверка: Actions → Live forward test — появляются запуски с событием
   `workflow_dispatch`. Ответ GitHub на запрос — `204`.

Одновременные запуски не пересекаются (`concurrency` в workflow): если сработают
и планировщик, и расписание GitHub, второй подождёт первого.

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
  services/            сценарии, связывающие модули (загрузка истории)
  test/fixtures.ts     синтетические свечи ТОЛЬКО для тестов
scripts/ingest.ts      CLI загрузки истории
scripts/backtest.ts    CLI исторического прогона
scripts/live.ts        один цикл перспективного теста
scripts/personas.ts    один цикл виртуальных трейдеров
scripts/research.ts    прогон на части разбиения
scripts/*-data.sh      подключение и коммит ветки data в workflow
docs/
  architecture.md      компоненты, поток данных, форматы хранения
  strategy-spec.md     trend-pullback (15m) — отвергнута
  strategy-donchian-breakout.md  donchian-breakout (1h) — зафиксирована до прогона
  strategy-crowding.md факторы фьючерсов: crowding и фильтр открытого интереса — до прогона
  validation-plan.md   правила исторического и перспективного тестирования
  personas.md          виртуальные трейдеры: правила, учёт счетов, ограничения
```

## Зависимости

| Пакет | Зачем |
|---|---|
| `next`, `react`, `react-dom` | UI-приложение |
| `lightweight-charts` | свечной график (Apache-2.0, одна зависимость `fancy-canvas`) |
| `typescript`, `@types/*` | типизация (TS 6.0 — максимум, поддерживаемый `typescript-eslint`) |
| `vitest` | тесты |
| `tsx` | запуск TypeScript-скриптов (`scripts/`) с алиасами `@/` без отдельной сборки |
| `eslint`, `eslint-config-next` | линтинг (ESLint 9 — плагины `eslint-config-next` ещё не поддерживают 10) |

SQLite — встроенный модуль Node, отдельный пакет не нужен.

## CI

`.github/workflows/ci.yml`: `npm ci` → typecheck → lint → test → build на
каждый push в `main` и pull request.
