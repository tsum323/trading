import Link from "next/link";

/** Шапка с переключением разделов сайта. */
export function SiteHeader({ current }: { current: "terminal" | "traders" }) {
  return (
    <header className="header">
      <h1>Trading Research Terminal</h1>
      <nav className="nav" aria-label="Разделы">
        <Link href="/" aria-current={current === "terminal" ? "page" : undefined}>Терминал</Link>
        <Link href="/traders/" aria-current={current === "traders" ? "page" : undefined}>Трейдеры</Link>
      </nav>
      <span className="hint">Публичные данные Binance Spot · время МСК</span>
    </header>
  );
}
