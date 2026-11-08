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
import { liveState } from "./state";
import type { BinanceOrder } from "./types";
import type { OrderResult } from "./orders";

export interface EmergencyPosition {
  symbol: string;
  positionAmt: string;
}

/** Conditional-order view of the exchange, kept narrow on purpose. */
export interface EmergencyAlgoOrder {
  clientAlgoId: string;
  symbol: string;
  /** closePosition orders are the leftovers an operator must clear. */
  closePosition?: boolean;
}

export interface EmergencyFlattenDeps {
  getOpenOrders(): Promise<BinanceOrder[]>;
  getOpenAlgoOrders(symbol: string): Promise<EmergencyAlgoOrder[]>;
  getOpenPositions(): Promise<EmergencyPosition[]>;
  cancelAllOpenOrders(symbol: string): Promise<BinanceOrder[]>;
  cancelAllAlgoOrders(symbol: string): Promise<unknown>;
  closePosition(symbol: string, positionAmt: string): Promise<OrderResult>;
  emit?(event: string, data: unknown): void;
}

export interface EmergencyFlattenFailure {
  action:
    | "snapshot_orders"
    | "cancel_orders"
    | "cancel_algo_orders"
    | "verify_algo_orders"
    | "close_position";
  symbol?: string;
  error: string;
}

export interface EmergencyFlattenSummary {
  accountId: string;
  triggeredBy: string;
  startedAt: number;
  finishedAt: number;
  canceledOrderIds: string[];
  closedPositions: Array<{ symbol: string; result: OrderResult }>;
  failures: EmergencyFlattenFailure[];
  /** Conditional orders still open after the retry; operators must clear them. */
  remainingAlgoOrders: Array<{ symbol: string; clientAlgoId: string }>;
}

/** Outcome of one cancellation round for a single symbol. */
interface AlgoCancelAttempt {
  /** Orders the exchange listed as open before the cancel was issued. */
  seen: EmergencyAlgoOrder[];
  /** Orders still listed as open after the cancel. */
  remaining: EmergencyAlgoOrder[];
  /** Honest description of every failed step, or null when fully confirmed. */
  error: string | null;
}

const inFlight = new Map<string, Promise<EmergencyFlattenSummary>>();

/**
 * Emergency action only. It intentionally does not call normal order
 * submission/cancellation methods, so kill switches, uncertainty freezes, and
 * normal circuit breakers cannot prevent an attempt to reduce exposure.
 */
export function cancelAllAndFlatten(
  accountId: string,
  deps: EmergencyFlattenDeps,
  triggeredBy: string,
  profile: PersistenceProfile = activePersistenceProfile(),
): Promise<EmergencyFlattenSummary> {
  assertPersistenceProfile(profile);
  const existing = inFlight.get(accountId);
  if (existing) return existing;

  const run = executeFlatten(accountId, deps, triggeredBy, profile);
  inFlight.set(accountId, run);
  void run.finally(() => {
    if (inFlight.get(accountId) === run) inFlight.delete(accountId);
  });
  return run;
}

async function executeFlatten(
  accountId: string,
  deps: EmergencyFlattenDeps,
  triggeredBy: string,
  profile: PersistenceProfile,
): Promise<EmergencyFlattenSummary> {
  assertPersistenceProfile(profile);
  const startedAt = Date.now();
  const canceledOrderIds: string[] = [];
  const closedPositions: Array<{ symbol: string; result: OrderResult }> = [];
  const failures: EmergencyFlattenFailure[] = [];

  audit("operator", "emergency.flatten.started", { accountId, triggeredBy, startedAt });

  let openOrders: BinanceOrder[] = [];
  try {
    openOrders = await deps.getOpenOrders();
  } catch (err) {
    failures.push({ action: "snapshot_orders", error: String(err) });
    audit("operator", "emergency.flatten.failure", { accountId, triggeredBy, action: "snapshot_orders", error: String(err) });
  }

  let positions: EmergencyPosition[] = [];
  try {
    positions = await deps.getOpenPositions();
  } catch (err) {
    failures.push({ action: "close_position", error: `Unable to snapshot positions: ${String(err)}` });
    audit("operator", "emergency.flatten.failure", { accountId, triggeredBy, action: "close_position", error: String(err) });
  }

  // Conditional-order cleanup is best effort: a failure there is reported but
  // never gates the reduce-only close that removes the actual exposure.
  const algoAttempts = await cancelOpenOrders(
    accountId,
    deps,
    triggeredBy,
    openOrders,
    positions,
    canceledOrderIds,
    failures,
    profile,
  );
  const closedSymbols = await closeOpenPositions(
    accountId,
    deps,
    triggeredBy,
    positions,
    closedPositions,
    failures,
    profile,
  );
  const remainingAlgoOrders = await retryAlgoCancels(
    accountId,
    deps,
    triggeredBy,
    algoAttempts,
    closedSymbols,
    canceledOrderIds,
    failures,
    profile,
  );

  const finishedAt = Date.now();
  const summary = {
    accountId,
    triggeredBy,
    startedAt,
    finishedAt,
    canceledOrderIds,
    closedPositions,
    failures,
    remainingAlgoOrders,
  };
  audit("operator", "emergency.flatten.completed", summary);
  return summary;
}

async function cancelOpenOrders(
  accountId: string,
  deps: EmergencyFlattenDeps,
  triggeredBy: string,
  openOrders: BinanceOrder[],
  positions: EmergencyPosition[],
  canceledOrderIds: string[],
  failures: EmergencyFlattenFailure[],
  profile: PersistenceProfile,
): Promise<Map<string, AlgoCancelAttempt>> {
  assertPersistenceProfile(profile);
  const symbols = [...new Set([
    ...openOrders.map((order) => order.symbol),
    ...positions.map((position) => position.symbol),
  ])];
  const attempts = new Map<string, AlgoCancelAttempt>();
  for (const symbol of symbols) {
    const symbolOrders = openOrders.filter((order) => order.symbol === symbol && order.kind !== "algo");
    if (symbolOrders.length > 0) {
      try {
        const canceled = await deps.cancelAllOpenOrders(symbol);
        for (const order of canceled.length > 0 ? canceled : symbolOrders) {
          canceledOrderIds.push(order.clientOrderId);
          const intent = findByClientOrderId(order.clientOrderId, profile);
          if (intent && !["FILLED", "REJECTED", "EXPIRED"].includes(intent.status)) {
            updateIntent(order.clientOrderId, { status: "CANCELED", exchangeOrderId: order.orderId, lastState: JSON.stringify({ source: "emergency_flatten" }) }, Date.now(), profile);
          }
          markOrderCanceled(order.clientOrderId);
          deps.emit?.("order-update", { clientOrderId: order.clientOrderId, status: "CANCELED", kind: "order" });
        }
        audit("operator", "emergency.orders.cancelled", { accountId, triggeredBy, symbol, count: canceled.length });
      } catch (err) {
        failures.push({ action: "cancel_orders", symbol, error: String(err) });
        audit("operator", "emergency.flatten.failure", { accountId, triggeredBy, action: "cancel_orders", symbol, error: String(err) });
      }
    }

    let attempt: AlgoCancelAttempt;
    try {
      attempt = await attemptAlgoCancel(symbol, deps);
    } catch (err) {
      attempt = { seen: [], remaining: [], error: String(err) };
    }
    attempts.set(symbol, attempt);
    if (attempt.error) {
      failures.push({ action: "cancel_algo_orders", symbol, error: attempt.error });
      audit("operator", "emergency.flatten.failure", { accountId, triggeredBy, action: "cancel_algo_orders", symbol, error: attempt.error });
      continue;
    }
    for (const order of attempt.seen) {
      canceledOrderIds.push(order.clientAlgoId);
      const intent = findByClientOrderId(order.clientAlgoId, profile);
      if (intent && !["FILLED", "REJECTED", "EXPIRED"].includes(intent.status)) {
        updateIntent(order.clientAlgoId, { status: "CANCELED", lastState: JSON.stringify({ source: "emergency_flatten", kind: "algo" }) }, Date.now(), profile);
      }
      markOrderCanceled(order.clientAlgoId);
      deps.emit?.("order-update", { clientOrderId: order.clientAlgoId, status: "CANCELED", kind: "algo" });
    }
    deleteProtectionIntent(symbol, profile);
    audit("operator", "emergency.algo_orders.cancelled", { accountId, triggeredBy, symbol, count: attempt.seen.length });
  }
  return attempts;
}

/** One cancel round: list, cancel all conditional orders, then verify. */
async function attemptAlgoCancel(symbol: string, deps: EmergencyFlattenDeps): Promise<AlgoCancelAttempt> {
  const seen = await deps.getOpenAlgoOrders(symbol);
  if (seen.length === 0) return { seen, remaining: [], error: null };
  let error: string | null = null;
  try {
    await deps.cancelAllAlgoOrders(symbol);
  } catch (err) {
    error = String(err);
  }
  let remaining: EmergencyAlgoOrder[];
  try {
    remaining = await deps.getOpenAlgoOrders(symbol);
  } catch (err) {
    const detail = `verification failed: ${String(err)}`;
    return { seen, remaining: seen, error: error ? `${error}; ${detail}` : detail };
  }
  if (remaining.length > 0) {
    const detail = `Conditional orders remain open: ${remaining.map((order) => order.clientAlgoId).join(", ")}`;
    error = error ? `${error}; ${detail}` : detail;
  }
  return { seen, remaining, error };
}

async function closeOpenPositions(
  accountId: string,
  deps: EmergencyFlattenDeps,
  triggeredBy: string,
  positions: EmergencyPosition[],
  closedPositions: Array<{ symbol: string; result: OrderResult }>,
  failures: EmergencyFlattenFailure[],
  profile: PersistenceProfile,
): Promise<Set<string>> {
  assertPersistenceProfile(profile);
  const closedSymbols = new Set<string>();
  for (const position of positions) {
    try {
      const result = await deps.closePosition(position.symbol, position.positionAmt);
      closedPositions.push({ symbol: position.symbol, result });
      if (result.ok) {
        closedSymbols.add(position.symbol);
        deleteProtectionIntent(position.symbol, profile);
      }
      if (!result.ok && result.status !== "NO_POSITION") {
        failures.push({ action: "close_position", symbol: position.symbol, error: result.error ?? "close rejected" });
      }
      audit("operator", result.ok ? "emergency.position.close_submitted" : "emergency.flatten.failure", {
        accountId,
        triggeredBy,
        symbol: position.symbol,
        clientOrderId: result.clientOrderId,
        status: result.status,
        error: result.error,
      });
    } catch (err) {
      failures.push({ action: "close_position", symbol: position.symbol, error: String(err) });
      audit("operator", "emergency.flatten.failure", { accountId, triggeredBy, action: "close_position", symbol: position.symbol, error: String(err) });
    }
  }
  return closedSymbols;
}

/**
 * One retry after the close. Symbols whose conditional orders survived are
 * reported, alerted and returned so the operator sees them instead of a
 * "flatten complete" that hides live exit orders.
 */
async function retryAlgoCancels(
  accountId: string,
  deps: EmergencyFlattenDeps,
  triggeredBy: string,
  attempts: Map<string, AlgoCancelAttempt>,
  closedSymbols: Set<string>,
  canceledOrderIds: string[],
  failures: EmergencyFlattenFailure[],
  profile: PersistenceProfile,
): Promise<Array<{ symbol: string; clientAlgoId: string }>> {
  assertPersistenceProfile(profile);
  const remainingAlgoOrders: Array<{ symbol: string; clientAlgoId: string }> = [];
  for (const [symbol, first] of attempts) {
    if (first.error === null && first.remaining.length === 0) continue;
    let retry: AlgoCancelAttempt;
    try {
      retry = await attemptAlgoCancel(symbol, deps);
    } catch (err) {
      retry = { seen: [], remaining: [], error: String(err) };
    }
    if (retry.remaining.length === 0) {
      for (const order of retry.seen) {
        canceledOrderIds.push(order.clientAlgoId);
        const intent = findByClientOrderId(order.clientAlgoId, profile);
        if (intent && !["FILLED", "REJECTED", "EXPIRED"].includes(intent.status)) {
          updateIntent(order.clientAlgoId, { status: "CANCELED", lastState: JSON.stringify({ source: "emergency_flatten_retry", kind: "algo" }) }, Date.now(), profile);
        }
        markOrderCanceled(order.clientAlgoId);
        deps.emit?.("order-update", { clientOrderId: order.clientAlgoId, status: "CANCELED", kind: "algo" });
      }
      deleteProtectionIntent(symbol, profile);
      audit("operator", "emergency.algo_orders.cancelled_on_retry", { accountId, triggeredBy, symbol, count: retry.seen.length });
      continue;
    }
    const detail = retry.error ?? "Conditional orders remain open";
    failures.push({ action: "verify_algo_orders", symbol, error: detail });
    for (const order of retry.remaining) remainingAlgoOrders.push({ symbol, clientAlgoId: order.clientAlgoId });
    audit("operator", "emergency.flatten.failure", {
      accountId,
      triggeredBy,
      action: "verify_algo_orders",
      symbol,
      error: detail,
      severity: "high",
    });
    const protective = retry.remaining.filter((order) => order.closePosition !== false);
    if (closedSymbols.has(symbol) && protective.length > 0) {
      const payload = {
        symbol,
        clientAlgoIds: protective.map((order) => order.clientAlgoId),
        error: detail,
        severity: "high",
      };
      audit("operator", "emergency.position.close_with_remaining_algo_orders", { accountId, triggeredBy, ...payload });
      alert(`emergency_algo_orders_remaining:${symbol}`, payload);
    }
  }
  return remainingAlgoOrders;
}

export function resetEmergencyForTests(): void {
  inFlight.clear();
}

function markOrderCanceled(clientOrderId: string): void {
  const order = liveState().orders.get(clientOrderId);
  if (!order) return;
  const canceled = { ...order, status: "CANCELED", updateTime: Date.now() };
  liveState().orders.set(clientOrderId, canceled);
  liveState().openOrders.delete(clientOrderId);
}
