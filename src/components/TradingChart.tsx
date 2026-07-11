import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import type { Bar, ChartKind, IndicatorConfig, OrderUpdate, Position } from "../types";
import { ema, sma, vwap } from "../lib/indicators";

interface Props {
  bars: Bar[];
  kind: ChartKind;
  symbol: string;
  description: string;
  exchange: string;
  indicators: IndicatorConfig[];
  orders: OrderUpdate[];
  positions: Position[];
}

const asTime = (time: number) => time as Time;

export function TradingChart({ bars, kind, symbol, description, exchange, indicators, orders, positions }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [hovered, setHovered] = useState<Bar | null>(null);
  const latest = hovered ?? bars.at(-1) ?? null;
  const change = latest ? latest.close - latest.open : 0;
  const closeValues = useMemo(() => bars.map((bar) => bar.close), [bars]);

  useEffect(() => {
    if (!host.current || !bars.length) return;
    const chart = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#0b0f17" }, textColor: "#778293", attributionLogo: true, panes: { separatorColor: "#202733", separatorHoverColor: "#334155", enableResize: true } },
      grid: { vertLines: { color: "#18202d" }, horzLines: { color: "#18202d" } },
      rightPriceScale: { borderColor: "#232c39", scaleMargins: { top: 0.08, bottom: 0.22 }, minimumWidth: 72 },
      timeScale: { borderColor: "#232c39", timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 4.3, minBarSpacing: 1.5 },
      crosshair: { vertLine: { color: "#8291a6", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#263242" }, horzLine: { color: "#8291a6", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#263242" } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    chartRef.current = chart;

    let priceSeries: ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | ISeriesApi<"Area">;
    if (kind === "line") {
      priceSeries = chart.addSeries(LineSeries, { color: "#34d6e9", lineWidth: 2, priceLineVisible: true });
      priceSeries.setData(bars.map((bar) => ({ time: asTime(bar.time), value: bar.close })));
    } else if (kind === "area") {
      priceSeries = chart.addSeries(AreaSeries, { lineColor: "#37d5e8", topColor: "rgba(55,213,232,.28)", bottomColor: "rgba(55,213,232,.01)", lineWidth: 2 });
      priceSeries.setData(bars.map((bar) => ({ time: asTime(bar.time), value: bar.close })));
    } else {
      priceSeries = chart.addSeries(CandlestickSeries, { upColor: "#16c79a", downColor: "#ef466f", borderVisible: false, wickUpColor: "#16c79a", wickDownColor: "#ef466f" });
      priceSeries.setData(bars.map((bar) => ({ time: asTime(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
    }

    const volumes = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", lastValueVisible: false, priceLineVisible: false });
    volumes.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volumes.setData(bars.map((bar) => ({ time: asTime(bar.time), value: bar.volume, color: bar.close >= bar.open ? "rgba(22,199,154,.35)" : "rgba(239,70,111,.35)" })));

    indicators.filter((item) => item.visible && ["SMA", "EMA", "VWAP"].includes(item.kind)).forEach((indicator) => {
      const values = indicator.kind === "SMA" ? sma(closeValues, indicator.period) : indicator.kind === "EMA" ? ema(closeValues, indicator.period) : vwap(bars);
      const series = chart.addSeries(LineSeries, { color: indicator.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      series.setData(values.flatMap((value, index) => value == null ? [] : [{ time: asTime(bars[index].time), value }]));
    });

    positions.filter((position) => position.symbol === symbol).forEach((position) => {
      priceSeries.createPriceLine({ price: position.averagePrice, color: "#37d5e8", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `${position.side} ${position.quantity}` });
    });
    orders.filter((order) => order.symbol === symbol && order.status === "Working" && (order.price || order.stopPrice)).forEach((order) => {
      priceSeries.createPriceLine({ price: order.price ?? order.stopPrice!, color: "#f0b84b", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `${order.side} ${order.quantity}` });
    });

    chart.subscribeCrosshairMove((param) => {
      if (!param.time) return setHovered(null);
      const found = bars.find((bar) => bar.time === Number(param.time));
      setHovered(found ?? null);
    });
    chart.timeScale().fitContent();
    return () => { chart.remove(); chartRef.current = null; };
  }, [bars, kind, indicators, orders, positions, symbol, closeValues]);

  return (
    <section className="chart-stage" aria-label={`${symbol} chart`}>
      <div className="chart-heading">
        <div className="instrument-mark">{exchange}</div>
        <strong>{description}</strong>
        <span>·</span><span>{symbol}</span>
        {latest && <div className="ohlc"><span>O <b>{latest.open.toFixed(2)}</b></span><span>H <b>{latest.high.toFixed(2)}</b></span><span>L <b>{latest.low.toFixed(2)}</b></span><span>C <b className={change >= 0 ? "positive" : "negative"}>{latest.close.toFixed(2)}</b></span></div>}
      </div>
      <div ref={host} className="chart-host" />
      <div className="chart-watermark">{symbol}</div>
      <div className="session-label">ETH</div>
    </section>
  );
}
