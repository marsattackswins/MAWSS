"use client";

/**
 * Dev-only performance readout (`?perf=1`).
 *
 * Mounted only when both `NODE_ENV !== "production"` and the query flag are
 * present. While it is on it measures:
 *   - rAF rate with the median and p99 frame interval,
 *   - how many animation frames actually drew something (Canvas2D and WebGL2
 *     draw calls are wrapped ONLY while the overlay is mounted, and put back on
 *     unmount),
 *   - pointer events per second during a drag.
 * It reads nothing from the app's state, sends nothing anywhere, and persists
 * nothing but the last copied report in sessionStorage.
 */

import { describeBrowser, frameStats, perfOverlayEnabled } from "@/lib/dev-perf-overlay";
import { useEffect, useRef, useState } from "react";

const WINDOW_MS = 2_000;
const TICK_MS = 1_000;

const DRAW_2D = [
  "drawImage",
  "fillRect",
  "strokeRect",
  "fill",
  "fillText",
  "strokeText",
  "stroke",
  "clearRect",
  "putImageData",
] as const;
const DRAW_GL = [
  "drawArrays",
  "drawElements",
  "drawArraysInstanced",
  "drawElementsInstanced",
  "blitFramebuffer",
] as const;

type Snapshot = {
  frame: { samples: number; fps: number; medianMs: number; p99Ms: number };
  paint: { fps: number; draws: number; busiest: { layer: string; draws: number } | null };
  pointer: { eventsPerSecond: number; dragging: boolean };
};

type PaintCounters = { draws: number; framesWithDraw: number; dirty: boolean; layers: Map<string, number> };

const EMPTY: Snapshot = {
  frame: { samples: 0, fps: 0, medianMs: 0, p99Ms: 0 },
  paint: { fps: 0, draws: 0, busiest: null },
  pointer: { eventsPerSecond: 0, dragging: false },
};

/** Wrap the drawing entry points and hand back the undo. */
function instrumentDraws(counters: PaintCounters): () => void {
  const restores: Array<() => void> = [];
  /** Attribute each draw to the canvas it lands on — the chart tags its layers with
   *  `data-layer`, so the report can name what is actually repainting. */
  const mark = (ctx: unknown) => {
    counters.draws += 1;
    counters.dirty = true;
    const canvas = (ctx as { canvas?: HTMLCanvasElement } | null)?.canvas;
    const layer = canvas?.dataset?.layer ?? 'untagged';
    counters.layers.set(layer, (counters.layers.get(layer) ?? 0) + 1);
  };

  const wrap = (
    proto: { [key: string]: unknown } | undefined,
    names: readonly string[],
  ) => {
    if (!proto) return;
    for (const name of names) {
      const original = proto[name];
      if (typeof original !== "function") continue;
      const patched = function patched(this: unknown, ...args: unknown[]) {
        mark(this);
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      };
      proto[name] = patched;
      restores.push(() => {
        proto[name] = original;
      });
    }
  };

  wrap(globalThis.CanvasRenderingContext2D?.prototype as never, DRAW_2D);
  wrap(globalThis.WebGL2RenderingContext?.prototype as never, DRAW_GL);

  return () => {
    for (const restore of restores.reverse()) restore();
  };
}

export function PerfOverlay() {
  const [enabled] = useState(() =>
    typeof window === "undefined"
      ? false
      : perfOverlayEnabled(window.location.search, process.env.NODE_ENV),
  );
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [copied, setCopied] = useState(false);
  const latest = useRef<Snapshot>(EMPTY);

  useEffect(() => {
    if (!enabled) return;
    const counters: PaintCounters = { draws: 0, framesWithDraw: 0, dirty: false, layers: new Map() };
    const restore = instrumentDraws(counters);

    const intervals: Array<{ at: number; ms: number }> = [];
    let raf = 0;
    let lastFrame = 0;
    let paintsInSecond = 0;
    let drawsInSecond = 0;
    let pointerDown = false;
    let movesInSecond = 0;

    const onFrame = (time: number) => {
      if (lastFrame) intervals.push({ at: time, ms: time - lastFrame });
      lastFrame = time;
      if (counters.dirty) {
        paintsInSecond += 1;
        counters.dirty = false;
      }
      const cutoff = time - WINDOW_MS;
      while (intervals.length > 0 && intervals[0].at < cutoff) intervals.shift();
      raf = requestAnimationFrame(onFrame);
    };
    raf = requestAnimationFrame(onFrame);

    const onPointerDown = () => {
      pointerDown = true;
    };
    const onPointerMove = () => {
      if (pointerDown) movesInSecond += 1;
    };
    const onPointerUp = () => {
      pointerDown = false;
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);

    const tick = window.setInterval(() => {
      drawsInSecond = counters.draws;
      counters.draws = 0;
      const busiest = [...counters.layers.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
      counters.layers.clear();
      const next: Snapshot = {
        frame: frameStats(intervals.map((entry) => entry.ms)),
        paint: { fps: paintsInSecond, draws: drawsInSecond, busiest: busiest ? { layer: busiest[0], draws: busiest[1] } : null },
        pointer: { eventsPerSecond: movesInSecond, dragging: pointerDown },
      };
      paintsInSecond = 0;
      movesInSecond = 0;
      latest.current = next;
      setSnapshot(next);
    }, TICK_MS);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(tick);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      restore();
    };
  }, [enabled]);

  if (!enabled) return null;

  const browser = typeof navigator === "undefined" ? { name: "unknown", version: "unknown" } : describeBrowser(navigator.userAgent);
  const report = () => ({
    takenAt: new Date().toISOString(),
    browser: `${browser.name} ${browser.version}`,
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    devicePixelRatio: typeof window === "undefined" ? 0 : window.devicePixelRatio,
    viewport: typeof window === "undefined" ? "" : `${window.innerWidth}x${window.innerHeight}`,
    raf: latest.current.frame,
    paint: latest.current.paint,
    pointer: latest.current.pointer,
    visibility: typeof document === "undefined" ? "" : document.visibilityState,
  });

  const copy = async () => {
    const text = JSON.stringify(report(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard permission denied: sessionStorage keeps it reachable instead.
      try {
        window.sessionStorage.setItem("maws.perf.lastReport", text);
      } catch {
        /* storage disabled */
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const row = (label: string, value: string) => (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[11px] uppercase tracking-wide opacity-60">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );

  return (
    <div
      data-perf-overlay
      className="fixed bottom-3 right-3 z-[9999] w-64 rounded-[4px] border border-white/15 bg-black/80 p-3 font-mono text-[11px] leading-5 text-white shadow-xl"
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold">perf readout</span>
        <span className="text-[11px] opacity-60">?perf=1</span>
      </div>
      {row("browser", `${browser.name} ${browser.version}`)}
      {row("dpr", String(typeof window === "undefined" ? 0 : window.devicePixelRatio))}
      {row("raf fps", snapshot.frame.fps.toFixed(1))}
      {row("frame p50 / p99", `${snapshot.frame.medianMs} / ${snapshot.frame.p99Ms} ms`)}
      {row("paint fps", snapshot.paint.fps.toFixed(0))}
      {row("draw calls/s", String(snapshot.paint.draws))}
      {row("busiest layer", snapshot.paint.busiest ? `${snapshot.paint.busiest.layer} ${snapshot.paint.busiest.draws}` : "—")}
      {row("ptr/s in drag", snapshot.pointer.dragging ? String(snapshot.pointer.eventsPerSecond) : "—")}
      <button
        type="button"
        onClick={() => void copy()}
        className="mt-2 w-full rounded border border-white/20 bg-white/10 px-2 py-1 text-[11px] hover:bg-white/20"
      >
        {copied ? "Copied" : "Copy report"}
      </button>
    </div>
  );
}
