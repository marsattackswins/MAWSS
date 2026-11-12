import { computeTradeStats, type PerfTrade, type PerfTradeStats } from "@/lib/trading/fifo-stats";
import type { OrderHistoryEntry } from "@/types";

/**
 * Bridges MAWS order history to the vendored FIFO stats engine. The history
 * also carries cancelled/rejected rows and quoted (not filled) prices, which
 * the engine must never see: only `filled` rows map, and `fillPrice` wins
 * over the quoted `price` whenever the exchange reported one.
 */
export function orderHistoryToTrades(history: OrderHistoryEntry[]): PerfTrade[] {
  return history
    .filter((entry) => entry.status === "filled")
    .map((entry) => ({
      symbol: entry.symbol,
      side: entry.side,
      quantity: entry.qty,
      price: entry.fillPrice ?? entry.price,
      // The engine sorts by executedAt (ISO text sorts chronologically);
      // closingTime is when the fill completed, which is the stat-relevant time.
      executedAt: new Date(entry.closingTime ?? entry.time).toISOString(),
    }));
}

/**
 * Performance statistics for one fill history (normalized to
 * OrderHistoryEntry by the panel).
 * Pure — callers memoize over the history identity.
 */
export function computePerformanceStats(history: OrderHistoryEntry[]): PerfTradeStats | null {
  return computeTradeStats(orderHistoryToTrades(history));
}
