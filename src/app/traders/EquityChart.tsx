"use client";

import { ColorType, createChart, LineSeries, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";
import { formatClock, formatDateTime, formatDayMonth } from "@/core/time";
import type { PersonaSummary } from "@/services/personas/types";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

interface Props {
  personas: readonly PersonaSummary[];
  colorVar: (id: string) => string;
  visible: ReadonlySet<string>;
  selected: string | null;
  initialEquity: number;
  /** Смена темы — пересоздать график с новыми цветами. */
  theme: string;
}

/** Кривые капитала всех персонажей на одной оси в долларах. */
export function EquityChart({ personas, colorVar, visible, selected, initialEquity, theme }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef(new Map<string, ISeriesApi<"Line">>());

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const c = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: css("--surface") }, textColor: css("--text-muted"), fontFamily: css("--font-mono") },
      grid: { vertLines: { visible: false }, horzLines: { color: css("--grid") } },
      rightPriceScale: { borderColor: css("--border") },
      timeScale: {
        borderColor: css("--border"),
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (t: Time, type: number) => {
          const ms = (t as number) * 1000;
          if (type === 0) return formatDateTime(ms).slice(0, 4);
          return type <= 2 ? formatDayMonth(ms) : formatClock(ms);
        },
      },
      crosshair: { mode: 0 },
      localization: {
        locale: "ru-RU",
        timeFormatter: (t: Time) => `${formatDateTime((t as number) * 1000)} МСК`,
        priceFormatter: (p: number) => `$${Math.round(p).toLocaleString("ru-RU")}`,
      },
      handleScale: { mouseWheel: false },
    });
    chart.current = c;
    const map = series.current;
    return () => {
      c.remove();
      chart.current = null;
      map.clear();
    };
  }, [theme]);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const map = series.current;
    for (const p of personas) {
      let s = map.get(p.id);
      if (!s) {
        s = c.addSeries(LineSeries, { lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: `${p.emoji}` });
        if (map.size === 0) {
          s.createPriceLine({ price: initialEquity, color: css("--text-muted"), lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "старт" });
        }
        map.set(p.id, s);
      }
      const dim = selected !== null && selected !== p.id;
      s.applyOptions({
        color: css(colorVar(p.id)),
        lineWidth: selected === p.id ? 3 : 2,
        // Эталон (Холдер) — пунктиром нейтрального цвета.
        lineStyle: colorVar(p.id) === "--p-ref" ? 2 : 0,
        visible: visible.has(p.id),
        lastValueVisible: !dim,
      });
      s.setData(p.curve.map(([t, v]) => ({ time: Math.floor(t / 1000) as UTCTimestamp, value: v })));
    }
    c.timeScale().fitContent();
  }, [personas, colorVar, visible, selected, initialEquity, theme]);

  return <div ref={container} className="equity-chart" role="img" aria-label="Кривые капитала персонажей" />;
}
