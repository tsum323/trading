import type { UnixMs } from "@/core/time";
import type { MarketSymbol } from "@/modules/market-data";
import type { SignalDirection } from "@/modules/strategies";
import { INITIAL_EQUITY, RISK_PER_TRADE } from "./roster";
import type { RiskStatus } from "./types";

/**
 * Защита капитала и адаптация персонажа (docs/personas.md §«Цель»).
 * Всё считается только по сделкам, исход которых известен к моменту решения.
 */
export const RISK_RULES = {
  baseRisk: RISK_PER_TRADE,
  /** Просадка от максимума счёта → риск на сделку. */
  drawdownSteps: [
    { drawdown: -0.2, risk: 0.0025 },
    { drawdown: -0.1, risk: 0.005 },
  ],
  /** Убыток за последние 24 часа, после которого новые сделки не открываются. */
  dailyLossLimit: -0.03,
  /** Просадка, при пересечении которой торговля останавливается на pauseMs. */
  pauseDrawdown: -0.3,
  pauseMs: 7 * 24 * 3_600_000,
  /** Суммарный риск открытых позиций не больше этой доли капитала. */
  maxOpenRisk: 0.03,
  /** Адаптация: последние N закрытых сделок по монете и направлению. */
  adaptWindow: 5,
  adaptMinTrades: 3,
  /** Множитель риска, если по монете и направлению последние сделки в минусе. */
  coolingFactor: 0.25,
  /** Сделка стоит входа: до цели хотя бы в 1,5 раза дальше, чем до стопа… */
  minRewardRisk: 1.5,
  /** …и издержки входа и выхода съедают не больше трети ожидаемой прибыли. */
  maxCostShare: 1 / 3,
} as const;

const DAY = 24 * 3_600_000;

export interface ClosedTrade {
  symbol: MarketSymbol;
  direction: SignalDirection;
  exitTime: UnixMs;
  pnlUsd: number;
  r: number;
}


export interface RiskState {
  equity: number;
  peak: number;
  drawdown: number;
  status: RiskStatus;
  /** Риск на сделку с учётом просадки (до охлаждения и лимита открытого риска). */
  riskFraction: number;
  pausedUntil: UnixMs | null;
  /** Убыток за 24 часа как доля капитала в начале окна. */
  dayPnlPct: number;
}

/** Состояние счёта в момент t: закрытые к t сделки, просадка, дневной стоп, пауза. */
export function riskState(closed: readonly ClosedTrade[], t: UnixMs): RiskState {
  const known = closed.filter((c) => c.exitTime <= t).sort((a, b) => a.exitTime - b.exitTime);
  let equity = INITIAL_EQUITY;
  let peak = INITIAL_EQUITY;
  let pausedUntil: UnixMs | null = null;
  for (const c of known) {
    const before = equity / peak - 1;
    equity += c.pnlUsd;
    peak = Math.max(peak, equity);
    const after = equity / peak - 1;
    // Пауза — при пересечении порога вниз; снова сработает, только если счёт поднимется выше порога.
    if (before > RISK_RULES.pauseDrawdown && after <= RISK_RULES.pauseDrawdown) pausedUntil = c.exitTime + RISK_RULES.pauseMs;
  }
  const drawdown = equity / peak - 1;
  const dayLoss = known.filter((c) => c.exitTime > t - DAY).reduce((s, c) => s + c.pnlUsd, 0);
  const dayPnlPct = dayLoss / (equity - dayLoss);
  const step = RISK_RULES.drawdownSteps.find((s) => drawdown <= s.drawdown);
  const riskFraction = step?.risk ?? RISK_RULES.baseRisk;
  const paused = pausedUntil !== null && t < pausedUntil;
  const status: RiskStatus = paused
    ? "paused"
    : dayPnlPct <= RISK_RULES.dailyLossLimit
      ? "daily-stop"
      : step === RISK_RULES.drawdownSteps[0]
        ? "defensive"
        : step
          ? "cautious"
          : "normal";
  return { equity, peak, drawdown, status, riskFraction, pausedUntil: paused ? pausedUntil : null, dayPnlPct };
}

/** Сумма R последних сделок по монете и направлению; null — сделок мало для вывода. */
export function recentBucketR(closed: readonly ClosedTrade[], t: UnixMs, symbol: MarketSymbol, direction: SignalDirection): number | null {
  const bucket = closed
    .filter((c) => c.exitTime <= t && c.symbol === symbol && c.direction === direction)
    .sort((a, b) => a.exitTime - b.exitTime)
    .slice(-RISK_RULES.adaptWindow);
  return bucket.length < RISK_RULES.adaptMinTrades ? null : bucket.reduce((s, c) => s + c.r, 0);
}

export type SkipReason = "paused" | "daily-stop" | "risk-cap" | "not-worth";

/**
 * Выгодна ли сделка до входа: отношение пути до цели к пути до стопа и доля
 * издержек (комиссия и проскальзывание на входе и выходе) в прибыли по цели.
 */
export function tradeEdge(
  signal: { direction: SignalDirection; entry: { referencePrice: number }; stopLoss: number; takeProfits: readonly number[] },
  costs: { feeRate: number; slippage: number },
): { rewardRisk: number; costShare: number; worth: boolean } {
  const ref = signal.entry.referencePrice;
  const target = signal.takeProfits[0]!;
  const reward = Math.abs(target - ref);
  const risk = Math.abs(ref - signal.stopLoss);
  const cost = (costs.feeRate + costs.slippage) * ref + costs.feeRate * target;
  const rewardRisk = risk > 0 ? reward / risk : 0;
  const costShare = reward > 0 ? cost / reward : Number.POSITIVE_INFINITY;
  return { rewardRisk, costShare, worth: rewardRisk >= RISK_RULES.minRewardRisk && costShare <= RISK_RULES.maxCostShare };
}

export type RiskDecision =
  | { skip: SkipReason; state: RiskState }
  | { skip: null; state: RiskState; riskUsd: number; riskFraction: number; notes: string[] };

/**
 * Сколько рисковать в новой сделке.
 * @param openRiskUsd риск уже открытых позиций (по стопам)
 * @param adaptive учитывать ли собственные недавние результаты по монете и направлению
 */
export function decideRisk(opts: {
  closed: readonly ClosedTrade[];
  t: UnixMs;
  symbol: MarketSymbol;
  direction: SignalDirection;
  openRiskUsd: number;
  adaptive: boolean;
}): RiskDecision {
  const state = riskState(opts.closed, opts.t);
  if (state.status === "paused" || state.status === "daily-stop") return { skip: state.status, state };

  const notes: string[] = [];
  let risk = state.riskFraction;
  if (risk < RISK_RULES.baseRisk) notes.push(`просадка ${(state.drawdown * 100).toFixed(1)}% → риск ${(risk * 100).toFixed(2)}%`);
  if (opts.adaptive) {
    const r = recentBucketR(opts.closed, opts.t, opts.symbol, opts.direction);
    if (r !== null && r < 0) {
      risk *= RISK_RULES.coolingFactor;
      notes.push(`охлаждение: последние сделки ${opts.symbol.split("/")[0]} ${opts.direction} ${r.toFixed(1)}R`);
    }
  }
  const wanted = risk * state.equity;
  const available = RISK_RULES.maxOpenRisk * state.equity - opts.openRiskUsd;
  // Меньше четверти желаемого риска — сделка не стоит издержек.
  if (available < wanted * 0.25) return { skip: "risk-cap", state };
  if (available < wanted) notes.push("урезано лимитом открытого риска 3%");
  const riskUsd = Math.min(wanted, available);
  return { skip: null, state, riskUsd, riskFraction: riskUsd / state.equity, notes };
}
