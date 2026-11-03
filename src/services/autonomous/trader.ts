import { formatDateTime, TIMEFRAME_MS, type UnixMs } from "@/core/time";
import { DEFAULT_COSTS, type Evaluation } from "@/modules/backtest";
import type { MarketSymbol } from "@/modules/market-data";
import { lossPerUnit } from "@/modules/risk";
import type { FileArchive } from "@/modules/storage";
import type { TradingSignal } from "@/modules/strategies";
import { decideRisk, tradeEdge, type ClosedTrade } from "../personas/risk-manager";
import { costsFor, INITIAL_EQUITY, MAX_POSITION_SHARE } from "../personas/roster";
import { exitPnlUsd, lowerBound, type PersonaEntry, type PersonaExit, type PersonaSkip } from "../personas/signal-trader";
import type { TradeMode } from "../personas/types";
import {
  BRAIN,
  classifyLoss,
  confidence,
  LESSON_TEXT,
  lessonAllows,
  LOSS_REASON_TEXT,
  marketContext,
  reviewLesson,
  skillScores,
  trustedSkills,
  type FilterLesson,
  type LossReason,
} from "./brain";
import { autoPath, readShadowExits, type CandleCache, type ShadowExit, type ShadowSignal } from "./shadow";
import { skillById, SKILLS } from "./skills";

const DAY = 86_400_000;
const FILTERS = Object.keys(LESSON_TEXT) as FilterLesson[];

export interface AutoEntry extends PersonaEntry {
  skillId: string;
}

export interface Postmortem {
  signalId: string;
  skillId: string;
  symbol: MarketSymbol;
  direction: TradingSignal["direction"];
  r: number;
  reasons: LossReason[];
  at: UnixMs;
}

export type LessonEvent =
  | { at: UnixMs; kind: "activate" | "revoke" | "confirm"; lesson: FilterLesson; evidence: string }
  | { at: UnixMs; kind: "demote"; skillId: string; until: UnixMs; evidence: string }
  | { at: UnixMs; kind: "slow-down"; until: UnixMs; evidence: string };

export interface BlockedSignal {
  signalId: string;
  skillId: string;
  lesson: FilterLesson;
  at: UnixMs;
}

export interface DiaryEntry {
  t: UnixMs;
  kind: "start" | "trust" | "distrust" | "postmortem" | "lesson" | "revoke" | "confirm" | "demote" | "slow-down" | "day";
  text: string;
}

export interface AutoCursor {
  startedAt: UnixMs;
  launchedAt: UnixMs;
  trusted: string[];
  /** День (МСК, YYYY-MM-DD), за который уже записан итог. */
  lastDay: string | null;
}

export const AUTO_START_PATH = autoPath("cursor.json");
/** Навыки торгуют «в уме» с запасом до старта: бот приходит не с нуля. */
export const SHADOW_WARMUP_MS = 60 * DAY;

const mskDay = (t: UnixMs) => formatDateTime(t).slice(0, 10);
const r2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`;
const usd = (x: number) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(0)}`;
const coin = (s: string) => s.split("/")[0]!;

/** Состояние уроков на момент t (свёртка журнала уроков). */
export function lessonState(events: readonly LessonEvent[], t: UnixMs) {
  const filters = new Map<FilterLesson, { since: UnixMs; confirmed: boolean }>();
  const revokedAt = new Map<FilterLesson, UnixMs>();
  const demoted = new Set<string>();
  let slowUntil = 0;
  for (const e of events) {
    if (e.at > t) continue;
    if (e.kind === "activate") filters.set(e.lesson, { since: e.at, confirmed: false });
    else if (e.kind === "revoke") {
      filters.delete(e.lesson);
      revokedAt.set(e.lesson, e.at);
    } else if (e.kind === "confirm") {
      const f = filters.get(e.lesson);
      if (f) f.confirmed = true;
    } else if (e.kind === "demote" && e.until > t) demoted.add(e.skillId);
    else if (e.kind === "slow-down") slowUntil = Math.max(slowUntil, e.until);
  }
  return { filters, revokedAt, demoted, slowUntil };
}

/**
 * Один цикл Автономного после тренировочной торговли: решения по свежим сигналам,
 * исходы, разборы убытков, уроки и их перепроверка, дневник.
 */
export function runAutonomousTrader(opts: {
  archive: FileArchive;
  candles: CandleCache;
  cursor: AutoCursor;
  newShadowSignals: readonly ShadowSignal[];
  now: UnixMs;
  codeCommit: string | null;
}): { newEntries: number; newExits: number } {
  const { archive, candles, cursor, now } = opts;
  const read = <T>(name: string) => archive.readJsonl<T>(autoPath(name));
  const entries = read<AutoEntry>("entries");
  const exits = new Map(read<PersonaExit>("exits").map((x) => [x.signalId, x]));
  const lessons = read<LessonEvent>("lessons");
  const postmortems = read<Postmortem>("postmortems");
  const blocked = read<BlockedSignal>("blocked");
  const shadowExits = readShadowExits(archive, SKILLS);
  const shadowById = new Map(shadowExits.map((x) => [x.signalId, x]));
  const diary: DiaryEntry[] = [];
  const newLessons: LessonEvent[] = [];
  const newBlocked: BlockedSignal[] = [];
  const newSkips: PersonaSkip[] = [];
  const skillIds = SKILLS.map((s) => s.id);

  const evals = new Map<string, Evaluation>();
  for (const e of entries) evals.set(e.signal.id, exits.get(e.signal.id) ?? candles.evaluate(e.signal));
  const closedAt = (e: AutoEntry): UnixMs => {
    const ev = evals.get(e.signal.id)!;
    if (ev.status === "pending") return Number.POSITIVE_INFINITY;
    if (ev.status === "no-entry") return e.signal.createdAt;
    return ev.exitTime ?? e.signal.expiresAt;
  };

  // 1. Решения по свежим сигналам навыков — только после старта бота.
  const all = [...entries];
  const added: AutoEntry[] = [];
  const candidates = [...opts.newShadowSignals].filter((c) => c.signal.createdAt > cursor.startedAt).sort((a, b) => a.signal.createdAt - b.signal.createdAt);
  for (const c of candidates) {
    const s = c.signal;
    const t = s.createdAt;
    if (all.some((e) => e.signal.symbol === s.symbol && closedAt(e) > t)) continue;
    const state = lessonState([...lessons, ...newLessons], t);
    const scores = skillScores(shadowExits, skillIds, t);
    const trusted = trustedSkills(scores, state.demoted);
    const mine = trusted.find((x) => x.skillId === c.skillId);
    if (!mine) continue;

    const mode: TradeMode = now - t > TIMEFRAME_MS[s.timeframe] ? "late" : "live";
    const skip = (reason: PersonaSkip["reason"], extra: Partial<PersonaSkip> = {}) =>
      newSkips.push({ signalId: s.id, symbol: s.symbol, direction: s.direction, createdAt: t, reason, drawdown: 0, recordedAt: now, mode, ...extra });
    const edge = tradeEdge(s, costsFor(s.symbol));
    if (!edge.worth) {
      skip("not-worth", { rewardRisk: edge.rewardRisk, costShare: edge.costShare });
      continue;
    }
    const context = marketContext(candles.get(s.symbol, "4h"), t);
    const blocking = [...state.filters.keys()].find((l) => !lessonAllows(l, { direction: s.direction, costShare: edge.costShare }, context));
    if (blocking) {
      newBlocked.push({ signalId: s.id, skillId: c.skillId, lesson: blocking, at: t });
      continue;
    }
    const open = all.filter((e) => e.signal.createdAt <= t && closedAt(e) > t && evals.get(e.signal.id)!.status !== "no-entry");
    if (state.slowUntil > t && open.length >= BRAIN.slowDownMaxPositions) continue;

    const closed: ClosedTrade[] = [];
    for (const e of all) {
      const ev = evals.get(e.signal.id)!;
      if (ev.status !== "pending" && ev.exitTime !== undefined && ev.exitTime <= t && ev.rMultiple !== undefined) {
        closed.push({ symbol: e.signal.symbol, direction: e.signal.direction, exitTime: ev.exitTime, pnlUsd: exitPnlUsd(e.signal, e.qty, ev), r: ev.rMultiple });
      }
    }
    const d = decideRisk({ closed, t, symbol: s.symbol, direction: s.direction, openRiskUsd: open.reduce((a, e) => a + e.riskUsd, 0), adaptive: false });
    if (d.skip) {
      skip(d.skip, { drawdown: d.state.drawdown });
      continue;
    }
    const conf = confidence(mine.score);
    const equity = d.state.equity;
    const unit = lossPerUnit(s.direction, s.entry.referencePrice, s.stopLoss, DEFAULT_COSTS.feeRate);
    const qty = Math.min((d.riskUsd * conf) / unit, (equity * MAX_POSITION_SHARE) / s.entry.referencePrice);
    if (!(qty > 0)) continue;
    const notes = [
      `навык «${skillById.get(c.skillId)!.label}»: оценка ${r2(mine.score)} по ${mine.trades} тренировочным сделкам`,
      ...(conf < 1 ? [`уверенность ${(conf * 100).toFixed(0)}% → риск меньше`] : []),
      ...d.notes,
    ];
    const entry: AutoEntry = {
      signal: s, skillId: c.skillId, qty, riskUsd: qty * unit, equityAtEntry: equity, riskFraction: (qty * unit) / equity, notes,
      recordedAt: now, codeCommit: opts.codeCommit, mode,
    };
    all.push(entry);
    added.push(entry);
    evals.set(s.id, candles.evaluate(s));
  }

  // 2. Исходы.
  const newExits: PersonaExit[] = [];
  for (const e of all) {
    if (exits.has(e.signal.id)) continue;
    const ev = evals.get(e.signal.id)!;
    if (ev.status === "pending") continue;
    const x = { ...ev, pnlUsd: exitPnlUsd(e.signal, e.qty, ev) };
    newExits.push(x);
    exits.set(e.signal.id, x);
  }

  // 3. Разбор каждого убытка — когда срок сделки прошёл и видно, что было бы дальше.
  const done = new Set(postmortems.map((p) => p.signalId));
  const newPostmortems: Postmortem[] = [];
  for (const e of all) {
    const x = exits.get(e.signal.id);
    if (!x || done.has(e.signal.id) || x.rMultiple === undefined || x.rMultiple >= 0 || x.exitTime === undefined) continue;
    const s = e.signal;
    const series = candles.get(s.symbol, s.timeframe);
    if ((series.at(-1)?.closeTime ?? 0) < s.expiresAt) continue;
    const after = series.slice(lowerBound(series, x.exitTime)).filter((k) => k.closeTime <= s.expiresAt);
    const reasons = classifyLoss({
      direction: s.direction, status: x.status, target: s.takeProfits[0]!, entryTime: s.basisCloseTime, exitTime: x.exitTime,
      barMs: TIMEFRAME_MS[s.timeframe], grossR: (shadowById.get(s.id) as ShadowExit | undefined)?.grossR ?? null, netR: x.rMultiple,
      context: marketContext(candles.get(s.symbol, "4h"), s.createdAt), after,
    });
    const pm: Postmortem = { signalId: s.id, skillId: e.skillId, symbol: s.symbol, direction: s.direction, r: x.rMultiple, reasons, at: now };
    newPostmortems.push(pm);
    diary.push({
      t: now, kind: "postmortem",
      text: `Разбор убытка ${coin(s.symbol)} ${s.direction === "long" ? "лонг" : "шорт"} ${r2(x.rMultiple)} (${usd(x.pnlUsd)}): ` +
        (reasons.length === 0 ? LOSS_REASON_TEXT.plain : reasons.map((r) => LOSS_REASON_TEXT[r]).join("; ")) + ".",
    });
  }
  const allPm = [...postmortems, ...newPostmortems];

  // 4. Уроки из разборов.
  const stateNow = lessonState([...lessons, ...newLessons], now);
  const recent = allPm.slice(-BRAIN.reviewWindow);
  for (const lesson of FILTERS) {
    const info = LESSON_TEXT[lesson];
    const hits = recent.filter((p) => p.reasons.includes(info.trigger)).length;
    const cooled = (stateNow.revokedAt.get(lesson) ?? Number.NEGATIVE_INFINITY) + BRAIN.lessonCooldownDays * DAY < now;
    if (hits >= BRAIN.lessonTrigger && !stateNow.filters.has(lesson) && cooled) {
      const evidence = `${hits} из ${recent.length} последних убытков: ${LOSS_REASON_TEXT[info.trigger]}`;
      newLessons.push({ at: now, kind: "activate", lesson, evidence });
      diary.push({ t: now, kind: "lesson", text: `Новый урок «${info.title}»: ${info.rule}. Почему: ${evidence}. Проверю его на следующих сделках.` });
    }
  }
  for (const skillId of skillIds) {
    const mine = allPm.filter((p) => p.skillId === skillId).slice(-5);
    const noise = mine.filter((p) => p.reasons.includes("noise-stop")).length;
    if (noise >= 2 && !stateNow.demoted.has(skillId) && newPostmortems.some((p) => p.skillId === skillId)) {
      const evidence = `${noise} из ${mine.length} последних убытков навыка — стоп выбит шумом`;
      newLessons.push({ at: now, kind: "demote", skillId, until: now + BRAIN.demoteDays * DAY, evidence });
      diary.push({ t: now, kind: "demote", text: `Меньше доверяю навыку «${skillById.get(skillId)!.label}» на ${BRAIN.demoteDays} дней: ${evidence} — его стоп слишком близко.` });
    }
  }
  const lastClosed = all.map((e) => exits.get(e.signal.id)).filter((x): x is PersonaExit => x?.rMultiple !== undefined).sort((a, b) => a.exitTime! - b.exitTime!);
  const streak = lastClosed.slice(-BRAIN.slowDownStreak);
  if (streak.length === BRAIN.slowDownStreak && streak.every((x) => x.rMultiple! < 0) && stateNow.slowUntil < streak.at(-1)!.exitTime!) {
    newLessons.push({ at: now, kind: "slow-down", until: now + BRAIN.slowDownDays * DAY, evidence: `${BRAIN.slowDownStreak} убытка подряд` });
    diary.push({ t: now, kind: "slow-down", text: `${BRAIN.slowDownStreak} убытка подряд — сбавляю темп: ${BRAIN.slowDownDays} дня не больше ${BRAIN.slowDownMaxPositions} позиций одновременно.` });
  }

  // 5. Перепроверка действующих уроков: что стало с отсечёнными сделками.
  const allBlocked = [...blocked, ...newBlocked];
  for (const [lesson, info] of lessonState([...lessons, ...newLessons], now).filters) {
    const blockedR = allBlocked.filter((b) => b.lesson === lesson && b.at >= info.since).map((b) => shadowById.get(b.signalId)?.rMultiple).filter((r): r is number => r !== undefined);
    const takenR = all.filter((e) => e.signal.createdAt >= info.since).map((e) => exits.get(e.signal.id)?.rMultiple).filter((r): r is number => r !== undefined);
    const verdict = reviewLesson(blockedR, takenR);
    const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length);
    const title = LESSON_TEXT[lesson].title;
    if (verdict === "revoke") {
      const evidence = `отсечённые сделки в среднем ${r2(mean(blockedR))} против ${r2(mean(takenR))} у принятых (${blockedR.length} шт.)`;
      newLessons.push({ at: now, kind: "revoke", lesson, evidence });
      diary.push({ t: now, kind: "revoke", text: `Урок «${title}» не подтвердился — отменяю: ${evidence}. Ошибся в выводе.` });
    } else if (verdict === "keep" && !info.confirmed) {
      const evidence = `отсечённые сделки в среднем ${r2(mean(blockedR))} против ${r2(mean(takenR))} у принятых (${blockedR.length} шт.)`;
      newLessons.push({ at: now, kind: "confirm", lesson, evidence });
      diary.push({ t: now, kind: "confirm", text: `Урок «${title}» подтвердился: ${evidence}. Оставляю.` });
    }
  }

  // 6. Кому доверяю сейчас.
  const finalState = lessonState([...lessons, ...newLessons], now);
  const trustedNow = trustedSkills(skillScores(shadowExits, skillIds, now), finalState.demoted);
  const ids = trustedNow.map((x) => x.skillId);
  for (const x of trustedNow) {
    if (!cursor.trusted.includes(x.skillId)) {
      diary.push({ t: now, kind: "trust", text: `Доверяю деньги навыку «${skillById.get(x.skillId)!.label}»: оценка ${r2(x.score)} по ${x.trades} тренировочным сделкам.` });
    }
  }
  for (const id of cursor.trusted) {
    if (!ids.includes(id)) diary.push({ t: now, kind: "distrust", text: `Больше не доверяю навыку «${skillById.get(id)?.label ?? id}»: его свежие результаты ухудшились.` });
  }
  cursor.trusted = ids;

  // 7. Итог прошедшего дня (по МСК).
  const today = mskDay(now);
  if (cursor.lastDay === null) cursor.lastDay = today;
  else if (cursor.lastDay !== today) {
    const dayExits = [...exits.values()].filter((x) => x.exitTime !== undefined && mskDay(x.exitTime) === cursor.lastDay && x.rMultiple !== undefined);
    const equity = INITIAL_EQUITY + [...exits.values()].reduce((a, x) => a + x.pnlUsd, 0);
    const dayR = dayExits.reduce((a, x) => a + x.rMultiple!, 0);
    diary.push({
      t: now, kind: "day",
      text: `Итог ${cursor.lastDay}: закрыто сделок ${dayExits.length}${dayExits.length ? `, в сумме ${r2(dayR)}` : ""}; закрытый счёт $${equity.toFixed(0)}. ` +
        `Доверяю ${ids.length} навыкам${ids.length ? `: ${ids.map((i) => skillById.get(i)!.label).join("; ")}` : " — пока никому не хватает свежих результатов"}.`,
    });
    cursor.lastDay = today;
  }

  archive.appendJsonl(autoPath("entries"), added);
  archive.appendJsonl(autoPath("exits"), newExits);
  archive.appendJsonl(autoPath("skips"), newSkips);
  archive.appendJsonl(autoPath("blocked"), newBlocked);
  archive.appendJsonl(autoPath("postmortems"), newPostmortems);
  archive.appendJsonl(autoPath("lessons"), newLessons);
  archive.appendJsonl(autoPath("diary"), diary);
  archive.writeText(AUTO_START_PATH, `${JSON.stringify(cursor, null, 2)}\n`);
  return { newEntries: added.length, newExits: newExits.length };
}
