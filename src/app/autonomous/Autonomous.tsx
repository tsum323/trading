"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DISPLAY_TIME_ZONE } from "@/core/time";
import { LOSS_REASON_TEXT } from "@/services/autonomous/brain";
import { DataBranchReader } from "@/services/data-branch";
import { PERSONAS_STATE_PATH, type AutonomousView, type FeedEvent, type PersonaSummary, type PersonasSnapshot, type PersonaTrade } from "@/services/personas/types";
import { fmtNum, fmtPct, fmtPrice, fmtTime } from "../terminal/format";
import { EquityChart } from "../traders/EquityChart";
import { applyLive, fetchLivePrices, liveView, type LivePrices } from "../traders/live";
import { coin, DIRECTION_LABEL, RISK_STATUS_LABEL, SKIP_LABEL, STATE_LABEL } from "../traders/model";

const REFRESH_MS = 60_000;
const LIVE_PRICES_MS = 30_000;

const usd = (x: number | null | undefined, signed = false) =>
  x == null || !Number.isFinite(x) ? "—" : `${signed && x > 0 ? "+" : x < 0 ? "−" : ""}$${fmtNum(Math.abs(x), Math.abs(x) >= 1000 ? 0 : 2)}`;
const tone = (x: number | null | undefined) => (x == null || x === 0 ? "" : x > 0 ? "up" : "down");
const rr = (x: number | null | undefined) => (x == null ? "—" : `${x > 0 ? "+" : ""}${fmtNum(x, 2)}R`);
const pct = (x: number) => fmtPct(x, 2);

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

/** Значение кривой на момент t (последняя точка не позже t). */
function curveAt(curve: readonly [number, number][], t: number): number | null {
  let v: number | null = null;
  for (const [x, y] of curve) {
    if (x > t) break;
    v = y;
  }
  return v;
}

/** Доходность эталона за время жизни бота: по кривой персонажа общего рейтинга. */
function sinceStart(p: PersonaSummary | undefined, startedAt: number): number | null {
  if (!p) return null;
  const then = curveAt(p.curve, startedAt);
  return then ? p.equity / then - 1 : null;
}

const DIARY_ICON: Record<string, string> = {
  start: "🚀", trust: "🤝", distrust: "✋", postmortem: "🔍", lesson: "📌", revoke: "↩️", confirm: "✅", demote: "⬇️", "slow-down": "🐌", day: "📅",
};

function TradeTable({ trades, open }: { trades: PersonaTrade[]; open: boolean }) {
  if (trades.length === 0) return <p className="hint">{open ? "Нет открытых позиций." : "Пока нет."}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Монета</th><th>Сторона</th><th>Вход, МСК</th><th>Цена входа</th>
            {open ? <><th>Стоп</th><th>Цель</th></> : <><th>Выход, МСК</th><th>Как</th></>}
            <th>Результат</th><th>R</th><th>Почему вошёл</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={`${t.symbol}-${t.decidedAt}`}>
              <td>{coin(t.symbol)}</td>
              <td className={t.direction === "long" ? "up" : "down"}>{DIRECTION_LABEL[t.direction]}</td>
              <td>{fmtTime(t.entryTime)}</td>
              <td>{t.entryPrice === null ? "ждёт" : fmtPrice(t.entryPrice)}</td>
              {open ? (
                <><td>{fmtPrice(t.stop, t.entryPrice ?? t.stop)}</td><td>{fmtPrice(t.target, t.entryPrice ?? t.target)}</td></>
              ) : (
                <><td>{fmtTime(t.exitTime)}</td><td>{STATE_LABEL[t.state]}</td></>
              )}
              <td className={tone(t.pnlUsd)}>{usd(t.pnlUsd, true)}</td>
              <td className={tone(t.r)}>{rr(t.r)}</td>
              <td className="wrap">{t.notes[0] ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function feedLine(e: FeedEvent): { title: string; amount?: number } | null {
  if (e.kind === "open") return { title: `Вход ${DIRECTION_LABEL[e.direction]} ${coin(e.symbol)}${e.price === null ? "" : ` по ${fmtPrice(e.price)}`}` };
  if (e.kind === "close") return { title: `Выход ${DIRECTION_LABEL[e.direction]} ${coin(e.symbol)} ${STATE_LABEL[e.state]} ${rr(e.r)}`, amount: e.pnlUsd };
  if (e.kind === "skip") return { title: `Пропустил ${DIRECTION_LABEL[e.direction]} ${coin(e.symbol)}: ${SKIP_LABEL[e.reason]}` };
  return null;
}

function Body({ s, a, liveAt }: { s: PersonasSnapshot; a: AutonomousView; liveAt: number | null }) {
  const theme = useTheme();
  const [diaryLimit, setDiaryLimit] = useState(30);
  const p = a.summary;
  const pnl = p.equity - s.initialEquity;
  const holder = sinceStart(s.personas.find((x) => x.id === "holder"), a.startedAt);
  const coinP = sinceStart(s.personas.find((x) => x.id === "coin"), a.startedAt);
  const colorVar = useCallback(() => "--p-1", []);
  const visible = useMemo(() => new Set([p.id]), [p.id]);
  const trusted = a.skills.filter((k) => k.trusted);
  const reasons = Object.entries(a.reasons).sort((x, y) => y[1] - x[1]);
  const wins = p.closedTrades === 0 ? null : p.wins / p.closedTrades;

  return (
    <div className="traders">
      <section className="panel auto-hero">
        <div className="auto-title">
          <span className="persona-emoji" aria-hidden="true">{p.emoji}</span>
          <div>
            <h2>{p.name}</h2>
            <p className="hint">{p.tagline}. Свой банк и свой старт — {fmtTime(a.startedAt)} МСК; с другими персонажами деньгами не связан.</p>
          </div>
        </div>
        <div className="stats">
          <div className="stat"><div className="stat-label">Счёт</div><div className="stat-value">{usd(p.equity)}</div><div className={`stat-sub ${tone(pnl)}`}>{pct(p.returnPct)} · {usd(pnl, true)}</div></div>
          <div className="stat"><div className="stat-label">BTC за то же время (Холдер)</div><div className={`stat-value ${tone(holder)}`}>{holder === null ? "—" : pct(holder)}</div><div className="stat-sub">ничего не делать</div></div>
          <div className="stat"><div className="stat-label">Монетка за то же время</div><div className={`stat-value ${tone(coinP)}`}>{coinP === null ? "—" : pct(coinP)}</div><div className="stat-sub">случайные входы</div></div>
          <div className="stat"><div className="stat-label">Сделок закрыто</div><div className="stat-value">{p.closedTrades}</div><div className="stat-sub">в плюс {wins === null ? "—" : fmtPct(wins, 0).replace("+", "")} · открыто {p.open.length}</div></div>
          <div className="stat"><div className="stat-label">Просадка</div><div className="stat-value">{fmtPct(p.maxDrawdownPct, 1)}</div><div className="stat-sub">{p.risk ? `${RISK_STATUS_LABEL[p.risk.status]} · риск ${fmtPct(p.risk.riskFraction, 2).replace("+", "")}` : ""}</div></div>
          <div className="stat"><div className="stat-label">Доверяет навыкам</div><div className="stat-value">{trusted.length} из {a.skills.length}</div><div className="stat-sub">разборов убытков: {a.postmortems}</div></div>
        </div>
        <p className="hint">
          {liveAt !== null ? <span className="live-dot">Открытые позиции оценены по ценам Binance на {new Intl.DateTimeFormat("ru-RU", { timeZone: DISPLAY_TIME_ZONE, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(liveAt)} МСК. </span> : null}
          Решения — каждые 15 минут, последний цикл {fmtTime(s.generatedAt)} МСК. Навыки тренируются «в уме» с {fmtTime(a.shadowFrom)} МСК.
        </p>
      </section>

      <section className="panel chart-panel" aria-labelledby="auto-equity">
        <div className="chart-head"><h2 id="auto-equity">Счёт, $</h2></div>
        <EquityChart personas={[p]} colorVar={colorVar} visible={visible} selected={p.id} initialEquity={s.initialEquity} theme={theme} />
      </section>

      <div className="columns">
        <section className="panel" aria-labelledby="auto-diary">
          <h2 id="auto-diary">Дневник</h2>
          <p className="hint">Что он заметил, где ошибся и что меняет. Пишется по правилам, без выдумок: каждая запись — из его журналов.</p>
          <ol className="feed-list">
            {a.diary.slice(0, diaryLimit).map((d, i) => (
              <li key={`${d.t}-${i}`} className="feed-item">
                <span className="feed-emoji" aria-hidden="true">{DIARY_ICON[d.kind] ?? "•"}</span>
                <div className="feed-body"><div className="feed-title diary-text">{d.text}</div></div>
                <div className="feed-side"><time className="feed-time">{fmtTime(d.t)}</time></div>
              </li>
            ))}
          </ol>
          {a.diary.length > diaryLimit && <button type="button" className="more" onClick={() => setDiaryLimit(diaryLimit + 30)}>Показать ещё</button>}
        </section>

        <div className="traders">
          <section className="panel" aria-labelledby="auto-skills">
            <h2 id="auto-skills">Навыки</h2>
            <p className="hint">Все торгуют «в уме» без денег. Деньги — только у отмеченных: у них лучшая оценка по свежим сделкам.</p>
            <div className="table-wrap">
              <table>
                <thead><tr><th /><th>Навык</th><th>Сделок</th><th>Среднее</th><th>Оценка</th></tr></thead>
                <tbody>
                  {a.skills.map((k) => (
                    <tr key={k.id}>
                      <td title={k.trusted ? "доверяет деньги" : k.demoted ? "понижен за ошибки" : "только тренируется"}>{k.trusted ? "💰" : k.demoted ? "⬇️" : "🧪"}</td>
                      <td className="wrap">{k.label}</td>
                      <td>{k.trades}</td>
                      <td className={tone(k.meanR)}>{rr(k.meanR)}</td>
                      <td className={tone(k.score)}>{rr(k.score)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel" aria-labelledby="auto-lessons">
            <h2 id="auto-lessons">Уроки</h2>
            {a.lessons.length === 0 ? <p className="hint">Пока ни одной повторяющейся ошибки — уроков нет.</p> : (
              <ul className="lessons">
                {a.lessons.map((l) => (
                  <li key={`${l.id}-${l.since}`} className={`lesson lesson-${l.status}`}>
                    <b>{l.status === "revoked" ? "↩️" : l.status === "confirmed" ? "✅" : "📌"} {l.title}</b>
                    <span className="hint"> — {l.rule}. С {fmtTime(l.since)} МСК{l.blocked ? `, отсёк сделок: ${l.blocked}` : ""}.</span>
                    <div className="hint">{l.status === "revoked" ? "Отменён: " : l.status === "confirmed" ? "Подтверждён: " : "Почему: "}{l.evidence}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel" aria-labelledby="auto-errors">
            <h2 id="auto-errors">Ошибки по разборам</h2>
            {reasons.length === 0 ? <p className="hint">Убыточных сделок с завершённым разбором пока нет.</p> : (
              <dl className="kv">
                {reasons.map(([r, n]) => (
                  <div key={r} style={{ display: "contents" }}><dt>{LOSS_REASON_TEXT[r as keyof typeof LOSS_REASON_TEXT] ?? r}</dt><dd>{n}</dd></div>
                ))}
              </dl>
            )}
          </section>
        </div>
      </div>

      <section className="panel" aria-labelledby="auto-open">
        <h2 id="auto-open">Открытые позиции · {p.open.length}</h2>
        <TradeTable trades={p.open} open />
        <h2>Закрытые сделки · {p.closedTrades}</h2>
        <TradeTable trades={p.history.slice(0, 50)} open={false} />
      </section>

      <section className="panel" aria-labelledby="auto-feed">
        <h2 id="auto-feed">Лента</h2>
        <ol className="feed-list">
          {a.feed.slice(0, 60).map((e, i) => {
            const f = feedLine(e);
            if (!f) return null;
            return (
              <li key={`${e.kind}-${e.t}-${i}`} className="feed-item">
                <span className="feed-emoji" aria-hidden="true">{p.emoji}</span>
                <div className="feed-body"><div className="feed-title">{f.title}</div></div>
                <div className="feed-side">
                  {f.amount !== undefined && <span className={`feed-amount ${tone(f.amount)}`}>{usd(f.amount, true)}</span>}
                  <time className="feed-time">{fmtTime(e.t)}</time>
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

export function Autonomous() {
  const [snapshot, setSnapshot] = useState<PersonasSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<{ prices: LivePrices; at: number } | null>(null);

  useEffect(() => {
    const reader = new DataBranchReader(process.env.NEXT_PUBLIC_DATA_BRANCH_URL || undefined);
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await reader.readJson<PersonasSnapshot>(PERSONAS_STATE_PATH, controller.signal);
        if (data) setSnapshot(data);
        else setError("Сводки ещё нет.");
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  const symbolsKey = snapshot ? Object.keys(snapshot.prices).sort().join(",") : "";
  useEffect(() => {
    if (!symbolsKey) return;
    const controller = new AbortController();
    const tick = async () => {
      try {
        setLive({ prices: await fetchLivePrices(symbolsKey.split(","), controller.signal), at: Date.now() });
      } catch {
        // Живые цены — только украшение: без них показывается оценка последнего цикла.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), LIVE_PRICES_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [symbolsKey]);

  const view = useMemo(() => {
    if (!snapshot?.autonomous) return null;
    if (!live) return snapshot.autonomous;
    // Пересчёт открытых позиций бота по живым ценам — тем же способом, что у остальных.
    const fake = { ...snapshot, personas: [snapshot.autonomous.summary] };
    const shown = applyLive(fake, liveView(fake, live.prices), live.at);
    return { ...snapshot.autonomous, summary: shown.personas[0]! };
  }, [snapshot, live]);

  if (error) return <p className="error">{error}</p>;
  if (!snapshot) return <p className="hint">Загружаю…</p>;
  if (!view) return <p className="hint">Автономный ещё не запускался — он стартует с первым циклом после обновления.</p>;
  return <Body s={snapshot} a={view} liveAt={live?.at ?? null} />;
}
