/**
 * Исторический прогон стратегии по свечам из локальной SQLite.
 *
 *   npm run backtest -- --strategy trend-pullback --symbol BTC/USDT --from 2024-01-01 --to 2024-07-01
 *
 * Свечи таймфрейма стратегии должны быть загружены заранее (npm run ingest) с запасом
 * на прогрев (strategy.warmup свечей до --from). Сигналы до --from не учитываются.
 */
import { parseArgs } from "node:util";
import { TIMEFRAME_MS } from "@/core/time";
import { DEFAULT_COSTS, judge, randomBaseline, runBacktest, summarize } from "@/modules/backtest";
import { BinanceSpotSource } from "@/modules/market-data";
import { SqliteStore } from "@/modules/storage";
import { getStrategy } from "@/modules/strategies/registry";

function parseDate(name: string, value: string): number {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(t)) throw new Error(`--${name}: cannot parse date "${value}"`);
  return t;
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
const r3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : String(x));

function main() {
  const { values } = parseArgs({
    options: {
      strategy: { type: "string", default: "trend-pullback" },
      symbol: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      db: { type: "string", default: "data/market.db" },
      source: { type: "string", default: new BinanceSpotSource().id },
      runs: { type: "string", default: "1000" },
      seed: { type: "string", default: "1" },
    },
  });
  if (!values.symbol || !values.from) throw new Error("Required: --symbol BASE/QUOTE --from <date> [--to <date>] [--db path]");

  const strategy = getStrategy(values.strategy);
  const from = parseDate("from", values.from);
  const to = values.to ? parseDate("to", values.to) : Date.now();
  const warmupFrom = from - strategy.warmup * TIMEFRAME_MS[strategy.timeframe];

  const store = new SqliteStore(values.db);
  const candles = store.getCandles(values.source, { symbol: values.symbol, timeframe: strategy.timeframe, from: warmupFrom, to });
  store.close();
  if (candles.length < strategy.warmup) {
    throw new Error(`Only ${candles.length} candles in DB for ${values.symbol} ${strategy.timeframe} from ${iso(warmupFrom)}; need >= ${strategy.warmup}. Run npm run ingest first.`);
  }

  const result = runBacktest(strategy, candles, { from });
  const stats = summarize(result.trades.map((t) => t.outcome), { seed: Number(values.seed) });
  const baseline = randomBaseline(result.trades, candles, { runs: Number(values.runs), seed: Number(values.seed), from });
  const report = judge(stats, baseline);

  console.log(`strategy:  ${result.strategyId}@${result.strategyVersion}`);
  console.log(`data:      ${values.source} ${values.symbol} ${strategy.timeframe}, ${candles.length} candles ${iso(candles[0]!.openTime)} .. ${iso(result.asOf)}`);
  console.log(`period:    signals from ${iso(from)}`);
  console.log(`costs:     fee ${DEFAULT_COSTS.feeRate * 100}%/side, slippage ${DEFAULT_COSTS.slippage * 100}%/side`);
  console.log(`signals:   ${result.signals.length} (skipped overlap ${result.skippedOverlap}, pending ${result.pending})`);
  console.log(`outcomes:  ${Object.entries(stats.byStatus).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`trades:    ${stats.trades}, total ${r3(stats.totalR)} R`);
  console.log(`expectancy ${r3(stats.expectancyR)} R, 95% CI ${stats.ci95 ? `[${r3(stats.ci95[0])}, ${r3(stats.ci95[1])}]` : "n/a"}`);
  console.log(`win rate ${r3(stats.winRate)}, avg win ${r3(stats.avgWinR)} R, avg loss ${r3(stats.avgLossR)} R, PF ${r3(stats.profitFactor)}`);
  console.log(`max drawdown ${r3(stats.maxDrawdownR)} R`);
  console.log(`baseline:  ${baseline.runs} random runs, p50 ${r3(baseline.p50)} R, p95 ${r3(baseline.p95)} R`);
  console.log("");
  for (const c of report.checks) console.log(`  [${c.passed ? "x" : " "}] ${c.name}: ${c.detail}`);
  console.log(`verdict:   ${report.verdict}`);
  console.log("");
  console.log("Это исторический прогон, а не доказательство прибыльности. Вывод действителен только для");
  console.log("однократного прогона на отложенной выборке и подтверждения в перспективном тесте");
  console.log("(docs/validation-plan.md §2, §6). Каждый прогон фиксируйте в журнале исследований (§5).");
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exitCode = 1;
}
