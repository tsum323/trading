import { TIMEFRAME_MS, type Timeframe, type UnixMs } from "@/core/time";
import type { Gap, MarketDataSource, MarketSymbol } from "@/modules/market-data";
import type { FileArchive } from "@/modules/storage";
import { getStrategy } from "@/modules/strategies/registry";
import { ingestHistory } from "../ingest-history";
import { runManagerTrader } from "./manager-trader";
import { runPortfolioTrader } from "./portfolio-trader";
import { PERSONA_START, PERSONAS } from "./roster";
import { runSignalTrader } from "./signal-trader";
import { buildBoard, buildPersonasSnapshot, curvesOf } from "./snapshot";
import { PERSONAS_STATE_PATH, type PersonasSnapshot } from "./types";

/** Запас дневных свечей до старта: окно импульса Ротатора (28 дн.) с запасом. */
const DAILY_WARMUP_BARS = 40;

export interface PersonasCycleReport {
  ingest: { symbol: MarketSymbol; timeframe: Timeframe; received: number; gaps: Gap[] }[];
  personas: { id: string; newEntries: number; newExits: number; newSkips: number; rebalances: number }[];
  snapshot: PersonasSnapshot;
}

/** Какие ряды нужны персонажам и сколько истории до старта. */
export function requiredSeries(): Map<string, { symbol: MarketSymbol; timeframe: Timeframe; warmupBars: number }> {
  const need = new Map<string, { symbol: MarketSymbol; timeframe: Timeframe; warmupBars: number }>();
  const add = (symbol: MarketSymbol, timeframe: Timeframe, warmupBars: number) => {
    const key = `${symbol}|${timeframe}`;
    const prev = need.get(key);
    need.set(key, { symbol, timeframe, warmupBars: Math.max(prev?.warmupBars ?? 0, warmupBars) });
  };
  for (const p of PERSONAS) {
    for (const s of p.symbols) {
      add(s, "1h", 24); // цены для кривых капитала и исполнения портфелей
      if (p.kind === "signals") {
        const strategy = getStrategy(p.strategyKey);
        add(s, strategy.timeframe, strategy.lookback + 1);
      } else if (p.kind === "portfolio") {
        add(s, "1d", DAILY_WARMUP_BARS);
      }
    }
  }
  return need;
}

/**
 * Один цикл всех персонажей: догрузить закрытые свечи, дать каждому принять
 * решения, записать сводку `personas/state.json` для сайта.
 */
export async function runPersonasCycle(opts: {
  source: MarketDataSource;
  archive: FileArchive;
  now?: () => UnixMs;
  codeCommit?: string | null;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PersonasCycleReport> {
  const { source, archive } = opts;
  const now = opts.now ?? Date.now;
  const codeCommit = opts.codeCommit ?? null;

  const ingest: PersonasCycleReport["ingest"] = [];
  for (const { symbol, timeframe, warmupBars } of requiredSeries().values()) {
    const size = TIMEFRAME_MS[timeframe];
    const last = archive.lastCandle(source.id, symbol, timeframe);
    const from = last ? last.closeTime : PERSONA_START - warmupBars * size;
    if (from + size > now()) continue;
    const r = await ingestHistory({
      source, store: archive, symbol, timeframe, from, to: now() + size, now, ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
    ingest.push({ symbol, timeframe, received: r.received - r.unclosedReceived, gaps: r.gaps });
  }

  const personas: PersonasCycleReport["personas"] = [];
  for (const p of PERSONAS) {
    if (p.kind === "signals") {
      const r = runSignalTrader({ archive, sourceId: source.id, persona: p, strategy: getStrategy(p.strategyKey), now: now(), codeCommit });
      personas.push({ id: p.id, newEntries: r.newEntries.length, newExits: r.newExits.length, newSkips: r.newSkips.length, rebalances: 0 });
    } else if (p.kind === "portfolio") {
      const r = runPortfolioTrader({ archive, sourceId: source.id, persona: p, now: now(), codeCommit });
      personas.push({ id: p.id, newEntries: 0, newExits: 0, newSkips: 0, rebalances: r.length });
    }
  }
  // Управляющий решает по кривым капитала остальных, посчитанным после их хода.
  const board = buildBoard(archive, source.id);
  const curves = curvesOf(board.summaries);
  const names = new Map(PERSONAS.map((p) => [p.id, p.name]));
  for (const p of PERSONAS) {
    if (p.kind !== "manager") continue;
    const r = runManagerTrader({ archive, persona: p, curves, names, until: board.until, now: now(), codeCommit });
    personas.push({ id: p.id, newEntries: 0, newExits: 0, newSkips: 0, rebalances: r.length });
  }

  const snapshot = buildPersonasSnapshot(archive, source.id, now(), codeCommit);
  archive.writeText(PERSONAS_STATE_PATH, `${JSON.stringify(snapshot)}\n`);
  return { ingest, personas, snapshot };
}
