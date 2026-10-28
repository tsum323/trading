import { describe, expect, it } from "vitest";
import { CANDLE_CSV_HEADER, MarketDataError, type Candle, type MarketDataSource } from "@/modules/market-data";
import { DataBranchReader } from "@/services/data-branch";
import { makeCandles } from "@/test/fixtures";
import { loadCandles, type DataDeps } from "./data";

const Q = 15 * 60_000;
const NOW = Date.UTC(2026, 9, 28, 12, 7);
/** Синтетические 15m-свечи за последние 12 часов — только для тестов. */
const archived = makeCandles(Array.from({ length: 48 }, (_, i) => 100 + i), { timeframe: "15m", start: NOW - 48 * Q - (NOW % Q) }).map(
  (c) => ({ ...c, source: "binance-spot", symbol: "BTC/USDT" }),
);
const csv = `${CANDLE_CSV_HEADER}\n${archived.map((c) => [c.openTime, c.open, c.high, c.low, c.close, c.volume].join(",")).join("\n")}\n`;

function deps(binance: ((from: number) => Promise<Candle[]>) | "fail", files: Record<string, string> = {}): DataDeps & { paths: string[] } {
  const paths: string[] = [];
  const source: MarketDataSource = {
    id: "binance-spot",
    async fetchCandles(q) {
      if (binance === "fail") throw new MarketDataError("GET /api/v3/klines → HTTP 451", 451);
      return binance(q.from ?? 0);
    },
    async listSymbols() {
      return [];
    },
  };
  const reader = new DataBranchReader("https://raw.example/data", (async (url: string | URL | Request) => {
    const path = String(url).replace("https://raw.example/data/", "");
    paths.push(path);
    return files[path] ? new Response(files[path]) : new Response("", { status: 404 });
  }) as typeof fetch);
  return { source, reader, now: () => NOW, paths };
}

describe("loadCandles", () => {
  it("uses Binance when it answers", async () => {
    const r = await loadCandles("BTC/USDT", "15m", 10, deps(async (from) => archived.filter((c) => c.openTime >= from)));
    expect(r).toMatchObject({ origin: "binance", notice: null });
    // 10 = 9 закрытых + текущая формирующаяся; в тестовых данных формирующейся нет.
    expect(r.candles).toHaveLength(9);
    expect(r.candles[0]!.openTime).toBe(NOW - (NOW % Q) - 9 * Q);
  });

  it("falls back to real candles from the data branch and resamples them", async () => {
    const d = deps("fail", { "candles/binance-spot/BTC-USDT/15m/2026-10.csv": csv });
    const r = await loadCandles("BTC/USDT", "1h", 12, d);
    expect(d.paths).toEqual(["candles/binance-spot/BTC-USDT/15m/2026-10.csv"]);
    expect(r.origin).toBe("data-branch");
    expect(r.notice).toContain("HTTP 451");
    expect(r.candles.every((c) => c.timeframe === "1h" && c.isClosed)).toBe(true);
    expect(r.candles.length).toBeGreaterThan(0);
    expect(r.candles.at(-1)!.close).toBe(archived.at(-1)!.close);
  });

  it("fails loudly when neither source has data — no substitute quotes", async () => {
    await expect(loadCandles("SOL/USDT", "1h", 12, deps("fail"))).rejects.toThrow(/нет свечей SOL\/USDT/);
  });

  it("does not fall back when the request was aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const d = deps(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(loadCandles("BTC/USDT", "15m", 10, d, controller.signal)).rejects.toThrow();
    expect(d.paths).toEqual([]);
  });
});
