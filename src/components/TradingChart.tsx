import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronsRight, Lock, LockOpen, MoveVertical, Trash2, X } from "lucide-react";
import {
  AreaSeries, CandlestickSeries, ColorType, createChart, CrosshairMode, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type LogicalRange, type Time,
} from "lightweight-charts";
import type { Bar, ChartKind, ChartTimezone, Drawing, IndicatorConfig, OrderUpdate, Position, Timeframe } from "../types";
import { ema, roundToTick, sma, vwap } from "../lib/indicators";
import { nearestCandleExtreme } from "../lib/crosshair";
import { formatChartTime, resolveTimezone, timezoneLabel, timezoneOptions } from "../lib/timezone";
import { SessionShading } from "../lib/sessionShading";
import { HorizontalRayPrimitive, nearestChartTime } from "../lib/horizontalRay";
import { buildProjectedTradeLines, buildTradeLines, snapTradeLinePrice, tradeLinePriceChanged, type OrderProjection } from "../lib/tradeLines";

interface Props {
  bars: Bar[];
  kind: ChartKind;
  magnetEnabled: boolean;
  symbol: string;
  tradeSymbol?: string;
  description: string;
  exchange: string;
  minMove: number;
  timeframe: Timeframe;
  timezone: ChartTimezone;
  indicators: IndicatorConfig[];
  orders: OrderUpdate[];
  positions: Position[];
  orderProjection?: OrderProjection;
  closingPositionIds: Set<string>;
  replacingOrderIds: Set<string>;
  onClosePosition: (position: Position) => void;
  onReplaceOrder: (order: OrderUpdate, newPrice: number) => void | Promise<void>;
  loadingOlder: boolean;
  activeTool: string;
  drawings: Drawing[];
  onToolComplete: () => void;
  onCreateDrawing: (drawing: Drawing) => void;
  onUpdateDrawing: (id: string, patch: Partial<Drawing>) => void;
  onDeleteDrawing: (id: string) => void;
  initialVisibleRange?: { from: number; to: number };
  onVisibleRangeChange?: (range: { from: number; to: number }) => void;
  onTimezoneChange: (timezone: ChartTimezone) => void;
  onLoadOlder: () => void;
}

const asTime = (time: number) => time as Time;
const isIntraday = (timeframe: Timeframe) => !["D", "W", "M"].includes(timeframe);
const pricePrecision = (minMove: number) => {
  const text = minMove.toFixed(10).replace(/0+$/, "");
  return text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
};

export function TradingChart({ bars, kind, magnetEnabled, symbol, tradeSymbol, description, exchange, minMove, timeframe, timezone, indicators, orders, positions, orderProjection, closingPositionIds, replacingOrderIds, onClosePosition, onReplaceOrder, loadingOlder, activeTool, drawings, onToolComplete, onCreateDrawing, onUpdateDrawing, onDeleteDrawing, initialVisibleRange, onVisibleRangeChange, onTimezoneChange, onLoadOlder }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<any> | null>(null);
  const volumeRef = useRef<ISeriesApi<any> | null>(null);
  const indicatorRefs = useRef<Array<{ config: IndicatorConfig; series: ISeriesApi<any> }>>([]);
  const tradeLineRefs = useRef<Map<string, IPriceLine>>(new Map());
  const drawingLineRefs = useRef<IPriceLine[]>([]);
  const rayPrimitiveRef = useRef<HorizontalRayPrimitive | null>(null);
  const sessionShadingRef = useRef<SessionShading | null>(null);
  const previousBars = useRef<Bar[]>([]);
  const barsRef = useRef(bars);
  const magnetEnabledRef = useRef(magnetEnabled);
  const activeToolRef = useRef(activeTool);
  const drawingsRef = useRef(drawings);
  const drawingCallbacksRef = useRef({ onToolComplete, onCreateDrawing, onUpdateDrawing, onDeleteDrawing });
  const loadOlderRef = useRef(onLoadOlder);
  const visibleRangeChangeRef = useRef(onVisibleRangeChange);
  const firstData = useRef(true);
  const [hovered, setHovered] = useState<Bar | null>(null);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const [chartGeneration, setChartGeneration] = useState(0);
  const [drawingMenu, setDrawingMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [movingDrawingId, setMovingDrawingId] = useState<string | null>(null);
  const [tradeLineTops, setTradeLineTops] = useState<Record<string, number>>({});
  const [draggingOrder, setDraggingOrder] = useState<{ id: string; originalPrice: number; price: number } | null>(null);
  const draggingOrderRef = useRef<typeof draggingOrder>(null);
  const syncTradeLabelsRef = useRef<() => void>(() => undefined);
  const movingDrawingIdRef = useRef<string | null>(null);
  const latest = hovered ?? bars.at(-1) ?? null;
  const change = latest ? latest.close - latest.open : 0;
  const tradeLines = [...buildTradeLines(tradeSymbol, positions, orders), ...buildProjectedTradeLines(orderProjection)];

  barsRef.current = bars;
  magnetEnabledRef.current = magnetEnabled;
  activeToolRef.current = activeTool;
  drawingsRef.current = drawings;
  drawingCallbacksRef.current = { onToolComplete, onCreateDrawing, onUpdateDrawing, onDeleteDrawing };
  loadOlderRef.current = onLoadOlder;
  visibleRangeChangeRef.current = onVisibleRangeChange;
  syncTradeLabelsRef.current = () => {
    const price = priceRef.current;
    const height = host.current?.clientHeight ?? 0;
    if (!price || !height) return;
    const next: Record<string, number> = {};
    tradeLineRefs.current.forEach((line, id) => {
      const coordinate = price.priceToCoordinate(line.options().price);
      if (coordinate != null && coordinate >= -16 && coordinate <= height + 16) next[id] = coordinate;
    });
    setTradeLineTops((current) => {
      const keys = Object.keys(next);
      if (keys.length === Object.keys(current).length && keys.every((key) => current[key] === next[key])) return current;
      return next;
    });
  };

  useEffect(() => {
    setDrawingMenu(null);
    if (activeTool !== "cursor") { movingDrawingIdRef.current = null; setMovingDrawingId(null); }
  }, [activeTool, symbol]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDrawingMenu(null); movingDrawingIdRef.current = null; setMovingDrawingId(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

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
    const priceFormat = { type: "price" as const, precision: pricePrecision(minMove), minMove };

    let priceSeries: ISeriesApi<any>;
    if (kind === "line") priceSeries = chart.addSeries(LineSeries, { color: "#34d6e9", lineWidth: 2, priceLineVisible: true, priceFormat });
    else if (kind === "area") priceSeries = chart.addSeries(AreaSeries, { lineColor: "#37d5e8", topColor: "rgba(55,213,232,.28)", bottomColor: "rgba(55,213,232,.01)", lineWidth: 2, priceFormat });
    else priceSeries = chart.addSeries(CandlestickSeries, { upColor: "#16c79a", downColor: "#ef466f", borderVisible: false, wickUpColor: "#16c79a", wickDownColor: "#ef466f", priceFormat });
    priceRef.current = priceSeries;
    const rayPrimitive = new HorizontalRayPrimitive();
    priceSeries.attachPrimitive(rayPrimitive);
    rayPrimitiveRef.current = rayPrimitive;
    if (intraday) {
      const sessionShading = new SessionShading();
      priceSeries.attachPrimitive(sessionShading);
      sessionShadingRef.current = sessionShading;
    }

    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", lastValueVisible: false, priceLineVisible: false });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volumeRef.current = volumeSeries;

    let settingCrosshair = false;
    chart.subscribeCrosshairMove((param) => {
      syncTradeLabelsRef.current();
      if (!param.time) return setHovered(null);
      const bar = barsRef.current.find((item) => item.time === Number(param.time)) ?? null;
      setHovered(bar);
      if (settingCrosshair || !param.sourceEvent || !param.point) return;
      let snappedPrice: number | null = null;
      if (magnetEnabledRef.current && kind === "candles" && bar) {
        const highY = priceSeries.priceToCoordinate(bar.high);
        const lowY = priceSeries.priceToCoordinate(bar.low);
        if (highY != null && lowY != null) snappedPrice = nearestCandleExtreme(param.point.y, highY, lowY, bar.high, bar.low);
      } else {
        const hoveredPrice = priceSeries.coordinateToPrice(param.point.y);
        if (hoveredPrice != null) snappedPrice = roundToTick(hoveredPrice, minMove);
      }
      if (snappedPrice == null) return;
      settingCrosshair = true;
      chart.setCrosshairPosition(snappedPrice, param.time, priceSeries);
      settingCrosshair = false;
    });
    chart.subscribeClick((param) => {
      if (!param.point) { setDrawingMenu(null); return; }
      const tool = activeToolRef.current;
      if (!movingDrawingIdRef.current && tool !== "horizontal" && tool !== "horizontal-ray") {
        const hits = drawingsRef.current.filter((drawing) => {
          const y = priceSeries.priceToCoordinate(drawing.points[0].price);
          if (y == null || Math.abs(y - param.point!.y) > 6) return false;
          if (drawing.kind !== "horizontal-ray") return drawing.kind === "horizontal";
          const x = chart.timeScale().timeToCoordinate(nearestChartTime(drawing.points[0].time, barsRef.current.map((bar) => bar.time)) as Time);
          return x != null && param.point!.x >= x - 6;
        });
        const selected = hits.at(-1);
        if (selected) {
          setDrawingMenu({ id: selected.id, x: Math.min(param.point.x + 10, Math.max(8, (host.current?.clientWidth ?? 240) - 190)), y: Math.min(param.point.y + 10, Math.max(8, (host.current?.clientHeight ?? 180) - 170)) });
          return;
        }
      }
      if (!param.time) { setDrawingMenu(null); return; }
      const time = Number(param.time);
      const bar = barsRef.current.find((item) => item.time === time) ?? null;
      let clickedPrice: number | null = null;
      if (magnetEnabledRef.current && kind === "candles" && bar) {
        const highY = priceSeries.priceToCoordinate(bar.high);
        const lowY = priceSeries.priceToCoordinate(bar.low);
        if (highY != null && lowY != null) clickedPrice = nearestCandleExtreme(param.point.y, highY, lowY, bar.high, bar.low);
      } else {
        const price = priceSeries.coordinateToPrice(param.point.y);
        if (price != null) clickedPrice = roundToTick(price, minMove);
      }
      if (clickedPrice == null) return;

      if (movingDrawingIdRef.current) {
        const drawing = drawingsRef.current.find((item) => item.id === movingDrawingIdRef.current);
        if (drawing && !drawing.locked) drawingCallbacksRef.current.onUpdateDrawing(drawing.id, { points: [{ time, price: clickedPrice }] });
        movingDrawingIdRef.current = null; setMovingDrawingId(null); setDrawingMenu(null); return;
      }
      if (tool === "horizontal" || tool === "horizontal-ray") {
        drawingCallbacksRef.current.onCreateDrawing({ id: crypto.randomUUID(), kind: tool, points: [{ time, price: clickedPrice }], color: "#ffffff", locked: false, lineWidth: 1 });
        drawingCallbacksRef.current.onToolComplete(); setDrawingMenu(null); return;
      }

      setDrawingMenu(null);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((range: LogicalRange | null) => {
      syncTradeLabelsRef.current();
      if (!range) return;
      setShowScrollToLatest(Number(range.to) < barsRef.current.length - 1);
      visibleRangeChangeRef.current?.({ from: Number(range.from), to: Number(range.to) });
      const info = priceSeries.barsInLogicalRange(range);
      if (info && info.barsBefore < 100) loadOlderRef.current();
    });

    previousBars.current = [];
    firstData.current = true;
    const syncLabels = () => syncTradeLabelsRef.current();
    const resizeObserver = new ResizeObserver(syncLabels);
    resizeObserver.observe(host.current);
    host.current.addEventListener("wheel", syncLabels, { passive: true });
    host.current.addEventListener("pointermove", syncLabels, { passive: true });
    setChartGeneration((value) => value + 1);
    return () => {
      resizeObserver.disconnect();
      host.current?.removeEventListener("wheel", syncLabels);
      host.current?.removeEventListener("pointermove", syncLabels);
      chart.remove(); chartRef.current = null; priceRef.current = null; volumeRef.current = null; indicatorRefs.current = []; tradeLineRefs.current = new Map(); drawingLineRefs.current = []; rayPrimitiveRef.current = null; sessionShadingRef.current = null;
    };
  }, [kind, symbol, exchange, minMove, timeframe, timezone]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const priceFormat = { type: "price" as const, precision: pricePrecision(minMove), minMove };
    const visible = indicators.filter((item) => item.visible && ["SMA", "EMA", "VWAP"].includes(item.kind));
    const visibleIds = new Set(visible.map((config) => config.id));
    const existing = new Map(indicatorRefs.current.map((item) => [item.config.id, item]));

    indicatorRefs.current.forEach((item) => {
      if (!visibleIds.has(item.config.id)) chart.removeSeries(item.series);
    });

    const closes = barsRef.current.map((bar) => bar.close);
    indicatorRefs.current = visible.map((config) => {
      const current = existing.get(config.id);
      const series = current?.series ?? chart.addSeries(LineSeries, {
        color: config.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        priceFormat,
      });
      series.applyOptions({ color: config.color });
      const values = config.kind === "SMA" ? sma(closes, config.period) : config.kind === "EMA" ? ema(closes, config.period) : vwap(barsRef.current);
      series.setData(values.flatMap((value, index) => value == null ? [] : [{ time: asTime(barsRef.current[index].time), value }]));
      return { config, series };
    });
  }, [indicators, chartGeneration, minMove]);

  useEffect(() => {
    const price = priceRef.current;
    if (!price) return;

    tradeLineRefs.current.forEach((line) => price.removePriceLine(line));
    const next = new Map<string, IPriceLine>();
    [...buildTradeLines(tradeSymbol, positions, orders), ...buildProjectedTradeLines(orderProjection)].forEach((line) => {
      const projected = line.kind === "projected-take-profit" || line.kind === "projected-stop-loss";
      next.set(line.id, price.createPriceLine({ price: line.price, color: line.color, lineWidth: 1, lineStyle: projected ? LineStyle.Dotted : LineStyle.Dashed, axisLabelVisible: false, title: "" }));
    });
    tradeLineRefs.current = next;
    requestAnimationFrame(() => syncTradeLabelsRef.current());
  }, [orders, positions, tradeSymbol, orderProjection?.takeProfit, orderProjection?.stopLoss, chartGeneration]);

  useEffect(() => {
    if (!draggingOrder?.id) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const current = draggingOrderRef.current;
      if (!current) return;
      tradeLineRefs.current.get(`order:${current.id}`)?.applyOptions({ price: current.originalPrice });
      requestAnimationFrame(() => syncTradeLabelsRef.current());
      draggingOrderRef.current = null;
      setDraggingOrder(null);
      chartRef.current?.applyOptions({ handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false } });
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [draggingOrder?.id]);

  useEffect(() => {
    const price = priceRef.current;
    if (!price) return;
    drawingLineRefs.current.forEach((line) => price.removePriceLine(line));
    drawingLineRefs.current = drawings
      .filter((drawing) => drawing.kind === "horizontal" || drawing.kind === "horizontal-ray")
      .map((drawing) => price.createPriceLine({
        price: drawing.points[0].price,
        color: drawing.color,
        lineWidth: drawing.lineWidth ?? 1,
        lineStyle: LineStyle.Solid,
        lineVisible: drawing.kind === "horizontal",
        axisLabelVisible: true,
        axisLabelColor: drawing.color,
        title: "",
      }));
    rayPrimitiveRef.current?.setDrawings(drawings.filter((drawing) => drawing.kind === "horizontal-ray"));
    if (drawingMenu && !drawings.some((drawing) => drawing.id === drawingMenu.id)) setDrawingMenu(null);
  }, [drawings, chartGeneration]);

  useEffect(() => {
    const chart = chartRef.current;
    const price = priceRef.current;
    const volume = volumeRef.current;
    if (!chart || !price || !volume || !bars.length) return;
    const prior = previousBars.current;
    const latestBar = bars[bars.length - 1];
    sessionShadingRef.current?.setTimes(bars.map((bar) => bar.time));
    rayPrimitiveRef.current?.setTimes(bars.map((bar) => bar.time));
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
    requestAnimationFrame(() => syncTradeLabelsRef.current());
  }, [bars, kind, chartGeneration]);

  const startOrderDrag = (event: ReactPointerEvent<HTMLDivElement>, order: OrderUpdate, price: number) => {
    if (replacingOrderIds.has(order.id)) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const drag = { id: order.id, originalPrice: price, price };
    draggingOrderRef.current = drag;
    setDraggingOrder(drag);
    chartRef.current?.applyOptions({ handleScroll: { mouseWheel: true, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false } });
  };

  const moveOrderDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = draggingOrderRef.current;
    const price = priceRef.current;
    const bounds = host.current?.getBoundingClientRect();
    if (!current || !price || !bounds) return;
    event.preventDefault();
    const rawPrice = price.coordinateToPrice(event.clientY - bounds.top);
    if (rawPrice == null) return;
    const snapped = snapTradeLinePrice(rawPrice, minMove);
    if (snapped == null) return;
    const next = { ...current, price: snapped };
    draggingOrderRef.current = next;
    setDraggingOrder(next);
    tradeLineRefs.current.get(`order:${current.id}`)?.applyOptions({ price: snapped });
    syncTradeLabelsRef.current();
  };

  const finishOrderDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = draggingOrderRef.current;
    if (!current) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const changed = tradeLinePriceChanged(current.originalPrice, current.price, minMove);
    if (!changed) tradeLineRefs.current.get(`order:${current.id}`)?.applyOptions({ price: current.originalPrice });
    draggingOrderRef.current = null;
    setDraggingOrder(null);
    chartRef.current?.applyOptions({ handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false } });
    requestAnimationFrame(() => syncTradeLabelsRef.current());
    if (!changed) return;
    const order = orders.find((item) => item.id === current.id);
    if (order) void onReplaceOrder(order, current.price);
  };

  const cancelOrderDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = draggingOrderRef.current;
    if (!current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    tradeLineRefs.current.get(`order:${current.id}`)?.applyOptions({ price: current.originalPrice });
    draggingOrderRef.current = null;
    setDraggingOrder(null);
    chartRef.current?.applyOptions({ handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false } });
    requestAnimationFrame(() => syncTradeLabelsRef.current());
  };

  const selectedDrawing = drawingMenu ? drawings.find((drawing) => drawing.id === drawingMenu.id) : undefined;

  return (
    <section className="chart-stage" aria-label={`${symbol} chart`}>
      <div className="chart-heading">
        <div className="instrument-mark">{exchange}</div><strong>{description}</strong><span>·</span><span>{symbol}</span>
        {latest && <div className="ohlc"><span>O <b>{latest.open.toFixed(2)}</b></span><span>H <b>{latest.high.toFixed(2)}</b></span><span>L <b>{latest.low.toFixed(2)}</b></span><span>C <b className={change >= 0 ? "positive" : "negative"}>{latest.close.toFixed(2)}</b></span></div>}
      </div>
      {loadingOlder && <div className="history-loading"><span />Loading history</div>}
      <div ref={host} className="chart-host" />
      {tradeLines.map((line) => {
        const top = tradeLineTops[line.id];
        if (top == null) return null;
        const dragging = draggingOrder?.id === line.order?.id;
        const pending = line.order && replacingOrderIds.has(line.order.id);
        const displayPrice = dragging ? draggingOrder?.price ?? line.price : line.price;
        const contractPrefix = tradeSymbol && tradeSymbol !== symbol ? `${tradeSymbol} ` : "";
        const label = line.kind === "position" ? `${contractPrefix}${line.side.toUpperCase()} ${line.quantity}`
          : line.kind === "take-profit" ? `${contractPrefix}TP ${line.quantity}`
            : line.kind === "stop-loss" ? `${contractPrefix}SL ${line.quantity}`
              : line.kind === "projected-take-profit" ? "PROJECTED TP"
                : line.kind === "projected-stop-loss" ? "PROJECTED SL"
                  : `${contractPrefix}${line.side.toUpperCase()} ${line.quantity}`;
        return <div
          key={line.id}
          className={`trade-line-label ${line.kind} ${line.kind === "position" ? line.side.toLowerCase() : ""} ${line.draggable ? "draggable" : ""} ${pending ? "pending" : ""}`}
          style={{ top }}
          onPointerDown={line.draggable && line.order ? (event) => startOrderDrag(event, line.order!, line.price) : undefined}
          onPointerMove={line.draggable ? moveOrderDrag : undefined}
          onPointerUp={line.draggable ? finishOrderDrag : undefined}
          onPointerCancel={line.draggable ? cancelOrderDrag : undefined}
          title={line.draggable ? "Drag to replace this protective order" : undefined}
        >
          <span>{pending ? "UPDATING" : label}</span><strong>{displayPrice.toFixed(pricePrecision(minMove))}</strong>
          {line.position && <button type="button" aria-label={`Close ${line.position.symbol} position`} title="Close position" disabled={closingPositionIds.has(line.position.id)} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onClosePosition(line.position!); }}><X size={11} /></button>}
        </div>;
      })}
      <div className="chart-watermark">{symbol}</div>
      {movingDrawingId && <div className="drawing-move-hint">Click a new chart position to move the drawing · Esc to cancel</div>}
      {selectedDrawing && drawingMenu && <>
        <button className="drawing-menu-backdrop" aria-label="Close drawing menu" onClick={() => setDrawingMenu(null)} />
        <div className="drawing-menu" role="menu" aria-label={`${selectedDrawing.kind === "horizontal-ray" ? "Horizontal ray" : "Horizontal line"} options`} style={{ left: drawingMenu.x, top: drawingMenu.y }}>
          <label className="drawing-menu-color"><input type="color" value={selectedDrawing.color} aria-label="Drawing color" onChange={(event) => onUpdateDrawing(selectedDrawing.id, { color: event.target.value })} /><span style={{ background: selectedDrawing.color }} />Color</label>
          <label className="drawing-menu-width"><span>Line width</span><select aria-label="Line width" value={selectedDrawing.lineWidth ?? 1} onChange={(event) => onUpdateDrawing(selectedDrawing.id, { lineWidth: Number(event.target.value) as 1 | 2 | 3 | 4 })}>{[1, 2, 3, 4].map((width) => <option key={width} value={width}>{width}px</option>)}</select></label>
          <button role="menuitem" disabled={selectedDrawing.locked} onClick={() => { movingDrawingIdRef.current = selectedDrawing.id; setMovingDrawingId(selectedDrawing.id); setDrawingMenu(null); }}><MoveVertical size={15} />Move</button>
          <button role="menuitem" onClick={() => onUpdateDrawing(selectedDrawing.id, { locked: !selectedDrawing.locked })}>{selectedDrawing.locked ? <LockOpen size={15} /> : <Lock size={15} />}{selectedDrawing.locked ? "Unlock" : "Lock"}</button>
          <button role="menuitem" className="danger" onClick={() => { onDeleteDrawing(selectedDrawing.id); setDrawingMenu(null); }}><Trash2 size={15} />Delete</button>
        </div>
      </>}
      {showScrollToLatest && <button className="scroll-to-latest" type="button" aria-label="Scroll to latest candle" title="Scroll to latest candle" onClick={() => chartRef.current?.timeScale().scrollToRealTime()}><ChevronsRight size={18} /></button>}
      <select className="timezone-select" aria-label="Chart timezone" value={timezone} onChange={(event) => onTimezoneChange(event.target.value as ChartTimezone)} title={`Chart timezone: ${resolveTimezone(timezone, exchange)}`}>
        {timezoneOptions.map((option) => <option key={option.value} value={option.value}>{option.value === timezone ? timezoneLabel(timezone, exchange) : option.label}</option>)}
      </select>
    </section>
  );
}
