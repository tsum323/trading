import type { TradingSignal } from "@/modules/strategies";

/**
 * AI-модуль объясняет уже сформированный детерминированный сигнал и
 * рыночный контекст. Он не создаёт сигналы, не меняет их уровни и не
 * участвует в бэктесте: его вывод нельзя проверить на истории без утечки.
 */
export interface ExplanationRequest {
  signal: TradingSignal;
  /** Сжатое числовое описание контекста (индикаторы, диапазоны), без сырых свечей будущего. */
  context: Record<string, number | string>;
  language: "ru" | "en";
}

export interface Explanation {
  signalId: string;
  /** Идентификатор модели/провайдера для воспроизводимости. */
  model: string;
  createdAt: number;
  summary: string;
  /** Сценарии, при которых гипотеза неверна. Обязательное поле. */
  invalidationScenarios: string[];
  /** Явная оговорка: объяснение не является доказательством прибыльности. */
  disclaimer: string;
}

export interface MarketExplainer {
  readonly id: string;
  explain(request: ExplanationRequest, signal?: AbortSignal): Promise<Explanation>;
}
