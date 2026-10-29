import type { PersonasSnapshot, PersonaSummary, PersonaTrade } from "@/services/personas/types";

/**
 * Живая оценка между циклами: сводка обновляется раз в 15 минут, а цены Binance
 * браузер берёт каждые 30 с. Пересчитывается только стоимость открытых позиций
 * и портфелей; новые сделки, стопы и цели исполняет следующий цикл.
 */
export type LivePrices = Record<string, number>;

const BINANCE_URL = "https://data-api.binance.vision";

export async function fetchLivePrices(symbols: readonly string[], signal?: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<LivePrices> {
  const base = process.env.NEXT_PUBLIC_BINANCE_BASE_URL || BINANCE_URL;
  const ids = symbols.map((s) => s.replace("/", ""));
  const res = await fetchImpl(`${base}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(ids))}`, signal ? { signal } : {});
  if (!res.ok) throw new Error(`GET /api/v3/ticker/price → HTTP ${res.status}`);
  const rows = (await res.json()) as { symbol: string; price: string }[];
  const out: LivePrices = {};
  for (const s of symbols) {
    const row = rows.find((r) => r.symbol === s.replace("/", ""));
    const price = row ? Number(row.price) : Number.NaN;
    if (Number.isFinite(price) && price > 0) out[s] = price;
  }
  return out;
}

export interface LiveView {
  /** Капитал по живым ценам. */
  equity: Map<string, number>;
  /** Открытые сделки с пересчитанным результатом. */
  open: Map<string, PersonaTrade[]>;
}

const sign = (t: PersonaTrade) => (t.direction === "long" ? 1 : -1);

/** Пересчёт сводки по живым ценам; символ без живой цены остаётся по цене сводки. */
export function liveView(snapshot: PersonasSnapshot, prices: LivePrices): LiveView {
  const snapPrice = (s: string) => snapshot.prices[s]?.price;
  const delta = (s: string) => {
    const now = prices[s];
    const then = snapPrice(s);
    return now !== undefined && then !== undefined ? now - then : 0;
  };
  const equity = new Map<string, number>();
  const open = new Map<string, PersonaTrade[]>();
  const signalOrPortfolio = (p: PersonaSummary) => {
    if (p.kind === "signals") {
      const trades = p.open.map((t) => {
        if (t.entryPrice === null || t.pnlUsd === null) return t;
        const pnlUsd = t.pnlUsd + sign(t) * delta(t.symbol) * t.qty;
        return { ...t, pnlUsd, r: pnlUsd / t.riskUsd };
      });
      open.set(p.id, trades);
      return p.equity + trades.reduce((s, t, i) => s + (t.pnlUsd ?? 0) - (p.open[i]!.pnlUsd ?? 0), 0);
    }
    return p.equity + p.holdings.reduce((s, h) => s + h.qty * delta(h.symbol), 0);
  };
  for (const p of snapshot.personas) if (p.kind !== "manager") equity.set(p.id, signalOrPortfolio(p));
  for (const p of snapshot.personas) {
    if (p.kind !== "manager") continue;
    const byId = new Map(snapshot.personas.map((x) => [x.id, x]));
    const value = p.allocations.reduce((s, a) => {
      const snapEquity = byId.get(a.personaId)?.equity;
      const liveEquity = equity.get(a.personaId);
      return s + (snapEquity && liveEquity !== undefined ? (a.value * liveEquity) / snapEquity : a.value);
    }, 0);
    equity.set(p.id, (p.cash ?? 0) + value);
  }
  return { equity, open };
}

/** Сводка с живыми значениями: капитал, доходность, открытые сделки, точка «сейчас» на кривой. */
export function applyLive(snapshot: PersonasSnapshot, live: LiveView | null, at: number): PersonasSnapshot {
  if (!live) return snapshot;
  return {
    ...snapshot,
    personas: snapshot.personas.map((p) => {
      const equity = live.equity.get(p.id) ?? p.equity;
      const last = p.curve.at(-1);
      const curve: [number, number][] = last && at > last[0] ? [...p.curve, [at, equity]] : p.curve;
      return { ...p, equity, returnPct: equity / snapshot.initialEquity - 1, open: live.open.get(p.id) ?? p.open, curve };
    }),
  };
}
