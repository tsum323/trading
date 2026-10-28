/**
 * Один цикл перспективного теста trend-pullback на живых публичных данных.
 * Запускается по расписанию из .github/workflows/live.yml; можно и вручную:
 *
 *   npm run live -- --archive ../trading-data --symbols BTC/USDT,ETH/USDT
 *
 * Архив — каталог с текстовыми данными (ветка `data`, см. FileArchive).
 */
import { parseArgs } from "node:util";
import { BinanceSpotSource } from "@/modules/market-data";
import { FileArchive } from "@/modules/storage";
import { trendPullback } from "@/modules/strategies/trend-pullback";
import { runLiveCycle } from "@/services/live-cycle";
import { renderLiveReport } from "@/services/live-report";

async function main() {
  const { values } = parseArgs({
    options: {
      archive: { type: "string" },
      symbols: { type: "string", default: "BTC/USDT,ETH/USDT" },
      "base-url": { type: "string" },
    },
  });
  if (!values.archive) throw new Error("Required: --archive <dir> [--symbols A/B,C/D] [--base-url url]");

  const archive = new FileArchive(values.archive);
  const strategy = trendPullback();
  const source = new BinanceSpotSource(values["base-url"] ? { baseUrl: values["base-url"] } : {});
  const symbols = values.symbols.split(",").map((s) => s.trim()).filter(Boolean);

  const cycle = await runLiveCycle({ source, archive, strategy, symbols, codeCommit: process.env.GITHUB_SHA ?? null });
  archive.writeText(`reports/${strategy.id}.md`, renderLiveReport(archive, strategy, cycle, Date.now()));

  for (const c of cycle) {
    const gaps = c.gaps.reduce((s, g) => s + g.missing, 0);
    console.log(
      `${c.symbol}: +${c.received} candles${c.bootstrap ? " (bootstrap)" : ""}, last close ${c.lastClose ? new Date(c.lastClose).toISOString() : "—"}, ` +
        `gaps ${gaps}, new signals ${c.newSignals.length}, skipped ${c.skippedOverlap}, new outcomes ${c.newOutcomes.length}, open ${c.openSignals.length}`,
    );
  }
}

main().catch((e: unknown) => {
  const cause = e instanceof Error && e.cause instanceof Error ? ` (cause: ${(e.cause as NodeJS.ErrnoException).code ?? e.cause.message})` : "";
  console.error(e instanceof Error ? `${e.name}: ${e.message}${cause}` : e);
  process.exitCode = 1;
});
