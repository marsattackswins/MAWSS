import "server-only";

import { getDb } from "../db/connection";
import { serverConfig } from "../env/config";
import { redactJson } from "../audit/redact";
import { setHealthSignal } from "../health/state";
import { log } from "../log/logger";
import {
  findActiveIntents,
  findByExchangeOrderId,
  intentsInUncertainStates,
  updateIntent,
  type IntentStatus,
  type OrderIntent,
} from "./intents";
import { BinanceApiError, ERR_UNKNOWN_ORDER, type BinanceRestClient } from "./rest";
import { fillExists, liveState, persistFill, rememberFill, type LiveFill } from "./state";
import { isTerminalStatus } from "./types";
import { getReconciliationBreaker } from "../resilience/breakers";
import { withRiskMutation } from "./mutation-queue";
import { trackReconRun, updateTradingGauges } from "../metrics/instrument";
import { eq, parseDec } from "./decimal";
import { audit } from "../audit/log";
import { alert } from "../alerts/dispatch";
import { publishLive } from "./sse";
import {
  deleteProtectionIntent,
  isProtectionIntentLocked,
  listProtectionIntents,
  markProtectionRestoreAttempted,
  setProtectionStatus,
  type ProtectionIntent,
} from "./protection";
import {
  activePersistenceProfile,
  assertPersistenceProfile,
  type PersistenceProfile,
} from "../profile/context";

export interface ReconResult {
  result: "ok" | "drift" | "error";
  diffs: string[];
  startedAt: number;
  finishedAt: number;
}

export interface ReconDeps {
  persistenceProfile?: PersistenceProfile;
  rest: BinanceRestClient;
  /** Pulls account/positions/openOrders truth from the exchange into state. */
  snapshot(): Promise<void>;
  freeze(reason: string): void;
  /** Lifts a recon/uncertainty freeze only if the caller confirms it is safe. */
  unfreeze(): void;
  /** Rejects callbacks from a manager generation that is no longer current. */
  isCurrent?: () => boolean;
  /** Called once for a persisted protection intent that has no matching order. */
  restoreProtection?(intent: ProtectionIntent): Promise<unknown>;
}

const UNCERTAIN = new Set(["CANCEL_REQUESTED", "CANCEL_UNKNOWN", "TIMEOUT_UNKNOWN", "UNCERTAIN", "SUBMITTING", "CREATED"]);

/**
 * Backfill window when a symbol has no persisted anchor. Configurable via
 * MAWS_HISTORY_BACKFILL_MS (default 3 days) — it must comfortably exceed the
 * observed 24h-fixed window so positions opened before a restart hydrate.
 */
const DEFAULT_BACKFILL_MS = serverConfig().historyBackfillMs;

/** Binance /fapi/v1/userTrades rejects (endTime − startTime) > 7 days with -4165. */
export const USER_TRADES_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Safety cap on backfill chunks (~182 days); wider anchors are clamped, not errored. */
export const USER_TRADES_MAX_CHUNKS = 26;

export interface UserTradesWindow {
  start: number;
  end: number;
}

/**
 * Splits a lookback range into sequential userTrades windows of at most 7
 * days each. Binance treats startTime and endTime as INCLUSIVE, so chunk k
 * ends at chunk k+1's start minus 1ms: no trade is duplicated or skipped at
 * a boundary. A range within the limit stays a single unchanged request;
 * a range so wide it exceeds maxChunks is clamped from the left (recent
 * history wins) rather than silently issuing an invalid interval.
 */
export function chunkUserTradeWindows(
  startTime: number,
  endTime: number,
  maxChunks = USER_TRADES_MAX_CHUNKS,
): UserTradesWindow[] {
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) return [];
  const span = endTime - startTime;
  if (span <= USER_TRADES_MAX_WINDOW_MS) return [{ start: startTime, end: endTime }];
  let count = Math.ceil(span / USER_TRADES_MAX_WINDOW_MS);
  let effectiveStart = startTime;
  if (count > maxChunks) {
    count = maxChunks;
    effectiveStart = endTime - count * USER_TRADES_MAX_WINDOW_MS;
  }
  const windows: UserTradesWindow[] = [];
  for (let i = 0; i < count; i++) {
    const start = effectiveStart + i * USER_TRADES_MAX_WINDOW_MS;
    // The final window closes exactly at endTime so the range is fully
    // covered even when the span is an exact multiple of 7 days.
    const end = i === count - 1 ? endTime : Math.min(start + USER_TRADES_MAX_WINDOW_MS - 1, endTime);
    windows.push({ start, end });
  }
  return windows;
}

/**
 * Settlement of record: exchange REST truth vs. persisted intents and local
 * state. Any mismatch freezes submissions until resolved.
 */
export class Reconciler {
  private readonly persistenceProfile: PersistenceProfile;

  constructor(private readonly deps: ReconDeps) {
    this.persistenceProfile = deps.persistenceProfile ?? activePersistenceProfile();
    assertPersistenceProfile(this.persistenceProfile);
  }

  private isCurrent(): boolean {
    return this.deps.isCurrent?.() ?? true;
  }

  private cancelled(): ReconResult {
    const now = Date.now();
    return { result: "error", diffs: [], startedAt: now, finishedAt: now };
  }

  async run(trigger: string): Promise<ReconResult> {
    return withRiskMutation(() => this.runSerialized(trigger));
  }

  private async runSerialized(trigger: string): Promise<ReconResult> {
    const breaker = getReconciliationBreaker();
    const startedAt = Date.now();
    if (!this.isCurrent()) return this.cancelled();
    try {
      const result = await breaker.execute(() => this.runUnprotected(trigger));
      if (!this.isCurrent()) return result;
      // The legacy reconciliation body returns an error result so it can
      // persist diagnostics. Convert that result into a breaker failure too.
      if (result.result === "error") {
        try {
          await breaker.execute(async () => {
            throw new Error(result.diffs.join("; ") || "reconciliation failed");
          });
        } catch {
          // The original result is the operator-facing response.
        }
      }
      trackReconRun(trigger, result.result, Date.now() - startedAt);
      updateTradingGauges();
      return result;
    } catch (err) {
      if (!this.isCurrent()) return this.cancelled();
      const finishedAt = Date.now();
      const result: ReconResult = { result: "error", diffs: [String(err)], startedAt: finishedAt, finishedAt };
      this.deps.freeze("reconciliation circuit is open or failed to start");
      assertPersistenceProfile(this.persistenceProfile);
      getDb()
        .prepare(`INSERT INTO reconciliation_runs (profile_id, started_at, finished_at, trigger, result, details) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(this.persistenceProfile.id, finishedAt, finishedAt, trigger, result.result, redactJson({ diffs: result.diffs }));
      setLastRecon({ lastRunAt: finishedAt, lastResult: result.result, driftCount: 0 });
      trackReconRun(trigger, result.result, Date.now() - startedAt);
      updateTradingGauges();
      log.error("reconciliation circuit blocked run", { trigger, error: String(err) });
      return result;
    }
  }

  private async runUnprotected(trigger: string): Promise<ReconResult> {
    const startedAt = Date.now();
    const diffs: string[] = [];
    let result: ReconResult["result"] = "ok";
    let positionSnapshotFresh = false;
    try {
      if (!this.isCurrent()) return this.cancelled();
      await this.deps.snapshot();
      positionSnapshotFresh = true;
      if (!this.isCurrent()) return this.cancelled();
      await this.backfillMissedFills(diffs);
      if (!this.isCurrent()) return this.cancelled();

      const openOrders = liveState().openOrders;
      const intentSync = await this.reconcileActiveIntents(openOrders, diffs);
      if (!this.isCurrent()) return this.cancelled();
      result = intentSync.result;
      if (positionSnapshotFresh) await this.reconcileProtectionIntents();
      if (!this.isCurrent()) return this.cancelled();

      for (const o of openOrders.values()) {
        if (!intentSync.seenClientIds.has(o.clientOrderId)) {
          result = "drift";
          diffs.push(`open order ${o.clientOrderId} (${o.symbol} ${o.type}) exists on exchange without an intent`);
        }
      }

      if (!this.isCurrent()) return this.cancelled();
      if (result === "drift") {
        this.deps.freeze(`reconciliation drift: ${diffs.join("; ").slice(0, 300)}`);
      } else {
        this.deps.unfreeze();
      }
    } catch (err) {
      if (!this.isCurrent()) return this.cancelled();
      result = "error";
      diffs.push(String(err));
      this.deps.freeze("reconciliation failed to complete");
      log.error("reconciliation error", { trigger, error: String(err) });
    }
    if (!this.isCurrent()) return this.cancelled();
    const finishedAt = Date.now();
    assertPersistenceProfile(this.persistenceProfile);
    getDb()
      .prepare(
        `INSERT INTO reconciliation_runs (profile_id, started_at, finished_at, trigger, result, details) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(this.persistenceProfile.id, startedAt, finishedAt, trigger, result, redactJson({ diffs }));
    setLastRecon({ lastRunAt: finishedAt, lastResult: result, driftCount: result === "drift" ? 1 : 0 });
    return { result, diffs, startedAt, finishedAt };
  }

  private async reconcileProtectionIntents(): Promise<void> {
    for (const intent of listProtectionIntents(this.persistenceProfile)) {
      if (!this.isCurrent()) return;
      if (isProtectionIntentLocked(intent.symbol, this.persistenceProfile)) continue;
      if (!liveState().positions.has(intent.symbol)) {
        deleteProtectionIntent(intent.symbol, this.persistenceProfile);
        continue;
      }

      const position = liveState().positions.get(intent.symbol)!;
      if (position.side !== intent.side) {
        deleteProtectionIntent(intent.symbol, this.persistenceProfile);
        const reason = `Protection intent side ${intent.side} does not match live position side ${position.side}`;
        audit("operator", "position.protection.intent_side_mismatch", {
          symbol: intent.symbol,
          intentSide: intent.side,
          positionSide: position.side,
        }, undefined, this.persistenceProfile);
        alert(`position_protection_intent_side_mismatch:${intent.symbol}`, {
          symbol: intent.symbol,
          intentSide: intent.side,
          positionSide: position.side,
          severity: "high",
        });
        continue;
      }
      if (
        intent.status === "CONFIRMED" &&
        intent.protectionStatus === "UNPROTECTED" &&
        intent.failureReason?.startsWith("Protection removal incomplete:")
      ) {
        continue;
      }
      const closeSide = position.side === "long" ? "SELL" : "BUY";
      const openOrders = [...liveState().openOrders.values()].filter(
        (order) => order.symbol === intent.symbol && order.side === closeSide && order.closePosition,
      );
      const tpPrice = intent.tpPrice;
      const slPrice = intent.slPrice;
      const tpMatches = tpPrice == null || openOrders.some(
        (order) => order.type === "TAKE_PROFIT_MARKET" && samePrice(order.stopPrice, tpPrice),
      );
      const slMatches = slPrice == null || openOrders.some(
        (order) => order.type === "STOP_MARKET" && samePrice(order.stopPrice, slPrice),
      );
      if (tpMatches && slMatches) {
        setProtectionStatus(intent.symbol, "PROTECTED", null, this.persistenceProfile);
        publishLive("account-update", { at: Date.now(), protection: intent.symbol, status: "PROTECTED" });
        continue;
      }

      const missing = [
        !tpMatches ? `TP ${intent.tpPrice}` : null,
        !slMatches ? `SL ${intent.slPrice}` : null,
      ].filter((part): part is string => part != null);
      const reason = `Recorded protection has no matching open order: ${missing.join(", ")}`;
      setProtectionStatus(intent.symbol, "UNPROTECTED", reason, this.persistenceProfile);
      publishLive("account-update", { at: Date.now(), protection: intent.symbol, status: "UNPROTECTED" });
      if (
        intent.protectionStatus !== "UNPROTECTED" ||
        (intent.status === "PENDING_REPLACE" && intent.failureReason === "Protection update in progress")
      ) {
        audit("operator", "position.protection.unprotected", { symbol: intent.symbol, reason }, undefined, this.persistenceProfile);
        alert(`position_unprotected:${intent.symbol}`, { symbol: intent.symbol, reason });
      }
      log.error("position protection missing during reconciliation", { symbol: intent.symbol, missing });

      if (intent.status !== "PENDING_REPLACE") continue;
      const ageMs = Date.now() - intent.createdAt;
      const maxAgeMs = serverConfig().protectionPendingMaxAgeMs;
      if (ageMs < 0 || ageMs > maxAgeMs) {
        const expiredReason = `Pending protection replacement expired after ${Math.max(0, ageMs)}ms; automatic restore limit is ${maxAgeMs}ms`;
        setProtectionStatus(intent.symbol, "UNPROTECTED", expiredReason, this.persistenceProfile);
        if (intent.failureReason !== expiredReason) {
          audit("operator", "position.protection.pending_restore_expired", { symbol: intent.symbol, ageMs, maxAgeMs }, undefined, this.persistenceProfile);
          alert(`position_protection_pending_expired:${intent.symbol}`, { symbol: intent.symbol, ageMs, maxAgeMs });
        }
        continue;
      }
      if (intent.restoreAttemptedAt >= intent.createdAt) continue;
      if (intentsInUncertainStates(this.persistenceProfile).some((order) => order.symbol === intent.symbol)) continue;
      if (!this.deps.restoreProtection) continue;
      markProtectionRestoreAttempted(intent.symbol, Date.now(), this.persistenceProfile);
      try {
        await this.deps.restoreProtection(intent);
      } catch (err) {
        const restoreError = `Protection restore attempt failed: ${String(err)}`;
        setProtectionStatus(intent.symbol, "UNPROTECTED", restoreError, this.persistenceProfile);
        audit("operator", "position.protection.restore_failed", { symbol: intent.symbol, error: String(err) }, undefined, this.persistenceProfile);
        alert(`position_protection_restore_failed:${intent.symbol}`, { symbol: intent.symbol, error: String(err) });
        log.error("position protection restore failed", { symbol: intent.symbol, error: String(err) });
      }
    }
  }

  /**
   * Algo intents live on a different endpoint than regular orders; querying
   * /fapi/v1/order for them always reports "unknown order" and would turn
   * every protection order into drift.
   */
  private async queryIntentExchangeState(intent: OrderIntent): Promise<IntentExchangeState | null> {
    if (intent.kind === "algo") {
      try {
        const order = await this.deps.rest.getAlgoOrder({
          clientAlgoId: intent.clientAlgoId ?? intent.clientOrderId,
        });
        return {
          status: order.algoStatus,
          executedQty: order.actualQty,
          exchangeOrderId: numericOrderId(order.actualOrderId),
        };
      } catch (err) {
        // -2013: never recorded, or aged out of the algo-history window.
        if (err instanceof BinanceApiError && err.code === ERR_UNKNOWN_ORDER) return null;
        throw err;
      }
    }
    const order = await this.deps.rest.getOrder(intent.symbol, undefined, intent.clientOrderId);
    return order
      ? { status: order.status, executedQty: order.executedQty, exchangeOrderId: order.orderId }
      : null;
  }

  private async reconcileActiveIntents(
    openOrders: ReadonlyMap<string, unknown>,
    diffs: string[],
  ): Promise<{ result: ReconResult["result"]; seenClientIds: Set<string> }> {
    let result: ReconResult["result"] = "ok";
    const seenClientIds = new Set<string>();

    for (const intent of findActiveIntents(this.persistenceProfile)) {
      if (!this.isCurrent()) return { result: "error", seenClientIds };
      seenClientIds.add(intent.clientOrderId);
      const state = await this.queryIntentExchangeState(intent);
      if (!this.isCurrent()) return { result: "error", seenClientIds };
      if (!state) {
        if (UNCERTAIN.has(intent.status)) {
          updateIntent(intent.clientOrderId, {
            status: "REJECTED",
            lastState: JSON.stringify({ resolvedBy: "reconciliation", note: "not_found_on_exchange" }),
          }, Date.now(), this.persistenceProfile);
          diffs.push(`intent ${intent.clientOrderId} not found on exchange; marked REJECTED`);
        } else {
          result = "drift";
          diffs.push(`intent ${intent.clientOrderId} believed ${intent.status} but exchange has no record`);
        }
        continue;
      }
      const mapped = mapExchangeStatus(state.status, intent.kind);
      // TRIGGERED keeps the intent SUBMITTED but reveals the actual order id;
      // link it so fills can still be attributed before FINISHED arrives.
      const linkedOrderId =
        state.exchangeOrderId != null && state.exchangeOrderId !== intent.exchangeOrderId
          ? state.exchangeOrderId
          : null;
      if (mapped !== intent.status || linkedOrderId != null) {
        updateIntent(intent.clientOrderId, {
          status: mapped,
          ...(linkedOrderId != null ? { exchangeOrderId: linkedOrderId } : {}),
          lastState: JSON.stringify({
            status: state.status,
            ...(state.executedQty != null ? { executedQty: state.executedQty } : {}),
            source: "reconciliation",
            kind: intent.kind,
          }),
        }, Date.now(), this.persistenceProfile);
        if (mapped !== intent.status) {
          diffs.push(`intent ${intent.clientOrderId} synced ${intent.status} -> ${mapped}`);
        }
      }
      if (expectsOpenOrder(intent.kind, state.status) && !openOrders.has(intent.clientOrderId)) {
        result = "drift";
        diffs.push(`exchange order ${intent.clientOrderId} is ${state.status} but missing from snapshot`);
      }
    }

    return { result, seenClientIds };
  }

  /**
   * REST user-trade history is the recovery path for fills missed while the
   * user stream was disconnected. The fills table's execution key makes this
   * safe to run on every reconciliation pass.
   */
  private async backfillMissedFills(diffs: string[]): Promise<void> {
    const now = Date.now();
    // Lookback: a symbol with persisted history starts from its earliest
    // record (the observed case of a position opened two days before startup
    // has no intent to anchor it, so the fallback window must cover it).
    // The window is configurable (MAWS_HISTORY_BACKFILL_MS, default 3 days —
    // Binance caps userTrades at 7-day windows anyway) and the request set is
    // symbol-scoped, so a fresh deploy does not sweep the whole account.
    const startBySymbol = new Map<string, number>();
    const intentRows = getDb()
      .prepare(`SELECT symbol, MIN(created_at) AS start_time FROM order_intents WHERE profile_id = ? GROUP BY symbol`)
      .all(this.persistenceProfile.id) as Array<{ symbol: string; start_time: number | null }>;
    for (const row of intentRows) {
      startBySymbol.set(row.symbol, row.start_time ?? now - DEFAULT_BACKFILL_MS);
    }
    for (const symbol of liveState().positions.keys()) {
      if (!startBySymbol.has(symbol)) startBySymbol.set(symbol, now - DEFAULT_BACKFILL_MS);
    }
    for (const order of liveState().orders.values()) {
      if (!startBySymbol.has(order.symbol)) startBySymbol.set(order.symbol, now - DEFAULT_BACKFILL_MS);
    }

    for (const [symbol, anchorStart] of startBySymbol) {
      if (!this.isCurrent()) return;
      // Binance caps userTrades at 7-day windows (-4165): split the anchor
      // range into sequential <=7d chunks. Anchors within the cap produce a
      // single unchanged request; over-wide legacy anchors are clamped.
      const windows = chunkUserTradeWindows(anchorStart, Math.max(now, anchorStart + 1));
      if (windows.length === 0) continue;
      if (windows.length > 1) {
        log.warn("userTrades backfill chunked to respect the 7-day API cap", { symbol, windows: windows.length });
      }
      let fromId: number | undefined;
      for (const window of windows) {
        // fromId takes precedence over the time window on Binance's side, so
        // it must be reset per window or the next window would re-fetch the
        // previous one and break before reaching its own trades.
        fromId = undefined;
        for (;;) {
          const trades = await this.deps.rest.getUserTrades(symbol, { startTime: window.start, endTime: window.end, limit: 1000, fromId });
          if (!this.isCurrent()) return;
          for (const trade of trades) {
            const liveOrder = [...liveState().orders.values()].find((order) => order.exchangeOrderId === trade.orderId);
            const intent = findByExchangeOrderId(trade.orderId, this.persistenceProfile);
            const fill: LiveFill = {
              tradeId: String(trade.id),
              ts: trade.time,
              exchangeOrderId: trade.orderId,
              clientOrderId: liveOrder?.clientOrderId ?? intent?.clientOrderId ?? "",
              symbol,
              side: trade.side === "SELL" ? "SELL" : "BUY",
              qty: trade.qty,
              price: trade.price,
              realizedPnl: trade.realizedPnl,
              source: "rest",
            };
            if (fillExists(fill.tradeId, this.persistenceProfile)) continue;
            if (!persistFill(fill, this.persistenceProfile)) continue;
            rememberFill(fill);
            diffs.push(`backfilled fill ${fill.tradeId} for ${symbol}`);
          }
          if (!this.isCurrent() || trades.length < 1000) break;
          const maxTradeId = Math.max(...trades.map((trade) => trade.id));
          if (!Number.isFinite(maxTradeId) || fromId === maxTradeId + 1) break;
          fromId = maxTradeId + 1;
        }
      }
    }
  }
}

function setLastRecon(patch: { lastRunAt: number; lastResult: "ok" | "drift" | "error"; driftCount: number }): void {
  setHealthSignal({ recon: { lastRunAt: patch.lastRunAt, lastResult: patch.lastResult, driftCount: patch.driftCount } });
}

interface IntentExchangeState {
  /** Raw exchange status: `status` for orders, `algoStatus` for algo orders. */
  status: string;
  executedQty?: string;
  /** Actual order id once an algo order triggered, otherwise the order id. */
  exchangeOrderId: number | null;
}

function mapExchangeStatus(status: string, kind: "order" | "algo"): IntentStatus {
  if (kind === "algo") {
    switch (status) {
      case "CANCELED":
        return "CANCELED";
      case "EXPIRED":
        return "EXPIRED";
      case "REJECTED":
        return "REJECTED";
      case "FINISHED":
        return "FILLED";
      case "PARTIALLY_FILLED":
        return "PARTIALLY_FILLED";
      default:
        // NEW, TRIGGERED and any future status: the conditional order (or the
        // actual order it created) still owns the outcome.
        return "SUBMITTED";
    }
  }
  switch (status) {
    case "FILLED":
      return "FILLED";
    case "CANCELED":
      return "CANCELED";
    case "EXPIRED":
      return "EXPIRED";
    case "REJECTED":
      return "REJECTED";
    case "PARTIALLY_FILLED":
      return "PARTIALLY_FILLED";
    default:
      return "SUBMITTED";
  }
}

/**
 * Algo orders are only open while NEW/PARTIALLY_FILLED. TRIGGERED means the
 * conditional order fired and left the open set; unknown future statuses are
 * tolerated as non-open rather than freezing reconciliation.
 */
function expectsOpenOrder(kind: "order" | "algo", status: string): boolean {
  if (kind === "algo") return status === "NEW" || status === "PARTIALLY_FILLED";
  return !isTerminalStatus(status);
}

function numericOrderId(value: number | string | null | undefined): number | null {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return null;
  return Number(value);
}

function samePrice(value: string | undefined, expected: string): boolean {
  if (!value) return false;
  try {
    return eq(parseDec(value), parseDec(expected));
  } catch {
    return false;
  }
}
