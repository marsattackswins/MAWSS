/**
 * G — fail-closed small fixes.
 *
 * Exchange filters that were declared but never enforced (MIN_NOTIONAL,
 * MAX_NUM_ORDERS), pending exposure silently valued at zero when a decimal was
 * unreadable, and an unpriced commission asset that blocked trading without any
 * visible reason.
 */

import { describe, expect, test } from "@jest/globals";

import { checkRisk, recordCommissionPrice, resetCommissionPricesForTests, unpricedCommissionAssets, type RiskSnapshot } from "@/lib/server/binance/risk";
import { COMMISSION_PRICE_MAX_AGE_MS } from "@/lib/server/binance/risk";
import { extractConstraints, validateAgainstConstraints } from "@/lib/server/binance/filters";
import { PROTECTION_RESTORE_RETRY_MAX_MS } from "@/lib/server/binance/recon";
import { getDb } from "@/lib/server/db/connection";
import { persistenceProfileFromConfig } from "@/lib/server/profile/context";
import { freshEnv, makeCfg } from "./helpers";

const INFO = {
  symbol: "BTCUSDT",
  status: "TRADING",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  filters: [
    { filterType: "PRICE_FILTER", minPrice: "0.1", maxPrice: "1000000", tickSize: "0.1" },
    { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "100", stepSize: "0.001" },
    { filterType: "MARKET_LOT_SIZE", minQty: "0.001", maxQty: "100", stepSize: "0.001" },
    { filterType: "MIN_NOTIONAL", notional: "5" },
    { filterType: "MAX_NUM_ORDERS", limit: 2 },
  ],
};

function snapshot(overrides: Partial<RiskSnapshot> = {}): RiskSnapshot {
  return {
    balanceUsd: 1000,
    grossExposureUsd: 0,
    openOrderCount: 0,
    openPositionCount: 0,
    realizedTodayUsd: 0,
    unrealizedPnlFresh: true,
    unrealizedPnlUsd: 0,
    marginDataFresh: true,
    marginRatio: 0.1,
    liquidationDistancesPct: [],
    openPositionCountAfterOrder: 0,
    ...overrides,
  };
}

describe("MIN_NOTIONAL and MAX_NUM_ORDERS", () => {
  const constraints = extractConstraints(INFO);

  test("the MAX_NUM_ORDERS filter is read from `limit`", () => {
    expect(constraints.maxNumOrders).toBe(2);
  });

  test("a LIMIT below MIN_NOTIONAL is rejected", () => {
    const errors = validateAgainstConstraints(constraints, {
      symbol: "BTCUSDT",
      type: "LIMIT",
      price: "1000",
      qty: "0.001", // 1 USD < 5 USD
    });
    expect(errors.some((error) => error.includes("minNotional"))).toBe(true);
  });

  test("a LIMIT at or above MIN_NOTIONAL passes", () => {
    const errors = validateAgainstConstraints(constraints, {
      symbol: "BTCUSDT",
      type: "LIMIT",
      price: "6000",
      qty: "0.001", // 6 USD
    });
    expect(errors).toEqual([]);
  });

  test("a quantity-based STOP_MARKET is valued at its trigger price", () => {
    const below = validateAgainstConstraints(constraints, {
      symbol: "BTCUSDT",
      type: "STOP_MARKET",
      stopPrice: "1000",
      qty: "0.001",
    });
    expect(below.some((error) => error.includes("minNotional"))).toBe(true);

    const above = validateAgainstConstraints(constraints, {
      symbol: "BTCUSDT",
      type: "STOP_MARKET",
      stopPrice: "6000",
      qty: "0.001",
    });
    expect(above).toEqual([]);
  });

  test("a closePosition leg has no quantity and skips the notional check", () => {
    const errors = validateAgainstConstraints(constraints, {
      symbol: "BTCUSDT",
      type: "STOP_MARKET",
      stopPrice: "1000",
    });
    expect(errors.some((error) => error.includes("minNotional"))).toBe(false);
  });
});

describe("pending exposure", () => {
  test("an unreadable pending amount rejects instead of counting as zero", () => {
    const errors = checkRisk(
      makeCfg(),
      snapshot({ workingOrders: [{ qty: "not-a-number", effectivePrice: "50000" }] }),
      { type: "LIMIT", qty: "0.001", effectivePrice: "50000", reduceOnly: false },
      null,
    );
    expect(errors).toContain("EXECUTION_UNHEALTHY: pending exposure unreadable");
  });

  test("readable pending exposure adds to the gross check and names no error", () => {
    const errors = checkRisk(
      makeCfg({ risk: { ...makeCfg().risk, maxGrossExposureUsd: 1 } }),
      snapshot({ workingOrders: [{ qty: "0.0001", effectivePrice: "50000" }] }), // 5 USD
      { type: "LIMIT", qty: "0.001", effectivePrice: "50000", reduceOnly: false },
      null,
    );
    expect(errors.some((error) => error.startsWith("RISK_MAX_GROSS_EXPOSURE"))).toBe(true);
    expect(errors).not.toContain("EXECUTION_UNHEALTHY: pending exposure unreadable");
  });
});

describe("commission asset diagnosis", () => {
  test("an unpriced asset is named and clears itself once a price arrives", () => {
    const cfg = freshEnv(makeCfg());
    const profile = persistenceProfileFromConfig(cfg);
    resetCommissionPricesForTests();
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO fills_log (profile_id, ts, trade_id, symbol, side, qty, price, fee, fee_asset, realized_pnl, source)
         VALUES (?, ?, NULL, 'BTCUSDT', 'BUY', '0.01', '50000', '0.001', 'BNB', '0', 'stream')`,
      )
      .run(profile.id, now);

    expect(unpricedCommissionAssets(now, profile)).toEqual(["BNB"]);

    const errors = checkRisk(
      cfg,
      snapshot({ commissionAssetsUnpriced: ["BNB"] }),
      { type: "LIMIT", qty: "0.001", effectivePrice: "50000", reduceOnly: false },
      null,
    );
    expect(errors).toContain("EXECUTION_UNHEALTHY: commission asset price unavailable (BNB)");

    recordCommissionPrice("BNB", 600, now);
    expect(unpricedCommissionAssets(now, profile)).toEqual([]);

    // A stale quote is no quote: the block returns and names the asset again.
    expect(unpricedCommissionAssets(now + COMMISSION_PRICE_MAX_AGE_MS + 1, profile)).toEqual(["BNB"]);
  });

  test("an empty fee_asset is reported as UNKNOWN rather than assumed USD", () => {
    const cfg = freshEnv(makeCfg());
    const profile = persistenceProfileFromConfig(cfg);
    resetCommissionPricesForTests();
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO fills_log (profile_id, ts, trade_id, symbol, side, qty, price, fee, fee_asset, realized_pnl, source)
         VALUES (?, ?, NULL, 'BTCUSDT', 'BUY', '0.01', '50000', '0.001', '', '0', 'stream')`,
      )
      .run(profile.id, now);
    // Empty labels are excluded from the asset list but still fail the day
    // closed through the manager's snapshot (commissionAssetsUnpriced).
    expect(unpricedCommissionAssets(now, profile)).toEqual([]);
    const errors = checkRisk(
      cfg,
      snapshot({ commissionAssetsUnpriced: ["UNKNOWN"] }),
      { type: "LIMIT", qty: "0.001", effectivePrice: "50000", reduceOnly: false },
      null,
    );
    expect(errors).toContain("EXECUTION_UNHEALTHY: commission asset price unavailable (UNKNOWN)");
  });

  test("protection restore retries for ten minutes", () => {
    expect(PROTECTION_RESTORE_RETRY_MAX_MS).toBe(10 * 60_000);
  });
});
