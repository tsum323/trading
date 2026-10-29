import type { Timeframe, UnixMs } from "@/core/time";
import type { OutcomeStatus } from "@/modules/backtest";
import type { MarketSymbol } from "@/modules/market-data";
import type { SignalDirection } from "@/modules/strategies";

/**
 * Как сделка попала в журнал:
 * - replay — решение принято до запуска персонажа (догоняющий реплей истории);
 * - live — записано вовремя, в течение одной свечи после решения;
 * - late — записано с опозданием (например, задержка планировщика).
 * Все режимы строго каузальны; различие — в том, когда запись сделана.
 */
export type TradeMode = "replay" | "live" | "late";

export type TradeState = OutcomeStatus | "open" | "waiting-entry";

export interface PersonaTrade {
  symbol: MarketSymbol;
  direction: SignalDirection;
  decidedAt: UnixMs;
  entryTime: UnixMs;
  /** Цена входа с проскальзыванием; null — свеча входа ещё не закрылась. */
  entryPrice: number | null;
  stop: number;
  target: number;
  expiresAt: UnixMs;
  qty: number;
  riskUsd: number;
  /** Доля капитала под риском в этой сделке. */
  riskFraction: number;
  /** Почему риск отличается от обычного (просадка, охлаждение, лимиты). */
  notes: string[];
  state: TradeState;
  exitTime: UnixMs | null;
  exitPrice: number | null;
  /** Реализованный результат (закрытые) или текущий нереализованный (открытые), $. */
  pnlUsd: number | null;
  r: number | null;
  mode: TradeMode;
}

export interface PersonaHolding {
  symbol: MarketSymbol;
  qty: number;
  price: number;
  value: number;
}

export interface PersonaRebalanceView {
  at: UnixMs;
  weights: Record<MarketSymbol, number>;
  costUsd: number;
  note: string;
  mode: TradeMode;
}

export type RiskStatus = "normal" | "cautious" | "defensive" | "daily-stop" | "paused";

export interface PersonaRiskView {
  status: RiskStatus;
  /** Риск на следующую сделку по просадке (без охлаждения). */
  riskFraction: number;
  /** Просадка реализованного капитала от максимума. */
  drawdownPct: number;
  pausedUntil: UnixMs | null;
  dayPnlPct: number;
  /** Монеты и направления на охлаждении, например «SOL short». */
  cooling: string[];
  /** Сигналов пропущено ради защиты капитала. */
  skipped: number;
}

export interface PersonaAllocation {
  personaId: string;
  value: number;
}

export interface PersonaSummary {
  id: string;
  name: string;
  emoji: string;
  tagline: string;
  rules: string[];
  kind: "signals" | "portfolio" | "manager";
  timeframe: Timeframe;
  symbols: MarketSymbol[];
  /** Ключ стратегии в реестре (для персонажей на сигналах). */
  strategyKey: string | null;
  strategyVersion: string | null;
  launchedAt: UnixMs | null;
  equity: number;
  returnPct: number;
  maxDrawdownPct: number;
  closedTrades: number;
  wins: number;
  losses: number;
  /** Закрытых сделок, записанных вовремя (без реплея и опозданий). */
  liveClosedTrades: number;
  /** Точки кривой капитала [время, $]. */
  curve: [UnixMs, number][];
  open: PersonaTrade[];
  history: PersonaTrade[];
  holdings: PersonaHolding[];
  cash: number | null;
  /** Ключи weights — символы (портфели) или id персонажей (Управляющий). */
  rebalances: PersonaRebalanceView[];
  /** Состояние защиты капитала (персонажи на сигналах). */
  risk: PersonaRiskView | null;
  /** Деньги Управляющего у персонажей. */
  allocations: PersonaAllocation[];
}

export type FeedEvent =
  | { t: UnixMs; personaId: string; kind: "open"; symbol: MarketSymbol; direction: SignalDirection; price: number | null; stop: number; target: number; mode: TradeMode }
  | { t: UnixMs; personaId: string; kind: "close"; symbol: MarketSymbol; direction: SignalDirection; state: TradeState; price: number | null; pnlUsd: number; r: number | null; mode: TradeMode }
  | { t: UnixMs; personaId: string; kind: "rebalance"; weights: Record<MarketSymbol, number>; note: string; mode: TradeMode }
  | { t: UnixMs; personaId: string; kind: "skip"; symbol: MarketSymbol; direction: SignalDirection; reason: "paused" | "daily-stop" | "risk-cap"; drawdown: number; mode: TradeMode };

export interface PersonasSnapshot {
  generatedAt: UnixMs;
  startedAt: UnixMs;
  initialEquity: number;
  riskPerTrade: number;
  maxPositionShare: number;
  costs: { feeRate: number; slippage: number };
  codeCommit: string | null;
  /** Последняя закрытая часовая свеча по символу. */
  prices: Record<MarketSymbol, { price: number; time: UnixMs }>;
  personas: PersonaSummary[];
  feed: FeedEvent[];
}

export const PERSONAS_STATE_PATH = "personas/state.json";
