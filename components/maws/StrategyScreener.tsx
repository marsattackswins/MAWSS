"use client";

import { AssetLogo } from "@/components/brand/AssetLogo";
import { formatPrice } from "@/lib/maws/feed";
import { mawsFeed } from "@/lib/maws/feed";
import { formatTicker } from "@/lib/maws/universe";
import { StrategySymbolPanel } from "@/components/maws/StrategySymbolPanel";
import {
  analyzeSymbol,
  HTF_TIMEFRAME,
  type ConditionId,
  type CondStatus,
  type StrategyRow,
} from "@/lib/strategy-screener";
import { useAppStore } from "@/lib/store";
import type { Candle, Quote } from "@/types";
import { memo, useEffect, useMemo, useRef, useState } from "react";

// ─── signal-dot helpers ────────────────────────────────────────────────────

const STATUS_DOT: Record<CondStatus, string> = {
  pass: "#089981",
  wait: "#787b86",
  block: "#f23645",
  info: "#4c525e",
};

function signalDotColor(row: StrategyRow): string {
  const fast = row.conditions.find((c) => c.id === "stochFast")?.value;
  const mid  = row.conditions.find((c) => c.id === "stochMid")?.value;
  const slow = row.conditions.find((c) => c.id === "stochSlow")?.value;
  const adx  = row.conditions.find((c) => c.id === "adx")?.value;
  const nums = [fast, mid, slow];
  const allNum = nums.every((v): v is number => typeof v === "number");
  const adxOk  = typeof adx === "number" && adx <= 40;
  if (allNum && adxOk) {
    if (nums.every((d) => d <= 20)) return "#089981";
    if (nums.every((d) => d >= 80)) return "#f23645";
  }
  if (typeof fast === "number" && typeof mid === "number") {
    if ((fast <= 20 && mid <= 20) || (fast >= 80 && mid >= 80)) return "#f0b90b";
  }
  return "#787b86";
}

function signalDotTitle(row: StrategyRow): string {
  const fast = row.conditions.find((c) => c.id === "stochFast")?.value;
  const mid  = row.conditions.find((c) => c.id === "stochMid")?.value;
  const slow = row.conditions.find((c) => c.id === "stochSlow")?.value;
  const adx  = row.conditions.find((c) => c.id === "adx")?.value;
  const nums = [fast, mid, slow];
  const allNum = nums.every((v): v is number => typeof v === "number");
  const adxOk  = typeof adx === "number" && adx <= 40;
  if (allNum && adxOk) {
    if (nums.every((d) => d <= 20)) return "Long — all stochs aligned, ADX ≤ 40";
    if (nums.every((d) => d >= 80)) return "Short — all stochs aligned, ADX ≤ 40";
  }
  if (typeof fast === "number" && typeof mid === "number") {
    if ((fast <= 20 && mid <= 20) || (fast >= 80 && mid >= 80))
      return "Stoch 14.3 + 40.4 aligned — waiting";
  }
  return "Waiting for Stoch 14.3 + 40.4";
}

const COND_LABEL: Record<ConditionId, string> = {
  htfBias:   "HTF bias",
  vwap:      "VWAP",
  stochFast: "Stoch 14.3",
  stochMid:  "Stoch 40.4",
  stochSlow: "Stoch 60.10",
  adx:       "ADX 14",
};
const COND_ORDER: ConditionId[] = [
  "htfBias", "stochFast", "vwap", "stochMid", "adx", "stochSlow",
];

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
        ? { text: formatted, from, color: value > prevNum ? "#089981" : "#f23645" }
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

// ─── strategy rows hook ────────────────────────────────────────────────────

function useStrategyRows(symbols: string[]): StrategyRow[] {
  const [rows, setRows] = useState<Map<string, StrategyRow>>(new Map());
  const symbolsKey = useMemo(() => [...symbols].sort().join("\u0000"), [symbols]);

  useEffect(() => {
    let cancelled = false;
    const m1     = new Map<string, Candle[]>();
    const mh     = new Map<string, Candle[]>();
    const unsubs: Array<() => void> = [];
    const wanted = new Set(symbols);
    let analyzeTimer:   number | null = null;
    let confirmedTimer: number | null = null;

    setRows((prev) => {
      const next = new Map<string, StrategyRow>();
      for (const s of symbols) { const r = prev.get(s); if (r) next.set(s, r); }
      return next;
    });

    const snap = () => {
      for (const symbol of symbols) {
        try { m1.set(symbol, mawsFeed.getCandles(symbol, "1m")); }    catch { /* ignore */ }
        try { mh.set(symbol, mawsFeed.getCandles(symbol, HTF_TIMEFRAME)); } catch { /* ignore */ }
      }
    };

    const analyze = (confirmed: boolean) => {
      if (cancelled) return;
      snap();
      setRows((prev) => {
        const next = new Map<string, StrategyRow>();
        let changed = false;
        for (const symbol of symbols) {
          if (!wanted.has(symbol)) continue;
          const row = analyzeSymbol(symbol, m1.get(symbol) ?? [], mh.get(symbol) ?? [], Date.now(), { confirmed });
          if (!row) { if (prev.has(symbol)) changed = true; continue; }
          if (!confirmed) {
            const p = prev.get(symbol);
            if (p) { row.confirmedState = p.confirmedState; row.confirmedMet = p.confirmedMet; }
          }
          const p = prev.get(symbol);
          if (!p || p.state !== row.state || p.met !== row.met || p.direction !== row.direction ||
              p.confirmedState !== row.confirmedState || p.bullishMet !== row.bullishMet ||
              p.bearishMet !== row.bearishMet || p.price !== row.price ||
              p.conditions.length !== row.conditions.length ||
              p.conditions.some((c, i) =>
                c.status !== row.conditions[i]?.status ||
                c.value  !== row.conditions[i]?.value  ||
                c.detail !== row.conditions[i]?.detail))
            changed = true;
          next.set(symbol, row);
        }
        if (!changed && next.size === prev.size) {
          for (const s of prev.keys()) { if (!next.has(s)) { changed = true; break; } }
        }
        return changed ? next : prev;
      });
    };

    snap();
    for (const symbol of symbols)
      unsubs.push(mawsFeed.subscribe(symbol, "1m", (c) => { m1.set(symbol, c); }));
    analyze(true);
    analyzeTimer   = window.setInterval(() => analyze(false),  2_000);
    confirmedTimer = window.setInterval(() => analyze(true),  15_000);

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
      if (analyzeTimer   != null) window.clearInterval(analyzeTimer);
      if (confirmedTimer != null) window.clearInterval(confirmedTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolsKey]);

  return useMemo(() => [...rows.values()], [rows]);
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

function IconChevronDown({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function IconChevronRight({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M3.5 2 6.5 5 3.5 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// ─── title bar ─────────────────────────────────────────────────────────────

function TitleBar() {
  const setSearchOpen = useAppStore((s) => s.setSearchOpen);
  const setRightOpen  = useAppStore((s) => s.setRightOpen);

  return (
    <div
      className="flex h-[42px] shrink-0 items-center border-b px-3"
      style={{ borderColor: "var(--app-border)" }}
    >
      <span className="flex-1 text-[13px] font-semibold" style={{ color: "var(--app-text)" }}>
        Watchlist
      </span>

      {/* + opens the symbol search so the user can find and add a symbol */}
      <button type="button" title="Add symbol" onClick={() => setSearchOpen(true)} className="wl-icon-btn">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>

      {/* ✕ closes the sidebar panel */}
      <button type="button" title="Close" onClick={() => setRightOpen(false)} className="wl-icon-btn">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>
    </div>
  );
}

// ─── column header ─────────────────────────────────────────────────────────

function ColumnHeader() {
  return (
    <div
      className="flex h-[28px] shrink-0 items-center border-b px-3 text-[10px] font-medium uppercase tracking-[0.05em]"
      style={{ color: "var(--app-muted)", borderColor: "var(--app-border)" }}
    >
      <span className="flex-1">Symbol / name</span>
      <span className="w-[80px] text-right">Last</span>
      <span className="w-[56px] text-right">Day %</span>
    </div>
  );
}

// ─── group header ──────────────────────────────────────────────────────────

function GroupHeader({
  name,
  count,
  collapsed,
  onToggle,
}: {
  name: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="wl-group-header flex h-[28px] w-full items-center gap-1.5 px-3"
    >
      <span style={{ color: "var(--app-muted)" }}>
        {collapsed ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
      </span>
      <span
        className="flex-1 truncate text-left text-[11px] font-semibold uppercase tracking-[0.05em]"
        style={{ color: "var(--app-muted)" }}
      >
        {name}
      </span>
      <span
        className="text-[11px] tabular-nums"
        style={{ color: "var(--app-muted)" }}
      >
        {count}
      </span>
    </button>
  );
}

// ─── expanded condition panel ──────────────────────────────────────────────

function ConditionPanel({ row }: { row: StrategyRow }) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1 py-1.5 pb-2.5 pl-[52px] pr-3">
      {COND_ORDER.map((id) => {
        const c = row.conditions.find((x) => x.id === id);
        if (!c) return null;
        const isStoch = id === "stochFast" || id === "stochMid" || id === "stochSlow";
        const color =
          c.id === "htfBias"
            ? c.value === 1 ? "#089981" : c.value === -1 ? "#f23645" : "#787b86"
            : c.id === "vwap"
              ? "#089981"
              : isStoch && typeof c.value === "number"
                ? c.value <= 20 ? "#089981" : c.value >= 80 ? "#f23645" : "#787b86"
                : STATUS_DOT[c.status];
        const label =
          id === "adx"
            ? c.value == null ? "ADX —" : `ADX ${Number(c.value).toFixed(1)}`
            : isStoch
              ? c.value == null
                ? `${COND_LABEL[id]} —`
                : `${COND_LABEL[id]} ${Number(c.value).toFixed(1)}`
              : c.detail;
        return (
          <div key={c.id} className="flex min-w-0 items-center gap-1 py-0.5">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
            <span className="truncate text-[11px]" style={{ color: "var(--app-text)" }}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── symbol row ────────────────────────────────────────────────────────────

const WatchlistRow = memo(function WatchlistRow({
  row,
  selected,
  expanded,
  dragging,
  last,
  changePct,
  onOpen,
  onToggleExpand,
  onPointerDragStart,
}: {
  row: StrategyRow;
  selected: boolean;
  expanded: boolean;
  dragging: boolean;
  last: number | null;
  changePct: number | null;
  onOpen: (symbol: string) => void;
  onToggleExpand: (symbol: string) => void;
  onPointerDragStart: (symbol: string, clientY: number, pointerId: number) => void;
}) {
  const price = last ?? row.price;
  const suppressClick = useRef(false);
  const startRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const dotColor = signalDotColor(row);
  const chgColor =
    changePct == null || changePct === 0
      ? "var(--app-muted)"
      : changePct > 0 ? "#089981" : "#f23645";

  return (
    <div
      data-screener-card={row.symbol}
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
          if ((e.target as HTMLElement).closest("[data-expand-dot]")) return;
          startRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
        }}
        onPointerMove={(e) => {
          const s = startRef.current;
          if (!s || s.pointerId !== e.pointerId) return;
          if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < 8) return;
          startRef.current = null;
          suppressClick.current = true;
          onPointerDragStart(row.symbol, e.clientY, e.pointerId);
        }}
        onPointerUp={() => { startRef.current = null; }}
        onPointerCancel={() => { startRef.current = null; }}
        onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          onOpen(row.symbol);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(row.symbol); }
        }}
        className={`flex h-[36px] w-full items-center gap-0 select-none px-3 ${dragging ? "cursor-grabbing" : "cursor-default"}`}
      >
        {/* signal dot / expand button */}
        <button
          type="button"
          data-expand-dot
          title={signalDotTitle(row)}
          aria-label={signalDotTitle(row)}
          aria-expanded={expanded}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleExpand(row.symbol); }}
          onPointerDown={(e) => e.stopPropagation()}
          className="wl-icon-btn mr-2 h-5 w-5 shrink-0 cursor-default"
        >
          <span
            className="block h-[8px] w-[8px] rounded-full transition-colors duration-200"
            style={{ background: dotColor }}
          />
        </button>

        {/* logo */}
        <AssetLogo symbol={row.symbol} size={20} className="mr-2.5 shrink-0" />

        {/* ticker — two-line: bold name + muted sub */}
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <span
            className="truncate text-[12px] font-bold leading-[15px]"
            style={{ color: "var(--app-text)" }}
          >
            {formatTicker(row.symbol)}
          </span>
          <span
            className="truncate text-[11px] leading-[14px]"
            style={{ color: "var(--app-muted)" }}
          >
            {formatTicker(row.symbol)}
          </span>
        </div>

        {/* last price */}
        <div className="w-[80px] shrink-0 text-right">
          {price == null ? (
            <span className="text-[12px] tabular-nums" style={{ color: "var(--app-muted)" }}>—</span>
          ) : (
            <DigitFlashPrice symbol={row.symbol} value={price} />
          )}
        </div>

        {/* day % */}
        <div className="w-[56px] shrink-0 text-right">
          <span className="text-[12px] font-semibold tabular-nums" style={{ color: chgColor }}>
            {changePct == null
              ? "—"
              : `${changePct > 0 ? "+" : ""}${changePct.toFixed(2)}%`}
          </span>
        </div>
      </div>

      {/* accordion — conditions */}
      <div
        className={[
          "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        ].join(" ")}
      >
        <div className="min-h-0 overflow-hidden">
          <ConditionPanel row={row} />
        </div>
      </div>
    </div>
  );
});

// ─── loading row (symbol exists in watchlist but strategy row not ready yet) ─

function PendingRow({
  symbol,
  selected,
  quote,
  onOpen,
}: {
  symbol: string;
  selected: boolean;
  quote: Quote | undefined;
  onOpen: (sym: string) => void;
}) {
  const chgColor =
    !quote || quote.changePct === 0
      ? "var(--app-muted)"
      : quote.changePct > 0 ? "#089981" : "#f23645";

  return (
    <div
      data-screener-card={symbol}
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
      {/* placeholder dot */}
      <span className="mr-2 flex h-5 w-5 shrink-0 items-center justify-center">
        <span className="block h-[8px] w-[8px] rounded-full" style={{ background: "var(--app-muted)" }} />
      </span>

      <AssetLogo symbol={symbol} size={20} className="mr-2.5 shrink-0" />

      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <span className="truncate text-[12px] font-bold leading-[15px]" style={{ color: "var(--app-text)" }}>
          {formatTicker(symbol)}
        </span>
        <span className="truncate text-[11px] leading-[14px]" style={{ color: "var(--app-muted)" }}>
          {formatTicker(symbol)}
        </span>
      </div>

      <div className="w-[80px] shrink-0 text-right">
        {quote ? (
          <DigitFlashPrice symbol={symbol} value={quote.last} />
        ) : (
          <span className="text-[12px] tabular-nums" style={{ color: "var(--app-muted)" }}>—</span>
        )}
      </div>
      <div className="w-[56px] shrink-0 text-right">
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
  const watchlistGroups    = useAppStore((s) => s.watchlistGroups);
  const toggleWatchlistGroup = useAppStore((s) => s.toggleWatchlistGroup);
  const setWatchlistOrder  = useAppStore((s) => s.setWatchlistOrder);
  const setSymbol          = useAppStore((s) => s.setSymbol);
  const active             = useAppStore((s) => s.panes.find((p) => p.id === s.activePaneId)?.symbol);
  const cardsHeight        = useAppStore((s) => s.strategyCardsHeight);
  const setCardsHeight     = useAppStore((s) => s.setStrategyCardsHeight);

  const boxRef  = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const quotes  = useScreenerQuotes();

  const [dragSymbol,   setDragSymbol]   = useState<string | null>(null);
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);
  const [expanded,     setExpanded]     = useState<Set<string>>(() => new Set());

  const dragSymbolRef = useRef<string | null>(null);
  const previewRef    = useRef<string[] | null>(null);

  const toggleExpand = (symbol: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(symbol) ? next.delete(symbol) : next.add(symbol);
      return next;
    });

  const rows = useStrategyRows(watchlist);

  const displayOrder = previewOrder ?? watchlist;

  const orderedRows = useMemo(() => {
    const bySym = new Map(rows.map((r) => [r.symbol, r]));
    const out: StrategyRow[] = [];
    const seen = new Set<string>();
    for (const s of displayOrder) {
      const r = bySym.get(s);
      if (!r || seen.has(s)) continue;
      out.push(r);
      seen.add(s);
    }
    for (const r of rows) {
      if (seen.has(r.symbol)) continue;
      out.push(r);
      seen.add(r.symbol);
    }
    return out;
  }, [rows, displayOrder]);

  const rowsBySym = useMemo(
    () => new Map(orderedRows.map((r) => [r.symbol, r])),
    [orderedRows],
  );

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
    const origin = orderedRows.map((r) => r.symbol);
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
        className="relative min-h-0 shrink-0 overflow-hidden"
        style={{
          height:    active ? cardsHeight : "100%",
          maxHeight: active ? "calc(100% - 120px)" : "100%",
        }}
      >
        <div className="flex h-full flex-col overflow-auto">
          <ColumnHeader />

          {watchlist.length === 0 ? (
            <div className="px-4 py-6 text-[12px]" style={{ color: "var(--app-muted)" }}>
              No symbols in watchlist.
            </div>
          ) : (
            <div ref={listRef}>
              {watchlistGroups.map((group) => {
                if (group.symbols.length === 0) return null;

                // Respect drag preview ordering within each group
                const groupSymbols = (previewOrder
                  ? previewOrder.filter((s) => group.symbols.includes(s))
                  : group.symbols);

                return (
                  <div key={group.id}>
                    <GroupHeader
                      name={group.name}
                      count={group.symbols.length}
                      collapsed={group.collapsed}
                      onToggle={() => toggleWatchlistGroup(group.id)}
                    />

                    {!group.collapsed && groupSymbols.map((sym) => {
                      const row = rowsBySym.get(sym);
                      const q   = quotes.get(bareSymbol(sym));

                      if (!row) {
                        return (
                          <PendingRow
                            key={sym}
                            symbol={sym}
                            selected={active === sym}
                            quote={q}
                            onOpen={setSymbol}
                          />
                        );
                      }

                      return (
                        <WatchlistRow
                          key={sym}
                          row={row}
                          selected={active === sym}
                          expanded={expanded.has(sym)}
                          dragging={dragSymbol === sym}
                          last={q?.last ?? null}
                          changePct={q?.changePct ?? null}
                          onOpen={setSymbol}
                          onToggleExpand={toggleExpand}
                          onPointerDragStart={onPointerDragStart}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* resize handle between list and symbol panel */}
        {active && (
          <div
            className="absolute bottom-0 left-0 z-20 h-1.5 w-full cursor-row-resize bg-transparent hover:bg-[#2962ff]"
            title="Drag to resize"
            onMouseDown={(e) => {
              e.preventDefault();
              const box = boxRef.current?.getBoundingClientRect();
              const move = (ev: MouseEvent) => {
                const top = box?.top ?? 0;
                const max = (box?.height ?? 600) - 120;
                setCardsHeight(Math.min(max, Math.max(96, ev.clientY - top)));
              };
              const up = () => {
                window.removeEventListener("mousemove", move);
                window.removeEventListener("mouseup",   up);
              };
              window.addEventListener("mousemove", move);
              window.addEventListener("mouseup",   up);
            }}
          />
        )}
      </div>

      {/* ── active-symbol detail panel ── */}
      {active && (
        <StrategySymbolPanel
          symbol={active}
          row={orderedRows.find((r) => r.symbol === active) ?? null}
        />
      )}
    </div>
  );
}
