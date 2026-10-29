import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { factorAvailableAt, factorsAsOf, parseMetricsCsv, parsePremiumCsv, type FactorRow } from "./factors";
import { FactorArchive, ingestFactors } from "./vision";
import { unzipFirstText } from "./zip";

const H = 3_600_000;
const D = 24 * H;

/** Минимальный zip с одним файлом (как у Binance Vision) — только для тестов. */
export function makeZip(name: string, text: string): Uint8Array {
  const data = deflateRawSync(Buffer.from(text));
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt16LE(n.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt16LE(n.length, 28);
  cd.writeUInt32LE(0, 42);
  const cdOffset = local.length + n.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + n.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return new Uint8Array(Buffer.concat([local, n, data, cd, n, eocd]));
}

/** СИНТЕТИЧЕСКИЕ метрики за день: 288 пятиминуток, интерес растёт линейно. Не рыночные данные. */
function metricsCsv(day: number, oi0 = 1000): string {
  const head = "create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio";
  const rows = Array.from({ length: 288 }, (_, i) => {
    const t = new Date(day + i * 300_000).toISOString().slice(0, 19).replace("T", " ");
    return `${t},TESTUSDT,1,${oi0 + i},2,1.9,1.5,${i % 2 === 0 ? 1 : 3}`;
  });
  return `${head}\n${rows.join("\n")}\n`;
}

function premiumCsv(day: number, value = 0.0001): string {
  const head = "open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore";
  return `${head}\n${Array.from({ length: 24 }, (_, h) => `${day + h * H},0,0,0,${value},0,${day + (h + 1) * H - 1},0,720,0,0,0`).join("\n")}\n`;
}

describe("binance vision factors", () => {
  const DAY0 = Date.UTC(2026, 9, 1);

  it("unzips the single CSV of an archive file", () => {
    expect(unzipFirstText(makeZip("a.csv", "x,y\n1,2\n"))).toBe("x,y\n1,2\n");
  });

  it("aggregates 5-minute metrics into hours of the same day", () => {
    const rows = parseMetricsCsv(metricsCsv(DAY0));
    expect(rows).toHaveLength(24);
    expect(rows[0]!.openTime).toBe(DAY0);
    // Конец часа — снимок 00:55 (индекс 11); taker — среднее 1 и 3.
    expect(rows[0]).toMatchObject({ oiUsd: 1011, topLongShort: 2, longShort: 1.5, takerRatio: 2 });
    expect(rows.every((r) => Math.floor(r.openTime / D) * D === DAY0)).toBe(true);
    expect(parsePremiumCsv(premiumCsv(DAY0)).get(DAY0 + 5 * H)).toBe(0.0001);
  });

  it("makes a day's factors known only after its publication (next day 14:00 UTC)", () => {
    const rows: FactorRow[] = [0, 23].map((h) => ({ openTime: DAY0 + h * H, oiUsd: 1, topLongShort: 1, longShort: 1, takerRatio: 1, premium: 0 }));
    expect(factorAvailableAt(DAY0 + 23 * H)).toBe(DAY0 + D + 14 * H);
    expect(factorsAsOf(rows, DAY0 + D + 14 * H - 1)).toHaveLength(0);
    expect(factorsAsOf(rows, DAY0 + D + 14 * H)).toHaveLength(2);
  });

  describe("ingest", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "trading-factors-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const server = (publishedDays: number) => {
      const urls: string[] = [];
      const fetchImpl = (async (url: string) => {
        urls.push(url);
        const m = /(\d{4}-\d{2}-\d{2})\.zip$/.exec(url);
        const day = m ? Date.parse(`${m[1]}T00:00:00Z`) : NaN;
        if (!m || day >= DAY0 + publishedDays * D) return new Response("", { status: 404 });
        const text = url.includes("/metrics/") ? metricsCsv(day) : premiumCsv(day);
        return new Response(Buffer.from(makeZip("f.csv", text)));
      }) as unknown as typeof fetch;
      return { urls, fetchImpl };
    };

    it("loads published days, stops at the unpublished tail and does not refetch complete days", async () => {
      const archive = new FactorArchive(dir);
      const s = server(3);
      const now = DAY0 + 4 * D + H; // вчера — 4-й день, он ещё не опубликован
      const [r] = await ingestFactors({ archive, symbols: ["TEST/USDT"], from: DAY0, now, deps: { fetch: s.fetchImpl } });
      expect(r).toMatchObject({ days: 3, rows: 72, missingDays: [], lastDay: "2026-10-03" });
      expect(archive.read("TEST/USDT")).toHaveLength(72);
      expect(archive.read("TEST/USDT").every((x) => x.premium === 0.0001)).toBe(true);

      // Следующий цикл: полный последний день не перечитывается, проверяется только новый.
      const again = server(3);
      await ingestFactors({ archive, symbols: ["TEST/USDT"], from: DAY0, now, deps: { fetch: again.fetchImpl } });
      expect(again.urls.every((u) => u.includes("2026-10-04"))).toBe(true);
    });
  });
});
