"use client";

import { formatSignedUsd } from "@/lib/trading/format";
import { useAppStore } from "@/lib/store";
import { Maximize2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

// ── Journal preview ─────────────────────────────────────────────────────────
// A docked glance at the vendored Trade Journal: headline metrics, today's
// realized P&L and the latest trades, read from the journal's same-origin API
// (/journal/api/trades). The expand action opens the full journal overlay;
// closing the overlay refreshes the preview so edits made there land here.

type PreviewTrade = {
  key: string;
  symbol: string;
  direction: "long" | "short";
  status: "open" | "win" | "loss" | "breakeven";
  openedAt: string;
  closedAt: string | null;
  netPnl: number;
};

type PreviewMetrics = {
  totalTrades: number;
  closedTrades: number;
  openTrades: number;
  netPnl: number;
  winRate: number | null;
  profitFactor: number | null;
  profitFactorIsInfinite: boolean;
};

type PreviewData = { trades: PreviewTrade[]; metrics: PreviewMetrics; todayPnl: number; todayCount: number };

type LoadState = "loading" | "ready" | "error" | "empty";

const RECENT_COUNT = 6;

function dayKey(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    typeof iso === "string" ? new Date(iso) : iso,
  );
}

function parsePreview(json: unknown): PreviewData | null {
  if (typeof json !== "object" || json == null) return null;
  const data = json as { trades?: unknown; metrics?: Partial<PreviewMetrics>; timeZone?: string };
  if (!Array.isArray(data.trades) || typeof data.metrics !== "object" || data.metrics == null) return null;
  const trades: PreviewTrade[] = [];
  for (const raw of data.trades) {
    if (typeof raw !== "object" || raw == null) continue;
    const t = raw as Partial<PreviewTrade>;
    if (typeof t.key !== "string" || typeof t.symbol !== "string" || typeof t.openedAt !== "string") continue;
    if (t.direction !== "long" && t.direction !== "short") continue;
    if (t.status !== "open" && t.status !== "win" && t.status !== "loss" && t.status !== "breakeven") continue;
    trades.push({
      key: t.key,
      symbol: t.symbol,
      direction: t.direction,
      status: t.status,
      openedAt: t.openedAt,
      closedAt: typeof t.closedAt === "string" ? t.closedAt : null,
      netPnl: typeof t.netPnl === "number" && Number.isFinite(t.netPnl) ? t.netPnl : 0,
    });
  }
  const m = data.metrics;
  const metrics: PreviewMetrics = {
    totalTrades: m.totalTrades ?? trades.length,
    closedTrades: m.closedTrades ?? 0,
    openTrades: m.openTrades ?? 0,
    netPnl: typeof m.netPnl === "number" ? m.netPnl : 0,
    winRate: typeof m.winRate === "number" ? m.winRate : null,
    profitFactor: typeof m.profitFactor === "number" ? m.profitFactor : null,
    profitFactorIsInfinite: m.profitFactorIsInfinite === true,
  };
  const tz = typeof data.timeZone === "string" ? data.timeZone : undefined;
  const today = dayKey(new Date(), tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const closedToday = trades.filter((t) => t.closedAt != null && dayKey(t.closedAt, tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone) === today);
  trades.sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  return {
    trades: trades.slice(0, RECENT_COUNT),
    metrics,
    todayPnl: closedToday.reduce((sum, t) => sum + t.netPnl, 0),
    todayCount: closedToday.length,
  };
}

const iconButton = "flex h-6 w-6 items-center justify-center rounded hover:bg-(--app-hover)";

function pnlColor(value: number): string {
  return value > 0 ? "var(--app-up)" : value < 0 ? "var(--app-down)" : "var(--app-muted)";
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-[0.05em]" style={{ color: "var(--app-meta)" }}>
        {label}
      </span>
      <span className="truncate text-[13px] font-semibold tabular-nums" style={{ color: color ?? "var(--app-text)" }}>
        {value}
      </span>
    </div>
  );
}

function TradeRow({ trade, onOpen }: { trade: PreviewTrade; onOpen: () => void }) {
  const dirColor = trade.direction === "long" ? "var(--app-up)" : "var(--app-down)";
  const open = trade.status === "open";
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Open in the full journal"
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-(--app-hover)"
    >
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold"
        style={{ color: dirColor, background: `color-mix(in srgb, ${dirColor} 14%, transparent)` }}
      >
        {trade.direction === "long" ? "L" : "S"}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] font-semibold" style={{ color: "var(--app-text)" }}>
        {trade.symbol}
      </span>
      {open ? (
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.05em]" style={{ color: "var(--app-accent)" }}>
          Open
        </span>
      ) : (
        <span className="shrink-0 text-[12px] font-semibold tabular-nums" style={{ color: pnlColor(trade.netPnl) }}>
          {formatSignedUsd(trade.netPnl)}
        </span>
      )}
      <span className="w-11 shrink-0 text-right text-[10px] tabular-nums" style={{ color: "var(--app-meta)" }}>
        {new Date(trade.openedAt).toLocaleDateString([], { month: "short", day: "numeric" })}
      </span>
    </button>
  );
}

export function JournalPreviewPanel() {
  const setJournalOverlayOpen = useAppStore((s) => s.setJournalOverlayOpen);
  const overlayOpen = useAppStore((s) => s.journalOverlayOpen);
  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setRefreshing(true);
    try {
      const res = await fetch("/journal/api/trades?view=list", { signal: ac.signal });
      if (res.status === 401) {
        setError("The journal is password-protected. Open it once to sign in.");
        setState("error");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parsePreview(await res.json());
      if (!parsed) throw new Error("Unexpected journal response");
      setData(parsed);
      setError(null);
      setState(parsed.metrics.totalTrades === 0 ? "empty" : "ready");
    } catch (err) {
      if (ac.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Journal unavailable");
      setState((prev) => (prev === "ready" ? prev : "error"));
    } finally {
      if (!ac.signal.aborted) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  // Trades edited in the full suite should be here when it closes.
  const hadOverlayRef = useRef(false);
  useEffect(() => {
    if (overlayOpen) hadOverlayRef.current = true;
    else if (hadOverlayRef.current) {
      hadOverlayRef.current = false;
      void load();
    }
  }, [overlayOpen, load]);

  const openFull = useCallback(() => setJournalOverlayOpen(true), [setJournalOverlayOpen]);

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ color: "var(--app-text)" }}>
      <div
        className="flex h-8 shrink-0 items-center gap-1 border-b px-2 text-[13px] font-semibold"
        style={{ borderColor: "var(--app-border)" }}
      >
        <span className="flex-1">Journal</span>
        <button
          type="button"
          className={iconButton}
          title="Refresh preview"
          aria-label="Refresh journal preview"
          onClick={() => void load()}
          style={{ color: "var(--app-muted)" }}
        >
          <RefreshCw size={13} className={refreshing ? "animate-spin" : undefined} />
        </button>
        <button
          type="button"
          className={iconButton}
          title="Open full journal"
          aria-label="Open full journal"
          onClick={openFull}
          style={{ color: "var(--app-muted)" }}
        >
          <Maximize2 size={13} />
        </button>
      </div>

      {state === "loading" ? (
        <div className="flex flex-col gap-2 px-3 py-3" aria-label="Loading journal preview">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-4 animate-pulse rounded" style={{ background: "var(--app-faint)", width: `${88 - i * 14}%` }} />
          ))}
        </div>
      ) : state === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <span className="text-[12px]" style={{ color: "var(--app-muted)" }}>
            {error ?? "Journal unavailable"}
          </span>
          <span className="text-[11px]" style={{ color: "var(--app-meta)" }}>
            The journal sidecar may not be running.
          </span>
          <div className="mt-1 flex gap-2">
            <button
              type="button"
              onClick={() => void load()}
              className="h-7 rounded border px-2 text-[11px] font-medium hover:bg-(--app-hover)"
              style={{ borderColor: "var(--app-border)", color: "var(--app-text)" }}
            >
              Retry
            </button>
            <button
              type="button"
              onClick={openFull}
              className="h-7 rounded border px-2 text-[11px] font-medium hover:bg-(--app-hover)"
              style={{ borderColor: "var(--app-border)", color: "var(--app-text)" }}
            >
              Open journal
            </button>
          </div>
        </div>
      ) : state === "empty" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <span className="text-[12px] font-medium" style={{ color: "var(--app-text)" }}>
            No trades journaled yet
          </span>
          <span className="text-[11px]" style={{ color: "var(--app-meta)" }}>
            Log your first trade in the full journal.
          </span>
          <button
            type="button"
            onClick={openFull}
            className="mt-1 h-7 rounded border px-2 text-[11px] font-medium hover:bg-(--app-hover)"
            style={{ borderColor: "var(--app-border)", color: "var(--app-text)" }}
          >
            Open journal
          </button>
        </div>
      ) : data ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 border-b px-3 py-2.5" style={{ borderColor: "var(--app-border)" }}>
            <Stat label="Net P&L" value={formatSignedUsd(data.metrics.netPnl)} color={pnlColor(data.metrics.netPnl)} />
            <Stat
              label="Win rate"
              value={data.metrics.winRate != null ? `${(data.metrics.winRate * 100).toFixed(1)}%` : "—"}
            />
            <Stat
              label="Profit factor"
              value={
                data.metrics.profitFactorIsInfinite
                  ? "∞"
                  : data.metrics.profitFactor != null
                    ? data.metrics.profitFactor.toFixed(2)
                    : "—"
              }
            />
            <Stat label="Trades" value={`${data.metrics.closedTrades} closed · ${data.metrics.openTrades} open`} />
          </div>
          <div className="flex items-baseline justify-between border-b px-3 py-2" style={{ borderColor: "var(--app-border)" }}>
            <span className="text-[10px] uppercase tracking-[0.05em]" style={{ color: "var(--app-meta)" }}>
              Today
            </span>
            <span className="text-[12px] font-semibold tabular-nums" style={{ color: pnlColor(data.todayPnl) }}>
              {data.todayCount === 0 ? "No closed trades" : `${formatSignedUsd(data.todayPnl)} · ${data.todayCount} trade${data.todayCount === 1 ? "" : "s"}`}
            </span>
          </div>
          <div className="px-1 py-1">
            <div className="px-2 pt-1 pb-0.5 text-[10px] uppercase tracking-[0.05em]" style={{ color: "var(--app-meta)" }}>
              Recent trades
            </div>
            {data.trades.map((t) => (
              <TradeRow key={t.key} trade={t} onOpen={openFull} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}