import type { SignalDirection } from "@/modules/strategies";

export interface RiskInput {
  /** Условный капитал для расчёта; не связан с реальным счётом. */
  equity: number;
  /** Доля капитала, которой рискуем в одной идее, например 0.005 = 0.5%. */
  riskFraction: number;
  direction: SignalDirection;
  entry: number;
  stopLoss: number;
  /** Комиссия за сторону как доля от объёма, например 0.001 = 0.1%. */
  feeRate?: number;
}

export interface RiskResult {
  /** Объём позиции в базовой валюте. */
  quantity: number;
  /** Номинал позиции в котируемой валюте. */
  notional: number;
  /** Сумма, теряемая при срабатывании стопа, включая комиссии входа и выхода. */
  riskAmount: number;
  /** Убыток на единицу актива при срабатывании стопа, включая комиссии. */
  lossPerUnit: number;
}

export const MAX_RISK_FRACTION = 0.02;

/**
 * Убыток на единицу актива при выходе точно по стопу, включая комиссии входа
 * и выхода. Это и есть 1R. Если стоп по неверную сторону входа — RangeError.
 */
export function lossPerUnit(direction: SignalDirection, entry: number, stopLoss: number, feeRate = 0): number {
  const priceRisk = direction === "long" ? entry - stopLoss : stopLoss - entry;
  if (priceRisk <= 0) throw new RangeError("stopLoss is on the wrong side of entry");
  return priceRisk + feeRate * (entry + stopLoss);
}

/**
 * Размер позиции по фиксированной доле риска. Проскальзывание не учитывается —
 * это делается в оценщике исходов.
 */
export function positionSize(input: RiskInput): RiskResult {
  const { equity, riskFraction, direction, entry, stopLoss, feeRate = 0 } = input;
  if (!(equity > 0)) throw new RangeError("equity must be > 0");
  if (!(riskFraction > 0 && riskFraction <= MAX_RISK_FRACTION)) {
    throw new RangeError(`riskFraction must be in (0, ${MAX_RISK_FRACTION}]`);
  }
  if (!(entry > 0 && stopLoss > 0)) throw new RangeError("prices must be > 0");
  if (!(feeRate >= 0 && feeRate < 0.01)) throw new RangeError("feeRate must be in [0, 0.01)");

  const perUnit = lossPerUnit(direction, entry, stopLoss, feeRate);
  const riskAmount = equity * riskFraction;
  const quantity = riskAmount / perUnit;
  return { quantity, notional: quantity * entry, riskAmount, lossPerUnit: perUnit };
}
