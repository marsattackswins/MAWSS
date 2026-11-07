import "server-only";

import crypto from "node:crypto";

import { abs, add, eq, gt, isNegative, isZero, lt, parseDec, roundDownToStep, toStr } from "./decimal";
import { applySymbolLeverage } from "./state";
import { audit } from "../audit/log";
import { requireEmergencyActionAllowed, requireSubmissionAllowed, SubmissionBlockedError } from "../gates/execution";
import type { EnvConfig } from "../env/config";
import {
  assertPersistenceProfile,
  persistenceProfileFromConfig,
  type PersistenceProfile,
} from "../profile/context";
import { log } from "../log/logger";
import {
  BinanceApiError,
  BinanceRestClient,
  classifyBinanceError,
  ERR_INVALID_API_KEY,
  ERR_ALGO_ORDER_REQUIRED,
  ERR_REDUCE_ONLY_REJECT,
  ERR_UNKNOWN_CANCEL,
  ERR_UNKNOWN_ORDER,
} from "./rest";
import { TransportTimeoutError } from "./transport";
import { CircuitBreakerOpenError } from "../resilience/circuit-breaker";
import type { SymbolConstraints } from "./filters";
import { validateAgainstConstraints, validateMarketQty } from "./filters";
import { checkRisk, type RiskSnapshot } from "./risk";
import { withRiskMutation } from "./mutation-queue";
import {
  createIntent as createIntentRecord,
  findByClientOrderId as findIntentByClientOrderId,
  intentsInUncertainStates as findUncertainIntents,
  updateIntent as updateIntentRecord,
  type OrderIntent,
} from "./intents";
import { liveState, rememberAlgoOrder, rememberOrder } from "./state";
import type { AlgoCancelAck, BinanceAlgoOrder, BinanceOrder, PlaceAlgoOrderParams, PositionRiskRow } from "./types";
import { trackOrderCanceled, trackOrderRejected, trackOrderSubmitted, trackOrderSubmissionDuration } from "../metrics/instrument";
import { normalMutationBlock } from "../profile/admission";
import { alert } from "../alerts/dispatch";
import {
  confirmProtectionIntent,
  deleteProtectionIntent,
  getProtectionIntent,
  markProtectionRestoreAttempted,
  revertProtectionIntent,
  savePendingProtectionIntent,
  saveProtectionIntent,
  setProtectionStatus,
  withProtectionIntentLock,
  type ProtectionIntent,
} from "./protection";

export interface SubmitOrderInput {
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";
  qty?: string;
  price?: string;
  stopPrice?: string;
  reduceOnly?: boolean;
  closePosition?: boolean;
  clientOrderId?: string;
  kind?: "order" | "algo";
  /** Internal emergency-close path; it still sends a normal MARKET order. */
  emergencyClose?: boolean;
  /**
   * Set by the position-close paths for both the reduce-only attempt and the
   * testnet-flag fallback. The quantity is the exchange's live position size,
   * so the order only flattens and must skip the new-exposure risk gate.
   */
  isClose?: boolean;
  /**
   * UI-selected leverage (1–125). When present, the exchange-side per-symbol
   * leverage is synced (POST /fapi/v1/leverage) before the order is placed so
   * Binance computes initial margin from the same sizing the UI used.
   */
  leverage?: number;
}

export interface ReversePositionInput {
  symbol: string;
  newQty: string;
  expectedPositionQty: string;
  expectedPositionSide: "long" | "short";
  clientOrderId: string;
}

export interface ReversePositionResult extends OrderResult {
  resultingPosition?: { side: "long" | "short"; qty: string } | null;
}

interface ReverseRiskEvaluation {
  snapshot: RiskSnapshot;
  qty: string;
  effectivePrice: string;
}

interface ReverseMarketContext {
  position: PositionRiskRow;
  currentSide: "long" | "short";
  currentQty: string;
  newQty: string;
  combinedQty: string;
  markPrice: string;
}

type ReversePreparation<T> = { ok: true; value: T } | { ok: false; error: string };
type ReverseSubmitAttempt =
  | { submitted: true; orderResult: OrderResult }
  | { submitted: false; result: ReversePositionResult };

export interface ReferencePrice {
  price: string;
  /** Wall-clock ms when this quote was observed. */
  at: number;
}

/** Fail closed: refuse submissions when the best available quote is older than this. */
export const STALE_REFERENCE_MS = 30_000;
export const PROTECTION_MARK_MAX_AGE_MS = 10_000;

type ProtectionReplaceResult = OrderResult & {
  rollbackRestored?: boolean;
  rollbackInvalid?: boolean;
  rollbackError?: string;
};

/**
 * Binance testnet occasionally rejects fully valid reduce-only closes with
 * -2022 REDUCE_ONLY_REJECT even in one-way mode with no open orders. The same
 * order without the flag is accepted; production honors the flag correctly.
 *
 * -2022 also has a legitimate meaning — an existing open order conflicting
 * with the close — so the fallback only fires when `verifySafeToFallback`
 * confirms the testnet-defect signature: no open orders AND the position
 * still matches the quantity/side that was read for the close. Otherwise the
 * original rejection is returned unchanged. The retry is safety-equivalent:
 * -2022 on HTTP 400 is a definite rejection (nothing executed), and the plain
 * order is verified to only flatten right before it is sent.
 */
function submitCloseWithReduceOnlyFallback(
  place: (reduceOnly: boolean) => Promise<OrderResult>,
  verifySafeToFallback: () => Promise<boolean>,
): Promise<OrderResult> {
  return (async () => {
    const first = await place(true);
    if (!(first.ok === false && first.errorCode === ERR_REDUCE_ONLY_REJECT)) return first;
    audit("operator", "order.close.reduce_only_rejected", { code: ERR_REDUCE_ONLY_REJECT });
    let safeToFallback = false;
    try {
      safeToFallback = await verifySafeToFallback();
    } catch {
      // Cannot verify exchange state: fail closed, keep the original rejection.
    }
    if (!safeToFallback) return first;
    const second = await place(false);
    audit("operator", "order.close.reduce_only_fallback", { clientOrderId: second.clientOrderId, ok: second.ok });
    return second;
  })();
}

export interface OrderResult {
  ok: boolean;
  clientOrderId: string;
  status?: string;
  exchangeOrderId?: number | null;
  algoId?: number;
  error?: string;
  /** Binance rejection code when the exchange refused the order (e.g. -2022). */
  errorCode?: number;
  failureKind?: "definite_rejection" | "transient_or_uncertain";
  rollbackError?: string;
  duplicate?: boolean;
}

export interface OrderServiceDeps {
  cfg: EnvConfig;
  persistenceProfile?: PersistenceProfile;
  rest: BinanceRestClient;
  getConstraints(symbol: string): SymbolConstraints | null;
  getReferencePrice(symbol: string): Promise<ReferencePrice | null>;
  /** Optional uncached mark-price fetch for protective-order validation. */
  getMarkPrice?(symbol: string): Promise<ReferencePrice | null>;
  getRiskSnapshot(): RiskSnapshot;
  /**
   * Must return an authoritative hypothetical post-flip risk snapshot.
   * `grossExposureUsd` and `openPositionCount` represent existing exposure
   * after removing the old position but before adding the new one;
   * unrealized P&L, margin ratio, and liquidation distances represent the
   * hypothetical resulting position. Missing means reverse is fail-closed.
   */
  projectReverseRisk?(input: {
    position: PositionRiskRow;
    newQty: string;
    price: string;
    current: RiskSnapshot;
  }): Promise<RiskSnapshot | null> | RiskSnapshot | null;
  freeze(reason: string): void;
  unfreeze?: () => void;
  emit(event: string, data: unknown): void;
  sleep?: (ms: number) => Promise<void>;
}

/** Binance newClientOrderId charset/length. */
export function newServerClientOrderId(prefix: string): string {
  const body = crypto.randomBytes(12).toString("hex");
  return `${prefix}${body}`.slice(0, 36);
}

export class OrderService {
  private readonly persistenceProfile: PersistenceProfile;

  constructor(private readonly deps: OrderServiceDeps) {
    this.persistenceProfile = deps.persistenceProfile ?? persistenceProfileFromConfig(deps.cfg);
    assertPersistenceProfile(this.persistenceProfile);
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? defaultSleep)(ms);
  }

  private async getOpenOrdersIncludingAlgos(symbol: string): Promise<BinanceOrder[]> {
    const [orders, algoOrders] = await Promise.all([
      this.deps.rest.getOpenOrders(symbol),
      this.deps.rest.getOpenAlgoOrders(symbol),
    ]);
    return [...orders, ...algoOrders.map(algoOrderAsBinanceOrder)];
  }

  private async cancelAlgoOrdersForClose(symbol: string, emergency: boolean): Promise<string | null> {
    const list = emergency
      ? this.deps.rest.getOpenAlgoOrdersEmergency.bind(this.deps.rest)
      : this.deps.rest.getOpenAlgoOrders.bind(this.deps.rest);
    const cancelAll = emergency
      ? this.deps.rest.cancelAllAlgoOrdersEmergency.bind(this.deps.rest)
      : this.deps.rest.cancelAllAlgoOrders.bind(this.deps.rest);
    const existing = await list(symbol);
    if (existing.length === 0) return null;
    await cancelAll(symbol);
    const remaining = await list(symbol);
    if (remaining.length > 0) {
      return `Conditional orders remain open for ${symbol}: ${remaining.map((order) => order.clientAlgoId).join(", ")}`;
    }
    for (const order of existing) {
      const intent = this.findIntent(order.clientAlgoId);
      const canceled = { ...order, algoStatus: "CANCELED" };
      if (intent) this.syncIntentFromAlgoOrder(order.clientAlgoId, canceled);
      else rememberAlgoOrder(canceled);
      this.deps.emit("order-update", { clientOrderId: order.clientAlgoId, status: "CANCELED", kind: "algo" });
    }
    deleteProtectionIntent(symbol, this.persistenceProfile);
    this.deps.emit("order-update", { symbol, status: "CANCELED", kind: "algo", source: emergency ? "emergency_close" : "close" });
    return null;
  }

  private async getFreshProtectionMark(symbol: string): Promise<ReferencePrice> {
    let reference: ReferencePrice | null = null;
    try {
      reference = this.deps.getMarkPrice
        ? await this.deps.getMarkPrice(symbol)
        : await this.deps.getReferencePrice(symbol);
    } catch {
      // Fall through to an uncached REST mark-price request.
    }
    if (
      reference &&
      Number.isFinite(Number(reference.price)) &&
      Number(reference.price) > 0 &&
      Date.now() - reference.at <= PROTECTION_MARK_MAX_AGE_MS
    ) {
      return reference;
    }

    const mark = await this.deps.rest.getMarkPrice(symbol);
    return { price: mark.markPrice, at: mark.time ?? Date.now() };
  }

  private protectionPriceError(
    side: "long" | "short",
    type: "TAKE_PROFIT_MARKET" | "STOP_MARKET",
    price: string,
    reference: ReferencePrice,
  ): string | null {
    try {
      const trigger = parseDec(price);
      const mark = parseDec(reference.price);
      if (isNegative(trigger) || isZero(trigger)) return "Trigger price must be greater than zero";
      if (eq(trigger, mark)) return `Trigger is immediately-triggering at mark ${reference.price}`;
      const isTakeProfit = type === "TAKE_PROFIT_MARKET";
      const beyond = isTakeProfit
        ? (side === "long" ? gt(trigger, mark) : lt(trigger, mark))
        : (side === "long" ? lt(trigger, mark) : gt(trigger, mark));
      if (beyond) return null;
      const label = type === "TAKE_PROFIT_MARKET" ? "TP" : "SL";
      const direction = isTakeProfit
        ? (side === "long" ? "above" : "below")
        : (side === "long" ? "below" : "above");
      return `${side === "long" ? "Long" : "Short"} ${label} must be strictly ${direction} the current mark ${reference.price}`;
    } catch {
      return "Trigger price must be a positive decimal";
    }
  }

  private findIntent(clientOrderId: string) {
    return findIntentByClientOrderId(clientOrderId, this.persistenceProfile);
  }

  private updateIntent(
    clientOrderId: string,
    patch: Partial<Pick<OrderIntent, "status" | "exchangeOrderId" | "lastState">>,
  ): void {
    updateIntentRecord(clientOrderId, patch, Date.now(), this.persistenceProfile);
  }

  private uncertainIntents() {
    return findUncertainIntents(this.persistenceProfile);
  }

  async submitOrder(input: SubmitOrderInput): Promise<OrderResult> {
    return withRiskMutation(() => this.submitOrderSerialized(input));
  }

  async reversePosition(input: ReversePositionInput): Promise<ReversePositionResult> {
    return withRiskMutation(() =>
      withProtectionIntentLock(
        input.symbol,
        () => this.reversePositionSerialized(input),
        this.persistenceProfile,
      ),
    );
  }

  private async reversePositionSerialized(input: ReversePositionInput): Promise<ReversePositionResult> {
    const reject = (error: string, extra: Partial<ReversePositionResult> = {}): ReversePositionResult => ({
      ok: false,
      clientOrderId: input.clientOrderId,
      error,
      ...extra,
    });
    if (this.findIntent(input.clientOrderId)) {
      return reject(`Duplicate clientOrderId ${input.clientOrderId}`, { duplicate: true });
    }
    const requestError = this.reverseRequestError(input);
    if (requestError) return reject(requestError);
    try {
      try {
        requireSubmissionAllowed(this.deps.cfg);
      } catch (error) {
        if (error instanceof SubmissionBlockedError) return reject(error.message);
        throw error;
      }
      const positionMode = await this.deps.rest.getPositionMode();
      if (positionMode.dualSidePosition) return reject("Reverse is supported only in verified one-way position mode");

      const market = await this.prepareReverseMarketContext(input);
      if (!market.ok) return reject(market.error, { resultingPosition: market.resultingPosition });
      const projection = await this.prepareReverseRisk(market.value);
      if (!projection.ok) return reject(projection.error);
      const submission = await this.submitReverseMarketOrder(input, market.value, projection.value);
      if (!submission.submitted) return submission.result;
      const reconciliation = await this.reconcileReversePosition(input, market.value, submission.orderResult);
      if (!reconciliation.ok) return reconciliation.result;
      return this.finishConfirmedReverse(input, market.value.currentSide, submission.orderResult, reconciliation.position);
    } catch (error) {
      if (error instanceof CircuitBreakerOpenError) {
        return reject("Reverse could not be verified because the exchange circuit breaker is open; no order was submitted");
      }
      throw error;
    }
  }

  private reverseRequestError(input: ReversePositionInput): string | null {
    if (!input.clientOrderId || input.clientOrderId.length > 36 || !/^[a-zA-Z0-9_-]+$/.test(input.clientOrderId)) {
      return "A valid clientOrderId (1-36 Binance-safe characters) is required";
    }
    if (this.uncertainIntents().some((intent) => intent.symbol === input.symbol)) {
      return `Reverse for ${input.symbol} is blocked while an order outcome remains uncertain`;
    }
    if (!this.deps.cfg.reverseEnabled) {
      return "Reverse is disabled. Close the position, then open the opposite side.";
    }
    return null;
  }

  private async prepareReverseMarketContext(
    input: ReversePositionInput,
  ): Promise<ReversePreparation<ReverseMarketContext> & { resultingPosition?: null }> {
    const rows = await this.deps.rest.getPositionRisk(input.symbol);
    const position = rows.find((row) => row.symbol === input.symbol && !isZero(parseDec(row.positionAmt)));
    if (!position) {
      return { ok: false, error: `No open position for ${input.symbol}`, resultingPosition: null };
    }
    const amount = parseDec(position.positionAmt);
    const currentSide = isNegative(amount) ? "short" : "long";
    const currentQty = toStr(abs(amount));
    let expectedQty: string;
    let newQty: string;
    try {
      expectedQty = toStr(abs(parseDec(input.expectedPositionQty)));
      newQty = toStr(parseDec(input.newQty));
    } catch {
      return { ok: false, error: "Position and new quantity must be valid decimals" };
    }
    if (
      currentSide !== input.expectedPositionSide ||
      !eq(amount, parseDec(input.expectedPositionSide === "short" ? `-${expectedQty}` : expectedQty))
    ) {
      return { ok: false, error: `Position changed since it was displayed (now ${currentSide} ${currentQty}); refresh and retry` };
    }
    if (isNegative(parseDec(newQty)) || isZero(parseDec(newQty))) {
      return { ok: false, error: "New position quantity must be greater than zero" };
    }

    const mark = await this.deps.rest.getMarkPrice(input.symbol);
    const markAge = Date.now() - (mark.time ?? 0);
    if (!Number.isFinite(Number(mark.markPrice)) || Number(mark.markPrice) <= 0 || markAge < 0 || markAge > 10_000) {
      return { ok: false, error: "Fresh mark price unavailable; reverse rejected before submission" };
    }
    const constraints = this.deps.getConstraints(input.symbol);
    if (!constraints) return { ok: false, error: `No exchange filter data for ${input.symbol}; metadata not ready` };
    const combinedQty = toStr(add(abs(amount), parseDec(newQty)));
    const filterErrors = [
      ...validateMarketQty(constraints, combinedQty, mark.markPrice),
      ...validateAgainstConstraints(constraints, { symbol: input.symbol, type: "MARKET", qty: combinedQty }),
    ];
    if (filterErrors.length > 0) return { ok: false, error: filterErrors.join("; ") };

    const leverage = Number(position.leverage);
    if (!Number.isFinite(leverage) || leverage < 1 || leverage > this.deps.cfg.risk.maxLeverage) {
      return {
        ok: false,
        error: `RISK_MAX_LEVERAGE: current leverage is unknown or exceeds the configured maximum (${this.deps.cfg.risk.maxLeverage}x)`,
      };
    }
    return {
      ok: true,
      value: { position, currentSide, currentQty, newQty, combinedQty, markPrice: mark.markPrice },
    };
  }

  private async prepareReverseRisk(
    market: ReverseMarketContext,
  ): Promise<ReversePreparation<RiskSnapshot>> {
    const projectReverseRisk = this.deps.projectReverseRisk;
    if (!projectReverseRisk) {
      return {
        ok: false,
        error: "Reverse is disabled: authoritative hypothetical post-flip margin and liquidation risk data is unavailable; close the position normally",
      };
    }
    const projection = await projectReverseRisk({
      position: market.position,
      newQty: market.newQty,
      price: market.markPrice,
      current: this.deps.getRiskSnapshot(),
    });
    if (!projection) {
      return {
        ok: false,
        error: "Reverse is disabled: authoritative hypothetical post-flip margin and liquidation risk data is unavailable; close the position normally",
      };
    }
    if (
      !Number.isFinite(projection.balanceUsd) ||
      projection.balanceUsd <= 0 ||
      !Number.isFinite(projection.grossExposureUsd) ||
      projection.grossExposureUsd < 0 ||
      !Number.isFinite(projection.openOrderCount) ||
      !Number.isInteger(projection.openOrderCount) ||
      projection.openOrderCount < 0 ||
      !Number.isFinite(projection.openPositionCount) ||
      !Number.isInteger(projection.openPositionCount) ||
      projection.openPositionCount < 0 ||
      !Number.isFinite(projection.openPositionCountAfterOrder) ||
      projection.openPositionCountAfterOrder == null ||
      !Number.isInteger(projection.openPositionCountAfterOrder) ||
      projection.openPositionCountAfterOrder < 1 ||
      !Number.isFinite(projection.realizedTodayUsd)
    ) {
      return { ok: false, error: "Reverse is disabled: hypothetical risk projection is incomplete; close the position normally" };
    }
    const errors = checkRisk(
      this.deps.cfg,
      projection,
      { type: "MARKET", qty: market.newQty, effectivePrice: market.markPrice, reduceOnly: false },
      market.markPrice,
    );
    if (errors.length > 0) return { ok: false, error: `${errors.join("; ")}. You can still close the position normally` };
    return { ok: true, value: projection };
  }

  private async submitReverseMarketOrder(
    input: ReversePositionInput,
    market: ReverseMarketContext,
    projection: RiskSnapshot,
  ): Promise<ReverseSubmitAttempt> {
    try {
      // This success path is tested with exchange fakes only. Keep the feature
      // disabled by default and unavailable in production until Testnet validation.
      const orderResult = await this.submitOrderSerialized({
        symbol: input.symbol,
        side: market.currentSide === "long" ? "SELL" : "BUY",
        type: "MARKET",
        qty: market.combinedQty,
        clientOrderId: input.clientOrderId,
      }, false, { snapshot: projection, qty: market.newQty, effectivePrice: market.markPrice }, true);
      return { submitted: true, orderResult };
    } catch (error) {
      if (!(error instanceof CircuitBreakerOpenError)) throw error;
      if (!this.findIntent(input.clientOrderId)) {
        return {
          submitted: false,
          result: {
            ok: false,
            clientOrderId: input.clientOrderId,
            error: "Reverse could not be submitted because the exchange circuit breaker is open",
          },
        };
      }
      this.markReverseUncertain(input.symbol, input.clientOrderId, "Circuit breaker opened during reverse submission; verify the exchange position before retrying");
      return {
        submitted: false,
        result: {
          ok: false,
          clientOrderId: input.clientOrderId,
          error: "Reverse outcome is uncertain because the exchange circuit breaker opened; submissions are frozen pending reconciliation",
        },
      };
    }
  }

  private async reconcileReversePosition(
    input: ReversePositionInput,
    market: ReverseMarketContext,
    orderResult: OrderResult,
  ): Promise<
    | { ok: true; position: { side: "long" | "short"; qty: string } }
    | { ok: false; result: ReversePositionResult }
  > {
    let after: PositionRiskRow | undefined;
    try {
      after = (await this.deps.rest.getPositionRisk(input.symbol)).find((row) => row.symbol === input.symbol);
    } catch (error) {
      this.markReverseUncertain(input.symbol, input.clientOrderId, `Unable to verify resulting position: ${String(error)}`);
      return {
        ok: false,
        result: {
          ...orderResult,
          ok: false,
          error: "Reverse submitted but the resulting position could not be verified; submissions are frozen pending reconciliation",
        },
      };
    }
    const afterAmount = after ? parseDec(after.positionAmt) : parseDec("0");
    const resultingPosition = !isZero(afterAmount)
      ? { side: isNegative(afterAmount) ? "short" as const : "long" as const, qty: toStr(abs(afterAmount)) }
      : null;
    if (
      orderResult.ok &&
      resultingPosition &&
      resultingPosition.side === (market.currentSide === "long" ? "short" : "long") &&
      eq(parseDec(resultingPosition.qty), parseDec(market.newQty))
    ) {
      return { ok: true, position: resultingPosition };
    }
    const unchanged = resultingPosition?.side === market.currentSide &&
      !!resultingPosition &&
      eq(parseDec(resultingPosition.qty), parseDec(market.currentQty));
    const uncertain = orderResult.failureKind === "transient_or_uncertain" || orderResult.ok || !unchanged;
    if (uncertain) {
      this.markReverseUncertain(input.symbol, input.clientOrderId, "Exchange result did not produce the requested exact reverse position");
    }
    audit("operator", "position.reverse.incomplete", {
      symbol: input.symbol,
      clientOrderId: input.clientOrderId,
      requested: { side: market.currentSide === "long" ? "short" : "long", qty: market.newQty },
      resultingPosition,
      error: orderResult.error,
    }, undefined, this.persistenceProfile);
    if (uncertain) {
      alert(`position_reverse_incomplete:${input.symbol}`, {
        symbol: input.symbol,
        clientOrderId: input.clientOrderId,
        resultingPosition,
        severity: "high",
      });
    }
    return {
      ok: false,
      result: {
        ...orderResult,
        ok: false,
        resultingPosition,
        error: orderResult.error ?? "Reverse did not produce the requested position; actual position is shown",
      },
    };
  }

  private async finishConfirmedReverse(
    input: ReversePositionInput,
    oldSide: "long" | "short",
    orderResult: OrderResult,
    resultingPosition: { side: "long" | "short"; qty: string },
  ): Promise<ReversePositionResult> {
    const closeSide = oldSide === "long" ? "SELL" : "BUY";
    let openOrders: BinanceOrder[];
    try {
      openOrders = await this.getOpenOrdersIncludingAlgos(input.symbol);
    } catch (error) {
      this.resetProtectionForReversedPosition(input.symbol, resultingPosition.side);
      const reason = `Reverse confirmed, but old protection could not be listed or canceled: ${String(error)}`;
      this.markProtectionUnprotected(input.symbol, reason);
      return { ...orderResult, ok: true, resultingPosition, error: reason };
    }
    const oldProtection = openOrders.filter((order) =>
      order.side === closeSide &&
      order.closePosition &&
      (order.type === "TAKE_PROFIT_MARKET" || order.type === "STOP_MARKET"),
    );
    const cancelFailures: string[] = [];
    for (const type of ["TAKE_PROFIT_MARKET", "STOP_MARKET"] as const) {
      const matching = oldProtection.filter((order) => order.type === type);
      if (matching.length === 0) continue;
      try {
        const error = await this.cancelProtectiveOrders(input.symbol, type, closeSide, matching);
        if (error) cancelFailures.push(error);
      } catch (error) {
        cancelFailures.push(String(error));
      }
    }
    this.resetProtectionForReversedPosition(input.symbol, resultingPosition.side);
    const reason = cancelFailures.length > 0
      ? `Reverse confirmed, but old protection cancellation was incomplete: ${cancelFailures.join("; ")}`
      : "Reverse confirmed; the new position needs TP/SL protection";
    this.markProtectionUnprotected(input.symbol, reason);
    return { ...orderResult, ok: true, resultingPosition, error: reason };
  }

  private resetProtectionForReversedPosition(symbol: string, side: "long" | "short"): void {
    deleteProtectionIntent(symbol, this.persistenceProfile);
    saveProtectionIntent({ symbol, side, tpPrice: null, slPrice: null }, Date.now(), this.persistenceProfile);
  }

  private markReverseUncertain(symbol: string, clientOrderId: string, reason: string): void {
    if (this.findIntent(clientOrderId)) this.updateIntent(clientOrderId, { status: "UNCERTAIN", lastState: uncertainState(clientOrderId, { reason }, this.persistenceProfile) });
    this.deps.freeze(`reverse position outcome uncertain for ${symbol}`);
    audit("operator", "position.reverse.uncertain", { symbol, clientOrderId, reason }, undefined, this.persistenceProfile);
    alert(`position_reverse_uncertain:${symbol}`, { symbol, clientOrderId, reason, severity: "high" });
  }

  /**
   * Returns a user-facing rejection when the optional leverage sync fails as
   * a definite business rejection; returns null when nothing needed syncing.
   * Transport/breaker failures propagate so timeouts surface as uncertain.
   */
  private async syncLeverage(input: SubmitOrderInput): Promise<string | null> {
    if (input.reduceOnly || input.closePosition || input.emergencyClose || input.isClose) return null;
    const leverage = normalizeLeverage(input.leverage);
    const currentLeverageValue =
      liveState().symbolLeverage.get(input.symbol) ??
      liveState().positions.get(input.symbol)?.leverage;
    const targetLeverage = leverage ?? (currentLeverageValue === undefined ? null : Number(currentLeverageValue));
    if (targetLeverage === null || !Number.isFinite(targetLeverage) || targetLeverage < 1) {
      return "RISK_MAX_LEVERAGE: current leverage is unknown; provide a leverage at or below the configured maximum";
    }
    if (targetLeverage > this.deps.cfg.risk.maxLeverage) {
      return `RISK_MAX_LEVERAGE: leverage ${targetLeverage}x exceeds max ${this.deps.cfg.risk.maxLeverage}x`;
    }
    // Only an absent value skips the sync. An explicit 1 must still be sent:
    // the exchange-side per-symbol setting persists whatever was last set, so
    // skipping 1x would margin the order at the stale value (the drift this
    // sync exists to prevent).
    if (leverage == null) return null;
    return syncLeverageToExchange(this.deps.rest, input.symbol, leverage);
  }

  private async submitOrderSerialized(
    input: SubmitOrderInput,
    protectionRecovery = false,
    reverseRisk?: ReverseRiskEvaluation,
    leverageAlreadyVerified = false,
  ): Promise<OrderResult> {
    const { cfg } = this.deps;
    const clientOrderId = input.clientOrderId ?? newServerClientOrderId(input.kind === "algo" ? "alg" : "ord");
    const blocked = normalMutationBlock();
    if (blocked && !input.emergencyClose) return { ok: false, clientOrderId, error: blocked };

    try {
      if (input.emergencyClose) requireEmergencyActionAllowed(cfg);
      else if (protectionRecovery) {
        const recoveryBlock = this.protectionRecoveryBlock(cfg, input.symbol);
        if (recoveryBlock) return { ok: false, clientOrderId, error: recoveryBlock };
      }
      else requireSubmissionAllowed(cfg);
    } catch (err) {
      if (err instanceof SubmissionBlockedError) {
        trackOrderRejected(clientOrderId, input.symbol, err.message);
        audit("operator", "order.blocked", { symbol: input.symbol, reasons: err.reasons, clientOrderId });
        return { ok: false, clientOrderId, error: err.message };
      }
      throw err;
    }

    const constraints = this.deps.getConstraints(input.symbol);
    if (!input.emergencyClose && !constraints) {
      return { ok: false, clientOrderId, error: `No exchange filter data for ${input.symbol}; metadata not ready` };
    }

    alignQtyToStep(input, constraints);

    const leverageError = leverageAlreadyVerified ? null : await this.syncLeverage(input);
    if (leverageError) {
      audit("operator", "order.rejected.leverage", { symbol: input.symbol, clientOrderId, error: leverageError });
      return { ok: false, clientOrderId, error: leverageError };
    }

    const validation = validateOrderInput(input, constraints);
    if (validation) {
      const msg = validation.errors.join("; ");
      if (validation.recordRejection) {
        trackOrderRejected(clientOrderId, input.symbol, msg);
        audit("operator", "order.rejected.validation", { symbol: input.symbol, clientOrderId, errors: validation.errors });
      }
      return { ok: false, clientOrderId, error: msg };
    }

    const reference = input.emergencyClose ? null : await this.deps.getReferencePrice(input.symbol);
    if (!input.emergencyClose && !reference) {
      audit("operator", "order.rejected.no_reference", { symbol: input.symbol, clientOrderId });
      return { ok: false, clientOrderId, error: "No reference price available to evaluate the order" };
    }
    const referenceAgeMs = reference ? Date.now() - reference.at : 0;
    if (!input.emergencyClose && referenceAgeMs > STALE_REFERENCE_MS) {
      audit("operator", "order.rejected.stale_data", { symbol: input.symbol, clientOrderId, ageMs: referenceAgeMs });
      return { ok: false, clientOrderId, error: "Market data is stale; order rejected until quotes refresh" };
    }
    const effectivePrice = input.price ?? input.stopPrice ?? reference?.price ?? "0";
    if (!input.closePosition && !input.emergencyClose && !input.reduceOnly && !input.isClose) {
      const riskErrors = checkRisk(
        cfg,
        reverseRisk?.snapshot ?? this.deps.getRiskSnapshot(),
        {
          type: input.type,
          qty: reverseRisk?.qty ?? input.qty ?? "0",
          effectivePrice: reverseRisk?.effectivePrice ?? effectivePrice,
          reduceOnly: !!input.reduceOnly,
        },
        reference!.price,
      );
      if (riskErrors.length > 0) {
        audit("operator", "order.rejected.risk", { symbol: input.symbol, clientOrderId, errors: riskErrors });
        return { ok: false, clientOrderId, error: riskErrors.join("; ") };
      }
    }

    const isAlgo = isConditionalOrder(input);
    const { intent, duplicate } = createIntentRecord({
      clientOrderId,
      clientAlgoId: isAlgo ? clientOrderId : undefined,
      kind: isAlgo ? "algo" : "order",
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      qty: input.closePosition ? "" : input.qty ?? "",
      price: input.price ?? null,
      stopPrice: input.stopPrice ?? null,
      reduceOnly: !!input.reduceOnly,
    }, Date.now(), this.persistenceProfile);
    if (duplicate) {
      return {
        ok: false,
        clientOrderId,
        duplicate: true,
        error: `Duplicate clientOrderId ${clientOrderId} (intent already ${intent.status})`,
      };
    }

    this.updateIntent(clientOrderId, { status: "SUBMITTING", lastState: JSON.stringify({ effectivePrice }) });
    audit("operator", "order.submitting", { symbol: input.symbol, type: input.type, side: input.side, clientOrderId });
    const submissionStartedAt = Date.now();

    try {
      if (isAlgo) {
        const order = await this.deps.rest.placeAlgoOrder(buildAlgoOrderParams(input, clientOrderId));
        this.syncIntentFromAlgoOrder(clientOrderId, order);
        trackOrderSubmissionDuration(Date.now() - submissionStartedAt);
        trackOrderSubmitted(clientOrderId, input.symbol, input.side, input.type);
        audit("operator", "order.submitted", {
          symbol: input.symbol,
          clientOrderId,
          clientAlgoId: order.clientAlgoId,
          algoId: order.algoId,
          status: order.algoStatus,
          kind: "algo",
        });
        this.deps.emit("order-update", { clientOrderId, status: order.algoStatus, kind: "algo" });
        return {
          ok: true,
          clientOrderId,
          status: order.algoStatus,
          exchangeOrderId: numericExchangeOrderId(order.actualOrderId),
          algoId: order.algoId,
        };
      }

      const params = buildOrderParams(input, clientOrderId);
      const order = input.emergencyClose
        ? await this.deps.rest.placeOrderEmergency(params)
        : await this.deps.rest.placeOrder(params);
      this.syncIntentFromOrder(clientOrderId, order);
      trackOrderSubmissionDuration(Date.now() - submissionStartedAt);
      trackOrderSubmitted(clientOrderId, input.symbol, input.side, input.type);

      audit("operator", "order.submitted", { symbol: input.symbol, clientOrderId, exchangeOrderId: order.orderId, status: order.status });
      this.deps.emit("order-update", { clientOrderId, status: order.status });
      return { ok: true, clientOrderId, status: order.status, exchangeOrderId: order.orderId };
    } catch (err) {
      trackOrderSubmissionDuration(Date.now() - submissionStartedAt);
      return this.handleSubmissionFailure(clientOrderId, input.symbol, err);
    }
  }

  private async handleSubmissionFailure(clientOrderId: string, symbol: string, err: unknown): Promise<OrderResult> {
    if (err instanceof BinanceApiError && err.httpStatus === 418) {
      const message = "Binance returned HTTP 418 and may have IP-banned this client; all Binance requests are paused until the ban expires";
      this.deps.freeze(message);
      this.updateIntent(clientOrderId, {
        status: "REJECTED",
        lastState: JSON.stringify({ code: err.code, httpStatus: err.httpStatus, retryAfterMs: err.retryAfterMs }),
      });
      audit("operator", "order.rejected.ip_ban", { symbol, clientOrderId, httpStatus: err.httpStatus, retryAfterMs: err.retryAfterMs, severity: "high" });
      alert("binance_ip_ban", { symbol, clientOrderId, httpStatus: err.httpStatus, retryAfterMs: err.retryAfterMs, severity: "high" });
      this.deps.emit("order-update", { clientOrderId, status: "REJECTED", error: message, severity: "high" });
      return {
        ok: false,
        clientOrderId,
        error: message,
        errorCode: err.code,
        failureKind: "transient_or_uncertain",
      };
    }
    if (classifyBinanceError(err) === "unknown_outcome") {
      this.updateIntent(clientOrderId, {
        status: "UNCERTAIN",
        lastState: uncertainState(clientOrderId, { code: (err as BinanceApiError).code, msg: (err as BinanceApiError).exchangeMsg, httpStatus: (err as BinanceApiError).httpStatus }, this.persistenceProfile),
      });
      this.deps.freeze("order submission returned HTTP 5xx; outcome must be verified");
      audit("operator", "order.unknown_outcome", { symbol, clientOrderId, httpStatus: (err as BinanceApiError).httpStatus });
      void this.resolveUnknownOutcome(clientOrderId);
      return {
        ok: false,
        clientOrderId,
        error: "Order submission returned an uncertain exchange response; outcome is being resolved",
        failureKind: "transient_or_uncertain",
      };
    }
    if (err instanceof BinanceApiError) {
      if (err.code === ERR_ALGO_ORDER_REQUIRED) {
        const message = "Binance rejected a conditional order with -4120; conditional orders must use the Algo Order API. Verify the configured endpoint and API permissions.";
        this.updateIntent(clientOrderId, { status: "REJECTED", lastState: JSON.stringify({ code: err.code, msg: err.exchangeMsg }) });
        trackOrderRejected(clientOrderId, symbol, message);
        audit("operator", "order.rejected.algo_api_configuration", {
          symbol,
          clientOrderId,
          code: err.code,
          severity: "high",
        });
        alert("binance_conditional_algo_api_rejected", {
          symbol,
          clientOrderId,
          code: err.code,
          severity: "high",
        });
        this.deps.emit("order-update", { clientOrderId, status: "REJECTED", error: message, severity: "high" });
        return {
          ok: false,
          clientOrderId,
          error: message,
          errorCode: err.code,
          failureKind: "definite_rejection",
        };
      }
      if (err.code === ERR_INVALID_API_KEY) {
        // Fail closed: a rejected key usually means wrong environment scope.
        this.deps.freeze("Binance rejected the API key (-2015); check environment/key scope");
        this.updateIntent(clientOrderId, { status: "REJECTED", lastState: JSON.stringify({ code: err.code }) });
        audit("operator", "order.rejected.key", { symbol, clientOrderId, code: err.code });
        return {
          ok: false,
          clientOrderId,
          error: "Exchange rejected the API key; submissions frozen",
          errorCode: err.code,
          failureKind: "definite_rejection",
        };
      }
      this.updateIntent(clientOrderId, { status: "REJECTED", lastState: JSON.stringify({ code: err.code, msg: err.exchangeMsg }) });
      trackOrderRejected(clientOrderId, symbol, err.exchangeMsg);
      audit("operator", "order.rejected.exchange", { symbol, clientOrderId, code: err.code, msg: err.exchangeMsg });
      this.deps.emit("order-update", { clientOrderId, status: "REJECTED", error: err.exchangeMsg });
      return {
        ok: false,
        clientOrderId,
        error: `Exchange rejected the order: ${err.exchangeMsg}`,
        errorCode: err.code,
        failureKind: "definite_rejection",
      };
    }
    if (err instanceof TransportTimeoutError) {
      // Unknown outcome: never retry blindly. Persist uncertainty, freeze, resolve.
      this.updateIntent(clientOrderId, { status: "TIMEOUT_UNKNOWN", lastState: uncertainState(clientOrderId, {}, this.persistenceProfile) });
      this.deps.freeze("submission timeout: order outcome unknown until resolved");
      audit("operator", "order.timeout_unknown", { symbol, clientOrderId });
      void this.resolveUnknownOutcome(clientOrderId);
      return {
        ok: false,
        clientOrderId,
        error: "Submission timed out; outcome is being resolved against the exchange",
        failureKind: "transient_or_uncertain",
      };
    }
    // Breaker state is propagated to the caller; all other transport failures
    // remain uncertain until a later exchange query proves the order absent.
    if (err instanceof CircuitBreakerOpenError) throw err;
    this.updateIntent(clientOrderId, { status: "UNCERTAIN", lastState: uncertainState(clientOrderId, { error: String(err) }, this.persistenceProfile) });
    this.deps.freeze("order submission transport failed; outcome must be verified");
    audit("operator", "order.unknown_outcome", { symbol, clientOrderId, error: String(err) });
    void this.resolveUnknownOutcome(clientOrderId);
    return {
      ok: false,
      clientOrderId,
      error: `Order submission outcome is uncertain: ${String(err)}`,
      failureKind: "transient_or_uncertain",
    };
  }

  /** Resolves TIMEOUT_UNKNOWN/CANCEL_UNKNOWN intents by querying exchange truth. */
  async resolveUnknownOutcome(clientOrderId: string, attempts = 3): Promise<void> {
    const intent = this.findIntent(clientOrderId);
    if (!intent) return;
    for (let i = 0; i < attempts; i++) {
      try {
        if (intent.kind === "algo") {
          try {
            const order = await this.deps.rest.getAlgoOrder({
              clientAlgoId: intent.clientAlgoId ?? clientOrderId,
            });
            this.syncIntentFromAlgoOrder(clientOrderId, order);
            audit("operator", "order.resolved", { clientOrderId, status: order.algoStatus, attempt: i + 1, kind: "algo" });
            this.deps.emit("order-update", { clientOrderId, status: order.algoStatus, resolved: true, kind: "algo" });
            this.maybeUnfreeze();
            return;
          } catch (err) {
            if (!(err instanceof BinanceApiError) || err.code !== ERR_UNKNOWN_ORDER) throw err;
            const openOrders = await this.deps.rest.getOpenAlgoOrders(intent.symbol);
            const openOrder = openOrders.find((order) => order.clientAlgoId === (intent.clientAlgoId ?? clientOrderId));
            if (openOrder) {
              this.syncIntentFromAlgoOrder(clientOrderId, openOrder);
              this.maybeUnfreeze();
              return;
            }
            if (i === attempts - 1) {
              this.updateIntent(clientOrderId, { status: "REJECTED", lastState: JSON.stringify({ resolved: "algo_not_found_on_exchange" }) });
              this.maybeUnfreeze();
              return;
            }
            await this.sleep(400 * (i + 1));
            continue;
          }
        }
        const order = await this.deps.rest.getOrder(intent.symbol, undefined, clientOrderId);
        if (order) {
          this.syncIntentFromOrder(clientOrderId, order);
          audit("operator", "order.resolved", { clientOrderId, status: order.status, attempt: i + 1 });
          this.deps.emit("order-update", { clientOrderId, status: order.status, resolved: true });
          this.maybeUnfreeze();
          return;
        }
        // -2013: exchange never recorded it (or it aged out).
        if (i === attempts - 1) {
          this.updateIntent(clientOrderId, { status: "REJECTED", lastState: JSON.stringify({ resolved: "not_found_on_exchange" }) });
          audit("operator", "order.resolved.not_found", { clientOrderId });
          this.deps.emit("order-update", { clientOrderId, status: "REJECTED", resolved: true });
          this.maybeUnfreeze();
          return;
        }
        await this.sleep(400 * (i + 1));
      } catch (err) {
        if (err instanceof BinanceApiError) {
          // A failed verification is itself uncertain. Never convert the
          // original mutation into a rejection without exchange truth.
          log.warn("resolveUnknownOutcome exchange query failed; leaving frozen", {
            clientOrderId,
            code: err.code,
            httpStatus: err.httpStatus,
            error: err.exchangeMsg,
          });
          return;
        }
        log.warn("resolveUnknownOutcome query failed; leaving to reconciliation", {
          clientOrderId,
          error: String(err),
        });
        return; // frozen; reconciliation will settle it.
      }
    }
  }

  private maybeUnfreeze(): void {
    if (this.uncertainIntents().length === 0) {
      this.deps.unfreeze?.();
      this.deps.emit("uncertainty-cleared", {});
    }
  }

  private syncIntentFromOrder(clientOrderId: string, order: BinanceOrder): void {
    rememberOrder(order);
    const status =
      order.status === "FILLED"
        ? "FILLED"
        : order.status === "CANCELED"
          ? "CANCELED"
          : order.status === "EXPIRED"
            ? "EXPIRED"
            : order.status === "REJECTED"
              ? "REJECTED"
              : order.status === "PARTIALLY_FILLED"
                ? "PARTIALLY_FILLED"
                : "SUBMITTED";
    this.updateIntent(clientOrderId, {
      status,
      exchangeOrderId: order.orderId,
      lastState: JSON.stringify({
        status: order.status,
        executedQty: order.executedQty,
        avgPrice: order.avgPrice ?? null,
        updateTime: order.updateTime,
      }),
    });
  }

  /**
   * DELETE /fapi/v1/algoOrder answers with an acknowledgement only. The order
   * is gone by definition, so record terminal state locally instead of reading
   * fields (algoStatus/triggerPrice) that the response does not contain.
   */
  private syncAlgoCancel(ack: AlgoCancelAck): void {
    const clientAlgoId = ack.clientAlgoId;
    if (!clientAlgoId) return;
    if (this.findIntent(clientAlgoId)) {
      this.updateIntent(clientAlgoId, {
        status: "CANCELED",
        lastState: JSON.stringify({
          kind: "algo",
          algoId: ack.algoId ?? null,
          clientAlgoId,
          canceled: true,
          code: ack.code ?? null,
          msg: ack.msg ?? null,
        }),
      });
    }
    const current = liveState().orders.get(clientAlgoId);
    if (current) {
      liveState().orders.set(clientAlgoId, { ...current, status: "CANCELED", updateTime: Date.now() });
    }
    liveState().openOrders.delete(clientAlgoId);
  }

  private syncIntentFromAlgoOrder(clientOrderId: string, order: BinanceAlgoOrder): void {
    rememberAlgoOrder(order);
    const status = normalizeAlgoStatus(order.algoStatus);
    this.updateIntent(clientOrderId, {
      status,
      lastState: JSON.stringify({
        kind: "algo",
        algoId: order.algoId,
        clientAlgoId: order.clientAlgoId,
        status: order.algoStatus,
        triggerPrice: order.triggerPrice,
        actualOrderId: order.actualOrderId ?? null,
        actualQty: order.actualQty ?? null,
        updateTime: order.updateTime,
      }),
    });
  }

  async cancelOrder(clientOrderId: string, symbol: string): Promise<OrderResult> {
    return withRiskMutation(() => this.cancelOrderSerialized(clientOrderId, symbol));
  }

  private async cancelOrderSerialized(clientOrderId: string, symbol: string): Promise<OrderResult> {
    const blocked = normalMutationBlock();
    if (blocked) return { ok: false, clientOrderId, error: blocked };
    const intent = this.findIntent(clientOrderId);
    if (!intent) {
      return { ok: false, clientOrderId, error: `No intent found for ${clientOrderId}` };
    }
    if (["FILLED", "CANCELED", "EXPIRED", "REJECTED"].includes(intent.status)) {
      return { ok: true, clientOrderId, status: intent.status, error: "already terminal" };
    }
    this.updateIntent(clientOrderId, { status: "CANCEL_REQUESTED" });
    audit("operator", "order.cancelling", { symbol, clientOrderId });
    try {
      if (intent.kind === "algo") {
        const ack = await this.deps.rest.cancelAlgoOrder({
          clientAlgoId: intent.clientAlgoId ?? clientOrderId,
        });
        this.syncAlgoCancel(ack);
        trackOrderCanceled(clientOrderId, symbol);
        audit("operator", "order.cancelled", { symbol, clientOrderId, status: "CANCELED", kind: "algo", algoId: ack.algoId });
        this.deps.emit("order-update", { clientOrderId, status: "CANCELED", kind: "algo" });
        return { ok: true, clientOrderId, status: "CANCELED", algoId: ack.algoId };
      }
      const order = await this.deps.rest.cancelOrder(symbol, undefined, clientOrderId);
      this.syncIntentFromOrder(clientOrderId, order);
      trackOrderCanceled(clientOrderId, symbol);
      audit("operator", "order.cancelled", { symbol, clientOrderId, status: order.status });
      this.deps.emit("order-update", { clientOrderId, status: order.status });
      return { ok: true, clientOrderId, status: order.status, exchangeOrderId: order.orderId };
    } catch (err) {
      if (classifyBinanceError(err) === "unknown_outcome") {
        this.updateIntent(clientOrderId, {
          status: "CANCEL_UNKNOWN",
          lastState: JSON.stringify({ code: (err as BinanceApiError).code, msg: (err as BinanceApiError).exchangeMsg, httpStatus: (err as BinanceApiError).httpStatus }),
        });
        this.deps.freeze("cancel returned HTTP 5xx; outcome must be verified");
        audit("operator", "order.cancel.unknown_outcome", { symbol, clientOrderId, httpStatus: (err as BinanceApiError).httpStatus });
        void this.resolveUnknownOutcome(clientOrderId);
        return { ok: false, clientOrderId, error: "Cancel returned an uncertain exchange response; outcome is being resolved" };
      }
      if (err instanceof BinanceApiError && err.code === ERR_UNKNOWN_CANCEL) {
        // The order vanished before our cancel: determine what actually happened.
        try {
          if (intent.kind === "algo") {
            try {
              const algoOrder = await this.deps.rest.getAlgoOrder({
                clientAlgoId: intent.clientAlgoId ?? clientOrderId,
              });
              this.syncIntentFromAlgoOrder(clientOrderId, algoOrder);
              audit("operator", "order.cancel.race_resolved", {
                symbol,
                clientOrderId,
                status: algoOrder.algoStatus,
                kind: "algo",
              });
              this.deps.emit("order-update", { clientOrderId, status: algoOrder.algoStatus, kind: "algo" });
              return { ok: true, clientOrderId, status: algoOrder.algoStatus, algoId: algoOrder.algoId };
            } catch (lookupError) {
              if (!(lookupError instanceof BinanceApiError) || lookupError.code !== ERR_UNKNOWN_ORDER) throw lookupError;
            }
            const openAlgoOrders = await this.deps.rest.getOpenAlgoOrders(symbol);
            if (openAlgoOrders.some((order) => order.clientAlgoId === (intent.clientAlgoId ?? clientOrderId))) {
              this.updateIntent(clientOrderId, { status: "SUBMITTED" });
              return { ok: false, clientOrderId, error: "Algo order is still open; cancellation was not confirmed" };
            }
            this.updateIntent(clientOrderId, { status: "RESOLVED", lastState: JSON.stringify({ note: "unknown_algo_cancel_not_found" }) });
            return { ok: true, clientOrderId, status: "RESOLVED" };
          }
          const order = await this.deps.rest.getOrder(symbol, undefined, clientOrderId);
          if (order) {
            this.syncIntentFromOrder(clientOrderId, order);
            audit("operator", "order.cancel.race_resolved", { symbol, clientOrderId, status: order.status });
            this.deps.emit("order-update", { clientOrderId, status: order.status });
            return { ok: true, clientOrderId, status: order.status, exchangeOrderId: order.orderId };
          }
          this.updateIntent(clientOrderId, { status: "RESOLVED", lastState: JSON.stringify({ note: "unknown_cancel_not_found" }) });
          return { ok: true, clientOrderId, status: "RESOLVED" };
        } catch {
          this.updateIntent(clientOrderId, { status: "CANCEL_UNKNOWN" });
          this.deps.freeze("cancel outcome unknown; resolving via reconciliation");
          return { ok: false, clientOrderId, error: "Cancel outcome unknown; frozen until reconciliation" };
        }
      }
      if (err instanceof TransportTimeoutError) {
        this.updateIntent(clientOrderId, { status: "CANCEL_UNKNOWN" });
        this.deps.freeze("cancel request timed out; outcome unknown");
        audit("operator", "order.cancel.timeout_unknown", { symbol, clientOrderId });
        void this.resolveUnknownOutcome(clientOrderId);
        return { ok: false, clientOrderId, error: "Cancel timed out; outcome is being resolved" };
      }
      // Infrastructure failure, not a business rejection: rethrow untouched so
      // runBrokerMutation can answer 503 circuit_open. Intent stays live.
      if (err instanceof CircuitBreakerOpenError) throw err;
      const msg = err instanceof BinanceApiError ? err.exchangeMsg : String(err);
      this.updateIntent(clientOrderId, { status: "SUBMITTED", lastState: JSON.stringify({ cancelError: msg }) });
      return { ok: false, clientOrderId, error: `Cancel failed: ${msg}` };
    }
  }

  /** Emergency-only close using exchange truth and bypassing normal submission gates. */
  async emergencyClosePosition(symbol: string, positionAmt?: string): Promise<OrderResult> {
    return withRiskMutation(async () => {
      const rows = positionAmt
        ? [{ symbol, positionAmt }]
        : await this.deps.rest.getPositionRiskEmergency(symbol);
      const row = rows.find((candidate) => candidate.symbol === symbol && !isZero(parseDec(candidate.positionAmt)));
      if (!row) return { ok: true, clientOrderId: "", status: "NO_POSITION" };
      try {
        // Existing protective/reduce-only orders can reserve the position size and
        // cause Binance to reject this close with -2022. Cancel them before the
        // reduce-only market order so closing also cannot leave stale exits behind.
        await this.deps.rest.cancelAllOpenOrdersEmergency(symbol);
        const algoCancelError = await this.cancelAlgoOrdersForClose(symbol, true);
        if (algoCancelError) {
          this.markProtectionUnprotected(symbol, algoCancelError);
          return { ok: false, clientOrderId: "", error: algoCancelError };
        }
      } catch (err) {
        if (err instanceof CircuitBreakerOpenError) throw err;
        const message = err instanceof BinanceApiError ? err.exchangeMsg : String(err);
        return { ok: false, clientOrderId: "", error: `Unable to cancel existing orders for ${symbol}: ${message}` };
      }

      const amount = parseDec(row.positionAmt);
      const short = isNegative(amount);
      const qty = short ? toStr({ units: -amount.units, scale: amount.scale }) : toStr(amount);
      const result = await submitCloseWithReduceOnlyFallback(
        (reduceOnly) =>
          this.submitOrderSerialized({
            symbol,
            side: short ? "BUY" : "SELL",
            type: "MARKET",
            qty,
            reduceOnly,
            emergencyClose: true,
            isClose: true,
            clientOrderId: newServerClientOrderId("em"),
          }),
        async () => {
          const [orders, rows] = await Promise.all([
            this.deps.rest.getOpenOrdersEmergency(symbol),
            this.deps.rest.getPositionRiskEmergency(symbol),
          ]);
          const row = rows.find((candidate) => candidate.symbol === symbol);
          return (
            orders.length === 0 &&
            row != null &&
            !isZero(parseDec(row.positionAmt)) &&
            isNegative(parseDec(row.positionAmt)) === short &&
            toStr(abs(parseDec(row.positionAmt))) === qty
          );
        },
      );
      if (result.ok) deleteProtectionIntent(symbol, this.persistenceProfile);
      return result;
    });
  }

  /** Reduce-only market close of the exchange's current position. */
  async closePosition(symbol: string): Promise<OrderResult> {
    // Emergency closes must not rely on a stale stream snapshot. If the
    // exchange cannot provide position truth, fail closed and send no order.
    let rows;
    try {
      rows = await this.deps.rest.getPositionRisk(symbol);
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) throw err;
      return { ok: false, clientOrderId: "", error: `Unable to verify position for ${symbol}: ${String(err)}` };
    }
    const row = rows.find((candidate) => candidate.symbol === symbol && !isZero(parseDec(candidate.positionAmt)));
    if (!row) return { ok: false, clientOrderId: "", error: `No open position for ${symbol}` };

    try {
      requireSubmissionAllowed(this.deps.cfg);
      const algoCancelError = await this.cancelAlgoOrdersForClose(symbol, false);
      if (algoCancelError) {
        this.markProtectionUnprotected(symbol, algoCancelError);
        return { ok: false, clientOrderId: "", error: algoCancelError };
      }
    } catch (err) {
      if (err instanceof SubmissionBlockedError) return { ok: false, clientOrderId: "", error: err.message };
      if (err instanceof CircuitBreakerOpenError) throw err;
      return { ok: false, clientOrderId: "", error: `Unable to cancel conditional orders for ${symbol}: ${String(err)}` };
    }

    const amount = parseDec(row.positionAmt);
    const short = isNegative(amount);
    const qty = short ? toStr({ units: -amount.units, scale: amount.scale }) : toStr(amount);
    // A normal UI close is still a live order submission. Only the explicit
    // emergency-flatten path may bypass the execution gates.
    const result = await submitCloseWithReduceOnlyFallback(
      (reduceOnly) =>
        this.submitOrder({
          symbol,
          side: short ? "BUY" : "SELL",
          type: "MARKET",
          qty,
          reduceOnly,
          isClose: true,
          clientOrderId: newServerClientOrderId("cls"),
        }),
      async () => {
        const [orders, rows] = await Promise.all([
          this.getOpenOrdersIncludingAlgos(symbol),
          this.deps.rest.getPositionRisk(symbol),
        ]);
        const row = rows.find((candidate) => candidate.symbol === symbol);
        return (
          orders.length === 0 &&
          row != null &&
          !isZero(parseDec(row.positionAmt)) &&
          isNegative(parseDec(row.positionAmt)) === short &&
          toStr(abs(parseDec(row.positionAmt))) === qty
        );
      },
    );
    if (result.ok) deleteProtectionIntent(symbol, this.persistenceProfile);
    return result;
  }

  /**
   * Native protective orders: TAKE_PROFIT_MARKET / STOP_MARKET with
   * closePosition=true. These are genuine exchange conditional orders —
   * never simulated in the browser. Replacing cancels the existing one first.
   */
  async protectPosition(input: { symbol: string; tpPrice?: string; slPrice?: string }): Promise<{ tp?: OrderResult; sl?: OrderResult }> {
    return withRiskMutation(() =>
      withProtectionIntentLock(
        input.symbol,
        () => this.protectPositionSerialized(input, true),
        this.persistenceProfile,
      ),
    );
  }

  /** Reconciliation already owns the risk-mutation queue when invoking this. */
  async restoreProtection(intent: ProtectionIntent): Promise<{ tp?: OrderResult; sl?: OrderResult }> {
    return withProtectionIntentLock(
      intent.symbol,
      () => this.protectPositionSerialized({
        symbol: intent.symbol,
        tpPrice: intent.tpPrice ?? undefined,
        slPrice: intent.slPrice ?? undefined,
      }, false),
      this.persistenceProfile,
    );
  }

  async removeProtection(symbol: string): Promise<{ ok: boolean; error?: string }> {
    return withRiskMutation(() =>
      withProtectionIntentLock(
        symbol,
        () => this.removeProtectionSerialized(symbol),
        this.persistenceProfile,
      ),
    );
  }

  private async removeProtectionSerialized(symbol: string): Promise<{ ok: boolean; error?: string }> {
    const openOrders = await this.getOpenOrdersIncludingAlgos(symbol);
    const canceled: string[] = [];
    const failures: string[] = [];
    let breakerError: CircuitBreakerOpenError | undefined;
    for (const type of ["TAKE_PROFIT_MARKET", "STOP_MARKET"] as const) {
      for (const side of ["BUY", "SELL"] as const) {
        for (const order of openOrders.filter((candidate) => this.isProtectiveOrder(candidate, type, side))) {
          try {
            const cancelError = await this.cancelProtectiveOrders(symbol, type, side, [order]);
            if (cancelError) failures.push(`${order.clientOrderId}: ${cancelError}`);
            else canceled.push(order.clientOrderId);
          } catch (err) {
            if (!(err instanceof CircuitBreakerOpenError)) throw err;
            breakerError = err;
            failures.push(`${order.clientOrderId}: ${String(err)}`);
            break;
          }
        }
        if (breakerError) break;
      }
      if (breakerError) break;
    }
    let remaining: BinanceOrder[];
    try {
      remaining = await this.getOpenOrdersIncludingAlgos(symbol);
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) breakerError = err;
      failures.push(`Could not verify remaining protection: ${String(err)}`);
      remaining = openOrders.filter((order) => !canceled.includes(order.clientOrderId));
    }
    const remainingProtection = remaining.filter((order) =>
      (order.type === "TAKE_PROFIT_MARKET" || order.type === "STOP_MARKET") && order.closePosition,
    );
    if (failures.length > 0 || remainingProtection.length > 0) {
      const reason = [
        `Protection removal incomplete: canceled [${canceled.join(", ") || "none"}]`,
        `remaining [${remainingProtection.map((order) => order.clientOrderId).join(", ") || "none"}]`,
        failures.length > 0 ? `failures [${failures.join("; ")}]` : "",
      ].filter(Boolean).join("; ");
      let intent = getProtectionIntent(symbol, this.persistenceProfile);
      if (!intent) {
        const position = liveState().positions.get(symbol);
        if (position) {
          const closeSide = position.side === "long" ? "SELL" : "BUY";
          saveProtectionIntent({
            symbol,
            side: position.side,
            tpPrice: remainingProtection.find((order) => order.type === "TAKE_PROFIT_MARKET" && order.side === closeSide)?.stopPrice ?? null,
            slPrice: remainingProtection.find((order) => order.type === "STOP_MARKET" && order.side === closeSide)?.stopPrice ?? null,
          }, Date.now(), this.persistenceProfile);
          intent = getProtectionIntent(symbol, this.persistenceProfile);
        }
      }
      if (intent) setProtectionStatus(symbol, "UNPROTECTED", reason, this.persistenceProfile);
      this.deps.emit("account-update", { at: Date.now(), protection: symbol, status: "UNPROTECTED" });
      if (breakerError) throw breakerError;
      return { ok: false, error: reason };
    }
    deleteProtectionIntent(symbol, this.persistenceProfile);
    this.deps.emit("account-update", { at: Date.now(), protection: symbol, status: null });
    return { ok: true };
  }

  private async protectPositionSerialized(
    input: { symbol: string; tpPrice?: string; slPrice?: string },
    persistIntent: boolean,
  ): Promise<{ tp?: OrderResult; sl?: OrderResult }> {
    const failed = (error: string): OrderResult => ({ ok: false, clientOrderId: "", error });
    const mutationBlock = normalMutationBlock();
    if (mutationBlock) {
      const result = failed(mutationBlock);
      return {
        ...(input.tpPrice ? { tp: result } : {}),
        ...(input.slPrice ? { sl: result } : {}),
      };
    }
    const pos = liveState().positions.get(input.symbol);
    if (!pos) {
      const result = failed(`No open position for ${input.symbol}`);
      return {
        ...(input.tpPrice ? { tp: result } : {}),
        ...(input.slPrice ? { sl: result } : {}),
      };
    }
    if (!persistIntent) {
      const recoveryBlock = this.protectionRecoveryBlock(this.deps.cfg, input.symbol);
      if (recoveryBlock) {
        const result = failed(recoveryBlock);
        return {
          ...(input.tpPrice ? { tp: result } : {}),
          ...(input.slPrice ? { sl: result } : {}),
        };
      }
    } else {
      try {
        requireSubmissionAllowed(this.deps.cfg);
      } catch (err) {
        if (err instanceof SubmissionBlockedError) {
          const result = failed(err.message);
          return {
            ...(input.tpPrice ? { tp: result } : {}),
            ...(input.slPrice ? { sl: result } : {}),
          };
        }
        throw err;
      }
    }

    let reference: ReferencePrice;
    try {
      reference = await this.getFreshProtectionMark(input.symbol);
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) throw err;
      const result = failed(`Unable to fetch a fresh mark price for ${input.symbol}: ${String(err)}`);
      return {
        ...(input.tpPrice ? { tp: result } : {}),
        ...(input.slPrice ? { sl: result } : {}),
      };
    }
    if (!Number.isFinite(Number(reference.price)) || Number(reference.price) <= 0) {
      const result = failed(`No current mark price available for ${input.symbol}`);
      return {
        ...(input.tpPrice ? { tp: result } : {}),
        ...(input.slPrice ? { sl: result } : {}),
      };
    }
    if (Date.now() - reference.at > PROTECTION_MARK_MAX_AGE_MS) {
      const result = failed(`Current mark price for ${input.symbol} is stale`);
      return {
        ...(input.tpPrice ? { tp: result } : {}),
        ...(input.slPrice ? { sl: result } : {}),
      };
    }

    const directionErrors: { tp?: string; sl?: string } = {};
    if (input.tpPrice) directionErrors.tp = this.protectionPriceError(pos.side, "TAKE_PROFIT_MARKET", input.tpPrice, reference) ?? undefined;
    if (input.slPrice) directionErrors.sl = this.protectionPriceError(pos.side, "STOP_MARKET", input.slPrice, reference) ?? undefined;
    if (directionErrors.tp || directionErrors.sl) {
      return {
        ...(input.tpPrice ? { tp: directionErrors.tp ? failed(directionErrors.tp) : undefined } : {}),
        ...(input.slPrice ? { sl: directionErrors.sl ? failed(directionErrors.sl) : undefined } : {}),
      };
    }

    const currentIntent = getProtectionIntent(input.symbol, this.persistenceProfile);
    let intendedTp = input.tpPrice ?? currentIntent?.tpPrice ?? null;
    let intendedSl = input.slPrice ?? currentIntent?.slPrice ?? null;

    let openOrders: BinanceOrder[];
    try {
      openOrders = await this.getOpenOrdersIncludingAlgos(input.symbol);
    } catch (err) {
      const error = `Could not verify existing protective orders: ${String(err)}`;
      this.markProtectionUnprotected(input.symbol, error);
      if (err instanceof CircuitBreakerOpenError) throw err;
      const result = failed(error);
      return {
        ...(input.tpPrice ? { tp: result } : {}),
        ...(input.slPrice ? { sl: result } : {}),
      };
    }

    const closeSide = pos.side === "long" ? "SELL" : "BUY";
    const out: { tp?: OrderResult; sl?: OrderResult } = {};
    const existingTp = openOrders.find((order) => this.isProtectiveOrder(order, "TAKE_PROFIT_MARKET", closeSide));
    const existingSl = openOrders.find((order) => this.isProtectiveOrder(order, "STOP_MARKET", closeSide));
    intendedTp = input.tpPrice ?? existingTp?.stopPrice ?? currentIntent?.tpPrice ?? null;
    intendedSl = input.slPrice ?? existingSl?.stopPrice ?? currentIntent?.slPrice ?? null;
    const previousTp = persistIntent
      ? existingTp?.stopPrice ?? currentIntent?.tpPrice ?? null
      : currentIntent?.previousTpPrice ?? existingTp?.stopPrice ?? null;
    const previousSl = persistIntent
      ? existingSl?.stopPrice ?? currentIntent?.slPrice ?? null
      : currentIntent?.previousSlPrice ?? existingSl?.stopPrice ?? null;

    if (persistIntent) {
      savePendingProtectionIntent({
        symbol: input.symbol,
        side: pos.side,
        tpPrice: intendedTp,
        slPrice: intendedSl,
        previousTpPrice: previousTp,
        previousSlPrice: previousSl,
      }, Date.now(), this.persistenceProfile);
    }

    try {
      if (input.tpPrice) {
        out.tp = await this.replaceProtectionOrder(input.symbol, closeSide, "TAKE_PROFIT_MARKET", input.tpPrice, previousTp ?? undefined);
      }
      if (input.slPrice) {
        out.sl = await this.replaceProtectionOrder(input.symbol, closeSide, "STOP_MARKET", input.slPrice, previousSl ?? undefined);
      }

      let finalOrders: BinanceOrder[];
      try {
        finalOrders = await this.getOpenOrdersIncludingAlgos(input.symbol);
      } catch (err) {
        if (err instanceof CircuitBreakerOpenError) throw err;
        const error = `Could not verify final protective orders: ${String(err)}`;
        this.markProtectionUnprotected(input.symbol, error);
        if (input.tpPrice) out.tp = failed(error);
        if (input.slPrice) out.sl = failed(error);
        return out;
      }

      const tpConfirmed = !intendedTp || !!this.findProtectiveOrder(finalOrders, "TAKE_PROFIT_MARKET", closeSide, intendedTp);
      const slConfirmed = !intendedSl || !!this.findProtectiveOrder(finalOrders, "STOP_MARKET", closeSide, intendedSl);
      if (tpConfirmed && slConfirmed) {
        confirmProtectionIntent({
          symbol: input.symbol,
          side: pos.side,
          tpPrice: intendedTp,
          slPrice: intendedSl,
        }, Date.now(), this.persistenceProfile);
        this.deps.emit("account-update", { at: Date.now(), protection: input.symbol });
      } else {
        const error = "Exchange open orders do not match the recorded TP/SL intent";
        const previousConfirmed =
          (!previousTp || !!this.findProtectiveOrder(finalOrders, "TAKE_PROFIT_MARKET", closeSide, previousTp)) &&
          (!previousSl || !!this.findProtectiveOrder(finalOrders, "STOP_MARKET", closeSide, previousSl));
        const rollbackInvalid = [out.tp, out.sl].some(
          (result) => (result as ProtectionReplaceResult | undefined)?.rollbackInvalid,
        );
        if (rollbackInvalid) {
          const invalidOrder = [out.tp, out.sl].find(
            (result) => (result as ProtectionReplaceResult | undefined)?.rollbackInvalid,
          ) as ProtectionReplaceResult | undefined;
          markProtectionRestoreAttempted(input.symbol, Date.now(), this.persistenceProfile);
          const rollbackError = invalidOrder?.rollbackError ?? invalidOrder?.error ?? error;
          this.markProtectionUnprotected(input.symbol, rollbackError);
          audit("operator", "position.protection.market_passed_old_trigger", {
            symbol: input.symbol,
            side: pos.side,
            severity: "high",
            error: rollbackError,
          }, undefined, this.persistenceProfile);
          alert(`position_protection_market_passed_old_trigger:${input.symbol}`, {
            symbol: input.symbol,
            side: pos.side,
            severity: "high",
            error: rollbackError,
          });
        } else if (previousConfirmed && (previousTp || previousSl)) {
          revertProtectionIntent({
            symbol: input.symbol,
            side: pos.side,
            previousTpPrice: previousTp,
            previousSlPrice: previousSl,
          }, Date.now(), this.persistenceProfile);
        } else {
          markProtectionRestoreAttempted(input.symbol, Date.now(), this.persistenceProfile);
          this.markProtectionUnprotected(input.symbol, error);
        }
        if (input.tpPrice && out.tp?.ok !== false) out.tp = failed(error);
        if (input.slPrice && out.sl?.ok !== false) out.sl = failed(error);
      }
    } catch (err) {
      this.markProtectionUnprotected(input.symbol, `Protective-order replacement failed: ${String(err)}`);
      throw err;
    }
    return out;
  }

  private findProtectiveOrder(
    orders: BinanceOrder[],
    type: string,
    side: "BUY" | "SELL",
    price: string,
  ): BinanceOrder | undefined {
    return orders.find((order) => this.isProtectiveOrder(order, type, side, price));
  }

  private async cancelProtectiveOrders(
    symbol: string,
    type: string,
    side: "BUY" | "SELL",
    orders: BinanceOrder[],
  ): Promise<string | null> {
    for (const order of orders) {
      if (!this.isProtectiveOrder(order, type, side)) continue;
      const intent = this.findIntent(order.clientOrderId);
      if (intent) this.updateIntent(order.clientOrderId, { status: "CANCEL_REQUESTED" });
      try {
        if (order.kind === "algo") {
          const ack = await this.deps.rest.cancelAlgoOrder({
            clientAlgoId: order.clientAlgoId ?? order.clientOrderId,
          });
          this.syncAlgoCancel(ack);
        } else {
          const canceled = await this.deps.rest.cancelOrder(symbol, undefined, order.clientOrderId);
          if (intent) this.syncIntentFromOrder(order.clientOrderId, canceled);
          else rememberOrder(canceled);
        }
        liveState().openOrders.delete(order.clientOrderId);
        audit("operator", "order.protection.cancelled", { symbol, clientOrderId: order.clientOrderId, type }, undefined, this.persistenceProfile);
      } catch (err) {
        if (err instanceof CircuitBreakerOpenError) throw err;
        if (order.kind === "algo") {
          let exchangeOrder: BinanceAlgoOrder | null = null;
          try {
            exchangeOrder = await this.deps.rest.getAlgoOrder({
              clientAlgoId: order.clientAlgoId ?? order.clientOrderId,
            });
          } catch (queryError) {
            if (queryError instanceof CircuitBreakerOpenError) throw queryError;
            if (!(queryError instanceof BinanceApiError) || queryError.code !== ERR_UNKNOWN_ORDER) {
              return `Could not reconcile Algo ${type} cancellation: ${String(queryError)}`;
            }
          }
          const currentAlgoOrders = await this.deps.rest.getOpenAlgoOrders(symbol);
          if (currentAlgoOrders.some((candidate) => candidate.clientAlgoId === (order.clientAlgoId ?? order.clientOrderId))) {
            return `Could not confirm cancellation of existing ${type}: ${String(err)}`;
          }
          if (exchangeOrder && !["CANCELED", "EXPIRED", "REJECTED"].includes(exchangeOrder.algoStatus)) {
            return `Algo ${type} is no longer listed as open but reports ${exchangeOrder.algoStatus}; cancellation is uncertain`;
          }
          if (intent) {
            if (exchangeOrder) this.syncIntentFromAlgoOrder(order.clientOrderId, exchangeOrder);
            else this.updateIntent(order.clientOrderId, { status: "CANCELED" });
          }
          if (exchangeOrder) rememberAlgoOrder(exchangeOrder);
          else {
            const current = liveState().orders.get(order.clientOrderId);
            if (current) {
              const canceled = { ...current, status: "CANCELED", updateTime: Date.now() };
              liveState().orders.set(order.clientOrderId, canceled);
              liveState().openOrders.delete(order.clientOrderId);
            }
          }
          continue;
        }
        let remaining: BinanceOrder[];
        try {
          await this.sleep(250);
          remaining = await this.getOpenOrdersIncludingAlgos(symbol);
        } catch (reconcileError) {
          if (reconcileError instanceof CircuitBreakerOpenError) throw reconcileError;
          return `Could not reconcile cancel outcome: ${String(reconcileError)}`;
        }
        if (remaining.some((candidate) => candidate.clientOrderId === order.clientOrderId)) {
          return `Could not confirm cancellation of existing ${type}: ${String(err)}`;
        }
        if (intent) this.updateIntent(order.clientOrderId, { status: "CANCELED" });
        liveState().openOrders.delete(order.clientOrderId);
      }
    }
    return null;
  }

  private async reconcileProtectionPlacement(
    symbol: string,
    type: string,
    side: "BUY" | "SELL",
    price: string,
    clientOrderId: string,
  ): Promise<{ order: BinanceOrder | null; absent: boolean }> {
    await this.sleep(250);
    const orders = await this.getOpenOrdersIncludingAlgos(symbol);
    const openOrder = this.findProtectiveOrder(orders, type, side, price);
    if (openOrder) return { order: openOrder, absent: false };
    let exchangeOrder: BinanceAlgoOrder | null = null;
    try {
      exchangeOrder = await this.deps.rest.getAlgoOrder({ clientAlgoId: clientOrderId });
    } catch (err) {
      if (!(err instanceof BinanceApiError) || err.code !== ERR_UNKNOWN_ORDER) throw err;
    }
    if (exchangeOrder && !["CANCELED", "EXPIRED", "REJECTED"].includes(exchangeOrder.algoStatus)) {
      return { order: null, absent: false };
    }
    if (exchangeOrder) this.syncIntentFromAlgoOrder(clientOrderId, exchangeOrder);
    else this.updateIntent(clientOrderId, {
      status: "REJECTED",
      lastState: JSON.stringify({ resolved: "protective_order_absent", exchangeStatus: null }),
    });
    this.maybeUnfreeze();
    return {
      order: null,
      absent: !exchangeOrder || ["CANCELED", "EXPIRED", "REJECTED"].includes(exchangeOrder.algoStatus),
    };
  }

  private async replaceProtectionOrder(
    symbol: string,
    side: "BUY" | "SELL",
    type: "TAKE_PROFIT_MARKET" | "STOP_MARKET",
    price: string,
    previousPrice?: string,
  ): Promise<ProtectionReplaceResult> {
    const failed = (error: string, extra: Partial<ProtectionReplaceResult> = {}): ProtectionReplaceResult => ({
      ok: false,
      clientOrderId: "",
      error,
      ...extra,
    });
    const current = await this.getOpenOrdersIncludingAlgos(symbol);
    const alreadyPresent = this.findProtectiveOrder(current, type, side, price);
    if (alreadyPresent) return this.protectiveOrderResult(alreadyPresent);

    const previous = current.filter((order) => this.isProtectiveOrder(order, type, side));
    const cancelError = await this.cancelProtectiveOrders(symbol, type, side, previous);
    if (cancelError) return failed(`Protective ${type} replacement blocked: ${cancelError}`);

    const submit = (triggerPrice: string): Promise<OrderResult> => this.submitOrderSerialized({
      symbol,
      side,
      type,
      stopPrice: triggerPrice,
      closePosition: true,
      kind: "algo",
      clientOrderId: newServerClientOrderId(type === "STOP_MARKET" ? "sl" : "tp"),
    }, true);

    const restorePrevious = async (): Promise<{
      restored: boolean;
      invalid?: boolean;
      error?: string;
    }> => {
      if (!previousPrice) return { restored: false };
      const validationError = await this.validateRollbackPrice(symbol, type, previousPrice);
      if (validationError) return { restored: false, invalid: true, error: validationError };
      const rollback = await submit(previousPrice);
      if (rollback.ok) {
        try {
          const result = await this.reconcileProtectionPlacement(symbol, type, side, previousPrice, rollback.clientOrderId);
          if (result.order) return { restored: true };
          return {
            restored: false,
            error: result.absent
              ? rollback.error ?? `Exchange did not confirm the previous ${type} order`
              : `Previous ${type} order outcome remains uncertain`,
          };
        } catch (err) {
          if (err instanceof CircuitBreakerOpenError) throw err;
          return { restored: false, error: `Could not confirm previous ${type} order: ${String(err)}` };
        }
      }
      try {
        const result = await this.reconcileProtectionPlacement(symbol, type, side, previousPrice, rollback.clientOrderId);
        if (result.order) return { restored: true };
        return {
          restored: false,
          error: result.absent
            ? rollback.error ?? `Exchange rejected the previous ${type} order`
            : `Previous ${type} order outcome remains uncertain`,
        };
      } catch (err) {
        if (err instanceof CircuitBreakerOpenError) throw err;
        return { restored: false, error: `Could not confirm previous ${type} order: ${String(err)}` };
      }
    };

    const first = await submit(price);
    if (first.ok) return first;
    if (first.failureKind !== "transient_or_uncertain") {
      const rollback = await restorePrevious();
      return {
        ...first,
        ...(rollback.restored ? { rollbackRestored: true } : {}),
        ...(rollback.invalid ? { rollbackInvalid: true, rollbackError: rollback.error } : {}),
      };
    }

    let reconciled: { order: BinanceOrder | null; absent: boolean };
    try {
      reconciled = await this.reconcileProtectionPlacement(symbol, type, side, price, first.clientOrderId);
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) throw err;
      return {
        ...first,
        error: `Protective ${type} submission is uncertain and open orders could not be reconciled: ${String(err)}`,
      };
    }
    if (reconciled.order) return this.protectiveOrderResult(reconciled.order);
    if (!reconciled.absent) {
      return { ...first, error: `Protective ${type} submission outcome remains uncertain; retry was not attempted` };
    }

    const retry = await submit(price);
    if (retry.ok) return retry;
    try {
      reconciled = await this.reconcileProtectionPlacement(symbol, type, side, price, retry.clientOrderId);
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) throw err;
      return {
        ...retry,
        error: `Protective ${type} retry is uncertain and open orders could not be reconciled: ${String(err)}`,
      };
    }
    if (reconciled.order) return this.protectiveOrderResult(reconciled.order);
    if (!reconciled.absent) {
      return { ...retry, error: `Protective ${type} retry outcome remains uncertain; rollback was not attempted` };
    }

    const rollback = await restorePrevious();
    return {
      ...retry,
      ...(rollback.restored ? { rollbackRestored: true } : {}),
      ...(rollback.invalid ? { rollbackInvalid: true, rollbackError: rollback.error } : {}),
      ...(!rollback.restored && !rollback.invalid && rollback.error ? {
        error: `${retry.error ?? `Could not confirm new ${type} protection`}; ${rollback.error}`,
      } : {}),
    };
  }

  private async validateRollbackPrice(
    symbol: string,
    type: "TAKE_PROFIT_MARKET" | "STOP_MARKET",
    price: string,
  ): Promise<string | null> {
    let mark: ReferencePrice;
    try {
      mark = await this.getFreshProtectionMark(symbol);
    } catch (err) {
      return `Cannot safely restore the previous ${type} order without a fresh mark: ${String(err)}`;
    }
    if (Date.now() - mark.at > PROTECTION_MARK_MAX_AGE_MS) {
      return `Cannot safely restore the previous ${type} order because the mark is stale`;
    }
    const side = liveState().positions.get(symbol)?.side;
    if (!side) return `Cannot safely restore the previous ${type} order without an open position`;
    const error = this.protectionPriceError(side, type, price, mark);
    if (!error) return null;
    if (type === "STOP_MARKET") {
      return `Market passed the old stop level ${price}; ${error}`;
    }
    return `Previous take-profit ${price} is no longer valid at mark ${mark.price}; ${error}`;
  }

  private isProtectiveOrder(
    order: BinanceOrder,
    type: string,
    side: "BUY" | "SELL",
    price?: string,
  ): boolean {
    if (order.type !== type || order.side !== side || order.closePosition !== true) return false;
    if (price == null) return true;
    if (!order.stopPrice) return false;
    try {
      return eq(parseDec(order.stopPrice), parseDec(price));
    } catch {
      return false;
    }
  }

  private protectiveOrderResult(order: BinanceOrder): OrderResult {
    return {
      ok: true,
      clientOrderId: order.clientOrderId,
      status: order.status,
      exchangeOrderId: order.kind === "algo" ? null : order.orderId,
      ...(order.algoId != null ? { algoId: order.algoId } : {}),
    };
  }

  private markProtectionUnprotected(symbol: string, reason: string): void {
    setProtectionStatus(symbol, "UNPROTECTED", reason, this.persistenceProfile);
    audit("operator", "position.protection.unprotected", { symbol, reason }, undefined, this.persistenceProfile);
    alert("position_unprotected", { symbol, reason });
    this.deps.emit("account-update", { at: Date.now(), protection: symbol, status: "UNPROTECTED" });
  }

  private protectionRecoveryBlock(cfg: EnvConfig, symbol: string): string | null {
    const profileId = cfg.env === "testnet"
      ? "binance-testnet"
      : cfg.env === "production"
        ? "binance-production"
        : null;
    if (!profileId || cfg.activeProfileId !== profileId || !cfg.profiles[profileId].configured) {
      return "Protective-order recovery requires a configured active Binance profile";
    }
    if (this.uncertainIntents().some((intent) => intent.symbol === symbol)) {
      return `Protective-order recovery for ${symbol} is blocked while an order outcome remains uncertain`;
    }
    return null;
  }
}

interface OrderInputValidation {
  errors: string[];
  recordRejection: boolean;
}

/**
 * Floors a client-supplied quantity onto the exchange LOT_SIZE step grid so
 * margin/leverage-derived sizes (e.g. 100 USDT × 10x / price → 0.012331811)
 * cannot be rejected for "must be a multiple of stepSize". Constraints come
 * from whichever Binance environment is active, so this protects testnet and
 * production uniformly. Quantities that floor to zero are left in place for
 * validateOrderInput to reject cleanly ("qty must be positive").
 */
function alignQtyToStep(input: SubmitOrderInput, constraints: SymbolConstraints | null): void {
  if (!input.qty || input.closePosition || !constraints) return;
  try {
    input.qty = toStr(roundDownToStep(parseDec(input.qty), constraints.stepSize));
  } catch {
    // Malformed qty or zero step: leave untouched; validation reports it.
  }
}

/** Binance -4028: requested leverage outside the symbol's bracket. */
const ERR_INVALID_LEVERAGE = -4028;

export function normalizeLeverage(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const whole = Math.floor(n);
  return whole >= 1 && whole <= 125 ? whole : null;
}

/**
 * Syncs the UI-selected leverage to the exchange before submission. Binance
 * stores leverage per symbol per account, so an unsynced order is margined at
 * whatever the symbol was last set to (default 1x) — not what the UI showed.
 * Idempotent submissions re-send the same value, which is a no-op server-side.
 * Failure semantics: an out-of-bracket value (-4028) is a definite business
 * rejection; transport/breaker failures propagate to the standard handlers.
 */
async function syncLeverageToExchange(
  rest: Pick<BinanceRestClient, "changeLeverage">,
  symbol: string,
  leverage: number,
): Promise<string | null> {
  try {
    await rest.changeLeverage(symbol, leverage);
    // Record immediately rather than waiting for the ACCOUNT_CONFIG_UPDATE
    // stream event, so a fill racing the event still seeds the right row.
    applySymbolLeverage(symbol, String(leverage));
    return null;
  } catch (err) {
    if (err instanceof BinanceApiError) {
      if (err.code === ERR_INVALID_LEVERAGE) {
        return `Leverage ${leverage} is not available for ${symbol} on this account tier`;
      }
      return `Leverage sync failed: ${err.exchangeMsg}`;
    }
    throw err;
  }
}

function validateOrderInput(input: SubmitOrderInput, constraints: SymbolConstraints | null): OrderInputValidation | null {
  if (!input.emergencyClose) {
    const errors = validateAgainstConstraints(constraints!, {
      symbol: input.symbol,
      type: input.type,
      price: input.price,
      stopPrice: input.stopPrice,
      qty: input.closePosition ? undefined : input.qty,
    });
    if (!input.closePosition && !input.qty) errors.push("qty is required");
    return errors.length > 0 ? { errors, recordRejection: true } : null;
  }
  if (!input.qty || input.closePosition || (!input.reduceOnly && !input.isClose) || input.type !== "MARKET") {
    return { errors: ["Emergency close requires an explicit reduce-only MARKET quantity"], recordRejection: false };
  }
  return null;
}

function buildOrderParams(input: SubmitOrderInput, clientOrderId: string) {
  return {
    symbol: input.symbol,
    side: input.side,
    type: input.type,
    quantity: input.closePosition ? undefined : input.qty,
    price: input.price,
    stopPrice: input.stopPrice,
    closePosition: input.closePosition || undefined,
    reduceOnly: input.reduceOnly || undefined,
    timeInForce: input.type === "LIMIT" ? "GTC" : undefined,
    clientOrderId,
  };
}

function isConditionalOrder(input: SubmitOrderInput): boolean {
  return input.kind === "algo" || input.type === "STOP_MARKET" || input.type === "TAKE_PROFIT_MARKET";
}

function buildAlgoOrderParams(input: SubmitOrderInput, clientAlgoId: string): PlaceAlgoOrderParams {
  if (!input.stopPrice) throw new Error(`${input.type} requires a trigger price`);
  const base = {
    algoType: "CONDITIONAL" as const,
    symbol: input.symbol,
    side: input.side,
    type: input.type as "STOP_MARKET" | "TAKE_PROFIT_MARKET",
    triggerPrice: input.stopPrice,
    clientAlgoId,
  };
  if (input.closePosition) return { ...base, closePosition: true };
  if (!input.qty) throw new Error(`${input.type} requires a quantity`);
  return {
    ...base,
    closePosition: false,
    quantity: input.qty,
    ...(input.reduceOnly ? { reduceOnly: true } : {}),
  };
}

function normalizeAlgoStatus(status: string): OrderIntent["status"] {
  switch (status) {
    case "CANCELED":
      return "CANCELED";
    case "REJECTED":
      return "REJECTED";
    case "EXPIRED":
      return "EXPIRED";
    case "FINISHED":
      return "FILLED";
    default:
      return "SUBMITTED";
  }
}

function numericExchangeOrderId(value: number | string | null | undefined): number | null {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return null;
  return Number(value);
}

function algoOrderAsBinanceOrder(order: BinanceAlgoOrder): BinanceOrder {
  return {
    orderId: numericExchangeOrderId(order.actualOrderId) ?? order.algoId,
    clientOrderId: order.clientAlgoId,
    clientAlgoId: order.clientAlgoId,
    algoId: order.algoId,
    kind: "algo",
    symbol: order.symbol,
    side: order.side,
    type: order.orderType,
    status: order.algoStatus,
    price: order.price ?? "0",
    stopPrice: order.triggerPrice,
    origQty: order.quantity ?? "0",
    executedQty: order.actualQty ?? "0",
    cumQuote: "0",
    avgPrice: order.actualPrice ?? "0",
    reduceOnly: !!order.reduceOnly,
    closePosition: !!order.closePosition,
    time: order.createTime,
    updateTime: order.updateTime,
  };
}

function uncertainState(clientOrderId: string, patch: Record<string, unknown>, profile: PersistenceProfile): string {
  const intent = findIntentByClientOrderId(clientOrderId, profile);
  let prior: Record<string, unknown> = {};
  try {
    prior = JSON.parse(intent?.lastState ?? "{}") as Record<string, unknown>;
  } catch {
    // Preserve the uncertainty even if an older state payload was malformed.
  }
  return JSON.stringify({ ...prior, ...patch });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
