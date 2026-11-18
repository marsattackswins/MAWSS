"use client";

import { AssetLogo } from "@/components/brand/AssetLogo";
import { ColResize } from "@/components/ui/ResizableColumns";
import { formatPrice } from "@/lib/maws/feed";
import { mawsFeed } from "@/lib/maws/feed";
import { formatTicker } from "@/lib/maws/universe";

import { useAppStore } from "@/lib/store";
import type { Quote } from "@/types";
import { ChevronDown, MoreVertical } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

const MIN_LAST_WIDTH = 45;
const MIN_CHANGE_WIDTH = 40;
const DEFAULT_COLUMN_WIDTHS = [80, 56]; // [lastWidth, changeWidth]

// ─── digit-flash price ─────────────────────────────────────────────────────

function DigitFlashPrice({ symbol, value }: { symbol: string; value: number }) {
  const formatted = formatPrice(symbol, value);
  const prevFormatted = useRef<string | null>(null);
  const prevValue    = useRef<number | null>(null);
  const flashRef     = useRef<{ text: string; from: number; color: string } | null>(null);

  const prevStr = prevFormatted.current;
  const prevNum = prevValue.current;
  if (prevStr != null && prevNum != null && formatted !== prevStr && value !== prevNum) {
    let from = 0;
    const len = Math.min(formatted.length, prevStr.length);
    while (from < len && formatted[from] === prevStr[from]) from++;
    flashRef.current =
      from < formatted.length
        ? { text: formatted, from, color: value > prevNum ? "var(--app-up)" : "var(--app-down)" }
        : null;
  }
  useEffect(() => {
    prevFormatted.current = formatted;
    prevValue.current     = value;
  }, [formatted, value]);

  const flash = flashRef.current?.text === formatted ? flashRef.current : null;
  if (!flash) {
    return (
      <span className="tabular-nums text-[12px] font-semibold" style={{ color: "var(--app-text)" }}>
        {formatted}
      </span>
    );
  }
  return (
    <span className="tabular-nums text-[12px] font-semibold">
      <span style={{ color: "var(--app-text)" }}>{formatted.slice(0, flash.from)}</span>
      <span style={{ color: flash.color }}>{formatted.slice(flash.from)}</span>
    </span>
  );
}

// ─── single shared quote subscription ─────────────────────────────────────

function useScreenerQuotes(): Map<string, Quote> {
  const [map, setMap] = useState(() => new Map(mawsFeed.getQuotes().map((q) => [q.symbol, q])));
  useEffect(() => {
    return mawsFeed.subscribeQuotes((next) => {
      setMap((prev) => {
        let changed = prev.size !== next.size;
        const out = new Map<string, Quote>();
        for (const [sym, q] of next) {
          const old = prev.get(sym);
          if (old && old.last === q.last && old.changePct === q.changePct && old.volume === q.volume) {
            out.set(sym, old);
          } else { out.set(sym, q); changed = true; }
        }
        if (!changed) {
          for (const sym of prev.keys()) { if (!next.has(sym)) { changed = true; break; } }
        }
        return changed ? out : prev;
      });
    });
  }, []);
  return map;
}

// ─── icons ────────────────────────────────────────────────────────────────

// ─── title bar ─────────────────────────────────────────────────────────────

function TitleBar() {
  const watchlists = useAppStore((s) => s.watchlistGroups);
  const activeWatchlist = watchlists[0];
  const watchlistName = activeWatchlist?.name ?? "Watchlist";
  const renameWatchlist = useAppStore((s) => s.renameWatchlist);
  const createWatchlist = useAppStore((s) => s.createWatchlist);
  const activateWatchlist = useAppStore((s) => s.activateWatchlist);
  const deleteWatchlistFromStore = useAppStore((s) => s.deleteWatchlist);
  const [menuOpen, setMenuOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen && !switcherOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
        setMenuOpen(false);
        setSwitcherOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setSwitcherOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen, switcherOpen]);

  const rename = () => {
    setMenuOpen(false);
    const name = window.prompt("Rename watchlist", watchlistName);
    if (name != null) renameWatchlist(name);
  };

  const addNewWatchlist = () => {
    setMenuOpen(false);
    const name = window.prompt("Name this watchlist", "New watchlist");
    if (name != null) createWatchlist(name);
  };

  const deleteWatchlist = () => {
    setMenuOpen(false);
    if (activeWatchlist && window.confirm(`Delete "${watchlistName}"?`)) {
      deleteWatchlistFromStore(activeWatchlist.id);
    }
  };

  return (
    <div
      className="flex h-[42px] shrink-0 items-center border-b px-3"
      style={{ borderColor: "var(--app-border)" }}
    >
      <span className="flex-1 truncate text-[13px] font-semibold" style={{ color: "var(--app-text)" }}>
        {watchlistName}
      </span>
      <div ref={menuRef} className="flex items-center">
        {watchlists.length > 1 && (
          <div className="relative">
            <button
              type="button"
              title="Switch watchlist"
              aria-label="Switch watchlist"
              aria-haspopup="menu"
              aria-expanded={switcherOpen}
              onClick={() => {
                setMenuOpen(false);
                setSwitcherOpen((open) => !open);
              }}
              className="wl-icon-btn"
            >
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            {switcherOpen && (
              <div
                role="menu"
                aria-label="Switch watchlist"
                className="absolute right-0 top-full z-30 mt-1 min-w-40 rounded border py-1 shadow-xl"
                style={{
                  background: "var(--app-panel)",
                  borderColor: "var(--app-border)",
                }}
              >
                {watchlists.map((watchlist) => (
                  <button
                    key={watchlist.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={watchlist.id === activeWatchlist?.id}
                    onClick={() => {
                      activateWatchlist(watchlist.id);
                      setSwitcherOpen(false);
                    }}
                    className="block w-full truncate px-3 py-1.5 text-left text-[12px] hover:bg-(--app-hover)"
                    style={{ color: "var(--app-text)" }}
                  >
                    {watchlist.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="relative">
          <button
            type="button"
            title="Watchlist options"
            aria-label="Watchlist options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => {
              setSwitcherOpen(false);
              setMenuOpen((open) => !open);
            }}
            className="wl-icon-btn"
          >
            <MoreVertical size={15} aria-hidden="true" />
          </button>
          {menuOpen && (
            <div
              role="menu"
              aria-label="Watchlist options"
              className="absolute right-0 top-full z-30 mt-1 min-w-36 rounded border py-1 shadow-xl"
              style={{
                background: "var(--app-panel)",
                borderColor: "var(--app-border)",
              }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={rename}
                className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-(--app-hover)"
                style={{ color: "var(--app-text)" }}
              >
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={addNewWatchlist}
                className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-(--app-hover)"
                style={{ color: "var(--app-text)" }}
              >
                Add new
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={deleteWatchlist}
                className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-(--app-hover)"
                style={{ color: "var(--app-down)" }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

// ─── column header ─────────────────────────────────────────────────────────

function ColumnHeader({
  lastWidth,
  changeWidth,
  onResizeDivider1,
  onResizeDivider2,
  onResetWidths,
}: {
  lastWidth: number;
  changeWidth: number;
  onResizeDivider1: (e: React.MouseEvent<HTMLSpanElement>) => void;
  onResizeDivider2: (e: React.MouseEvent<HTMLSpanElement>) => void;
  onResetWidths: (e: React.MouseEvent<HTMLSpanElement>) => void;
}) {
  return (
    <div
      className="flex h-[28px] shrink-0 items-center border-b px-3 text-[11px] font-medium uppercase tracking-[0.05em]"
      style={{ color: "var(--app-muted)", borderColor: "var(--app-border)" }}
    >
      <div className="relative flex min-w-0 flex-1 items-center h-full">
        <span className="truncate">Symbol</span>
        <ColResize onMouseDown={onResizeDivider1} onDoubleClick={onResetWidths} />
      </div>
      <div
        className="relative flex shrink-0 items-center justify-center h-full"
        style={{ width: lastWidth }}
      >
        <span className="truncate">Last</span>
        <ColResize onMouseDown={onResizeDivider2} onDoubleClick={onResetWidths} />
      </div>
      <div
        className="flex shrink-0 items-center justify-center h-full"
        style={{ width: changeWidth }}
      >
        <span className="truncate">Day %</span>
      </div>
    </div>
  );
}

// ─── symbol row ────────────────────────────────────────────────────────────

const WatchlistRow = memo(function WatchlistRow({
  symbol,
  selected,
  dragging,
  last,
  changePct,
  lastWidth,
  changeWidth,
  onOpen,
  onPointerDragStart,
}: {
  symbol: string;
  selected: boolean;
  dragging: boolean;
  last: number | null;
  changePct: number | null;
  lastWidth: number;
  changeWidth: number;
  onOpen: (symbol: string) => void;
  onPointerDragStart: (symbol: string, clientY: number, pointerId: number) => void;
}) {
  const suppressClick = useRef(false);
  const startRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const chgColor =
    changePct == null || changePct === 0
      ? "var(--app-muted)"
      : changePct > 0 ? "var(--app-up)" : "var(--app-down)";

  return (
    <div
      data-screener-card={symbol}
      data-selected={selected ? "true" : undefined}
      style={{ borderColor: "var(--app-border)" }}
      className={[
        "wl-row border-b",
        dragging ? "wl-row is-dragging" : selected ? "wl-row is-selected" : "",
      ].join(" ")}
    >
      {/* main clickable row — 36px tall to match Vela */}
      <div
        role="button"
        tabIndex={0}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          startRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
        }}
        onPointerMove={(e) => {
          const s = startRef.current;
          if (!s || s.pointerId !== e.pointerId) return;
          if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < 8) return;
          startRef.current = null;
          suppressClick.current = true;
          onPointerDragStart(symbol, e.clientY, e.pointerId);
        }}
        onPointerUp={() => { startRef.current = null; }}
        onPointerCancel={() => { startRef.current = null; }}
        onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          onOpen(symbol);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(symbol); }
        }}
        className={`flex h-[36px] w-full items-center gap-0 select-none px-3 ${dragging ? "cursor-grabbing" : "cursor-default"}`}
      >
        {/* logo */}
        <AssetLogo symbol={symbol} size={20} className="mr-2.5 shrink-0" />

        {/* ticker — single line */}
        <span
          className="min-w-0 flex-1 truncate text-[12px] font-bold"
          style={{ color: "var(--app-text)" }}
        >
          {formatTicker(symbol)}
        </span>

        {/* last price */}
        <div className="shrink-0 text-right pr-1.5" style={{ width: lastWidth }}>
          {last == null ? (
            <span className="text-[12px] tabular-nums" style={{ color: "var(--app-muted)" }}>—</span>
          ) : (
            <DigitFlashPrice symbol={symbol} value={last!} />
          )}
        </div>

        {/* day % */}
        <div className="shrink-0 text-right" style={{ width: changeWidth }}>
          <span className="text-[12px] font-semibold tabular-nums" style={{ color: chgColor }}>
            {changePct == null
              ? "—"
              : `${changePct > 0 ? "+" : ""}${changePct.toFixed(2)}%`}
          </span>
        </div>
      </div>
    </div>
  );
});

// ─── loading row (quote not ready yet) ─────────────────────────────────

function PendingRow({
  symbol,
  selected,
  quote,
  lastWidth,
  changeWidth,
  onOpen,
}: {
  symbol: string;
  selected: boolean;
  quote: Quote | undefined;
  lastWidth: number;
  changeWidth: number;
  onOpen: (sym: string) => void;
}) {
  const chgColor =
    !quote || quote.changePct === 0
      ? "var(--app-muted)"
      : quote.changePct > 0 ? "var(--app-up)" : "var(--app-down)";

  return (
    <div
      data-screener-card={symbol}
      data-selected={selected ? "true" : undefined}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(symbol)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(symbol); } }}
      style={{ borderColor: "var(--app-border)" }}
      className={[
        "flex h-[36px] w-full cursor-default items-center select-none border-b px-3",
        selected ? "wl-row is-selected" : "wl-row",
      ].join(" ")}
    >
      {/* placeholder for logo alignment (was the signal dot) */}
      <span className="mr-2 w-5 shrink-0" />

      <AssetLogo symbol={symbol} size={20} className="mr-2.5 shrink-0" />

      {/* ticker — single line */}
      <span
        className="min-w-0 flex-1 truncate text-[12px] font-bold"
        style={{ color: "var(--app-text)" }}
      >
        {formatTicker(symbol)}
      </span>

      <div className="shrink-0 text-right pr-1.5" style={{ width: lastWidth }}>
        {quote ? (
          <DigitFlashPrice symbol={symbol} value={quote.last} />
        ) : (
          <span className="text-[12px] tabular-nums" style={{ color: "var(--app-muted)" }}>—</span>
        )}
      </div>
      <div className="shrink-0 text-right" style={{ width: changeWidth }}>
        <span className="text-[12px] font-semibold tabular-nums" style={{ color: chgColor }}>
          {quote ? `${quote.changePct > 0 ? "+" : ""}${quote.changePct.toFixed(2)}%` : "—"}
        </span>
      </div>
    </div>
  );
}

// ─── main component ────────────────────────────────────────────────────────

function bareSymbol(symbol: string) {
  return symbol.replace(/\.P$/i, "").toUpperCase();
}

export function StrategyScreener() {
  const watchlist          = useAppStore((s) => s.watchlist);
  const setWatchlistOrder  = useAppStore((s) => s.setWatchlistOrder);
  const setSymbol          = useAppStore((s) => s.setSymbol);
  const active             = useAppStore((s) => s.panes.find((p) => p.id === s.activePaneId)?.symbol);
  // Rows carry the watchlist symbol ("XAUUSDT.P") while the active pane may hold the
  // canonical universe symbol ("XAUUSDT") — compare on the bare symbol so the
  // selected-row marker survives either form.
  const activeKey = active ? bareSymbol(active) : undefined;
  const storedWidths       = useAppStore((s) => s.columnWidths["watchlist"]);
  const setColumnWidths    = useAppStore((s) => s.setColumnWidths);

  const widths =
    storedWidths && storedWidths.length === 2
      ? storedWidths
      : DEFAULT_COLUMN_WIDTHS;
  const lastWidth = widths[0];
  const changeWidth = widths[1];

  const onResizeDivider1 = (e: React.MouseEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const current = useAppStore.getState().columnWidths["watchlist"] ?? DEFAULT_COLUMN_WIDTHS;
    const startLast = current[0] ?? DEFAULT_COLUMN_WIDTHS[0];
    const curChange = current[1] ?? DEFAULT_COLUMN_WIDTHS[1];
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const nextLast = Math.max(MIN_LAST_WIDTH, Math.min(220, Math.round(startLast - dx)));
      setColumnWidths("watchlist", [nextLast, curChange]);
    };

    const onUp = () => {
      document.body.style.userSelect = prevSelect;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onResizeDivider2 = (e: React.MouseEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const current = useAppStore.getState().columnWidths["watchlist"] ?? DEFAULT_COLUMN_WIDTHS;
    const startLast = current[0] ?? DEFAULT_COLUMN_WIDTHS[0];
    const startChange = current[1] ?? DEFAULT_COLUMN_WIDTHS[1];
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      let nextLast = startLast + dx;
      let nextChange = startChange - dx;

      if (nextLast < MIN_LAST_WIDTH) {
        nextLast = MIN_LAST_WIDTH;
        nextChange = startLast + startChange - MIN_LAST_WIDTH;
      }
      if (nextChange < MIN_CHANGE_WIDTH) {
        nextChange = MIN_CHANGE_WIDTH;
        nextLast = startLast + startChange - MIN_CHANGE_WIDTH;
      }

      setColumnWidths("watchlist", [Math.round(nextLast), Math.round(nextChange)]);
    };

    const onUp = () => {
      document.body.style.userSelect = prevSelect;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onResetWidths = (e: React.MouseEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setColumnWidths("watchlist", DEFAULT_COLUMN_WIDTHS);
  };

  const boxRef  = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const quotes  = useScreenerQuotes();

  const [dragSymbol,   setDragSymbol]   = useState<string | null>(null);
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);

  const dragSymbolRef = useRef<string | null>(null);
  const previewRef    = useRef<string[] | null>(null);

  const displayOrder = previewOrder ?? watchlist;


  const [indicator, setIndicator] = useState<{
    top: number;
    height: number;
    ready: boolean;
  }>({
    top: 0,
    height: 36,
    ready: false,
  });

  useLayoutEffect(() => {
    const listEl = listRef.current;
    if (!listEl) return;

    const selectedEl = listEl.querySelector<HTMLElement>('[data-selected="true"]');
    if (!selectedEl) {
      setIndicator((prev) => (prev.ready ? { ...prev, ready: false } : prev));
      return;
    }

    const top = selectedEl.offsetTop;
    const height = selectedEl.clientHeight || 36;

    setIndicator((prev) => {
      if (prev.ready && prev.top === top && prev.height === height) {
        return prev;
      }
      return {
        top,
        height,
        ready: true,
      };
    });
  }, [activeKey, displayOrder]);

  useEffect(() => {
    const listEl = listRef.current;
    if (!listEl) return;

    const handleResize = () => {
      const selectedEl = listEl.querySelector<HTMLElement>('[data-selected="true"]');
      if (selectedEl) {
        setIndicator({
          top: selectedEl.offsetTop,
          height: selectedEl.clientHeight || 36,
          ready: true,
        });
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // ─── drag-to-reorder ────────────────────────────────────────────────────

  const moveDragToClientY = (clientY: number) => {
    const sym  = dragSymbolRef.current;
    const list = previewRef.current;
    const root = listRef.current;
    if (!sym || !list || !root) return;
    const cards = [...root.querySelectorAll<HTMLElement>("[data-screener-card]")];
    if (!cards.length) return;

    let target = list.length - 1;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) { target = i; break; }
      target = i;
    }

    const from = list.indexOf(sym);
    if (from < 0 || from === target) return;
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(target, 0, item);
    previewRef.current = next;
    setPreviewOrder(next);
  };

  const endDrag = (commit: boolean) => {
    if (commit && previewRef.current) setWatchlistOrder(previewRef.current);
    dragSymbolRef.current = null;
    previewRef.current    = null;
    setDragSymbol(null);
    setPreviewOrder(null);
  };

  const onPointerDragStart = (symbol: string, clientY: number, pointerId: number) => {
    const origin = [...displayOrder];
    dragSymbolRef.current = symbol;
    previewRef.current    = origin;
    setDragSymbol(symbol);
    setPreviewOrder(origin);

    const onMove = (ev: PointerEvent) => { if (ev.pointerId === pointerId) moveDragToClientY(ev.clientY); };
    const onUp   = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup",   onUp);
      window.removeEventListener("pointercancel", onUp);
      endDrag(true);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup",   onUp);
    window.addEventListener("pointercancel", onUp);
    moveDragToClientY(clientY);
  };

  // ─── render ─────────────────────────────────────────────────────────────

  return (
    <div
      ref={boxRef}
      className="flex h-full min-h-0 flex-col"
      style={{ background: "var(--app-panel)" }}
    >
      {/* ── title bar ── */}
      <TitleBar />

      {/* ── scrollable symbol list ── */}
      <div
        className="relative min-h-0 flex-1 overflow-hidden"
      >
        <div className="flex h-full flex-col overflow-auto">
          <ColumnHeader
            lastWidth={lastWidth}
            changeWidth={changeWidth}
            onResizeDivider1={onResizeDivider1}
            onResizeDivider2={onResizeDivider2}
            onResetWidths={onResetWidths}
          />

          {watchlist.length === 0 ? (
            <div className="px-4 py-6 text-[12px]" style={{ color: "var(--app-muted)" }}>
              No symbols in watchlist.
            </div>
          ) : (
            <div ref={listRef} className="relative">
              <div
                className={`wl-selected-indicator ${!indicator.ready || dragSymbol != null ? "no-transition" : ""}`}
                style={{
                  transform: `translate3d(0, ${indicator.top}px, 0)`,
                  height: `${indicator.height}px`,
                  opacity: indicator.ready ? 1 : 0,
                  transition:
                    indicator.ready && dragSymbol == null
                      ? "transform 0.18s cubic-bezier(0.2, 0.8, 0.25, 1), height 0.18s cubic-bezier(0.2, 0.8, 0.25, 1), opacity 0.12s ease"
                      : "none",
                }}
                aria-hidden="true"
              />
              {displayOrder.map((sym) => {
                const q = quotes.get(bareSymbol(sym));
                const quoteReady = q != null;

                if (!quoteReady) {
                  return (
                    <PendingRow
                      key={sym}
                      symbol={sym}
                      selected={activeKey === bareSymbol(sym)}
                      quote={q}
                      lastWidth={lastWidth}
                      changeWidth={changeWidth}
                      onOpen={setSymbol}
                    />
                  );
                }

                return (
                  <WatchlistRow
                    key={sym}
                    symbol={sym}
                    selected={activeKey === bareSymbol(sym)}
                    dragging={dragSymbol === sym}
                    last={q.last}
                    changePct={q.changePct}
                    lastWidth={lastWidth}
                    changeWidth={changeWidth}
                    onOpen={setSymbol}
                    onPointerDragStart={onPointerDragStart}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>


    </div>
  );
}
