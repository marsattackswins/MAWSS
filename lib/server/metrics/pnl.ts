import "server-only";

import { liveState } from "@/lib/server/binance/state";
import type { LivePosition } from "@/lib/server/binance/state";

/** Binance's mark-price unrealized P&L is authoritative. */
export function livePositionUnrealized(p: Pick<LivePosition, "unrealizedProfit">): number {
  const raw = Number(p.unrealizedProfit);
  return Number.isFinite(raw) ? raw : 0;
}

/** Current unrealized P&L across open Binance positions; no browser inputs. */
export function pnl24h(): number {
  let total = 0;
  for (const p of liveState().positions.values()) total += livePositionUnrealized(p);
  return total;
}
