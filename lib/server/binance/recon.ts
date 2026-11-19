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
import type { FreezeCode } from "./freeze";
import { fillExists, isAlgoOrphanCleanupPending, isAlgoStateStale, isOrphanedAlgoOrder, liveState, persistFill, rememberFill, type LiveFill } from "./state";
import { cancelOrphanedClosePositionAlgos } from "./algo-orphans";
import { isTerminalStatus } from "./types";
import { getReconciliationBreaker } from "../resilience/breakers";
import { withRiskMutation } from "./mutation-queue";
import { trackReconRun, updateTradingGauges } from "../metrics/instrument";
import { eq, parseDec } from "./decimal";
import { audit } from "../audit/log";
import { alert } from "../alerts/dispatch";
import { publishLive } from "./sse";
import { deleteProtectionIntent,
  isProtectionIntentLocked,
  listProtectionIntents,
  markProtectionRestoreAttempted,
  setProtectionStatus,
  type ProtectionIntent, getProtectionIntent } from "./protection";
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
  freeze(reason: string, code?: FreezeCode): void;
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
 * Read lazily: module scope executes during `next build` route collection,
 * where no operator configuration exists.
 */
function defaultBackfillMs(): number {
  return serverConfig().historyBackfillMs;
}

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
      this.deps.freeze("reconciliation circuit is open or failed to start", "RECON_UNAVAILABLE");
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

      await this.cleanupOrphanedConditionalOrders(diffs);
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
        this.deps.freeze(`reconciliation drift: ${diffs.join("; ").slice(0, 300)}`, "RECON_DRIFT");
      } else {
        this.deps.unfreeze();
      }
    } catch (err) {
      if (!this.isCurrent()) return this.cancelled();
      result = "error";
      diffs.push(String(err));
      this.deps.freeze("reconciliation failed to complete", "RECON_FAILED");
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
      await checkPositionProtection(intent.symbol, {
        persistenceProfile: this.persistenceProfile,
        restoreProtection: this.deps.restoreProtection,
        isCurrent: () => this.isCurrent(),
      });
    }
  }

  /**
   * Algo intents live on a different endpoint than regular orders; querying
   * /fapi/v1/order for them always reports "unknown order" and would turn
   * every protection order into drift.
   */
  /**
   * A flat symbol keeps its untriggered closePosition leg (the TP when the SL
   * fills, the SL when the TP fills, either on liquidation) because Binance
   * only removes the leg that fired. Cancel exactly the ids the snapshot just
   * showed for that symbol; a new position's orders use new ids.
   */
  private async cleanupOrphanedConditionalOrders(diffs: string[]): Promise<void> {
    const candidates = new Map<string, string[]>();
    for (const order of liveState().openOrders.values()) {
      if (order.kind !== "algo" || !order.closePosition) continue;
      if (liveState().positions.has(order.symbol)) continue;
      const ids = candidates.get(order.symbol) ?? [];
      ids.push(order.clientOrderId);
      candidates.set(order.symbol, ids);
    }
    for (const [symbol, ids] of candidates) {
      if (!this.isCurrent()) return;
      const outcome = await cancelOrphanedClosePositionAlgos(symbol, ids, {
        getOpenAlgoOrders: (candidate) => this.deps.rest.getOpenAlgoOrders(candidate),
        cancelAlgoOrder: (clientAlgoId) => this.deps.rest.cancelAlgoOrder({ clientAlgoId }),
        isSymbolFlat: () => !liveState().positions.has(symbol),
        isCurrent: () => this.isCurrent(),
      }, this.persistenceProfile, "reconciliation");
      if (outcome.canceled.length > 0) {
        diffs.push(`cancelled ${outcome.canceled.length} orphaned conditional order(s) for flat ${symbol}`);
      }
      if (outcome.remaining.length > 0) {
        diffs.push(`orphaned conditional order(s) remain open for flat ${symbol}: ${outcome.remaining.join(", ")}`);
      }
    }
  }

  private async queryIntentExchangeState(intent: OrderIntent): Promise<IntentExchangeState | null> {
    if (intent.kind === "algo") {
      let order;
      try {
        order = await this.deps.rest.getAlgoOrder({
          clientAlgoId: intent.clientAlgoId ?? intent.clientOrderId,
        });
      } catch (err) {
        // -2013: never recorded, or aged out of the algo-history window.
        if (err instanceof BinanceApiError && err.code === ERR_UNKNOWN_ORDER) return null;
        throw err;
      }
      const actualOrderId = numericOrderId(order.actualOrderId);
      if (order.algoStatus === "TRIGGERED" || order.algoStatus === "FINISHED") {
        // TRIGGERED/FINISHED describe the conditional order, not the outcome.
        // The actual order it created is the settlement of record.
        const actual = actualOrderId != null
          ? await this.deps.rest.getOrder(intent.symbol, actualOrderId)
          : null;
        if (!actual) {
          return {
            status: order.algoStatus,
            statusKind: "algo",
            exchangeOrderId: actualOrderId,
            unresolvedActual: true,
          };
        }
        return {
          status: actual.status,
          statusKind: "order",
          executedQty: actual.executedQty,
          exchangeOrderId: actualOrderId,
        };
      }
      return {
        status: order.algoStatus,
        statusKind: "algo",
        executedQty: order.actualQty,
        exchangeOrderId: actualOrderId,
      };
    }
    const order = await this.deps.rest.getOrder(intent.symbol, undefined, intent.clientOrderId);
    return order
      ? { status: order.status, statusKind: "order", executedQty: order.executedQty, exchangeOrderId: order.orderId }
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
      if (state?.unresolvedActual) {
        // Never infer FILLED from a conditional status. Link the actual order
        // (when known) and let a later pass read its real outcome.
        if (state.exchangeOrderId != null && state.exchangeOrderId !== intent.exchangeOrderId) {
          updateIntent(intent.clientOrderId, {
            exchangeOrderId: state.exchangeOrderId,
            lastState: JSON.stringify({
              status: state.status,
              actualOrderId: state.exchangeOrderId,
              outcome: "pending",
              source: "reconciliation",
              kind: intent.kind,
            }),
          }, Date.now(), this.persistenceProfile);
        }
        diffs.push(`intent ${intent.clientOrderId} triggered but actual order outcome is not yet available`);
        continue;
      }
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
      const mapped = mapExchangeStatus(state.status, state.statusKind);
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
      if (expectsOpenOrder(state.statusKind, state.status) && !openOrders.has(intent.clientOrderId)) {
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
      startBySymbol.set(row.symbol, row.start_time ?? now - defaultBackfillMs());
    }
    for (const symbol of liveState().positions.keys()) {
      if (!startBySymbol.has(symbol)) startBySymbol.set(symbol, now - defaultBackfillMs());
    }
    for (const order of liveState().orders.values()) {
      if (!startBySymbol.has(order.symbol)) startBySymbol.set(order.symbol, now - defaultBackfillMs());
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

export interface ProtectionCheckDeps {
  persistenceProfile: PersistenceProfile;
  /** Omitted by callers that only classify protection (no restore attempts). */
  restoreProtection?(intent: ProtectionIntent): Promise<unknown>;
  isCurrent?(): boolean;
}

/**
 * Per-symbol protection check: claims PROTECTED, flags UNPROTECTED once and
 * runs the bounded pending-replace restore. Reconciliation calls it for every
 * intent; the live manager calls it right after a conditional-order refresh so
 * a TP/SL cancelled on the exchange is flagged within seconds instead of after
 * the next reconciliation interval.
 */
export async function checkPositionProtection(
  symbol: string,
  deps: ProtectionCheckDeps,
): Promise<void> {
  assertPersistenceProfile(deps.persistenceProfile);
  if (deps.isCurrent && !deps.isCurrent()) return;
  // A held protection lock means a replace is in flight; a stale conditional
  // view cannot prove protection. Neither may prune the intent.
  if (isProtectionIntentLocked(symbol, deps.persistenceProfile)) return;
  if (isAlgoStateStale(symbol) || isAlgoOrphanCleanupPending(symbol)) return;
  const intent = getProtectionIntent(symbol, deps.persistenceProfile);
  if (!intent) return;
  if (!liveState().positions.has(symbol)) {
    deleteProtectionIntent(symbol, deps.persistenceProfile);
    return;
  }

  const position = liveState().positions.get(symbol)!;
  if (position.side !== intent.side) {
    deleteProtectionIntent(symbol, deps.persistenceProfile);
    const reason = `Protection intent side ${intent.side} does not match live position side ${position.side}`;
    audit("operator", "position.protection.intent_side_mismatch", {
      symbol,
      intentSide: intent.side,
      positionSide: position.side,
    }, undefined, deps.persistenceProfile);
    alert(`position_protection_intent_side_mismatch:${symbol}`, {
      symbol,
      intentSide: intent.side,
      positionSide: position.side,
      severity: "high",
    });
    return;
  }
  if (
    intent.status === "CONFIRMED" &&
    intent.protectionStatus === "UNPROTECTED" &&
    intent.failureReason?.startsWith("Protection removal incomplete:")
  ) {
    return;
  }
  const closeSide = position.side === "long" ? "SELL" : "BUY";
  const openOrders = [...liveState().openOrders.values()].filter(
    (order) =>
      order.symbol === symbol &&
      order.side === closeSide &&
      order.closePosition &&
      !isOrphanedAlgoOrder(symbol, order.clientOrderId),
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
    setProtectionStatus(symbol, "PROTECTED", null, deps.persistenceProfile);
    publishLive("account-update", { at: Date.now(), protection: symbol, status: "PROTECTED" });
    return;
  }

  const missing = [
    !tpMatches ? `TP ${intent.tpPrice}` : null,
    !slMatches ? `SL ${intent.slPrice}` : null,
  ].filter((part): part is string => part != null);
  const reason = `Recorded protection has no matching open order: ${missing.join(", ")}`;
  setProtectionStatus(symbol, "UNPROTECTED", reason, deps.persistenceProfile);
  publishLive("account-update", { at: Date.now(), protection: symbol, status: "UNPROTECTED" });
  // One alert per transition: a symbol that is already UNPROTECTED (or a
  // replace that recorded its own pending state) is not re-alerted.
  if (
    intent.protectionStatus !== "UNPROTECTED" ||
    (intent.status === "PENDING_REPLACE" && intent.failureReason === "Protection update in progress")
  ) {
    audit("operator", "position.protection.unprotected", { symbol, reason }, undefined, deps.persistenceProfile);
    alert(`position_unprotected:${symbol}`, { symbol, reason });
  }
  log.error("position protection missing during reconciliation", { symbol, missing });

  if (intent.status !== "PENDING_REPLACE") return;
  const ageMs = Date.now() - intent.createdAt;
  const maxAgeMs = serverConfig().protectionPendingMaxAgeMs;
  if (ageMs < 0 || ageMs > maxAgeMs) {
    const expiredReason = `Pending protection replacement expired after ${Math.max(0, ageMs)}ms; automatic restore limit is ${maxAgeMs}ms`;
    setProtectionStatus(symbol, "UNPROTECTED", expiredReason, deps.persistenceProfile);
    if (intent.failureReason !== expiredReason) {
      audit("operator", "position.protection.pending_restore_expired", { symbol, ageMs, maxAgeMs }, undefined, deps.persistenceProfile);
      alert(`position_protection_pending_expired:${symbol}`, { symbol, ageMs, maxAgeMs });
    }
    return;
  }
  if (intent.restoreAttemptedAt >= intent.createdAt) return;
  if (intentsInUncertainStates(deps.persistenceProfile).some((order) => order.symbol === symbol)) return;
  if (!deps.restoreProtection) return;
  markProtectionRestoreAttempted(symbol, Date.now(), deps.persistenceProfile);
  try {
    await deps.restoreProtection(intent);
  } catch (err) {
    const restoreError = `Protection restore attempt failed: ${String(err)}`;
    setProtectionStatus(symbol, "UNPROTECTED", restoreError, deps.persistenceProfile);
    audit("operator", "position.protection.restore_failed", { symbol, error: String(err) }, undefined, deps.persistenceProfile);
    alert(`position_protection_restore_failed:${symbol}`, { symbol, error: String(err) });
    log.error("position protection restore failed", { symbol, error: String(err) });
  }
}


function setLastRecon(patch: { lastRunAt: number; lastResult: "ok" | "drift" | "error"; driftCount: number }): void {
  setHealthSignal({ recon: { lastRunAt: patch.lastRunAt, lastResult: patch.lastResult, driftCount: patch.driftCount } });
}

interface IntentExchangeState {
  /** Raw exchange status: `status` for orders, `algoStatus` for algo orders. */
  status: string;
  /** Which status vocabulary `status` belongs to. */
  statusKind: "order" | "algo";
  executedQty?: string;
  /** Actual order id once an algo order triggered, otherwise the order id. */
  exchangeOrderId: number | null;
  /** The trigger fired but the actual order could not be read yet. */
  unresolvedActual?: boolean;
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
      case "PARTIALLY_FILLED":
        return "PARTIALLY_FILLED";
      default:
        // NEW, TRIGGERED and any future status: the conditional order (or the
        // actual order it created) still owns the outcome. FINISHED is resolved
        // from the actual order before this mapping is used.
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
