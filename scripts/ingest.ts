/**
 * Загрузка истории публичных свечей Binance Spot в локальную SQLite.
 *
 *   npm run ingest -- --symbol BTC/USDT --timeframe 15m --from 2024-01-01 --to 2024-02-01
 *
 * Даты — ISO 8601 (UTC, если не указан часовой пояс). `--to` — исключительно.
 * Без `--to` загружается до текущего момента.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { isTimeframe, TIMEFRAMES } from "@/core/time";
import { BinanceSpotSource } from "@/modules/market-data";
import { SqliteStore } from "@/modules/storage";
import { ingestHistory } from "@/services/ingest-history";

function parseDate(name: string, value: string): number {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new Error(`--${name}: cannot parse date "${value}"`);
  return t;
}

const iso = (t: number) => new Date(t).toISOString();

async function main() {
  const { values } = parseArgs({
    options: {
      symbol: { type: "string" },
      timeframe: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      db: { type: "string", default: "data/market.db" },
      "base-url": { type: "string" },
    },
  });
  if (!values.symbol || !values.timeframe || !values.from) {
    throw new Error("Required: --symbol BASE/QUOTE --timeframe <tf> --from <date> [--to <date>] [--db path]");
  }
  if (!isTimeframe(values.timeframe)) throw new Error(`--timeframe must be one of ${TIMEFRAMES.join(", ")}`);

  const from = parseDate("from", values.from);
  const to = values.to ? parseDate("to", values.to) : Date.now();
  mkdirSync(dirname(values.db), { recursive: true });
  const store = new SqliteStore(values.db);

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());

  try {
    const report = await ingestHistory({
      source: new BinanceSpotSource(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
      store,
      symbol: values.symbol,
      timeframe: values.timeframe,
      from,
      to,
      signal: controller.signal,
      onPage: ({ page, received, lastOpenTime }) =>
        console.error(`page ${page}: ${received} candles, up to ${iso(lastOpenTime)}`),
    });

    console.log(`source:   ${report.source}`);
    console.log(`series:   ${report.symbol} ${report.timeframe}`);
    console.log(`range:    ${iso(report.from)} .. ${iso(report.to)} (closed expected until ${iso(report.expectedUntil)})`);
    console.log(`received: ${report.received} candles in ${report.pages} requests (${report.unclosedReceived} unclosed)`);
    console.log(`stored:   ${report.storedClosed} / ${report.expected} closed candles`);
    if (report.gaps.length === 0) {
      console.log("gaps:     none");
    } else {
      const missing = report.gaps.reduce((s, g) => s + g.missing, 0);
      console.log(`gaps:     ${report.gaps.length} (${missing} candles missing, NOT filled)`);
      for (const g of report.gaps.slice(0, 20)) console.log(`  ${iso(g.from)} .. ${iso(g.to)}  missing ${g.missing}`);
      if (report.gaps.length > 20) console.log(`  … and ${report.gaps.length - 20} more`);
    }
  } finally {
    store.close();
  }
}

function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  // fetch прячет настоящую причину (DNS, TLS, отказ соединения) в cause.
  const cause = e.cause instanceof Error ? ` (cause: ${(e.cause as NodeJS.ErrnoException).code ?? e.cause.message})` : "";
  return `${e.name}: ${e.message}${cause}`;
}

main().catch((e: unknown) => {
  console.error(describeError(e));
  process.exitCode = 1;
});
