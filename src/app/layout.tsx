import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Trading Research Terminal",
  description: "Личный исследовательский терминал. Без исполнения ордеров.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: 24, background: "#0b0e11", color: "#e6e8ea" }}>
        {children}
      </body>
    </html>
  );
}
