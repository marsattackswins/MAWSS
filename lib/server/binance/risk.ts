import "server-only";

import { getDb } from "../db/connection";
import { log } from "../log/logger";
import { audit } from "../audit/log";
import { alert } from "../alerts/dispatch";
import {
  activePersistenceProfile,
  assertPersistenceProfile,
  type PersistenceProfile,
} from "../profile/context";
import type { EnvConfig } from "../env/config";
import { abs, mul, parseDec, pctDiff, type Dec } from "./decimal";

export interface PendingRiskExposure {
  qty: string;
  /** Price used to value the pending quantity. */
  effectivePrice: string;
}

export interface RiskSnapshot {
  balanceUsd: number;
  /** Exposure from current exchange-derived positions only. */
  grossExposureUsd: number;
  openOrderCount: number;
  /** Existing positions before the new order is added; normally the same as the after-count. */
  openPositionCount: number;
  /** Used when evaluating a projected order whose post-order count differs from the base count. */
  openPositionCountAfterOrder?: number;
  /**
   * Net UTC-day result used by the daily-loss check: realized PnL minus
   * commissions plus funding. (Kept under the old name for the DTO contract.)
   */
  realizedTodayUsd: number;
  /** Commission component of `realizedTodayUsd` (positive cost). */
  dailyCommissionUsd?: number;
  /** Funding component of `realizedTodayUsd` (signed as reported). */
  dailyFundingUsd?: number;
  /** Realized trading PnL alone (no fees), for display/debug. */
  dailyRealizedPnlUsd?: number;
  /** Sum of mark-derived unrealized P&L, or null when unavailable/stale. */
  unrealizedPnlUsd?: number | null;
  /** False when account/position marks are missing, stale, or not mark-derived. */
  unrealizedPnlFresh?: boolean;
  /** Maintenance margin / exchange-reported margin balance. */
  marginRatio?: number | null;
  /** False if margin fields or required position marks are missing or stale. */
  marginDataFresh?: boolean;
  /** Per-position mark-to-liquidation distances; empty when none apply. */
  liquidationDistancesPct?: number[] | null;
  /** Working exchange orders reserved against the gross cap. */
  workingOrders?: PendingRiskExposure[];
  /** Intents whose exchange outcome is not yet certain. */
  uncertainIntents?: PendingRiskExposure[];
}

export interface RiskOrderDraft {
  type: string;
  qty: string;
  /** Price driving notional: limit price, stop price, or a mark/last reference. */
  effectivePrice: string;
  reduceOnly: boolean;
  closePosition?: boolean;
  emergencyClose?: boolean;
  isClose?: boolean;
}

/** Assets treated as USD at 1:1 for the daily-loss limit. */
const USD_PEGGED_ASSETS = new Set(["USDT", "USDC", "BUSD", "FDUSD"]);

/** Assets already warned about being counted at face value (per process). */
const warnedCommissionAssets = new Set<string>();

export interface DailyPnl {
  /** Realized trading PnL only (fills_log.realized_pnl). */
  realizedPnlUsd: number;
  /** Commission cost as a positive USD magnitude. */
  commissionUsd: number;
  /** Funding fees for the day, signed as reported (paid = negative). */
  fundingUsd: number;
  /** realizedPnl - commission + funding: what the daily-loss check uses. */
  netUsd: number;
  /** Commission assets that are not USD-pegged (counted at face value). */
  nonUsdCommissionAssets: string[];
}

function utcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function toNumber(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * UTC-day result including fees.
 *
 * Realized PnL and commission come from fills_log; funding comes ONLY from
 * account_income FUNDING_FEE rows. Ledger REALIZED_PNL/COMMISSION rows are
 * deliberately not summed here — they repeat the fills data, so including
 * them would double-count.
 *
 * Commission conversion: USDT/USDC/BUSD/FDUSD at 1:1. Any other asset (BNB
 * being the common case) is counted at face value (1 unit = 1 USD), which can
 * only overstate the cost and therefore fails closed against the loss limit;
 * it is never silently dropped. A one-time warning + audit records each such
 * asset.
 */
export function dailyPnlSinceUtcMidnight(
  now = Date.now(),
  profile: PersistenceProfile = activePersistenceProfile(),
): DailyPnl {
  assertPersistenceProfile(profile);
  const db = getDb();
  const start = utcMidnight(now);
  const fills = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(realized_pnl AS REAL)), 0) AS realized,
              COALESCE(SUM(CAST(fee AS REAL)), 0) AS fee
         FROM fills_log
        WHERE profile_id = ? AND ts >= ?`,
    )
    .get(profile.id, start) as { realized: number; fee: number };
  const feeRows = db
    .prepare(
      `SELECT fee_asset, fee FROM fills_log
        WHERE profile_id = ? AND ts >= ? AND fee IS NOT NULL AND CAST(fee AS REAL) > 0`,
    )
    .all(profile.id, start) as Array<{ fee_asset: string | null; fee: string }>;

  let commissionUsd = 0;
  const nonUsd = new Set<string>();
  for (const row of feeRows) {
    const fee = toNumber(row.fee);
    if (fee <= 0) continue;
    const asset = (row.fee_asset ?? "").trim().toUpperCase();
    if (asset === "" || USD_PEGGED_ASSETS.has(asset)) {
      // An unknown asset is treated as USD rather than dropped: counting it
      // can only increase the measured loss.
      commissionUsd += fee;
      continue;
    }
    nonUsd.add(asset);
    commissionUsd += fee; // conservative face value, see doc comment
    if (!warnedCommissionAssets.has(asset)) {
      warnedCommissionAssets.add(asset);
      log.warn("commission charged in a non-USD asset; counted at face value for the daily-loss limit", { asset });
      audit("system", "risk.commission_asset_non_usd", { asset, basis: "face_value_1usd_per_unit" }, undefined, profile);
      alert("commission_asset_non_usd", { asset, severity: "medium" });
    }
  }

  const funding = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) AS funding
         FROM account_income
        WHERE profile_id = ? AND ts >= ? AND income_type = 'FUNDING_FEE'`,
    )
    .get(profile.id, start) as { funding: number };

  return {
    realizedPnlUsd: toNumber(fills.realized),
    commissionUsd,
    fundingUsd: toNumber(funding.funding),
    netUsd: toNumber(fills.realized) - commissionUsd + toNumber(funding.funding),
    nonUsdCommissionAssets: [...nonUsd],
  };
}

/** Realized P&L alone, booked today (UTC) from the durable fills log. */
export function realizedSinceUtcMidnight(
  now = Date.now(),
  profile: PersistenceProfile = activePersistenceProfile(),
): number {
  assertPersistenceProfile(profile);
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const row = getDb()
    .prepare(`SELECT COALESCE(SUM(CAST(realized_pnl AS REAL)), 0) AS s FROM fills_log WHERE profile_id = ? AND ts >= ? AND realized_pnl IS NOT NULL`)
    .get(profile.id, start) as { s: number };
  return row.s;
}

/**
 * Server-side risk caps. All checks are applied against authoritative
 * exchange-derived state; errors are human readable and shown to the operator.
 */
export function checkRisk(
  cfg: EnvConfig,
  snap: RiskSnapshot,
  order: RiskOrderDraft,
  referencePrice: string | null,
): string[] {
  if (order.reduceOnly || order.closePosition || order.emergencyClose || order.isClose) return [];

  const errors: string[] = [];
  const risk = cfg.risk;
  const notional = abs(mul(parseDec(order.effectivePrice), parseDec(order.qty)));
  const notionalUsd = decToNumber(notional);

  if (notionalUsd > risk.maxOrderNotionalUsd) {
    errors.push(
      `RISK_MAX_ORDER_NOTIONAL: order notional ${notionalUsd.toFixed(2)} USD exceeds max ${risk.maxOrderNotionalUsd} USD`,
    );
  }
  const pendingExposureUsd = pendingExposure(snap.workingOrders) + pendingExposure(snap.uncertainIntents);
  const proposedGrossExposureUsd = snap.grossExposureUsd + pendingExposureUsd + notionalUsd;
  if (proposedGrossExposureUsd > risk.maxGrossExposureUsd) {
    errors.push(
      `RISK_MAX_GROSS_EXPOSURE: gross exposure would become ${proposedGrossExposureUsd.toFixed(2)} USD, above cap ${risk.maxGrossExposureUsd} USD`,
    );
  }
  const staysOnBook = order.type !== "MARKET";
  if (staysOnBook && snap.openOrderCount >= risk.maxOpenOrders) {
    errors.push(`RISK_MAX_OPEN_ORDERS: open order cap reached (${risk.maxOpenOrders})`);
  }
  if (!order.reduceOnly && snap.openPositionCount >= risk.maxOpenPositions) {
    errors.push(`RISK_MAX_OPEN_POSITIONS: open position cap reached (${risk.maxOpenPositions})`);
  }
  if (snap.balanceUsd > 0 && snap.realizedTodayUsd < 0) {
    const limit = (snap.balanceUsd * risk.dailyLossPct) / 100;
    if (-snap.realizedTodayUsd >= limit) {
      errors.push(`EXECUTION_UNHEALTHY: daily realized loss limit reached (${snap.realizedTodayUsd.toFixed(2)} USD)`);
    }
  }
  if (snap.unrealizedPnlFresh !== true || !Number.isFinite(snap.unrealizedPnlUsd)) {
    errors.push("EXECUTION_UNHEALTHY: unrealized P&L is unavailable or stale; risk-increasing order rejected");
  } else if (snap.balanceUsd > 0) {
    const combinedPnl = snap.realizedTodayUsd + snap.unrealizedPnlUsd!;
    const limit = (snap.balanceUsd * risk.dailyLossPct) / 100;
    if (combinedPnl < 0 && -combinedPnl >= limit) {
      errors.push(`EXECUTION_UNHEALTHY: daily realized and unrealized loss limit reached (${combinedPnl.toFixed(2)} USD)`);
    }
  }
  if ((snap.openPositionCountAfterOrder ?? snap.openPositionCount) > 0) {
    if (
      snap.marginDataFresh !== true ||
      !Number.isFinite(snap.marginRatio) ||
      snap.marginRatio! < 0 ||
      !Array.isArray(snap.liquidationDistancesPct) ||
      snap.liquidationDistancesPct.some((distance) => !Number.isFinite(distance))
    ) {
      errors.push("EXECUTION_UNHEALTHY: margin or liquidation data is unavailable or stale; risk-increasing order rejected");
    } else {
      if (snap.marginRatio! > risk.maxMarginRatio) {
        errors.push(
          `RISK_MAX_MARGIN_RATIO: margin ratio ${(snap.marginRatio! * 100).toFixed(2)}% exceeds max ${(risk.maxMarginRatio * 100).toFixed(2)}%`,
        );
      }
      if (snap.liquidationDistancesPct.some((distance) => distance < risk.minLiquidationDistancePct)) {
        const distance = Math.min(...snap.liquidationDistancesPct);
        errors.push(
          `RISK_MIN_LIQ_DISTANCE: liquidation distance ${distance.toFixed(2)}% is below minimum ${risk.minLiquidationDistancePct}%`,
        );
      }
    }
  }
  if (referencePrice && (order.type === "LIMIT" || order.type === "STOP_MARKET" || order.type === "TAKE_PROFIT_MARKET")) {
    const diff = Math.abs(pctDiff(parseDec(order.effectivePrice), parseDec(referencePrice)));
    if (diff > risk.priceCollarPct) {
      errors.push(
        `RISK_PRICE_COLLAR: price ${order.effectivePrice} is ${diff.toFixed(2)}% from reference ${referencePrice}; collar is ${risk.priceCollarPct}%`,
      );
    }
  }
  return errors;
}

function pendingExposure(items: PendingRiskExposure[] | undefined): number {
  return (items ?? []).reduce((total, item) => {
    try {
      return total + decToNumber(abs(mul(parseDec(item.effectivePrice), parseDec(item.qty))));
    } catch {
      // Invalid pending data is not silently treated as exposure. The exchange
      // snapshot/reconciliation path will repair it; current-order checks stay
      // fail-closed through the authoritative snapshot freeze.
      return total;
    }
  }, 0);
}

export function pendingExposureUsd(items: PendingRiskExposure[] | undefined): number {
  return pendingExposure(items);
}

function decToNumber(d: Dec): number {
  return Number(d.units) / 10 ** d.scale;
}
