import type { Timeframe, UnixMs } from "@/core/time";
import type { MarketSymbol } from "@/modules/market-data";

/**
 * Виртуальные трейдеры: каждый торгует на бумаге по своим правилам на живых
 * публичных данных Binance Spot. Реальных ордеров и ключей нет.
 */

/** Общий старт всех счетов. После конца разбиения research/validation/holdout (2026-10-01). */
export const PERSONA_START: UnixMs = Date.UTC(2026, 9, 1);
export const INITIAL_EQUITY = 10_000;
/** Риск на сделку от текущего капитала. */
export const RISK_PER_TRADE = 0.01;
/** Номинал одной позиции не больше этой доли капитала: 5 символов × 20% — без плеча. */
export const MAX_POSITION_SHARE = 0.2;
export const PERSONA_SYMBOLS: MarketSymbol[] = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT"];

interface PersonaBase {
  id: string;
  name: string;
  emoji: string;
  tagline: string;
  /** Правила простыми словами — то же, что делает код. */
  rules: string[];
  timeframe: Timeframe;
  symbols: MarketSymbol[];
}

export interface SignalPersonaDef extends PersonaBase {
  kind: "signals";
  /** Ключ в реестре стратегий. */
  strategyKey: string;
}

export interface PortfolioPersonaDef extends PersonaBase {
  kind: "portfolio";
  /** once — одна покупка на старте; weekly — старт и каждый понедельник 00:00 UTC (03:00 МСК). */
  schedule: "once" | "weekly";
  allocation: { type: "fixed"; weights: Record<MarketSymbol, number> } | { type: "momentum"; lookbackDays: number; top: number };
}

export type PersonaDef = SignalPersonaDef | PortfolioPersonaDef;

const RISK_RULE = "Риск 1% капитала на сделку, позиция не больше 20% капитала. Комиссия 0,1% и проскальзывание 0,02% на сторону.";

export const PERSONAS: PersonaDef[] = [
  {
    id: "trend",
    name: "Трендовик",
    emoji: "🐢",
    tagline: "Входит на пробое канала и едет по тренду",
    kind: "signals",
    strategyKey: "donchian-breakout-4h",
    timeframe: "4h",
    symbols: PERSONA_SYMBOLS,
    rules: [
      "Смотрит на 4-часовые свечи.",
      "Покупает, когда свеча закрылась выше максимума последних 48 свечей (8 дней) и выше EMA 200; продаёт в шорт зеркально.",
      "Стоп — 2 ATR от входа, цель — 3 риска (3R), сделка закрывается через 72 свечи (12 дней), если ничего не сработало.",
      RISK_RULE,
    ],
  },
  {
    id: "sniper",
    name: "Снайпер откатов",
    emoji: "🎯",
    tagline: "Ждёт отката внутри тренда и стреляет",
    kind: "signals",
    strategyKey: "trend-pullback",
    timeframe: "15m",
    symbols: PERSONA_SYMBOLS,
    rules: [
      "Тренд определяет по часовым свечам: EMA 50 растёт и цена выше неё (для шорта — наоборот).",
      "На 15-минутках ждёт касания EMA 20 и закрытия за максимумом предыдущей свечи.",
      "Пропускает слишком тихий и слишком бурный рынок (ATR вне 20–80-го перцентиля за 30 дней).",
      "Стоп — за экстремумом отката, цель — 2R, срок — 4 часа.",
      RISK_RULE,
    ],
  },
  {
    id: "contrarian",
    name: "Контрарианец",
    emoji: "🪃",
    tagline: "Покупает панику, продаёт эйфорию",
    kind: "signals",
    strategyKey: "mean-reversion",
    timeframe: "1h",
    symbols: PERSONA_SYMBOLS,
    rules: [
      "Смотрит на часовые свечи.",
      "Покупает, когда цена закрылась ниже нижней полосы Боллинджера (20, 2σ) и RSI 14 ниже 30; продаёт в шорт выше верхней полосы при RSI выше 70.",
      "Цель — средняя линия полос, стоп — 1,5 ATR, срок — 24 часа.",
      RISK_RULE,
    ],
  },
  {
    id: "coin",
    name: "Монетка",
    emoji: "🎲",
    tagline: "Входит наугад — контроль для остальных",
    kind: "signals",
    strategyKey: "random-entry",
    timeframe: "4h",
    symbols: PERSONA_SYMBOLS,
    rules: [
      "На каждой 4-часовой свече с вероятностью 5% входит в случайную сторону.",
      "Выходы как у Трендовика: стоп 2 ATR, цель 3R, срок 12 дней.",
      "Если стратегия не обгоняет Монетку, её «преимущество» — случайность.",
      RISK_RULE,
    ],
  },
  {
    id: "rotator",
    name: "Ротатор",
    emoji: "🔄",
    tagline: "Раз в неделю пересаживается в самых сильных",
    kind: "portfolio",
    schedule: "weekly",
    allocation: { type: "momentum", lookbackDays: 28, top: 2 },
    timeframe: "1d",
    symbols: PERSONA_SYMBOLS,
    rules: [
      "Каждый понедельник в 03:00 МСК сравнивает рост монет за 28 дней по дневным свечам.",
      "Держит две самые сильные поровну; монету с отрицательным ростом не берёт — эта доля остаётся в долларах.",
      "Только покупки, без шортов и плеча. Комиссия и проскальзывание — с объёма каждой перестановки.",
    ],
  },
  {
    id: "holder",
    name: "Холдер",
    emoji: "💎",
    tagline: "Купил биткоин и ничего не делает",
    kind: "portfolio",
    schedule: "once",
    allocation: { type: "fixed", weights: { "BTC/USDT": 1 } },
    timeframe: "1d",
    symbols: ["BTC/USDT"],
    rules: [
      "1 октября 2026 купил BTC на весь капитал и держит.",
      "Эталон «ничего не делать»: активный стиль имеет смысл, только если обгоняет его.",
    ],
  },
];
