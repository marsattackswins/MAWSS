"use client";

/**
 * CrosshairPlus.tsx — Vela implementation.
 *
 * Hover-state is driven by Vela's public crosshair seam (onCrosshairMove), and
 * Buy/Sell rows go through the existing MAWS dispatch layer — Vela never sees
 * broker credentials or executes orders.
 */

import { formatPrice } from "@/lib/maws/feed";
import { getChart, setLastCrosshair, syncCrosshairToOthers } from "@/lib/chart-registry";
import { useAppStore } from "@/lib/store";
import { newClientOrderId, submitOrderFromUi } from "@/lib/trading/ui-orders";
import { resolveOrderQty } from "@/lib/trading/symbol-settings";
import type {
  ChartHover,
  ChartPaneState,
} from "@/types";
import { AlarmClock, ChevronsDown, ChevronsUp, Minus, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const AXIS_W = 56;

function OrderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2 11.5h8M2 8h5M2 4.5h11" stroke="currentColor" strokeWidth="1.2" />
      <path d="M11 3.5v6M8.5 6.5 11 3.5 13.5 6.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/**
 * Owns its own hover tracking so ChartPane (and heavy siblings) do not
 * re-render on every mouse move.
 */
export function CrosshairPlus({ pane, suppress }: { pane: ChartPaneState; suppress?: boolean }) {
  const setBuySellMenu = useAppStore((s) => s.setBuySellMenu);
  const setTradingSettingsSymbol = useAppStore((s) => s.setTradingSettingsSymbol);
  const addAlert = useAppStore((s) => s.addAlert);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<ChartHover>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const openRef = useRef(false);
  const overPlusRef = useRef(false);
  // Live cursor Y (client coords) over the chart element — the crosshair event
  // carries no pixel position, so the plus button tracks this instead of
  // parking at the pane's vertical center.
  const pointerYRef = useRef<number | null>(null);
  const [pointerY, setPointerY] = useState<number | null>(null);
  openRef.current = open;

  // Vela crosshair → hover state (rAF-throttled by Vela itself).
  useEffect(() => {
    let tries = 0;
    let timer = 0;
    let cancelled = false;
    let off: (() => void) | null = null;
    let offPointer: (() => void) | null = null;

    const attach = () => {
      if (cancelled) return;
      const handle = getChart(pane.id);
      if (!handle) {
        if (tries++ < 120) timer = window.setTimeout(attach, 250);
        return;
      }
      const el = handle.el;
      const onPointerMove = (ev: PointerEvent) => {
        // Menu open: freeze — the button (and its open menu) must not follow the cursor.
        if (openRef.current) return;
        if (pointerYRef.current === ev.clientY) return;
        pointerYRef.current = ev.clientY;
        setPointerY(ev.clientY);
      };
      const onPointerLeave = () => {
        // Moving onto the plus button itself leaves the chart element — keep
        // the last Y so the button (and its open menu) does not jump.
        if (overPlusRef.current) return;
        pointerYRef.current = null;
        setPointerY(null);
      };
      el.addEventListener("pointermove", onPointerMove);
      el.addEventListener("pointerleave", onPointerLeave);
      off = handle.vela.renderer.onCrosshairMove((e) => {
        if (openRef.current) return;
        if (e.price == null) {
          if (!overPlusRef.current) setHover(null);
          return;
        }
        const next: ChartHover = {
          price: e.price,
          time: e.time != null ? Math.floor(e.time / 1000) : null,
          y: 0,
          axisWidth: AXIS_W,
        };
        setHover((prev) =>
          prev &&
          Math.abs(prev.price - next.price) < 1e-12 &&
          prev.time === next.time
            ? prev
            : next,
        );
        setLastCrosshair({ paneId: pane.id, price: e.price, time: e.time ?? null });
        syncCrosshairToOthers(pane.id, e.time ?? null, e.price);
      });
      offPointer = () => {
        el.removeEventListener("pointermove", onPointerMove);
        el.removeEventListener("pointerleave", onPointerLeave);
      };
    };

    attach();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      off?.();
      offPointer?.();
    };
  }, [pane.id]);

  useLayoutEffect(() => {
    if (!hover) {
      setAnchor(null);
      return;
    }
    const handle = getChart(pane.id);
    if (!handle) return;
    const rect = handle.el.getBoundingClientRect();
    setAnchor({
      left: rect.right - hover.axisWidth - 28,
      // Ride the cursor: center the 24px button on the pointer's Y (client
      // coords — the button is position:fixed). Fall back to the pane's
      // vertical center when the crosshair moved without a pointer (keyboard).
      top: pointerYRef.current ?? rect.top + rect.height / 2 - 12,
    });
  }, [hover, pointerY, pane.id]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node)) return;
      if (wrapRef.current?.contains(e.target)) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-crosshair-plus]")) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!hover || !anchor || suppress) return null;

  const price = formatPrice(pane.symbol, hover.price);
  const side: "above" | "below" = "above";

  return createPortal(
    <>
      <button
        type="button"
        data-crosshair-plus
        className="fixed z-[35] flex h-6 w-6 items-center justify-center rounded-[4px] border border-(--app-border) bg-(--app-elevated) text-(--app-text) shadow-[0_2px_8px_rgba(0,0,0,0.45)] hover:bg-(--app-hover)"
        style={{ left: anchor.left, top: anchor.top }}
        onMouseEnter={() => {
          overPlusRef.current = true;
        }}
        onMouseLeave={() => {
          overPlusRef.current = false;
        }}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Plus size={14} />
      </button>
      {open && (
        <div
          ref={wrapRef}
          data-crosshair-plus
          className="fixed z-[80] w-[220px] rounded-[8px] border border-(--app-border) bg-(--app-elevated) py-1 shadow-[0_8px_28px_rgba(0,0,0,0.65)]"
          style={{ left: Math.max(8, anchor.left - 200), top: anchor.top + 28 }}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={() => {
            overPlusRef.current = true;
          }}
          onMouseLeave={() => {
            overPlusRef.current = false;
          }}
        >
          <button
            type="button"
            className="plus-row"
            onClick={() => {
              const qty = resolveOrderQty(pane.symbol, hover.price);
              if (qty > 0) {
                submitOrderFromUi({
                  symbol: pane.symbol,
                  side: "buy",
                  type: "market",
                  qty,
                  price: hover.price,
                  clientOrderId: newClientOrderId(),
                });
              }
              setOpen(false);
            }}
          >
            <ChevronsUp size={14} className="text-[#089981]" />
            <span className="plus-row-label">Buy {price}</span>
          </button>
          <button
            type="button"
            className="plus-row"
            onClick={() => {
              const qty = resolveOrderQty(pane.symbol, hover.price);
              if (qty > 0) {
                submitOrderFromUi({
                  symbol: pane.symbol,
                  side: "sell",
                  type: "market",
                  qty,
                  price: hover.price,
                  clientOrderId: newClientOrderId(),
                });
              }
              setOpen(false);
            }}
          >
            <ChevronsDown size={14} className="text-[#f23645]" />
            <span className="plus-row-label">Sell {price}</span>
          </button>
          <button
            type="button"
            className="plus-row"
            onClick={() => {
              setBuySellMenu({ x: anchor.left, y: anchor.top, symbol: pane.symbol });
              setOpen(false);
            }}
          >
            <OrderIcon />
            <span className="plus-row-label">Trade…</span>
          </button>
          <button
            type="button"
            className="plus-row"
            onClick={() => {
              addAlert({ symbol: pane.symbol, price: hover.price, side, enabled: true });
              setOpen(false);
            }}
          >
            <AlarmClock size={14} />
            <span className="plus-row-label">Add alert at {price}</span>
          </button>
          <button
            type="button"
            className="plus-row"
            onClick={() => {
              setTradingSettingsSymbol(pane.symbol);
              setOpen(false);
            }}
          >
            <Minus size={14} />
            <span className="plus-row-label">Trading settings…</span>
          </button>
        </div>
      )}
    </>,
    document.body,
  );
}
