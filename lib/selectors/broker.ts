/**
 * Broker book selection: one source of truth for which orders/positions the
 * UI renders. Only `connectedBroker === "binance"` shows the live book;
 * in all other states (disconnected) the books are empty — there is no
 * paper book to fall back to.
 */

import { useAppStore, type Store } from "@/lib/store";
import { useLiveStore } from "@/lib/live/store";
import type { OrderDto, PositionDto } from "@/lib/live/types";
import type { ChartOrder, ChartPosition } from "@/types";

/** Chart-compatible position; live DTOs additionally carry mark/unrealized/notional/margin and PnL-freshness fields. */
export type BookPosition = ChartPosition & Partial<Pick<PositionDto, "mark" | "unrealized" | "notional" | "marginType" | "isolatedMargin" | "isolatedWallet" | "markAgeMs" | "markPriceStale">>;

export interface BrokerBook {
  orders: ChartOrder[];
  positions: BookPosition[];
}

/** Empty book returned when no live broker is connected. */
const EMPTY_BOOK: BrokerBook = { orders: [], positions: [] };

/**
 * Pure selector over a combined store snapshot. Live book is returned
 * when (and only when) the binance broker is the connected one.
 * Returns an empty book when disconnected — there is no fallback paper book.
 */
export function getBrokerBook(
  app: Pick<Store, "connectedBroker">,
  live: Pick<ReturnType<typeof useLiveStore.getState>, "orders" | "positions" | "attached" | "profileId">,
): BrokerBook {
  if (app.connectedBroker === "binance" && live.attached && live.profileId !== null) {
    return { orders: live.orders as ChartOrder[], positions: live.positions as BookPosition[] };
  }
  return EMPTY_BOOK;
}

/** Reactive variant for React components (subscribes to both stores). */
export function useBrokerBook(): BrokerBook {
  const connectedBroker = useAppStore((s) => s.connectedBroker);
  const liveOrders = useLiveStore((s) => s.orders);
  const livePositions = useLiveStore((s) => s.positions);
  const attached = useLiveStore((s) => s.attached);
  const profileId = useLiveStore((s) => s.profileId);
  return getBrokerBook({ connectedBroker }, { orders: liveOrders, positions: livePositions, attached, profileId });
}

export type { OrderDto, PositionDto };
