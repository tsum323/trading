import type { SignalOutcome } from "@/modules/backtest";
import { getStrategy, STRATEGY_IDS } from "@/modules/strategies/registry";
import type { DataBranchReader } from "./data-branch";
import type { LiveSignalRecord } from "./live-cycle";
import type { JournalEntry, SplitPlan } from "./research";

export interface Overview {
  dataBranch: string;
  split: SplitPlan | null;
  journal: JournalEntry[];
  live: Record<string, { signals: LiveSignalRecord[]; outcomes: SignalOutcome[] }>;
  browse: { journal: string | null; reports: string | null };
}

/** Журнал исследований и перспективный тест из ветки `data`. Работает и в браузере. */
export async function loadOverview(reader: DataBranchReader, signal?: AbortSignal): Promise<Overview> {
  // Журналы перспективного теста называются по id стратегии (несколько записей реестра могут делить один id).
  const ids = [...new Set(STRATEGY_IDS.map((key) => getStrategy(key).id))];
  const [split, journal, ...live] = await Promise.all([
    reader.readJson<SplitPlan>("research/split.json", signal),
    reader.readJsonl<JournalEntry>("research/journal.jsonl", signal),
    ...ids.map(async (id) => ({
      id,
      signals: await reader.readJsonl<LiveSignalRecord>(`signals/${id}.jsonl`, signal),
      outcomes: await reader.readJsonl<SignalOutcome>(`outcomes/${id}.jsonl`, signal),
    })),
  ]);
  return {
    dataBranch: reader.baseUrl,
    split,
    journal,
    live: Object.fromEntries(live.map(({ id, signals, outcomes }) => [id, { signals, outcomes }])),
    browse: { journal: reader.browseUrl("research/journal.jsonl"), reports: reader.browseUrl("reports") },
  };
}
