import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Bell, BellOff, ChevronsRight, Lock, LockOpen, MoveVertical, Trash2, Volume2, X } from "lucide-react";
import {
  AreaSeries, CandlestickSeries, ColorType, createChart, CrosshairMode, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type Logical, type LogicalRange, type Time,
} from "lightweight-charts";
import type { AlertDurationSeconds, AlertSound, Bar, ChartEconomicEventSettings, ChartKind, ChartLabelSettings, ChartSessionSettings, ChartTimezone, ChartTool, Drawing, DrawingAlertConfig, DrawingAlertDirection, DrawingAlertFrequency, DrawingPatch, EconomicEvent, GexExpirationDisplay, GexView, IndicatorConfig, LineDrawing, MarketDataProvider, OrderUpdate, PointAndFigureSettings, Position, PositionDrawing, RenkoSettings, Timeframe } from "../types";
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
import { approximateDataUrlBytes, ENTRY_SCREENSHOT_MAX_BYTES } from "../lib/entryScreenshot";
import { createPositionDrawing, logicalToSourceTime, movePositionDrawing, normalizePositionQuantity, positionMetrics, sourceTimeToLogical, updatePositionPrice } from "../lib/positionDrawing";
import { formatGex, formatOpenInterest, type GexLevel } from "../lib/gex";
import { GexHeatmapPrimitive } from "../lib/gexHeatmapPrimitive";
import { defaultDrawingAlert } from "../lib/drawingAlerts";
import { ALERT_DURATIONS, ALERT_SOUNDS } from "../lib/emaAlerts";
import { playAlertSound, prepareAlertAudio } from "../lib/alertAudio";
import {
  clusterEconomicEventCoordinates, economicEventImpact, economicEventImpactLabel, economicEventLogicalPosition, economicEventsEligible,
  visibleEconomicEvents, type EconomicEventCluster,
} from "../lib/economicEvents";
import { formatEventTime } from "../lib/tradingToday";

interface Props {
  bars: Bar[];
  vwapBars: Bar[];
  kind: ChartKind;
  renkoSettings: RenkoSettings;
  pointAndFigureSettings: PointAndFigureSettings;
  magnetEnabled: boolean;
  symbol: string;
  provider: MarketDataProvider;
  tradeSymbol?: string;
  description: string;
  exchange: string;
  minMove: number;
  pointValue: number;
  currentPrice: number;
  projectedEntryPrice?: number;
  chartLabelSettings: ChartLabelSettings;
  chartSessionSettings: ChartSessionSettings;
  economicEvents: EconomicEvent[];
  economicEventSettings: ChartEconomicEventSettings;
  timeframe: Timeframe;
  timezone: ChartTimezone;
  indicators: IndicatorConfig[];
  gexLevels: GexLevel[];
  gexView: GexView;
  gexExpirationDisplay: GexExpirationDisplay;
  gexExpirationDates: string[];
  gexStatus?: string;
  gexExpirationCount: number;
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
  activeTool: ChartTool;
  drawings: Drawing[];
  onToolComplete: () => void;
  onCreateDrawing: (drawing: Drawing) => void;
  onUpdateDrawing: (id: string, patch: DrawingPatch) => void;
  onDeleteDrawing: (id: string) => void;
  initialVisibleRange?: { from: number; to: number };
  onVisibleRangeChange?: (range: { from: number; to: number }) => void;
  onTimezoneChange: (timezone: ChartTimezone) => void;
  onLoadOlder: () => void;
}

export interface TradingChartCapture {
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: string;
}

export interface TradingChartHandle {
  captureEntryScreenshot: () => Promise<TradingChartCapture>;
}

const asTime = (time: number) => time as Time;
const isIntraday = (timeframe: Timeframe) => !["D", "W", "M"].includes(timeframe);
const pricePrecision = (minMove: number) => {
  const text = minMove.toFixed(10).replace(/0+$/, "");
  return text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
};

type DisplayItem = Bar | RenkoBrick | PointAndFigureColumn;

interface PositionCoordinates {
  startX: number;
  endX: number;
  entryY: number;
  stopY: number;
  targetY: number;
}

type PositionDragKind = "body" | "entry" | "stop" | "target" | "start" | "end";

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const TradingChart = forwardRef<TradingChartHandle, Props>(function TradingChart({ bars, vwapBars, kind, renkoSettings, pointAndFigureSettings, magnetEnabled, symbol, provider, tradeSymbol, description, exchange, minMove, pointValue, currentPrice, projectedEntryPrice, chartLabelSettings, chartSessionSettings, economicEvents, economicEventSettings, timeframe, timezone, indicators, gexLevels, gexView, gexExpirationDisplay, gexExpirationDates, gexStatus, gexExpirationCount, orders, positions, orderProjection, onOrderProjectionChange, onOrderProjectionRestore, closingPositionIds, replacingOrderIds, onClosePosition, onReplaceOrder, loadingOlder, activeTool, drawings, onToolComplete, onCreateDrawing, onUpdateDrawing, onDeleteDrawing, initialVisibleRange, onVisibleRangeChange, onTimezoneChange, onLoadOlder }: Props, ref) {
  const economicEventTooltipId = useId();
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
  const gexPrimitiveRef = useRef<GexHeatmapPrimitive | null>(null);
  const gexLevelsRef = useRef(gexLevels);
  const previousBars = useRef<Bar[]>([]);
  const previousPlotPoints = useRef<Array<{ plotTime: number; sourceTime: number }>>([]);
  const barsRef = useRef(bars);
  const displayItemsRef = useRef<Map<number, DisplayItem>>(new Map());
  const sourceTimeByPlotTimeRef = useRef<Map<number, number>>(new Map());
  const plotPointsRef = useRef<Array<{ plotTime: number; sourceTime: number }>>([]);
  const magnetEnabledRef = useRef(magnetEnabled);
  const activeToolRef = useRef(activeTool);
  const drawingsRef = useRef(drawings);
  const economicEventsRef = useRef(economicEvents);
  const economicEventSettingsRef = useRef(economicEventSettings);
  const drawingCallbacksRef = useRef({ onToolComplete, onCreateDrawing, onUpdateDrawing, onDeleteDrawing });
  const loadOlderRef = useRef(onLoadOlder);
  const visibleRangeChangeRef = useRef(onVisibleRangeChange);
  const firstData = useRef(true);
  const [hovered, setHovered] = useState<DisplayItem | null>(null);
  const [hoveredGex, setHoveredGex] = useState<GexLevel | null>(null);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const [chartGeneration, setChartGeneration] = useState(0);
  const [drawingMenu, setDrawingMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [drawingAlertDraft, setDrawingAlertDraft] = useState<DrawingAlertConfig | null>(null);
  const [movingDrawingId, setMovingDrawingId] = useState<string | null>(null);
  const [selectedPositionId, setSelectedPositionId] = useState<string | null>(null);
  const [positionCoordinates, setPositionCoordinates] = useState<Record<string, PositionCoordinates>>({});
  const [tradeLineTops, setTradeLineTops] = useState<Record<string, number>>({});
  const [economicEventClusters, setEconomicEventClusters] = useState<EconomicEventCluster[]>([]);
  const [hoveredEconomicEventId, setHoveredEconomicEventId] = useState<string | null>(null);
  const [pinnedEconomicEventId, setPinnedEconomicEventId] = useState<string | null>(null);
  const [candleCountdown, setCandleCountdown] = useState("");
  const [candleCountdownTop, setCandleCountdownTop] = useState<number | null>(null);
  const [draggingOrder, setDraggingOrder] = useState<{ id: string; originalPrice: number; price: number } | null>(null);
  const draggingOrderRef = useRef<typeof draggingOrder>(null);
  const [draggingProjection, setDraggingProjection] = useState<{ field: ProjectedExitField; lineId: string; originalPrice: number; price: number; originalProjection: OrderProjection; edited: boolean } | null>(null);
  const draggingProjectionRef = useRef<typeof draggingProjection>(null);
  const syncTradeLabelsRef = useRef<() => void>(() => undefined);
  const movingDrawingIdRef = useRef<string | null>(null);
  const positionDragRef = useRef<{
    id: string;
    kind: PositionDragKind;
    pointerId: number;
    originX: number;
    originY: number;
    originLogical: number;
    originPrice: number;
    drawing: PositionDrawing;
  } | null>(null);
  const isSynthetic = kind === "renko" || kind === "point-and-figure";
  const vwapIndicator = indicators.find((indicator) => indicator.kind === "VWAP" && indicator.visible);
  const chartBarTimes = useMemo(() => bars.map((bar) => bar.time), [bars]);
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

  useImperativeHandle(ref, () => ({
    captureEntryScreenshot: async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const chart = chartRef.current;
      const stage = host.current?.parentElement;
      if (!chart || !stage || stage.clientWidth <= 0 || stage.clientHeight <= 0) throw new Error("The originating chart is not ready for capture.");
      const required = (["position", "take-profit", "stop-loss"] as const).map((lineKind) => tradeLines.find((line) => line.kind === lineKind));
      if (required.some((line) => !line || tradeLineTops[line.id] == null || tradeLineTops[line.id] < 0 || tradeLineTops[line.id] > stage.clientHeight)) throw new Error("Waiting for the position, stop-loss, and take-profit lines to be visible.");

      const source = chart.takeScreenshot(true, false);
      const output = document.createElement("canvas");
      output.width = source.width;
      output.height = source.height;
      const context = output.getContext("2d");
      if (!context) throw new Error("Chart image rendering is unavailable.");
      context.drawImage(source, 0, 0);
      const scaleX = source.width / stage.clientWidth;
      const scaleY = source.height / stage.clientHeight;
      const headerHeight = Math.round(31 * scaleY);
      context.fillStyle = "rgba(11,15,23,.9)";
      context.fillRect(0, 0, source.width, headerHeight);
      context.fillStyle = "#d8dee8";
      context.font = `600 ${Math.max(11, Math.round(11 * scaleY))}px DM Mono, monospace`;
      context.textBaseline = "middle";
      context.fillText(`${symbol}${tradeSymbol && tradeSymbol !== symbol ? `  ·  ${tradeSymbol}` : ""}  ·  ${timeframe}  ·  ${exchange}`, Math.round(13 * scaleX), headerHeight / 2);

      required.forEach((line) => {
        if (!line) return;
        const top = (tradeLineTops[line.id] ?? 0) * scaleY;
        const priceValue = displayPrices.get(line.id) ?? line.price;
        const metric = tradeLineMetrics.get(line.id);
        const metricText = metric ? formatTradeLineMetrics(metric, chartLabelSettings) : null;
        const name = line.kind === "position" ? `${line.side.toUpperCase()} POSITION ${line.quantity}`
          : line.kind === "take-profit" ? `TAKE PROFIT ${line.quantity}` : `STOP LOSS ${line.quantity}`;
        const textValue = `${name}  ${priceValue.toFixed(pricePrecision(minMove))}${metricText ? `  ${metricText}` : ""}`;
        context.font = `600 ${Math.max(10, Math.round(chartLabelSettings.fontSize * scaleY))}px DM Mono, monospace`;
        const paddingX = Math.round(8 * scaleX);
        const labelHeight = Math.round((chartLabelSettings.fontSize + 14) * scaleY);
        const labelWidth = Math.min(source.width - Math.round(24 * scaleX), Math.ceil(context.measureText(textValue).width + paddingX * 2));
        const x = source.width - Math.round(76 * scaleX) - labelWidth;
        const y = Math.round(top - labelHeight / 2);
        const negative = line.kind === "stop-loss" || (line.kind === "position" && line.side === "Short");
        const color = negative ? "#ef466f" : "#16c79a";
        context.fillStyle = negative ? "rgba(42,12,20,.96)" : "rgba(8,34,28,.96)";
        context.fillRect(x, y, labelWidth, labelHeight);
        context.strokeStyle = color;
        context.lineWidth = Math.max(1, scaleX);
        context.strokeRect(x + .5, y + .5, labelWidth - 1, labelHeight - 1);
        context.fillStyle = "#eef3f8";
        context.textBaseline = "middle";
        context.fillText(textValue, x + paddingX, y + labelHeight / 2);
      });

      const dataUrl = output.toDataURL("image/png");
      if (approximateDataUrlBytes(dataUrl) > ENTRY_SCREENSHOT_MAX_BYTES) throw new Error("The entry chart exceeds the 5 MB cloud limit.");
      return { dataUrl, width: output.width, height: output.height, capturedAt: new Date().toISOString() };
    },
  }));

  barsRef.current = bars;
  gexLevelsRef.current = gexLevels;
  displayItemsRef.current = displayMap;
  sourceTimeByPlotTimeRef.current = sourceTimeMap;
  plotPointsRef.current = plotPoints;
  magnetEnabledRef.current = magnetEnabled;
  activeToolRef.current = activeTool;
  drawingsRef.current = drawings;
  economicEventsRef.current = economicEvents;
  economicEventSettingsRef.current = economicEventSettings;
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
    const chart = chartRef.current;
    if (!chart) return;
    const positionNext: Record<string, PositionCoordinates> = {};
    drawingsRef.current.forEach((drawing) => {
      if (drawing.kind !== "position") return;
      const startX = chart.timeScale().logicalToCoordinate(sourceTimeToLogical(drawing.startTime, plotPointsRef.current) as Logical);
      const endX = chart.timeScale().logicalToCoordinate(sourceTimeToLogical(drawing.endTime, plotPointsRef.current) as Logical);
      const entryY = price.priceToCoordinate(drawing.entryPrice);
      const stopY = price.priceToCoordinate(drawing.stopPrice);
      const targetY = price.priceToCoordinate(drawing.targetPrice);
      if ([startX, endX, entryY, stopY, targetY].some((value) => value == null)) return;
      positionNext[drawing.id] = { startX: Number(startX), endX: Number(endX), entryY: Number(entryY), stopY: Number(stopY), targetY: Number(targetY) };
    });
    setPositionCoordinates((current) => {
      const ids = Object.keys(positionNext);
      if (ids.length === Object.keys(current).length && ids.every((id) => {
        const left = current[id]; const right = positionNext[id];
        return left && left.startX === right.startX && left.endX === right.endX && left.entryY === right.entryY && left.stopY === right.stopY && left.targetY === right.targetY;
      })) return current;
      return positionNext;
    });
    if (!economicEventsEligible(kind, timeframe)) {
      setEconomicEventClusters((current) => current.length ? [] : current);
      return;
    }
    const plotWidth = Math.max(0, (host.current?.clientWidth ?? 0) - 72);
    const coordinates = visibleEconomicEvents(economicEventsRef.current, economicEventSettingsRef.current).flatMap((event) => {
      const logical = economicEventLogicalPosition(event, plotPointsRef.current);
      if (logical == null) return [];
      const x = chart.timeScale().logicalToCoordinate(logical as Logical);
      return x != null && x >= 7 && x <= plotWidth - 7 ? [{ event, x: Number(x) }] : [];
    });
    const clusters = clusterEconomicEventCoordinates(coordinates);
    setEconomicEventClusters((current) => current.length === clusters.length && current.every((cluster, index) => {
      const next = clusters[index];
      return cluster.id === next.id && Math.abs(cluster.x - next.x) < .25 && cluster.impact === next.impact
        && cluster.events.length === next.events.length
        && cluster.events.every((event, eventIndex) => event === next.events[eventIndex]);
    }) ? current : clusters);
  };

  useEffect(() => {
    setDrawingMenu(null);
    if (activeTool !== "cursor") { movingDrawingIdRef.current = null; setMovingDrawingId(null); setSelectedPositionId(null); }
  }, [activeTool, symbol]);

  useEffect(() => { setSelectedPositionId(null); }, [symbol]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const drag = positionDragRef.current;
      if (drag) {
        const original = drag.drawing;
        drawingCallbacksRef.current.onUpdateDrawing(original.id, {
          startTime: original.startTime, endTime: original.endTime, entryPrice: original.entryPrice,
          stopPrice: original.stopPrice, targetPrice: original.targetPrice,
        });
        positionDragRef.current = null;
        chartRef.current?.applyOptions({ handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false } });
      }
      setDrawingMenu(null); movingDrawingIdRef.current = null; setMovingDrawingId(null); setPinnedEconomicEventId(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  useEffect(() => {
    if (!pinnedEconomicEventId) return;
    const closePinnedEvent = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".economic-event-marker,.economic-event-tooltip")) return;
      setPinnedEconomicEventId(null);
    };
    document.addEventListener("pointerdown", closePinnedEvent);
    return () => document.removeEventListener("pointerdown", closePinnedEvent);
  }, [pinnedEconomicEventId]);

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
    const gexPrimitive = new GexHeatmapPrimitive();
    priceSeries.attachPrimitive(gexPrimitive);
    gexPrimitiveRef.current = gexPrimitive;
    if (intraday && !isSynthetic) {
      const sessionShading = new SessionShading(chartSessionSettings);
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
      if (param.point) {
        const nearest = gexLevelsRef.current.reduce<{ level: GexLevel; distance: number } | null>((best, level) => {
          const y = priceSeries.priceToCoordinate(level.strike);
          if (y == null) return best;
          const distance = Math.abs(param.point!.y - y);
          return !best || distance < best.distance ? { level, distance } : best;
        }, null);
        setHoveredGex(nearest && nearest.distance <= 10 ? nearest.level : null);
      } else setHoveredGex(null);
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
      if (!param.point) { setDrawingMenu(null); setSelectedPositionId(null); return; }
      const tool = activeToolRef.current;
      if (!movingDrawingIdRef.current && tool === "cursor") {
        const hits = drawingsRef.current.filter((drawing) => {
          if (drawing.kind === "position") return false;
          const y = priceSeries.priceToCoordinate(drawing.points[0].price);
          if (y == null || Math.abs(y - param.point!.y) > 6) return false;
          if (drawing.kind !== "horizontal-ray") return drawing.kind === "horizontal";
          const nearest = plotPointsRef.current.reduce<{ plotTime: number; sourceTime: number } | null>((best, item) => !best || Math.abs(item.sourceTime - drawing.points[0].time) < Math.abs(best.sourceTime - drawing.points[0].time) ? item : best, null);
          const x = nearest ? chart.timeScale().timeToCoordinate(asTime(nearest.plotTime)) : null;
          return x != null && param.point!.x >= x - 6;
        });
        const selected = hits.at(-1);
        if (selected) {
          setSelectedPositionId(null);
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
      if (tool === "long-position" || tool === "short-position") {
        const startLogical = chart.timeScale().coordinateToLogical(param.point.x) ?? 0 as Logical;
        const drawing = createPositionDrawing({
          id: crypto.randomUUID(), side: tool === "long-position" ? "long" : "short", entryPrice: clickedPrice,
          startTime: time, endTime: logicalToSourceTime(Number(startLogical) + 20, plotPointsRef.current), minMove,
        });
        drawingCallbacksRef.current.onCreateDrawing(drawing);
        drawingCallbacksRef.current.onToolComplete(); setDrawingMenu(null); return;
      }

      setDrawingMenu(null);
      if (tool === "cursor") setSelectedPositionId(null);
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
      chart.remove(); chartRef.current = null; priceRef.current = null; volumeRef.current = null; indicatorRefs.current = []; tradeLineRefs.current = new Map(); drawingLineRefs.current = []; rayPrimitiveRef.current = null; sessionShadingRef.current = null; vwapPrimitiveRef.current = null; gexPrimitiveRef.current = null;
    };
  }, [kind, symbol, exchange, minMove, timeframe, timezone, renkoSettings.brickSizeTicks, renkoSettings.priceSource, renkoSettings.reversalBricks, pointAndFigureSettings.boxSizeTicks, pointAndFigureSettings.priceSource, pointAndFigureSettings.reversalBoxes]);

  useEffect(() => {
    sessionShadingRef.current?.setSettings(chartSessionSettings);
  }, [chartSessionSettings.colorMode, chartSessionSettings.overnightColor, chartSessionSettings.asiaColor, chartSessionSettings.londonColor, chartGeneration]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => syncTradeLabelsRef.current());
    return () => cancelAnimationFrame(frame);
  }, [
    economicEvents,
    economicEventSettings.enabled,
    economicEventSettings.impactVisibility.high,
    economicEventSettings.impactVisibility.medium,
    economicEventSettings.impactVisibility.low,
    economicEventSettings.impactVisibility.unrated,
    plotPoints,
    chartGeneration,
  ]);

  useEffect(() => {
    if (hoveredEconomicEventId && !economicEventClusters.some((cluster) => cluster.id === hoveredEconomicEventId)) setHoveredEconomicEventId(null);
    if (pinnedEconomicEventId && !economicEventClusters.some((cluster) => cluster.id === pinnedEconomicEventId)) setPinnedEconomicEventId(null);
  }, [economicEventClusters, hoveredEconomicEventId, pinnedEconomicEventId]);

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
    vwapPrimitiveRef.current?.setData(
      !isSynthetic && vwapIndicator ? vwapBars : [],
      chartBarTimes,
      vwapIndicator?.color ?? "#a879ff",
      timeframe,
    );
  }, [vwapBars, vwapIndicator?.id, vwapIndicator?.color, chartBarTimes, timeframe, chartGeneration, isSynthetic]);

  useEffect(() => {
    gexPrimitiveRef.current?.setData(gexLevels, gexView, gexExpirationDisplay, gexExpirationDates);
    if (!gexLevels.length) setHoveredGex(null);
  }, [gexLevels, gexView, gexExpirationDisplay, gexExpirationDates, chartGeneration]);

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
      .filter((drawing): drawing is LineDrawing => drawing.kind === "horizontal" || drawing.kind === "horizontal-ray")
      .map((drawing) => price.createPriceLine({
        price: drawing.points[0].price,
        color: drawing.color,
        lineWidth: drawing.lineWidth ?? 1,
        lineStyle: LineStyle.Solid,
        lineVisible: drawing.kind === "horizontal",
        axisLabelVisible: true,
        axisLabelColor: drawing.color,
        title: drawing.alert ? drawing.alert.enabled ? "● ALERT" : "○ ALERT" : "",
      }));
    rayPrimitiveRef.current?.setDrawings(drawings.filter((drawing): drawing is LineDrawing => drawing.kind === "horizontal-ray"));
    if (drawingMenu && !drawings.some((drawing) => drawing.id === drawingMenu.id)) setDrawingMenu(null);
    if (selectedPositionId && !drawings.some((drawing) => drawing.id === selectedPositionId && drawing.kind === "position")) setSelectedPositionId(null);
    requestAnimationFrame(() => syncTradeLabelsRef.current());
  }, [drawings, chartGeneration]);

  useEffect(() => {
    setDrawingAlertDraft(null);
  }, [drawingMenu?.id]);

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

  const startPositionDrag = (event: ReactPointerEvent<HTMLElement>, drawing: PositionDrawing, kind: PositionDragKind) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedPositionId(drawing.id);
    setDrawingMenu(null);
    if (drawing.locked) return;
    const chart = chartRef.current;
    const price = priceRef.current;
    const bounds = host.current?.getBoundingClientRect();
    if (!chart || !price || !bounds) return;
    const originX = event.clientX - bounds.left;
    const originY = event.clientY - bounds.top;
    const originLogical = Number(chart.timeScale().coordinateToLogical(originX) ?? 0);
    const originPrice = price.coordinateToPrice(originY) ?? drawing.entryPrice;
    event.currentTarget.setPointerCapture(event.pointerId);
    positionDragRef.current = { id: drawing.id, kind, pointerId: event.pointerId, originX, originY, originLogical, originPrice, drawing: { ...drawing } };
    chart.applyOptions({ handleScroll: { mouseWheel: true, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false } });
  };

  const movePositionDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = positionDragRef.current;
    const chart = chartRef.current;
    const price = priceRef.current;
    const bounds = host.current?.getBoundingClientRect();
    if (!drag || drag.pointerId !== event.pointerId || !chart || !price || !bounds) return;
    event.preventDefault();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const logical = Number(chart.timeScale().coordinateToLogical(x) ?? drag.originLogical);
    const rawPrice = price.coordinateToPrice(y) ?? drag.originPrice;
    let next = drag.drawing;
    if (drag.kind === "body") {
      const startLogical = sourceTimeToLogical(drag.drawing.startTime, plotPointsRef.current);
      const shiftedStartTime = logicalToSourceTime(startLogical + logical - drag.originLogical, plotPointsRef.current);
      next = movePositionDrawing(drag.drawing, shiftedStartTime - drag.drawing.startTime, rawPrice - drag.originPrice, minMove);
    } else if (drag.kind === "entry" || drag.kind === "stop" || drag.kind === "target") {
      const field = `${drag.kind}Price` as "entryPrice" | "stopPrice" | "targetPrice";
      next = updatePositionPrice(drag.drawing, field, drag.drawing[field] + rawPrice - drag.originPrice, minMove);
    } else {
      const otherLogical = sourceTimeToLogical(drag.kind === "start" ? drag.drawing.endTime : drag.drawing.startTime, plotPointsRef.current);
      const constrained = drag.kind === "start" ? Math.min(logical, otherLogical - 1) : Math.max(logical, otherLogical + 1);
      const changedTime = logicalToSourceTime(constrained, plotPointsRef.current);
      next = { ...drag.drawing, [drag.kind === "start" ? "startTime" : "endTime"]: changedTime };
    }
    drawingCallbacksRef.current.onUpdateDrawing(next.id, {
      startTime: next.startTime, endTime: next.endTime, entryPrice: next.entryPrice,
      stopPrice: next.stopPrice, targetPrice: next.targetPrice,
    });
  };

  const finishPositionDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = positionDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    positionDragRef.current = null;
    chartRef.current?.applyOptions({ handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false } });
    requestAnimationFrame(() => syncTradeLabelsRef.current());
  };

  const cancelPositionDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = positionDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drawingCallbacksRef.current.onUpdateDrawing(drag.id, {
      startTime: drag.drawing.startTime, endTime: drag.drawing.endTime, entryPrice: drag.drawing.entryPrice,
      stopPrice: drag.drawing.stopPrice, targetPrice: drag.drawing.targetPrice,
    });
    positionDragRef.current = null;
    chartRef.current?.applyOptions({ handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false } });
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
  const selectedPosition = selectedDrawing?.kind === "position" ? selectedDrawing : undefined;
  const selectedLineDrawing = selectedDrawing && selectedDrawing.kind !== "position" ? selectedDrawing : undefined;
  const activeEconomicEventId = pinnedEconomicEventId ?? hoveredEconomicEventId;
  const activeEconomicEvent = economicEventClusters.find((cluster) => cluster.id === activeEconomicEventId);
  const economicEventTooltipLeft = activeEconomicEvent
    ? Math.max(8, Math.min(activeEconomicEvent.x - 160, Math.max(8, (host.current?.clientWidth ?? 412) - 400)))
    : 8;
  const economicEventTimezone = resolveTimezone(timezone, exchange);
  const economicEventTimezoneLabel = timezoneLabel(timezone, exchange);

  return (
    <section className="chart-stage" aria-label={`${symbol} chart`}>
      <div className="chart-heading">
        <div className="instrument-mark">{exchange}</div><strong>{description}</strong><span>·</span><span>{symbol}</span>
        {kind === "point-and-figure" && latest && "boxes" in latest
          ? <div className="ohlc synthetic-metrics"><span className={latest.direction === "x" ? "positive" : "negative"}>{latest.direction.toUpperCase()} COLUMN</span><span>H <b>{latest.high.toFixed(pricePrecision(minMove))}</b></span><span>L <b>{latest.low.toFixed(pricePrecision(minMove))}</b></span><span>{pointAndFigureSettings.boxSizeTicks}T × {pointAndFigureSettings.reversalBoxes}</span></div>
          : latest && <div className="ohlc"><span>O <b>{latestOpen.toFixed(pricePrecision(minMove))}</b></span><span>H <b>{latest.high.toFixed(pricePrecision(minMove))}</b></span><span>L <b>{latest.low.toFixed(pricePrecision(minMove))}</b></span><span>C <b className={change >= 0 ? "positive" : "negative"}>{latest.close.toFixed(pricePrecision(minMove))}</b></span></div>}
        {syntheticLive && <span className="synthetic-live">LIVE</span>}
        {gexStatus && <div className="gex-heading"><span>{gexView === "open-interest" ? "OI" : "GEX"}</span><strong>{gexStatus}</strong><em>{gexExpirationCount} exp</em>{hoveredGex && (gexView === "open-interest"
          ? <b>{hoveredGex.strike.toFixed(pricePrecision(minMove))} · C {formatOpenInterest(hoveredGex.callOpenInterest)} · P {formatOpenInterest(hoveredGex.putOpenInterest)} · T {formatOpenInterest(hoveredGex.callOpenInterest + hoveredGex.putOpenInterest)}</b>
          : <b>{hoveredGex.strike.toFixed(pricePrecision(minMove))} · C {formatGex(hoveredGex.callGex)} · P {formatGex(-hoveredGex.putGex)} · N {formatGex(hoveredGex.netGex)}</b>)}</div>}
      </div>
      {loadingOlder && <div className="history-loading"><span />Loading history</div>}
      <div ref={host} className="chart-host" />
      {economicEventClusters.length > 0 && <div className="economic-event-axis-layer">
        {activeEconomicEvent && <div className={`economic-event-guide impact-${activeEconomicEvent.impact}`} style={{ left: activeEconomicEvent.x }} />}
        {economicEventClusters.map((cluster) => {
          const active = cluster.id === activeEconomicEventId;
          const eventTime = formatEventTime(cluster.events[0].occursAt, economicEventTimezone);
          const ariaLabel = cluster.events.length === 1
            ? `${cluster.events[0].title}, ${economicEventImpactLabel(cluster.events[0].importance)}, ${eventTime} ${economicEventTimezoneLabel}`
            : `${cluster.events.length} economic events near ${eventTime} ${economicEventTimezoneLabel}; highest is ${cluster.impact} impact`;
          return <button
            key={cluster.id}
            type="button"
            className={`economic-event-marker impact-${cluster.impact} ${active ? "active" : ""}`}
            style={{ left: cluster.x }}
            aria-label={ariaLabel}
            aria-describedby={active ? economicEventTooltipId : undefined}
            aria-pressed={pinnedEconomicEventId === cluster.id}
            onPointerEnter={() => setHoveredEconomicEventId(cluster.id)}
            onPointerLeave={() => setHoveredEconomicEventId((current) => current === cluster.id ? null : current)}
            onFocus={() => setHoveredEconomicEventId(cluster.id)}
            onBlur={() => setHoveredEconomicEventId((current) => current === cluster.id ? null : current)}
            onClick={() => setPinnedEconomicEventId((current) => current === cluster.id ? null : cluster.id)}
          >{cluster.events.length > 1 ? cluster.events.length : <span />}</button>;
        })}
        {activeEconomicEvent && <section
          id={economicEventTooltipId}
          className={`economic-event-tooltip ${pinnedEconomicEventId === activeEconomicEvent.id ? "pinned" : ""}`}
          style={{ left: economicEventTooltipLeft }}
          role={pinnedEconomicEventId === activeEconomicEvent.id ? "dialog" : "tooltip"}
          aria-label="Economic event details"
        >
          <header><span>Economic events</span><strong>{economicEventTimezoneLabel}</strong></header>
          <div>
            {activeEconomicEvent.events.map((event) => <article key={event.id}>
              <div className="economic-event-tooltip-heading">
                <time dateTime={event.occursAt}>{formatEventTime(event.occursAt, economicEventTimezone)}</time>
                <i className={`impact-${economicEventImpact(event.importance)}`}>{economicEventImpactLabel(event.importance)}</i>
              </div>
              <h4>{event.title}</h4>
              {event.reference && <p>{event.reference}</p>}
              <dl>
                <div><dt>Actual</dt><dd className={event.actual ? "has-value" : ""}>{event.actual || "—"}</dd></div>
                <div><dt>Consensus</dt><dd>{event.consensus || "—"}</dd></div>
                <div><dt>Previous</dt><dd>{event.previous || "—"}</dd></div>
                <div><dt>Forecast</dt><dd>{event.forecast || "—"}</dd></div>
              </dl>
            </article>)}
          </div>
          {pinnedEconomicEventId === activeEconomicEvent.id && <footer>Click the marker again or press Esc to close</footer>}
        </section>}
      </div>}
      <div className={`position-drawing-layer ${activeTool === "cursor" ? "interactive" : "placing"}`}>
        {drawings.filter((drawing): drawing is PositionDrawing => drawing.kind === "position").map((drawing) => {
          const coordinates = positionCoordinates[drawing.id];
          if (!coordinates) return null;
          const left = Math.min(coordinates.startX, coordinates.endX);
          const right = Math.max(coordinates.startX, coordinates.endX);
          const width = Math.max(2, right - left);
          const profitTop = Math.min(coordinates.targetY, coordinates.entryY);
          const profitHeight = Math.max(1, Math.abs(coordinates.entryY - coordinates.targetY));
          const riskTop = Math.min(coordinates.stopY, coordinates.entryY);
          const riskHeight = Math.max(1, Math.abs(coordinates.stopY - coordinates.entryY));
          const insetHandleY = (levelY: number, towardY: number) => levelY + Math.sign(towardY - levelY) * Math.min(18, Math.abs(towardY - levelY) / 2);
          const targetHandleY = insetHandleY(coordinates.targetY, coordinates.entryY);
          const stopHandleY = insetHandleY(coordinates.stopY, coordinates.entryY);
          const timeHandleY = insetHandleY(coordinates.entryY, coordinates.targetY);
          const values = positionMetrics(drawing, minMove, pointValue, currentPrice > 0 ? currentPrice : liveBar?.close ?? drawing.entryPrice);
          const selected = selectedPositionId === drawing.id;
          const dragHandlers = {
            onPointerMove: movePositionDrag,
            onPointerUp: finishPositionDrag,
            onPointerCancel: cancelPositionDrag,
          };
          return <div key={drawing.id} className={`position-drawing ${drawing.side} ${selected ? "selected" : ""} ${drawing.locked ? "locked" : ""}`}>
            <div className="position-zone profit" style={{ left, top: profitTop, width, height: profitHeight }} onPointerDown={(event) => startPositionDrag(event, drawing, "body")} {...dragHandlers} />
            <div className="position-zone risk" style={{ left, top: riskTop, width, height: riskHeight }} onPointerDown={(event) => startPositionDrag(event, drawing, "body")} {...dragHandlers} />
            <div className="position-level target" style={{ left, top: coordinates.targetY, width }} />
            <div className="position-level entry" style={{ left, top: coordinates.entryY, width }} onPointerDown={(event) => startPositionDrag(event, drawing, "entry")} {...dragHandlers} />
            <div className="position-level stop" style={{ left, top: coordinates.stopY, width }} />
            <div className="position-label target" style={{ left: left + width / 2, top: coordinates.targetY }}>
              Target: {values.targetDistance.toFixed(pricePrecision(minMove))} ({values.targetPercent.toFixed(3)}%) {values.targetTicks} ticks · Profit {currency.format(values.targetAmount)}
            </div>
            <div className={`position-label entry ${values.openPnl > 0 ? "pnl-positive" : values.openPnl < 0 ? "pnl-negative" : ""}`} style={{ left: left + width / 2, top: coordinates.entryY }} onPointerDown={(event) => startPositionDrag(event, drawing, "entry")} {...dragHandlers}>
              <span>{drawing.side.toUpperCase()} · Open P&amp;L {values.openPnl >= 0 ? "+" : ""}{currency.format(values.openPnl)} · Qty {drawing.quantity} · R/R {values.riskReward.toFixed(2)}</span>
              <button type="button" aria-label={`Edit ${drawing.side} position drawing`} title="Edit position drawing" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setSelectedPositionId(drawing.id); setDrawingMenu({ id: drawing.id, x: Math.min(left + width / 2 + 12, Math.max(8, (host.current?.clientWidth ?? 240) - 232)), y: Math.min(coordinates.entryY + 12, Math.max(8, (host.current?.clientHeight ?? 180) - 276)) }); }}>•••</button>
            </div>
            <div className="position-label stop" style={{ left: left + width / 2, top: coordinates.stopY }}>
              Stop: {values.riskDistance.toFixed(pricePrecision(minMove))} ({values.riskPercent.toFixed(3)}%) {values.riskTicks} ticks · Risk {currency.format(values.riskAmount)}
            </div>
            {selected && !drawing.locked && <>
              <button type="button" className="position-handle target" style={{ left: coordinates.startX, top: targetHandleY }} aria-label="Adjust target price" onPointerDown={(event) => startPositionDrag(event, drawing, "target")} {...dragHandlers} />
              <button type="button" className="position-handle stop" style={{ left: coordinates.startX, top: stopHandleY }} aria-label="Adjust stop price" onPointerDown={(event) => startPositionDrag(event, drawing, "stop")} {...dragHandlers} />
              <button type="button" className="position-handle start" style={{ left: coordinates.startX, top: timeHandleY }} aria-label="Adjust position start time" onPointerDown={(event) => startPositionDrag(event, drawing, "start")} {...dragHandlers} />
              <button type="button" className="position-handle end" style={{ left: coordinates.endX, top: timeHandleY }} aria-label="Adjust position end time" onPointerDown={(event) => startPositionDrag(event, drawing, "end")} {...dragHandlers} />
            </>}
          </div>;
        })}
      </div>
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
      {selectedLineDrawing && drawingMenu && <>
        <button className="drawing-menu-backdrop" aria-label="Close drawing menu" onClick={() => setDrawingMenu(null)} />
        {!drawingAlertDraft ? <div className="drawing-menu" role="menu" aria-label={`${selectedLineDrawing.kind === "horizontal-ray" ? "Horizontal ray" : "Horizontal line"} options`} style={{ left: drawingMenu.x, top: drawingMenu.y }}>
          <label className="drawing-menu-color"><input type="color" value={selectedLineDrawing.color} aria-label="Drawing color" onChange={(event) => onUpdateDrawing(selectedLineDrawing.id, { color: event.target.value })} /><span style={{ background: selectedLineDrawing.color }} />Color</label>
          <label className="drawing-menu-width"><span>Line width</span><select aria-label="Line width" value={selectedLineDrawing.lineWidth ?? 1} onChange={(event) => onUpdateDrawing(selectedLineDrawing.id, { lineWidth: Number(event.target.value) as 1 | 2 | 3 | 4 })}>{[1, 2, 3, 4].map((width) => <option key={width} value={width}>{width}px</option>)}</select></label>
          <button role="menuitem" onClick={() => { prepareAlertAudio(); setDrawingAlertDraft(selectedLineDrawing.alert ? { ...selectedLineDrawing.alert } : defaultDrawingAlert(provider, symbol)); }}>
            {selectedLineDrawing.alert?.enabled ? <Bell size={15} /> : <BellOff size={15} />}{selectedLineDrawing.alert ? "Edit alert" : "Add alert"}
          </button>
          <button role="menuitem" disabled={selectedLineDrawing.locked} onClick={() => { movingDrawingIdRef.current = selectedLineDrawing.id; setMovingDrawingId(selectedLineDrawing.id); setDrawingMenu(null); }}><MoveVertical size={15} />Move</button>
          <button role="menuitem" onClick={() => onUpdateDrawing(selectedLineDrawing.id, { locked: !selectedLineDrawing.locked })}>{selectedLineDrawing.locked ? <LockOpen size={15} /> : <Lock size={15} />}{selectedLineDrawing.locked ? "Unlock" : "Lock"}</button>
          <button role="menuitem" className="danger" onClick={() => { onDeleteDrawing(selectedLineDrawing.id); setDrawingMenu(null); }}><Trash2 size={15} />Delete</button>
        </div> : <div className="drawing-menu drawing-alert-editor" role="dialog" aria-label={`Edit ${selectedLineDrawing.kind === "horizontal-ray" ? "horizontal ray" : "horizontal line"} alert`} style={{
          left: Math.min(drawingMenu.x, Math.max(8, (host.current?.clientWidth ?? 320) - 300)),
          top: Math.min(drawingMenu.y, Math.max(8, (host.current?.clientHeight ?? 360) - 382)),
        }}>
          <header><span><strong>Drawing alert</strong><small>{symbol} · {selectedLineDrawing.points[0].price.toFixed(pricePrecision(minMove))}</small></span><button type="button" aria-label="Cancel alert editing" onClick={() => setDrawingAlertDraft(null)}><X size={14} /></button></header>
          <button type="button" className="drawing-alert-enabled" aria-pressed={drawingAlertDraft.enabled} onClick={() => setDrawingAlertDraft({
            ...drawingAlertDraft,
            enabled: !drawingAlertDraft.enabled,
            ...(!drawingAlertDraft.enabled ? { lastTriggeredAt: undefined } : {}),
          })}>
            <span><strong>{drawingAlertDraft.enabled ? "Alert armed" : "Alert disabled"}</strong><small>{drawingAlertDraft.enabled ? "Monitoring live last price" : "Save to keep this alert inactive"}</small></span><span className={`toggle ${drawingAlertDraft.enabled ? "on" : ""}`} />
          </button>
          <label><span>Condition</span><select aria-label="Drawing alert condition" value={drawingAlertDraft.direction} onChange={(event) => setDrawingAlertDraft({ ...drawingAlertDraft, direction: event.target.value as DrawingAlertDirection })}><option value="either">Crosses either direction</option><option value="above">Crosses above</option><option value="below">Crosses below</option></select></label>
          <label><span>Frequency</span><select aria-label="Drawing alert frequency" value={drawingAlertDraft.frequency} onChange={(event) => setDrawingAlertDraft({ ...drawingAlertDraft, frequency: event.target.value as DrawingAlertFrequency })}><option value="once">One time</option><option value="recurring">Recurring</option></select></label>
          <div className="drawing-alert-audio">
            <label><span>Sound</span><select aria-label="Drawing alert sound" value={drawingAlertDraft.sound} onChange={(event) => setDrawingAlertDraft({ ...drawingAlertDraft, sound: event.target.value as AlertSound })}>{ALERT_SOUNDS.map((sound) => <option key={sound.value} value={sound.value}>{sound.label}</option>)}</select></label>
            <label><span>Duration</span><select aria-label="Drawing alert duration" value={drawingAlertDraft.durationSeconds} onChange={(event) => setDrawingAlertDraft({ ...drawingAlertDraft, durationSeconds: Number(event.target.value) as AlertDurationSeconds })}>{ALERT_DURATIONS.map((duration) => <option key={duration} value={duration}>{duration}s</option>)}</select></label>
            <button type="button" aria-label="Preview drawing alert sound" title="Preview sound" onClick={() => playAlertSound(drawingAlertDraft.sound, drawingAlertDraft.durationSeconds)}><Volume2 size={14} /></button>
          </div>
          <footer>
            {selectedLineDrawing.alert && <button type="button" className="danger" onClick={() => { onUpdateDrawing(selectedLineDrawing.id, { alert: null }); setDrawingAlertDraft(null); setDrawingMenu(null); }}>Remove alert</button>}
            <button type="button" className="secondary-button" onClick={() => setDrawingAlertDraft(null)}>Cancel</button>
            <button type="button" className="primary-button" onClick={() => { onUpdateDrawing(selectedLineDrawing.id, { alert: drawingAlertDraft }); setDrawingAlertDraft(null); setDrawingMenu(null); }}>Save</button>
          </footer>
        </div>}
      </>}
      {selectedPosition && drawingMenu && <>
        <button className="drawing-menu-backdrop" aria-label="Close position properties" onClick={() => setDrawingMenu(null)} />
        <div className="drawing-menu position-properties" role="dialog" aria-label={`${selectedPosition.side} position properties`} style={{ left: drawingMenu.x, top: drawingMenu.y }}>
          <header><strong>{selectedPosition.side === "long" ? "Long" : "Short"} Position</strong><span>Analysis only</span></header>
          {(["entryPrice", "targetPrice", "stopPrice"] as const).map((field) => <label className="position-menu-field" key={field}><span>{field === "entryPrice" ? "Entry" : field === "targetPrice" ? "Target" : "Stop"}</span><input type="number" step={minMove} disabled={selectedPosition.locked} value={selectedPosition[field]} aria-label={`${field} price`} onChange={(event) => {
            const value = Number(event.target.value); if (!Number.isFinite(value)) return;
            const next = updatePositionPrice(selectedPosition, field, value, minMove);
            onUpdateDrawing(selectedPosition.id, { [field]: next[field] });
          }} /></label>)}
          <label className="position-menu-field"><span>Quantity</span><input type="number" min="1" step="1" value={selectedPosition.quantity} aria-label="Position quantity" onChange={(event) => onUpdateDrawing(selectedPosition.id, { quantity: normalizePositionQuantity(Number(event.target.value)) })} /></label>
          <button type="button" onClick={() => onUpdateDrawing(selectedPosition.id, { locked: !selectedPosition.locked })}>{selectedPosition.locked ? <LockOpen size={15} /> : <Lock size={15} />}{selectedPosition.locked ? "Unlock" : "Lock"}</button>
          <button type="button" className="danger" onClick={() => { onDeleteDrawing(selectedPosition.id); setSelectedPositionId(null); setDrawingMenu(null); }}><Trash2 size={15} />Delete</button>
        </div>
      </>}
      {showScrollToLatest && <button className="scroll-to-latest" type="button" aria-label="Scroll to latest price" title="Scroll to latest price" onClick={() => chartRef.current?.timeScale().scrollToRealTime()}><ChevronsRight size={18} /></button>}
      <select className="timezone-select" aria-label="Chart timezone" value={timezone} onChange={(event) => onTimezoneChange(event.target.value as ChartTimezone)} title={`Chart timezone: ${resolveTimezone(timezone, exchange)}`}>
        {timezoneOptions.map((option) => <option key={option.value} value={option.value}>{option.value === timezone ? timezoneLabel(timezone, exchange) : option.label}</option>)}
      </select>
    </section>
  );
});
