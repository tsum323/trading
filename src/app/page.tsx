import { SiteHeader } from "./SiteHeader";
import { Terminal } from "./terminal/Terminal";

export default function HomePage() {
  return (
    <main className="page">
      <SiteHeader current="terminal" />
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
