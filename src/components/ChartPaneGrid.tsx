import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { defaultChartSplitRatios, normalizeChartSplitRatio } from "../lib/chartWorkspace";
import type { ChartLayout } from "../types";

interface ChartPaneGridProps {
  layout: ChartLayout;
  ratios?: number[];
  panes: Array<{ id: string; label: string; node: ReactNode }>;
  activePaneId: string;
  onFocus: (tabId: string) => void;
  onRatiosChange: (ratios: number[]) => void;
}

type Axis = "x" | "y";

function paneStyle(layout: ChartLayout, index: number, ratios: number[]): CSSProperties {
  const percent = (value: number) => `${value * 100}%`;
  if (layout === "single") return { inset: 0 };
  if (layout === "two-columns") return index === 0
    ? { left: 0, top: 0, bottom: 0, width: percent(ratios[0]) }
    : { right: 0, top: 0, bottom: 0, width: percent(1 - ratios[0]) };
  if (layout === "two-rows") return index === 0
    ? { left: 0, right: 0, top: 0, height: percent(ratios[0]) }
    : { left: 0, right: 0, bottom: 0, height: percent(1 - ratios[0]) };
  if (layout === "three-columns") {
    const starts = [0, ratios[0], ratios[1]];
    const ends = [ratios[0], ratios[1], 1];
    return { left: percent(starts[index]), top: 0, bottom: 0, width: percent(ends[index] - starts[index]) };
  }
  if (layout === "three-rows") {
    const starts = [0, ratios[0], ratios[1]];
    const ends = [ratios[0], ratios[1], 1];
    return { top: percent(starts[index]), left: 0, right: 0, height: percent(ends[index] - starts[index]) };
  }
  const column = index % 2;
  const row = Math.floor(index / 2);
  return {
    left: column === 0 ? 0 : percent(ratios[0]),
    top: row === 0 ? 0 : percent(ratios[1]),
    width: percent(column === 0 ? ratios[0] : 1 - ratios[0]),
    height: percent(row === 0 ? ratios[1] : 1 - ratios[1]),
  };
}

function dividerDefinitions(layout: ChartLayout, ratios: number[]): Array<{ axis: Axis; ratioIndex: number; position: number }> {
  if (layout === "two-columns") return [{ axis: "x", ratioIndex: 0, position: ratios[0] }];
  if (layout === "two-rows") return [{ axis: "y", ratioIndex: 0, position: ratios[0] }];
  if (layout === "three-columns") return ratios.map((position, ratioIndex) => ({ axis: "x" as const, ratioIndex, position }));
  if (layout === "three-rows") return ratios.map((position, ratioIndex) => ({ axis: "y" as const, ratioIndex, position }));
  if (layout === "four-grid") return [
    { axis: "x", ratioIndex: 0, position: ratios[0] },
    { axis: "y", ratioIndex: 1, position: ratios[1] },
  ];
  return [];
}

export function ChartPaneGrid({ layout, ratios, panes, activePaneId, onFocus, onRatiosChange }: ChartPaneGridProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const normalized = normalizeChartSplitRatio(layout, ratios ?? defaultChartSplitRatios(layout));
  const [draftRatios, setDraftRatios] = useState(normalized);
  const [expanded, setExpanded] = useState(false);
  const draftRef = useRef(draftRatios);
  const dragRef = useRef<{ axis: Axis; ratioIndex: number; pointerId: number } | null>(null);
  draftRef.current = draftRatios;

  useEffect(() => {
    const next = normalizeChartSplitRatio(layout, ratios ?? defaultChartSplitRatios(layout));
    draftRef.current = next;
    setDraftRatios(next);
  }, [layout, JSON.stringify(ratios ?? [])]);

  useEffect(() => {
    setExpanded(false);
  }, [layout]);

  useEffect(() => {
    if (panes.length <= 1) setExpanded(false);
  }, [panes.length]);

  const updateRatio = (axis: Axis, ratioIndex: number, value: number, commit: boolean) => {
    const next = [...draftRef.current];
    next[ratioIndex] = value;
    const valid = normalizeChartSplitRatio(layout, next);
    draftRef.current = valid;
    setDraftRatios(valid);
    if (commit) onRatiosChange(valid);
  };

  const pointerRatio = (event: ReactPointerEvent, axis: Axis) => {
    const bounds = rootRef.current?.getBoundingClientRect();
    if (!bounds) return 0.5;
    return axis === "x" ? (event.clientX - bounds.left) / Math.max(1, bounds.width) : (event.clientY - bounds.top) / Math.max(1, bounds.height);
  };
  const hasExpandControl = layout !== "single" && panes.length > 1;

  return <div ref={rootRef} className={`chart-pane-grid layout-${layout} ${expanded ? "pane-expanded" : ""}`}>
    {panes.map((pane, index) => {
      const isExpandedPane = expanded && pane.id === activePaneId;
      const isHiddenPane = expanded && !isExpandedPane;
      return <div
        key={pane.id}
        className={`chart-pane-frame ${hasExpandControl ? "has-expand-control" : ""} ${pane.id === activePaneId ? "active" : ""} ${isExpandedPane ? "expanded" : ""} ${isHiddenPane ? "expanded-hidden" : ""}`}
        style={isExpandedPane ? { inset: 0 } : paneStyle(layout, index, draftRatios)}
        aria-hidden={isHiddenPane || undefined}
        inert={isHiddenPane || undefined}
        onPointerDownCapture={() => { if (!isHiddenPane && pane.id !== activePaneId) onFocus(pane.id); }}
      >
        {pane.node}
        {hasExpandControl && <button
          type="button"
          className="chart-pane-expand-button"
          aria-label={`${isExpandedPane ? "Restore" : "Expand"} ${pane.label} chart`}
          aria-pressed={isExpandedPane}
          title={`${isExpandedPane ? "Restore" : "Expand"} ${pane.label} chart`}
          onClick={(event) => {
            event.stopPropagation();
            if (isExpandedPane) setExpanded(false);
            else {
              if (pane.id !== activePaneId) onFocus(pane.id);
              setExpanded(true);
            }
          }}
        >{isExpandedPane ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>}
      </div>;
    })}
    {!expanded && dividerDefinitions(layout, draftRatios).map(({ axis, ratioIndex, position }) => <div
      key={`${axis}-${ratioIndex}`}
      className={`chart-pane-divider ${axis === "x" ? "vertical" : "horizontal"}`}
      style={axis === "x" ? { left: `${position * 100}%` } : { top: `${position * 100}%` }}
      role="separator"
      tabIndex={0}
      aria-label={`Resize chart panes ${ratioIndex + 1}`}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-valuemin={15}
      aria-valuemax={85}
      aria-valuenow={Math.round(position * 100)}
      onDoubleClick={() => {
        const defaults = defaultChartSplitRatios(layout);
        draftRef.current = defaults;
        setDraftRatios(defaults);
        onRatiosChange(defaults);
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { axis, ratioIndex, pointerId: event.pointerId };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        updateRatio(drag.axis, drag.ratioIndex, pointerRatio(event, drag.axis), false);
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        updateRatio(drag.axis, drag.ratioIndex, pointerRatio(event, drag.axis), true);
        dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        const restored = normalizeChartSplitRatio(layout, ratios ?? defaultChartSplitRatios(layout));
        draftRef.current = restored;
        setDraftRatios(restored);
        dragRef.current = null;
      }}
      onKeyDown={(event) => {
        const direction = axis === "x"
          ? event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0
          : event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
        if (!direction) return;
        event.preventDefault();
        updateRatio(axis, ratioIndex, draftRef.current[ratioIndex] + direction * (event.shiftKey ? 0.1 : 0.02), true);
      }}
    />)}
  </div>;
}
