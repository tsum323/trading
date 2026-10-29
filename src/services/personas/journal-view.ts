import type { PersonaEntry, PersonaExit } from "./signal-trader";
import type { PersonaTrade } from "./types";

/** Закрытая сделка из журналов персонажа — так же в сводке и в браузере (полная история). */
export function closedTrade(e: PersonaEntry, x: PersonaExit): PersonaTrade {
  const s = e.signal;
  return {
    symbol: s.symbol, direction: s.direction, decidedAt: s.createdAt, entryTime: s.basisCloseTime,
    stop: s.stopLoss, target: s.takeProfits[0]!, expiresAt: s.expiresAt, qty: e.qty, riskUsd: e.riskUsd,
    riskFraction: e.riskFraction ?? e.riskUsd / e.equityAtEntry, notes: e.notes ?? [], mode: e.mode,
    state: x.status, entryPrice: x.entryPrice ?? null, exitTime: x.exitTime ?? null, exitPrice: x.exitPrice ?? null,
    pnlUsd: x.pnlUsd, r: x.rMultiple ?? null,
  };
}

/** Все закрытые сделки с результатом, новые первыми. */
export function closedTrades(entries: readonly PersonaEntry[], exits: readonly PersonaExit[]): PersonaTrade[] {
  const byId = new Map(exits.map((x) => [x.signalId, x]));
  return entries
    .flatMap((e) => {
      const x = byId.get(e.signal.id);
      return x ? [closedTrade(e, x)] : [];
    })
    .filter((t) => t.exitTime !== null && t.state !== "no-entry" && t.state !== "data-gap")
    .reverse();
}
