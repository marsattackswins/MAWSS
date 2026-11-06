import { describe, expect, test } from "@jest/globals";
import { computeTradeStats, matchRoundTrips, type PerfTrade } from "@/lib/trading/fifo-stats";
import {
  computePerformanceStats,
  orderHistoryToTrades,
} from "@/lib/trading/performance";
import type { OrderHistoryEntry } from "@/types";

/** Row builder: sensible defaults, tests override what matters. */
function row(
  overrides: Partial<OrderHistoryEntry> &
    Pick<OrderHistoryEntry, "id" | "symbol" | "side" | "type" | "qty" | "price" | "status">,
): OrderHistoryEntry {
  return {
    ...overrides,
    time: overrides.time ?? 0,
  };
}

describe("vendored FIFO engine (matchRoundTrips / computeTradeStats)", () => {
  test("matches a simple long round-trip", () => {
    const trips = matchRoundTrips([
      { symbol: "BTCUSDT", side: "buy", quantity: 1, price: 100, executedAt: "2026-01-01T00:00:00Z" },
      { symbol: "BTCUSDT", side: "sell", quantity: 1, price: 110, executedAt: "2026-01-01T01:00:00Z" },
    ]);
    expect(trips).toEqual([{ pnl: 10 }]);
  });

  test("a plain sell with no matching buy is ignored — buys open, sells close (one-way)", () => {
    const trips = matchRoundTrips([
      { symbol: "ETHUSDT", side: "sell", quantity: 2, price: 50, executedAt: "2026-01-01T00:00:00Z" },
      { symbol: "ETHUSDT", side: "buy", quantity: 2, price: 40, executedAt: "2026-01-01T01:00:00Z" },
    ]);
    // Upstream semantics: without positionSide a list nets one-way, so the
    // sell is skipped (nothing to close) and the buy becomes an open lot.
    expect(trips).toEqual([]);
  });

  test("matches a short round-trip in hedge mode: sell opens, buy closes", () => {
    const trips = matchRoundTrips([
      { symbol: "ETHUSDT", side: "sell", quantity: 2, price: 50, positionSide: "short", executedAt: "2026-01-01T00:00:00Z" },
      { symbol: "ETHUSDT", side: "buy", quantity: 2, price: 40, positionSide: "short", executedAt: "2026-01-01T01:00:00Z" },
    ]);
    expect(trips).toEqual([{ pnl: 20 }]);
  });

  test("matches FIFO across lots, honouring partial closes (splitting a round trip)", () => {
    const trips = matchRoundTrips([
      { symbol: "X", side: "buy", quantity: 1, price: 10, executedAt: "2026-01-01T00:00:00Z" },
      { symbol: "X", side: "sell", quantity: 0.5, price: 12, executedAt: "2026-01-01T01:00:00Z" },
      { symbol: "X", side: "sell", quantity: 0.5, price: 14, executedAt: "2026-01-01T02:00:00Z" },
    ]);
    expect(trips.map((t) => t.pnl)).toEqual([1, 2]);
  });

  test("a sell with no recorded buy is ignored, never guessed", () => {
    const trips = matchRoundTrips([
      { symbol: "X", side: "sell", quantity: 1, price: 100 },
    ]);
    expect(trips).toEqual([]);
  });

  test("fill order is by executedAt, not array position", () => {
    const trips = matchRoundTrips([
      { symbol: "X", side: "sell", quantity: 1, price: 120, executedAt: "2026-01-01T01:00:00Z" },
      { symbol: "X", side: "buy", quantity: 1, price: 100, executedAt: "2026-01-01T00:00:00Z" },
    ]);
    // The buy happened first: a +20 round-trip, not a -20 one.
    expect(trips).toEqual([{ pnl: 20 }]);
  });

  test("hedge-mode sides keep separate lots", () => {
    const trips = matchRoundTrips([
      { symbol: "X", side: "buy", quantity: 1, price: 10, positionSide: "long", executedAt: "2026-01-01T00:00:00Z" },
      { symbol: "X", side: "sell", quantity: 1, price: 12, positionSide: "short", executedAt: "2026-01-01T00:30:00Z" },
      { symbol: "X", side: "sell", quantity: 1, price: 15, positionSide: "long", executedAt: "2026-01-01T01:00:00Z" },
    ]);
    // The short side's sell never meets the long side's buy lot; the long
    // round-trip (buy 10 → sell 15) is the only closed one.
    expect(trips.map((t) => t.pnl)).toEqual([5]);
  });

  test("stats roll up win rate, averages and per-symbol realized PnL", () => {
    const trades: PerfTrade[] = [
      { symbol: "A", side: "buy", quantity: 1, price: 10, executedAt: "2026-01-01T00:00:00Z" },
      { symbol: "A", side: "sell", quantity: 1, price: 12, executedAt: "2026-01-01T01:00:00Z" },
      { symbol: "A", side: "buy", quantity: 1, price: 10, executedAt: "2026-01-02T00:00:00Z" },
      { symbol: "A", side: "sell", quantity: 1, price: 8, executedAt: "2026-01-02T01:00:00Z" },
      { symbol: "B", side: "sell", quantity: 10, price: 5, positionSide: "short", executedAt: "2026-01-03T00:00:00Z" }, // hedge short: open lot 10@5
      { symbol: "B", side: "buy", quantity: 5, price: 4, positionSide: "short", executedAt: "2026-01-03T01:00:00Z" }, // closed half: +5
    ];
    const stats = computeTradeStats(trades)!;
    expect(stats.closedTrades).toBe(3);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.winRate).toBeCloseTo(2 / 3);
    expect(stats.avgWin).toBeCloseTo((2 + 5) / 2);
    expect(stats.avgLoss).toBeCloseTo(-2);
    expect(stats.avgPositionSize).toBeCloseTo((10 + 12 + 10 + 8 + 50 + 20) / 6);
    expect(stats.realizedPnl).toBeCloseTo(2 - 2 + 5);
    expect(stats.bySymbol["A"].realizedPnl).toBeCloseTo(0);
    expect(stats.bySymbol["B"].realizedPnl).toBeCloseTo(5);
    expect(stats.bySymbol["B"].notional).toBeCloseTo(70);
  });

  test("empty trade list produces null statistics", () => {
    expect(computeTradeStats([])).toBeNull();
  });
});

describe("orderHistory → PerfTrade mapper", () => {
  test("keeps only filled rows and prefers fillPrice over the quoted price", () => {
    const trades = orderHistoryToTrades([
      row({ id: "1", time: 1000, symbol: "BTCUSDT", side: "buy", type: "limit", qty: 1, price: 100, status: "filled", fillPrice: 99.5 }),
      row({ id: "2", time: 2000, symbol: "BTCUSDT", side: "buy", type: "stop", qty: 1, price: 90, status: "cancelled" }),
      row({ id: "3", time: 3000, symbol: "BTCUSDT", side: "sell", type: "market", qty: 1, price: 110, status: "rejected" }),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ symbol: "BTCUSDT", side: "buy", quantity: 1, price: 99.5 });
  });

  test("executedAt uses closingTime when present, else time; as ISO 8601", () => {
    const trades = orderHistoryToTrades([
      row({ id: "1", time: 1_000, symbol: "X", side: "buy", type: "market", qty: 1, price: 1, status: "filled" }),
      row({ id: "2", time: 5_000, symbol: "X", side: "sell", type: "market", qty: 1, price: 2, status: "filled", closingTime: 9_000 }),
    ]);
    expect(trades[0].executedAt).toBe(new Date(1_000).toISOString());
    expect(trades[1].executedAt).toBe(new Date(9_000).toISOString());
  });

  test("computePerformanceStats crosses the full path", () => {
    const stats = computePerformanceStats([
      row({ id: "1", time: 1_000, symbol: "BTCUSDT", side: "buy", type: "market", qty: 2, price: 100, status: "filled" }),
      row({ id: "2", time: 2_000, symbol: "BTCUSDT", side: "sell", type: "market", qty: 2, price: 120, status: "filled" }),
    ]);
    expect(stats).not.toBeNull();
    expect(stats!.closedTrades).toBe(1);
    expect(stats!.realizedPnl).toBeCloseTo(40);
    expect(stats!.winRate).toBe(1);
  });

  test("history that starts mid-position contributes no PnL", () => {
    const stats = computePerformanceStats([
      row({ id: "1", time: 1_000, symbol: "X", side: "sell", type: "market", qty: 1, price: 100, status: "filled" }),
    ]);
    expect(stats!.closedTrades).toBe(0);
    expect(stats!.realizedPnl).toBe(0);
  });
});
