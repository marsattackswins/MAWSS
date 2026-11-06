/**
 * Broker book selector (lib/selectors/broker.ts).
 *
 * Guarantees the UI renders exactly one orders/positions book at a time:
 *   - connectedBroker === "binance"  → live book only
 *   - connectedBroker !== "binance"  → empty book (no paper fallback)
 * There is no paper book; when disconnected the books are empty.
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { getBrokerBook } from "@/lib/selectors/broker";
import { useAppStore } from "@/lib/store";
import { useLiveStore } from "@/lib/live/store";
import type { OrderDto, PositionDto } from "@/lib/live/types";

const liveOrder: OrderDto = {
  id: "live-order-1",
  symbol: "ETHUSDT",
  side: "sell",
  type: "limit",
  price: 2_500,
  qty: 2,
  reduceOnly: false,
  closePosition: false,
  time: 1_700_000_000_000,
};

const livePos: PositionDto = {
  id: "ETHUSDT",
  symbol: "ETHUSDT",
  side: "short",
  entry: 2_600,
  qty: 1.5,
  tp: null,
  sl: 2_800,
  leverage: 10,
  liq: 3_100,
  mark: 2_550,
  unrealized: 75,
  openedAt: 1_700_000_000_000,
};

beforeEach(() => {
  useAppStore.setState({ connectedBroker: null });
  useLiveStore.setState({ orders: [liveOrder], positions: [livePos] });
});

afterEach(() => {
  useAppStore.setState({ connectedBroker: null });
  useLiveStore.setState({ orders: [], positions: [] });
});

describe("getBrokerBook", () => {
  test("binance: returns live orders/positions only", () => {
    const app = { connectedBroker: "binance" as const };
    const live = { orders: [liveOrder], positions: [livePos] };

    const book = getBrokerBook(app, live);

    expect(book.orders).toHaveLength(1);
    expect(book.orders[0]).toBe(liveOrder);
    expect(book.positions).toHaveLength(1);
    expect(book.positions[0]).toBe(livePos);
  });

  test("no broker connected: returns empty orders/positions", () => {
    const app = { connectedBroker: null };
    const live = { orders: [liveOrder], positions: [livePos] };

    const book = getBrokerBook(app, live);

    expect(book.orders).toEqual([]);
    expect(book.positions).toEqual([]);
  });

  test("returns empty books when the live side has nothing", () => {
    const book = getBrokerBook(
      { connectedBroker: "binance" },
      { orders: [], positions: [] },
    );
    expect(book).toEqual({ orders: [], positions: [] });
  });

  test("disconnected never returns live items even when live is populated", () => {
    const book = getBrokerBook(
      { connectedBroker: null },
      { orders: [liveOrder], positions: [livePos] },
    );
    expect(book.orders).toHaveLength(0);
    expect(book.positions).toHaveLength(0);
  });
});
