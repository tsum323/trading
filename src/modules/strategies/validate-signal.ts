import type { TradingSignal } from "./types";

export type SignalIssue =
  | "basis-after-decision"
  | "expires-before-created"
  | "non-finite-price"
  | "stop-on-wrong-side"
  | "target-on-wrong-side"
  | "no-targets";

export function validateSignal(s: TradingSignal): SignalIssue[] {
  const issues: SignalIssue[] = [];
  const entry = s.entry.referencePrice;
  const prices = [entry, s.stopLoss, ...s.takeProfits];

  if (s.basisCloseTime > s.createdAt) issues.push("basis-after-decision");
  if (s.expiresAt <= s.createdAt) issues.push("expires-before-created");
  if (!prices.every((p) => Number.isFinite(p) && p > 0)) issues.push("non-finite-price");
  if (s.takeProfits.length === 0) issues.push("no-targets");

  const sign = s.direction === "long" ? 1 : -1;
  if (sign * (entry - s.stopLoss) <= 0) issues.push("stop-on-wrong-side");
  if (s.takeProfits.some((tp) => sign * (tp - entry) <= 0)) issues.push("target-on-wrong-side");

  return issues;
}
