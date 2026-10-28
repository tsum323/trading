"use client";

import { useState } from "react";
import { DEFAULT_COSTS } from "@/modules/backtest";
import { MAX_RISK_FRACTION, positionSize } from "@/modules/risk";
import type { SignalDirection } from "@/modules/strategies";
import { fmtNum } from "./format";

interface Props {
  symbol: string;
  /** Подсказка для полей «вход» и «стоп»: последняя закрытая цена и ATR. */
  lastPrice: number | null;
  atr: number | null;
}

/**
 * Калькулятор размера позиции по фиксированной доле риска. Ничего не исполняет.
 * Подсказки (вход = последняя цена, стоп = 2 × ATR) ставятся при монтировании —
 * родитель пересоздаёт компонент при смене символа или таймфрейма (`key`), —
 * и по кнопке; обновление цены не затирает введённые вручную значения.
 */
export function RiskCalculator({ symbol, lastPrice, atr }: Props) {
  const [equity, setEquity] = useState("10000");
  const [riskPct, setRiskPct] = useState("0.5");
  const [direction, setDirection] = useState<SignalDirection>("long");
  const [entry, setEntry] = useState(lastPrice == null ? "" : String(lastPrice));
  const [stop, setStop] = useState(suggestStop("long", lastPrice, atr));
  const [feePct, setFeePct] = useState(String(DEFAULT_COSTS.feeRate * 100));

  const applySuggestion = (dir: SignalDirection) => {
    if (lastPrice == null) return;
    setEntry(String(lastPrice));
    setStop(suggestStop(dir, lastPrice, atr));
  };

  let result: ReturnType<typeof positionSize> | null = null;
  let error: string | null = null;
  try {
    result = positionSize({
      equity: Number(equity),
      riskFraction: Number(riskPct) / 100,
      direction,
      entry: Number(entry),
      stopLoss: Number(stop),
      feeRate: Number(feePct) / 100,
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const base = symbol.split("/")[0];
  const quote = symbol.split("/")[1];
  const stopPct = Math.abs(Number(entry) - Number(stop)) / Number(entry);

  return (
    <section className="panel" aria-labelledby="risk-title">
      <h2 id="risk-title">Калькулятор риска</h2>
      <p className="hint">Размер позиции, при котором срабатывание стопа стоит заданную долю капитала, включая комиссии входа и выхода. Капитал условный.</p>
      <div className="form">
        <label>Капитал, {quote}<input inputMode="decimal" value={equity} onChange={(e) => setEquity(e.target.value)} /></label>
        <label>Риск, % (≤ {MAX_RISK_FRACTION * 100})<input inputMode="decimal" value={riskPct} onChange={(e) => setRiskPct(e.target.value)} /></label>
        <label>Направление
          <select
            value={direction}
            onChange={(e) => {
              const dir = e.target.value as SignalDirection;
              setDirection(dir);
              applySuggestion(dir);
            }}
          >
            <option value="long">long</option>
            <option value="short">short</option>
          </select>
        </label>
        <label>Вход<input inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} /></label>
        <label>Стоп<input inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value)} /></label>
        <label>Комиссия, % за сторону<input inputMode="decimal" value={feePct} onChange={(e) => setFeePct(e.target.value)} /></label>
      </div>
      <p className="hint">
        <button type="button" onClick={() => applySuggestion(direction)} disabled={lastPrice == null}>
          Подставить текущую цену и стоп 2·ATR
        </button>
      </p>
      {error ? (
        <p className="error" role="alert">{translateRiskError(error)}</p>
      ) : result ? (
        <dl className="kv">
          <dt>Объём</dt><dd>{fmtNum(result.quantity, 6)} {base}</dd>
          <dt>Номинал</dt><dd>{fmtNum(result.notional, 2)} {quote}</dd>
          <dt>Риск</dt><dd>{fmtNum(result.riskAmount, 2)} {quote}</dd>
          <dt>Стоп от входа</dt><dd>{fmtNum(stopPct * 100, 2)}%</dd>
          <dt>Издержки в R</dt><dd>≈ {fmtNum((2 * (Number(feePct) / 100 + DEFAULT_COSTS.slippage)) / stopPct, 2)} R</dd>
          {result.notional > Number(equity) && (
            <><dt>Внимание</dt><dd className="warn">номинал больше капитала — нужно плечо</dd></>
          )}
        </dl>
      ) : null}
    </section>
  );
}

const fmtPlain = (x: number) => String(Number(x.toPrecision(8)));

function suggestStop(direction: SignalDirection, price: number | null, atr: number | null): string {
  if (price == null || atr == null) return "";
  return fmtPlain(direction === "long" ? price - 2 * atr : price + 2 * atr);
}

function translateRiskError(message: string): string {
  if (message.includes("wrong side")) return "Стоп должен быть ниже входа для long и выше входа для short.";
  if (message.includes("riskFraction")) return `Риск должен быть больше 0 и не больше ${MAX_RISK_FRACTION * 100}% капитала.`;
  if (message.includes("equity")) return "Капитал должен быть больше нуля.";
  if (message.includes("feeRate")) return "Комиссия должна быть от 0 до 1%.";
  return "Проверьте числа: вход и стоп должны быть больше нуля.";
}
