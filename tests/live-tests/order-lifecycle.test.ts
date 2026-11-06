import { BinanceRestClient } from "@/lib/server/binance/rest";
import { RateLimiter } from "@/lib/server/binance/ratelimit";
import { OrderService, type ReferencePrice } from "@/lib/server/binance/orders";
import { extractConstraints } from "@/lib/server/binance/filters";
import { createIntent, findByClientOrderId, updateIntent } from "@/lib/server/binance/intents";
import { applyAccountEvent, liveState } from "@/lib/server/binance/state";
import { applyOpenOrdersSnapshot } from "@/lib/server/binance/state";
import {
  getProtectionIntent,
  savePendingProtectionIntent,
  saveProtectionIntent,
} from "@/lib/server/binance/protection";
import { Reconciler } from "@/lib/server/binance/recon";
import { resetServerConfigForTests } from "@/lib/server/env/config";
import { setHealthSignal } from "@/lib/server/health/state";
import { resetAlertsForTests } from "@/lib/server/alerts/dispatch";
import { RUNTIME_KEYS, setRuntime } from "@/lib/server/runtime/flags";
import type { EnvConfig } from "@/lib/server/env/config";
import { persistenceProfileFromConfig } from "@/lib/server/profile/context";
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
  const cfg = { ...base, ...cfgOverrides };
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
    getRiskSnapshot: () => ({ balanceUsd: 1000, grossExposureUsd: 0, openOrderCount: 0, openPositionCount: 0, realizedTodayUsd: 0, unrealizedPnlUsd: 0, unrealizedPnlFresh: true }),
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
const queryOf = (c: { url: string }) => new URLSearchParams(c.url.split("?")[1]);

function mockProtectionExchange(h: Harness, initial: Array<Record<string, unknown>> = []) {
  const orders = [...initial];
  let postFailures = 0;
  const failedPrices = new Map<string, number>();
  let onPostFailure: (() => void) | undefined;
  h.http.route("/fapi/v1/openOrders", () => jsonRes(orders));
  h.http.route("/fapi/v1/order", () => {
    const request = h.http.calls[h.http.calls.length - 1];
    const url = new URL(request.url);
    const query = url.searchParams;
    if (request.method === "DELETE") {
      const index = orders.findIndex((order) => order.clientOrderId === query.get("origClientOrderId"));
      if (index < 0) return jsonRes({ code: -2011, msg: "Unknown order sent." }, 400);
      const [canceled] = orders.splice(index, 1);
      return jsonRes({ ...canceled, status: "CANCELED" });
    }
    if (request.method === "GET") {
      const found = orders.find((order) => order.clientOrderId === query.get("origClientOrderId"));
      return found ? jsonRes(found) : jsonRes({ code: -2013, msg: "Order does not exist." }, 404);
    }
    if (request.method === "POST") {
      const stopPrice = query.get("stopPrice") ?? "";
      const failPriceCount = failedPrices.get(stopPrice) ?? 0;
      if (postFailures > 0 || failPriceCount > 0) {
        if (postFailures > 0) postFailures -= 1;
        if (failPriceCount > 1) failedPrices.set(stopPrice, failPriceCount - 1);
        else if (failPriceCount === 1) failedPrices.delete(stopPrice);
        onPostFailure?.();
        return jsonRes({ code: -1000, msg: "simulated protective placement failure" }, 400);
      }
      const order = orderFixture({
        clientOrderId: query.get("newClientOrderId") ?? "generated",
        symbol: query.get("symbol") ?? "BTCUSDT",
        side: query.get("side") === "SELL" ? "SELL" : "BUY",
        type: query.get("type") ?? "STOP_MARKET",
        stopPrice: query.get("stopPrice") ?? "0",
        closePosition: query.get("closePosition") === "true",
        status: "NEW",
      });
      orders.push(order);
      return jsonRes(order);
    }
    return jsonRes({ code: -1000, msg: "unsupported test method" }, 400);
  });
  return {
    orders,
    failPosts(count: number) {
      postFailures = count;
    },
    failPostPrices(prices: string[], callback?: () => void) {
      prices.forEach((price) => failedPrices.set(price, (failedPrices.get(price) ?? 0) + 1));
      onPostFailure = callback;
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
    const posts = placeCalls(h).map((c) => queryOf(c));
    const tp = posts.find((q) => q.get("type") === "TAKE_PROFIT_MARKET");
    const sl = posts.find((q) => q.get("type") === "STOP_MARKET");
    expect(tp).toBeDefined();
    expect(sl).toBeDefined();
    expect(tp?.get("closePosition")).toBe("true");
    expect(sl?.get("closePosition")).toBe("true");
    expect(tp?.get("stopPrice")).toBe("45000.5");
    expect(sl?.get("stopPrice")).toBe("52000.5");
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
    expect(exchange.orders.map((order) => order.clientOrderId)).toEqual(["old-tp-invalid"]);
    expect(h.http.callsTo("/fapi/v1/order").filter((call) => call.method === "DELETE")).toHaveLength(0);
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
    expect(h.http.callsTo("/fapi/v1/order").filter((call) => call.method === "DELETE")).toHaveLength(1);
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
    expect(exchange.orders.map((order) => order.clientOrderId)).toEqual(["old-tp-mark-failure"]);
    expect(h.http.callsTo("/fapi/v1/order").filter((call) => call.method === "DELETE" || call.method === "POST")).toHaveLength(0);
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
      expect(out.sl?.error).toContain("Market passed the old stop level 49000");
      expect(placeCalls(h)).toHaveLength(1);
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
      clientOrderId: "old-tp-fail", exchangeOrderId: 78, symbol: "BTCUSDT", side: "SELL",
      type: "TAKE_PROFIT_MARKET", status: "NEW", price: "0", stopPrice: "51000", origQty: "0",
      executedQty: "0", avgPrice: "0", reduceOnly: false, closePosition: true, time: 1, updateTime: 1,
    });
    createIntent({ clientOrderId: "old-tp-fail", kind: "algo", symbol: "BTCUSDT", side: "SELL", type: "TAKE_PROFIT_MARKET", qty: "" });
    updateIntent("old-tp-fail", { status: "SUBMITTED" });
    h.http.scriptApiError("/fapi/v1/order", -1000, "cancel unavailable", 400);
    const out = await h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "52000" });
    expect(out.tp?.ok).toBe(false);
    expect(out.tp?.error).toContain("replacement blocked");
    expect(placeCalls(h)).toHaveLength(0);
    expect(exchange.orders.map((order) => order.clientOrderId)).toEqual(["old-tp-fail"]);
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
    const deletes = h.http.callsTo("/fapi/v1/order").filter((c) => c.method === "DELETE");
    expect(deletes.length).toBe(1);
    expect(queryOf(deletes[0]).get("origClientOrderId")).toBe("old-tp");
    expect(exchange.orders).toHaveLength(1);
    expect(exchange.orders[0].stopPrice).toBe("55000.5");
  });

  test("placement failure restores old order, then retries the requested protection once", async () => {
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

    expect(out.tp?.ok).toBe(true);
    expect(placeCalls(h).map((call) => queryOf(call).get("stopPrice"))).toEqual(["52000", "51000", "52000"]);
    expect(exchange.orders).toHaveLength(1);
    expect(exchange.orders[0].stopPrice).toBe("52000");
    expect(getProtectionIntent("BTCUSDT")).toMatchObject({ status: "CONFIRMED", protectionStatus: "PROTECTED" });
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
    expect(exchange.orders[0].stopPrice).toBe("51000");
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
    expect(placeCalls(h)).toHaveLength(2);
  });

  test("timeout is reconciled against open orders before the one retry", async () => {
    const h = setup();
    mockProtectionExchange(h);
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50000",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: Date.now(),
    });
    h.http.scriptTimeout("/fapi/v1/order");

    const out = await h.svc.protectPosition({ symbol: "BTCUSDT", tpPrice: "52000" });

    expect(out.tp).toMatchObject({ ok: true });
    const calls = h.http.calls;
    const firstPost = calls.findIndex((call) => call.method === "POST" && call.url.includes("/fapi/v1/order"));
    const secondPost = calls.findIndex((call, index) => index > firstPost && call.method === "POST" && call.url.includes("/fapi/v1/order"));
    const reconcileRead = calls.findIndex((call, index) => index > firstPost && call.url.includes("/fapi/v1/openOrders"));
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
      snapshot: async () => applyOpenOrdersSnapshot(exchange.orders as never),
      freeze: () => undefined,
      unfreeze: () => undefined,
      restoreProtection: (intent) => h.svc.restoreProtection(intent),
    });

    await recon.run("startup-test");
    await recon.run("startup-test");

    expect(exchange.orders).toHaveLength(1);
    expect(exchange.orders[0]).toMatchObject({
      type: "TAKE_PROFIT_MARKET",
      stopPrice: "52000",
      closePosition: true,
    });
    expect(placeCalls(h)).toHaveLength(1);
    expect(getProtectionIntent("BTCUSDT")).toMatchObject({ status: "CONFIRMED", protectionStatus: "PROTECTED" });
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
      snapshot: async () => applyOpenOrdersSnapshot(exchange.orders as never),
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
