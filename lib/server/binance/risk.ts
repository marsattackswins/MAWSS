import "server-only";

import { getDb } from "../db/connection";
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
  openPositionCount: number;
  realizedTodayUsd: number;
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

/** Realized P&L booked today (UTC) from the durable fills log. */
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
  if (snap.openPositionCount > 0) {
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
