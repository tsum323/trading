import { TIMEFRAMES } from "@/core/time";

const MODULES = ["market-data", "indicators", "strategies", "risk", "backtest", "ai-analysis", "storage"] as const;

export default function HomePage() {
  return (
    <main style={{ maxWidth: 720 }}>
      <h1>Trading Research Terminal</h1>
      <p>
        Каркас проекта. Рыночные данные ещё не подключены, поэтому здесь нет ни цен, ни графиков: страница не
        показывает выдуманных котировок.
      </p>
      <p>
        <strong>Режим:</strong> только исследование. Исполнение ордеров и торговые API-ключи не поддерживаются.
      </p>
      <h2>Модули</h2>
      <ul>
        {MODULES.map((m) => (
          <li key={m}>
            <code>src/modules/{m}</code>
          </li>
        ))}
      </ul>
      <h2>Таймфреймы</h2>
      <p>{TIMEFRAMES.join(", ")}</p>
    </main>
  );
}
