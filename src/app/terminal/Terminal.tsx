"use client";

import { useEffect, useMemo, useState } from "react";
import type { Timeframe } from "@/core/time";
import type { SignalOutcome } from "@/modules/backtest";
import type { Candle } from "@/modules/market-data";
import type { Overview } from "@/app/api/overview/route";
import type { TradingSignal } from "@/modules/strategies";
import { CandleChart } from "./CandleChart";
import { fmtDay, fmtNum, fmtPct, fmtPrice, fmtR, fmtTime } from "./format";
import {
  buildOverlays,
  candleCount,
  marketSummary,
  replayOnCandles,
  signalMarkers,
  strategiesFor,
  TERMINAL_SYMBOLS,
  TERMINAL_TIMEFRAMES,
} from "./model";
import { RiskCalculator } from "./RiskCalculator";

const REFRESH_MS = 30_000;
const NO_CANDLES: Candle[] = [];

interface CandleData {
  candles: Candle[];
  /** Только закрытые свечи; тот же массив, пока не закрылась новая — индикаторы и реплей не пересчитываются зря. */
  closed: Candle[];
  fetchedAt: number;
}

function withStableClosed(body: { candles: Candle[]; fetchedAt: number }, prev: CandleData | null): CandleData {
  const closed = body.candles.filter((c) => c.isClosed);
  const same =
    prev !== null &&
    prev.closed.length === closed.length &&
    prev.closed[0]?.openTime === closed[0]?.openTime &&
    prev.closed.at(-1)?.closeTime === closed.at(-1)?.closeTime &&
    prev.closed[0]?.symbol === closed[0]?.symbol &&
    prev.closed[0]?.timeframe === closed[0]?.timeframe;
  return { candles: body.candles, closed: same ? prev.closed : closed, fetchedAt: body.fetchedAt };
}

type Load<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: T };

function useTheme(): string {
  const [theme, setTheme] = useState("light");
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setTheme(mq.matches ? "dark" : "light");
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return theme;
}

export function Terminal() {
  const [symbol, setSymbol] = useState<string>(TERMINAL_SYMBOLS[0]);
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [show, setShow] = useState({ ema50: true, ema200: true, donchian: false });
  const [replayId, setReplayId] = useState<string>("");
  const [candles, setCandles] = useState<Load<CandleData>>({ state: "loading" });
  const [overview, setOverview] = useState<Load<Overview>>({ state: "loading" });
  const theme = useTheme();

  // Свечи: при смене символа/таймфрейма и каждые 30 с (обновляется формирующаяся свеча).
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const load = async (first: boolean) => {
      if (first) setCandles({ state: "loading" });
      try {
        const q = new URLSearchParams({ symbol, timeframe, count: String(candleCount(timeframe)) });
        const res = await fetch(`/api/candles?${q}`, { signal: controller.signal });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (!cancelled) setCandles((prev) => ({ state: "ready", data: withStableClosed(body, prev.state === "ready" ? prev.data : null) }));
      } catch (e) {
        if (!cancelled && !controller.signal.aborted && first) setCandles({ state: "error", message: e instanceof Error ? e.message : String(e) });
      }
    };
    void load(true);
    const timer = setInterval(() => void load(false), REFRESH_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [symbol, timeframe]);

  useEffect(() => {
    fetch("/api/overview")
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setOverview({ state: "ready", data: body });
      })
      .catch((e: unknown) => setOverview({ state: "error", message: e instanceof Error ? e.message : String(e) }));
  }, []);

  const strategies = useMemo(() => strategiesFor(timeframe), [timeframe]);
  // Выбранная стратегия может не подходить к новому таймфрейму — тогда реплей выключен.
  const activeReplay = strategies.some((s) => s.id === replayId) ? replayId : "";

  const data = candles.state === "ready" ? candles.data.candles : NO_CANDLES;
  const closed = candles.state === "ready" ? candles.data.closed : NO_CANDLES;
  const overlays = useMemo(() => buildOverlays(closed), [closed]);
  const summary = useMemo(() => marketSummary(data), [data]);
  const replay = useMemo(() => (activeReplay && closed.length > 0 ? replayOnCandles(activeReplay, closed) : null), [activeReplay, closed]);

  // Живые сигналы перспективного теста для этого символа и таймфрейма.
  const live = useMemo(() => {
    if (overview.state !== "ready") return [];
    return Object.values(overview.data.live).flatMap(({ signals, outcomes }) => {
      const byId = new Map<string, SignalOutcome>(outcomes.map((o) => [o.signalId, o]));
      return signals
        .filter((r) => r.signal.symbol === symbol)
        .map((r) => ({ ...r, outcome: byId.get(r.signal.id) }));
    });
  }, [overview, symbol]);

  const markers = useMemo(
    () => [
      ...signalMarkers(live, timeframe),
      ...(replay ? signalMarkers(replay.trades.map((t) => ({ signal: t.signal, outcome: t.outcome })), timeframe, "R·") : []),
    ].sort((a, b) => a.time - b.time),
    [live, replay, timeframe],
  );

  return (
    <div className="terminal" data-theme-hint={theme}>
      <div className="toolbar" role="toolbar" aria-label="Параметры графика">
        <label>Символ
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {TERMINAL_SYMBOLS.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <div className="segmented" role="group" aria-label="Таймфрейм">
          {TERMINAL_TIMEFRAMES.map((tf) => (
            <button key={tf} type="button" aria-pressed={tf === timeframe} onClick={() => setTimeframe(tf)}>{tf}</button>
          ))}
        </div>
        <div className="toggles" role="group" aria-label="Индикаторы">
          <label className="chip"><input type="checkbox" checked={show.ema50} onChange={(e) => setShow({ ...show, ema50: e.target.checked })} /><span className="swatch s1" />EMA 50</label>
          <label className="chip"><input type="checkbox" checked={show.ema200} onChange={(e) => setShow({ ...show, ema200: e.target.checked })} /><span className="swatch s2" />EMA 200</label>
          <label className="chip"><input type="checkbox" checked={show.donchian} onChange={(e) => setShow({ ...show, donchian: e.target.checked })} /><span className="swatch s3" />Канал 48</label>
        </div>
        <label>Реплей стратегии
          <select value={activeReplay} onChange={(e) => setReplayId(e.target.value)} disabled={strategies.length === 0}>
            <option value="">{strategies.length === 0 ? "нет для этого таймфрейма" : "выключен"}</option>
            {strategies.map((s) => <option key={s.id} value={s.id}>{s.id}@{s.version}</option>)}
          </select>
        </label>
      </div>

      <section className="stats" aria-label="Сводка по рынку">
        <Stat label={`${symbol} · ${timeframe}`} value={fmtPrice(summary?.last.close)} sub={summary && !summary.last.isClosed ? "текущая свеча формируется" : "последняя закрытая"} />
        <Stat label="За 24 часа" value={fmtPct(summary?.change24h)} tone={summary?.change24h == null ? undefined : summary.change24h >= 0 ? "up" : "down"} />
        <Stat label="ATR(14)" value={fmtPrice(summary?.atr14, summary?.lastClosed?.close)} sub={summary?.atrPct != null ? `${fmtNum(summary.atrPct * 100, 2)}% цены` : undefined} />
        <Stat label="Издержки при стопе 2·ATR" value={summary?.costR != null ? `≈ ${fmtNum(summary.costR, 2)} R` : "—"} sub="0.1% + 0.02% на сторону" />
        <Stat label="Обновлено" value={candles.state === "ready" ? fmtTime(candles.data.fetchedAt) : "—"} sub="UTC, Binance Spot" />
      </section>

      <section className="panel chart-panel" aria-label="График">
        {candles.state === "loading" && <div className="placeholder">Загрузка свечей…</div>}
        {candles.state === "error" && (
          <div className="placeholder error" role="alert">
            Не удалось получить свечи: {candles.message}. Котировки не подставляются — график пуст.
          </div>
        )}
        {candles.state === "ready" && (
          <CandleChart key={theme} candles={data} overlays={overlays} show={show} markers={markers} resetKey={`${symbol}-${timeframe}`} />
        )}
        {replay && replay.insufficient && (
          <p className="hint replay-note">
            Реплей <b>{replay.strategy.id}@{replay.strategy.version}</b> не построен: для прогрева нужно {replay.insufficient.need} закрытых
            свечей, загружено {replay.insufficient.have}.
          </p>
        )}
        {replay && !replay.insufficient && (
          <p className="hint replay-note">
            Реплей <b>{replay.strategy.id}@{replay.strategy.version}</b> на видимых свечах: сделок {replay.trades.length}
            {replay.pending ? `, ещё открыта ${replay.pending}` : ""}, среднее {fmtR(replay.expectancyR)}. Это визуальная проверка правил,
            а не исследование: окно короткое, в журнал не пишется. Отметки «R·L/R·S» — входы, кружки — выходы.
          </p>
        )}
      </section>

      <div className="columns">
        <section className="panel" aria-labelledby="live-title">
          <h2 id="live-title">Сигналы перспективного теста</h2>
          <LiveSignals overview={overview} rows={live} />
        </section>
        <RiskCalculator
          key={`${symbol}-${timeframe}-${summary ? "ready" : "empty"}`}
          symbol={symbol}
          lastPrice={summary?.lastClosed?.close ?? null}
          atr={summary?.atr14 ?? null}
        />
      </div>

      <section className="panel" aria-labelledby="journal-title">
        <h2 id="journal-title">Журнал исследований</h2>
        <Journal overview={overview} />
      </section>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string | undefined; tone?: "up" | "down" | undefined }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${tone ? ` ${tone}` : ""}`}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function LiveSignals({ overview, rows }: { overview: Load<Overview>; rows: { signal: TradingSignal; late: boolean; outcome?: SignalOutcome | undefined }[] }) {
  if (overview.state === "loading") return <p className="hint">Загрузка…</p>;
  if (overview.state === "error") return <p className="error" role="alert">Ветка data недоступна: {overview.message}</p>;
  if (rows.length === 0) {
    return (
      <p className="hint">
        По этому символу живых сигналов пока нет. Перспективный тест ведёт стратегии, указанные в workflow
        «Live forward test» (сейчас trend-pullback 15m, BTC/USDT и ETH/USDT).
      </p>
    );
  }
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Решение, UTC</th><th>Стратегия</th><th>Напр.</th><th>Вход ≈</th><th>Стоп</th><th>Цель</th><th>Исход</th><th>R</th></tr></thead>
        <tbody>
          {[...rows].reverse().map(({ signal: s, late, outcome }) => (
            <tr key={s.id}>
              <td>{fmtTime(s.createdAt)}{late && <span className="tag">запоздал</span>}</td>
              <td>{s.strategyId} {s.timeframe}</td>
              <td className={s.direction === "long" ? "up" : "down"}>{s.direction}</td>
              <td>{fmtPrice(s.entry.referencePrice)}</td>
              <td>{fmtPrice(s.stopLoss)}</td>
              <td>{fmtPrice(s.takeProfits[0])}</td>
              <td>{outcome?.status ?? "открыт"}</td>
              <td>{fmtR(outcome?.rMultiple)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Journal({ overview }: { overview: Load<Overview> }) {
  if (overview.state === "loading") return <p className="hint">Загрузка…</p>;
  if (overview.state === "error") return <p className="error" role="alert">Ветка data недоступна: {overview.message}</p>;
  const { journal, split, browse } = overview.data;
  return (
    <>
      {split && (
        <p className="hint">
          Разбиение: research {fmtDay(split.from)} – {fmtDay(split.researchEnd)}, validation – {fmtDay(split.validationEnd)}, holdout – {fmtDay(split.to)}.
          Конфигураций в журнале: {new Set(journal.map((e) => `${e.strategyId}@${e.strategyVersion}`)).size}.
        </p>
      )}
      {journal.length === 0 ? (
        <p className="hint">Прогонов пока нет.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Запуск, UTC</th><th>Стратегия</th><th>Часть</th><th>Сделок</th><th>Матожидание</th><th>95% CI</th><th>Без издержек</th><th>Случайные p95</th><th>Вердикт</th></tr></thead>
            <tbody>
              {[...journal].reverse().map((e) => (
                <tr key={`${e.at}-${e.strategyId}-${e.segment}`}>
                  <td>{fmtTime(e.at)}</td>
                  <td>{e.strategyId}@{e.strategyVersion}</td>
                  <td>{e.segment}</td>
                  <td>{e.trades}</td>
                  <td>{fmtR(e.expectancyR)}</td>
                  <td>{e.ci95 ? `[${fmtNum(e.ci95[0], 3)}; ${fmtNum(e.ci95[1], 3)}]` : "—"}</td>
                  <td>{fmtR(e.grossExpectancyR)}</td>
                  <td>{fmtR(e.baselineP95)}</td>
                  <td><span className={`verdict ${e.verdict}`}>{e.verdict}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {browse.reports && <p className="hint"><a href={browse.reports} target="_blank" rel="noreferrer">Полные отчёты на GitHub →</a></p>}
    </>
  );
}
