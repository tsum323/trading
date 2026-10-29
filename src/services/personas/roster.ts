import type { Timeframe, UnixMs } from "@/core/time";
import type { MarketSymbol } from "@/modules/market-data";

/**
 * Виртуальные трейдеры: каждый торгует на бумаге по своим правилам на живых
 * публичных данных Binance Spot. Реальных ордеров и ключей нет.
 */

/**
 * Момент старта всех счетов записывается первым циклом в этот файл ветки `data`:
 * персонажи торгуют только вперёд от запуска, без проигрывания истории.
 */
export const PERSONAS_START_PATH = "personas/start.json";

export interface PersonasStart {
  startedAt: UnixMs;
  codeCommit: string | null;
}
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
  /** Снижать риск по монете и направлению, где последние сделки в минусе (контроль — без этого). */
  adaptive: boolean;
}

export interface PortfolioPersonaDef extends PersonaBase {
  kind: "portfolio";
  /** once — одна покупка на старте; weekly — старт и каждый понедельник 00:00 UTC (03:00 МСК). */
  schedule: "once" | "weekly";
  allocation: { type: "fixed"; weights: Record<MarketSymbol, number> } | { type: "momentum"; lookbackDays: number; top: number };
}

/** Распределяет капитал между другими персонажами по их недавним результатам. */
export interface ManagerPersonaDef extends PersonaBase {
  kind: "manager";
  /** Между кем делить капитал. */
  candidates: string[];
  lookbackDays: number;
  maxWeight: number;
}

export type PersonaDef = SignalPersonaDef | PortfolioPersonaDef | ManagerPersonaDef;

const RISK_RULE = "Цель — вырастить счёт и не потерять его. Риск 1% капитала на сделку; при просадке от максимума −10% — 0,5%, при −20% — 0,25%.";
const PROTECTION_RULE = "Защита: за 24 часа потерял больше 3% — новых сделок нет; просадка −30% — пауза на неделю. Открытый риск всех позиций — не больше 3%, позиция — не больше 20% капитала.";
const ADAPT_RULE = "Учится на своих сделках: если по монете и направлению последние сделки (3–5) в сумме в минусе, рискует вчетверо меньше, пока не начнёт получаться.";
const COST_RULE = "Комиссия 0,1% и проскальзывание 0,02% на сторону.";
const WORTH_RULE = "Входит, только если сделка выгодна: до цели хотя бы в 1,5 раза дальше, чем до стопа, и комиссии с проскальзыванием съедают не больше трети прибыли по цели.";

export const PERSONAS: PersonaDef[] = [
  {
    id: "trend",
    name: "Трендовик",
    emoji: "🐢",
    tagline: "Входит на пробое канала и едет по тренду",
    kind: "signals",
    strategyKey: "donchian-breakout-4h",
    adaptive: true,
    timeframe: "4h",
    symbols: PERSONA_SYMBOLS,
    rules: [
      "Смотрит на 4-часовые свечи.",
      "Покупает, когда свеча закрылась выше максимума последних 48 свечей (8 дней) и выше EMA 200; продаёт в шорт зеркально.",
      "Стоп — 2 ATR от входа, цель — 3 риска (3R), сделка закрывается через 72 свечи (12 дней), если ничего не сработало.",
      WORTH_RULE,
      RISK_RULE,
      PROTECTION_RULE,
      ADAPT_RULE,
      COST_RULE,
    ],
  },
  {
    id: "sniper",
    name: "Снайпер откатов",
    emoji: "🎯",
    tagline: "Ждёт отката внутри тренда и стреляет",
    kind: "signals",
    strategyKey: "trend-pullback",
    adaptive: true,
    timeframe: "15m",
    symbols: PERSONA_SYMBOLS,
    rules: [
      "Тренд определяет по часовым свечам: EMA 50 растёт и цена выше неё (для шорта — наоборот).",
      "На 15-минутках ждёт касания EMA 20 и закрытия за максимумом предыдущей свечи.",
      "Пропускает слишком тихий и слишком бурный рынок (ATR вне 20–80-го перцентиля за 30 дней).",
      "Стоп — за экстремумом отката, цель — 2R, срок — 4 часа.",
      WORTH_RULE,
      RISK_RULE,
      PROTECTION_RULE,
      ADAPT_RULE,
      COST_RULE,
    ],
  },
  {
    id: "contrarian",
    name: "Контрарианец",
    emoji: "🪃",
    tagline: "Покупает панику, продаёт эйфорию",
    kind: "signals",
    strategyKey: "mean-reversion",
    adaptive: true,
    timeframe: "1h",
    symbols: PERSONA_SYMBOLS,
    rules: [
      "Смотрит на часовые свечи.",
      "Покупает, когда цена закрылась ниже нижней полосы Боллинджера (20, 2σ) и RSI 14 ниже 30; продаёт в шорт выше верхней полосы при RSI выше 70.",
      "Цель — средняя линия полос, стоп — 1,5 ATR, срок — 24 часа.",
      WORTH_RULE,
      RISK_RULE,
      PROTECTION_RULE,
      ADAPT_RULE,
      COST_RULE,
    ],
  },
  {
    id: "coin",
    name: "Монетка",
    emoji: "🎲",
    tagline: "Входит наугад — контроль для остальных",
    kind: "signals",
    strategyKey: "random-entry",
    adaptive: false,
    timeframe: "4h",
    symbols: PERSONA_SYMBOLS,
    rules: [
      "На каждой 4-часовой свече с вероятностью 5% входит в случайную сторону.",
      "Выходы как у Трендовика: стоп 2 ATR, цель 3R, срок 12 дней.",
      "Если стратегия не обгоняет Монетку, её «преимущество» — случайность.",
      WORTH_RULE,
      RISK_RULE,
      PROTECTION_RULE,
      "Не учится на своих сделках — иначе перестала бы быть контролем.",
      COST_RULE,
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
      "В момент запуска купил BTC на весь капитал и держит.",
      "Эталон «ничего не делать»: активный стиль имеет смысл, только если обгоняет его.",
    ],
  },
  {
    id: "crowd",
    name: "Против толпы",
    emoji: "🐋",
    tagline: "Ставит против перегруженных позиций на фьючерсах",
    kind: "signals",
    strategyKey: "crowding",
    adaptive: true,
    timeframe: "4h",
    symbols: PERSONA_SYMBOLS,
    rules: [
      "Смотрит на фьючерсы Binance: премию фьючерса к споту (из неё считается funding) и открытый интерес.",
      "Если средняя премия за 3 дня выше, чем в 90% случаев за последние 90 дней, а открытый интерес за 3 дня вырос больше чем на 3%, — лонги перегружены, открывает шорт. Зеркально: премия ниже, чем в 90% случаев, и интерес растёт — открывает лонг.",
      "Входит только в момент, когда перекос появился (на предыдущей свече его не было); решения — на закрытии 4-часовой свечи. Данные фьючерсов приходят с задержкой примерно в сутки.",
      "Стоп 2 ATR, цель 2R, срок 7 дней.",
      WORTH_RULE,
      RISK_RULE,
      PROTECTION_RULE,
      ADAPT_RULE,
      COST_RULE,
    ],
  },
  {
    id: "trend-oi",
    name: "Трендовик с интересом",
    emoji: "🌊",
    tagline: "Пробой, только если в рынок идут новые деньги",
    kind: "signals",
    strategyKey: "donchian-breakout-4h-oi",
    adaptive: true,
    timeframe: "4h",
    symbols: PERSONA_SYMBOLS,
    rules: [
      "Те же пробои, что у Трендовика (канал 48 свечей по 4 часа, EMA 200, стоп 2 ATR, цель 3R, срок 12 дней).",
      "Но входит, только если открытый интерес на фьючерсах Binance за 7 дней вырос: движение поддержано новыми позициями. Данные приходят с задержкой примерно в сутки.",
      "Сравнение с Трендовиком показывает, помогает ли этот фильтр.",
      WORTH_RULE,
      RISK_RULE,
      PROTECTION_RULE,
      ADAPT_RULE,
      COST_RULE,
    ],
  },
  {
    id: "manager",
    name: "Управляющий",
    emoji: "🧠",
    tagline: "Даёт деньги тем, у кого получается",
    kind: "manager",
    candidates: ["trend", "sniper", "contrarian", "rotator", "holder", "crowd", "trend-oi"],
    lookbackDays: 28,
    maxWeight: 0.4,
    timeframe: "1d",
    symbols: PERSONA_SYMBOLS,
    rules: [
      "Сам сделок не ищет: делит капитал между всеми, кроме Монетки (она — контроль, ей денег не даёт).",
      "Каждый понедельник в 03:00 МСК смотрит, кто сколько заработал за последние 28 дней, и даёт деньги тем, кто в плюсе, — пропорционально результату, не больше 40% одному.",
      "Если в плюсе никого, держит доллары. На старте — поровну между всеми.",
      "Перераспределение стоит как сделка: комиссия и проскальзывание с переставленной суммы.",
    ],
  },
];
