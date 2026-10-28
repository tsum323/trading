import type { SignalOutcome } from "@/modules/backtest";
import { getStrategy, STRATEGY_IDS } from "@/modules/strategies/registry";
import { DataBranchReader } from "@/services/data-branch";
import type { LiveSignalRecord } from "@/services/live-cycle";
import type { JournalEntry, SplitPlan } from "@/services/research";

export const revalidate = 60;

export interface Overview {
  dataBranch: string;
  split: SplitPlan | null;
  journal: JournalEntry[];
  live: Record<string, { signals: LiveSignalRecord[]; outcomes: SignalOutcome[] }>;
  browse: { journal: string | null; reports: string | null };
}

/**
 * Журнал исследований и перспективный тест из ветки `data`.
 * Адрес — DATA_BRANCH_URL (по умолчанию raw.githubusercontent.com этого репозитория).
 */
export async function GET() {
  const reader = new DataBranchReader(process.env.DATA_BRANCH_URL || undefined);
  try {
    const [split, journal, ...live] = await Promise.all([
      reader.readJson<SplitPlan>("research/split.json"),
      reader.readJsonl<JournalEntry>("research/journal.jsonl"),
      // Журналы перспективного теста называются по id стратегии (несколько записей реестра могут делить один id).
      ...[...new Set(STRATEGY_IDS.map((key) => getStrategy(key).id))].map(async (id) => ({
        id,
        signals: await reader.readJsonl<LiveSignalRecord>(`signals/${id}.jsonl`),
        outcomes: await reader.readJsonl<SignalOutcome>(`outcomes/${id}.jsonl`),
      })),
    ]);
    const body: Overview = {
      dataBranch: reader.baseUrl,
      split,
      journal,
      live: Object.fromEntries(live.map(({ id, signals, outcomes }) => [id, { signals, outcomes }])),
      browse: { journal: reader.browseUrl("research/journal.jsonl"), reports: reader.browseUrl("reports") },
    };
    return Response.json(body);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
