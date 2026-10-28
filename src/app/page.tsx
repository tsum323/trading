import { Terminal } from "./terminal/Terminal";

export default function HomePage() {
  return (
    <main className="page">
      <header className="header">
        <h1>Trading Research Terminal</h1>
        <span className="hint">Публичные данные Binance Spot · время UTC</span>
      </header>
      <p className="notice">
        <b>Только исследование.</b> Исполнения ордеров нет, торговые ключи не используются. Ни одна стратегия пока
        не прошла проверку (см. журнал внизу) — сигналы и реплей нельзя считать торговыми рекомендациями.
      </p>
      <Terminal />
      <footer className="footer">
        Индикаторы считаются только по закрытым свечам; формирующаяся свеча показана приглушённо. Котировки не
        подставляются: если источник недоступен, график остаётся пустым.
      </footer>
    </main>
  );
}
