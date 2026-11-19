"use client";

import { useEffect as useReactEffect, useState as useReactState } from "react";
import { formatPrice } from "@/lib/maws/feed";
import { formatTicker } from "@/lib/maws/universe";
import { disconnectLiveBroker, profileLabel, profilePhaseLabel } from "@/lib/live/bridge";
import { useLiveStore } from "@/lib/live/store";
import { useBrokerBook } from "@/lib/selectors/broker";
import { useAppStore } from "@/lib/store";
import {
  dispatchCancelOrder,
  dispatchClosePosition,
  dispatchRemoveProtection,
} from "@/lib/trading/dispatch";
import { formatNum, formatSignedNum, formatSignedUsd } from "@/lib/trading/format";
import { PerformancePanel } from "@/components/trading/PerformancePanel";
import { timezoneIana } from "@/lib/timezone";
import { PanelEmpty, PanelWaiting } from "@/components/ui/panel-states";
import { useQuotes } from "@/lib/use-quotes";
import type { BalanceHistoryEntry, OrderHistoryEntry } from "@/types";

/** Re-renders once per second so relative timestamps stay current. */
function useNowTick(enabled: boolean): number {
  const [now, setNow] = useReactState(() => Date.now());
  useReactEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [enabled]);
  return now;
}

/** Live · updated 2s ago / Stale · last update 48s ago */
export function FreshnessBadge({ live }: { live: boolean }) {
  const markPrice = useLiveStore((s) => s.markPrice);
  const now = useNowTick(live && markPrice != null);
  if (!live || !markPrice) return null;
  const { connected, stale, lastEventAt } = markPrice;
  if (!connected && lastEventAt == null) return null;
  const ageS = lastEventAt == null ? null : Math.max(0, Math.round((now - lastEventAt) / 1000));
  const isStale = stale || ageS == null || ageS > 15;
  const label = isStale
    ? `Stale · last update ${ageS == null ? "—" : `${ageS}s`} ago`
    : `Live · updated ${ageS}s ago`;
  return (
    <span className="whitespace-nowrap text-[11px] font-semibold" style={{ color: isStale ? "#f0b90b" : "var(--app-up)" }}>
      {label}
    </span>
  );
}
import { ChevronDown, ChevronsDown, Columns3, Download, LogOut, Maximize2, Plug } from "lucide-react";
import { useEffect, useRef, useState } from "react";

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down" | "muted";
}) {
  const color =
    tone === "up" ? "text-[var(--app-up)]" : tone === "down" ? "text-[var(--app-down)]" : "text-(--app-text)";
  return (
    <span className="flex flex-col justify-center gap-1 whitespace-nowrap border-l border-[var(--maws-border)] px-4 py-1 first:border-l-0">
      <span className="text-[11px] font-semibold uppercase leading-none tracking-[0.08em] text-(--app-muted)">{label}</span>
      <span className={`text-[13px] font-semibold leading-none ${color}`}>{value}</span>
    </span>
  );
}

/** P&L values always carry an explicit sign: +0.00 / -1.23. Zero counts as positive. */
function formatSigned(value: number): string {
  return formatSignedNum(value);
}

/**
 * Unrealized P&L cell: value plus a non-intrusive "stale" marker when the
 * number is still the fill-time ACCOUNT_UPDATE snapshot (markPriceStale).
 * Display only — never recomputes PnL.
 */
export function PnlCell({
  pnl,
  markPriceStale,
  markAgeMs,
}: {
  pnl: number;
  markPriceStale?: boolean;
  protectionStatus?: "PROTECTED" | "UNPROTECTED";
  markAgeMs?: number;
}) {
  const ageS = markAgeMs != null ? Math.max(0, Math.round(markAgeMs / 1000)) : null;
  return (
    <span
      title={markPriceStale && ageS != null ? `PnL from fill snapshot; mark age ${ageS}s` : undefined}
    >
      {formatSignedUsd(pnl)}
      {markPriceStale ? (
        <span
          role="status"
          aria-label={ageS != null ? `Unrealized PnL is a fill-time snapshot, mark age ${ageS} seconds` : "Unrealized PnL is a fill-time snapshot"}
          className="ml-1 align-[2px] text-[11px] font-bold uppercase text-[#f0b90b]"
        >
          stale
        </span>
      ) : null}
    </span>
  );
}

/**
 * Risk bar: how much of the entry→stop distance price has already given up.
 * Display only — it reads the stop the exchange book reports, never recomputes
 * one. Positions without a stop have no bar.
 */
function RiskBar({ entry, last, sl }: { entry: number; last: number; sl: number | null }) {
  if (sl == null) return null;
  const span = Math.abs(entry - sl);
  if (!(span > 0)) return null;
  const progress = Math.max(0, Math.min(1, Math.abs(last - entry) / span));
  const critical = progress >= 0.8;
  const pct = Math.round(progress * 100);
  return (
    <span
      role="img"
      aria-label={`Risk: ${pct}% of the way from entry to stop loss`}
      title={`${pct}% of the way from entry to stop loss`}
      className="mt-1 block h-[3px] w-[64px] overflow-hidden rounded-full bg-(--app-faint)/40"
    >
      <span
        className="block h-full rounded-full"
        style={{
          width: `${Math.max(2, pct)}%`,
          background: critical ? "var(--app-down)" : "var(--app-accent)",
        }}
      />
    </span>
  );
}

function formatStamp(ms: number, timeZone = "UTC") {
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function StatusTone({ status }: { status: string }) {
  const color =
    status === "filled"
      ? "text-[var(--app-up)]"
      : status === "cancelled"
        ? "text-[var(--app-warn)]"
        : status === "rejected"
          ? "text-[var(--app-down)]"
          : "text-(--app-muted)";
  return <span className={`capitalize ${color}`}>{status}</span>;
}

function SymbolChip({ symbol }: { symbol: string }) {
  return (
    <span className="inline-flex items-center rounded-[4px] bg-(--app-hover) px-2 py-1 text-[11px] text-(--app-text)">
      {formatTicker(symbol)}
    </span>
  );
}

function TableTools() {
  return (
    <span className="flex justify-end gap-2 text-(--app-muted)">
      <Download size={13} />
      <Columns3 size={13} />
    </span>
  );
}

type OrderFilter = "all" | "filled" | "cancelled" | "rejected";

export function useTradingMetrics() {
  const connected = useAppStore((s) => s.connectedBroker);
  const leverage = useAppStore((s) => s.chartSettings.defaultLeverage);
  const liveAccount = useLiveStore((s) => s.account);
  // Authoritative lifetime metrics from the server-side exchange income
  // ledger — NOT the capped latest-50-fill list.
  const liveMetrics = useLiveStore((s) => s.accountMetrics);
  const liveFills = useLiveStore((s) => s.fills);
  // Exactly one book (live for binance) — never a mix.
  const { orders, positions } = useBrokerBook();
  const quotes = useQuotes();
  const lastOf = (symbol: string) => quotes.find((q) => q.symbol === symbol)?.last ?? 0;
  const live = connected === "binance";
  const liveAcc = liveAccount ?? {
    balance: 0,
    available: 0,
    equity: 0,
    margin: 0,
    unrealized: 0,
    fetchedAt: null,
    equitySource: "fallback" as const,
  };
  const liveMetricsSafe = liveMetrics ?? { realizedPnl: 0, commission: 0, fundingFee: 0, netRealized: 0, fetchedAt: null };
  const unrealized = live ? liveAcc.unrealized : 0;
  const margin = live ? liveAcc.margin : 0;
  const orderMargin = live ? 0 : 0;
  const equity = live ? liveAcc.equity : 0;
  const accountBalance = live ? liveAcc.balance : 0;
  const available = live ? liveAcc.available : 0;
  const realizedShown = live ? liveMetricsSafe.realizedPnl : 0;
  const buffer = margin + orderMargin <= 0 ? 100 : (equity / (margin + orderMargin)) * 100;
  const pnlTone = (v: number): "up" | "down" | "muted" =>
    v > 0 ? "up" : v < 0 ? "down" : "muted";

  return {
    connected,
    live,
    liveAcc,
    liveMetrics: liveMetricsSafe,
    liveFills,
    orders,
    positions,
    lastOf,
    accountBalance,
    equity,
    realizedShown,
    unrealized,
    margin,
    available,
    orderMargin,
    buffer,
    pnlTone,
  };
}

export function TradingMetrics() {
  const {
    connected,
    live,
    liveMetrics,
    accountBalance,
    equity,
    realizedShown,
    unrealized,
    available,
    buffer,
  } = useTradingMetrics();

  return (
    <div className="ml-auto flex shrink-0 items-stretch">
      <Metric label="Balance" value={formatNum(accountBalance)} />
      <Metric label="Equity" value={formatNum(equity)} />
      {live ? (
        <>
          <Metric
            label="Realized"
            value={formatSigned(liveMetrics.realizedPnl)}
            tone={liveMetrics.realizedPnl >= 0 ? "up" : "down"}
          />
          <Metric label="Commission" value={formatNum(liveMetrics.commission)} />
          <Metric
            label="Funding"
            value={formatSigned(liveMetrics.fundingFee)}
            tone={liveMetrics.fundingFee >= 0 ? "up" : "down"}
          />
          <Metric
            label="Net Realized"
            value={formatSigned(liveMetrics.netRealized)}
            tone={liveMetrics.netRealized >= 0 ? "up" : "down"}
          />
        </>
      ) : (
        <Metric label="Realized" value={formatSigned(realizedShown)} tone={realizedShown >= 0 ? "up" : "down"} />
      )}
      <Metric label="Unrealized" value={formatSigned(unrealized)} tone={unrealized >= 0 ? "up" : "down"} />
      <Metric label="Available" value={formatNum(available)} />
      <Metric label="Buffer" value={`${formatNum(buffer, 0)}%`} />
    </div>
  );
}

export type PosRow = {
  id: string;
  symbol: string;
  side: "long" | "short";
  entry: number;
  qty: number;
  tp: number | null;
  sl: number | null;
  leverage: number;
  last: number;
  pnl: number;
  notional: number;
  margin: number;
  marginType?: string;
  /** PnL-freshness provenance from the live DTO (live branch only). */
  markAgeMs?: number;
  markPriceStale?: boolean;
  protectionStatus?: "PROTECTED" | "UNPROTECTED";
};

export function computePosRows(
  positions: Array<{ id: string; symbol: string; side: "long" | "short"; entry: number; qty: number; leverage: number; tp: number | null; sl: number | null; liq: number | null; mark?: number; unrealized?: number; notional?: number; marginType?: string; isolatedMargin?: number; isolatedWallet?: number; markAgeMs?: number; markPriceStale?: boolean; protectionStatus?: "PROTECTED" | "UNPROTECTED" }>,
  live: boolean,
  lastOf: (symbol: string) => number,
): PosRow[] {
  return live
    ? positions.map((p) => {
        const last = (p.mark && p.mark > 0) ? p.mark : p.entry;
        const pnl = (p.mark && p.mark > 0) ? (p.side === "long" ? (last - p.entry) * p.qty : (p.entry - last) * p.qty) : (p.unrealized ?? 0);
        const notional = p.qty * last;
        const margin = (p.marginType === "isolated" && p.isolatedWallet != null && p.isolatedWallet > 0)
          ? p.isolatedWallet
          : (p.marginType === "isolated" && p.isolatedMargin != null && p.isolatedMargin > 0)
            ? p.isolatedMargin
            : notional / Math.max(1, p.leverage);
        return {
          id: p.id,
          symbol: p.symbol,
          side: p.side,
          entry: p.entry,
          qty: p.qty,
          tp: p.tp,
          sl: p.sl,
          leverage: p.leverage,
          last,
          pnl,
          notional,
          margin,
          marginType: p.marginType,
          markAgeMs: p.markAgeMs,
          markPriceStale: p.markPriceStale === true,
          protectionStatus: p.protectionStatus,
        };
      })
    : positions.map((p) => {
        const streamPrice = lastOf(p.symbol);
        const last = streamPrice > 0 ? streamPrice : p.entry;
        const notional = p.qty * last;
        return {
          id: p.id,
          symbol: p.symbol,
          side: p.side,
          entry: p.entry,
          qty: p.qty,
          tp: p.tp,
          sl: p.sl,
          leverage: p.leverage,
          last,
          pnl: p.side === "long" ? (last - p.entry) * p.qty : (p.entry - last) * p.qty,
          notional,
          margin: notional / Math.max(1, p.leverage),
        };
      });
}

export function PositionsPanel() {
  const tab = useAppStore((s) => s.bottomTab);
  const rowDensity = useAppStore((s) => s.rowDensity);
  const timezone = useAppStore((s) => s.chartSettings.timezone);
  const stampTz = timezoneIana(timezone);
  const setBrokerDialogOpen = useAppStore((s) => s.setBrokerDialogOpen);
  const setBottomOpen = useAppStore((s) => s.setBottomOpen);
  const setBottomHeight = useAppStore((s) => s.setBottomHeight);
  const liveProfileId = useLiveStore((s) => s.profileId);
  const livePhase = useLiveStore((s) => s.phase);
  const liveReady = useLiveStore((s) => s.ready);
  const { connected, live, liveAcc, liveFills, orders, positions, lastOf } = useTradingMetrics();
  const freshness = <FreshnessBadge live={live} />;
  const [brokerMenuOpen, setBrokerMenuOpen] = useState(false);
  const [orderFilter, setOrderFilter] = useState<OrderFilter>("all");
  const brokerMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!brokerMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node)) return;
      if (!brokerMenuRef.current?.contains(e.target)) setBrokerMenuOpen(false);
    };
    const id = window.setTimeout(() => {
      window.addEventListener("mousedown", onDown);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("mousedown", onDown);
    };
  }, [brokerMenuOpen]);

  const mutationBlocked = livePhase === "switching";

  /** No account snapshot yet — ghost rows, never an empty table. */
  const waiting = live && !liveReady && liveAcc.fetchedAt == null;

  const posRows = computePosRows(positions, live, lastOf);

  const ordRows = orders.map((o) => ({
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    type: o.type as string,
    qty: o.qty,
    price: o.price,
  }));

  const histRows: OrderHistoryEntry[] = live
    ? liveFills.map((f) => ({
        id: `${f.ts}-${f.symbol}-${f.side}-${f.qty}-${f.price}`,
        time: f.ts,
        closingTime: f.ts,
        symbol: f.symbol,
        side: f.side,
        type: "market" as const,
        qty: f.qty,
        price: f.price,
        limitPrice: null,
        stopPrice: null,
        fillPrice: f.price,
        status: "filled" as const,
      }))
    : [];

  const filledCount = histRows.filter((o) => o.status === "filled").length;
  const cancelledCount = histRows.filter((o) => o.status === "cancelled").length;
  const rejectedCount = histRows.filter((o) => o.status === "rejected").length;
  const filteredOrders =
    orderFilter === "all"
      ? histRows
      : histRows.filter((o) => o.status === orderFilter);

  // Live fills are the exchange-side record of every execution, including
  // closing ones (non-zero realized P&L).
  const balanceRows: BalanceHistoryEntry[] = live
    ? liveFills.map((f) => ({
        id: `fill-${f.ts}-${f.symbol}-${f.side}-${f.qty}-${f.price}`,
        time: f.ts,
        type: "realized_pnl" as const,
        amount: f.realizedPnl,
        balanceAfter: liveAcc.balance,
        note: `${f.realizedPnl !== 0 ? "Close" : "Open"} fill for symbol ${f.symbol} at price ${f.price} for ${f.qty} units${f.realizedPnl !== 0 ? `. Realized P&L ${f.realizedPnl >= 0 ? "+" : ""}${f.realizedPnl.toFixed(2)} USD` : ""}.`,
        symbol: f.symbol,
      }))
    : [];

  const journalRows = live
    ? liveFills
        .filter((f) => f.realizedPnl !== 0)
        .map((f) => ({
          id: `live-journal-${f.ts}-${f.symbol}-${f.side}-${f.qty}-${f.price}`,
          time: f.ts,
          text: `Close position for symbol ${f.symbol} at price ${f.price} for ${f.qty} units. Realized P&L ${f.realizedPnl >= 0 ? "+" : ""}${f.realizedPnl.toFixed(2)} USD.`,
        }))
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--maws-panel)]">
      <div className="relative z-20 flex h-[28px] shrink-0 items-center gap-3 px-2">
        <div className="relative shrink-0" ref={brokerMenuRef}>
          <button
            type="button"
            className="flex items-center gap-1 text-[13px] font-semibold text-(--app-text) hover:text-white"
            onClick={() => setBrokerMenuOpen((v) => !v)}
          >
            {connected === "binance"
              ? liveProfileId
                ? profileLabel(liveProfileId)
                : "Binance Futures"
              : "Trade with your broker"}
            <ChevronDown size={14} className="text-(--app-muted)" />
            {freshness}
            {live && !liveReady ? <span className="ml-1 text-[11px] font-normal text-[#f0b90b]">{profilePhaseLabel(livePhase)}</span> : null}
          </button>
          {brokerMenuOpen && (
            <div
              className="absolute top-full left-0 z-50 mt-1 w-[210px] rounded-[8px] border border-(--app-border) bg-(--app-menu) py-1 shadow-[var(--app-shadow-menu)]"
              role="menu"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="menu-row w-full"
                onClick={() => {
                  setBrokerMenuOpen(false);
                  setBrokerDialogOpen(true);
                }}
              >
                <Plug size={14} className="shrink-0 text-(--app-muted)" />
                Connect to a broker
              </button>
              <button
                type="button"
                className="menu-row w-full"
                onClick={() => {
                  setBrokerMenuOpen(false);
                  if (connected === "binance") {
                    void disconnectLiveBroker();
                  }
                  setBottomOpen(false);
                }}
              >
                <LogOut size={14} className="shrink-0 text-(--app-muted)" />
                Log out
              </button>
            </div>
          )}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-[4px] text-(--app-muted) hover:bg-(--app-hover) hover:text-(--app-text)"
            title="Collapse"
            onClick={() => setBottomOpen(false)}
          >
            <ChevronsDown size={14} />
          </button>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-[4px] text-(--app-muted) hover:bg-(--app-hover) hover:text-(--app-text)"
            title="Expand to half screen"
            onClick={(event) => {
              const section = event.currentTarget.closest<HTMLElement>("section");
              const parentHeight = section?.parentElement?.clientHeight || window.innerHeight;
              const next = section?.nextElementSibling;
              const replayHeight = next instanceof HTMLElement ? next.offsetHeight : 0;
              const available = Math.max(160, parentHeight - replayHeight);
              const shell = section?.closest<HTMLElement>("[data-app-shell]");
              const applicationHeight = shell?.clientHeight || window.innerHeight;
              setBottomHeight(Math.min(available, Math.round(applicationHeight / 2)));
            }}
          >
            <Maximize2 size={13} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "positions" ? (
          waiting ? (
            <PanelWaiting label="Loading your account" rows={6} className="px-2 py-2" />
          ) : posRows.length === 0 ? (
            <PanelEmpty
              text="No open positions right now."
              hint="Open a trade and it will show up here."
            />
          ) : (
            <table className="w-full min-w-[980px] text-left text-[12px]" data-density={rowDensity}>
              <thead className="sticky top-0 bg-[var(--maws-panel)] text-(--app-muted)">
                <tr>
                  <th className="px-2 py-2 font-normal">Symbol</th>
                  <th className="px-2 py-2 font-normal">Side</th>
                  <th className="px-2 py-2 font-normal">Avg fill price</th>
                  <th className="px-2 py-2 font-normal">Take profit</th>
                  <th className="px-2 py-2 font-normal">Stop loss</th>
                  <th className="px-2 py-2 font-normal">Margin</th>
                  <th className="px-2 py-2 font-normal">Leverage</th>
                  <th className="px-2 py-2 font-normal">Trade value</th>
                  <th className="px-2 py-2 font-normal">Unrealized P&L %</th>
                  <th className="px-2 py-2 font-normal">Unrealized P&L</th>
                  <th className="px-2 py-2 font-normal">Expiration date</th>
                  <th className="px-2 py-2 font-normal">
                    <span className="flex justify-end gap-1 text-(--app-muted)">
                      <Download size={13} />
                      <Columns3 size={13} />
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {posRows.map((p) => {
                  const pnl = p.pnl;
                  const notional = p.notional;
                  const mgn = p.margin;
                  // Binance ROE% is PnL / initial margin (qty × entry / leverage),
                  // not PnL / notional — otherwise the % ignores leverage and
                  // diverges from the Futures UI by the leverage factor.
                  const initialMargin = mgn > 0 ? mgn : notional / Math.max(1, p.leverage);
                  const pct = initialMargin === 0 ? 0 : (pnl / initialMargin) * 100;
                  return (
                    <tr key={p.id} className="border-t border-(--app-border) text-(--app-text)">
                      <td className="px-2 py-2">
                        {formatTicker(p.symbol)}
                        <RiskBar entry={p.entry} last={p.last} sl={p.sl} />
                        {p.protectionStatus === "UNPROTECTED" && (
                          <span className="ml-1 text-[var(--app-down)]" title="The recorded TP/SL protection is missing or could not be confirmed">
                            UNPROTECTED
                          </span>
                        )}
                      </td>
                      <td className={`px-2 py-2 ${p.side === "long" ? "text-[var(--app-accent)]" : "text-[var(--app-down)]"}`}>
                        {p.side === "long" ? "Buy" : "Sell"}
                      </td>
                      <td className="px-2 py-2">{formatPrice(p.symbol, p.entry)}</td>
                      <td className="px-2 py-2">{p.tp == null ? "—" : formatPrice(p.symbol, p.tp)}</td>
                      <td className="px-2 py-2">{p.sl == null ? "—" : formatPrice(p.symbol, p.sl)}</td>
                      <td className="px-2 py-2">{formatNum(mgn)}</td>
                      <td className="px-2 py-2">{p.leverage}x</td>
                      <td className="px-2 py-2">{formatNum(notional)}</td>
                      <td className={`px-2 py-2 ${pct >= 0 ? "text-[var(--app-up)]" : "text-[var(--app-down)]"}`}>

                        {formatSignedNum(pct)}%
                      </td>
                      <td className={`px-2 py-2 ${pnl >= 0 ? "text-[var(--app-up)]" : "text-[var(--app-down)]"}`}>
                        <PnlCell pnl={pnl} markPriceStale={p.markPriceStale} markAgeMs={p.markAgeMs} />
                      </td>
                      <td className="px-2 py-2 text-(--app-muted)">—</td>
                      <td className="px-2 py-2 text-right">
                        {live && (p.tp != null || p.sl != null || p.protectionStatus != null) && (
                          <button
                            type="button"
                            disabled={mutationBlocked}
                            title={mutationBlocked ? "Switching profile…" : "Cancel all TP/SL orders for this position"}
                            className="mr-2 text-[#f0b90b] hover:text-(--app-text) disabled:cursor-not-allowed disabled:text-(--app-disabled) disabled:hover:text-(--app-disabled)"
                            onClick={() => {
                              if (window.confirm(`Remove all TP/SL protection for ${formatTicker(p.symbol)}?`)) {
                                void dispatchRemoveProtection(p.symbol);
                              }
                            }}
                          >
                            Remove TP/SL
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={mutationBlocked}
                          title={mutationBlocked ? "Switching profile…" : undefined}
                          className="text-(--app-muted) hover:text-(--app-text) disabled:cursor-not-allowed disabled:text-(--app-disabled) disabled:hover:text-(--app-disabled)"
                          onClick={() => {
                            void dispatchClosePosition(p.id);
                          }}
                        >
                          Close
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        ) : null}

        {tab === "orders" ? (
          waiting ? (
            <PanelWaiting label="Loading your account" rows={5} className="px-2 py-2" />
          ) : ordRows.length === 0 ? (
            <PanelEmpty
              text="No working orders right now."
              hint="Limit and stop orders stay here until they fill."
            />
          ) : (
            <table className="w-full text-left text-[12px]" data-density={rowDensity}>
              <thead className="sticky top-0 bg-[var(--maws-panel)] text-(--app-muted)">
                <tr>
                  <th className="px-2 py-2 font-normal">Symbol</th>
                  <th className="px-2 py-2 font-normal">Side</th>
                  <th className="px-2 py-2 font-normal">Type</th>
                  <th className="px-2 py-2 font-normal">Qty</th>
                  <th className="px-2 py-2 font-normal">Price</th>
                  <th className="px-2 py-2 font-normal" />
                </tr>
              </thead>
              <tbody>
                {ordRows.map((o) => (
                  <tr key={o.id} className="border-t border-(--app-border) text-(--app-text)">
                    <td className="px-2 py-2">{formatTicker(o.symbol)}</td>
                    <td className={`px-2 py-2 ${o.side === "buy" ? "text-[var(--app-accent)]" : "text-[var(--app-down)]"}`}>
                      {o.side === "buy" ? "Buy" : "Sell"}
                    </td>
                    <td className="px-2 py-2 capitalize">{o.type}</td>
                    <td className="px-2 py-2">{o.qty}</td>
                    <td className="px-2 py-2">{formatPrice(o.symbol, o.price)}</td>
                    <td className="px-2 py-2 text-right">
                      <button
                        type="button"
                        disabled={mutationBlocked}
                        title={mutationBlocked ? "Switching profile…" : undefined}
                        className="text-(--app-muted) hover:text-(--app-text) disabled:cursor-not-allowed disabled:text-(--app-disabled) disabled:hover:text-(--app-disabled)"
                        onClick={() => {
                          void dispatchCancelOrder(o.id);
                        }}
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}

        {tab === "orderHistory" ? (
          waiting ? (
            <PanelWaiting label="Loading your account" rows={6} className="px-2 py-2" />
          ) : histRows.length === 0 ? (
            <PanelEmpty text="No order history yet." hint="Fills from your live account appear here." />
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 items-center gap-2 px-2 py-2">
                {(
                  [
                    { id: "all", label: "All", count: histRows.length },
                    { id: "filled", label: "Filled", count: filledCount },
                    { id: "cancelled", label: "Cancelled", count: cancelledCount },
                    { id: "rejected", label: "Rejected", count: rejectedCount },
                  ] as const
                ).map((f) => {
                  const on = orderFilter === f.id;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setOrderFilter(f.id)}
                      className={`h-[22px] rounded-[4px] px-2 text-[12px] ${
                        on
                          ? "bg-(--app-hover) text-(--app-text)"
                          : "text-(--app-muted) hover:text-(--app-text)"
                      }`}
                    >
                      {f.label}
                      {f.count > 0 || f.id !== "rejected" ? ` ${f.count}` : ""}
                    </button>
                  );
                })}
                <div className="ml-auto">
                  <TableTools />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full min-w-[1280px] text-left text-[12px]">
                  <thead className="sticky top-0 bg-[var(--maws-panel)] text-(--app-muted)">
                    <tr>
                      <th className="px-2 py-2 font-normal">Symbol</th>
                      <th className="px-2 py-2 font-normal">Side</th>
                      <th className="px-2 py-2 font-normal">Type</th>
                      <th className="px-2 py-2 font-normal">Qty</th>
                      <th className="px-2 py-2 font-normal">Limit price</th>
                      <th className="px-2 py-2 font-normal">Stop price</th>
                      <th className="px-2 py-2 font-normal">Fill price</th>
                      <th className="px-2 py-2 font-normal">Status</th>
                      <th className="px-2 py-2 font-normal">Placing time</th>
                      <th className="px-2 py-2 font-normal">Closing time</th>
                      <th className="px-2 py-2 font-normal">Order ID</th>
                      <th className="px-2 py-2 font-normal">Level ID</th>
                      <th className="px-2 py-2 font-normal">Leverage</th>
                      <th className="px-2 py-2 font-normal">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredOrders.map((o) => (
                      <tr key={o.id} className="border-t border-(--app-border) text-(--app-text)">
                        <td className="px-2 py-2">
                          <SymbolChip symbol={o.symbol} />
                        </td>
                        <td
                          className={`px-2 py-2 ${
                            o.side === "buy" ? "text-[var(--app-accent)]" : "text-[var(--app-down)]"
                          }`}
                        >
                          {o.side === "buy" ? "Buy" : "Sell"}
                        </td>
                        <td className="px-2 py-2 capitalize">{o.type}</td>
                        <td className="px-2 py-2">{o.qty}</td>
                        <td className="px-2 py-2 text-(--app-muted)">
                          {o.limitPrice != null
                            ? formatPrice(o.symbol, o.limitPrice)
                            : ""}
                        </td>
                        <td className="px-2 py-2 text-(--app-muted)">
                          {o.stopPrice != null
                            ? formatPrice(o.symbol, o.stopPrice)
                            : ""}
                        </td>
                        <td className="px-2 py-2">
                          {o.fillPrice != null || o.status === "filled"
                            ? formatPrice(o.symbol, o.fillPrice ?? o.price)
                            : ""}
                        </td>
                        <td className="px-2 py-2">
                          <StatusTone status={o.status} />
                        </td>
                        <td className="px-2 py-2 whitespace-nowrap text-(--app-text)">
                          {formatStamp(o.time, stampTz)}
                        </td>
                        <td className="px-2 py-2 whitespace-nowrap text-(--app-text)">
                          {formatStamp(o.closingTime ?? o.time, stampTz)}
                        </td>
                        <td className="px-2 py-2 font-mono text-[11px] text-(--app-muted)">
                          {o.id}
                        </td>
                        <td className="px-2 py-2 text-(--app-muted)" />
                        <td className="px-2 py-2">
                          {o.leverage != null ? `${o.leverage}x` : "—"}
                        </td>
                        <td className="px-2 py-2 whitespace-nowrap">
                          {o.margin != null
                            ? `${formatNum(o.margin)} usd`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        ) : null}

        {tab === "balanceHistory" ? (
          waiting ? (
            <PanelWaiting label="Loading your account" rows={6} className="px-2 py-2" />
          ) : balanceRows.length === 0 ? (
            <PanelEmpty
              text="No balance history yet."
              hint="Balance changes appear here after your first fill."
            />
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 justify-end px-2 py-1">
                <TableTools />
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full min-w-[960px] text-left text-[12px]">
                  <thead className="sticky top-0 bg-[var(--maws-panel)] text-(--app-muted)">
                    <tr>
                      <th className="px-2 py-2 font-normal">Time</th>
                      <th className="px-2 py-2 font-normal">Balance before</th>
                      <th className="px-2 py-2 font-normal">Realized PnL</th>
                      <th className="px-2 py-2 font-normal">Balance after</th>
                      <th className="px-2 py-2 font-normal">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {balanceRows.map((b) => {
                      const before = b.balanceAfter - b.amount;
                      const isPnl = b.type === "realized_pnl";
                      const pnlColor =
                        b.amount > 0
                          ? "text-[var(--app-up)]"
                          : b.amount < 0
                            ? "text-[var(--app-down)]"
                            : "text-(--app-text)";
                      return (
                        <tr key={b.id} className="border-t border-(--app-border) text-(--app-text)">
                          <td className="px-2 py-2 whitespace-nowrap">
                            {formatStamp(b.time, stampTz)}
                          </td>
                          <td className="px-2 py-2">{formatNum(before)}</td>
                          <td className={`px-2 py-2 whitespace-nowrap ${isPnl ? pnlColor : "text-(--app-muted)"}`}>
                            {isPnl
                              ? `${formatSignedNum(b.amount)} USD`
                              : b.type === "deposit" || b.type === "withdrawal"
                                ? `${b.amount < 0 ? "-" : ""}${formatNum(Math.abs(b.amount))} USD`
                                : "—"}
                          </td>
                          <td className="px-2 py-2">{formatNum(b.balanceAfter)}</td>
                          <td className="max-w-[520px] px-2 py-2 text-[11px] leading-snug text-(--app-text)">
                            {b.note}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )
        ) : null}

        {tab === "performance" ? (
          <PerformancePanel histRows={histRows} waiting={waiting} />
        ) : null}

        {tab === "journal" ? (
          waiting ? (
            <PanelWaiting label="Loading your account" rows={5} className="px-2 py-2" />
          ) : journalRows.length === 0 ? (
            <PanelEmpty
              text="Your trading journal is empty."
              hint="Closed trades are written here automatically."
            />
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 justify-end px-2 py-1">
                <TableTools />
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full min-w-[640px] text-left text-[12px]">
                  <thead className="sticky top-0 bg-[var(--maws-panel)] text-(--app-muted)">
                    <tr>
                      <th className="w-[180px] px-2 py-2 font-normal">Time</th>
                      <th className="px-2 py-2 font-normal">Text</th>
                    </tr>
                  </thead>
                  <tbody>
                    {journalRows.map((j) => (
                      <tr key={j.id} className="border-t border-(--app-border) text-(--app-text)">
                        <td className="px-2 py-2 whitespace-nowrap align-top">
                          {formatStamp(j.time, stampTz)}
                        </td>
                        <td className="px-2 py-2 leading-snug">{j.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}
