import "server-only";

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

export interface EmergencyFlattenDeps {
  getOpenOrders(): Promise<BinanceOrder[]>;
  getOpenAlgoOrders(symbol: string): Promise<Array<{ clientAlgoId: string; symbol: string }>>;
  getOpenPositions(): Promise<EmergencyPosition[]>;
  cancelAllOpenOrders(symbol: string): Promise<BinanceOrder[]>;
  cancelAllAlgoOrders(symbol: string): Promise<unknown>;
  closePosition(symbol: string, positionAmt: string): Promise<OrderResult>;
  emit?(event: string, data: unknown): void;
}

export interface EmergencyFlattenFailure {
  action: "snapshot_orders" | "cancel_orders" | "cancel_algo_orders" | "close_position";
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

  const blockedSymbols = await cancelOpenOrders(
    accountId,
    deps,
    triggeredBy,
    openOrders,
    positions,
    canceledOrderIds,
    failures,
    profile,
  );
  await closeOpenPositions(accountId, deps, triggeredBy, positions, blockedSymbols, closedPositions, failures, profile);

  const finishedAt = Date.now();
  const summary = { accountId, triggeredBy, startedAt, finishedAt, canceledOrderIds, closedPositions, failures };
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
): Promise<Set<string>> {
  assertPersistenceProfile(profile);
  const symbols = [...new Set([
    ...openOrders.map((order) => order.symbol),
    ...positions.map((position) => position.symbol),
  ])];
  const blockedSymbols = new Set<string>();
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

    try {
      const algoOrders = await deps.getOpenAlgoOrders(symbol);
      if (algoOrders.length > 0) {
        await deps.cancelAllAlgoOrders(symbol);
        const remaining = await deps.getOpenAlgoOrders(symbol);
        if (remaining.length > 0) {
          throw new Error(`Conditional orders remain open: ${remaining.map((order) => order.clientAlgoId).join(", ")}`);
        }
        for (const order of algoOrders) {
          canceledOrderIds.push(order.clientAlgoId);
          const intent = findByClientOrderId(order.clientAlgoId, profile);
          if (intent && !["FILLED", "REJECTED", "EXPIRED"].includes(intent.status)) {
            updateIntent(order.clientAlgoId, { status: "CANCELED", lastState: JSON.stringify({ source: "emergency_flatten", kind: "algo" }) }, Date.now(), profile);
          }
          markOrderCanceled(order.clientAlgoId);
          deps.emit?.("order-update", { clientOrderId: order.clientAlgoId, status: "CANCELED", kind: "algo" });
        }
      }
      deleteProtectionIntent(symbol, profile);
      audit("operator", "emergency.algo_orders.cancelled", { accountId, triggeredBy, symbol, count: algoOrders.length });
    } catch (err) {
      blockedSymbols.add(symbol);
      failures.push({ action: "cancel_algo_orders", symbol, error: String(err) });
      audit("operator", "emergency.flatten.failure", { accountId, triggeredBy, action: "cancel_algo_orders", symbol, error: String(err) });
    }
  }
  return blockedSymbols;
}

async function closeOpenPositions(
  accountId: string,
  deps: EmergencyFlattenDeps,
  triggeredBy: string,
  positions: EmergencyPosition[],
  blockedSymbols: Set<string>,
  closedPositions: Array<{ symbol: string; result: OrderResult }>,
  failures: EmergencyFlattenFailure[],
  profile: PersistenceProfile,
): Promise<void> {
  assertPersistenceProfile(profile);
  for (const position of positions) {
    if (blockedSymbols.has(position.symbol)) continue;
    try {
      const result = await deps.closePosition(position.symbol, position.positionAmt);
      closedPositions.push({ symbol: position.symbol, result });
      if (result.ok) deleteProtectionIntent(position.symbol, profile);
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
