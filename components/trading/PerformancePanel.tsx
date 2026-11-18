"use client";

import { useMemo } from "react";
import { formatTicker } from "@/lib/maws/universe";
import { computePerformanceStats } from "@/lib/trading/performance";
import { formatNum } from "@/lib/trading/format";
import type { OrderHistoryEntry } from "@/types";

/**
 * Performance tab of the bottom panel: FIFO round-trip statistics derived
 * from the confirmed fill history (the live fill feed mapped onto the
 * order-history shape by the panel). Read-only — the engine
 * never mutates state and never sees order credentials.
 */

function StatCell({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: "up" | "down" | "muted";
  title?: string;
}) {
  const color =
    tone === "up" ? "text-[var(--app-up)]" : tone === "down" ? "text-[var(--app-down)]" : "text-(--app-text)";
  return (
    <span
      title={title}
      className="flex flex-col justify-center gap-1 whitespace-nowrap border-l border-(--app-border) px-4 py-1 first:border-l-0"
    >
      <span className="text-[11px] font-semibold uppercase leading-none tracking-[0.08em] text-(--app-muted)">
        {label}
      </span>
      <span className={`text-[13px] font-semibold leading-none ${color}`}>{value}</span>
    </span>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-full min-h-[120px] items-center justify-center text-[13px] text-(--app-muted)">
      {text}
    </div>
  );
}

const pctText = (rate: number | null) => (rate == null ? "—" : `${Math.round(rate * 100)}%`);

const signed = (v: number) => (v >= 0 ? "+" : "") + formatNum(v);

export function PerformancePanel({ histRows }: { histRows: OrderHistoryEntry[] }) {
  const stats = useMemo(() => computePerformanceStats(histRows), [histRows]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center">
        <StatCell label="Fills" value={stats ? String(stats.count) : "0"} />
        <StatCell label="Closed trades" value={stats ? String(stats.closedTrades) : "0"} />
        <StatCell
          label="Win rate"
          value={pctText(stats?.winRate ?? null)}
          title="Closed round-trips that matched a buy lot FIFO and closed with profit"
        />
        <StatCell
          label="Avg win"
          value={stats?.avgWin != null ? signed(stats.avgWin) : "—"}
          tone={stats?.avgWin != null ? (stats.avgWin >= 0 ? "up" : "down") : "muted"}
        />
        <StatCell
          label="Avg loss"
          value={stats?.avgLoss != null ? signed(stats.avgLoss) : "—"}
          tone={stats?.avgLoss != null ? (stats.avgLoss >= 0 ? "up" : "down") : "muted"}
        />
        <StatCell
          label="Avg position size"
          value={stats?.avgPositionSize != null ? formatNum(stats.avgPositionSize) : "—"}
          title="Average traded notional (quantity × price) per fill"
        />
        <StatCell
          label="Realized PnL (FIFO)"
          value={stats ? signed(stats.realizedPnl) : "0.00"}
          tone={stats ? (stats.realizedPnl >= 0 ? "up" : "down") : "muted"}
          title="Sells matched FIFO against prior buys per symbol; sells with no recorded buy are ignored, never guessed"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!stats ? (
          <Empty text="No fills recorded yet — statistics appear once the account has traded" />
        ) : stats.closedTrades === 0 ? (
          <Empty text="No closed round-trips yet — open lots do not contribute PnL until a closing fill matches them" />
        ) : (
          <table className="w-full min-w-[560px] text-left text-[12px]">
            <thead className="sticky top-0 bg-[var(--maws-panel)] text-(--app-muted)">
              <tr>
                <th className="px-2 py-2 font-normal">Symbol</th>
                <th className="px-2 py-2 font-normal">Fills</th>
                <th className="px-2 py-2 font-normal">Notional</th>
                <th className="px-2 py-2 font-normal">Realized PnL</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(stats.bySymbol).map(([symbol, entry]) => (
                <tr key={symbol} className="border-t border-(--app-border) text-(--app-text)">
                  <td className="px-2 py-2">{formatTicker(symbol)}</td>
                  <td className="px-2 py-2">{entry.trades}</td>
                  <td className="px-2 py-2">{formatNum(entry.notional)}</td>
                  <td
                    className={`px-2 py-2 ${
                      entry.realizedPnl >= 0 ? "text-[var(--app-up)]" : "text-[var(--app-down)]"
                    }`}
                  >
                    {signed(entry.realizedPnl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
