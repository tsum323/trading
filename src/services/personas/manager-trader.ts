import { TIMEFRAME_MS, type UnixMs } from "@/core/time";
import { DEFAULT_COSTS } from "@/modules/backtest";
import type { FileArchive } from "@/modules/storage";
import { rebalanceTimes, type PortfolioCursor } from "./portfolio-trader";
import { INITIAL_EQUITY, PERSONA_START, type ManagerPersonaDef } from "./roster";
import { personaPath } from "./signal-trader";
import type { TradeMode } from "./types";

const DAY = TIMEFRAME_MS["1d"];

export type Curve = readonly [UnixMs, number][];

/** Перераспределение капитала Управляющего: доли персонажей, решение по их кривым капитала к `at`. */
export interface ManagerRebalance {
  at: UnixMs;
  weights: Record<string, number>;
  /** Доходность кандидата за окно, по которой принято решение. */
  scores: Record<string, number>;
  note: string;
  recordedAt: UnixMs;
  codeCommit: string | null;
  mode: TradeMode;
}

/** Значение кривой в момент t: последняя точка не позже t (до первой — стартовый капитал). */
export function curveAt(curve: Curve, t: UnixMs): number {
  let lo = 0;
  let hi = curve.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (curve[mid]![0] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? curve[lo - 1]![1] : INITIAL_EQUITY;
}

/** Доли по доходности кандидатов за lookbackDays (на старте — поровну). */
export function managerWeights(
  persona: ManagerPersonaDef,
  curves: ReadonlyMap<string, Curve>,
  at: UnixMs,
  names: ReadonlyMap<string, string>,
): { weights: Record<string, number>; scores: Record<string, number>; note: string } {
  const ids = persona.candidates.filter((id) => curves.has(id));
  if (at <= PERSONA_START) {
    const w = Math.min(persona.maxWeight, 1 / ids.length);
    return { weights: Object.fromEntries(ids.map((id) => [id, w])), scores: {}, note: "старт: поровну, результатов ещё нет" };
  }
  const from = Math.max(PERSONA_START, at - persona.lookbackDays * DAY);
  const scores = Object.fromEntries(ids.map((id) => [id, curveAt(curves.get(id)!, at) / curveAt(curves.get(id)!, from) - 1]));
  const positive = ids.filter((id) => scores[id]! > 0);
  const total = positive.reduce((s, id) => s + scores[id]!, 0);
  const weights = Object.fromEntries(positive.map((id) => [id, Math.min(persona.maxWeight, scores[id]! / total)]));
  const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
  const days = Math.round((at - from) / DAY);
  const note = `за ${days} дн.: ${[...ids].sort((a, b) => scores[b]! - scores[a]!).map((id) => `${names.get(id) ?? id} ${pct(scores[id]!)}`).join(", ")}`;
  return { weights, scores, note };
}

/**
 * Капитал Управляющего на сетке времени. Между перераспределениями доля каждого
 * персонажа растёт и падает вместе с его капиталом; перераспределение платит
 * комиссию и проскальзывание с переставленной суммы.
 */
export function managerCurve(log: readonly ManagerRebalance[], curves: ReadonlyMap<string, Curve>, grid: readonly UnixMs[]): {
  curve: [UnixMs, number][];
  allocations: Record<string, number>;
  cash: number;
  costs: number[];
} {
  const rate = DEFAULT_COSTS.feeRate + DEFAULT_COSTS.slippage;
  let cash = INITIAL_EQUITY;
  // Сумма, вложенная в персонажа, и его капитал в момент вложения.
  let alloc = new Map<string, { amount: number; basis: number }>();
  const value = (id: string, t: UnixMs) => {
    const a = alloc.get(id)!;
    return (a.amount * curveAt(curves.get(id) ?? [], t)) / a.basis;
  };
  const total = (t: UnixMs) => cash + [...alloc.keys()].reduce((s, id) => s + value(id, t), 0);
  const costs: number[] = [];
  let i = 0;
  const apply = (r: ManagerRebalance) => {
    const before = total(r.at);
    const ids = new Set([...alloc.keys(), ...Object.keys(r.weights)]);
    const turnover = [...ids].reduce((s, id) => s + Math.abs((r.weights[id] ?? 0) * before - (alloc.has(id) ? value(id, r.at) : 0)), 0);
    const cost = turnover * rate;
    const scale = (before - cost) / before;
    const next = new Map<string, { amount: number; basis: number }>();
    let invested = 0;
    for (const [id, w] of Object.entries(r.weights)) {
      if (w <= 0) continue;
      const amount = w * before * scale;
      next.set(id, { amount, basis: curveAt(curves.get(id) ?? [], r.at) });
      invested += amount;
    }
    alloc = next;
    cash = before - cost - invested;
    costs.push(cost);
  };
  const curve: [UnixMs, number][] = grid.map((t) => {
    while (i < log.length && log[i]!.at <= t) apply(log[i++]!);
    return [t, total(t)];
  });
  while (i < log.length) apply(log[i++]!);
  const last = grid.at(-1) ?? PERSONA_START;
  return { curve, allocations: Object.fromEntries([...alloc.keys()].map((id) => [id, value(id, last)])), cash, costs };
}

/** Цикл Управляющего: новые перераспределения до `until`, по уже посчитанным кривым кандидатов. */
export function runManagerTrader(opts: {
  archive: FileArchive;
  persona: ManagerPersonaDef;
  curves: ReadonlyMap<string, Curve>;
  names: ReadonlyMap<string, string>;
  until: UnixMs;
  now: UnixMs;
  codeCommit: string | null;
}): ManagerRebalance[] {
  const { archive, persona, now } = opts;
  const cursorPath = personaPath(persona.id, "cursor.json");
  const cursor = archive.readJson<PortfolioCursor>(cursorPath) ?? { launchedAt: now, processedUntil: null };
  const out: ManagerRebalance[] = [];
  for (const at of rebalanceTimes("weekly", cursor.processedUntil, opts.until)) {
    const { weights, scores, note } = managerWeights(persona, opts.curves, at, opts.names);
    const mode: TradeMode = at + TIMEFRAME_MS["1h"] < cursor.launchedAt ? "replay" : now - at > 2 * TIMEFRAME_MS["1h"] ? "late" : "live";
    out.push({ at, weights, scores, note, recordedAt: now, codeCommit: opts.codeCommit, mode });
    cursor.processedUntil = at;
  }
  archive.appendJsonl(personaPath(persona.id, "rebalances"), out);
  archive.writeText(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`);
  return out;
}
