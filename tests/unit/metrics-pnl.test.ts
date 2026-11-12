/**
 * pnl_24h metric (lib/server/metrics/pnl.ts).
 *
 * Verifies the admin metrics endpoint stays numeric and fast to compute:
 *   - live positions contribute Binance mark-price unrealized P&L,
 *   - empty state sums to 0,
 *   - non-finite exchange values are ignored rather than poisoning the total,
 *   - the value is a finite number.
 *
 * Paper trading has been removed, so there is no browser/paper input path.
 */

import { describe, test, expect, beforeEach } from "@jest/globals";
import { pnl24h, livePositionUnrealized } from "@/lib/server/metrics/pnl";
import { liveState, resetLiveStateForTests } from "@/lib/server/binance/state";

describe("pnl_24h metric", () => {
  beforeEach(() => {
    resetLiveStateForTests();
  });

  test("is numeric and zero when there are no positions", () => {
    const value = pnl24h();
    expect(typeof value).toBe("number");
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBe(0);
  });

  test("live positions contribute mark-price unrealized P&L", () => {
    const state = liveState();
    state.positions.set("BTCUSDT", {
      symbol: "BTCUSDT",
      side: "long",
      qty: "1",
      entryPrice: "60000",
      markPrice: "65000",
      unrealizedProfit: "5000",
      leverage: "10",
      liquidationPrice: "54000",
      notional: "65000",
      updatedAt: Date.now(),
    });

    expect(pnl24h()).toBe(5_000);
  });

  test("sums every open live position, including losses", () => {
    const state = liveState();
    state.positions.set("SOLUSDT", {
      symbol: "SOLUSDT",
      side: "long",
      qty: "10",
      entryPrice: "100",
      markPrice: "105",
      unrealizedProfit: "50",
      leverage: "5",
      liquidationPrice: "80",
      notional: "1050",
      updatedAt: Date.now(),
    });
    state.positions.set("ETHUSDT", {
      symbol: "ETHUSDT",
      side: "short",
      qty: "2",
      entryPrice: "3000",
      markPrice: "3100",
      unrealizedProfit: "-200",
      leverage: "5",
      liquidationPrice: "3600",
      notional: "6200",
      updatedAt: Date.now(),
    });

    expect(pnl24h()).toBe(-150);
  });

  test("helpers are numeric for clean and malformed inputs", () => {
    expect(livePositionUnrealized({ unrealizedProfit: "-123.45" })).toBe(-123.45);
    expect(livePositionUnrealized({ unrealizedProfit: "0" })).toBe(0);
    expect(livePositionUnrealized({ unrealizedProfit: "not-a-number" })).toBe(0);
    expect(Number.isFinite(livePositionUnrealized({ unrealizedProfit: "NaN" }))).toBe(true);
  });
});
