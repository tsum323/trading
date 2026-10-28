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
import { BinanceSpotSource } from "@/modules/market-data";
import { FileArchive } from "@/modules/storage";
import { getStrategy } from "@/modules/strategies/registry";
import {
  assertHoldoutAllowed,
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
  const strategy = getStrategy(values.strategy);
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

main().catch((e: unknown) => {
  const cause = e instanceof Error && e.cause instanceof Error ? ` (cause: ${(e.cause as NodeJS.ErrnoException).code ?? e.cause.message})` : "";
  console.error(e instanceof Error ? `${e.name}: ${e.message}${cause}` : e);
  process.exitCode = 1;
});
