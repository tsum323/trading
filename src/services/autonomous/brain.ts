import type { UnixMs } from "@/core/time";
import type { Candle } from "@/modules/market-data";
import type { SignalDirection } from "@/modules/strategies";
import { atr, ema } from "@/modules/indicators";
import type { ShadowExit } from "./shadow";

/**
 * Правила обучения Автономного (docs/autonomous.md). Все решения — только по
 * исходам, известным к моменту решения; правила фиксированы в коде.
 */
export const BRAIN = {
  /** Полураспад веса тренировочной сделки: свежие сделки важнее старых. */
  halfLifeDays: 30,
  /** Сжатие оценки к нулю: k «нулевых» сделок в знаменателе. */
  shrinkTrades: 5,
  /** Навык получает деньги, если его оценка выше этого порога… */
  minScore: 0.05,
  /** …и у него не меньше стольких «весовых» тренировочных сделок. */
  minWeight: 5,
  /** Сколько лучших навыков допускается к деньгам одновременно. */
  maxActiveSkills: 5,
  /** Оценка, при которой риск сделки — полный; ниже — пропорционально, но не меньше четверти. */
  fullConfidenceScore: 0.3,
  /** Разборы: сколько последних убытков смотреть, сколько совпадений нужно для урока. */
  reviewWindow: 8,
  lessonTrigger: 3,
  /** Перепроверка урока: после стольких отсечённых сделок с известным исходом. */
  lessonCheckAfter: 8,
  /** Урок отменяется, если отсечённые сделки в среднем лучше принятых на столько R. */
  lessonRevokeMargin: 0.1,
  /** Отменённый урок не возвращается раньше этого срока. */
  lessonCooldownDays: 30,
  /** Понижение навыка за шумовые стопы: множитель оценки и срок. */
  demoteFactor: 0.5,
  demoteDays: 30,
  /** Серия убытков подряд, после которой бот сбавляет темп. */
  slowDownStreak: 4,
  slowDownDays: 3,
  slowDownMaxPositions: 2,
} as const;

const DAY = 86_400_000;

export interface SkillScore {
  skillId: string;
  /** Взвешенное число тренировочных сделок. */
  weight: number;
  trades: number;
  /** Сжатое к нулю средневзвешенное R. */
  score: number;
  /** Простое среднее R (для показа). */
  meanR: number;
}

/** Оценка навыков на момент t по тренировочным исходам, закрытым к t. */
export function skillScores(exits: readonly ShadowExit[], skillIds: readonly string[], t: UnixMs): SkillScore[] {
  return skillIds.map((skillId) => {
    let w = 0;
    let wr = 0;
    let n = 0;
    let sum = 0;
    for (const x of exits) {
      if (x.skillId !== skillId || x.rMultiple === undefined || x.exitTime === undefined || x.exitTime > t) continue;
      const age = (t - x.exitTime) / DAY;
      const weight = 0.5 ** (age / BRAIN.halfLifeDays);
      w += weight;
      wr += weight * x.rMultiple;
      n++;
      sum += x.rMultiple;
    }
    return { skillId, weight: w, trades: n, score: wr / (w + BRAIN.shrinkTrades), meanR: n === 0 ? 0 : sum / n };
  });
}

/** Навыки, которым бот доверяет деньги: лучшие по оценке, с учётом понижений. */
export function trustedSkills(scores: readonly SkillScore[], demoted: ReadonlySet<string>): SkillScore[] {
  return scores
    .map((s) => (demoted.has(s.skillId) ? { ...s, score: s.score * BRAIN.demoteFactor } : s))
    .filter((s) => s.weight >= BRAIN.minWeight && s.score > BRAIN.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, BRAIN.maxActiveSkills);
}

export function confidence(score: number): number {
  return Math.min(1, Math.max(0.25, score / BRAIN.fullConfidenceScore));
}

/** Причины убытка, которые бот умеет распознавать. */
export type LossReason = "noise-stop" | "against-trend" | "high-volatility" | "costs" | "instant";

export const LOSS_REASON_TEXT: Record<LossReason | "plain", string> = {
  "noise-stop": "стоп выбило шумом: после выхода цена всё-таки дошла до цели",
  "against-trend": "вход против крупного тренда (4h, EMA 200)",
  "high-volatility": "вход в слишком бурный рынок (ATR в верхних 10% за месяц)",
  costs: "до издержек сделка была в плюсе — прибыль съели комиссии",
  instant: "рынок сразу пошёл против: стоп за 1–2 свечи",
  plain: "обычный риск: сценарий не сработал, явной ошибки нет",
};

/** Рыночный контекст на момент решения по 4h-свечам (только закрытым к t). */
export function marketContext(candles4h: readonly Candle[], t: UnixMs): { trend: SignalDirection | null; atrRank: number | null } {
  const closed = candles4h.filter((c) => c.closeTime <= t).slice(-400);
  if (closed.length < 220) return { trend: null, atrRank: null };
  const e = ema(200).compute(closed).at(-1);
  const last = closed.at(-1)!;
  const atrSeries = atr(14).compute(closed).slice(-180).filter((x): x is number => x !== null);
  const now = atrSeries.at(-1);
  return {
    trend: e == null ? null : last.close >= e ? "long" : "short",
    atrRank: now === undefined ? null : atrSeries.filter((x) => x <= now).length / atrSeries.length,
  };
}

/**
 * Разбор убыточной сделки. `after` — свечи её таймфрейма после выхода до срока
 * сделки: разбор делается, только когда срок прошёл и они все известны.
 */
export function classifyLoss(opts: {
  direction: SignalDirection;
  status: string;
  target: number;
  entryTime: UnixMs;
  exitTime: UnixMs;
  barMs: number;
  grossR: number | null;
  netR: number;
  context: { trend: SignalDirection | null; atrRank: number | null };
  after: readonly Candle[];
}): LossReason[] {
  const reasons: LossReason[] = [];
  const sign = opts.direction === "long" ? 1 : -1;
  const stopped = opts.status === "stop" || opts.status === "ambiguous";
  if (stopped && opts.after.some((c) => sign * ((sign > 0 ? c.high : c.low) - opts.target) >= 0)) reasons.push("noise-stop");
  if (opts.context.trend !== null && opts.context.trend !== opts.direction) reasons.push("against-trend");
  if (opts.context.atrRank !== null && opts.context.atrRank >= 0.9) reasons.push("high-volatility");
  if (opts.grossR !== null && opts.grossR > 0 && opts.netR <= 0) reasons.push("costs");
  if (stopped && opts.exitTime - opts.entryTime <= 2 * opts.barMs) reasons.push("instant");
  return reasons;
}

/** Фильтры, которые бот может включить у себя по итогам разборов. */
export type FilterLesson = "trend-filter" | "calm-only" | "cost-guard";

export const LESSON_TEXT: Record<FilterLesson, { title: string; rule: string; trigger: LossReason }> = {
  "trend-filter": { title: "Не идти против тренда", rule: "входить только по направлению 4h-тренда (цена относительно EMA 200)", trigger: "against-trend" },
  "calm-only": { title: "Не входить в бурю", rule: "не открывать сделки, когда ATR в верхних 10% за месяц", trigger: "high-volatility" },
  "cost-guard": { title: "Беречься издержек", rule: "входить, только если издержки — не больше 20% прибыли по цели (вместо трети)", trigger: "costs" },
};

/** Пропускает ли фильтр сделку. */
export function lessonAllows(lesson: FilterLesson, s: { direction: SignalDirection; costShare: number }, context: { trend: SignalDirection | null; atrRank: number | null }): boolean {
  if (lesson === "trend-filter") return context.trend === null || context.trend === s.direction;
  if (lesson === "calm-only") return context.atrRank === null || context.atrRank < 0.9;
  return s.costShare <= 0.2;
}

/**
 * Перепроверка урока: отсечённые им сделки (их тренировочные исходы) против
 * принятых. null — данных ещё мало.
 */
export function reviewLesson(blockedR: readonly number[], takenR: readonly number[]): "keep" | "revoke" | null {
  if (blockedR.length < BRAIN.lessonCheckAfter) return null;
  const mean = (xs: readonly number[]) => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length);
  return mean(blockedR) > mean(takenR) + BRAIN.lessonRevokeMargin ? "revoke" : "keep";
}
