import { formatDateTime } from "@/core/time";

const nf = new Map<number, Intl.NumberFormat>();

export function fmtNum(x: number | null | undefined, digits = 2): string {
  if (x == null || !Number.isFinite(x)) return "—";
  let f = nf.get(digits);
  if (!f) nf.set(digits, (f = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: digits, minimumFractionDigits: 0 })));
  return f.format(x);
}

/**
 * Цена: знаков после запятой столько, чтобы и BTC, и мелкие монеты читались.
 * `scale` — цена, по которой выбирается точность (для ATR и расстояний — цена актива).
 */
export function fmtPrice(x: number | null | undefined, scale: number | null | undefined = x): string {
  if (x == null || !Number.isFinite(x)) return "—";
  const ref = Math.abs(scale ?? x);
  const digits = ref >= 1000 ? 2 : ref >= 1 ? 4 : 6;
  return fmtNum(x, digits);
}

export function fmtPct(x: number | null | undefined, digits = 2): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${x > 0 ? "+" : ""}${fmtNum(x * 100, digits)}%`;
}

export function fmtR(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${x > 0 ? "+" : ""}${fmtNum(x, 3)} R`;
}

/** Дата и время по Москве (МСК). */
export function fmtTime(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return formatDateTime(ms);
}

export const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
