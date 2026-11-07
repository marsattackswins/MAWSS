import { BinanceRestClient } from "@/lib/server/binance/rest";
import { RateLimiter } from "@/lib/server/binance/ratelimit";
import { OrderService, type OrderServiceDeps, type ReferencePrice } from "@/lib/server/binance/orders";
import { extractConstraints } from "@/lib/server/binance/filters";
import type { RiskSnapshot } from "@/lib/server/binance/risk";
import { createIntent, findByClientOrderId, updateIntent } from "@/lib/server/binance/intents";
import { applyAccountEvent, liveState } from "@/lib/server/binance/state";
import { applyOpenOrdersSnapshot } from "@/lib/server/binance/state";
import {
  getProtectionIntent,
  isProtectionIntentLocked,
  savePendingProtectionIntent,
  saveProtectionIntent,
  withProtectionIntentLock,
} from "@/lib/server/binance/protection";
import { Reconciler } from "@/lib/server/binance/recon";
import { resetServerConfigForTests } from "@/lib/server/env/config";
import { setHealthSignal } from "@/lib/server/health/state";
import { resetAlertsForTests } from "@/lib/server/alerts/dispatch";
import { CircuitBreakerOpenError } from "@/lib/server/resilience/circuit-breaker";
import { TransportTimeoutError } from "@/lib/server/binance/transport";
import { RUNTIME_KEYS, setRuntime } from "@/lib/server/runtime/flags";
import type { EnvConfig } from "@/lib/server/env/config";
import { persistenceProfileFromConfig } from "@/lib/server/profile/context";
import { getDb } from "@/lib/server/db/connection";
import { BTCUSDT_INFO, FakeHttp, freshEnv, installFakes, jsonRes, makeCfg, orderFixture } from "./helpers";

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

interface Harness {
  cfg: EnvConfig;
  http: FakeHttp;
  rest: BinanceRestClient;
  svc: OrderService;
  freezes: string[];
  emitted: Array<{ event: string; data: unknown }>;
}

function setup(
  cfgOverrides: Partial<EnvConfig> = {},
  depOverrides: {
    getReferencePrice?: (symbol: string) => Promise<ReferencePrice | null>;
    getMarkPrice?: (symbol: string) => Promise<ReferencePrice | null>;
    projectReverseRisk?: OrderServiceDeps["projectReverseRisk"];
    getRiskSnapshot?: () => RiskSnapshot;
  } = {},
): Harness {
  resetAlertsForTests();
  // Fakes are only installable under a testnet server config (shadow and
  // production refuse the DI seam outright); the service under test can then
  // be pointed at any env via its own cfg object.
  const base = freshEnv(makeCfg());
  liveState().symbolLeverage.set("BTCUSDT", "1");
  const http = new FakeHttp();
  installFakes(http);
  const cfg = {
    ...base,
    ...(depOverrides.projectReverseRisk ? { reverseEnabled: true } : {}),
    ...cfgOverrides,
  };
  const profile = persistenceProfileFromConfig(cfg);
  const rest = new BinanceRestClient(cfg, new RateLimiter(cfg.rateInternalPerMin), async () => undefined);
  rest.setTransportForTests(http);
  setRuntime(RUNTIME_KEYS.executionEnabled, "true", Date.now(), profile);
  setRuntime(RUNTIME_KEYS.killSwitch, "false", Date.now(), profile);
  setRuntime(RUNTIME_KEYS.frozen, "false", Date.now(), profile);
  setRuntime(RUNTIME_KEYS.frozenReason, "", Date.now(), profile);

  const constraints = extractConstraints(BTCUSDT_INFO);
  const freezes: string[] = [];
  const emitted: Array<{ event: string; data: unknown }> = [];
  const svc = new OrderService({
    cfg,
    rest,
    getConstraints: (s) => (s === "BTCUSDT" ? constraints : null),
    getReferencePrice: depOverrides.getReferencePrice ?? (async () => ({ price: "50000", at: Date.now() })),
    getMarkPrice: depOverrides.getMarkPrice,
    getRiskSnapshot: depOverrides.getRiskSnapshot ?? (() => ({ balanceUsd: 1000, grossExposureUsd: 0, openOrderCount: 0, openPositionCount: 0, realizedTodayUsd: 0, unrealizedPnlUsd: 0, unrealizedPnlFresh: true })),
    projectReverseRisk: depOverrides.projectReverseRisk,
    freeze: (reason) => {
      freezes.push(reason);
      setRuntime(RUNTIME_KEYS.frozen, "true", Date.now(), profile);
      setRuntime(RUNTIME_KEYS.frozenReason, reason, Date.now(), profile);
    },
    unfreeze: () => {
      setRuntime(RUNTIME_KEYS.frozen, "false", Date.now(), profile);
      setRuntime(RUNTIME_KEYS.frozenReason, "", Date.now(), profile);
    },
    emit: (event, data) => emitted.push({ event, data }),
    sleep: async () => undefined,
  });
  return { cfg, http, rest, svc, freezes, emitted };
}

const placeCalls = (h: Harness) => h.http.callsTo("/fapi/v1/order").filter((c) => c.method === "POST");
const algoPlaceCalls = (h: Harness) => h.http.callsTo("/fapi/v1/algoOrder").filter((c) => c.method === "POST");
const queryOf = (c: { url: string }) => new URLSearchParams(c.url.split("?")[1]);

function reverseRiskSnapshot(overrides: Partial<RiskSnapshot> = {}): RiskSnapshot {
  return {
    balanceUsd: 1000,
    grossExposureUsd: 0,
    openOrderCount: 0,
    openPositionCount: 0,
    openPositionCountAfterOrder: 1,
    realizedTodayUsd: 0,
    unrealizedPnlUsd: 0,
    unrealizedPnlFresh: true,
    marginRatio: 0.1,
    marginDataFresh: true,
    liquidationDistancesPct: [20],
    ...overrides,
  };
}

function installReverseExchange(
  h: Harness,
  options: {
    initialQty?: string;
    resultingQty?: string;
    leverage?: string;
    dualSidePosition?: boolean;
    rejected?: boolean;
    protectiveOrders?: Array<Record<string, unknown>>;
  } = {},
) {
  let positionAmt = options.initialQty ?? "0.001";
  const orders = [...(options.protectiveOrders ?? [])];
  h.http.route("/fapi/v1/positionSide/dual", () => jsonRes({ dualSidePosition: !!options.dualSidePosition }));
  h.http.route("/fapi/v2/positionRisk", () => jsonRes([{
    symbol: "BTCUSDT",
    positionAmt,
    entryPrice: "50000",
    markPrice: "50000",
    unRealizedProfit: "0",
    liquidationPrice: "35000",
    leverage: options.leverage ?? "2",
    positionSide: "BOTH",
  }]));
  h.http.route("/fapi/v1/premiumIndex", () => jsonRes({ symbol: "BTCUSDT", markPrice: "50000", time: Date.now() }));
  h.http.route("/fapi/v1/openOrders", () => jsonRes(orders));
  h.http.route("/fapi/v1/order", () => {
    const request = h.http.calls[h.http.calls.length - 1];
    const params = new URL(request.url).searchParams;
    if (request.method === "DELETE") {
      const index = orders.findIndex((order) => order.clientOrderId === params.get("origClientOrderId"));
      if (index < 0) return jsonRes({ code: -2011, msg: "Unknown order sent." }, 400);
      const [canceled] = orders.splice(index, 1);
      return jsonRes({ ...canceled, status: "CANCELED" });
    }
    if (request.method === "GET") {
      const order = orders.find((candidate) => candidate.clientOrderId === params.get("origClientOrderId"));
      return order ? jsonRes(order) : jsonRes({ code: -2013, msg: "Order does not exist." }, 404);
    }
    if (options.rejected) return jsonRes({ code: -2021, msg: "Order would immediately trigger." }, 400);
    positionAmt = options.resultingQty ?? "-0.001";
    return jsonRes(orderFixture({
      clientOrderId: params.get("newClientOrderId") ?? "reverse-order",
      symbol: "BTCUSDT",
      side: params.get("side") === "SELL" ? "SELL" : "BUY",
      type: "MARKET",
      status: "FILLED",
      origQty: params.get("quantity") ?? "0",
      executedQty: params.get("quantity") ?? "0",
    }));
  });
  return { orders };
}

function mockProtectionExchange(h: Harness, initial: Array<Record<string, unknown>> = []) {
  const orders: Array<Record<string, unknown>> = [];
  const algoOrders = initial.map((order, index) => ({
    algoId: index + 1,
    clientAlgoId: String(order.clientOrderId ?? `initial-algo-${index + 1}`),
    algoType: "CONDITIONAL",
    orderType: String(order.type ?? "STOP_MARKET"),
    symbol: String(order.symbol ?? "BTCUSDT"),
    side: String(order.side ?? "SELL"),
    algoStatus: String(order.status ?? "NEW"),
    triggerPrice: String(order.stopPrice ?? "0"),
    closePosition: Boolean(order.closePosition),
    quantity: String(order.origQty ?? "0"),
    actualQty: String(order.executedQty ?? "0"),
    actualPrice: String(order.avgPrice ?? "0"),
    createTime: Number(order.time ?? Date.now()),
    updateTime: Number(order.updateTime ?? Date.now()),
  }));
  const algoHistory = [...algoOrders];
  let nextAlgoId = algoOrders.length + 1;
  let postFailures = 0;
  const failedPrices = new Map<string, number>();
  const postErrors: Error[] = [];
  const postResponses: Array<{ status: number; code: number; msg: string; headers?: Record<string, string> }> = [];
  let onPostFailure: (() => void) | undefined;
  h.http.route("/fapi/v1/openOrders", () => jsonRes(orders));
  h.http.route("/fapi/v1/openAlgoOrders", () => jsonRes(algoOrders));
  h.http.route("/fapi/v1/algoOrder", () => {
    const request = h.http.calls[h.http.calls.length - 1];
    const url = new URL(request.url);
    const query = url.searchParams;
    if (request.method === "DELETE") {
      const index = algoOrders.findIndex((order) => order.clientAlgoId === query.get("clientAlgoId"));
      if (index < 0) return jsonRes({ code: -2011, msg: "Unknown algo order sent." }, 400);
      const [canceled] = algoOrders.splice(index, 1);
      canceled.algoStatus = "CANCELED";
      canceled.updateTime = Date.now();
      return jsonRes(canceled);
    }
    if (request.method === "GET") {
      const found = algoHistory.find((order) => order.clientAlgoId === query.get("clientAlgoId"));
      return found ? jsonRes(found) : jsonRes({ code: -2013, msg: "Algo order does not exist." }, 404);
    }
    if (request.method === "POST") {
      if (postErrors.length > 0) throw postErrors.shift()!;
      const scriptedResponse = postResponses.shift();
      if (scriptedResponse) {
        const response = jsonRes({ code: scriptedResponse.code, msg: scriptedResponse.msg }, scriptedResponse.status);
        response.headers = scriptedResponse.headers ?? {};
        return response;
      }
      const stopPrice = query.get("triggerPrice") ?? "";
      const failPriceCount = failedPrices.get(stopPrice) ?? 0;
      if (postFailures > 0 || failPriceCount > 0) {
        if (postFailures > 0) postFailures -= 1;
        if (failPriceCount > 1) failedPrices.set(stopPrice, failPriceCount - 1);
        else if (failPriceCount === 1) failedPrices.delete(stopPrice);
        onPostFailure?.();
        return jsonRes({ code: -1000, msg: "simulated protective placement failure" }, 400);
      }
      const order = {
        algoId: nextAlgoId++,
        clientAlgoId: query.get("clientAlgoId") ?? "generated",
        algoType: "CONDITIONAL",
        orderType: query.get("type") ?? "STOP_MARKET",
        symbol: query.get("symbol") ?? "BTCUSDT",
        side: query.get("side") === "SELL" ? "SELL" : "BUY",
        algoStatus: "NEW",
        triggerPrice: query.get("triggerPrice") ?? "0",
        closePosition: query.get("closePosition") === "true",
        quantity: query.get("quantity") ?? "0",
        actualQty: "0",
        actualPrice: "0",
        createTime: Date.now(),
        updateTime: Date.now(),
      };
      algoOrders.push(order);
      algoHistory.push(order);
      return jsonRes(order);
    }
    return jsonRes({ code: -1000, msg: "unsupported test method" }, 400);
  });
  h.http.route("/fapi/v1/algoOpenOrders", () => {
    const request = h.http.calls[h.http.calls.length - 1];
    const symbol = new URL(request.url).searchParams.get("symbol");
    const removed = algoOrders.filter((order) => order.symbol === symbol);
    for (const order of removed) order.algoStatus = "CANCELED";
    for (let index = algoOrders.length - 1; index >= 0; index--) {
      if (algoOrders[index].symbol === symbol) algoOrders.splice(index, 1);
    }
    return jsonRes(removed);
  });
  return {
    orders: algoOrders,
    algoOrders,
    failPosts(count: number) {
      postFailures = count;
    },
    failPostPrices(prices: string[], callback?: () => void) {
      prices.forEach((price) => failedPrices.set(price, (failedPrices.get(price) ?? 0) + 1));
      onPostFailure = callback;
    },
    throwOnPosts(errors: Error[]) {
      postErrors.push(...errors);
    },
    respondToPost(status: number, code: number, msg: string, headers?: Record<string, string>) {
      postResponses.push({ status, code, msg, headers });
    },
  };
}

describe("order submission (testnet lifecycle via fake exchange)", () => {
  test("MARKET order: intent persisted before submission, accepted by exchange", async () => {
    const h = setup();
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "mk1", type: "MARKET", status: "NEW" })));

    const res = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "mk1" });
    expect(res).toMatchObject({ ok: true, clientOrderId: "mk1", status: "NEW" });

    const call = placeCalls(h)[0];
    const q = queryOf(call);
    expect(q.get("symbol")).toBe("BTCUSDT");
    expect(q.get("side")).toBe("BUY");
    expect(q.get("type")).toBe("MARKET");
    expect(q.get("quantity")).toBe("0.001");
    expect(q.get("newClientOrderId")).toBe("mk1");
    expect(q.get("timeInForce")).toBeNull();
    expect(q.get("signature")).toMatch(/^[0-9a-f]{64}$/);

    const intent = findByClientOrderId("mk1");
    expect(intent?.status).toBe("SUBMITTED");
    expect(Number(intent?.exchangeOrderId)).toBe(res.exchangeOrderId);
    expect(h.emitted.some((e) => e.event === "order-update")).toBe(true);
  });

  test("LIMIT order sends price and timeInForce=GTC", async () => {
    const h = setup({ risk: { maxOrderNotionalUsd: 100, maxGrossExposureUsd: 1000, maxOpenOrders: 10, maxOpenPositions: 3, dailyLossPct: 5, priceCollarPct: 2, maxLeverage: 10, maxMarginRatio: 0.5, minLiquidationDistancePct: 10 } });
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "lm1", type: "LIMIT", status: "NEW" })));
    const res = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "SELL", type: "LIMIT", qty: "0.001", price: "50000.5", clientOrderId: "lm1" });
    expect(res.ok).toBe(true);
    const q = queryOf(placeCalls(h)[0]);
    expect(q.get("type")).toBe("LIMIT");
    expect(q.get("price")).toBe("50000.5");
    expect(q.get("timeInForce")).toBe("GTC");
  });

  test("filter violations are rejected before any exchange call and leave no intent", async () => {
    const h = setup();
    const badTick = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", qty: "0.001", price: "50000.15", clientOrderId: "vt1" });
    expect(badTick.ok).toBe(false);
    expect(badTick.error).toContain("tickSize");

    const missingQty = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", clientOrderId: "vt2" });
    expect(missingQty.ok).toBe(false);
    expect(missingQty.error).toContain("qty is required");

    const unknownSymbol = await h.svc.submitOrder({ symbol: "NOPEUSDT", side: "BUY", type: "MARKET", qty: "1", clientOrderId: "vt3" });
    expect(unknownSymbol.ok).toBe(false);
    expect(unknownSymbol.error).toContain("No exchange filter data");

    expect(placeCalls(h)).toHaveLength(0);
    expect(findByClientOrderId("vt1")).toBeNull();
  });

  test("risk caps reject oversized orders before any exchange call", async () => {
    const h = setup();
    const res = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.003", clientOrderId: "rk1" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("RISK_MAX_ORDER_NOTIONAL");
    expect(placeCalls(h)).toHaveLength(0);
    expect(findByClientOrderId("rk1")).toBeNull();
  });

  test("unrounded margin-derived qty is floored to stepSize before validation and submission", async () => {
    // UI sizing produces arbitrary floats like 0.012331811 (100 USDT × 10x /
    // 81100). The LOT_SIZE step for the harness symbol is 0.001, so the
    // pre-flight validator must never see the off-grid value.
    const h = setup({
      risk: { maxOrderNotionalUsd: 1000, maxGrossExposureUsd: 5000, maxOpenOrders: 10, maxOpenPositions: 3, dailyLossPct: 5, priceCollarPct: 2, maxLeverage: 10, maxMarginRatio: 0.5, minLiquidationDistancePct: 10 },
    });
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "qt1", type: "MARKET", status: "NEW" })));

    const res = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.012331811", clientOrderId: "qt1" });
    expect(res.ok).toBe(true);

    const q = queryOf(placeCalls(h)[0]);
    expect(q.get("quantity")).toBe("0.012");
    // The persisted intent records the aligned quantity, not the raw input.
    expect(findByClientOrderId("qt1")?.qty).toBe("0.012");
  });

  test("qty that floors below minQty is rejected cleanly without exchange traffic", async () => {
    const h = setup();
    // 0.0005 floors to zero steps of 0.001 → validation reports minQty.
    const res = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.0005", clientOrderId: "qt2" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("minQty");
    expect(res.error).toContain("qty");
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("UI-selected leverage is synced to the exchange before the order", async () => {
    const h = setup({ risk: { ...makeCfg().risk, maxLeverage: 20 } });
    h.http.route("/fapi/v1/leverage", () => jsonRes({ leverage: 20, maxNotionalValue: "1000000" }));
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "lv1", type: "MARKET", status: "NEW" })));

    const res = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", leverage: 20, clientOrderId: "lv1" });
    expect(res.ok).toBe(true);

    const levCalls = h.http.callsTo("/fapi/v1/leverage").filter((c) => c.method === "POST");
    expect(levCalls).toHaveLength(1);
    const levQ = new URLSearchParams(levCalls[0].url.split("?")[1]);
    expect(levQ.get("symbol")).toBe("BTCUSDT");
    expect(levQ.get("leverage")).toBe("20");
    // The order still goes out after the successful sync.
    expect(placeCalls(h)).toHaveLength(1);
  });

  test("no leverage call when leverage is absent; explicit 1x is still synced", async () => {
    const h = setup();
    h.http.route("/fapi/v1/leverage", () => jsonRes({ leverage: 1, maxNotionalValue: "1000000" }));
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "lv2", type: "MARKET", status: "NEW" })));

    await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "lv2" });
    await h.svc.submitOrder({ symbol: "BTCUSDT", side: "SELL", type: "MARKET", qty: "0.001", leverage: 1, clientOrderId: "lv3" });
    const levCalls = h.http.callsTo("/fapi/v1/leverage").filter((c) => c.method === "POST");
    expect(levCalls).toHaveLength(1);
    const levQ = new URLSearchParams(levCalls[0].url.split("?")[1]);
    expect(levQ.get("leverage")).toBe("1");
  });

  test("out-of-bracket leverage (-4028) rejects the order without sending it", async () => {
    const h = setup({ risk: { ...makeCfg().risk, maxLeverage: 100 } });
    h.http.scriptApiError("/fapi/v1/leverage", -4028, "Leverage 100 is not valid for BTCUSDT", 400);

    const res = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", leverage: 100, clientOrderId: "lv4" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not available");
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("invalid leverage values are ignored (no sync, no rejection)", async () => {
    const h = setup();
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "lv5", type: "MARKET", status: "NEW" })));

    const res = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", leverage: 0, clientOrderId: "lv5" });
    expect(res.ok).toBe(true);
    expect(h.http.callsTo("/fapi/v1/leverage")).toHaveLength(0);
  });

  test("stale or missing market data rejects orders fail-closed", async () => {
    const stale = setup({}, { getReferencePrice: async () => ({ price: "50000", at: Date.now() - 31_000 }) });
    const staleRes = await stale.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "st1" });
    expect(staleRes.ok).toBe(false);
    expect(staleRes.error).toContain("stale");
    expect(placeCalls(stale)).toHaveLength(0);
    expect(findByClientOrderId("st1")).toBeNull();

    const missing = setup({}, { getReferencePrice: async () => null });
    const missingRes = await missing.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "st2" });
    expect(missingRes.ok).toBe(false);
    expect(missingRes.error).toContain("No reference price");
    expect(placeCalls(missing)).toHaveLength(0);
    expect(findByClientOrderId("st2")).toBeNull();
  });

  test("limit price outside the collar is rejected", async () => {
    const h = setup();
    const res = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", qty: "0.001", price: "60000", clientOrderId: "cl1" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("collar");
  });

  test("duplicate clientOrderId is refused and never double-submitted", async () => {
    const h = setup();
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "dup1", status: "NEW" })));
    const first = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "dup1" });
    expect(first.ok).toBe(true);
    const second = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "dup1" });
    expect(second).toMatchObject({ ok: false, duplicate: true });
    expect(second.error).toContain("Duplicate");
    expect(placeCalls(h)).toHaveLength(1);
  });

  test("exchange rejection (-2010) marks the intent REJECTED", async () => {
    const h = setup();
    h.http.scriptApiError("/fapi/v1/order", -2010, "New order rejected", 400);
    const res = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "rj1" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("New order rejected");
    expect(findByClientOrderId("rj1")?.status).toBe("REJECTED");
    expect(h.freezes).toHaveLength(0);
  });

  test("invalid API key (-2015) freezes submissions fail-closed", async () => {
    const h = setup();
    h.http.scriptApiError("/fapi/v1/order", -2015, "Invalid API-key", 401);
    const res = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "ky1" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("frozen");
    expect(h.freezes.length).toBe(1);
    expect(findByClientOrderId("ky1")?.status).toBe("REJECTED");
    // Subsequent submissions stay blocked while frozen.
    const next = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "ky2" });
    expect(next.ok).toBe(false);
  });

  test("submission timeout: TIMEOUT_UNKNOWN + freeze, then resolved to FILLED via exchange truth", async () => {
    const h = setup();
    h.http.scriptTimeout("/fapi/v1/order");
    h.http.route("/fapi/v1/order", () =>
      jsonRes(orderFixture({ clientOrderId: "to1", status: "FILLED", executedQty: "0.001", avgPrice: "50000" })),
    );
    const res = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "to1" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("timed out");
    expect(findByClientOrderId("to1")?.status).toBe("TIMEOUT_UNKNOWN");
    expect(h.freezes.length).toBe(1);
    await flush();
    expect(findByClientOrderId("to1")?.status).toBe("FILLED");
    // The placeOrder call happened exactly once: no blind retry.
    expect(placeCalls(h)).toHaveLength(1);
  });

  test("HTTP 5xx submission is uncertain, frozen, and resolved by later exchange truth", async () => {
    const h = setup();
    h.http.scriptApiError("/fapi/v1/order", -1000, "Internal error", 503);
    h.http.scriptApiError("/fapi/v1/order", -1000, "Status query unavailable", 503);
    const res = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "u5xx" });
    expect(res.ok).toBe(false);
    await flush();
    expect(findByClientOrderId("u5xx")?.status).toBe("UNCERTAIN");
    expect(h.freezes).toHaveLength(1);

    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "u5xx", status: "FILLED", executedQty: "0.001", avgPrice: "50000" })));
    await h.svc.resolveUnknownOutcome("u5xx");
    expect(findByClientOrderId("u5xx")?.status).toBe("FILLED");
  });

  test("submission timeout resolving to not-found ends REJECTED", async () => {
    const h = setup();
    h.http.scriptTimeout("/fapi/v1/order");
    h.http.scriptApiError("/fapi/v1/order", -2013, "Order does not exist", 400);
    h.http.scriptApiError("/fapi/v1/order", -2013, "Order does not exist", 400);
    h.http.scriptApiError("/fapi/v1/order", -2013, "Order does not exist", 400);
    const res = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "to2" });
    expect(res.ok).toBe(false);
    await flush();
    expect(findByClientOrderId("to2")?.status).toBe("REJECTED");
    expect(placeCalls(h)).toHaveLength(1);
  });
});

describe("cancel flows and races", () => {
  async function submitWorking(h: Harness, id: string): Promise<void> {
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: id, status: "NEW", type: "LIMIT", price: "50000" })));
    const res = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", qty: "0.001", price: "50000", clientOrderId: id });
    expect(res.ok).toBe(true);
  }

  test("plain cancel succeeds", async () => {
    const h = setup();
    await submitWorking(h, "cx1");
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "cx1", status: "CANCELED" })));
    const res = await h.svc.cancelOrder("cx1", "BTCUSDT");
    expect(res.ok).toBe(true);
    expect(findByClientOrderId("cx1")?.status).toBe("CANCELED");
  });

  test("cancel/fill race: -2011 resolves to FILLED via order query", async () => {
    const h = setup();
    await submitWorking(h, "cx2");
    h.http.scriptApiError("/fapi/v1/order", -2011, "Unknown order sent", 400);
    h.http.route("/fapi/v1/order", () =>
      jsonRes(orderFixture({ clientOrderId: "cx2", status: "FILLED", executedQty: "0.001", avgPrice: "50000" })),
    );
    const res = await h.svc.cancelOrder("cx2", "BTCUSDT");
    expect(res.ok).toBe(true);
    expect(res.status).toBe("FILLED");
    expect(findByClientOrderId("cx2")?.status).toBe("FILLED");
    expect(h.freezes).toHaveLength(0);
  });

  test("cancel/fill race: -2011 with no exchange record resolves cleanly", async () => {
    const h = setup();
    await submitWorking(h, "cx3");
    h.http.scriptApiError("/fapi/v1/order", -2011, "Unknown order sent", 400);
    h.http.scriptApiError("/fapi/v1/order", -2013, "Order does not exist", 400);
    const res = await h.svc.cancelOrder("cx3", "BTCUSDT");
    expect(res.ok).toBe(true);
    expect(res.status).toBe("RESOLVED");
    expect(findByClientOrderId("cx3")?.status).toBe("RESOLVED");
  });

  test("HTTP 5xx cancel is uncertain, frozen, and verified against exchange truth", async () => {
    const h = setup();
    await submitWorking(h, "cx5xx");
    h.http.scriptApiError("/fapi/v1/order", -1000, "Internal error", 503);
    h.http.scriptApiError("/fapi/v1/order", -1000, "Status query unavailable", 503);
    const res = await h.svc.cancelOrder("cx5xx", "BTCUSDT");
    expect(res.ok).toBe(false);
    await flush();
    expect(findByClientOrderId("cx5xx")?.status).toBe("CANCEL_UNKNOWN");
    expect(h.freezes).toHaveLength(1);

    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "cx5xx", status: "CANCELED" })));
    await h.svc.resolveUnknownOutcome("cx5xx");
    expect(findByClientOrderId("cx5xx")?.status).toBe("CANCELED");
  });

  test("cancel timeout freezes and resolves against exchange truth", async () => {
    const h = setup();
    await submitWorking(h, "cx4");
    h.http.scriptTimeout("/fapi/v1/order");
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "cx4", status: "CANCELED" })));
    const res = await h.svc.cancelOrder("cx4", "BTCUSDT");
    expect(res.ok).toBe(false);
    expect(findByClientOrderId("cx4")?.status).toBe("CANCEL_UNKNOWN");
    expect(h.freezes.length).toBe(1);
    await flush();
    expect(findByClientOrderId("cx4")?.status).toBe("CANCELED");
  });

  test("cancelling an already-terminal intent is a no-op", async () => {
    const h = setup();
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "cx5", status: "FILLED", executedQty: "0.001", avgPrice: "50000" })));
    await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", qty: "0.001", price: "50000", clientOrderId: "cx5" });
    expect(findByClientOrderId("cx5")?.status).toBe("FILLED");
    const callsBefore = h.http.calls.length;
    const res = await h.svc.cancelOrder("cx5", "BTCUSDT");
    expect(res.ok).toBe(true);
    expect(res.error).toBe("already terminal");
    expect(h.http.calls.length).toBe(callsBefore);
  });

  test("cancel without intent fails without exchange traffic", async () => {
    const h = setup();
    const res = await h.svc.cancelOrder("ghost", "BTCUSDT");
    expect(res.ok).toBe(false);
    expect(h.http.calls).toHaveLength(0);
  });
});

describe("position close and native protection", () => {
  test.each(["STOP_MARKET", "TAKE_PROFIT_MARKET"] as const)(
    "%s uses only the Algo Order API",
    async (type) => {
      const h = setup({ risk: { ...makeCfg().risk, maxOrderNotionalUsd: 100 } });
      mockProtectionExchange(h);
      const clientOrderId = `standalone-${type.toLowerCase()}`;
      const res = await h.svc.submitOrder({
        symbol: "BTCUSDT",
        side: type === "STOP_MARKET" ? "SELL" : "BUY",
        type,
        qty: "0.001",
        stopPrice: type === "STOP_MARKET" ? "49000" : "51000",
        clientOrderId,
      });

      expect(res.ok).toBe(true);
      expect(algoPlaceCalls(h)).toHaveLength(1);
      expect(h.http.callsTo("/fapi/v1/order").filter((call) => call.method === "POST")).toHaveLength(0);
      const params = queryOf(algoPlaceCalls(h)[0]);
      expect(params.get("clientAlgoId")).toBe(clientOrderId);
      expect(params.get("triggerPrice")).toBe(type === "STOP_MARKET" ? "49000" : "51000");
    },
  );

  test("-4120 is surfaced as a loud Algo API configuration error", async () => {
    const h = setup();
    mockProtectionExchange(h);
    h.http.scriptApiError("/fapi/v1/algoOrder", -4120, "Order type not supported on this endpoint", 400);

    const result = await h.svc.submitOrder({
      symbol: "BTCUSDT",
      side: "SELL",
      type: "STOP_MARKET",
      qty: "0.001",
      stopPrice: "49000",
      clientOrderId: "algo-required",
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: -4120,
      failureKind: "definite_rejection",
    });
    expect(result.error).toContain("Algo Order API");
    expect(findByClientOrderId("algo-required")?.status).toBe("REJECTED");
    expect(getDb().prepare("SELECT action FROM audit_log WHERE action = ?").get("order.rejected.algo_api_configuration")).toBeTruthy();
  });

  test("removeProtection cancels Algo orders and deletes the intent", async () => {
    const h = setup();
    const exchange = mockProtectionExchange(h, [
      orderFixture({
        clientOrderId: "remove-tp",
        type: "TAKE_PROFIT_MARKET",
        side: "SELL",
        stopPrice: "52000",
        closePosition: true,
      }),
      orderFixture({
        clientOrderId: "remove-sl",
        type: "STOP_MARKET",
        side: "SELL",
        stopPrice: "48000",
        closePosition: true,
      }),
    ]);
    saveProtectionIntent({ symbol: "BTCUSDT", side: "long", tpPrice: "52000", slPrice: "48000" });

    const result = await h.svc.removeProtection("BTCUSDT");

    expect(result).toEqual({ ok: true });
    expect(exchange.algoOrders).toHaveLength(0);
    expect(h.http.callsTo("/fapi/v1/algoOrder").filter((call) => call.method === "DELETE")).toHaveLength(2);
    expect(h.http.callsTo("/fapi/v1/order").filter((call) => call.method === "DELETE")).toHaveLength(0);
    expect(getProtectionIntent("BTCUSDT")).toBeNull();
  });

  test("closePosition submits reduce-only MARKET on the opposite side", async () => {
    const h = setup();
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT",
      side: "long",
      qty: "0.002",
      entryPrice: "49000",
      markPrice: "50000",
      unrealizedProfit: "2",
      leverage: "1",
      liquidationPrice: "0",
      notional: "100",
      updatedAt: 1,
    });
    h.http.route("/fapi/v2/positionRisk", () => jsonRes([{ symbol: "BTCUSDT", positionAmt: "0.002", entryPrice: "49000", markPrice: "50000", unRealizedProfit: "2", liquidationPrice: "0", leverage: "1", positionSide: "BOTH" }]));
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "cls-x", type: "MARKET", status: "FILLED" })));
    saveProtectionIntent({ symbol: "BTCUSDT", side: "long", tpPrice: "52000", slPrice: "48000" });
    const res = await h.svc.closePosition("BTCUSDT");

    expect(res.ok).toBe(true);
    expect(getProtectionIntent("BTCUSDT")).toBeNull();
    const q = queryOf(placeCalls(h)[0]);
    expect(q.get("side")).toBe("SELL");
    expect(q.get("type")).toBe("MARKET");
    expect(q.get("reduceOnly")).toBe("true");
    expect(q.get("closePosition")).toBeNull();
    expect(q.get("quantity")).toBe("0.002");
    expect(q.get("newClientOrderId")?.startsWith("cls")).toBe(true);

    const noPos = await h.svc.closePosition("ETHUSDT");
    expect(noPos.ok).toBe(false);
  });

  test("emergency close deletes protection intent after the close is accepted", async () => {
    const h = setup();
    h.http.route("/fapi/v2/positionRisk", () => jsonRes([
      { symbol: "BTCUSDT", positionAmt: "0.002", entryPrice: "49000", markPrice: "50000", unRealizedProfit: "2", liquidationPrice: "0", leverage: "1", positionSide: "BOTH" },
    ]));
    h.http.route("/fapi/v1/allOpenOrders", () => jsonRes([]));
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "em-x", type: "MARKET", status: "FILLED" })));
    saveProtectionIntent({ symbol: "BTCUSDT", side: "long", tpPrice: "52000", slPrice: "48000" });

    const result = await h.svc.emergencyClosePosition("BTCUSDT");

    expect(result.ok).toBe(true);
    expect(getProtectionIntent("BTCUSDT")).toBeNull();
  });

  test("closePosition retries without reduceOnly when testnet rejects -2022 with no open orders", async () => {
    const h = setup();
    h.http.route("/fapi/v2/positionRisk", () => jsonRes([{ symbol: "BTCUSDT", positionAmt: "0.002", entryPrice: "49000", markPrice: "50000", unRealizedProfit: "2", liquidationPrice: "0", leverage: "1", positionSide: "BOTH" }]));
    h.http.route("/fapi/v1/openOrders", () => jsonRes([]));
    // First POST carries reduceOnly and is rejected exactly like testnet does;
    // the immediate retry drops the flag and succeeds.
    h.http.script("/fapi/v1/order", () => jsonRes({ code: -2022, msg: "ReduceOnly Order is rejected." }, 400));
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "cls-fallback", type: "MARKET", status: "FILLED" })));

    const res = await h.svc.closePosition("BTCUSDT");

    expect(res.ok).toBe(true);
    const posts = placeCalls(h);
    expect(posts).toHaveLength(2);
    const first = queryOf(posts[0]);
    const second = queryOf(posts[1]);
    expect(first.get("reduceOnly")).toBe("true");
    expect(second.get("reduceOnly")).toBeNull();
    expect(second.get("quantity")).toBe("0.002");
  });

  test("closePosition keeps the -2022 rejection when open orders could conflict", async () => {
    const h = setup();
    h.http.route("/fapi/v2/positionRisk", () => jsonRes([{ symbol: "BTCUSDT", positionAmt: "0.002", entryPrice: "49000", markPrice: "50000", unRealizedProfit: "2", liquidationPrice: "0", leverage: "1", positionSide: "BOTH" }]));
    h.http.route("/fapi/v1/openOrders", () => jsonRes([orderFixture({ clientOrderId: "conflicting", status: "NEW" })]));
    h.http.route("/fapi/v1/order", () => jsonRes({ code: -2022, msg: "ReduceOnly Order is rejected." }, 400));

    const res = await h.svc.closePosition("BTCUSDT");

    expect(res.ok).toBe(false);
    expect(res.error).toContain("ReduceOnly Order is rejected");
    expect(placeCalls(h)).toHaveLength(1);
  });

  test("protectPosition uses genuine exchange conditional orders with closePosition=true", async () => {
    const h = setup();
    mockProtectionExchange(h);
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT",
      side: "short",
      qty: "0.001",
      entryPrice: "50000",
      markPrice: "49000",
      unrealizedProfit: "1",
      leverage: "1",
      liquidationPrice: "0",
      notional: "50",
      updatedAt: 1,
    });
    const out = await h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "45000.5", slPrice: "52000.5" });
    expect(out.tp).toMatchObject({ ok: true });
    expect(out.sl?.ok).toBe(true);
    const posts = algoPlaceCalls(h).map((c) => queryOf(c));
    const tp = posts.find((q) => q.get("type") === "TAKE_PROFIT_MARKET");
    const sl = posts.find((q) => q.get("type") === "STOP_MARKET");
    expect(tp).toBeDefined();
    expect(sl).toBeDefined();
    expect(tp?.get("closePosition")).toBe("true");
    expect(sl?.get("closePosition")).toBe("true");
    expect(tp?.get("triggerPrice")).toBe("45000.5");
    expect(sl?.get("triggerPrice")).toBe("52000.5");
    expect(tp?.get("side")).toBe("BUY"); // short position closes via BUY
    // closePosition=true orders never carry a quantity.
    expect(tp?.get("quantity")).toBeNull();
  });

  test("invalid immediate TP price leaves existing protection untouched", async () => {
    const h = setup();
    const exchange = mockProtectionExchange(h, [
      orderFixture({
        clientOrderId: "old-tp-invalid",
        type: "TAKE_PROFIT_MARKET",
        side: "SELL",
        stopPrice: "51000",
        closePosition: true,
      }),
    ]);
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });
    const out = await h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "50000" });
    expect(out.tp?.ok).toBe(false);
    expect(out.tp?.error).toContain("immediately-triggering");
    expect(exchange.orders.map((order) => order.clientAlgoId)).toEqual(["old-tp-invalid"]);
    expect(h.http.callsTo("/fapi/v1/algoOrder").filter((call) => call.method === "DELETE")).toHaveLength(0);
  });

  test("short SL below mark is rejected before exchange traffic", async () => {
    const h = setup();
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "short", qty: "0.001", entryPrice: "51000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });
    const out = await h.svc.protectPosition({ symbol: "BTCUSDT", slPrice: "49999" });
    expect(out.sl?.ok).toBe(false);
    expect(out.sl?.error).toContain("Short SL");
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("stale mark price is refreshed over REST before protection replacement", async () => {
    const h = setup({}, {
      getMarkPrice: async () => ({ price: "50000", at: Date.now() - 11_000 }),
    });
    const exchange = mockProtectionExchange(h, [
      orderFixture({
        clientOrderId: "old-tp-stale-mark",
        type: "TAKE_PROFIT_MARKET",
        side: "SELL",
        stopPrice: "51000",
        closePosition: true,
      }),
    ]);
    h.http.route("/fapi/v1/premiumIndex", () =>
      jsonRes({ symbol: "BTCUSDT", markPrice: "50000", time: Date.now() }),
    );
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });

    const out = await h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "52000" });

    expect(out.tp?.ok).toBe(true);
    expect(h.http.callsTo("/fapi/v1/premiumIndex")).toHaveLength(1);
    expect(h.http.callsTo("/fapi/v1/algoOrder").filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  test("failed fresh-mark fetch rejects before canceling existing protection", async () => {
    const h = setup({}, {
      getMarkPrice: async () => ({ price: "50000", at: Date.now() - 11_000 }),
    });
    const exchange = mockProtectionExchange(h, [
      orderFixture({
        clientOrderId: "old-tp-mark-failure",
        type: "TAKE_PROFIT_MARKET",
        side: "SELL",
        stopPrice: "51000",
        closePosition: true,
      }),
    ]);
    h.http.scriptApiError("/fapi/v1/premiumIndex", -1000, "mark unavailable");
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });

    const out = await h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "52000" });

    expect(out.tp?.ok).toBe(false);
    expect(out.tp?.error).toContain("Unable to fetch a fresh mark price");
    expect(exchange.orders.map((order) => order.clientAlgoId)).toEqual(["old-tp-mark-failure"]);
    expect(h.http.callsTo("/fapi/v1/algoOrder").filter((call) => call.method === "DELETE" || call.method === "POST")).toHaveLength(0);
  });

  test("rollback skips an old stop passed by the market and alerts high severity", async () => {
    let mark = "50000";
    const h = setup(
      { alertWebhookUrl: "https://alerts.example.test/hook" },
      { getMarkPrice: async () => ({ price: mark, at: Date.now() }) },
    );
    resetServerConfigForTests(h.cfg);
    const exchange = mockProtectionExchange(h, [
      orderFixture({
        clientOrderId: "old-sl-passed",
        type: "STOP_MARKET",
        side: "SELL",
        stopPrice: "49000",
        closePosition: true,
      }),
    ]);
    exchange.failPostPrices(["48000"], () => {
      mark = "48000";
    });
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "50000", markPrice: "50000",
      unrealizedProfit: "0", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    try {
      const out = await h.svc.protectPosition({ symbol: "BTCUSDT", slPrice: "48000" });

      expect(out.sl?.ok).toBe(false);
      expect(out.sl?.error).toContain("Exchange rejected the order");
      expect(algoPlaceCalls(h)).toHaveLength(1);
      expect(getProtectionIntent("BTCUSDT")).toMatchObject({
        status: "PENDING_REPLACE",
        protectionStatus: "UNPROTECTED",
        previousSlPrice: "49000",
      });
      expect(fetchSpy.mock.calls.some(([, init]) => String(init?.body).includes('"severity":"high"'))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("protective cancel failure leaves the old order and submits no replacement", async () => {
    const h = setup();
    const exchange = mockProtectionExchange(h, [
      orderFixture({
        clientOrderId: "old-tp-fail",
        type: "TAKE_PROFIT_MARKET",
        side: "SELL",
        stopPrice: "51000",
        closePosition: true,
      }),
    ]);
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });
    liveState().openOrders.set("old-tp-fail", {
      clientOrderId: "old-tp-fail", exchangeOrderId: 78, kind: "algo", symbol: "BTCUSDT", side: "SELL",
      type: "TAKE_PROFIT_MARKET", status: "NEW", price: "0", stopPrice: "51000", origQty: "0",
      executedQty: "0", avgPrice: "0", reduceOnly: false, closePosition: true, time: 1, updateTime: 1,
    });
    createIntent({ clientOrderId: "old-tp-fail", kind: "algo", symbol: "BTCUSDT", side: "SELL", type: "TAKE_PROFIT_MARKET", qty: "" });
    updateIntent("old-tp-fail", { status: "SUBMITTED" });
    h.http.scriptApiError("/fapi/v1/algoOrder", -1000, "cancel unavailable", 400);
    const out = await h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "52000" });
    expect(out.tp?.ok).toBe(false);
    expect(out.tp?.error).toContain("replacement blocked");
    expect(placeCalls(h)).toHaveLength(0);
    expect(exchange.orders.map((order) => order.clientAlgoId)).toEqual(["old-tp-fail"]);
  });

  test("protectPosition cancels the existing protection of the same type first", async () => {
    const h = setup();
    const exchange = mockProtectionExchange(h, [
      orderFixture({
        clientOrderId: "old-tp",
        orderId: 77,
        type: "TAKE_PROFIT_MARKET",
        side: "SELL",
        stopPrice: "51000",
        closePosition: true,
      }),
    ]);
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT",
      side: "long",
      qty: "0.001",
      entryPrice: "49000",
      markPrice: "50000",
      unrealizedProfit: "1",
      leverage: "1",
      liquidationPrice: "0",
      notional: "50",
      updatedAt: 1,
    });
    liveState().openOrders.set("old-tp", {
      clientOrderId: "old-tp",
      exchangeOrderId: 77,
      kind: "algo",
      symbol: "BTCUSDT",
      side: "SELL",
      type: "TAKE_PROFIT_MARKET",
      status: "NEW",
      price: "0",
      stopPrice: "51000",
      origQty: "0",
      executedQty: "0",
      avgPrice: "0",
      reduceOnly: false,
      closePosition: true,
      time: 1,
      updateTime: 1,
    });
    createIntent({ clientOrderId: "old-tp", kind: "algo", symbol: "BTCUSDT", side: "SELL", type: "TAKE_PROFIT_MARKET", qty: "" });
    updateIntent("old-tp", { status: "SUBMITTED" });
    await h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "55000.5" });
    const deletes = h.http.callsTo("/fapi/v1/algoOrder").filter((c) => c.method === "DELETE");
    expect(deletes.length).toBe(1);
    expect(queryOf(deletes[0]).get("clientAlgoId")).toBe("old-tp");
    expect(exchange.orders).toHaveLength(1);
    expect(exchange.orders[0].triggerPrice).toBe("55000.5");
  });

  test("definite placement rejection rolls back once without retrying", async () => {
    const h = setup();
    const exchange = mockProtectionExchange(h, [
      orderFixture({
        clientOrderId: "rollback-old-tp",
        type: "TAKE_PROFIT_MARKET",
        side: "SELL",
        stopPrice: "51000",
        closePosition: true,
      }),
    ]);
    exchange.failPosts(1);
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });

    const out = await h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "52000" });

    expect(out.tp).toMatchObject({
      ok: false,
      error: "Exchange rejected the order: simulated protective placement failure",
      failureKind: "definite_rejection",
    });
    expect(algoPlaceCalls(h).map((call) => queryOf(call).get("triggerPrice"))).toEqual(["52000", "51000"]);
    expect(h.http.callsTo("/fapi/v1/algoOrder").filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(exchange.orders).toHaveLength(1);
    expect(exchange.orders[0].triggerPrice).toBe("51000");
    expect(getProtectionIntent("BTCUSDT")).toMatchObject({
      status: "CONFIRMED",
      protectionStatus: "PROTECTED",
      tpPrice: "51000",
    });
  });

  test("429 Retry-After is honored before replacement rollback", async () => {
    const h = setup();
    const exchange = mockProtectionExchange(h, [
      orderFixture({
        clientOrderId: "rate-limit-old-tp",
        type: "TAKE_PROFIT_MARKET",
        side: "SELL",
        stopPrice: "51000",
        closePosition: true,
      }),
    ]);
    const waits: number[] = [];
    h.rest.setSleeperForTests(async (ms) => { waits.push(ms); });
    exchange.respondToPost(429, -1003, "Too many requests", { "Retry-After": "2" });
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });

    const result = await h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "52000" });

    expect(result.tp?.ok).toBe(false);
    expect(waits).toEqual([2000]);
    expect(algoPlaceCalls(h).map((call) => queryOf(call).get("triggerPrice"))).toEqual(["52000", "51000"]);
    expect(exchange.algoOrders.map((order) => order.triggerPrice)).toEqual(["51000"]);
  });

  test("418 stops replacement retries and marks protection UNPROTECTED", async () => {
    const h = setup();
    const exchange = mockProtectionExchange(h, [
      orderFixture({
        clientOrderId: "ban-old-tp",
        type: "TAKE_PROFIT_MARKET",
        side: "SELL",
        stopPrice: "51000",
        closePosition: true,
      }),
    ]);
    exchange.respondToPost(418, -1003, "IP banned", { "Retry-After": "60" });
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });

    const result = await h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "52000" });

    expect(result.tp?.ok).toBe(false);
    expect(algoPlaceCalls(h)).toHaveLength(1);
    expect(exchange.algoOrders).toHaveLength(0);
    expect(getProtectionIntent("BTCUSDT")).toMatchObject({
      status: "PENDING_REPLACE",
      protectionStatus: "UNPROTECTED",
    });
    expect(h.freezes.join(" ")).toContain("HTTP 418");
  });

  test("transient placement failure retries once without canceling a restored order", async () => {
    const h = setup();
    const exchange = mockProtectionExchange(h, [
      orderFixture({
        clientOrderId: "transient-old-tp",
        type: "TAKE_PROFIT_MARKET",
        side: "SELL",
        stopPrice: "51000",
        closePosition: true,
      }),
    ]);
    exchange.throwOnPosts([new TransportTimeoutError("new TP timed out")]);
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });

    const out = await h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "52000" });

    expect(out.tp?.ok).toBe(true);
    expect(algoPlaceCalls(h).map((call) => queryOf(call).get("triggerPrice"))).toEqual(["52000", "52000"]);
    expect(h.http.callsTo("/fapi/v1/algoOrder").filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(exchange.orders.map((order) => order.triggerPrice)).toEqual(["52000"]);
  });

  test("transient failure followed by retry rejection rolls back without another cancel", async () => {
    const h = setup();
    const exchange = mockProtectionExchange(h, [
      orderFixture({
        clientOrderId: "transient-rollback-old-tp",
        type: "TAKE_PROFIT_MARKET",
        side: "SELL",
        stopPrice: "51000",
        closePosition: true,
      }),
    ]);
    exchange.throwOnPosts([new TransportTimeoutError("first TP timed out")]);
    exchange.failPostPrices(["52000"]);
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });

    const out = await h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "52000" });

    expect(out.tp?.ok).toBe(false);
    expect(algoPlaceCalls(h).map((call) => queryOf(call).get("triggerPrice"))).toEqual(["52000", "52000", "51000"]);
    expect(h.http.callsTo("/fapi/v1/algoOrder").filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(exchange.orders.map((order) => order.triggerPrice)).toEqual(["51000"]);
  });

  test("concurrent protect requests for one symbol do not interleave", async () => {
    let releaseFirstMark!: () => void;
    let markEntered!: () => void;
    const firstMark = new Promise<void>((resolve) => {
      releaseFirstMark = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let markCalls = 0;
    const h = setup({}, {
      getMarkPrice: async () => {
        markCalls += 1;
        if (markCalls === 1) {
          markEntered();
          await firstMark;
        }
        return { price: "50000", at: Date.now() };
      },
    });
    const exchange = mockProtectionExchange(h);
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });

    const first = h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "52000" });
    await entered;
    expect(isProtectionIntentLocked("BTCUSDT", persistenceProfileFromConfig(h.cfg))).toBe(true);
    const second = h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "53000" });
    await flush();
    expect(markCalls).toBe(1);

    releaseFirstMark();
    await Promise.all([first, second]);

    expect(algoPlaceCalls(h).map((call) => queryOf(call).get("triggerPrice"))).toEqual(["52000", "53000"]);
    expect(h.http.callsTo("/fapi/v1/algoOrder").filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(exchange.orders.map((order) => order.triggerPrice)).toEqual(["53000"]);
    expect(isProtectionIntentLocked("BTCUSDT", persistenceProfileFromConfig(h.cfg))).toBe(false);
  });

  test("CircuitBreakerOpenError after cancel marks protection unprotected and preserves pending intent", async () => {
    const h = setup({ alertWebhookUrl: "https://alerts.example.test/hook" });
    resetServerConfigForTests(h.cfg);
    const exchange = mockProtectionExchange(h, [
      orderFixture({
        clientOrderId: "breaker-old-tp",
        type: "TAKE_PROFIT_MARKET",
        side: "SELL",
        stopPrice: "51000",
        closePosition: true,
      }),
    ]);
    exchange.throwOnPosts([
      new CircuitBreakerOpenError("REST breaker opened mid-replace", "binance-rest", Date.now()),
    ]);
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    try {
      await expect(h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "52000" }))
        .rejects.toThrow(CircuitBreakerOpenError);
      await flush();

      expect(exchange.orders).toHaveLength(0);
      expect(getProtectionIntent("BTCUSDT")).toMatchObject({
        status: "PENDING_REPLACE",
        protectionStatus: "UNPROTECTED",
        previousTpPrice: "51000",
        restoreAttemptedAt: 0,
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://alerts.example.test/hook",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("failed replacement with successful rollback reverts intent to previous prices", async () => {
    const h = setup();
    const exchange = mockProtectionExchange(h, [
      orderFixture({
        clientOrderId: "rollback-confirmed-tp",
        type: "TAKE_PROFIT_MARKET",
        side: "SELL",
        stopPrice: "51000",
        closePosition: true,
      }),
    ]);
    exchange.failPostPrices(["52000", "52000"]);
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });

    const out = await h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "52000" });

    expect(out.tp?.ok).toBe(false);
    expect(exchange.orders).toHaveLength(1);
    expect(exchange.orders[0].triggerPrice).toBe("51000");
    expect(getProtectionIntent("BTCUSDT")).toMatchObject({
      status: "CONFIRMED",
      protectionStatus: "PROTECTED",
      tpPrice: "51000",
      slPrice: null,
    });
  });

  test("two failed placements keep one attempted pending intent and never auto-loop", async () => {
    const h = setup();
    mockProtectionExchange(h).failPostPrices(["52000", "52000"]);
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });

    const out = await h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "52000" });
    const intent = getProtectionIntent("BTCUSDT")!;
    h.http.route("/fapi/v1/userTrades", () => jsonRes([]));
    const restoreProtection = jest.fn((pending: Parameters<typeof h.svc.restoreProtection>[0]) => h.svc.restoreProtection(pending));
    const recon = new Reconciler({
      persistenceProfile: persistenceProfileFromConfig(h.cfg),
      rest: h.rest,
      snapshot: async () => applyOpenOrdersSnapshot([]),
      freeze: () => undefined,
      unfreeze: () => undefined,
      restoreProtection,
    });

    await recon.run("failed-replacement");
    await recon.run("failed-replacement");

    expect(out.tp?.ok).toBe(false);
    expect(intent).toMatchObject({ status: "PENDING_REPLACE", protectionStatus: "UNPROTECTED" });
    expect(intent.restoreAttemptedAt).toBeGreaterThanOrEqual(intent.createdAt);
    expect(restoreProtection).not.toHaveBeenCalled();
    expect(algoPlaceCalls(h)).toHaveLength(1);
  });

  test("timeout is reconciled against open orders before the one retry", async () => {
    const h = setup();
    mockProtectionExchange(h);
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });
    h.http.scriptTimeout("/fapi/v1/algoOrder");

    const out = await h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "52000" });

    expect(out.tp).toMatchObject({ ok: true });
    const calls = h.http.calls;
    const firstPost = calls.findIndex((call) => call.method === "POST" && call.url.includes("/fapi/v1/algoOrder"));
    const secondPost = calls.findIndex((call, index) => index > firstPost && call.method === "POST" && call.url.includes("/fapi/v1/algoOrder"));
    const reconcileRead = calls.findIndex((call, index) => index > firstPost && call.url.includes("/fapi/v1/openAlgoOrders"));
    expect(reconcileRead).toBeGreaterThan(firstPost);
    expect(secondPost).toBeGreaterThan(reconcileRead);
  });

  test("failed placement and rollback mark position UNPROTECTED and alert", async () => {
    const h = setup({ alertWebhookUrl: "https://alerts.example.test/hook" });
    resetServerConfigForTests(h.cfg);
    const exchange = mockProtectionExchange(h, [
      orderFixture({
        clientOrderId: "unprotected-old-tp",
        type: "TAKE_PROFIT_MARKET",
        side: "SELL",
        stopPrice: "51000",
        closePosition: true,
      }),
    ]);
    exchange.failPosts(4);
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    try {
      const out = await h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "52000" });
      expect(out.tp?.ok).toBe(false);
      expect(getProtectionIntent("BTCUSDT")).toMatchObject({ status: "PENDING_REPLACE", protectionStatus: "UNPROTECTED", symbol: "BTCUSDT" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://alerts.example.test/hook",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("persisted protection intent is restored during reconciliation after a cancel-place crash", async () => {
    const h = setup();
    const exchange = mockProtectionExchange(h);
    setHealthSignal({ brokerStatus: "starting" });
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });
    savePendingProtectionIntent({
      symbol: "BTCUSDT",
      side: "long",
      tpPrice: "52000",
      slPrice: null,
      previousTpPrice: null,
      previousSlPrice: null,
    });
    h.http.route("/fapi/v1/userTrades", () => jsonRes([]));
    const recon = new Reconciler({
      persistenceProfile: persistenceProfileFromConfig(h.cfg),
      rest: h.rest,
      snapshot: async () => applyOpenOrdersSnapshot([], exchange.algoOrders as never),
      freeze: () => undefined,
      unfreeze: () => undefined,
      restoreProtection: (intent) => h.svc.restoreProtection(intent),
    });

    await recon.run("startup-test");
    await recon.run("startup-test");

    expect(exchange.orders).toHaveLength(1);
    expect(exchange.orders[0]).toMatchObject({
      orderType: "TAKE_PROFIT_MARKET",
      triggerPrice: "52000",
      closePosition: true,
    });
    expect(algoPlaceCalls(h)).toHaveLength(1);
    expect(getProtectionIntent("BTCUSDT")).toMatchObject({ status: "CONFIRMED", protectionStatus: "PROTECTED" });
  });

  test("reconciliation skips restoration while the symbol protection lock is held", async () => {
    const h = setup();
    mockProtectionExchange(h);
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });
    savePendingProtectionIntent({
      symbol: "BTCUSDT",
      side: "long",
      tpPrice: "52000",
      slPrice: null,
      previousTpPrice: null,
      previousSlPrice: null,
    });
    h.http.route("/fapi/v1/userTrades", () => jsonRes([]));
    const restoreProtection = jest.fn(async () => undefined);
    const recon = new Reconciler({
      persistenceProfile: persistenceProfileFromConfig(h.cfg),
      rest: h.rest,
      snapshot: async () => applyOpenOrdersSnapshot([]),
      freeze: () => undefined,
      unfreeze: () => undefined,
      restoreProtection,
    });

    await withProtectionIntentLock(
      "BTCUSDT",
      () => recon.run("protection-lock-held").then(() => undefined),
      persistenceProfileFromConfig(h.cfg),
    );

    expect(restoreProtection).not.toHaveBeenCalled();
    expect(placeCalls(h)).toHaveLength(0);
    expect(getProtectionIntent("BTCUSDT")).toMatchObject({ status: "PENDING_REPLACE" });
  });

  test("failed position snapshot leaves protection intents untouched", async () => {
    const h = setup();
    savePendingProtectionIntent({
      symbol: "BTCUSDT",
      side: "long",
      tpPrice: "52000",
      slPrice: null,
      previousTpPrice: null,
      previousSlPrice: null,
    });
    const recon = new Reconciler({
      persistenceProfile: persistenceProfileFromConfig(h.cfg),
      rest: h.rest,
      snapshot: async () => {
        throw new Error("position snapshot unavailable");
      },
      freeze: () => undefined,
      unfreeze: () => undefined,
    });

    const result = await recon.run("failed-position-snapshot");

    expect(result.result).toBe("error");
    expect(getProtectionIntent("BTCUSDT")).toMatchObject({ status: "PENDING_REPLACE" });
  });

  test("flat fill followed by same-symbol reopen cannot restore the old protection intent", async () => {
    const h = setup();
    const exchange = mockProtectionExchange(h);
    const event = (positionAmt: string) => ({
      e: "ACCOUNT_UPDATE" as const,
      E: Date.now(),
      T: Date.now(),
      a: {
        B: [],
        P: [{ s: "BTCUSDT", pa: positionAmt, ep: "50000", cr: "0", up: "0", mt: "cross", iw: "0", ps: "BOTH" as const }],
      },
    });
    applyAccountEvent(event("0.001"));
    savePendingProtectionIntent({
      symbol: "BTCUSDT",
      side: "long",
      tpPrice: "52000",
      slPrice: "48000",
      previousTpPrice: null,
      previousSlPrice: null,
    });
    applyAccountEvent(event("0"));
    applyAccountEvent(event("0.002"));
    h.http.route("/fapi/v1/userTrades", () => jsonRes([]));
    const restoreProtection = jest.fn(async () => undefined);
    const recon = new Reconciler({
      persistenceProfile: persistenceProfileFromConfig(h.cfg),
      rest: h.rest,
      snapshot: async () => applyOpenOrdersSnapshot([], exchange.algoOrders as never),
      freeze: () => undefined,
      unfreeze: () => undefined,
      restoreProtection,
    });

    await recon.run("same-symbol-reopen");

    expect(getProtectionIntent("BTCUSDT")).toBeNull();
    expect(restoreProtection).not.toHaveBeenCalled();
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("reconciliation alerts on missing protection and attempts restoration once", async () => {
    const h = setup({ alertWebhookUrl: "https://alerts.example.test/hook" });
    resetServerConfigForTests(h.cfg);
    mockProtectionExchange(h);
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });
    savePendingProtectionIntent({
      symbol: "BTCUSDT",
      side: "long",
      tpPrice: "52000",
      slPrice: null,
      previousTpPrice: null,
      previousSlPrice: null,
    });
    h.http.route("/fapi/v1/userTrades", () => jsonRes([]));
    const restoreProtection = jest.fn(async () => {
      throw new Error("restore unavailable");
    });
    const recon = new Reconciler({
      persistenceProfile: persistenceProfileFromConfig(h.cfg),
      rest: h.rest,
      snapshot: async () => applyOpenOrdersSnapshot([]),
      freeze: () => undefined,
      unfreeze: () => undefined,
      restoreProtection,
    });
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    try {
      await recon.run("interval-test");
      await recon.run("interval-test");

      expect(restoreProtection).toHaveBeenCalledTimes(1);
      expect(getProtectionIntent("BTCUSDT")).toMatchObject({ status: "PENDING_REPLACE", protectionStatus: "UNPROTECTED" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://alerts.example.test/hook",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("confirmed intent missing on Binance is alerted once and never restored", async () => {
    const h = setup({ alertWebhookUrl: "https://alerts.example.test/hook" });
    resetServerConfigForTests(h.cfg);
    mockProtectionExchange(h);
    liveState().positions.set("ETHUSDT", {
      symbol: "ETHUSDT", side: "long", qty: "1", entryPrice: "3000", markPrice: "3000",
      unrealizedProfit: "0", leverage: "1", liquidationPrice: "0", notional: "3000", updatedAt: Date.now(),
    });
    saveProtectionIntent({ symbol: "ETHUSDT", side: "long", tpPrice: "3200", slPrice: "2800" });
    h.http.route("/fapi/v1/userTrades", () => jsonRes([]));
    const restoreProtection = jest.fn(async () => undefined);
    const recon = new Reconciler({
      persistenceProfile: persistenceProfileFromConfig(h.cfg),
      rest: h.rest,
      snapshot: async () => applyOpenOrdersSnapshot([]),
      freeze: () => undefined,
      unfreeze: () => undefined,
      restoreProtection,
    });
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    try {
      await recon.run("confirmed-order-missing");
      await recon.run("confirmed-order-missing");

      expect(restoreProtection).not.toHaveBeenCalled();
      expect(placeCalls(h)).toHaveLength(0);
      expect(getProtectionIntent("ETHUSDT")).toMatchObject({ status: "CONFIRMED", protectionStatus: "UNPROTECTED" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("opposite-side position deletes the old protection intent without placing orders", async () => {
    const h = setup();
    mockProtectionExchange(h);
    liveState().positions.set("ETHUSDT", {
      symbol: "ETHUSDT", side: "short", qty: "1", entryPrice: "3000", markPrice: "3000",
      unrealizedProfit: "0", leverage: "1", liquidationPrice: "0", notional: "3000", updatedAt: Date.now(),
    });
    saveProtectionIntent({ symbol: "ETHUSDT", side: "long", tpPrice: "3200", slPrice: "2800" });
    h.http.route("/fapi/v1/userTrades", () => jsonRes([]));
    const recon = new Reconciler({
      persistenceProfile: persistenceProfileFromConfig(h.cfg),
      rest: h.rest,
      snapshot: async () => applyOpenOrdersSnapshot([]),
      freeze: () => undefined,
      unfreeze: () => undefined,
      restoreProtection: (intent) => h.svc.restoreProtection(intent),
    });

    await recon.run("opposite-position");

    expect(getProtectionIntent("ETHUSDT")).toBeNull();
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("expired pending replacement alerts but does not restore", async () => {
    const h = setup({ alertWebhookUrl: "https://alerts.example.test/hook" });
    resetServerConfigForTests(h.cfg);
    mockProtectionExchange(h);
    liveState().positions.set("ETHUSDT", {
      symbol: "ETHUSDT", side: "long", qty: "1", entryPrice: "3000", markPrice: "3000",
      unrealizedProfit: "0", leverage: "1", liquidationPrice: "0", notional: "3000", updatedAt: Date.now(),
    });
    savePendingProtectionIntent({
      symbol: "ETHUSDT",
      side: "long",
      tpPrice: "3200",
      slPrice: null,
      previousTpPrice: "3100",
      previousSlPrice: null,
    }, Date.now() - 130_000);
    h.http.route("/fapi/v1/userTrades", () => jsonRes([]));
    const restoreProtection = jest.fn(async () => undefined);
    const recon = new Reconciler({
      persistenceProfile: persistenceProfileFromConfig(h.cfg),
      rest: h.rest,
      snapshot: async () => applyOpenOrdersSnapshot([]),
      freeze: () => undefined,
      unfreeze: () => undefined,
      restoreProtection,
    });
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    try {
      await recon.run("expired-pending");
      await recon.run("expired-pending");

      expect(restoreProtection).not.toHaveBeenCalled();
      expect(placeCalls(h)).toHaveLength(0);
      expect(fetchSpy).toHaveBeenCalled();
      expect(getProtectionIntent("ETHUSDT")).toMatchObject({
        status: "PENDING_REPLACE",
        protectionStatus: "UNPROTECTED",
        previousTpPrice: "3100",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("execution gates inside OrderService", () => {
  test("kill switch blocks submission", async () => {
    const h = setup();
    setRuntime(RUNTIME_KEYS.killSwitch, "true");
    const res = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "ks1" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("kill switch");
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("frozen runtime blocks submission", async () => {
    const h = setup();
    setRuntime(RUNTIME_KEYS.frozen, "true");
    setRuntime(RUNTIME_KEYS.frozenReason, "drift");
    const res = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "fz1" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("drift");
  });

  test("shadow env can never submit", async () => {
    const h = setup({ env: "shadow" });
    const res = await h.svc.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "sh1" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("shadow mode is read-only");
  });

});

describe("server-side reverse position", () => {
  const project = () => reverseRiskSnapshot();
  const input = (clientOrderId: string, overrides: Record<string, unknown> = {}) => ({
    symbol: "BTCUSDT",
    newQty: "0.001",
    expectedPositionQty: "0.001",
    expectedPositionSide: "long" as const,
    clientOrderId,
    ...overrides,
  });

  test("success submits one combined market order and confirms the requested position", async () => {
    const h = setup({}, { projectReverseRisk: project });
    installReverseExchange(h);

    const result = await h.svc.reversePosition(input("reverse-success"));

    expect(result).toMatchObject({ ok: true, resultingPosition: { side: "short", qty: "0.001" } });
    expect(placeCalls(h)).toHaveLength(1);
    expect(queryOf(placeCalls(h)[0]).get("quantity")).toBe("0.002");
  });

  test("partial fill reports actual position and freezes further submissions", async () => {
    const h = setup({}, { projectReverseRisk: project });
    installReverseExchange(h, { resultingQty: "-0.0005" });

    const result = await h.svc.reversePosition(input("reverse-partial"));

    expect(result).toMatchObject({ ok: false, resultingPosition: { side: "short", qty: "0.0005" } });
    expect(h.freezes.some((reason) => reason.includes("reverse position outcome uncertain"))).toBe(true);
    expect(placeCalls(h)).toHaveLength(1);
  });

  test("definite rejection preserves the position and old protection without retry", async () => {
    const protective = orderFixture({
      clientOrderId: "old-sl",
      side: "SELL",
      type: "STOP_MARKET",
      closePosition: true,
      stopPrice: "45000",
    });
    const h = setup({}, { projectReverseRisk: project });
    installReverseExchange(h, { rejected: true, protectiveOrders: [protective] });

    const result = await h.svc.reversePosition(input("reverse-rejected"));

    expect(result).toMatchObject({ ok: false, resultingPosition: { side: "long", qty: "0.001" } });
    expect(placeCalls(h)).toHaveLength(1);
    expect(h.http.callsTo("/fapi/v1/order").filter((call) => call.method === "DELETE")).toHaveLength(0);
  });

  test("timeout reconciles without an automatic retry", async () => {
    const h = setup({}, { projectReverseRisk: project });
    installReverseExchange(h);
    h.http.scriptTimeout("/fapi/v1/order");

    const result = await h.svc.reversePosition(input("reverse-timeout"));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
    expect(placeCalls(h)).toHaveLength(1);
    expect(h.freezes.some((reason) => reason.includes("reverse position outcome uncertain"))).toBe(true);
  });

  test("stale UI position is rejected before submitting", async () => {
    const h = setup({}, { projectReverseRisk: project });
    installReverseExchange(h);

    const result = await h.svc.reversePosition(input("reverse-stale", { expectedPositionQty: "0.002" }));

    expect(result.error).toContain("Position changed since it was displayed");
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("same idempotency key cannot submit a second flip", async () => {
    const h = setup({}, { projectReverseRisk: project });
    installReverseExchange(h);

    const [first, second] = await Promise.all([
      h.svc.reversePosition(input("reverse-double-click")),
      h.svc.reversePosition(input("reverse-double-click")),
    ]);

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, duplicate: true });
    expect(placeCalls(h)).toHaveLength(1);
  });

  test("risk projection failure blocks the order", async () => {
    const h = setup({}, { projectReverseRisk: () => reverseRiskSnapshot({ marginDataFresh: false }) });
    installReverseExchange(h);

    const result = await h.svc.reversePosition(input("reverse-risk-fail"));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("margin or liquidation data is unavailable or stale");
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("hedge mode is rejected", async () => {
    const h = setup({}, { projectReverseRisk: project });
    installReverseExchange(h, { dualSidePosition: true });

    const result = await h.svc.reversePosition(input("reverse-hedge"));

    expect(result.error).toContain("one-way position mode");
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("current leverage above the configured cap is rejected", async () => {
    const baseCfg = makeCfg();
    const h = setup(
      { risk: { ...baseCfg.risk, maxLeverage: 10 } },
      { projectReverseRisk: project },
    );
    installReverseExchange(h, { leverage: "11" });

    const result = await h.svc.reversePosition(input("reverse-leverage-cap"));

    expect(result.error).toContain("RISK_MAX_LEVERAGE");
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("old protection is canceled only after the resulting position is confirmed", async () => {
    const protective = orderFixture({
      clientOrderId: "old-sl-confirmed",
      side: "SELL",
      type: "STOP_MARKET",
      closePosition: true,
      stopPrice: "45000",
    });
    const h = setup({}, { projectReverseRisk: project });
    installReverseExchange(h, { protectiveOrders: [protective] });

    const result = await h.svc.reversePosition(input("reverse-cleanup"));

    const calls = h.http.callsTo("/fapi/v1/order");
    const postIndex = calls.findIndex((call) => call.method === "POST");
    const deleteIndex = calls.findIndex((call) => call.method === "DELETE");
    expect(result).toMatchObject({ ok: true, resultingPosition: { side: "short", qty: "0.001" } });
    expect(postIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(postIndex);
  });

  test("combined market quantity violating exchange max is rejected before submission", async () => {
    const h = setup({}, { projectReverseRisk: project });
    installReverseExchange(h, { initialQty: "100" });

    const result = await h.svc.reversePosition(input("reverse-combined-filter", {
      expectedPositionQty: "100",
      newQty: "1",
    }));

    expect(result.error).toContain("market qty above maxQty");
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("projected risk removes the old position before applying exposure caps", async () => {
    const baseCfg = makeCfg();
    const h = setup(
      { risk: { ...baseCfg.risk, maxGrossExposureUsd: 75 } },
      {
        getRiskSnapshot: () => reverseRiskSnapshot({ grossExposureUsd: 50, openPositionCount: 1 }),
        projectReverseRisk: ({ current }) => reverseRiskSnapshot({
          ...current,
          grossExposureUsd: current.grossExposureUsd - 50,
          openPositionCount: current.openPositionCount - 1,
          openPositionCountAfterOrder: 1,
        }),
      },
    );
    installReverseExchange(h);

    const result = await h.svc.reversePosition(input("reverse-risk-projection"));

    expect(result.ok).toBe(true);
    expect(placeCalls(h)).toHaveLength(1);
  });

  test("reverse is fail-closed when no authoritative hypothetical risk projection exists", async () => {
    const h = setup({ reverseEnabled: true });
    installReverseExchange(h);

    const result = await h.svc.reversePosition(input("reverse-no-projection"));

    expect(result.error).toContain("authoritative hypothetical post-flip margin and liquidation risk data is unavailable");
    expect(placeCalls(h)).toHaveLength(0);
    expect(h.http.callsTo("/fapi/v2/positionRisk")).toHaveLength(1);
  });
});
