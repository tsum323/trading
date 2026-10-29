/**
 * Исторический прогон стратегии (--strategy) на одной части зафиксированного разбиения
 * (docs/validation-plan.md §2). Запускается из .github/workflows/research.yml.
 *
 *   npm run research -- --archive <dir> --strategy donchian-breakout --segment research
 *
 * При первом запуске разбиение создаётся из --from/--to (по умолчанию — 24
 * месяца до начала текущего месяца) и сохраняется в research/split.json; дальше
 * используется только оно. Отложенная часть проверяется один раз на версию.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BinanceSpotSource, type Candle } from "@/modules/market-data";
import { FileArchive } from "@/modules/storage";
import { FactorArchive, ingestFactors } from "@/modules/derivatives/vision";
import { FACTOR_STRATEGY_IDS, getStrategy } from "@/modules/strategies/registry";
import { ingestHistory } from "@/services/ingest-history";
import { renderRotationReport, rotationJournalEntry, ROTATION_ID, ROTATION_UNIVERSE, ROTATION_VERSION, runRotationResearch } from "@/services/rotation-research";
import {
  assertHoldoutAllowed,
  segmentRange,
  journalEntry,
  JOURNAL,
  planSplit,
  renderResearchReport,
  runResearch,
  SEGMENTS,
  SPLIT_FILE,
  type JournalEntry,
  type Segment,
  type SplitPlan,
} from "@/services/research";

function parseDate(name: string, value: string): number {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(t)) throw new Error(`--${name}: cannot parse date "${value}"`);
  return t;
}

async function main() {
  const { values } = parseArgs({
    options: {
      archive: { type: "string" },
      strategy: { type: "string", default: "trend-pullback" },
      segment: { type: "string", default: "research" },
      symbols: { type: "string", default: "BTC/USDT,ETH/USDT" },
      from: { type: "string" },
      to: { type: "string" },
      runs: { type: "string", default: "1000" },
      seed: { type: "string", default: "1" },
      "base-url": { type: "string" },
    },
  });
  if (!values.archive) throw new Error("Required: --archive <dir> [--segment research|validation|holdout]");
  if (!(SEGMENTS as readonly string[]).includes(values.segment)) throw new Error(`--segment must be one of ${SEGMENTS.join(", ")}`);
  const segment = values.segment as Segment;
  const runs = Number(values.runs);
  const seed = Number(values.seed);
  const at = Date.now();
  const codeCommit = process.env.GITHUB_SHA ?? null;

  const archive = new FileArchive(values.archive);
  const symbols = values.symbols.split(",").map((s) => s.trim()).filter(Boolean);

  const splitPath = join(values.archive, SPLIT_FILE);
  let plan: SplitPlan;
  if (existsSync(splitPath)) {
    plan = JSON.parse(readFileSync(splitPath, "utf8")) as SplitPlan;
    if (values.from || values.to) console.error(`Note: ${SPLIT_FILE} already exists; --from/--to are ignored.`);
  } else {
    const monthStart = new Date(at);
    const to = values.to ? parseDate("to", values.to) : Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), 1);
    const toDate = new Date(to);
    const from = values.from ? parseDate("from", values.from) : Date.UTC(toDate.getUTCFullYear() - 2, toDate.getUTCMonth(), 1);
    plan = planSplit(from, to, at);
    archive.writeText(SPLIT_FILE, `${JSON.stringify(plan, null, 2)}\n`);
    console.error(`Created ${SPLIT_FILE}: ${JSON.stringify(plan)}`);
  }

  if (values.strategy === ROTATION_ID) {
    await runRotation(archive, plan, segment, { at, codeCommit, seed, runs, baseUrl: values["base-url"] });
    return;
  }

  // Стратегиям на факторах — архив факторов фьючерсов с запасом на 90-дневное окно.
  let factors;
  if (FACTOR_STRATEGY_IDS.has(values.strategy)) {
    const factorArchive = new FactorArchive(values.archive);
    const from = plan.from - 120 * 86_400_000;
    for (const r of await ingestFactors({ archive: factorArchive, symbols, from })) {
      console.error(`factors ${r.symbol}: ${r.days} days, last ${r.lastDay}${r.missingDays.length ? `, missing ${r.missingDays.join(" ")}` : ""}`);
    }
    factors = factorArchive.book(symbols, from);
  }
  const strategy = getStrategy(values.strategy, factors ? { factors } : {});

  const journal = archive.readJsonl<JournalEntry>(JOURNAL);
  if (segment === "holdout") assertHoldoutAllowed(journal, strategy);

  const result = await runResearch({
    source: new BinanceSpotSource(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
    archive, strategy, symbols, plan, segment, runs, seed,
  });
  const entry = journalEntry(result, { at, codeCommit, seed, runs });
  archive.appendJsonl(JOURNAL, [entry]);

  const md = renderResearchReport(result, plan, [...journal, entry], { at, codeCommit });
  const stamp = new Date(at).toISOString().slice(0, 16).replace(":", "");
  archive.writeText(`reports/research/${stamp}-${strategy.id}-${segment}.md`, md);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

/** Недельная ротация (docs/strategy-rotation.md): портфель, а не сделки по сигналам. Корзина фиксирована. */
async function runRotation(
  archive: FileArchive,
  plan: SplitPlan,
  segment: Segment,
  meta: { at: number; codeCommit: string | null; seed: number; runs: number; baseUrl: string | undefined },
) {
  const journal = archive.readJsonl<JournalEntry>(JOURNAL);
  if (segment === "holdout") assertHoldoutAllowed(journal, { id: ROTATION_ID, version: ROTATION_VERSION });
  const range = segmentRange(plan, segment);
  if (range.to > meta.at) throw new RangeError(`Segment ${segment} ends in the future`);
  console.error(`Rotation uses its pre-registered basket: ${ROTATION_UNIVERSE.join(", ")} (--symbols ignored).`);
  const source = new BinanceSpotSource(meta.baseUrl ? { baseUrl: meta.baseUrl } : {});
  const from = range.from - 40 * 86_400_000;
  const daily = new Map<string, Candle[]>();
  for (const symbol of ROTATION_UNIVERSE) {
    const r = await ingestHistory({ source, store: archive, symbol, timeframe: "1d", from, to: range.to });
    const gaps = r.gaps.reduce((a, g) => a + g.missing, 0);
    console.error(`${symbol} 1d: ${r.storedClosed}/${r.expected} candles${gaps ? `, ${gaps} missing` : ""}`);
    daily.set(symbol, archive.getCandles(source.id, { symbol, timeframe: "1d", from, to: range.to }));
  }
  const result = runRotationResearch({ daily, range, segment, runs: meta.runs, seed: meta.seed });
  const entry = rotationJournalEntry(result, meta);
  archive.appendJsonl(JOURNAL, [entry]);
  const md = renderRotationReport(result, plan, meta);
  const stamp = new Date(meta.at).toISOString().slice(0, 16).replace(":", "");
  archive.writeText(`reports/research/${stamp}-${ROTATION_ID}-${segment}.md`, md);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

main().catch((e: unknown) => {
  const cause = e instanceof Error && e.cause instanceof Error ? ` (cause: ${(e.cause as NodeJS.ErrnoException).code ?? e.cause.message})` : "";
  console.error(e instanceof Error ? `${e.name}: ${e.message}${cause}` : e);
  process.exitCode = 1;
});
