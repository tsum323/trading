/**
 * Один цикл виртуальных трейдеров (бумажная торговля на публичных данных Binance Spot).
 *
 *   npm run personas -- --archive ../trading-data
 *
 * Архив — каталог с текстовыми данными (ветка `data`, см. FileArchive).
 */
import { parseArgs } from "node:util";
import { formatDateTime } from "@/core/time";
import { BinanceSpotSource } from "@/modules/market-data";
import { FileArchive } from "@/modules/storage";
import { runPersonasCycle } from "@/services/personas/cycle";

async function main() {
  const { values } = parseArgs({
    options: {
      archive: { type: "string" },
      "base-url": { type: "string" },
    },
  });
  if (!values.archive) throw new Error("Required: --archive <dir> [--base-url url]");

  const archive = new FileArchive(values.archive);
  const source = new BinanceSpotSource(values["base-url"] ? { baseUrl: values["base-url"] } : {});
  const report = await runPersonasCycle({ source, archive, codeCommit: process.env.GITHUB_SHA ?? null });

  for (const i of report.ingest) {
    const gaps = i.gaps.reduce((s, g) => s + g.missing, 0);
    console.log(`${i.symbol} ${i.timeframe}: +${i.received} closed candles${gaps ? `, ${gaps} missing` : ""}`);
  }
  for (const p of report.snapshot.personas) {
    const r = report.personas.find((x) => x.id === p.id)!;
    console.log(
      `${p.emoji} ${p.name}: $${p.equity.toFixed(2)} (${(p.returnPct * 100).toFixed(2)}%), closed ${p.closedTrades}, open ${p.open.length}` +
        ` | this cycle: +${r.newEntries} entries, +${r.newExits} exits, ${r.rebalances} rebalances`,
    );
  }
  console.log(`Snapshot at ${formatDateTime(report.snapshot.generatedAt)} MSK`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
