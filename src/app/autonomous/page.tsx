import type { Metadata } from "next";
import { SiteHeader } from "../SiteHeader";
import { Autonomous } from "./Autonomous";

export const metadata: Metadata = {
  title: "Автономный трейдер",
  description: "Бот со своим банком: сам выбирает навыки, разбирает свои ошибки и учится. Бумажная торговля на публичных данных Binance.",
};

export default function AutonomousPage() {
  return (
    <main className="page">
      <SiteHeader current="autonomous" />
      <p className="notice">
        <b>Бумажная торговля.</b> Деньги виртуальные, ордера никуда не отправляются. Бот учится только на прошлом и
        перепроверяет свои выводы; это наблюдение, а не доказательство, что он умеет зарабатывать.
      </p>
      <Autonomous />
      <footer className="footer">Правила обучения — docs/autonomous.md. Журналы бота только дописываются в ветку <code>data</code>.</footer>
    </main>
  );
}
