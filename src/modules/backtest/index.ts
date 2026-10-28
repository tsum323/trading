export { closedCandlesAsOf } from "./closed-candles";
export { replaySignals, LookaheadError } from "./replay";
export {
  evaluateSignal,
  DEFAULT_COSTS,
  EVALUATOR_VERSION,
  type Evaluation,
  type ExecutionCosts,
  type NoEntryReason,
  type OutcomeStatus,
  type SignalOutcome,
} from "./outcome";
export { runBacktest, windowBars, type BacktestOptions, type BacktestResult, type Trade } from "./run";
export { summarize, type TradeStats } from "./stats";
export { randomBaseline, combineBaselines, type BaselineResult } from "./baseline";
export { judge, MIN_TRADES, MAX_TOP_MONTH_SHARE, MAX_TOP_SYMBOL_SHARE, type Verdict, type VerdictReport } from "./verdict";
