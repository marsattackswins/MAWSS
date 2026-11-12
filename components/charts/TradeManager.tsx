"use client";

/**
 * TradeManager.tsx — on-chart trade management ("manage trades on the chart").
 *
 * One pill is pinned to each open position's entry line: side, size, open P&L,
 * TP/SL readouts, add/move exits, a disabled reverse control, and a close menu
 * (Close all — plus 25/50/75% where the broker supports it).
 *
 * The TP/SL chips are DRAG HANDLES: hold one and a guide line follows the
 * pointer up and down, and on release the exit is created (or moved) at that
 * price — the same path a drag of the chart's own TP/SL line takes. The pill
 * itself is pinned left or right; right-click it to switch sides.
 *
 * Every enabled action goes through the guarded MAWS dispatch layer
 * (`dispatchClosePosition`, `dispatchClosePositionFraction`, `dispatchProtect`);
 * this component never talks to a broker, exchange or the live API directly, and
 * it mutates nothing itself — the confirmed book flows back through the store.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftRight, Check, X } from "lucide-react";
import { getChart } from "@/lib/chart-registry";
import { mawsFeed, formatPrice } from "@/lib/maws/feed";
import { useBrokerBook, type BookPosition } from "@/lib/selectors/broker";
import { useAppStore } from "@/lib/store";
import { useLiveStore } from "@/lib/live/store";
import {
  dispatchClosePosition,
  dispatchClosePositionFraction,
  dispatchProtect,
} from "@/lib/trading/dispatch";
import { CLOSE_FRACTIONS, validExitPrice } from "@/lib/trade-marks";
import type { ChartPaneState } from "@/types";

type Leg = "tp" | "sl";

/** Fraction of a position a close removes when only a position id is known. */
type CloseChoice = { fraction: number; label: string };

const CLOSE_MENU: CloseChoice[] = [
  ...CLOSE_FRACTIONS.map((f) => ({ fraction: f, label: `Close ${Math.round(f * 100)}%` })),
  { fraction: 1, label: "Close all" },
];

type Drag = { leg: Leg; y: number; price: number };

function openPnl(p: BookPosition, last: number): number | null {
  if (typeof p.unrealized === "number" && Number.isFinite(p.unrealized)) return p.unrealized;
  if (!Number.isFinite(last) || !(p.qty > 0)) return null;
  return p.side === "long" ? (last - p.entry) * p.qty : (p.entry - last) * p.qty;
}

function pnlText(value: number | null): string {
  if (value == null) return "P&L —";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}`;
}

/**
 * Track the CSS pixel Y of one price inside the chart canvas. A single
 * projection call per frame, updating state only on a visible change: the pill
 * stays glued through pan, zoom and price-scale drags without re-rendering the
 * chart or its parent overlays.
 */
function usePriceAnchorY(paneId: string, price: number): number | null {
  const [y, setY] = useState<number | null>(null);

  useEffect(() => {
    let raf = 0;
    let stopped = false;
    const tick = () => {
      const handle = getChart(paneId);
      const raw = handle?.renderer.priceToPixelY(price) ?? null;
      // Keep the pill inside the chart box when the price sits off the visible window.
      const height = handle?.el.clientHeight ?? null;
      const next = raw == null || !height ? raw : Math.max(12, Math.min(height - 12, raw));
      setY((prev) => {
        if (prev == null || next == null) return prev === next ? prev : next;
        return Math.abs(prev - next) < 0.5 ? prev : next;
      });
      if (!stopped) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [paneId, price]);

  return y;
}

function notify(text: string) {
  useLiveStore.getState().notify("error", text);
}

function PositionPill({
  pane,
  position,
  live,
}: {
  pane: ChartPaneState;
  position: BookPosition;
  live: boolean;
}) {
  const y = usePriceAnchorY(pane.id, position.entry);
  const side = useAppStore((s) => s.chartSettings.tradePillSide);
  const patchChartSettings = useAppStore((s) => s.patchChartSettings);
  const [menu, setMenu] = useState(false);
  const [sideMenu, setSideMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const long = position.side === "long";
  const last = mawsFeed.getQuote(position.symbol).last;
  const pnl = openPnl(position, last);

  const closeMenus = useCallback(() => {
    setMenu(false);
    setSideMenu(false);
  }, []);

  useEffect(() => {
    if (!menu && !sideMenu) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      closeMenus();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menu, sideMenu, closeMenus]);

  const runClose = async (fraction: number) => {
    closeMenus();
    const question =
      fraction >= 1
        ? `Close the ${position.side} ${position.qty} ${position.symbol} position at market?`
        : `Close ${Math.round(fraction * 100)}% of the ${position.side} ${position.symbol} position at market?`;
    if (!window.confirm(question)) return;
    setBusy(true);
    const result =
      fraction >= 1
        ? await dispatchClosePosition(live ? position.symbol : position.id)
        : await dispatchClosePositionFraction(position.id, fraction);
    setBusy(false);
    if (!result.ok) notify(result.error ?? "Close rejected");
  };

  /** Commit one exit leg at a price through the guarded path. */
  const commitExit = useCallback(
    async (leg: Leg, price: number) => {
      if (!validExitPrice(position.side, position.entry, leg, price)) {
        notify(
          leg === "tp"
            ? "Take profit must be on the profit side of the entry"
            : "Stop loss must be on the loss side of the entry",
        );
        return;
      }
      
      // For new exits (when tp/sl is null), always allow setting them
      const currentTpOrSl = leg === "tp" ? position.tp : position.sl;
      if (currentTpOrSl === null) {
        // Allow any price for initial placement
      } else if (leg === "tp") {
        // Existing TP validation
        if ((long && price <= position.entry) || (!long && price >= position.entry)) {
          notify("Take profit must be on the profit side of the entry");
          return;
        }
      } else {
        // Existing SL validation
        if ((long && price >= position.entry) || (!long && price <= position.entry)) {
          notify("Stop loss must be on the loss side of the entry");
          return;
        }
      }
      
      if (live) {
        const result = await dispatchProtect(
          position.symbol,
          leg === "tp" ? price : position.tp,
          leg === "sl" ? price : position.sl,
        );
        if (!result.ok) notify(result.error ?? "Protective order rejected");
      }
    },
    [live, position.entry, position.id, position.side, position.sl, position.symbol, position.tp, long],
  );

  /**
   * Hold a TP/SL handle: a guide line follows the pointer, and the release
   * resolves the price under it and creates/moves the exit there.
   * 
   * CRITICAL: Drag MUST start from the exact pixel location of the current
   * TP/SL price, NOT from mouse coordinates. This ensures visual continuity
   * with the horizontal guide line.
   */
  const beginExitDrag = (leg: Leg) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    
    const handle = getChart(pane.id);
    if (!handle) return;
    
    // Get the actual price we're dragging (current value or null if not set)
    const currentPrice = leg === "tp" ? position.tp : position.sl;
    
    // Use the existing price as-is if already set
    // If not set yet, use last price as starting point
    const targetPrice = currentPrice ?? mawsFeed.getQuote(position.symbol).last;
    
    // Convert target price directly to pixel Y - THIS IS THE KEY FIX
    // We want to start drag from EXACTLY where the price IS rendered
    const startYPixel = handle.renderer.priceToPixelY(targetPrice);
    
    if (startYPixel === null) {
      notify("Unable to calculate drag position");
      return;
    }
    
    // Initialize drag state with the CORRECT starting position
    // The guide line will appear exactly at this price level
    setDrag({
      leg,
      y: startYPixel,
      price: targetPrice,
    });
  };

  useEffect(() => {
    if (!drag) return;
    
    const move = (ev: PointerEvent) => {
      const handle = getChart(pane.id);
      if (!handle) return;
      
      // Get mouse position relative to chart
      const rect = handle.el.getBoundingClientRect();
      const mouseY = ev.clientY - rect.y;
      
      // Clamp to chart boundaries
      const clampedY = Math.max(0, Math.min(rect.height, mouseY));
      
      // Convert directly to price - this is what determines where guide line goes
      const price = handle.renderer.pixelYToPrice(clampedY);
      
      setDrag((d) => d ? { leg: d.leg, y: clampedY, price: price ?? d.price } : d);
    };
    
    const up = () => {
      const d = dragRef.current;
      setDrag(null);
      if (d) void commitExit(d.leg, d.price);
    };
    
    const cancel = () => setDrag(null);
    const esc = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setDrag(null);
    };
    
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", esc);
    };
  }, [drag, pane.id, commitExit]);

  if (y == null) return null;

  const exitColor = (leg: Leg) => (leg === "tp" ? "var(--tp, #26a69a)" : "var(--sl, #ef5350)");
  const exitHex = (leg: Leg) => (leg === "tp" ? "#26a69a" : "#ef5350");
  const handleProps = (leg: Leg) => ({
    onPointerDown: beginExitDrag(leg),
    title:
      leg === "tp"
        ? `Take profit ${position.tp != null ? formatPrice(position.symbol, position.tp) : "not set"} — click and drag up/down to set or move`
        : `Stop loss ${position.sl != null ? formatPrice(position.symbol, position.sl) : "not set"} — click and drag up/down to set or move`,
  });

  return (
    <div
      ref={rootRef}
      data-trade-manager-pill={side}
      className="pointer-events-none absolute inset-x-0 z-30 h-0"
      style={{ top: y }}
    >
      {/* Drag guide: the price line the exit will be created at on release. */}
      {drag && (
        <>
          <div
            className="pointer-events-none absolute inset-x-0 border-t border-dashed"
            style={{ top: drag.y, borderColor: exitColor(drag.leg) }}
          />
          <span
            className="pointer-events-none absolute rounded-[2px] px-1 py-0.5 text-[10px] font-semibold tabular-nums text-black"
            style={{
              top: drag.y,
              background: exitHex(drag.leg),
              [side]: 8,
              transform: "translateY(-50%)",
            }}
          >
            {drag.leg === "tp" ? "TP" : "SL"} {formatPrice(position.symbol, drag.price)}
          </span>
        </>
      )}

      <div
        className={`pointer-events-auto absolute flex -translate-y-1/2 flex-col items-stretch ${side === "left" ? "left-2 items-start" : "right-2 items-end"}`}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu(false);
          setSideMenu((v) => !v);
        }}
      >
        <div
          className={`flex items-stretch overflow-hidden rounded-[3px] border bg-(--app-panel)/95 text-[10px] leading-none shadow-[0_1px_4px_rgba(0,0,0,0.45)] ${
            long ? "border-[#26a69a]/60" : "border-[#ef5350]/60"
          }`}
        >
          <span
            className={`flex items-center gap-1 px-1.5 py-1 font-semibold ${
              long ? "bg-[#26a69a]/15 text-[#26a69a]" : "bg-[#ef5350]/15 text-[#ef5350]"
            }`}
            title={`${long ? "Long" : "Short"} ${position.qty} ${position.symbol} @ ${formatPrice(
              position.symbol,
              position.entry,
            )}`}
          >
            {long ? "LONG" : "SHORT"} {position.qty}
          </span>
          <span
            className={`flex items-center px-1.5 py-1 tabular-nums ${
              pnl != null && pnl >= 0 ? "text-[#26a69a]" : "text-[#ef5350]"
            }`}
            title="Open P&L"
          >
            {pnlText(pnl)}
          </span>

          <span
            {...handleProps("tp")}
            className="flex cursor-ns-resize items-center border-l border-(--app-border) px-1.5 py-1 tabular-nums text-(--app-muted) hover:bg-(--app-hover) hover:text-(--app-text)"
          >
            {position.tp != null ? `TP ${formatPrice(position.symbol, position.tp)}` : "+TP"}
          </span>
          <span
            {...handleProps("sl")}
            className="flex cursor-ns-resize items-center border-l border-(--app-border) px-1.5 py-1 tabular-nums text-(--app-muted) hover:bg-(--app-hover) hover:text-(--app-text)"
          >
            {position.sl != null ? `SL ${formatPrice(position.symbol, position.sl)}` : "+SL"}
          </span>

          <button
            type="button"
            title="Reverse is disabled. Close the position, then open the opposite side."
            aria-label="Reverse is disabled. Close the position, then open the opposite side."
            disabled
            className="flex items-center border-l border-(--app-border) px-1.5 py-1 text-(--app-muted) hover:bg-(--app-hover) hover:text-(--app-text) disabled:opacity-40"
          >
            <ArrowLeftRight size={11} />
          </button>
          <button
            type="button"
            title="Close position"
            aria-label="Close position"
            disabled={busy}
            className="flex items-center border-l border-(--app-border) px-1.5 py-1 text-(--app-muted) hover:bg-(--app-hover) hover:text-(--app-text) disabled:opacity-40"
            onClick={() => {
              setSideMenu(false);
              setMenu((v) => !v);
            }}
          >
            <X size={12} />
          </button>
        </div>

        {sideMenu && (
          <div className="ctx-menu mt-1 w-[176px]" onClick={(e) => e.stopPropagation()}>
            {(["left", "right"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className="ctx-item"
                onClick={() => {
                  patchChartSettings({ tradePillSide: option });
                  setSideMenu(false);
                }}
              >
                <span className="ctx-ico">{side === option ? <Check size={13} /> : null}</span>
                <span className="ctx-body">
                  <span className="ctx-label">Pin to {option}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {menu && (
          <div className="ctx-menu mt-1 w-[150px]" onClick={(e) => e.stopPropagation()}>
            {CLOSE_MENU.map(({ fraction, label }) => {
              const supported = fraction >= 1 || !live;
              return (
                <button
                  key={label}
                  type="button"
                  disabled={!supported}
                  title={
                    supported
                      ? undefined
                      : "Partial close is not available for live accounts — close all, or size the order manually"
                  }
                  className={`ctx-item ${supported ? "" : "cursor-not-allowed opacity-40"}`}
                  onClick={() => supported && void runClose(fraction)}
                >
                  <span className="ctx-body">
                    <span className="ctx-label">{label}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function TradeManager({ pane }: { pane: ChartPaneState }) {
  const { positions } = useBrokerBook();
  const live = useAppStore((s) => s.connectedBroker) === "binance";
  const replay = useAppStore((s) => s.replay);
  if (replay?.paneId === pane.id) return null;
  const mine = positions.filter((p) => p.symbol === pane.symbol);
  if (mine.length === 0) return null;
  return (
    <>
      {mine.map((position) => (
        <PositionPill key={position.id} pane={pane} position={position} live={live} />
      ))}
    </>
  );
}
