"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DISPLAY_TIME_ZONE } from "@/core/time";
import { DataBranchReader } from "@/services/data-branch";
import { PERSONAS_STATE_PATH, type FeedEvent, type PersonaSummary, type PersonasSnapshot, type PersonaTrade, type TradeMode } from "@/services/personas/types";
import { fmtNum, fmtPct, fmtPrice, fmtTime } from "../terminal/format";
import { closedTrades } from "@/services/personas/journal-view";
import type { PersonaEntry, PersonaExit } from "@/services/personas/signal-trader";
import { EquityChart } from "./EquityChart";
import { applyLive, fetchLivePrices, liveView, type LivePrices } from "./live";
import {
  baselineY,
  coin,
  colorVarFor,
  DIRECTION_LABEL,
  filterFeed,
  MIN_TRADES_FOR_RANKING,
  rankPersonas,
  RISK_STATUS_LABEL,
  SKIP_LABEL,
  sparklinePoints,
  STATE_LABEL,
  weightsText,
  winRate,
  type FeedFilter,
} from "./model";

const REFRESH_MS = 60_000;
const LIVE_PRICES_MS = 30_000;
const FEED_PAGE = 40;

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: PersonasSnapshot };

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

const usd = (x: number | null | undefined, signed = false) =>
  x == null || !Number.isFinite(x) ? "—" : `${signed && x > 0 ? "+" : x < 0 ? "−" : ""}$${fmtNum(Math.abs(x), Math.abs(x) >= 1000 ? 0 : 2)}`;
const tone = (x: number | null | undefined) => (x == null || x === 0 ? "" : x > 0 ? "up" : "down");

function ModeTag({ mode }: { mode: TradeMode }) {
  if (mode === "live") return null;
  return (
    <span className="tag" title={mode === "replay" ? "Решение принято до запуска персонажа: история проиграна по тем же правилам" : "Записано с опозданием: запуск по расписанию задержался"}>
      {mode === "replay" ? "реплей" : "с опозданием"}
    </span>
  );
}

function Sparkline({ curve, initial, color }: { curve: [number, number][]; initial: number; color: string }) {
  const w = 160;
  const h = 44;
  const base = baselineY(curve, initial, h);
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      {base !== null && <line x1="0" x2={w} y1={base} y2={base} className="spark-base" />}
      <polyline points={sparklinePoints(curve, w, h)} fill="none" stroke={`var(${color})`} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function RiskBadge({ p }: { p: PersonaSummary }) {
  if (!p.risk) return null;
  const r = p.risk;
  const label = r.status === "paused" && r.pausedUntil !== null ? `пауза до ${fmtTime(r.pausedUntil)}` : RISK_STATUS_LABEL[r.status];
  return (
    <span className={`risk-badge risk-${r.status}`} title={`Риск на сделку ${fmtPct(r.riskFraction, 2).replace("+", "")}, просадка ${fmtPct(r.drawdownPct, 1)}`}>
      {r.status === "normal" ? "●" : "▲"} {label} · риск {fmtPct(r.riskFraction, 2).replace("+", "")}
    </span>
  );
}

function PersonaCard({ p, rank, color, initial, selected, onSelect, names }: {
  p: PersonaSummary; rank: number; color: string; initial: number; selected: boolean; onSelect: () => void; names: (id: string) => string;
}) {
  const wr = winRate(p);
  const pnl = p.equity - initial;
  return (
    <button type="button" className={`persona-card${selected ? " selected" : ""}`} onClick={onSelect} aria-pressed={selected}>
      <div className="persona-head">
        <span className="persona-rank">#{rank}</span>
        <span className="persona-emoji" aria-hidden="true">{p.emoji}</span>
        <span className="persona-name">
          <b>{p.name}</b>
          <span className="persona-tagline">{p.tagline}</span>
        </span>
        <span className="persona-dot" style={{ background: `var(${color})` }} aria-hidden="true" />
      </div>
      <div className="persona-equity">
        <span className="persona-balance">{usd(p.equity)}</span>
        <span className={`persona-return ${tone(pnl)}`}>{fmtPct(p.returnPct)} · {usd(pnl, true)}</span>
      </div>
      <Sparkline curve={p.curve} initial={initial} color={color} />
      <dl className="persona-stats">
        {p.kind === "signals" ? (
          <>
            <div><dt>Сделок</dt><dd>{p.closedTrades}</dd></div>
            <div><dt>В плюс</dt><dd>{wr === null ? "—" : fmtPct(wr, 0).replace("+", "")}</dd></div>
            <div><dt>Открыто</dt><dd>{p.open.length}</dd></div>
          </>
        ) : p.kind === "manager" ? (
          <>
            <div><dt>Деньги у</dt><dd>{p.allocations.length === 0 ? "$" : [...p.allocations].sort((a, b) => b.value - a.value).map((a) => names(a.personaId)).join(", ")}</dd></div>
            <div><dt>Решений</dt><dd>{p.rebalances.length}</dd></div>
          </>
        ) : (
          <>
            <div><dt>Держит</dt><dd>{p.holdings.length === 0 ? "$" : p.holdings.map((h) => coin(h.symbol)).join(", ")}</dd></div>
            <div><dt>Перестановок</dt><dd>{p.rebalances.length}</dd></div>
          </>
        )}
        <div><dt>Просадка</dt><dd>{fmtPct(p.maxDrawdownPct, 1)}</dd></div>
      </dl>
      <RiskBadge p={p} />
      {p.kind === "signals" && p.closedTrades < MIN_TRADES_FOR_RANKING && (
        <span className="persona-note">Мало сделок для выводов ({p.closedTrades} из {MIN_TRADES_FOR_RANKING})</span>
      )}
    </button>
  );
}

function feedText(e: FeedEvent, p: PersonaSummary | undefined, names: (id: string) => string): { title: string; detail: string; amount?: number } {
  if (e.kind === "open") {
    return {
      title: `Вход ${DIRECTION_LABEL[e.direction]} ${coin(e.symbol)}`,
      detail: `${e.price === null ? "по открытию следующей свечи" : `по ${fmtPrice(e.price)}`} · стоп ${fmtPrice(e.stop, e.price ?? e.stop)} · цель ${fmtPrice(e.target, e.price ?? e.target)}`,
    };
  }
  if (e.kind === "close") {
    return {
      title: `Выход ${DIRECTION_LABEL[e.direction]} ${coin(e.symbol)} ${STATE_LABEL[e.state]}`,
      detail: `${e.price === null ? "" : `по ${fmtPrice(e.price)} · `}${e.r === null ? "" : `${e.r > 0 ? "+" : ""}${fmtNum(e.r, 2)}R`}`,
      amount: e.pnlUsd,
    };
  }
  if (e.kind === "skip") {
    return {
      title: `Пропустил ${DIRECTION_LABEL[e.direction]} ${coin(e.symbol)}: ${SKIP_LABEL[e.reason]}`,
      detail:
        e.reason === "not-worth"
          ? `цель/стоп ${fmtNum(e.rewardRisk ?? 0, 2)} (нужно ≥ 1,5) · издержки ${fmtPct(Math.min(e.costShare ?? 0, 9.99), 0).replace("+", "")} прибыли (нужно ≤ 33%)`
          : `защита капитала · просадка ${fmtPct(e.drawdown, 1)}`,
    };
  }
  if (p?.kind === "manager") return { title: `Распределил: ${weightsText(e.weights, names)}`, detail: e.note };
  return { title: `Перестановка: ${weightsText(e.weights)}`, detail: e.note };
}

function Feed({ feed, personas, colorVar, names }: { feed: FeedEvent[]; personas: PersonaSummary[]; colorVar: (id: string) => string; names: (id: string) => string }) {
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [limit, setLimit] = useState(FEED_PAGE);
  const byId = useMemo(() => new Map(personas.map((p) => [p.id, p])), [personas]);
  const items = useMemo(() => filterFeed(feed, filter), [feed, filter]);
  return (
    <section className="panel feed" aria-labelledby="feed-title">
      <h2 id="feed-title">Лента действий</h2>
      <div className="toggles feed-filter" role="group" aria-label="Фильтр по персонажу">
        <button type="button" className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>Все</button>
        {personas.map((p) => (
          <button key={p.id} type="button" className="chip" aria-pressed={filter === p.id} onClick={() => setFilter(p.id)}>
            <span aria-hidden="true">{p.emoji}</span>{p.name}
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="hint">Пока действий нет.</p>
      ) : (
        <ol className="feed-list">
          {items.slice(0, limit).map((e, i) => {
            const p = byId.get(e.personaId);
            const t = feedText(e, p, names);
            return (
              <li key={`${e.personaId}-${e.kind}-${e.t}-${i}`} className="feed-item">
                <span className="feed-emoji" style={{ borderColor: `var(${colorVar(e.personaId)})` }} aria-hidden="true">{p?.emoji}</span>
                <div className="feed-body">
                  <div className="feed-who">{p?.name ?? e.personaId}</div>
                  <div className="feed-title">
                    {t.title}
                    <ModeTag mode={e.mode} />
                  </div>
                  <div className="feed-detail">{t.detail}</div>
                </div>
                <div className="feed-side">
                  {t.amount !== undefined && <span className={`feed-amount ${tone(t.amount)}`}>{usd(t.amount, true)}</span>}
                  <time className="feed-time" dateTime={new Date(e.t).toISOString()}>{fmtTime(e.t)}</time>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {items.length > limit && (
        <button type="button" className="more" onClick={() => setLimit(limit + FEED_PAGE)}>Показать ещё</button>
      )}
    </section>
  );
}

function TradeRow({ t, open }: { t: PersonaTrade; open: boolean }) {
  const ref = t.entryPrice ?? t.stop;
  return (
    <tr>
      <td>{coin(t.symbol)}</td>
      <td className={t.direction === "long" ? "up" : "down"}>{DIRECTION_LABEL[t.direction]}</td>
      <td>{fmtTime(t.entryTime)}</td>
      <td>{t.entryPrice === null ? "ждёт" : fmtPrice(t.entryPrice)}</td>
      {open ? (
        <>
          <td>{fmtPrice(t.stop, ref)}</td>
          <td>{fmtPrice(t.target, ref)}</td>
          <td>{fmtTime(t.expiresAt)}</td>
        </>
      ) : (
        <>
          <td>{fmtTime(t.exitTime)}</td>
          <td>{STATE_LABEL[t.state]}</td>
        </>
      )}
      <td className={tone(t.pnlUsd)}>{usd(t.pnlUsd, true)}</td>
      <td className={tone(t.r)}>{t.r === null ? "—" : `${t.r > 0 ? "+" : ""}${fmtNum(t.r, 2)}R`}</td>
      <td title={t.notes.join("; ") || undefined}>{fmtPct(t.riskFraction, 2).replace("+", "")}{t.notes.length > 0 ? " ▲" : ""}</td>
      <td>{t.mode === "live" ? "" : t.mode === "replay" ? "реплей" : "с опозданием"}</td>
    </tr>
  );
}

function RiskPanel({ p }: { p: PersonaSummary }) {
  const r = p.risk;
  if (!r) return null;
  return (
    <>
      <h3>Защита капитала</h3>
      <dl className="kv">
        <dt>Режим</dt><dd><RiskBadge p={p} /></dd>
        <dt>Просадка от максимума</dt><dd>{fmtPct(r.drawdownPct, 1)}</dd>
        <dt>Риск на следующую сделку</dt><dd>{fmtPct(r.riskFraction, 2).replace("+", "")}</dd>
        <dt>За последние 24 часа</dt><dd className={tone(r.dayPnlPct)}>{fmtPct(r.dayPnlPct, 2)}</dd>
        <dt>На охлаждении</dt><dd>{r.cooling.length === 0 ? "нет" : r.cooling.join(", ")}</dd>
        <dt>Пропущено сигналов ради защиты</dt><dd>{r.skipped}</dd>
        <dt>Пропущено невыгодных сигналов</dt><dd>{r.notWorth}</dd>
      </dl>
    </>
  );
}

const HISTORY_PAGE = 20;

function PersonaDetail({ p, snapshot, names }: { p: PersonaSummary; snapshot: PersonasSnapshot; names: (id: string) => string }) {
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE);
  const [full, setFull] = useState<{ state: "idle" | "loading" | "error"; trades: PersonaTrade[] | null; message?: string }>({ state: "idle", trades: null });
  const history = full.trades ?? p.history;
  const loadFull = async () => {
    setFull({ state: "loading", trades: null });
    try {
      const reader = new DataBranchReader(process.env.NEXT_PUBLIC_DATA_BRANCH_URL || undefined);
      const [entries, exits] = await Promise.all([
        reader.readJsonl<PersonaEntry>(`personas/${p.id}/entries.jsonl`),
        reader.readJsonl<PersonaExit>(`personas/${p.id}/exits.jsonl`),
      ]);
      setFull({ state: "idle", trades: closedTrades(entries, exits) });
    } catch (e) {
      setFull({ state: "error", trades: null, message: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <section className="panel detail" aria-labelledby="detail-title">
      <h2 id="detail-title"><span aria-hidden="true">{p.emoji}</span> {p.name}</h2>
      <p className="hint">{p.tagline}{p.strategyVersion ? ` · стратегия ${p.strategyKey}@${p.strategyVersion}` : ""}</p>
      <h3>Правила</h3>
      <ul className="rules">{p.rules.map((r) => <li key={r}>{r}</li>)}</ul>
      <p className="hint">
        Торгует с {fmtTime(snapshot.startedAt)} МСК, стартовый капитал {usd(snapshot.initialEquity)}. Все решения — в реальном времени.
      </p>

      {p.kind === "signals" ? (
        <>
          <RiskPanel p={p} />
          <h3>Открытые позиции · {p.open.length}</h3>
          {p.open.length === 0 ? <p className="hint">Нет — ждёт сигнала.</p> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Монета</th><th>Сторона</th><th>Вход, МСК</th><th>Цена входа</th><th>Стоп</th><th>Цель</th><th>Истекает</th><th>Сейчас</th><th>R</th><th>Риск</th><th /></tr></thead>
                <tbody>{p.open.map((t) => <TradeRow key={`${t.symbol}-${t.decidedAt}`} t={t} open />)}</tbody>
              </table>
            </div>
          )}
          <h3>Закрытые сделки · {p.closedTrades}</h3>
          {history.length === 0 ? <p className="hint">Пока нет.</p> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Монета</th><th>Сторона</th><th>Вход, МСК</th><th>Цена входа</th><th>Выход, МСК</th><th>Как</th><th>Результат</th><th>R</th><th>Риск</th><th /></tr></thead>
                <tbody>{history.slice(0, historyLimit).map((t) => <TradeRow key={`${t.symbol}-${t.decidedAt}`} t={t} open={false} />)}</tbody>
              </table>
            </div>
          )}
          {history.length > historyLimit ? (
            <button type="button" className="more" onClick={() => setHistoryLimit(historyLimit + HISTORY_PAGE)}>
              Показать ещё ({historyLimit} из {history.length})
            </button>
          ) : full.trades === null && p.closedTrades > p.history.length ? (
            <button type="button" className="more" onClick={() => void loadFull()} disabled={full.state === "loading"}>
              {full.state === "loading" ? "Загружаю…" : `Загрузить всю историю с начала (${p.closedTrades})`}
            </button>
          ) : null}
          {full.state === "error" && <p className="error">{full.message}</p>}
        </>
      ) : p.kind === "manager" ? (
        <>
          <h3>У кого деньги</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Персонаж</th><th>Сумма</th><th>Доля</th></tr></thead>
              <tbody>
                {[...p.allocations].sort((a, b) => b.value - a.value).map((a) => (
                  <tr key={a.personaId}><td>{names(a.personaId)}</td><td>{usd(a.value)}</td><td>{fmtPct(a.value / p.equity, 0).replace("+", "")}</td></tr>
                ))}
                <tr><td>$</td><td>{usd(p.cash)}</td><td>{fmtPct((p.cash ?? 0) / p.equity, 0).replace("+", "")}</td></tr>
              </tbody>
            </table>
          </div>
          <h3>Решения</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Когда, МСК</th><th>Распределил</th><th>Издержки</th><th>Почему</th><th /></tr></thead>
              <tbody>
                {p.rebalances.map((r) => (
                  <tr key={r.at}><td>{fmtTime(r.at)}</td><td className="wrap">{weightsText(r.weights, names)}</td><td>{usd(r.costUsd)}</td><td className="wrap">{r.note}</td><td>{r.mode === "live" ? "" : r.mode === "replay" ? "реплей" : "с опозданием"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <h3>Портфель</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Актив</th><th>Количество</th><th>Цена</th><th>Стоимость</th></tr></thead>
              <tbody>
                {p.holdings.map((h) => (
                  <tr key={h.symbol}><td>{coin(h.symbol)}</td><td>{fmtNum(h.qty, 6)}</td><td>{fmtPrice(h.price)}</td><td>{usd(h.value)}</td></tr>
                ))}
                <tr><td>$</td><td /><td /><td>{usd(p.cash)}</td></tr>
              </tbody>
            </table>
          </div>
          <h3>Перестановки</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Когда, МСК</th><th>Стал держать</th><th>Издержки</th><th>Почему</th><th /></tr></thead>
              <tbody>
                {p.rebalances.map((r) => (
                  <tr key={r.at}><td>{fmtTime(r.at)}</td><td>{weightsText(r.weights)}</td><td>{usd(r.costUsd)}</td><td className="wrap">{r.note}</td><td>{r.mode === "live" ? "" : r.mode === "replay" ? "реплей" : "с опозданием"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export function Traders() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const theme = useTheme();

  useEffect(() => {
    const reader = new DataBranchReader(process.env.NEXT_PUBLIC_DATA_BRANCH_URL || undefined);
    const controller = new AbortController();
    const fetchState = async (first: boolean) => {
      try {
        const data = await reader.readJson<PersonasSnapshot>(PERSONAS_STATE_PATH, controller.signal);
        if (data) setLoad({ state: "ready", data });
        else if (first) setLoad({ state: "error", message: "Персонажи ещё не запускались: в ветке data нет personas/state.json." });
      } catch (e) {
        if (first && !controller.signal.aborted) setLoad({ state: "error", message: e instanceof Error ? e.message : String(e) });
      }
    };
    void fetchState(true);
    const timer = setInterval(() => void fetchState(false), REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  const snapshot = load.state === "ready" ? load.data : null;
  const [live, setLive] = useState<{ prices: LivePrices; at: number } | { error: string } | null>(null);
  const symbolsKey = snapshot ? Object.keys(snapshot.prices).sort().join(",") : "";
  useEffect(() => {
    if (!symbolsKey) return;
    const controller = new AbortController();
    const tick = async () => {
      try {
        const prices = await fetchLivePrices(symbolsKey.split(","), controller.signal);
        setLive({ prices, at: Date.now() });
      } catch (e) {
        if (!controller.signal.aborted) setLive({ error: e instanceof Error ? e.message : String(e) });
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), LIVE_PRICES_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [symbolsKey]);
  const shown = useMemo(
    () => (snapshot && live && "prices" in live ? applyLive(snapshot, liveView(snapshot, live.prices), live.at) : snapshot),
    [snapshot, live],
  );
  const ids = useMemo(() => snapshot?.personas.map((p) => p.id) ?? [], [snapshot]);
  const colorVar = useCallback((id: string) => colorVarFor(ids, id), [ids]);
  const ranked = useMemo(() => (shown ? rankPersonas(shown.personas) : []), [shown]);
  const visible = useMemo(() => new Set(ids.filter((id) => !hidden.has(id))), [ids, hidden]);
  const names = useCallback((id: string) => snapshot?.personas.find((p) => p.id === id)?.name ?? id, [snapshot]);
  const formatClockSeconds = (t: number) => new Intl.DateTimeFormat("ru-RU", { timeZone: DISPLAY_TIME_ZONE, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(t);

  if (load.state === "loading") return <p className="hint">Загружаю состояние трейдеров…</p>;
  if (load.state === "error" || !shown) return <p className="error">{load.state === "error" ? load.message : ""}</p>;
  const s = shown;
  const active = s.personas.find((p) => p.id === (selected ?? ranked[0]?.id)) ?? null;
  const lastPrice = Math.max(...Object.values(s.prices).map((p) => p.time));
  const toggle = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setHidden(next);
  };

  return (
    <div className="traders">
      <p className="hint">
        Старт {fmtTime(s.startedAt)} МСК, у каждого было {usd(s.initialEquity)} виртуальных денег. Решения принимаются каждые 15 минут
        (последний цикл {fmtTime(s.generatedAt)} МСК, закрытые свечи до {fmtTime(lastPrice)} МСК).{" "}
        {live && "prices" in live
          ? <span className="live-dot">Открытые позиции оценены по ценам Binance на {formatClockSeconds(live.at)} МСК, обновление каждые 30 с.</span>
          : live && "error" in live
            ? <span className="warn">Живые цены недоступны ({live.error}) — показана оценка последнего цикла.</span>
            : null}{" "}
        Комиссия {fmtPct(s.costs.feeRate, 1).replace("+", "")} и проскальзывание {fmtPct(s.costs.slippage, 2).replace("+", "")} на сторону учтены.
      </p>

      <section aria-label="Рейтинг" className="leaderboard">
        {ranked.map((p, i) => (
          <PersonaCard
            key={p.id} p={p} rank={i + 1} color={colorVar(p.id)} initial={s.initialEquity}
            selected={active?.id === p.id} onSelect={() => setSelected(p.id)} names={names}
          />
        ))}
      </section>

      <section className="panel chart-panel" aria-labelledby="equity-title">
        <div className="chart-head">
          <h2 id="equity-title">Капитал, $</h2>
          <div className="toggles" role="group" aria-label="Показать на графике">
            {s.personas.map((p) => (
              <label key={p.id} className="chip">
                <input type="checkbox" checked={visible.has(p.id)} onChange={() => toggle(p.id)} />
                <span className="swatch" style={{ background: `var(${colorVar(p.id)})` }} />
                <span aria-hidden="true">{p.emoji}</span>{p.name}
              </label>
            ))}
          </div>
        </div>
        <EquityChart personas={s.personas} colorVar={colorVar} visible={visible} selected={active?.id ?? null} initialEquity={s.initialEquity} theme={theme} />
        <p className="replay-note hint">Пунктир — стартовые {usd(s.initialEquity)}. Точки каждые 4 часа, последняя — сейчас; открытые позиции оценены по текущей цене.</p>
      </section>

      <div className="columns">
        {active && <PersonaDetail key={active.id} p={active} snapshot={s} names={names} />}
        <Feed feed={s.feed} personas={s.personas} colorVar={colorVar} names={names} />
      </div>
    </div>
  );
}
