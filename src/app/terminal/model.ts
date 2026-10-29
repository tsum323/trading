import { TIMEFRAME_MS, type Timeframe, type UnixMs } from "@/core/time";
import { DEFAULT_COSTS, runBacktest, type SignalOutcome, type Trade } from "@/modules/backtest";
import { atr, ema } from "@/modules/indicators";
import type { Candle } from "@/modules/market-data";
import { FACTOR_STRATEGY_IDS, getStrategy, STRATEGY_IDS } from "@/modules/strategies/registry";
import type { Strategy, TradingSignal } from "@/modules/strategies";

export const TERMINAL_SYMBOLS = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT"] as const;
export const TERMINAL_TIMEFRAMES: readonly Timeframe[] = ["15m", "1h", "4h", "1d"];
/** Сколько свечей видно на графике; сверх этого загружается прогрев индикаторов и стратегий. */
export const VISIBLE_CANDLES = 500;
export const MAX_CANDLES = 5000;
const INDICATOR_WARMUP = 250;

/**
 * Стратегии, работающие на этом таймфрейме, с ключами реестра. Ключ, а не id:
 * несколько записей реестра делят один id (donchian-breakout 1h и 4h).
 */
export function strategiesFor(tf: Timeframe): { key: string; strategy: Strategy }[] {
  // Стратегиям на факторах фьючерсов нужен архив факторов — в реплее терминала их нет.
  return STRATEGY_IDS.filter((key) => !FACTOR_STRATEGY_IDS.has(key))
    .map((key) => ({ key, strategy: getStrategy(key) }))
    .filter((e) => e.strategy.timeframe === tf);
}

/** Сколько свечей грузить: видимая часть + прогрев самой «длинной» стратегии или индикатора. */
export function candleCount(tf: Timeframe): number {
  const warmup = Math.max(INDICATOR_WARMUP, ...strategiesFor(tf).map((e) => e.strategy.lookback));
  return Math.min(MAX_CANDLES, VISIBLE_CANDLES + warmup);
}

/** Время для графика: секунды UTC, бар помечается временем открытия. */
export const chartTime = (ms: UnixMs) => Math.floor(ms / 1000);

export type LinePoint = { time: number; value: number };

function toLine(candles: readonly Candle[], values: readonly (number | null)[]): LinePoint[] {
  const out: LinePoint[] = [];
  values.forEach((v, i) => {
    if (v != null) out.push({ time: chartTime(candles[i]!.openTime), value: v });
  });
  return out;
}

export interface Overlays {
  ema50: LinePoint[];
  ema200: LinePoint[];
  /** Канал Дончиана по 48 предыдущим свечам (текущая не входит), как в donchian-breakout. */
  donchianHigh: LinePoint[];
  donchianLow: LinePoint[];
}

/** Индикаторы считаются только по закрытым свечам — формирующаяся свеча их не двигает. */
export function buildOverlays(candles: readonly Candle[], channel = 48): Overlays {
  const closed = candles.filter((c) => c.isClosed);
  const high: (number | null)[] = closed.map((_, i) => (i < channel ? null : Math.max(...closed.slice(i - channel, i).map((c) => c.high))));
  const low: (number | null)[] = closed.map((_, i) => (i < channel ? null : Math.min(...closed.slice(i - channel, i).map((c) => c.low))));
  return {
    ema50: toLine(closed, ema(50).compute(closed)),
    ema200: toLine(closed, ema(200).compute(closed)),
    donchianHigh: toLine(closed, high),
    donchianLow: toLine(closed, low),
  };
}

export interface MarketSummary {
  last: Candle;
  lastClosed: Candle | null;
  /** Изменение close последней закрытой свечи за 24 часа, доля. */
  change24h: number | null;
  atr14: number | null;
  atrPct: number | null;
  /** Сколько R стоят издержки сделки со стопом 2 × ATR(14) по умолчанию. */
  costR: number | null;
}

export function marketSummary(candles: readonly Candle[], costs = DEFAULT_COSTS): MarketSummary | null {
  const last = candles.at(-1);
  if (!last) return null;
  const closed = candles.filter((c) => c.isClosed);
  const lastClosed = closed.at(-1) ?? null;
  const dayAgo = lastClosed ? closed.find((c) => c.closeTime === lastClosed.closeTime - 86_400_000) : undefined;
  const atr14 = atr(14).compute(closed).at(-1) ?? null;
  const atrPct = atr14 != null && lastClosed ? atr14 / lastClosed.close : null;
  const roundTrip = 2 * (costs.feeRate + costs.slippage);
  return {
    last,
    lastClosed,
    change24h: dayAgo && lastClosed ? lastClosed.close / dayAgo.close - 1 : null,
    atr14,
    atrPct,
    costR: atrPct ? roundTrip / (2 * atrPct) : null,
  };
}

export type MarkerKind = "long" | "short" | "win" | "loss" | "flat";

export interface ChartMarker {
  time: number;
  position: "aboveBar" | "belowBar";
  shape: "arrowUp" | "arrowDown" | "circle";
  kind: MarkerKind;
  text: string;
}

function outcomeKind(o: SignalOutcome): MarkerKind {
  if (o.rMultiple === undefined) return "flat";
  return o.rMultiple > 0 ? "win" : o.rMultiple < 0 ? "loss" : "flat";
}

/** Отметки входа (на опорной свече) и выхода (на свече выхода) для пар сигнал/исход. */
export function signalMarkers(
  items: readonly { signal: TradingSignal; outcome?: SignalOutcome | undefined }[],
  timeframe: Timeframe,
  label = "",
): ChartMarker[] {
  const size = TIMEFRAME_MS[timeframe];
  const markers: ChartMarker[] = [];
  for (const { signal, outcome } of items) {
    if (signal.timeframe !== timeframe) continue;
    const long = signal.direction === "long";
    markers.push({
      time: chartTime(signal.basisCloseTime - size),
      position: long ? "belowBar" : "aboveBar",
      shape: long ? "arrowUp" : "arrowDown",
      kind: long ? "long" : "short",
      text: `${label}${long ? "L" : "S"}`,
    });
    if (outcome?.exitTime !== undefined && outcome.rMultiple !== undefined) {
      markers.push({
        time: chartTime(outcome.exitTime - size),
        position: long ? "aboveBar" : "belowBar",
        shape: "circle",
        kind: outcomeKind(outcome),
        text: `${outcome.rMultiple >= 0 ? "+" : ""}${outcome.rMultiple.toFixed(1)}R`,
      });
    }
  }
  return markers.sort((a, b) => a.time - b.time);
}

export interface ReplayResult {
  strategy: Strategy;
  trades: Trade[];
  pending: number;
  expectancyR: number | null;
  /** Закрытых свечей меньше, чем нужно стратегии для прогрева плюс видимая часть. */
  insufficient: { need: number; have: number } | null;
}

/**
 * Реплей стратегии на загруженных свечах — для визуальной проверки правил.
 * Это не новый прогон исследования и не проверка гипотезы: окно короткое,
 * а журнал исследований не пополняется.
 */
export function replayOnCandles(registryKey: string, candles: readonly Candle[]): ReplayResult {
  const strategy = getStrategy(registryKey);
  const have = candles.filter((c) => c.isClosed).length;
  if (have <= strategy.lookback) {
    return { strategy, trades: [], pending: 0, expectancyR: null, insufficient: { need: strategy.lookback + 1, have } };
  }
  const firstVisible = candles.length > VISIBLE_CANDLES ? candles[candles.length - VISIBLE_CANDLES]!.openTime : undefined;
  const result = runBacktest(strategy, candles, firstVisible === undefined ? {} : { from: firstVisible });
  const rs = result.trades.map((t) => t.outcome.rMultiple).filter((r): r is number => r !== undefined);
  return {
    strategy,
    trades: result.trades,
    pending: result.pending,
    expectancyR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    insufficient: null,
  };
}
