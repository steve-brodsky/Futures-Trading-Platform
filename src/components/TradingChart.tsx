import { useEffect, useRef, useState } from "react";
import { ChevronsRight } from "lucide-react";
import {
  AreaSeries, CandlestickSeries, ColorType, createChart, CrosshairMode, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type LogicalRange, type Time,
} from "lightweight-charts";
import type { Bar, ChartKind, ChartTimezone, IndicatorConfig, OrderUpdate, Position, Timeframe } from "../types";
import { ema, sma, vwap } from "../lib/indicators";
import { nearestCandleExtreme } from "../lib/crosshair";
import { formatChartTime, resolveTimezone, timezoneLabel, timezoneOptions } from "../lib/timezone";
import { SessionShading } from "../lib/sessionShading";

interface Props {
  bars: Bar[];
  kind: ChartKind;
  magnetEnabled: boolean;
  symbol: string;
  description: string;
  exchange: string;
  timeframe: Timeframe;
  timezone: ChartTimezone;
  indicators: IndicatorConfig[];
  orders: OrderUpdate[];
  positions: Position[];
  loadingOlder: boolean;
  initialVisibleRange?: { from: number; to: number };
  onVisibleRangeChange?: (range: { from: number; to: number }) => void;
  onTimezoneChange: (timezone: ChartTimezone) => void;
  onLoadOlder: () => void;
}

const asTime = (time: number) => time as Time;
const isIntraday = (timeframe: Timeframe) => !["D", "W", "M"].includes(timeframe);

export function TradingChart({ bars, kind, magnetEnabled, symbol, description, exchange, timeframe, timezone, indicators, orders, positions, loadingOlder, initialVisibleRange, onVisibleRangeChange, onTimezoneChange, onLoadOlder }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<any> | null>(null);
  const volumeRef = useRef<ISeriesApi<any> | null>(null);
  const indicatorRefs = useRef<Array<{ config: IndicatorConfig; series: ISeriesApi<any> }>>([]);
  const tradeLineRefs = useRef<IPriceLine[]>([]);
  const sessionShadingRef = useRef<SessionShading | null>(null);
  const previousBars = useRef<Bar[]>([]);
  const barsRef = useRef(bars);
  const magnetEnabledRef = useRef(magnetEnabled);
  const loadOlderRef = useRef(onLoadOlder);
  const visibleRangeChangeRef = useRef(onVisibleRangeChange);
  const firstData = useRef(true);
  const [hovered, setHovered] = useState<Bar | null>(null);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const [chartGeneration, setChartGeneration] = useState(0);
  const latest = hovered ?? bars.at(-1) ?? null;
  const change = latest ? latest.close - latest.open : 0;

  barsRef.current = bars;
  magnetEnabledRef.current = magnetEnabled;
  loadOlderRef.current = onLoadOlder;
  visibleRangeChangeRef.current = onVisibleRangeChange;

  useEffect(() => {
    if (!host.current) return;
    const zone = resolveTimezone(timezone, exchange);
    const intraday = isIntraday(timeframe);
    const chart = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#0b0f17" }, textColor: "#778293", attributionLogo: true, panes: { separatorColor: "#202733", separatorHoverColor: "#334155", enableResize: true } },
      localization: { locale: "en-US", timeFormatter: (time: Time) => formatChartTime(Number(time), zone, true) },
      grid: { vertLines: { color: "#18202d" }, horzLines: { color: "#18202d" } },
      rightPriceScale: { borderColor: "#232c39", scaleMargins: { top: 0.08, bottom: 0.22 }, minimumWidth: 72 },
      timeScale: {
        borderColor: "#232c39", timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 4.3, minBarSpacing: 1.5,
        tickMarkFormatter: (time: Time) => intraday
          ? formatChartTime(Number(time), zone)
          : new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "2-digit" }).format(new Date(Number(time) * 1000)),
      },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "#8291a6", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#263242" }, horzLine: { color: "#8291a6", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#263242" } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    chartRef.current = chart;

    let priceSeries: ISeriesApi<any>;
    if (kind === "line") priceSeries = chart.addSeries(LineSeries, { color: "#34d6e9", lineWidth: 2, priceLineVisible: true });
    else if (kind === "area") priceSeries = chart.addSeries(AreaSeries, { lineColor: "#37d5e8", topColor: "rgba(55,213,232,.28)", bottomColor: "rgba(55,213,232,.01)", lineWidth: 2 });
    else priceSeries = chart.addSeries(CandlestickSeries, { upColor: "#16c79a", downColor: "#ef466f", borderVisible: false, wickUpColor: "#16c79a", wickDownColor: "#ef466f" });
    priceRef.current = priceSeries;
    if (intraday) {
      const sessionShading = new SessionShading();
      priceSeries.attachPrimitive(sessionShading);
      sessionShadingRef.current = sessionShading;
    }

    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", lastValueVisible: false, priceLineVisible: false });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volumeRef.current = volumeSeries;

    indicatorRefs.current = indicators.filter((item) => item.visible && ["SMA", "EMA", "VWAP"].includes(item.kind)).map((config) => ({
      config,
      series: chart.addSeries(LineSeries, { color: config.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
    }));

    let settingCrosshair = false;
    chart.subscribeCrosshairMove((param) => {
      if (!param.time) return setHovered(null);
      const bar = barsRef.current.find((item) => item.time === Number(param.time)) ?? null;
      setHovered(bar);
      if (settingCrosshair || !param.sourceEvent || !magnetEnabledRef.current || kind !== "candles" || !bar || !param.point) return;
      const highY = priceSeries.priceToCoordinate(bar.high);
      const lowY = priceSeries.priceToCoordinate(bar.low);
      if (highY == null || lowY == null) return;
      settingCrosshair = true;
      chart.setCrosshairPosition(nearestCandleExtreme(param.point.y, highY, lowY, bar.high, bar.low), asTime(bar.time), priceSeries);
      settingCrosshair = false;
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((range: LogicalRange | null) => {
      if (!range) return;
      setShowScrollToLatest(Number(range.to) < barsRef.current.length - 1);
      visibleRangeChangeRef.current?.({ from: Number(range.from), to: Number(range.to) });
      const info = priceSeries.barsInLogicalRange(range);
      if (info && info.barsBefore < 100) loadOlderRef.current();
    });

    previousBars.current = [];
    firstData.current = true;
    setChartGeneration((value) => value + 1);
    return () => {
      chart.remove(); chartRef.current = null; priceRef.current = null; volumeRef.current = null; indicatorRefs.current = []; tradeLineRefs.current = []; sessionShadingRef.current = null;
    };
  }, [kind, symbol, exchange, timeframe, timezone, indicators]);

  useEffect(() => {
    const price = priceRef.current;
    if (!price) return;

    tradeLineRefs.current.forEach((line) => price.removePriceLine(line));
    tradeLineRefs.current = [
      ...positions
        .filter((position) => position.symbol === symbol)
        .map((position) => price.createPriceLine({ price: position.averagePrice, color: "#37d5e8", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `${position.side} ${position.quantity}` })),
      ...orders
        .filter((order) => order.symbol === symbol && order.status === "Working" && (order.price != null || order.stopPrice != null))
        .map((order) => price.createPriceLine({ price: order.price ?? order.stopPrice!, color: "#f0b84b", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `${order.side} ${order.quantity}` })),
    ];
  }, [orders, positions, symbol, chartGeneration]);

  useEffect(() => {
    const chart = chartRef.current;
    const price = priceRef.current;
    const volume = volumeRef.current;
    if (!chart || !price || !volume || !bars.length) return;
    const prior = previousBars.current;
    const latestBar = bars[bars.length - 1];
    sessionShadingRef.current?.setTimes(bars.map((bar) => bar.time));
    const realtimeOnly = prior.length > 0 && bars[0].time === prior[0].time && bars.length >= prior.length && bars.length <= prior.length + 1;
    if (realtimeOnly) {
      if (kind === "candles") price.update({ time: asTime(latestBar.time), open: latestBar.open, high: latestBar.high, low: latestBar.low, close: latestBar.close });
      else price.update({ time: asTime(latestBar.time), value: latestBar.close });
      volume.update({ time: asTime(latestBar.time), value: latestBar.volume, color: latestBar.close >= latestBar.open ? "rgba(22,199,154,.35)" : "rgba(239,70,111,.35)" });
    } else {
      const range = chart.timeScale().getVisibleLogicalRange();
      const prepended = prior.length && bars[0].time < prior[0].time ? bars.length - prior.length : 0;
      if (kind === "candles") price.setData(bars.map((bar) => ({ time: asTime(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
      else price.setData(bars.map((bar) => ({ time: asTime(bar.time), value: bar.close })));
      volume.setData(bars.map((bar) => ({ time: asTime(bar.time), value: bar.volume, color: bar.close >= bar.open ? "rgba(22,199,154,.35)" : "rgba(239,70,111,.35)" })));
      if (range && prepended > 0) chart.timeScale().setVisibleLogicalRange({ from: range.from + prepended, to: range.to + prepended });
    }

    const closes = bars.map((bar) => bar.close);
    indicatorRefs.current.forEach(({ config, series }) => {
      const values = config.kind === "SMA" ? sma(closes, config.period) : config.kind === "EMA" ? ema(closes, config.period) : vwap(bars);
      series.setData(values.flatMap((value, index) => value == null ? [] : [{ time: asTime(bars[index].time), value }]));
    });
    if (firstData.current) {
      chart.timeScale().setVisibleLogicalRange(initialVisibleRange
        ? { from: initialVisibleRange.from as any, to: initialVisibleRange.to as any }
        : { from: Math.max(0, bars.length - 180) as any, to: (bars.length + 5) as any });
      firstData.current = false;
    }
    const visibleRange = chart.timeScale().getVisibleLogicalRange();
    setShowScrollToLatest(Boolean(visibleRange && Number(visibleRange.to) < bars.length - 1));
    previousBars.current = bars;
  }, [bars, kind, chartGeneration]);

  return (
    <section className="chart-stage" aria-label={`${symbol} chart`}>
      <div className="chart-heading">
        <div className="instrument-mark">{exchange}</div><strong>{description}</strong><span>·</span><span>{symbol}</span>
        {latest && <div className="ohlc"><span>O <b>{latest.open.toFixed(2)}</b></span><span>H <b>{latest.high.toFixed(2)}</b></span><span>L <b>{latest.low.toFixed(2)}</b></span><span>C <b className={change >= 0 ? "positive" : "negative"}>{latest.close.toFixed(2)}</b></span></div>}
      </div>
      {loadingOlder && <div className="history-loading"><span />Loading history</div>}
      <div ref={host} className="chart-host" />
      <div className="chart-watermark">{symbol}</div>
      {showScrollToLatest && <button className="scroll-to-latest" type="button" aria-label="Scroll to latest candle" title="Scroll to latest candle" onClick={() => chartRef.current?.timeScale().scrollToRealTime()}><ChevronsRight size={18} /></button>}
      <select className="timezone-select" aria-label="Chart timezone" value={timezone} onChange={(event) => onTimezoneChange(event.target.value as ChartTimezone)} title={`Chart timezone: ${resolveTimezone(timezone, exchange)}`}>
        {timezoneOptions.map((option) => <option key={option.value} value={option.value}>{option.value === timezone ? timezoneLabel(timezone, exchange) : option.label}</option>)}
      </select>
    </section>
  );
}
