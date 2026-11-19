/**
 * FIX E — the UTC-day loss limit counts commission and funding, not only
 * price PnL, and never double-counts the income ledger.
 */

import { getDb } from "@/lib/server/db/connection";
import { dailyPnlSinceUtcMidnight } from "@/lib/server/binance/risk";
import { checkRisk, type RiskSnapshot } from "@/lib/server/binance/risk";
import { persistenceProfileFromConfig } from "@/lib/server/profile/context";
import { resetAlertsForTests } from "@/lib/server/alerts/dispatch";
import { freshEnv, makeCfg } from "./helpers";

function setup() {
  resetAlertsForTests();
  const cfg = freshEnv(makeCfg({ risk: { ...makeCfg().risk, dailyLossPct: 1 } }));
  const profile = persistenceProfileFromConfig(cfg);
  const db = getDb();
  let seq = 0;
  const addFill = (input: { realized: string; fee?: string; feeAsset?: string; ts?: number }) => {
    seq += 1;
    db.prepare(
      `INSERT INTO fills_log (profile_id, ts, trade_id, symbol, side, qty, price, fee, fee_asset, realized_pnl, source)
       VALUES (?, ?, ?, 'BTCUSDT', 'SELL', '0.001', '50000', ?, ?, ?, 'stream')`,
    ).run(profile.id, input.ts ?? Date.now(), `t${seq}`, input.fee ?? null, input.feeAsset ?? null, input.realized);
  };
  const addIncome = (type: string, amount: string) => {
    seq += 1;
    db.prepare(
      `INSERT INTO account_income (profile_id, income_id, ts, income_type, symbol, amount, asset, info, source)
       VALUES (?, ?, ?, ?, 'BTCUSDT', ?, 'USDT', NULL, 'rest')`,
    ).run(profile.id, `i${seq}`, Date.now(), type, amount);
  };
  return { cfg, profile, addFill, addIncome };
}

function snapshot(realizedTodayUsd: number): RiskSnapshot {
  return {
    balanceUsd: 1000,
    grossExposureUsd: 0,
    openOrderCount: 0,
    openPositionCount: 0,
    realizedTodayUsd,
    unrealizedPnlUsd: 0,
    unrealizedPnlFresh: true,
    marginDataFresh: true,
    marginRatio: 0.1,
    liquidationDistancesPct: [20],
  };
}

const order = { type: "MARKET", qty: "0.001", effectivePrice: "50000", reduceOnly: false };

describe("daily-loss accounting", () => {
  test("commission tips the day over the limit while price PnL alone does not", () => {
    const { cfg, addFill } = setup();
    addFill({ realized: "-9", fee: "2", feeAsset: "USDT" });

    const daily = dailyPnlSinceUtcMidnight(Date.now());
    expect(daily.realizedPnlUsd).toBeCloseTo(-9);
    expect(daily.commissionUsd).toBeCloseTo(2);
    expect(daily.netUsd).toBeCloseTo(-11);

    // 1% of 1000 USD = 10 USD limit.
    expect(checkRisk(cfg, snapshot(-9), order, "50000")).toEqual([]);
    const errors = checkRisk(cfg, snapshot(daily.netUsd), order, "50000");
    expect(errors.some((e) => e.includes("daily realized loss limit"))).toBe(true);
  });

  test("funding is included for the UTC day", () => {
    const { addIncome } = setup();
    addIncome("FUNDING_FEE", "-11");
    const daily = dailyPnlSinceUtcMidnight(Date.now());
    expect(daily.fundingUsd).toBeCloseTo(-11);
    expect(daily.netUsd).toBeCloseTo(-11);
  });

  test("the income ledger is not double-counted (only FUNDING_FEE is summed)", () => {
    const { addFill, addIncome } = setup();
    addFill({ realized: "-5", fee: "1", feeAsset: "USDT" });
    // The ledger repeats realized PnL and commission; summing those rows would
    // double the day's loss.
    addIncome("REALIZED_PNL", "-5");
    addIncome("COMMISSION", "-1");
    addIncome("FUNDING_FEE", "-2");

    const daily = dailyPnlSinceUtcMidnight(Date.now());
    expect(daily.realizedPnlUsd).toBeCloseTo(-5);
    expect(daily.commissionUsd).toBeCloseTo(1);
    expect(daily.fundingUsd).toBeCloseTo(-2);
    expect(daily.netUsd).toBeCloseTo(-8);
  });

  test("yesterday's fills and funding are excluded", () => {
    const { addFill } = setup();
    const yesterday = Date.now() - 48 * 60 * 60 * 1000;
    addFill({ realized: "-50", fee: "5", feeAsset: "USDT", ts: yesterday });
    getDb()
      .prepare(
        `INSERT INTO account_income (profile_id, income_id, ts, income_type, symbol, amount, asset, info, source)
         VALUES (?, 'old-funding', ?, 'FUNDING_FEE', 'BTCUSDT', '-50', 'USDT', NULL, 'rest')`,
      )
      .run(persistenceProfileFromConfig(makeCfg()).id, yesterday);
    const daily = dailyPnlSinceUtcMidnight(Date.now());
    expect(daily.realizedPnlUsd).toBe(0);
    expect(daily.fundingUsd).toBe(0);
  });

  test("non-USDT commission is counted conservatively, never silently zeroed", () => {
    const { addFill } = setup();
    addFill({ realized: "0", fee: "0.02", feeAsset: "BNB" });
    const daily = dailyPnlSinceUtcMidnight(Date.now());
    expect(daily.commissionUsd).toBeCloseTo(0.02);
    expect(daily.nonUsdCommissionAssets).toEqual(["BNB"]);
    expect(daily.netUsd).toBeCloseTo(-0.02);
  });
});
