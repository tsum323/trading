import { describe, expect, it } from "vitest";
import { TIMEFRAME_MS } from "@/core/time";
import { replaySignals } from "@/modules/backtest";
import { factorAvailableAt, type FactorRow } from "@/modules/derivatives";
import type { Candle } from "@/modules/market-data";
import { FIXTURE_SOURCE } from "@/test/fixtures";
import type { Strategy } from "../types";
import { crowdingFeatures } from "./features";
import { withOiFilter } from "./oi-filter";
import { crowding } from "./strategy";

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.UTC(2025, 0, 1);
const DAYS = 140;

/**
 * СИНТЕТИЧЕСКИЕ факторы: премия около нуля, на 120-й день — резкий рост премии и
 * интереса (перегрев лонгов). Не рыночные данные.
 */
function factorRows(spikeDay = 120): FactorRow[] {
  const out: FactorRow[] = [];
  for (let h = 0; h < DAYS * 24; h++) {
    const day = Math.floor(h / 24);
    const hot = day >= spikeDay && day < spikeDay + 3;
    out.push({
      openTime: T0 + h * H,
      oiUsd: 1e9 * (1 + (hot ? 0.02 * (h - spikeDay * 24) / 24 : 0)),
      topLongShort: 1,
      longShort: 1,
      takerRatio: 1,
      premium: hot ? 0.001 : 0.00005 * Math.sin(day),
    });
  }
  return out;
}

function candles4h(): Candle[] {
  const size = TIMEFRAME_MS["4h"];
  return Array.from({ length: DAYS * 6 }, (_, i) => {
    const close = 100 + Math.sin(i / 5);
    const open = 100 + Math.sin((i - 1) / 5);
    return {
      source: FIXTURE_SOURCE, symbol: "TEST/USDT", timeframe: "4h", openTime: T0 + i * size, closeTime: T0 + (i + 1) * size,
      open, close, high: Math.max(open, close) + 0.5, low: Math.min(open, close) - 0.5, volume: 1, isClosed: true,
    };
  });
}

describe("crowding features", () => {
  it("use only published factors", () => {
    const rows = factorRows();
    const spikeEnd = T0 + 123 * D;
    // До публикации дней перегрева признаки их не видят.
    const before = crowdingFeatures(rows, factorAvailableAt(T0 + 120 * D) - 1)!;
    expect(before.premiumPct).toBeLessThan(0.9);
    const after = crowdingFeatures(rows, factorAvailableAt(spikeEnd - H))!;
    expect(after.premiumPct).toBe(1);
    expect(after.oiChange3d).toBeGreaterThan(0.03);
  });

  it("need 90 days of history and fresh data", () => {
    expect(crowdingFeatures(factorRows(), T0 + 60 * D)).toBeNull();
    expect(crowdingFeatures(factorRows(), T0 + (DAYS + 10) * D)).toBeNull();
  });
});

describe("crowding strategy", () => {
  it("shorts a new long-crowding event once, after the data is published", () => {
    const factors = new Map([["TEST/USDT", factorRows()]]);
    const signals = replaySignals(crowding(factors), candles4h());
    expect(signals.length).toBe(1);
    const s = signals[0]!;
    expect(s.direction).toBe("short");
    // Решение — не раньше публикации часа, на котором основан признак.
    expect(s.createdAt).toBeGreaterThanOrEqual(factorAvailableAt(s.features.factor_hour!));
    expect(s.takeProfits[0]).toBeCloseTo(s.entry.referencePrice - 2 * (s.stopLoss - s.entry.referencePrice), 9);
  });

  it("gives no signals without factors", () => {
    expect(replaySignals(crowding(), candles4h())).toEqual([]);
  });
});

describe("open-interest filter", () => {
  const every: Strategy = {
    id: "test", version: "0", timeframe: "4h", warmup: 1, lookback: 2,
    evaluate(ctx) {
      const c = ctx.candles.at(-1)!;
      return { basisCloseTime: c.closeTime, direction: "long", entry: { type: "next-open", referencePrice: c.close }, stopLoss: c.close - 1, takeProfits: [c.close + 3], expiresAt: c.closeTime + 4 * H, features: {}, rule: "test" };
    },
  };

  it("passes only signals with 7-day open-interest growth and marks the version", () => {
    const factors = new Map([["TEST/USDT", factorRows()]]);
    const f = withOiFilter(every, factors);
    expect(f.version).toBe("0+oi7d");
    expect(f.id).toBe("test-oi");
    const signals = replaySignals(f, candles4h());
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.features.oi_change_7d! > 0)).toBe(true);
  });
});
