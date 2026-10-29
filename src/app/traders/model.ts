import type { FeedEvent, PersonaSummary, RiskStatus, TradeState } from "@/services/personas/types";

/** Цвета персонажей по фиксированному порядку ростера (не по месту в рейтинге). */
export const PERSONA_COLOR_VARS = ["--p-1", "--p-2", "--p-3", "--p-4", "--p-5", "--p-6", "--p-7"] as const;

export function colorVarFor(personaIds: readonly string[], id: string): string {
  const i = personaIds.indexOf(id);
  return PERSONA_COLOR_VARS[i % PERSONA_COLOR_VARS.length] ?? "--text-muted";
}

/** Сделок меньше — место в рейтинге ничего не говорит о стратегии. */
export const MIN_TRADES_FOR_RANKING = 30;

export const coin = (symbol: string) => symbol.split("/")[0]!;

export const STATE_LABEL: Record<TradeState, string> = {
  target: "по цели",
  stop: "по стопу",
  ambiguous: "по стопу (стоп и цель в одной свече)",
  expired: "по сроку",
  "no-entry": "без входа",
  "data-gap": "пропуск данных",
  open: "открыта",
  "waiting-entry": "ждёт входа",
};

export const DIRECTION_LABEL = { long: "LONG", short: "SHORT" } as const;

export function rankPersonas(personas: readonly PersonaSummary[]): PersonaSummary[] {
  return [...personas].sort((a, b) => b.equity - a.equity);
}

export function winRate(p: PersonaSummary): number | null {
  return p.closedTrades === 0 ? null : p.wins / p.closedTrades;
}

export const RISK_STATUS_LABEL: Record<RiskStatus, string> = {
  normal: "обычный риск",
  cautious: "осторожно",
  defensive: "защита",
  "daily-stop": "дневной стоп",
  paused: "пауза",
};

export const SKIP_LABEL = {
  paused: "пауза после просадки",
  "daily-stop": "дневной стоп",
  "risk-cap": "лимит открытого риска",
} as const;

/** Доли портфеля; `label` — подпись ключа (монета или имя персонажа). */
export function weightsText(weights: Record<string, number>, label: (key: string) => string = coin): string {
  const parts = Object.entries(weights)
    .filter(([, w]) => w > 0)
    .map(([s, w]) => `${label(s)} ${Math.round(w * 100)}%`);
  if (parts.length === 0) return "всё в долларах";
  const cash = 1 - Object.values(weights).reduce((s, w) => s + w, 0);
  if (cash > 0.005) parts.push(`$ ${Math.round(cash * 100)}%`);
  return parts.join(", ");
}

/** Точки SVG-полилинии для мини-графика капитала. */
export function sparklinePoints(curve: readonly [number, number][], width: number, height: number, pad = 2): string {
  if (curve.length < 2) return "";
  const t0 = curve[0]![0];
  const t1 = curve.at(-1)![0];
  const values = curve.map((p) => p[1]);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  return curve
    .map(([t, v]) => {
      const x = pad + ((t - t0) / (t1 - t0 || 1)) * (width - 2 * pad);
      const y = pad + (1 - (v - lo) / span) * (height - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/** Точка на мини-графике для уровня стартового капитала (или null, если вне диапазона). */
export function baselineY(curve: readonly [number, number][], level: number, height: number, pad = 2): number | null {
  if (curve.length < 2) return null;
  const values = curve.map((p) => p[1]);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (level < lo || level > hi || hi === lo) return null;
  return pad + (1 - (level - lo) / (hi - lo)) * (height - 2 * pad);
}

export type FeedFilter = "all" | string;

export function filterFeed(feed: readonly FeedEvent[], filter: FeedFilter): FeedEvent[] {
  return filter === "all" ? [...feed] : feed.filter((e) => e.personaId === filter);
}
