import { describe, expect, it } from "vitest";
import type { PersonasSnapshot, PersonaSummary, PersonaTrade } from "@/services/personas/types";
import { applyLive, fetchLivePrices, liveView } from "./live";

const persona = (over: Partial<PersonaSummary>): PersonaSummary => ({
  id: "x", name: "X", emoji: "", tagline: "", rules: [], kind: "signals", timeframe: "1h", symbols: [], strategyKey: null, strategyVersion: null,
  launchedAt: null, equity: 10_000, returnPct: 0, maxDrawdownPct: 0, closedTrades: 0, wins: 0, losses: 0, liveClosedTrades: 0,
  curve: [[0, 10_000]], open: [], history: [], holdings: [], cash: null, rebalances: [], risk: null, allocations: [], ...over,
});
const trade: PersonaTrade = {
  symbol: "BTC/USDT", direction: "short", decidedAt: 0, entryTime: 0, entryPrice: 100, stop: 110, target: 70, expiresAt: 1, qty: 2,
  riskUsd: 20, riskFraction: 0.002, notes: [], state: "open", exitTime: null, exitPrice: null, pnlUsd: -4, r: -0.2, mode: "live",
};

// Тестовая сводка с условными ценами — не рыночные данные.
const snapshot: PersonasSnapshot = {
  generatedAt: 10, startedAt: 0, initialEquity: 10_000, riskPerTrade: 0.01, maxPositionShare: 0.2, costs: { feeRate: 0.001, slippage: 0.0002 }, slippageBySymbol: {},
  codeCommit: null, prices: { "BTC/USDT": { price: 102, time: 5 } }, feed: [],
  personas: [
    persona({ id: "s", equity: 9_996, open: [trade] }),
    persona({ id: "h", kind: "portfolio", equity: 10_200, holdings: [{ symbol: "BTC/USDT", qty: 100, price: 102, value: 10_200 }], cash: 0 }),
    persona({ id: "m", kind: "manager", equity: 10_000, cash: 5_000, allocations: [{ personaId: "h", value: 5_000 }] }),
  ],
};

describe("live view", () => {
  it("re-marks open positions, holdings and the manager's allocations at live prices", () => {
    const v = liveView(snapshot, { "BTC/USDT": 97 });
    // Шорт 2 BTC: цена −5 → +10 к результату.
    expect(v.open.get("s")![0]!.pnlUsd).toBe(6);
    expect(v.equity.get("s")).toBe(10_006);
    expect(v.equity.get("h")).toBe(9_700);
    expect(v.equity.get("m")).toBeCloseTo(5_000 + (5_000 * 9_700) / 10_200, 9);
    const shown = applyLive(snapshot, v, 20);
    expect(shown.personas[0]!.curve.at(-1)).toEqual([20, 10_006]);
  });

  it("keeps the snapshot values for symbols without a live price", () => {
    expect(liveView(snapshot, {}).equity.get("h")).toBe(10_200);
  });

  it("reads Binance ticker prices", async () => {
    let url = "";
    const prices = await fetchLivePrices(["BTC/USDT", "ETH/USDT"], undefined, (async (u: string) => {
      url = u;
      return new Response(JSON.stringify([{ symbol: "BTCUSDT", price: "101.5" }, { symbol: "ETHUSDT", price: "x" }]));
    }) as unknown as typeof fetch);
    expect(decodeURIComponent(url)).toContain('/api/v3/ticker/price?symbols=["BTCUSDT","ETHUSDT"]');
    expect(prices).toEqual({ "BTC/USDT": 101.5 });
  });
});
