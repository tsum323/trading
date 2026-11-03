import { alignToTimeframe, TIMEFRAME_MS, type Timeframe, type UnixMs } from "@/core/time";
import type { FactorBook } from "@/modules/derivatives";
import type { MarketDataSource } from "@/modules/market-data";
import type { FileArchive } from "@/modules/storage";
import { ingestHistory } from "../ingest-history";
import { AUTONOMOUS } from "../personas/roster";
import { autoPath, CandleCache, runShadow } from "./shadow";
import { SKILLS } from "./skills";
import { AUTO_START_PATH, runAutonomousTrader, SHADOW_WARMUP_MS, type AutoCursor, type DiaryEntry } from "./trader";

/** Самое длинное окно навыков по таймфрейму, в свечах. */
function lookbackByTimeframe(): Map<Timeframe, number> {
  const out = new Map<Timeframe, number>();
  for (const s of SKILLS) {
    const st = s.make(new Map());
    out.set(st.timeframe, Math.max(out.get(st.timeframe) ?? 0, st.lookback + 1));
  }
  out.set("4h", Math.max(out.get("4h") ?? 0, 400)); // контекст разборов: EMA 200 и ATR по 4h
  return out;
}

/**
 * Цикл Автономного: при первом запуске фиксирует его собственный старт, догружает
 * историю для тренировки навыков «в уме», затем тренировка и решения.
 */
export async function runAutonomousCycle(opts: {
  source: MarketDataSource;
  archive: FileArchive;
  factors: FactorBook;
  now: () => UnixMs;
  codeCommit: string | null;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ newEntries: number; newExits: number; shadowSignals: number }> {
  const { archive, source, now } = opts;
  let cursor = archive.readJson<AutoCursor>(AUTO_START_PATH);
  if (!cursor) {
    cursor = { startedAt: alignToTimeframe(now(), "15m"), launchedAt: now(), trusted: [], lastDay: null };
    const hello: DiaryEntry = {
      t: now(), kind: "start",
      text: "Старт. Банк $10 000. Навыки начинают тренироваться «в уме» на истории за 60 дней — деньги получат только те, кто покажет результат.",
    };
    archive.appendJsonl(autoPath("diary"), [hello]);
  }
  const shadowFrom = cursor.startedAt - SHADOW_WARMUP_MS;
  const lookbacks = lookbackByTimeframe();
  const fromFor = (tf: Timeframe) => shadowFrom - (lookbacks.get(tf) ?? 1) * TIMEFRAME_MS[tf];

  // История для тренировки: догружаем недостающее начало рядов (конец догружает общий цикл).
  for (const symbol of AUTONOMOUS.symbols) {
    for (const tf of lookbacks.keys()) {
      const size = TIMEFRAME_MS[tf];
      const from = fromFor(tf);
      const first = archive.getCandles(source.id, { symbol, timeframe: tf, from, limit: 1 })[0];
      if (first && first.openTime <= from + size) continue;
      await ingestHistory({
        source, store: archive, symbol, timeframe: tf, from, to: first?.openTime ?? now() + size, now, ...(opts.sleep ? { sleep: opts.sleep } : {}),
      });
    }
  }

  const candles = new CandleCache(archive, source.id, fromFor);
  const shadow = runShadow({ archive, candles, skills: SKILLS, factors: opts.factors, symbols: AUTONOMOUS.symbols, from: shadowFrom, now: now() });
  const r = runAutonomousTrader({ archive, candles, cursor, newShadowSignals: shadow.newSignals, now: now(), codeCommit: opts.codeCommit });
  return { ...r, shadowSignals: shadow.newSignals.length };
}
