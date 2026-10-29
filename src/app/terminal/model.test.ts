import { describe, expect, it } from "vitest";
import { TIMEFRAME_MS } from "@/core/time";
import type { SignalOutcome } from "@/modules/backtest";
import type { TradingSignal } from "@/modules/strategies";
import { FIXTURE_SOURCE, makeCandles, sawtooth } from "@/test/fixtures";
import { buildOverlays, candleCount, chartTime, marketSummary, MAX_CANDLES, signalMarkers, strategiesFor, VISIBLE_CANDLES } from "./model";

const H = TIMEFRAME_MS["1h"];

describe("candleCount", () => {
  it("adds the longest strategy lookback for the timeframe to the visible window", () => {
    expect(strategiesFor("1h").map((e) => e.key)).toEqual(["donchian-breakout", "mean-reversion"]);
    expect(strategiesFor("4h").map((e) => [e.key, e.strategy.timeframe])).toEqual([
      ["donchian-breakout-4h", "4h"],
      ["donchian-breakout-4h-long", "4h"],
      ["random-entry", "4h"],
    ]);
    expect(candleCount("1h")).toBe(VISIBLE_CANDLES + 1000);
    expect(candleCount("15m")).toBe(Math.min(MAX_CANDLES, VISIBLE_CANDLES + 30 * 96 + 14));
    expect(candleCount("4h")).toBe(VISIBLE_CANDLES + 1000);
    expect(candleCount("1d")).toBe(VISIBLE_CANDLES + 250);
  });
});

describe("buildOverlays", () => {
  it("ignores the forming candle and keeps the current candle out of the channel", () => {
    const candles = makeCandles(sawtooth(260), { timeframe: "1h", lastOpen: true });
    const o = buildOverlays(candles, 48);
    const closed = candles.slice(0, -1);
    expect(o.ema50.at(-1)!.time).toBe(chartTime(closed.at(-1)!.openTime));
    expect(o.ema200).toHaveLength(closed.length - 199);
    const i = closed.length - 1;
    expect(o.donchianHigh.at(-1)!.value).toBe(Math.max(...closed.slice(i - 48, i).map((c) => c.high)));
    expect(o.donchianHigh).toHaveLength(closed.length - 48);
  });
});

describe("marketSummary", () => {
  it("reports last price, 24h change on closed candles, ATR and the cost of a 2·ATR stop in R", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
    const candles = makeCandles(closes, { timeframe: "1h", lastOpen: true });
    const s = marketSummary(candles, { feeRate: 0.001, slippage: 0.0002 })!;
    expect(s.last.isClosed).toBe(false);
    expect(s.lastClosed!.close).toBe(138);
    expect(s.change24h).toBeCloseTo(138 / 114 - 1);
    expect(s.atrPct).toBeCloseTo(s.atr14! / 138);
    expect(s.costR).toBeCloseTo(0.0024 / (2 * s.atrPct!));
  });

  it("returns null for no data", () => {
    expect(marketSummary([])).toBeNull();
  });
});

describe("signalMarkers", () => {
  const signal = (direction: "long" | "short"): TradingSignal => ({
    id: direction, strategyId: "s", strategyVersion: "0", source: FIXTURE_SOURCE, symbol: "TEST/USDT", timeframe: "1h",
    createdAt: 10 * H, basisCloseTime: 10 * H, direction, entry: { type: "next-open", referencePrice: 100 },
    stopLoss: direction === "long" ? 98 : 102, takeProfits: [direction === "long" ? 106 : 94], expiresAt: 20 * H, features: {}, rule: "t",
  });
  const outcome: SignalOutcome = { signalId: "long", status: "target", exitTime: 14 * H, rMultiple: 2.9, evaluatedAt: 0, evaluatorVersion: "1" };

  it("puts the entry on the basis candle and the exit on the exit candle", () => {
    const m = signalMarkers([{ signal: signal("long"), outcome }], "1h");
    expect(m).toEqual([
      { time: chartTime(9 * H), position: "belowBar", shape: "arrowUp", kind: "long", text: "L" },
      { time: chartTime(13 * H), position: "aboveBar", shape: "circle", kind: "win", text: "+2.9R" },
    ]);
  });

  it("skips signals of another timeframe and open signals have no exit marker", () => {
    expect(signalMarkers([{ signal: signal("short") }], "1h")).toHaveLength(1);
    expect(signalMarkers([{ signal: signal("short") }], "15m")).toEqual([]);
  });
});

describe("replayOnCandles", () => {
  it("reports insufficient warmup instead of an empty result", async () => {
    const { replayOnCandles } = await import("./model");
    const r = replayOnCandles("donchian-breakout", makeCandles(sawtooth(300), { timeframe: "1h" }));
    expect(r.insufficient).toEqual({ need: 1001, have: 300 });
    expect(r.trades).toEqual([]);
  });
});
