import type { Vela, NativeRenderer } from "@/lib/charting";

/**
 * Per-chart-pane Vela handle registry (Vela migration).
 *
 * `renderer` is the chart's own NativeRenderer instance — kept so overlay
 * owners (order blocks, session breaks, trade zones) can push layer payloads
 * via `renderer.setNativeData(id, data)`.
 */
export type ChartHandle = {
  vela: Vela;
  renderer: NativeRenderer;
  /** The DOM element the chart mounted on. */
  el: HTMLElement;
};

const handles = new Map<string, ChartHandle>();

// Dev-only debugging aid: `__mawsCharts.get('<paneId>').vela` in the console.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as unknown as { __mawsCharts?: unknown }).__mawsCharts = handles;
}

// ── workspace engine handle (VelaWorkspace migration) ──────────────────────
// When the workspace engine hosts the grid, shell surfaces (TopBar screenshot,
// AppShell shortcuts) reach the shared VelaWorkspace through this accessor.
type WorkspaceHandle = {
  /** Composite screenshot of the whole grid → PNG data URL (null when empty). */
  screenshot(): string | null;
  /** Download the composite screenshot (workspace's own filename). */
  downloadScreenshot(): void;
  /** Maximize one cell over the grid (null restores). */
  maximizeCell(id: string | null): void;
};

let workspaceHandle: WorkspaceHandle | null = null;

export function setWorkspaceHandle(handle: WorkspaceHandle | null): void {
  workspaceHandle = handle;
}

export function getWorkspace(): WorkspaceHandle | null {
  return workspaceHandle;
}

let syncing = false;

function withChartSync(fn: () => void) {
  if (syncing) return;
  syncing = true;
  try {
    fn();
  } finally {
    syncing = false;
  }
}

export function registerChart(paneId: string, handle: ChartHandle) {
  handles.set(paneId, handle);
}

export function unregisterChart(paneId: string) {
  handles.delete(paneId);
}

export function getChart(paneId: string): ChartHandle | undefined {
  return handles.get(paneId);
}

/** The live Vela instance for a pane (or null). */
export function getVela(paneId: string): Vela | null {
  return handles.get(paneId)?.vela ?? null;
}

export function forEachChart(fn: (paneId: string, handle: ChartHandle) => void) {
  handles.forEach((handle, paneId) => fn(paneId, handle));
}

// ── multi-chart sync (crosshair + viewport), via Vela's public seams ─────────

/** Mirror the crosshair of `sourcePaneId` onto every other chart. `time` is epoch-ms. */
export function syncCrosshairToOthers(
  sourcePaneId: string,
  time: number | null,
  price: number | null,
) {
  withChartSync(() => {
    forEachChart((paneId, handle) => {
      if (paneId === sourcePaneId) return;
      try {
        handle.vela.renderer.setExternalCrosshair(time, price);
      } catch {
        /* renderer may not support the seam */
      }
    });
  });
}

/** Mirror the visible time range of `sourcePaneId` onto every other chart (epoch-ms). */
export function syncVisibleRangeToOthers(
  sourcePaneId: string,
  range: { from: number; to: number },
) {
  withChartSync(() => {
    forEachChart((paneId, handle) => {
      if (paneId === sourcePaneId) return;
      try {
        handle.vela.setVisibleRange(range);
      } catch {
        /* ignore */
      }
    });
  });
}

// ── last crosshair (drives context menu / shortcuts) ────────────────────────

export type LastCrosshair = {
  paneId: string;
  price: number;
  time: number | null;
};

let lastCrosshair: LastCrosshair | null = null;

export function setLastCrosshair(value: LastCrosshair | null) {
  lastCrosshair = value;
}

export function getLastCrosshair(): LastCrosshair | null {
  return lastCrosshair;
}
