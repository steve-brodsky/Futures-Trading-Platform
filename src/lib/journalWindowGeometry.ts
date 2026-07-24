export const JOURNAL_WINDOW_GEOMETRY_STORAGE_KEY = "northstar-journal-geometry-v2";
export const LEGACY_JOURNAL_WINDOW_GEOMETRY_STORAGE_KEY = "northstar-journal-geometry";

export const DEFAULT_JOURNAL_WINDOW_INNER_WIDTH = 1280;
export const DEFAULT_JOURNAL_WINDOW_INNER_HEIGHT = 800;
export const MIN_JOURNAL_WINDOW_INNER_WIDTH = 960;
export const MIN_JOURNAL_WINDOW_INNER_HEIGHT = 640;

export interface JournalWindowGeometryV2 {
  version: 2;
  x: number;
  y: number;
  innerWidth: number;
  innerHeight: number;
}

export interface JournalWindowFrameSize {
  width: number;
  height: number;
}

export interface JournalPhysicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface JournalPhysicalPosition {
  x: number;
  y: number;
}

interface JournalPhysicalSize {
  width: number;
  height: number;
}

export interface JournalMonitorGeometry {
  name?: string | null;
  scaleFactor?: number;
  workArea: {
    position: JournalPhysicalPosition;
    size: JournalPhysicalSize;
  };
}

function finiteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function persistedValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Parses the v2 local-storage value. Legacy records are deliberately rejected:
 * their outer dimensions cannot be safely converted back to inner dimensions.
 */
export function parseJournalWindowGeometry(value: unknown): JournalWindowGeometryV2 | undefined {
  const parsed = persistedValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const geometry = parsed as Partial<Record<keyof JournalWindowGeometryV2, unknown>>;
  if (geometry.version !== 2
    || !finiteInteger(geometry.x)
    || !finiteInteger(geometry.y)
    || !finiteInteger(geometry.innerWidth)
    || !finiteInteger(geometry.innerHeight)
    || geometry.innerWidth < MIN_JOURNAL_WINDOW_INNER_WIDTH
    || geometry.innerHeight < MIN_JOURNAL_WINDOW_INNER_HEIGHT) {
    return undefined;
  }
  return {
    version: 2,
    x: geometry.x,
    y: geometry.y,
    innerWidth: geometry.innerWidth,
    innerHeight: geometry.innerHeight,
  };
}

function normalizedFrameSize(frame: JournalWindowFrameSize): JournalWindowFrameSize {
  return {
    width: Number.isFinite(frame.width) ? Math.max(0, Math.round(frame.width)) : 0,
    height: Number.isFinite(frame.height) ? Math.max(0, Math.round(frame.height)) : 0,
  };
}

function monitorWorkArea(monitor: JournalMonitorGeometry): JournalPhysicalRect | undefined {
  const { position, size } = monitor.workArea;
  if (![position.x, position.y, size.width, size.height].every((value) => Number.isFinite(value))
    || size.width <= 0
    || size.height <= 0) {
    return undefined;
  }
  return {
    x: Math.round(position.x),
    y: Math.round(position.y),
    width: Math.round(size.width),
    height: Math.round(size.height),
  };
}

export function journalWindowOuterRect(
  geometry: JournalWindowGeometryV2,
  frame: JournalWindowFrameSize,
): JournalPhysicalRect {
  const normalizedFrame = normalizedFrameSize(frame);
  return {
    x: geometry.x,
    y: geometry.y,
    width: geometry.innerWidth + normalizedFrame.width,
    height: geometry.innerHeight + normalizedFrame.height,
  };
}

function overlapArea(left: JournalPhysicalRect, right: JournalPhysicalRect): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

/**
 * Picks the monitor containing the greatest portion of the decorated window.
 * A window on a disconnected display has no overlap, so it falls back to the
 * primary monitor and then the first valid available monitor.
 */
export function selectJournalWindowMonitor(
  outerRect: JournalPhysicalRect,
  monitors: readonly JournalMonitorGeometry[],
  primaryMonitor?: JournalMonitorGeometry | null,
): JournalMonitorGeometry | undefined {
  let bestMonitor: JournalMonitorGeometry | undefined;
  let bestArea = 0;
  for (const monitor of monitors) {
    const workArea = monitorWorkArea(monitor);
    if (!workArea) continue;
    const area = overlapArea(outerRect, workArea);
    if (area > bestArea) {
      bestArea = area;
      bestMonitor = monitor;
    }
  }
  if (bestMonitor) return bestMonitor;
  if (primaryMonitor && monitorWorkArea(primaryMonitor)) return primaryMonitor;
  return monitors.find((monitor) => monitorWorkArea(monitor) != null);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

/**
 * Fits the entire decorated window inside the chosen monitor's work area while
 * retaining inner-size semantics for Tauri's setSize API.
 */
export function fitJournalWindowGeometry(
  geometry: JournalWindowGeometryV2,
  frame: JournalWindowFrameSize,
  monitors: readonly JournalMonitorGeometry[],
  primaryMonitor?: JournalMonitorGeometry | null,
): JournalWindowGeometryV2 {
  const normalizedFrame = normalizedFrameSize(frame);
  const monitor = selectJournalWindowMonitor(
    journalWindowOuterRect(geometry, normalizedFrame),
    monitors,
    primaryMonitor,
  );
  const workArea = monitor && monitorWorkArea(monitor);
  if (!workArea) return { ...geometry };

  const innerWidth = Math.min(geometry.innerWidth, Math.max(1, workArea.width - normalizedFrame.width));
  const innerHeight = Math.min(geometry.innerHeight, Math.max(1, workArea.height - normalizedFrame.height));
  const outerWidth = innerWidth + normalizedFrame.width;
  const outerHeight = innerHeight + normalizedFrame.height;

  return {
    version: 2,
    x: clamp(geometry.x, workArea.x, workArea.x + workArea.width - outerWidth),
    y: clamp(geometry.y, workArea.y, workArea.y + workArea.height - outerHeight),
    innerWidth,
    innerHeight,
  };
}

/**
 * Builds the one-time safe default used when no valid v2 record exists. Physical
 * pixels are intentionally not divided by the monitor scale factor.
 */
export function defaultJournalWindowGeometry(
  monitors: readonly JournalMonitorGeometry[],
  primaryMonitor: JournalMonitorGeometry | null | undefined,
  frame: JournalWindowFrameSize,
): JournalWindowGeometryV2 {
  const normalizedFrame = normalizedFrameSize(frame);
  const target = (primaryMonitor && monitorWorkArea(primaryMonitor) ? primaryMonitor : undefined)
    ?? monitors.find((monitor) => monitorWorkArea(monitor) != null);
  const workArea = target && monitorWorkArea(target);
  if (!workArea) {
    return {
      version: 2,
      x: 0,
      y: 0,
      innerWidth: DEFAULT_JOURNAL_WINDOW_INNER_WIDTH,
      innerHeight: DEFAULT_JOURNAL_WINDOW_INNER_HEIGHT,
    };
  }

  const innerWidth = Math.min(DEFAULT_JOURNAL_WINDOW_INNER_WIDTH, Math.max(1, workArea.width - normalizedFrame.width));
  const innerHeight = Math.min(DEFAULT_JOURNAL_WINDOW_INNER_HEIGHT, Math.max(1, workArea.height - normalizedFrame.height));
  const outerWidth = innerWidth + normalizedFrame.width;
  const outerHeight = innerHeight + normalizedFrame.height;

  return {
    version: 2,
    x: workArea.x + Math.round((workArea.width - outerWidth) / 2),
    y: workArea.y + Math.round((workArea.height - outerHeight) / 2),
    innerWidth,
    innerHeight,
  };
}
