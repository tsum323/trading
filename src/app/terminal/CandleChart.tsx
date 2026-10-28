"use client";

import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import { formatClock, formatDateTime, formatDayMonth } from "@/core/time";
import type { Candle } from "@/modules/market-data";
import { chartTime, type ChartMarker, type MarkerKind, type Overlays } from "./model";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

interface Props {
  candles: readonly Candle[];
  overlays: Overlays;
  show: { ema50: boolean; ema200: boolean; donchian: boolean };
  markers: readonly ChartMarker[];
  /** Сменился символ или таймфрейм — показать последние свечи заново. */
  resetKey: string;
}

/** Свечной график (lightweight-charts) с наложениями и отметками сигналов. */
export function CandleChart({ candles, overlays, show, markers, resetKey }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<{
    candles: ISeriesApi<"Candlestick">;
    ema50: ISeriesApi<"Line">;
    ema200: ISeriesApi<"Line">;
    dHigh: ISeriesApi<"Line">;
    dLow: ISeriesApi<"Line">;
    markers: ISeriesMarkersPluginApi<Time>;
  } | null>(null);
  const lastReset = useRef<string | null>(null);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const c = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: css("--surface") }, textColor: css("--text-muted"), fontFamily: css("--font-mono") },
      grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } },
      rightPriceScale: { borderColor: css("--border") },
      timeScale: {
        borderColor: css("--border"),
        timeVisible: true,
        secondsVisible: false,
        // TickMarkType: 0 год, 1 месяц, 2 день, 3+ время.
        tickMarkFormatter: (t: Time, type: number) => {
          const ms = (t as number) * 1000;
          if (type <= 1) return formatDateTime(ms).slice(0, type === 0 ? 4 : 7);
          return type === 2 ? formatDayMonth(ms) : formatClock(ms);
        },
      },
      crosshair: { mode: 0 },
      // Время на шкале и в перекрестии — по Москве; сами данные остаются в UTC.
      localization: { locale: "ru-RU", timeFormatter: (t: Time) => formatDateTime((t as number) * 1000) },
    });
    const up = css("--up");
    const down = css("--down");
    const candlesSeries = c.addSeries(CandlestickSeries, {
      upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
    });
    const line = (color: string, style = 0) =>
      c.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    series.current = {
      candles: candlesSeries,
      ema50: line(css("--series-1")),
      ema200: line(css("--series-2")),
      dHigh: line(css("--series-3"), 2),
      dLow: line(css("--series-3"), 2),
      markers: createSeriesMarkers(candlesSeries, []),
    };
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
      lastReset.current = null;
    };
  }, []);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const t = (ms: number) => chartTime(ms) as UTCTimestamp;
    const formingColor = css("--text-muted");
    s.candles.setData(
      candles.map((c) => ({
        time: t(c.openTime), open: c.open, high: c.high, low: c.low, close: c.close,
        // Формирующаяся свеча — приглушённым цветом.
        ...(c.isClosed ? {} : { color: formingColor, wickColor: formingColor, borderColor: formingColor }),
      })),
    );
    const asLine = (pts: Overlays["ema50"], visible: boolean) => (visible ? pts.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })) : []);
    s.ema50.setData(asLine(overlays.ema50, show.ema50));
    s.ema200.setData(asLine(overlays.ema200, show.ema200));
    s.dHigh.setData(asLine(overlays.donchianHigh, show.donchian));
    s.dLow.setData(asLine(overlays.donchianLow, show.donchian));

    const color: Record<MarkerKind, string> = {
      long: css("--up"), short: css("--down"), win: css("--good"), loss: css("--bad"), flat: css("--text-muted"),
    };
    s.markers.setMarkers(markers.map((m) => ({ time: m.time as UTCTimestamp, position: m.position, shape: m.shape, color: color[m.kind], text: m.text })));

    if (lastReset.current !== resetKey && candles.length > 0) {
      chart.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, candles.length - 200), to: candles.length + 5 });
      lastReset.current = resetKey;
    }
  }, [candles, overlays, show, markers, resetKey]);

  return <div ref={container} className="chart" role="img" aria-label="Свечной график" />;
}
