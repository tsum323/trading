import type { UnixMs } from "@/core/time";
import type { FileArchive } from "@/modules/storage";
import type { AutonomousView, FeedEvent, PersonaSummary } from "../personas/types";
import { LESSON_TEXT, skillScores, trustedSkills } from "./brain";
import { autoPath, readShadowExits } from "./shadow";
import { SKILLS } from "./skills";
import { AUTO_START_PATH, lessonState, SHADOW_WARMUP_MS, type AutoCursor, type BlockedSignal, type DiaryEntry, type LessonEvent, type Postmortem } from "./trader";

const MAX_DIARY = 150;

/** Сводка Автономного для сайта: счёт, навыки, уроки, разборы, дневник. */
export function buildAutonomousView(archive: FileArchive, summary: PersonaSummary, feed: FeedEvent[], now: UnixMs): AutonomousView | null {
  const cursor = archive.readJson<AutoCursor>(AUTO_START_PATH);
  if (!cursor) return null;
  const read = <T>(name: string) => archive.readJsonl<T>(autoPath(name));
  const lessons = read<LessonEvent>("lessons");
  const blocked = read<BlockedSignal>("blocked");
  const postmortems = read<Postmortem>("postmortems");
  const diary = read<DiaryEntry>("diary");
  const state = lessonState(lessons, now);
  const scores = skillScores(readShadowExits(archive, SKILLS), SKILLS.map((s) => s.id), now);
  const trusted = new Set(trustedSkills(scores, state.demoted).map((s) => s.skillId));

  const lessonViews: AutonomousView["lessons"] = [];
  for (const e of lessons) {
    if (e.kind !== "activate") continue;
    const later = lessons.filter((x) => x.at >= e.at && "lesson" in x && x.lesson === e.lesson && x.kind !== "activate");
    const revoked = later.find((x) => x.kind === "revoke");
    const confirmed = later.find((x) => x.kind === "confirm");
    lessonViews.push({
      id: e.lesson, title: LESSON_TEXT[e.lesson].title, rule: LESSON_TEXT[e.lesson].rule,
      status: revoked ? "revoked" : confirmed ? "confirmed" : "active", since: e.at,
      evidence: revoked?.evidence ?? confirmed?.evidence ?? e.evidence,
      blocked: blocked.filter((b) => b.lesson === e.lesson && b.at >= e.at && (!revoked || b.at < revoked.at)).length,
    });
  }
  for (const e of lessons) {
    if (e.kind === "demote" && e.until > now) {
      lessonViews.push({
        id: `demote:${e.skillId}`, title: `Меньше доверять: ${SKILLS.find((s) => s.id === e.skillId)?.label ?? e.skillId}`,
        rule: "оценка навыка ×0,5 до конца срока", status: "active", since: e.at, evidence: e.evidence, blocked: 0,
      });
    }
  }

  const reasons: Record<string, number> = {};
  for (const p of postmortems) for (const r of p.reasons.length ? p.reasons : ["plain"]) reasons[r] = (reasons[r] ?? 0) + 1;

  return {
    summary,
    startedAt: cursor.startedAt,
    shadowFrom: cursor.startedAt - SHADOW_WARMUP_MS,
    skills: SKILLS.map((s) => {
      const sc = scores.find((x) => x.skillId === s.id)!;
      return { id: s.id, label: s.label, timeframe: s.make(new Map()).timeframe, trades: sc.trades, meanR: sc.meanR, score: sc.score, trusted: trusted.has(s.id), demoted: state.demoted.has(s.id) };
    }).sort((a, b) => b.score - a.score),
    lessons: lessonViews.reverse(),
    reasons,
    postmortems: postmortems.length,
    diary: diary.slice(-MAX_DIARY).reverse(),
    feed: [...feed].sort((a, b) => b.t - a.t).slice(0, MAX_DIARY),
  };
}
