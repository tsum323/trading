import { describe, expect, it } from "vitest";
import type { Candle, MarketDataSource } from "@/modules/market-data";
import { fetchCandleRange } from "@/modules/market-data";
import { FIXTURE_SOURCE, makeCandles } from "@/test/fixtures";
import { DataBranchReader } from "./data-branch";

function reader(files: Record<string, string | number>) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    const path = String(url).replace("https://raw.example/data/", "");
    calls.push(path);
    const body = files[path];
    if (body === undefined) return new Response("Not Found", { status: 404 });
    if (typeof body === "number") return new Response("err", { status: body });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return { r: new DataBranchReader("https://raw.example/data/", impl), calls };
}

describe("DataBranchReader", () => {
  it("reads JSONL and treats a missing file as empty", async () => {
    const { r } = reader({ "signals/x.jsonl": '{"a":1}\n\n{"a":2}\n' });
    expect(await r.readJsonl("signals/x.jsonl")).toEqual([{ a: 1 }, { a: 2 }]);
    expect(await r.readJsonl("missing.jsonl")).toEqual([]);
    expect(await r.readJson("missing.json")).toBeNull();
  });

  it("fails loudly on a corrupt line or a server error instead of hiding data", async () => {
    const { r } = reader({ "bad.jsonl": '{"a":1}\n{oops\n', "err.jsonl": 500 });
    await expect(r.readJsonl("bad.jsonl")).rejects.toThrow("bad.jsonl:2");
    await expect(r.readJsonl("err.jsonl")).rejects.toThrow("HTTP 500");
  });

  it("builds GitHub browse links only for raw.githubusercontent.com", () => {
    expect(new DataBranchReader("https://raw.githubusercontent.com/o/r/data").browseUrl("reports")).toBe("https://github.com/o/r/blob/data/reports");
    expect(new DataBranchReader("https://raw.example/data").browseUrl("reports")).toBeNull();
  });
});

describe("fetchCandleRange", () => {
  it("pages through the source until the range is covered", async () => {
    const all = makeCandles(Array.from({ length: 25 }, (_, i) => 100 + i), { timeframe: "1h" });
    const calls: number[] = [];
    const source: MarketDataSource = {
      id: FIXTURE_SOURCE,
      async fetchCandles(q) {
        calls.push(q.from!);
        return all.filter((c: Candle) => c.openTime >= q.from! && c.openTime < q.to!).slice(0, q.limit);
      },
      async listSymbols() {
        return [];
      },
    };
    const got = await fetchCandleRange(source, { symbol: "TEST/USDT", timeframe: "1h", from: all[0]!.openTime, to: all.at(-1)!.closeTime }, { pageLimit: 10 });
    expect(got).toEqual(all);
    expect(calls).toHaveLength(3);
  });
});
