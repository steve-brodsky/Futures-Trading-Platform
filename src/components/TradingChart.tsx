import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronsRight, Lock, LockOpen, MoveVertical, Trash2, X } from "lucide-react";
import {
  AreaSeries, CandlestickSeries, ColorType, createChart, CrosshairMode, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type LogicalRange, type Time,
} from "lightweight-charts";
import type { Bar, ChartKind, ChartLabelSettings, ChartTimezone, Drawing, IndicatorConfig, OrderUpdate, PointAndFigureSettings, Position, RenkoSettings, Timeframe } from "../types";
import { ema, roundToTick, sma } from "../lib/indicators";
import { formatCandleCountdown } from "../lib/candleCountdown";
import { nearestCandleExtreme } from "../lib/crosshair";
import { formatChartTime, resolveTimezone, timezoneLabel, timezoneOptions } from "../lib/timezone";
import { SessionShading } from "../lib/sessionShading";
import { HorizontalRayPrimitive } from "../lib/horizontalRay";
import { buildProjectedTradeLines, buildTradeLineMetrics, buildTradeLines, formatTradeLineMetrics, snapTradeLinePrice, snapshotOrderProjection, tradeLinePriceChanged, type OrderProjection, type ProjectedExitField } from "../lib/tradeLines";
import { NySessionVwapPrimitive } from "../lib/nySessionVwapPrimitive";
import { buildPointAndFigure, buildRenko, type PointAndFigureColumn, type RenkoBrick } from "../lib/priceBasedCharts";
import { PointAndFigureSeries, type PointAndFigureSeriesData } from "../lib/pointAndFigureSeries";

interface Props {
  bars: Bar[];
  vwapBars: Bar[];
  kind: ChartKind;
  renkoSettings: RenkoSettings;
  pointAndFigureSettings: PointAndFigureSettings;
  magnetEnabled: boolean;
  symbol: string;
  tradeSymbol?: string;
  description: string;
  exchange: string;
  minMove: number;
  pointValue: number;
  currentPrice: number;
  projectedEntryPrice?: number;
  chartLabelSettings: ChartLabelSettings;
  timeframe: Timeframe;
  timezone: ChartTimezone;
  indicators: IndicatorConfig[];
  orders: OrderUpdate[];
  positions: Position[];
  orderProjection?: OrderProjection;
  onOrderProjectionChange: (field: ProjectedExitField, price: number) => void;
  onOrderProjectionRestore: (projection: OrderProjection) => void;
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

type DisplayItem = Bar | RenkoBrick | PointAndFigureColumn;

export function TradingChart({ bars, vwapBars, kind, renkoSettings, pointAndFigureSettings, magnetEnabled, symbol, tradeSymbol, description, exchange, minMove, pointValue, currentPrice, projectedEntryPrice, chartLabelSettings, timeframe, timezone, indicators, orders, positions, orderProjection, onOrderProjectionChange, onOrderProjectionRestore, closingPositionIds, replacingOrderIds, onClosePosition, onReplaceOrder, loadingOlder, activeTool, drawings, onToolComplete, onCreateDrawing, onUpdateDrawing, onDeleteDrawing, initialVisibleRange, onVisibleRangeChange, onTimezoneChange, onLoadOlder }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<any> | null>(null);
  const volumeRef = useRef<ISeriesApi<any> | null>(null);
  const indicatorRefs = useRef<Array<{ config: IndicatorConfig; series: ISeriesApi<any> }>>([]);
  const tradeLineRefs = useRef<Map<string, IPriceLine>>(new Map());
  const drawingLineRefs = useRef<IPriceLine[]>([]);
  const rayPrimitiveRef = useRef<HorizontalRayPrimitive | null>(null);
  const sessionShadingRef = useRef<SessionShading | null>(null);
  const vwapPrimitiveRef = useRef<NySessionVwapPrimitive | null>(null);
  const previousBars = useRef<Bar[]>([]);
  const previousPlotPoints = useRef<Array<{ plotTime: number; sourceTime: number }>>([]);
  const barsRef = useRef(bars);
  const displayItemsRef = useRef<Map<number, DisplayItem>>(new Map());
  const sourceTimeByPlotTimeRef = useRef<Map<number, number>>(new Map());
  const plotPointsRef = useRef<Array<{ plotTime: number; sourceTime: number }>>([]);
  const magnetEnabledRef = useRef(magnetEnabled);
  const activeToolRef = useRef(activeTool);
  const drawingsRef = useRef(drawings);
  const drawingCallbacksRef = useRef({ onToolComplete, onCreateDrawing, onUpdateDrawing, onDeleteDrawing });
  const loadOlderRef = useRef(onLoadOlder);
  const visibleRangeChangeRef = useRef(onVisibleRangeChange);
  const firstData = useRef(true);
  const [hovered, setHovered] = useState<DisplayItem | null>(null);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const [chartGeneration, setChartGeneration] = useState(0);
  const [drawingMenu, setDrawingMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [movingDrawingId, setMovingDrawingId] = useState<string | null>(null);
  const [tradeLineTops, setTradeLineTops] = useState<Record<string, number>>({});
  const [candleCountdown, setCandleCountdown] = useState("");
  const [candleCountdownTop, setCandleCountdownTop] = useState<number | null>(null);
  const [draggingOrder, setDraggingOrder] = useState<{ id: string; originalPrice: number; price: number } | null>(null);
  const draggingOrderRef = useRef<typeof draggingOrder>(null);
  const [draggingProjection, setDraggingProjection] = useState<{ field: ProjectedExitField; lineId: string; originalPrice: number; price: number; originalProjection: OrderProjection; edited: boolean } | null>(null);
  const draggingProjectionRef = useRef<typeof draggingProjection>(null);
  const syncTradeLabelsRef = useRef<() => void>(() => undefined);
  const movingDrawingIdRef = useRef<string | null>(null);
  const isSynthetic = kind === "renko" || kind === "point-and-figure";
  const renkoBricks = useMemo(() => kind === "renko" ? buildRenko(bars, minMove, renkoSettings) : [], [bars, kind, minMove, renkoSettings]);
  const pointAndFigureColumns = useMemo(() => kind === "point-and-figure" ? buildPointAndFigure(bars, minMove, pointAndFigureSettings) : [], [bars, kind, minMove, pointAndFigureSettings]);
  const displayItems = useMemo<DisplayItem[]>(() => kind === "renko" ? renkoBricks : kind === "point-and-figure" ? pointAndFigureColumns : bars, [bars, kind, renkoBricks, pointAndFigureColumns]);
  const displayTimes = useMemo(() => displayItems.map((item) => "plotTime" in item ? item.plotTime : item.time), [displayItems]);
  const displayCloses = useMemo(() => displayItems.map((item) => item.close), [displayItems]);
  const displayMap = useMemo(() => new Map(displayItems.map((item) => ["plotTime" in item ? item.plotTime : item.time, item])), [displayItems]);
  const sourceTimeMap = useMemo(() => new Map(displayItems.map((item) => ["plotTime" in item ? item.plotTime : item.time, "sourceTime" in item ? item.sourceTime : item.time])), [displayItems]);
  const plotPoints = useMemo(() => displayItems.map((item) => ({ plotTime: "plotTime" in item ? item.plotTime : item.time, sourceTime: "sourceTime" in item ? item.sourceTime : item.time })), [displayItems]);
  const liveBar = bars.at(-1);
  const syntheticLatest = kind === "renko" ? renkoBricks.at(-1) : kind === "point-and-figure" ? pointAndFigureColumns.at(-1) : undefined;
  const latest = hovered ?? syntheticLatest ?? liveBar ?? null;
  const latestOpen = latest && "open" in latest ? latest.open : latest?.low ?? 0;
  const change = latest ? latest.close - latestOpen : 0;
  const candleCountdownTone = (kind === "candles" || isSynthetic) && liveBar ? liveBar.close >= liveBar.open ? "up" : "down" : kind;
  const syntheticLive = Boolean(syntheticLatest && "provisional" in syntheticLatest && syntheticLatest.provisional);
  const tradeLines = [...buildTradeLines(tradeSymbol, positions, orders), ...buildProjectedTradeLines(orderProjection)];
  const displayPrices = new Map(tradeLines.map((line) => [line.id,
    draggingOrder && draggingOrder.id === line.order?.id ? draggingOrder.price
      : draggingProjection && draggingProjection.lineId === line.id ? draggingProjection.price
        : line.price,
  ]));
  const tradeLineMetrics = buildTradeLineMetrics(tradeLines.map((line) => ({ ...line, price: displayPrices.get(line.id) ?? line.price })), pointValue, currentPrice, projectedEntryPrice);

  barsRef.current = bars;
  displayItemsRef.current = displayMap;
  sourceTimeByPlotTimeRef.current = sourceTimeMap;
  plotPointsRef.current = plotPoints;
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
    const latestPrice = barsRef.current.at(-1)?.close;
    const latestCoordinate = latestPrice == null ? null : price.priceToCoordinate(latestPrice);
    setCandleCountdownTop((current) => current === latestCoordinate ? current : latestCoordinate);
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
      localization: { locale: "en-US", timeFormatter: (time: Time) => formatChartTime(sourceTimeByPlotTimeRef.current.get(Number(time)) ?? Number(time), zone, true) },
      grid: { vertLines: { color: "#18202d" }, horzLines: { color: "#18202d" } },
      rightPriceScale: { borderColor: "#232c39", scaleMargins: { top: 0.08, bottom: 0.22 }, minimumWidth: 72 },
      timeScale: {
        borderColor: "#232c39", timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 4.3, minBarSpacing: 1.5,
        tickMarkFormatter: (time: Time) => {
          const sourceTime = sourceTimeByPlotTimeRef.current.get(Number(time)) ?? Number(time);
          return intraday
            ? formatChartTime(sourceTime, zone)
            : new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "2-digit" }).format(new Date(sourceTime * 1000));
        },
      },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "#8291a6", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#263242" }, horzLine: { color: "#8291a6", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#263242" } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    chartRef.current = chart;
    const priceFormat = { type: "price" as const, precision: pricePrecision(minMove), minMove };

    let priceSeries: ISeriesApi<any>;
    if (kind === "line") priceSeries = chart.addSeries(LineSeries, { color: "#34d6e9", lineWidth: 2, lastValueVisible: false, priceLineVisible: true, priceFormat });
    else if (kind === "area") priceSeries = chart.addSeries(AreaSeries, { lineColor: "#37d5e8", topColor: "rgba(55,213,232,.28)", bottomColor: "rgba(55,213,232,.01)", lineWidth: 2, lastValueVisible: false, priceLineVisible: true, priceFormat });
    else if (kind === "point-and-figure") priceSeries = chart.addCustomSeries(new PointAndFigureSeries(), { upColor: "#16c79a", downColor: "#ef466f", lastValueVisible: false, priceLineVisible: true, priceFormat });
    else priceSeries = chart.addSeries(CandlestickSeries, { upColor: "#16c79a", downColor: "#ef466f", borderVisible: kind === "renko", wickVisible: kind !== "renko", wickUpColor: "#16c79a", wickDownColor: "#ef466f", lastValueVisible: false, priceLineVisible: true, priceFormat });
    priceRef.current = priceSeries;
    const rayPrimitive = new HorizontalRayPrimitive();
    priceSeries.attachPrimitive(rayPrimitive);
    rayPrimitiveRef.current = rayPrimitive;
    if (intraday && !isSynthetic) {
      const sessionShading = new SessionShading();
      priceSeries.attachPrimitive(sessionShading);
      sessionShadingRef.current = sessionShading;
      const vwapPrimitive = new NySessionVwapPrimitive();
      priceSeries.attachPrimitive(vwapPrimitive);
      vwapPrimitiveRef.current = vwapPrimitive;
    }

    if (!isSynthetic) {
      const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", lastValueVisible: false, priceLineVisible: false });
      volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volumeRef.current = volumeSeries;
    } else volumeRef.current = null;

    let settingCrosshair = false;
    chart.subscribeCrosshairMove((param) => {
      syncTradeLabelsRef.current();
      if (!param.time) return setHovered(null);
      const bar = displayItemsRef.current.get(Number(param.time)) ?? null;
      setHovered(bar);
      if (settingCrosshair || !param.sourceEvent || !param.point) return;
      let snappedPrice: number | null = null;
      if (magnetEnabledRef.current && (kind === "candles" || kind === "renko") && bar) {
        const highY = priceSeries.priceToCoordinate(bar.high);
        const lowY = priceSeries.priceToCoordinate(bar.low);
        if (highY != null && lowY != null) snappedPrice = nearestCandleExtreme(param.point.y, highY, lowY, bar.high, bar.low);
      } else if (magnetEnabledRef.current && kind === "point-and-figure" && bar && "boxes" in bar) {
        const candidates = bar.boxes.flatMap((price) => {
          const y = priceSeries.priceToCoordinate(price);
          return y == null ? [] : [{ price, distance: Math.abs(param.point!.y - y) }];
        });
        snappedPrice = candidates.sort((left, right) => left.distance - right.distance)[0]?.price ?? null;
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
          const nearest = plotPointsRef.current.reduce<{ plotTime: number; sourceTime: number } | null>((best, item) => !best || Math.abs(item.sourceTime - drawing.points[0].time) < Math.abs(best.sourceTime - drawing.points[0].time) ? item : best, null);
          const x = nearest ? chart.timeScale().timeToCoordinate(asTime(nearest.plotTime)) : null;
          return x != null && param.point!.x >= x - 6;
        });
        const selected = hits.at(-1);
        if (selected) {
          setDrawingMenu({ id: selected.id, x: Math.min(param.point.x + 10, Math.max(8, (host.current?.clientWidth ?? 240) - 190)), y: Math.min(param.point.y + 10, Math.max(8, (host.current?.clientHeight ?? 180) - 170)) });
          return;
        }
      }
      if (!param.time) { setDrawingMenu(null); return; }
      const plotTime = Number(param.time);
      const time = sourceTimeByPlotTimeRef.current.get(plotTime) ?? plotTime;
      const bar = displayItemsRef.current.get(plotTime) ?? null;
      let clickedPrice: number | null = null;
      if (magnetEnabledRef.current && (kind === "candles" || kind === "renko") && bar) {
        const highY = priceSeries.priceToCoordinate(bar.high);
        const lowY = priceSeries.priceToCoordinate(bar.low);
        if (highY != null && lowY != null) clickedPrice = nearestCandleExtreme(param.point.y, highY, lowY, bar.high, bar.low);
      } else if (magnetEnabledRef.current && kind === "point-and-figure" && bar && "boxes" in bar) {
        const candidates = bar.boxes.flatMap((price) => {
          const y = priceSeries.priceToCoordinate(price);
          return y == null ? [] : [{ price, distance: Math.abs(param.point!.y - y) }];
        });
        clickedPrice = candidates.sort((left, right) => left.distance - right.distance)[0]?.price ?? null;
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
    previousPlotPoints.current = [];
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
      chart.remove(); chartRef.current = null; priceRef.current = null; volumeRef.current = null; indicatorRefs.current = []; tradeLineRefs.current = new Map(); drawingLineRefs.current = []; rayPrimitiveRef.current = null; sessionShadingRef.current = null; vwapPrimitiveRef.current = null;
    };
  }, [kind, symbol, exchange, minMove, timeframe, timezone, renkoSettings.brickSizeTicks, renkoSettings.priceSource, renkoSettings.reversalBricks, pointAndFigureSettings.boxSizeTicks, pointAndFigureSettings.priceSource, pointAndFigureSettings.reversalBoxes]);

  useEffect(() => {
    if (isSynthetic) { setCandleCountdown(""); return; }
    const latestOpenTime = bars.at(-1)?.time;
    const price = priceRef.current;
    if (!price || latestOpenTime == null) return;
    price.applyOptions({ title: "" });
    const updateCountdown = () => setCandleCountdown(formatCandleCountdown(latestOpenTime, timeframe));
    updateCountdown();
    requestAnimationFrame(() => syncTradeLabelsRef.current());
    const timer = window.setInterval(updateCountdown, 1_000);
    return () => window.clearInterval(timer);
  }, [bars.at(-1)?.time, timeframe, chartGeneration, isSynthetic]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const priceFormat = { type: "price" as const, precision: pricePrecision(minMove), minMove };
    const visible = indicators.filter((item) => item.visible && ["SMA", "EMA"].includes(item.kind));
    const visibleIds = new Set(visible.map((config) => config.id));
    const existing = new Map(indicatorRefs.current.map((item) => [item.config.id, item]));

    indicatorRefs.current.forEach((item) => {
      if (!visibleIds.has(item.config.id)) chart.removeSeries(item.series);
    });

    const closes = displayCloses;
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
      const values = config.kind === "SMA" ? sma(closes, config.period) : ema(closes, config.period);
      series.setData(values.flatMap((value, index) => value == null ? [] : [{ time: asTime(displayTimes[index]), value }]));
      return { config, series };
    });
  }, [indicators, chartGeneration, minMove, displayItems]);

  useEffect(() => {
    const vwap = indicators.find((indicator) => indicator.kind === "VWAP" && indicator.visible);
    vwapPrimitiveRef.current?.setData(!isSynthetic && vwap ? vwapBars : [], bars.map((bar) => bar.time), vwap?.color ?? "#a879ff", timeframe);
  }, [bars, vwapBars, indicators, chartGeneration, isSynthetic]);

  useEffect(() => {
    const price = priceRef.current;
    if (!price) return;

    const lines = [...buildTradeLines(tradeSymbol, positions, orders), ...buildProjectedTradeLines(orderProjection)];
    const nextIds = new Set(lines.map((line) => line.id));
    tradeLineRefs.current.forEach((line, id) => {
      if (nextIds.has(id)) return;
      price.removePriceLine(line);
      tradeLineRefs.current.delete(id);
    });
    lines.forEach((line) => {
      const projected = line.kind === "projected-take-profit" || line.kind === "projected-stop-loss";
      const orderDrag = draggingOrderRef.current;
      const projectionDrag = draggingProjectionRef.current;
      const displayPrice = orderDrag && orderDrag.id === line.order?.id ? orderDrag.price
        : projectionDrag && projectionDrag.lineId === line.id ? projectionDrag.price
          : line.price;
      const options = { price: displayPrice, color: line.color, lineWidth: 1 as const, lineStyle: projected ? LineStyle.Dotted : LineStyle.Dashed, axisLabelVisible: false, title: "" };
      const existing = tradeLineRefs.current.get(line.id);
      if (existing) existing.applyOptions(options);
      else tradeLineRefs.current.set(line.id, price.createPriceLine(options));
    });
    requestAnimationFrame(() => syncTradeLabelsRef.current());
  }, [orders, positions, tradeSymbol, orderProjection?.takeProfit, orderProjection?.stopLoss, chartGeneration]);

  useEffect(() => {
    if (!draggingOrder?.id && !draggingProjection?.lineId) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const currentOrder = draggingOrderRef.current;
      const currentProjection = draggingProjectionRef.current;
      if (currentOrder) tradeLineRefs.current.get(`order:${currentOrder.id}`)?.applyOptions({ price: currentOrder.originalPrice });
      if (currentProjection) {
        tradeLineRefs.current.get(currentProjection.lineId)?.applyOptions({ price: currentProjection.originalPrice });
        if (currentProjection.edited) onOrderProjectionRestore(currentProjection.originalProjection);
      }
      requestAnimationFrame(() => syncTradeLabelsRef.current());
      draggingOrderRef.current = null;
      setDraggingOrder(null);
      draggingProjectionRef.current = null;
      setDraggingProjection(null);
      chartRef.current?.applyOptions({ handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false } });
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [draggingOrder?.id, draggingProjection?.lineId, onOrderProjectionRestore]);

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
    if (!chart || !price || !bars.length) return;
    const prior = previousBars.current;
    const latestBar = bars[bars.length - 1];
    sessionShadingRef.current?.setTimes(bars.map((bar) => bar.time));
    rayPrimitiveRef.current?.setTimePoints(plotPoints);
    const realtimeOnly = !isSynthetic && prior.length > 0 && bars[0].time === prior[0].time && bars.length >= prior.length && bars.length <= prior.length + 1;
    if (realtimeOnly) {
      if (kind === "candles") price.update({ time: asTime(latestBar.time), open: latestBar.open, high: latestBar.high, low: latestBar.low, close: latestBar.close });
      else price.update({ time: asTime(latestBar.time), value: latestBar.close });
      volume?.update({ time: asTime(latestBar.time), value: latestBar.volume, color: latestBar.close >= latestBar.open ? "rgba(22,199,154,.35)" : "rgba(239,70,111,.35)" });
    } else {
      const range = chart.timeScale().getVisibleLogicalRange();
      const priorAnchorIndex = range ? Math.max(0, Math.min(previousPlotPoints.current.length - 1, Math.floor(Number(range.from)))) : -1;
      const priorAnchor = priorAnchorIndex >= 0 ? previousPlotPoints.current[priorAnchorIndex]?.sourceTime : undefined;
      if (kind === "candles") price.setData(bars.map((bar) => ({ time: asTime(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
      else if (kind === "line" || kind === "area") price.setData(bars.map((bar) => ({ time: asTime(bar.time), value: bar.close })));
      else if (kind === "renko") price.setData(renkoBricks.map((brick) => ({
        time: asTime(brick.plotTime), open: brick.open, high: brick.high, low: brick.low, close: brick.close,
        color: brick.provisional ? (brick.direction === "up" ? "rgba(22,199,154,.48)" : "rgba(239,70,111,.48)") : brick.direction === "up" ? "#16c79a" : "#ef466f",
        borderColor: brick.direction === "up" ? "#16c79a" : "#ef466f",
        wickColor: "transparent",
      })));
      else price.setData(pointAndFigureColumns.map((column): PointAndFigureSeriesData => ({
        time: asTime(column.plotTime), sourceTime: column.sourceTime, direction: column.direction, boxes: column.boxes,
        high: column.high, low: column.low, close: column.close, boxSize: pointAndFigureSettings.boxSizeTicks * minMove,
        provisional: column.provisional, color: column.direction === "x" ? "#16c79a" : "#ef466f",
      })));
      volume?.setData(bars.map((bar) => ({ time: asTime(bar.time), value: bar.volume, color: bar.close >= bar.open ? "rgba(22,199,154,.35)" : "rgba(239,70,111,.35)" })));
      if (range && priorAnchor != null && plotPoints.length) {
        const nextAnchorIndex = plotPoints.reduce((best, item, index) => Math.abs(item.sourceTime - priorAnchor) < Math.abs(plotPoints[best].sourceTime - priorAnchor) ? index : best, 0);
        const shift = nextAnchorIndex - priorAnchorIndex;
        if (shift) chart.timeScale().setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
      }
    }

    const closes = displayCloses;
    indicatorRefs.current.forEach(({ config, series }) => {
      const values = config.kind === "SMA" ? sma(closes, config.period) : ema(closes, config.period);
      series.setData(values.flatMap((value, index) => value == null ? [] : [{ time: asTime(displayTimes[index]), value }]));
    });
    if (firstData.current) {
      chart.timeScale().setVisibleLogicalRange(initialVisibleRange
        ? { from: initialVisibleRange.from as any, to: initialVisibleRange.to as any }
        : { from: Math.max(0, displayItems.length - 180) as any, to: (displayItems.length + 5) as any });
      firstData.current = false;
    }
    const visibleRange = chart.timeScale().getVisibleLogicalRange();
    setShowScrollToLatest(Boolean(visibleRange && Number(visibleRange.to) < displayItems.length - 1));
    previousBars.current = bars;
    previousPlotPoints.current = plotPoints;
    requestAnimationFrame(() => syncTradeLabelsRef.current());
  }, [bars, kind, chartGeneration, displayItems, renkoBricks, pointAndFigureColumns, pointAndFigureSettings.boxSizeTicks, minMove]);

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

  const startProjectionDrag = (event: ReactPointerEvent<HTMLDivElement>, field: ProjectedExitField, lineId: string, price: number) => {
    if (!orderProjection) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const drag = { field, lineId, originalPrice: price, price, originalProjection: snapshotOrderProjection(orderProjection), edited: false };
    draggingProjectionRef.current = drag;
    setDraggingProjection(drag);
    chartRef.current?.applyOptions({ handleScroll: { mouseWheel: true, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false } });
  };

  const moveProjectionDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = draggingProjectionRef.current;
    const price = priceRef.current;
    const bounds = host.current?.getBoundingClientRect();
    if (!current || !price || !bounds) return;
    event.preventDefault();
    const rawPrice = price.coordinateToPrice(event.clientY - bounds.top);
    if (rawPrice == null) return;
    const snapped = snapTradeLinePrice(rawPrice, minMove);
    if (snapped == null || snapped === current.price) return;
    const next = { ...current, price: snapped, edited: true };
    draggingProjectionRef.current = next;
    setDraggingProjection(next);
    tradeLineRefs.current.get(current.lineId)?.applyOptions({ price: snapped });
    onOrderProjectionChange(current.field, snapped);
    syncTradeLabelsRef.current();
  };

  const finishProjectionDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = draggingProjectionRef.current;
    if (!current) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const changed = tradeLinePriceChanged(current.originalPrice, current.price, minMove);
    if (changed) onOrderProjectionChange(current.field, current.price);
    else if (current.edited) onOrderProjectionRestore(current.originalProjection);
    draggingProjectionRef.current = null;
    setDraggingProjection(null);
    chartRef.current?.applyOptions({ handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false } });
    requestAnimationFrame(() => syncTradeLabelsRef.current());
  };

  const cancelProjectionDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = draggingProjectionRef.current;
    if (!current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    tradeLineRefs.current.get(current.lineId)?.applyOptions({ price: current.originalPrice });
    if (current.edited) onOrderProjectionRestore(current.originalProjection);
    draggingProjectionRef.current = null;
    setDraggingProjection(null);
    chartRef.current?.applyOptions({ handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false } });
    requestAnimationFrame(() => syncTradeLabelsRef.current());
  };

  const promoteTradeLine = (lineId: string) => {
    const price = priceRef.current;
    const line = tradeLineRefs.current.get(lineId);
    if (!price || !line) return;
    const options = line.options();
    price.removePriceLine(line);
    tradeLineRefs.current.set(lineId, price.createPriceLine(options));
  };

  const selectedDrawing = drawingMenu ? drawings.find((drawing) => drawing.id === drawingMenu.id) : undefined;

  return (
    <section className="chart-stage" aria-label={`${symbol} chart`}>
      <div className="chart-heading">
        <div className="instrument-mark">{exchange}</div><strong>{description}</strong><span>·</span><span>{symbol}</span>
        {kind === "point-and-figure" && latest && "boxes" in latest
          ? <div className="ohlc synthetic-metrics"><span className={latest.direction === "x" ? "positive" : "negative"}>{latest.direction.toUpperCase()} COLUMN</span><span>H <b>{latest.high.toFixed(pricePrecision(minMove))}</b></span><span>L <b>{latest.low.toFixed(pricePrecision(minMove))}</b></span><span>{pointAndFigureSettings.boxSizeTicks}T × {pointAndFigureSettings.reversalBoxes}</span></div>
          : latest && <div className="ohlc"><span>O <b>{latestOpen.toFixed(pricePrecision(minMove))}</b></span><span>H <b>{latest.high.toFixed(pricePrecision(minMove))}</b></span><span>L <b>{latest.low.toFixed(pricePrecision(minMove))}</b></span><span>C <b className={change >= 0 ? "positive" : "negative"}>{latest.close.toFixed(pricePrecision(minMove))}</b></span></div>}
        {syntheticLive && <span className="synthetic-live">LIVE</span>}
      </div>
      {loadingOlder && <div className="history-loading"><span />Loading history</div>}
      <div ref={host} className="chart-host" />
      {isSynthetic && bars.length > 0 && displayItems.length === 0 && <div className="synthetic-empty"><strong>Not enough price movement</strong><span>Reduce the {kind === "renko" ? "brick" : "box"} size or load more history.</span></div>}
      {candleCountdownTop != null && liveBar && (candleCountdown || isSynthetic) && <div
        className={`current-price-label ${candleCountdownTone} ${isSynthetic ? "price-only" : ""}`}
        style={{ top: candleCountdownTop }}
        aria-label={`Current price ${liveBar.close.toFixed(pricePrecision(minMove))}${candleCountdown ? `; candle closes in ${candleCountdown}` : ""}`}
      ><strong>{liveBar.close.toFixed(pricePrecision(minMove))}</strong>{!isSynthetic && <span>{candleCountdown}</span>}</div>}
      {tradeLines.map((line) => {
        const top = tradeLineTops[line.id];
        if (top == null) return null;
        const projectionField: ProjectedExitField | undefined = line.kind === "projected-take-profit" ? "takeProfit"
          : line.kind === "projected-stop-loss" ? "stopLoss" : undefined;
        const pending = line.order && replacingOrderIds.has(line.order.id);
        const closing = Boolean(line.position && closingPositionIds.has(line.position.id));
        const displayPrice = displayPrices.get(line.id) ?? line.price;
        const metricValues = tradeLineMetrics.get(line.id);
        const metricLabel = metricValues ? formatTradeLineMetrics(metricValues, chartLabelSettings) : null;
        const contractPrefix = tradeSymbol && tradeSymbol !== symbol ? `${tradeSymbol} ` : "";
        const label = line.kind === "position" ? `${contractPrefix}${line.side.toUpperCase()} ${line.quantity}`
          : line.kind === "take-profit" ? `${contractPrefix}TP ${line.quantity}`
            : line.kind === "stop-loss" ? `${contractPrefix}SL ${line.quantity}`
              : line.kind === "projected-take-profit" ? "PROJECTED TP"
                : line.kind === "projected-stop-loss" ? "PROJECTED SL"
                  : `${contractPrefix}${line.side.toUpperCase()} ${line.quantity}`;
        return <div
          key={line.id}
          className={`trade-line-label ${line.kind} ${line.kind === "position" ? line.side.toLowerCase() : ""} ${line.draggable ? "draggable" : ""} ${pending || closing ? "pending" : ""}`}
          style={{ top, "--trade-label-font-size": `${chartLabelSettings.fontSize}px` } as CSSProperties}
          onPointerEnter={() => promoteTradeLine(line.id)}
          onFocus={() => promoteTradeLine(line.id)}
          onPointerDown={line.draggable && line.order ? (event) => startOrderDrag(event, line.order!, line.price)
            : projectionField ? (event) => startProjectionDrag(event, projectionField, line.id, line.price) : undefined}
          onPointerMove={line.order && line.draggable ? moveOrderDrag : projectionField ? moveProjectionDrag : undefined}
          onPointerUp={line.order && line.draggable ? finishOrderDrag : projectionField ? finishProjectionDrag : undefined}
          onPointerCancel={line.order && line.draggable ? cancelOrderDrag : projectionField ? cancelProjectionDrag : undefined}
          title={line.order && line.draggable ? "Drag to replace this protective order" : projectionField ? "Drag to update the order ticket price" : undefined}
        >
          <span>{closing ? "CLOSING" : pending ? "UPDATING" : label}</span><strong>{displayPrice.toFixed(pricePrecision(minMove))}</strong>{metricLabel && <em>{metricLabel}</em>}
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
      {showScrollToLatest && <button className="scroll-to-latest" type="button" aria-label="Scroll to latest price" title="Scroll to latest price" onClick={() => chartRef.current?.timeScale().scrollToRealTime()}><ChevronsRight size={18} /></button>}
      <select className="timezone-select" aria-label="Chart timezone" value={timezone} onChange={(event) => onTimezoneChange(event.target.value as ChartTimezone)} title={`Chart timezone: ${resolveTimezone(timezone, exchange)}`}>
        {timezoneOptions.map((option) => <option key={option.value} value={option.value}>{option.value === timezone ? timezoneLabel(timezone, exchange) : option.label}</option>)}
      </select>
    </section>
  );
}
