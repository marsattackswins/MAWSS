/**
 * App-level Algo protection failure handling (Binance Testnet only).
 *
 * Complements scripts/testnet-smoke.ts (an exchange-only probe): these tests
 * drive the real BinanceLiveManager/OrderService, the same temp DB and the
 * assertTestnetSafety guard used by algo-protection.integration.test.ts, and
 * exercise the failures the probe cannot see: an operator bypassing the app,
 * a position closed outside the app, and cross-symbol margin freshness.
 *
 * Requires MAWS_ENV=testnet and Testnet credentials; skipped otherwise.
 */

import * as alerts from "@/lib/server/alerts/dispatch";
import { BinanceLiveManager } from "@/lib/server/binance/manager";
import { getProtectionIntent } from "@/lib/server/binance/protection";
import { BinanceApiError } from "@/lib/server/binance/rest";
import {
  cleanupTestnetState,
  createTestnetManager,
  sleep,
  uniqueOrderId,
  waitFor,
  waitForPosition,
} from "./helpers";
import {
  assertSizesWithinRiskCaps,
  planTestnetOrder,
  priceFromPct,
  type OrderPlan,
} from "./testnet-sizing";

const hasTestnetCredentials = Boolean(
  (process.env.MAWS_BINANCE_TESTNET_API_KEY && process.env.MAWS_BINANCE_TESTNET_API_SECRET) ||
  (process.env.MAWS_BINANCE_API_KEY && process.env.MAWS_BINANCE_API_SECRET),
);
const testnetDescribe = hasTestnetCredentials ? describe : describe.skip;

const SYMBOL = "BTCUSDT";
const SECOND_SYMBOL = "ETHUSDT";
const PROTECTION_TIMEOUT_MS = 20_000;
const ORPHAN_TIMEOUT_MS = 30_000;
const MARGIN_FRESH_TIMEOUT_MS = 30_000;

testnetDescribe("Algo protection failure handling (Binance Testnet only)", () => {
  let manager: BinanceLiveManager;
  let alertSpy: jest.SpyInstance;
  let primary: OrderPlan;
  let second: OrderPlan;

  beforeAll(async () => {
    alertSpy = jest.spyOn(alerts, "alert").mockImplementation(() => undefined);
    manager = await createTestnetManager();
    if (manager.cfg.env !== "testnet" || manager.cfg.activeProfileId !== "binance-testnet") {
      throw new Error("Algo protection failure tests require the Binance Testnet profile");
    }
    // Size from the live exchangeInfo filters instead of hardcoded quantities.
    primary = await planTestnetOrder(SYMBOL);
    second = await planTestnetOrder(SECOND_SYMBOL);
    console.log(
      `[integration] sized ${SYMBOL} ${primary.qty} @ $${primary.mark} = $${primary.notionalUsd.toFixed(2)}; `
      + `${SECOND_SYMBOL} ${second.qty} @ $${second.mark} = $${second.notionalUsd.toFixed(2)}`,
    );
  }, 30_000);

  beforeEach(() => {
    alertSpy?.mockClear();
  });

  afterEach(async () => {
    if (!manager) return;
    await cleanupTestnetState(manager);
    await cancelAndFlatten();
    await sleep(1_500);
    try {
      await verifyFlat();
    } catch (firstError) {
      // One bounded retry: testnet sometimes lags position/order visibility.
      await cancelAndFlatten();
      await sleep(1_500);
      try {
        await verifyFlat();
      } catch {
        throw firstError;
      }
    }
  }, 60_000);

  afterAll(() => {
    alertSpy?.mockRestore();
    manager?.stop();
  });

  // ─── Helpers ────────────────────────────────────────────────────────────

  function alertCount(event: string): number {
    return alertSpy.mock.calls.filter((call) => call[0] === event).length;
  }

  async function currentPositionAmt(symbol: string): Promise<string> {
    const rows = await manager.rest.getPositionRisk(symbol);
    return rows.find((row) => row.symbol === symbol)?.positionAmt ?? "0";
  }

  function planFor(symbol: string): OrderPlan {
    if (symbol === SYMBOL) return primary;
    if (symbol === SECOND_SYMBOL) return second;
    throw new Error(`no sized order plan for ${symbol}`);
  }

  /** Current exchange leverage for the symbol, or null when it cannot be read. */
  async function currentLeverage(symbol: string): Promise<number | null> {
    try {
      const row = (await manager.rest.getPositionRisk(symbol)).find((candidate) => candidate.symbol === symbol);
      const value = Number(row?.leverage);
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Fails with the cap's name before an order is submitted, so a mis-sized
   * suite reports RISK_MAX_ORDER_NOTIONAL / RISK_MAX_GROSS_EXPOSURE /
   * RISK_MAX_LEVERAGE instead of surfacing a rejection mid-test.
   */
  async function assertCapsAllow(symbols: string[]): Promise<void> {
    const orders = symbols.map((symbol) => ({ symbol, notionalUsd: planFor(symbol).notionalUsd }));
    assertSizesWithinRiskCaps(manager.cfg.risk, orders, await currentLeverage(symbols[0]));
  }

  async function openPosition(symbol: string, qty: string): Promise<void> {
    await assertCapsAllow([symbol]);
    const result = await manager.orders.submitOrder({
      symbol,
      side: "BUY",
      type: "MARKET",
      qty,
      clientOrderId: uniqueOrderId("fail"),
    });
    if (!result.ok) throw new Error(`entry on ${symbol} rejected: ${result.error ?? "unknown error"}`);
    await waitForPosition(symbol, true, 15_000);
  }

  async function protectPosition(symbol: string): Promise<void> {
    const plan = planFor(symbol);
    const placed = await manager.orders.protectPosition({
      symbol,
      tpPrice: priceFromPct(plan.mark, 110, plan.tick),
      slPrice: priceFromPct(plan.mark, 90, plan.tick),
    });
    if (!placed.tp?.ok || !placed.sl?.ok) {
      throw new Error(`protection placement failed on ${symbol}: ${placed.tp?.error ?? placed.sl?.error ?? "unknown error"}`);
    }
    await manager.reconcileRun("algo-protection-failures:protect");
    expect(getProtectionIntent(symbol)?.protectionStatus).toBe("PROTECTED");
  }

  /**
   * Closes the exchange position with a direct REST order, bypassing
   * OrderService entirely. Testnet occasionally rejects reduce-only closes
   * with -2022 even in one-way mode; that definite rejection is retried once
   * without the flag only after re-verifying the position is unchanged.
   */
  async function closeDirectly(symbol: string): Promise<string> {
    const row = (await manager.rest.getPositionRisk(symbol)).find((candidate) => candidate.symbol === symbol);
    if (!row || Number(row.positionAmt) === 0) throw new Error(`no open position on ${symbol}`);
    const short = row.positionAmt.trim().startsWith("-");
    const qty = short ? row.positionAmt.trim().slice(1) : row.positionAmt.trim();
    const side = short ? "BUY" : "SELL";
    try {
      await manager.rest.placeOrder({ symbol, side, type: "MARKET", quantity: qty, reduceOnly: true });
      return "reduce-only MARKET";
    } catch (error) {
      if (!(error instanceof BinanceApiError) || error.code !== -2022) throw error;
      const still = (await manager.rest.getPositionRisk(symbol)).find((candidate) => candidate.symbol === symbol);
      if (!still || still.positionAmt !== row.positionAmt) {
        throw new Error("position changed after the -2022 rejection; not retrying without reduceOnly");
      }
      await manager.rest.placeOrder({ symbol, side, type: "MARKET", quantity: qty });
      return "MARKET after -2022 reduce-only rejection (testnet fallback)";
    }
  }

  /** Waits until no closePosition Algo order is listed for the symbol. */
  async function waitForNoClosePositionAlgos(symbol: string, timeoutMs: number): Promise<number> {
    const start = Date.now();
    for (;;) {
      const orders = await manager.rest.getOpenAlgoOrders(symbol);
      if (!orders.some((order) => order.closePosition)) return Date.now() - start;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`closePosition Algo order(s) still open on ${symbol} after ${timeoutMs}ms`);
      }
      await sleep(500);
    }
  }

  async function cancelAndFlatten(): Promise<void> {
    for (const symbol of [SYMBOL, SECOND_SYMBOL]) {
      await manager.rest.cancelAllAlgoOrdersEmergency(symbol).catch((error: unknown) => {
        console.log(`[integration] cancel-all Algo orders on ${symbol} reported: ${String(error)}`);
      });
      await manager.rest.cancelAllOpenOrdersEmergency(symbol).catch((error: unknown) => {
        console.log(`[integration] cancel-all orders on ${symbol} reported: ${String(error)}`);
      });
      try {
        if (Number(await currentPositionAmt(symbol)) !== 0) await closeDirectly(symbol);
      } catch (error) {
        console.log(`[integration] flatten on ${symbol} report: ${String(error)}`);
      }
    }
  }

  async function verifyFlat(): Promise<void> {
    const problems: string[] = [];
    for (const symbol of [SYMBOL, SECOND_SYMBOL]) {
      const positionAmt = await currentPositionAmt(symbol).catch((error: unknown) => {
        problems.push(`${symbol}: position unreadable (${String(error)})`);
        return "0";
      });
      if (Number(positionAmt) !== 0) problems.push(`${symbol}: position ${positionAmt}`);

      const orders = await manager.rest.getOpenOrders(symbol).catch((error: unknown) => {
        problems.push(`${symbol}: openOrders unreadable (${String(error)})`);
        return [];
      });
      if (orders.length > 0) problems.push(`${symbol}: ${orders.length} open order(s)`);

      const algos = await manager.rest.getOpenAlgoOrders(symbol).catch((error: unknown) => {
        problems.push(`${symbol}: openAlgoOrders unreadable (${String(error)})`);
        return [];
      });
      if (algos.length > 0) problems.push(`${symbol}: ${algos.length} open Algo order(s)`);
    }
    if (problems.length > 0) throw new Error(`testnet cleanup not flat: ${problems.join("; ")}`);
  }

  // ─── (a) External TP cancel ─────────────────────────────────────────────

  test("operator-cancelled TP becomes UNPROTECTED within 20s with exactly one alert", async () => {
    await openPosition(SYMBOL, primary.qty);
    await protectPosition(SYMBOL);

    const openAlgos = await manager.rest.getOpenAlgoOrders(SYMBOL);
    const tp = openAlgos.find((order) => order.orderType === "TAKE_PROFIT_MARKET");
    if (!tp) throw new Error("no open TP Algo order found after protection");
    // Direct REST cancel: the app's OrderService never sees this cancellation.
    await manager.rest.cancelAlgoOrder({ clientAlgoId: tp.clientAlgoId });

    const started = Date.now();
    await waitFor(() => getProtectionIntent(SYMBOL)?.protectionStatus === "UNPROTECTED", {
      timeoutMs: PROTECTION_TIMEOUT_MS,
      intervalMs: 250,
      description: "protection status UNPROTECTED after an external TP cancel",
    });
    const elapsed = Date.now() - started;
    const emitted = alertCount(`position_unprotected:${SYMBOL}`);
    console.log(`[integration] UNPROTECTED after ${elapsed}ms; position_unprotected alerts=${emitted}`);
    expect(elapsed).toBeLessThanOrEqual(PROTECTION_TIMEOUT_MS);
    expect(emitted).toBe(1);
  }, 90_000);

  // ─── (b) Close outside the app, then a new position ─────────────────────

  test("direct reduce-only close leaves no closePosition Algo order and no stale protection", async () => {
    await openPosition(SYMBOL, primary.qty);
    await protectPosition(SYMBOL);

    const oldAlgoIds = (await manager.rest.getOpenAlgoOrders(SYMBOL))
      .filter((order) => order.closePosition)
      .map((order) => order.clientAlgoId);
    expect(oldAlgoIds.length).toBeGreaterThan(0);

    const closeMode = await closeDirectly(SYMBOL);
    await waitForPosition(SYMBOL, false, 15_000);

    const clearedInMs = await waitForNoClosePositionAlgos(SYMBOL, ORPHAN_TIMEOUT_MS);
    const mechanism = alertCount(`position_algo_orphan_cleaned:${SYMBOL}`) > 0
      ? "app orphan cleanup"
      : "Binance auto-cancel (no app orphan-cleanup alert observed)";
    console.log(`[integration] close=${closeMode}; closePosition Algo orders gone after ${clearedInMs}ms via ${mechanism}`);

    // The old intent must be deleted once the symbol is flat. Report its status
    // instead of assuming UNPROTECTED: a surviving row would let the next
    // position inherit protection that no longer exists on the exchange.
    await manager.reconcileRun("algo-protection-failures:flat");
    const survivingIntent = getProtectionIntent(SYMBOL);
    if (survivingIntent !== null && survivingIntent !== undefined) {
      throw new Error(
        `protection intent for ${SYMBOL} survived the flat position: status=${survivingIntent.status}, `
        + `protectionStatus=${survivingIntent.protectionStatus}, tp=${survivingIntent.tpPrice ?? "null"}, `
        + `sl=${survivingIntent.slPrice ?? "null"}`,
      );
    }

    await openPosition(SYMBOL, primary.qty);
    await manager.reconcileRun("algo-protection-failures:new-position");
    expect(getProtectionIntent(SYMBOL)).toBeNull();
    const remainingAlgos = await manager.rest.getOpenAlgoOrders(SYMBOL);
    expect(remainingAlgos.some((order) => oldAlgoIds.includes(order.clientAlgoId))).toBe(false);
    expect(remainingAlgos.filter((order) => order.closePosition)).toHaveLength(0);

    // Nothing stale may be re-placed once the new position is live.
    await sleep(2_000);
    expect(await manager.rest.getOpenAlgoOrders(SYMBOL)).toHaveLength(0);
  }, 120_000);

  // ─── (c) Second symbol and margin freshness ─────────────────────────────

  test("second risk-increasing order on another symbol records margin freshness", async () => {
    await openPosition(SYMBOL, primary.qty);
    // Both positions are live at once, so the gross-exposure cap must allow both.
    await assertCapsAllow([SYMBOL, SECOND_SYMBOL]);

    const secondOrder = await manager.orders.submitOrder({
      symbol: SECOND_SYMBOL,
      side: "BUY",
      type: "MARKET",
      qty: second.qty,
      clientOrderId: uniqueOrderId("cross"),
    });
    console.log(`[integration] ${SECOND_SYMBOL} order accepted=${secondOrder.ok}${secondOrder.ok ? "" : ` error=${secondOrder.error ?? "unknown"}`}`);
    if (secondOrder.ok) await waitForPosition(SECOND_SYMBOL, true, 15_000);

    // Freshness is measured from immediately after the risk-increasing order.
    const started = Date.now();
    let fresh = manager.getRiskSnapshot().marginDataFresh;
    while (!fresh && Date.now() - started < MARGIN_FRESH_TIMEOUT_MS) {
      await sleep(500);
      fresh = manager.getRiskSnapshot().marginDataFresh;
    }
    const elapsed = Date.now() - started;
    console.log(`[integration] marginDataFresh=${fresh} after ${elapsed}ms`);
    expect(fresh).toBe(true);
    expect(elapsed).toBeLessThanOrEqual(MARGIN_FRESH_TIMEOUT_MS);
  }, 90_000);
});
