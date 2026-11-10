import "server-only";

import { alert } from "../alerts/dispatch";
import { audit } from "../audit/log";
import {
  activePersistenceProfile,
  assertPersistenceProfile,
  type PersistenceProfile,
} from "../profile/context";
import { findByClientOrderId, updateIntent } from "./intents";
import { deleteProtectionIntent } from "./protection";
import {
  beginAlgoOrphanCleanup,
  finishAlgoOrphanCleanup,
  liveState,
  markOrderCanceledLocally,
} from "./state";

/** Conditional-order row, narrowed to what orphan cleanup needs. */
export interface ConditionalAlgoOrder {
  clientAlgoId: string;
  symbol: string;
  closePosition?: boolean;
}

export interface OrphanAlgoCleanupDeps {
  getOpenAlgoOrders(symbol: string): Promise<ConditionalAlgoOrder[]>;
  cancelAlgoOrder(clientAlgoId: string): Promise<unknown>;
  /** Exchange truth: the symbol has no open position right now. */
  isSymbolFlat(): boolean;
  /** False when the owning manager generation was replaced mid-cleanup. */
  isCurrent?(): boolean;
}

export interface OrphanAlgoCleanupResult {
  symbol: string;
  canceled: string[];
  remaining: string[];
  /** Honest description of every failed step, or null when confirmed. */
  error: string | null;
}

/**
 * Client ids of the open closePosition algo orders the live view knows for a
 * symbol. Only these ids are ever cancelled, so a new position's fresh exit
 * orders (which carry new ids) are never touched by a stale cleanup.
 */
export function openClosePositionAlgoIds(symbol: string): string[] {
  return [...liveState().openOrders.values()]
    .filter((order) => order.symbol === symbol && order.kind === "algo" && order.closePosition)
    .map((order) => order.clientOrderId);
}

/**
 * Cancels the untriggered closePosition legs of a position that is already
 * flat. Binance only removes the leg that fired, so the sibling conditional
 * order would otherwise sit on the exchange until someone notices it.
 * Failures are alerted and remembered: the surviving ids can never be reused
 * as protection by a later position on the same symbol.
 */
export async function cancelOrphanedClosePositionAlgos(
  symbol: string,
  candidateIds: Iterable<string>,
  deps: OrphanAlgoCleanupDeps,
  profile: PersistenceProfile = activePersistenceProfile(),
  source = "reconciliation",
): Promise<OrphanAlgoCleanupResult> {
  assertPersistenceProfile(profile);
  const candidates = new Set(candidateIds);
  const result: OrphanAlgoCleanupResult = { symbol, canceled: [], remaining: [], error: null };
  if (candidates.size === 0) return result;

  beginAlgoOrphanCleanup(symbol, candidates);
  let targets: ConditionalAlgoOrder[];
  try {
    const open = await deps.getOpenAlgoOrders(symbol);
    if (deps.isCurrent && !deps.isCurrent()) {
      // A replaced generation no longer owns this symbol; keep the ids blocked
      // but do not audit or alert on the dead generation's behalf.
      finishAlgoOrphanCleanup(symbol, candidates);
      return result;
    }
    targets = open.filter((order) => candidates.has(order.clientAlgoId) && order.closePosition !== false);
  } catch (err) {
    result.error = String(err);
    result.remaining = [...candidates];
    finishAlgoOrphanCleanup(symbol, result.remaining);
    reportCleanupFailure(symbol, source, result.remaining, result.error, profile);
    return result;
  }
  if (targets.length === 0) {
    finishAlgoOrphanCleanup(symbol, []);
    return result;
  }

  audit("operator", "position.algo_orphan.cancel_started", {
    symbol,
    source,
    clientAlgoIds: targets.map((order) => order.clientAlgoId),
    severity: "high",
  }, undefined, profile);

  const errors: string[] = [];
  for (const order of targets) {
    try {
      await deps.cancelAlgoOrder(order.clientAlgoId);
      result.canceled.push(order.clientAlgoId);
    } catch (err) {
      errors.push(`${order.clientAlgoId}: ${String(err)}`);
    }
  }
  recordCanceledOrders(symbol, targets.filter((order) => result.canceled.includes(order.clientAlgoId)), profile, source);

  let remaining: string[];
  try {
    remaining = (await deps.getOpenAlgoOrders(symbol))
      .filter((order) => candidates.has(order.clientAlgoId) && order.closePosition !== false)
      .map((order) => order.clientAlgoId);
  } catch (err) {
    remaining = targets.map((order) => order.clientAlgoId);
    errors.push(`verification failed: ${String(err)}`);
  }

  result.remaining = remaining;
  result.error = errors.length > 0 ? errors.join("; ") : null;
  finishAlgoOrphanCleanup(symbol, remaining);

  if (remaining.length > 0) {
    reportCleanupFailure(symbol, source, remaining, result.error, profile);
    return result;
  }
  if (deps.isSymbolFlat()) deleteProtectionIntent(symbol, profile);
  audit("operator", "position.algo_orphan.cleaned", {
    symbol,
    source,
    canceled: result.canceled,
    ...(result.error ? { cancelErrors: result.error } : {}),
  }, undefined, profile);
  alert(`position_algo_orphan_cleaned:${symbol}`, {
    symbol,
    source,
    canceled: result.canceled,
    ...(result.error ? { cancelErrors: result.error } : {}),
  });
  return result;
}

/** Marks confirmed cancels in local state and syncs their durable intents. */
function recordCanceledOrders(
  symbol: string,
  orders: ConditionalAlgoOrder[],
  profile: PersistenceProfile,
  source: string,
): void {
  assertPersistenceProfile(profile);
  for (const order of orders) {
    markOrderCanceledLocally(order.clientAlgoId);
    const intent = findByClientOrderId(order.clientAlgoId, profile);
    if (intent && !["FILLED", "REJECTED", "EXPIRED"].includes(intent.status)) {
      updateIntent(order.clientAlgoId, {
        status: "CANCELED",
        lastState: JSON.stringify({ source, kind: "algo" }),
      }, Date.now(), profile);
    }
  }
  audit("operator", "position.algo_orphan.cancelled", {
    symbol,
    source,
    clientAlgoIds: orders.map((order) => order.clientAlgoId),
  }, undefined, profile);
}

function reportCleanupFailure(
  symbol: string,
  source: string,
  remaining: string[],
  error: string | null,
  profile: PersistenceProfile,
): void {
  assertPersistenceProfile(profile);
  audit("operator", "position.algo_orphan.cleanup_failed", {
    symbol,
    source,
    remaining,
    error,
    severity: "high",
  }, undefined, profile);
  alert(`position_algo_orphan_cleanup_failed:${symbol}`, {
    symbol,
    source,
    remaining,
    error,
    severity: "high",
  });
}
