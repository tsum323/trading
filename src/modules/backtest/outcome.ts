import { alignToTimeframe, TIMEFRAME_MS, type UnixMs } from "@/core/time";
import type { Candle } from "@/modules/market-data";
import { lossPerUnit } from "@/modules/risk";
import type { TradingSignal } from "@/modules/strategies";
import { closedCandlesAsOf } from "./closed-candles";

/** Меняется при любом изменении логики оценки; старые исходы тогда пересчитываются. */
export const EVALUATOR_VERSION = "1";

export type OutcomeStatus = "target" | "stop" | "expired" | "ambiguous" | "no-entry" | "data-gap";

export type NoEntryReason = "entry-candle-missing" | "entry-beyond-stop" | "entry-beyond-target" | "expiry-before-entry-close";

export interface SignalOutcome {
  signalId: string;
  status: OutcomeStatus;
  reason?: NoEntryReason;
  /** openTime свечи входа (= basisCloseTime). */
  entryTime?: UnixMs;
  /** Цена входа с проскальзыванием. */
  entryPrice?: number;
  /** closeTime свечи выхода: момент, когда исход стал известен. */
  exitTime?: UnixMs;
  exitPrice?: number;
  /** Результат в R после комиссий и проскальзывания; 1R = убыток при выходе ровно по стопу с комиссиями. */
  rMultiple?: number;
  /** Максимальное благоприятное движение от входа, в R (>= 0). */
  mfeR?: number;
  /** Максимальное неблагоприятное движение от входа, в R (<= 0). */
  maeR?: number;
  evaluatedAt: UnixMs;
  evaluatorVersion: string;
}

export type Evaluation = { status: "pending" } | SignalOutcome;

export interface ExecutionCosts {
  /** Комиссия за сторону, доля объёма. */
  feeRate: number;
  /** Проскальзывание рыночных исполнений (вход, стоп, истечение), доля цены. */
  slippage: number;
}

/** Издержки из docs/strategy-spec.md §5. */
export const DEFAULT_COSTS: ExecutionCosts = { feeRate: 0.001, slippage: 0.0002 };

/**
 * Гипотетический исход сигнала по правилам docs/validation-plan.md §3.
 *
 * - Вход: open свечи с openTime = basisCloseTime (рыночный, с проскальзыванием).
 *   Свечи до неё не читаются.
 * - Свеча входа проверяется на стоп/цель целиком: вход по open предшествует остальной свече.
 * - Гэп через стоп: выход по open (хуже стопа). Гэп через цель: выход по цели
 *   (консервативно, лимитная заявка).
 * - Стоп и цель в одной свече: «ambiguous», считается как стоп.
 * - В окно входят свечи с closeTime <= expiresAt; без исхода — выход по close
 *   последней из них («expired»).
 * - Пропуск в данных во время сделки: «data-gap» без результата.
 * - Цель — первая из takeProfits.
 *
 * `asOf` — момент, до которого данные гарантированно загружены (не просто
 * текущее время): учитываются только свечи, закрытые к нему, а отсутствующая
 * свеча до `asOf` считается пропуском. Пока исход не определён и окно не
 * закончилось, возвращается { status: "pending" }.
 */
export function evaluateSignal(
  signal: TradingSignal,
  candles: readonly Candle[],
  asOf: UnixMs,
  costs: ExecutionCosts = DEFAULT_COSTS,
): Evaluation {
  const { direction, stopLoss: stop, expiresAt } = signal;
  const target = signal.takeProfits[0];
  if (target === undefined) throw new RangeError(`${signal.id}: no take-profit`);
  const size = TIMEFRAME_MS[signal.timeframe];
  const entryOpen = signal.basisCloseTime;
  const base = { signalId: signal.id, evaluatedAt: asOf, evaluatorVersion: EVALUATOR_VERSION };

  // Последняя свеча окна закрывается в lastClose <= expiresAt.
  const lastClose = alignToTimeframe(expiresAt, signal.timeframe);
  if (lastClose < entryOpen + size) return { ...base, status: "no-entry", reason: "expiry-before-entry-close" };

  const byOpen = new Map<UnixMs, Candle>();
  for (const c of closedCandlesAsOf(candles, Math.min(asOf, lastClose))) {
    if (c.openTime >= entryOpen && c.symbol === signal.symbol && c.timeframe === signal.timeframe && c.source === signal.source) {
      byOpen.set(c.openTime, c);
    }
  }

  const sign = direction === "long" ? 1 : -1;
  const slip = (price: number, side: "buy" | "sell") => price * (side === "buy" ? 1 + costs.slippage : 1 - costs.slippage);
  const entrySide = direction === "long" ? "buy" : "sell";
  const exitSide = direction === "long" ? "sell" : "buy";

  let entryPrice = 0;
  let unit = 0;
  let best = 0;
  let worst = 0;

  const finish = (status: OutcomeStatus, exitTime: UnixMs, exitPrice: number): SignalOutcome => {
    const pnl = sign * (exitPrice - entryPrice) - costs.feeRate * (entryPrice + exitPrice);
    return {
      ...base,
      status,
      entryTime: entryOpen,
      entryPrice,
      exitTime,
      exitPrice,
      rMultiple: pnl / unit,
      mfeR: (sign * (best - entryPrice)) / unit,
      maeR: (sign * (worst - entryPrice)) / unit,
    };
  };

  let last: Candle | undefined;
  for (let t = entryOpen; t + size <= lastClose; t += size) {
    const c = byOpen.get(t);
    if (!c) {
      if (t + size > asOf) return { status: "pending" };
      if (t === entryOpen) return { ...base, status: "no-entry", reason: "entry-candle-missing" };
      return { ...base, status: "data-gap", entryTime: entryOpen, entryPrice };
    }

    if (t === entryOpen) {
      entryPrice = slip(c.open, entrySide);
      if (sign * (entryPrice - stop) <= 0) return { ...base, status: "no-entry", reason: "entry-beyond-stop" };
      if (sign * (target - entryPrice) <= 0) return { ...base, status: "no-entry", reason: "entry-beyond-target" };
      unit = lossPerUnit(direction, entryPrice, stop, costs.feeRate);
      best = worst = entryPrice;
    } else {
      // Гэп на открытии свечи.
      if (sign * (c.open - stop) <= 0) {
        worst = sign > 0 ? Math.min(worst, c.open) : Math.max(worst, c.open);
        return finish("stop", c.closeTime, slip(c.open, exitSide));
      }
      if (sign * (c.open - target) >= 0) {
        best = sign > 0 ? Math.max(best, c.open) : Math.min(best, c.open);
        return finish("target", c.closeTime, target);
      }
    }

    const favorable = sign > 0 ? c.high : c.low;
    const adverse = sign > 0 ? c.low : c.high;
    const stopHit = sign * (adverse - stop) <= 0;
    const targetHit = sign * (favorable - target) >= 0;

    // Движение за уровнем выхода позиция уже не переживает.
    const reachedFavorable = targetHit ? target : favorable;
    const reachedAdverse = stopHit ? stop : adverse;
    best = sign > 0 ? Math.max(best, reachedFavorable) : Math.min(best, reachedFavorable);
    worst = sign > 0 ? Math.min(worst, reachedAdverse) : Math.max(worst, reachedAdverse);

    if (stopHit && targetHit) return finish("ambiguous", c.closeTime, slip(stop, exitSide));
    if (stopHit) return finish("stop", c.closeTime, slip(stop, exitSide));
    if (targetHit) return finish("target", c.closeTime, target);
    last = c;
  }

  return finish("expired", last!.closeTime, slip(last!.close, exitSide));
}
