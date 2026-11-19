"use client";

import { useEffect, useRef, useState } from "react";
import { AlertsPanel } from "@/components/alerts/AlertsPanel";
import { NewsCalendarPanel } from "@/components/calendar/NewsCalendarPanel";
import { JournalPreviewPanel } from "@/components/journal/JournalPreviewPanel";
import { ObjectTree } from "@/components/objects/ObjectTree";
import { PineScriptsPanel } from "@/components/pine/PineScriptsPanel";
import { StrategyScreener } from "@/components/maws/StrategyScreener";
import { StrategySymbolPanel } from "@/components/maws/StrategySymbolPanel";
import { useAppStore } from "@/lib/store";
import type { DockId } from "@/types";

const SYMBOL_PANEL_HEIGHT_KEY = "maws.symbolPanelHeight.v1";
const SYMBOL_PANEL_MIN_HEIGHT = 120;
const SYMBOL_PANEL_DEFAULT_HEIGHT = 280;

function clampSymbolPanelHeight(value: number, available: number): number {
  return Math.round(Math.min(Math.max(value, SYMBOL_PANEL_MIN_HEIGHT), Math.max(available, SYMBOL_PANEL_MIN_HEIGHT)));
}

function readStoredSymbolPanelHeight(): number {
  if (typeof window === "undefined") return SYMBOL_PANEL_DEFAULT_HEIGHT;
  try {
    const raw = Number(localStorage.getItem(SYMBOL_PANEL_HEIGHT_KEY));
    return Number.isFinite(raw) && raw >= SYMBOL_PANEL_MIN_HEIGHT
      ? raw
      : SYMBOL_PANEL_DEFAULT_HEIGHT;
  } catch {
    return SYMBOL_PANEL_DEFAULT_HEIGHT;
  }
}

function resolveDock(dock: DockId | string): DockId {
  // Migrate removed docks to their replacements.
  if (dock === "watchlist" || dock === "screener") return "strategy";
  if (dock === "news") return "calendar";
  return dock as DockId;
}

/** The active chart pane's symbol, whatever dock is showing above the panel. */
function SymbolPanelFooter() {
  const symbol = useAppStore((s) => s.panes.find((p) => p.id === s.activePaneId)?.symbol);
  if (!symbol) return null;
  return <StrategySymbolPanel symbol={symbol} />;
}

export function RightSidebar() {
  // Panel body + rail share the rightOpen master flag for a full fold (the
  // top-bar arrow's job); rightPanelOpen alone folds only this panel body and
  // leaves the rail on screen.
  const open = useAppStore((s) => s.rightOpen && s.rightPanelOpen);
  const width = useAppStore((s) => s.rightWidth);
  const setRightWidth = useAppStore((s) => s.setRightWidth);
  const dock = useAppStore((s) => s.rightDock);
  const effectiveDock = resolveDock(dock);
  const symbolPanelDocked = useAppStore((s) => s.symbolPanelDocked);

  const asideRef = useRef<HTMLElement>(null);
  const [symbolPanelHeight, setSymbolPanelHeight] = useState(readStoredSymbolPanelHeight);
  // Keep the stored height usable across window resizes: the card may claim
  // most of the sidebar, so re-clamp it whenever the sidebar height changes.
  useEffect(() => {
    const aside = asideRef.current;
    if (!aside || symbolPanelDocked) return;
    const fit = () =>
      setSymbolPanelHeight((h) => clampSymbolPanelHeight(h, aside.clientHeight - SYMBOL_PANEL_MIN_HEIGHT));
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(aside);
    return () => observer.disconnect();
  }, [open, symbolPanelDocked]);

  if (!open) return null;

  return (
    <aside
      ref={asideRef}
      className="relative flex shrink-0 flex-col border-l"
      style={{
        width,
        background: "var(--app-panel)",
        borderColor: "var(--app-border)",
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className="absolute top-0 -left-1 z-10 h-full w-2 cursor-col-resize"
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = width;
            const move = (ev: MouseEvent) => {
              setRightWidth(Math.min(520, Math.max(200, startW - (ev.clientX - startX))));
            };
            const up = () => {
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", up);
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
          }}
        />
        {effectiveDock === "strategy" && (
          <div className="min-h-0 flex-1">
            <StrategyScreener />
          </div>
        )}
        {effectiveDock === "alerts" && (
          <div className="min-h-0 flex-1">
            <AlertsPanel />
          </div>
        )}
        {effectiveDock === "calendar" && (
          <div className="min-h-0 flex-1">
            <NewsCalendarPanel />
          </div>
        )}
        {effectiveDock === "objects" && (
          <div className="min-h-0 flex-1">
            <ObjectTree />
          </div>
        )}
        {effectiveDock === "scripts" && (
          <div className="min-h-0 flex-1">
            <PineScriptsPanel />
          </div>
        )}
        {effectiveDock === "journal" && (
          <div className="min-h-0 flex-1">
            <JournalPreviewPanel />
          </div>
        )}
      </div>
      {/* ── active-symbol detail panel, pinned under every dock tab; reads the
          dock flag itself and collapses to the compact strip when docked.
          The expanded card gets a user-dragged height; the strip rides the
          bottom with no splitter. */}
      {!symbolPanelDocked && (
        <div
          role="separator"
          aria-orientation="horizontal"
          title="Drag to resize the symbol panel"
          className="relative z-10 h-1.5 shrink-0 cursor-row-resize"
          onMouseDown={(e) => {
            e.preventDefault();
            const aside = asideRef.current;
            const startY = e.clientY;
            const startH = symbolPanelHeight;
            let latest = startH;
            const move = (ev: MouseEvent) => {
              const available = (aside?.clientHeight ?? 600) - SYMBOL_PANEL_MIN_HEIGHT;
              latest = clampSymbolPanelHeight(startH - (ev.clientY - startY), available);
              setSymbolPanelHeight(latest);
            };
            const up = () => {
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", up);
              try {
                localStorage.setItem(SYMBOL_PANEL_HEIGHT_KEY, String(latest));
              } catch {
                // Resize still works when storage is unavailable.
              }
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
          }}
        >
          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-(--app-border)" />
        </div>
      )}
      <div
        className={symbolPanelDocked ? "flex shrink-0 flex-col" : "flex min-h-0 shrink-0 flex-col overflow-hidden"}
        style={symbolPanelDocked ? undefined : { height: symbolPanelHeight }}
      >
        <SymbolPanelFooter />
      </div>
    </aside>
  );
}
