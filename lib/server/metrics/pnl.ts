import "server-only";

import { liveState } from "@/lib/server/binance/state";
import type { LivePosition } from "@/lib/server/binance/state";
import type { ChartPosition } from "@/types";

/**
 * P&L aggregation for the admin metrics endpoint.
 *
 * `pnl_24h` is defined as the sum of UNREALIZED P&L across all OPEN positions
 * right now:
 *   - live: Binance mark-price unrealized P&L from the server live state.
 *
 * Low-cost, no new tables/services: reads already-maintained in-memory state.
 */

/** Unrealized P&L for a position: (last − entry) × qty for longs, inverse for shorts. */
export function positionUnrealized(pos: ChartPosition, last: number): number {
  return pos.side === "long" ? (last - pos.entry) * pos.qty : (pos.entry - last) * pos.qty;
}

/** Unrealized P&L for live positions: Binance's mark-price value is authoritative. */
export function livePositionUnrealized(p: Pick<LivePosition, "unrealizedProfit">): number {
  const raw = Number(p.unrealizedProfit);
  return Number.isFinite(raw) ? raw : 0;
}

/**
 * Sums unrealized P&L across every open position (live + paper).
 * `clientBacked` is injected by the caller (server-owned module can't read the
 * browser paper store); defaults to live-only if the store is unavailable.
 */
export interface PnlInput {
  positions: readonly ChartPosition[];
  lastPriceOf: (symbol: string) => number;
}

export function pnl24h(input?: PnlInput): number {
  let total = 0;

  // Live positions: mark-price unrealized P&L.
  for (const p of liveState().positions.values()) {
    total += livePositionUnrealized(p);
  }

  // Paper positions: current unrealized P&L only (realized is already banked).
  if (input) {
    for (const p of input.positions) {
      const last = input.lastPriceOf(p.symbol);
      if (Number.isFinite(last) && last > 0) {
        total += positionUnrealized(p, last);
      }
    }
  }

  return total;
}
