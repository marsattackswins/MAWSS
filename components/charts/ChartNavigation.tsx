"use client";

import { getChart } from "@/lib/chart-registry";
import { mawsFeed } from "@/lib/maws/feed";
import { useAppStore } from "@/lib/store";
import type { ChartSettings } from "@/types";
import { ChevronLeft, ChevronRight, Minus, Plus, RotateCcw } from "lucide-react";
import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

type Mode = ChartSettings["navigationButtons"];

type Props = {
  paneId: string;
  mode: Mode;
  onViewReset?: () => void;
};

const PAN_FRAC = 0.28;
const DEFAULT_VISIBLE_BARS = 90;

/** Right-anchored zoom over Vela's visible time range (epoch-ms). */
function zoom(paneId: string, factor: number) {
  const handle = getChart(paneId);
  if (!handle) return;
  const range = handle.vela.getVisibleRange();
  if (!range) return;
  const span = Math.max(60_000, (range.to - range.from) * factor);
  handle.vela.setVisibleRange({ from: range.to - span, to: range.to });
}

function resetChartView(paneId: string) {
  const handle = getChart(paneId);
  if (!handle) return;
  const pane = useAppStore.getState().panes.find((p) => p.id === paneId);
  if (!pane) return;
  const candles = mawsFeed.getCandles(pane.symbol, pane.timeframe);
  const n = candles.length;
  if (n > 0) {
    const from = candles[Math.max(0, n - DEFAULT_VISIBLE_BARS)].time * 1000;
    handle.vela.setVisibleRange({ from, to: Date.now() + 60_000 });
  } else {
    handle.vela.setVisibleRangePreset("ALL");
  }
  try {
    handle.vela.renderer.set("autoScale", true);
  } catch {
    /* ignore */
  }
  useAppStore.getState().setPaneAutoScale(paneId, true);
}

function NavBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded-[4px] bg-(--app-hover) text-(--app-text) shadow-[0_1px_3px_rgba(0,0,0,0.45)] hover:bg-(--app-hover) hover:text-white"
      onMouseDown={(e: ReactMouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

export function ChartNavigation({ paneId, mode, onViewReset }: Props) {
  const setActivePane = useAppStore((s) => s.setActivePane);
  const [near, setNear] = useState(false);

  if (mode === "never") return null;

  const run = (fn: () => void) => {
    setActivePane(paneId);
    fn();
  };

  const bar = (
    <div className="flex items-center gap-1" onMouseDown={(e) => e.stopPropagation()}>
      <NavBtn label="Zoom out" onClick={() => run(() => zoom(paneId, 1.087))}>
        <Minus size={14} strokeWidth={2.25} />
      </NavBtn>
      <NavBtn label="Zoom in" onClick={() => run(() => zoom(paneId, 0.92))}>
        <Plus size={14} strokeWidth={2.25} />
      </NavBtn>
      <NavBtn label="Scroll left" onClick={() => run(() => getChart(paneId)?.vela.panBy(-PAN_FRAC))}>
        <ChevronLeft size={15} strokeWidth={2.25} />
      </NavBtn>
      <NavBtn label="Scroll right" onClick={() => run(() => getChart(paneId)?.vela.panBy(PAN_FRAC))}>
        <ChevronRight size={15} strokeWidth={2.25} />
      </NavBtn>
      <NavBtn
        label="Reset chart view"
        onClick={() =>
          run(() => {
            resetChartView(paneId);
            onViewReset?.();
          })
        }
      >
        <RotateCcw size={13} strokeWidth={2.25} />
      </NavBtn>
    </div>
  );

  if (mode === "always") {
    return (
      <div className="absolute bottom-8 left-1/2 z-40 -translate-x-1/2">{bar}</div>
    );
  }

  return (
    <div
      className="absolute bottom-7 left-1/2 z-40 flex h-14 w-[280px] -translate-x-1/2 items-end justify-center pb-1"
      onMouseEnter={() => setNear(true)}
      onMouseLeave={() => setNear(false)}
    >
      <div
        className={`transition-opacity duration-150 ${
          near ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        {bar}
      </div>
    </div>
  );
}
