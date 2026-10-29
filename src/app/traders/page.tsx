import type { Metadata } from "next";
import { SiteHeader } from "../SiteHeader";
import { Traders } from "./Traders";

export const metadata: Metadata = {
  title: "Виртуальные трейдеры",
  description: "Персонажи торгуют на бумаге по разным правилам на живых публичных данных Binance.",
};

export default function TradersPage() {
  return (
    <main className="page">
      <SiteHeader current="traders" />
      <p className="notice">
        <b>Бумажная торговля.</b> Деньги виртуальные, ордера никуда не отправляются. Ни одна стратегия не доказала
        преимущества — рейтинг показывает, как идут дела, а не кому доверять. Выводы возможны только после десятков
        сделок, записанных вовремя.
      </p>
      <Traders />
      <footer className="footer">
        Персонажи решают только по закрытым свечам. Вход — по открытию следующей свечи, стоп при одновременном касании
        стопа и цели. Журналы только дописываются в ветку <code>data</code>.
      </footer>
    </main>
  );
}
