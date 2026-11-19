/**
 * FIX B — -2022 reduce-only rejection handling.
 *
 * Production must never resubmit without reduceOnly. Only the demo/testnet
 * profile may fall back, inside the mutation queue, after a fresh position read
 * matches the planned side/size and at the freshly read quantity.
 */

import { BinanceRestClient } from "@/lib/server/binance/rest";
import { RateLimiter } from "@/lib/server/binance/ratelimit";
import { OrderService, REDUCE_ONLY_REJECTED_PRODUCTION } from "@/lib/server/binance/orders";
import { acquireRiskMutationDrain, resetMutationQueueForTests } from "@/lib/server/binance/mutation-queue";
import { resetAlertsForTests } from "@/lib/server/alerts/dispatch";
import { RUNTIME_KEYS, setRuntime } from "@/lib/server/runtime/flags";
import { extractConstraints } from "@/lib/server/binance/filters";
import { persistenceProfileFromConfig } from "@/lib/server/profile/context";
import type { EnvConfig } from "@/lib/server/env/config";
import { BTCUSDT_INFO, FakeHttp, freshEnv, installFakes, jsonRes, makeCfg, orderFixture } from "./helpers";

function positionRow(amount = "0.002") {
  return {
    symbol: "BTCUSDT",
    positionAmt: amount,
    entryPrice: "49000",
    markPrice: "50000",
    unRealizedProfit: "2",
    liquidationPrice: "0",
    leverage: "1",
    positionSide: "BOTH",
  };
}

function setup(overrides: Partial<EnvConfig> = {}) {
  resetMutationQueueForTests();
  resetAlertsForTests();
  const base = freshEnv(makeCfg());
  const http = new FakeHttp();
  installFakes(http);
  const cfg: EnvConfig = { ...base, ...overrides };
  const profile = persistenceProfileFromConfig(cfg);
  const rest = new BinanceRestClient(cfg, new RateLimiter(cfg.rateInternalPerMin), async () => undefined);
  rest.setTransportForTests(http);
  setRuntime(RUNTIME_KEYS.executionEnabled, "true", Date.now(), profile);
  setRuntime(RUNTIME_KEYS.killSwitch, "false", Date.now(), profile);
  setRuntime(RUNTIME_KEYS.frozen, "false", Date.now(), profile);
  const svc = new OrderService({
    cfg,
    rest,
    getConstraints: () => extractConstraints(BTCUSDT_INFO),
    getReferencePrice: async () => ({ price: "50000", at: Date.now() }),
    getRiskSnapshot: () => ({
      balanceUsd: 1000,
      grossExposureUsd: 0,
      openOrderCount: 0,
      openPositionCount: 1,
      realizedTodayUsd: 0,
      unrealizedPnlUsd: 0,
      unrealizedPnlFresh: true,
    }),
    freeze: () => undefined,
    emit: () => undefined,
    sleep: async () => undefined,
  });
  let position = positionRow();
  const setPosition = (amount: string) => {
    position = positionRow(amount);
  };
  http.route("/fapi/v2/positionRisk", () => jsonRes([position]));
  http.route("/fapi/v1/openOrders", () => jsonRes([]));
  return { cfg, http, svc, profile, setPosition };
}

const placeCalls = (http: FakeHttp) => http.callsTo("/fapi/v1/order").filter((c) => c.method === "POST");
const queryOf = (c: { url: string }) => new URLSearchParams(c.url.split("?")[1]);

const PRODUCTION: Partial<EnvConfig> = {
  env: "production",
  activeProfileId: "binance-production",
  profiles: {
    ...makeCfg().profiles,
    "binance-production": {
      ...makeCfg().profiles["binance-production"],
      configured: true,
      executionEnabled: true,
      apiKey: "prod-key",
      apiSecret: "prod-secret",
    },
  },
};

describe("-2022 reduce-only fallback", () => {
  test("production never falls back: re-reads, records, alerts and sends nothing else", async () => {
    const h = setup(PRODUCTION);
    h.http.script("/fapi/v1/order", () => jsonRes({ code: -2022, msg: "ReduceOnly Order is rejected." }, 400));
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "should-not-happen", type: "MARKET" })));

    const result = await h.svc.closePosition("BTCUSDT");

    expect(result.ok).toBe(false);
    expect(result.error).toBe(REDUCE_ONLY_REJECTED_PRODUCTION);
    expect(placeCalls(h.http)).toHaveLength(1);
    expect(queryOf(placeCalls(h.http)[0]).get("reduceOnly")).toBe("true");
    // Position was re-read exactly once after the rejection (initial read + one).
    expect(h.http.callsTo("/fapi/v2/positionRisk")).toHaveLength(2);
  });

  test("demo profile falls back only when the fresh read matches, at the fresh quantity", async () => {
    const h = setup();
    h.http.script("/fapi/v1/order", () => jsonRes({ code: -2022, msg: "ReduceOnly Order is rejected." }, 400));
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "cls-fallback", type: "MARKET", status: "FILLED" })));

    const result = await h.svc.closePosition("BTCUSDT");

    expect(result.ok).toBe(true);
    const posts = placeCalls(h.http);
    expect(posts).toHaveLength(2);
    expect(queryOf(posts[0]).get("reduceOnly")).toBe("true");
    expect(queryOf(posts[1]).get("reduceOnly")).toBeNull();
    expect(queryOf(posts[1]).get("side")).toBe("SELL");
    expect(queryOf(posts[1]).get("quantity")).toBe("0.002");
  });

  test("a changed position aborts the demo fallback", async () => {
    const h = setup();
    // The position grows between the first attempt and the fresh read: a
    // flag-free retry at the old size would be wrong, so nothing is sent.
    h.http.script("/fapi/v1/order", () => {
      h.setPosition("0.005");
      return jsonRes({ code: -2022, msg: "ReduceOnly Order is rejected." }, 400);
    });

    const result = await h.svc.closePosition("BTCUSDT");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("fallback aborted");
    expect(placeCalls(h.http)).toHaveLength(1);
  });

  test("a flipped position aborts the demo fallback", async () => {
    const h = setup();
    h.http.script("/fapi/v1/order", () => {
      h.setPosition("-0.002");
      return jsonRes({ code: -2022, msg: "ReduceOnly Order is rejected." }, 400);
    });

    const result = await h.svc.closePosition("BTCUSDT");

    expect(result.ok).toBe(false);
    expect(placeCalls(h.http)).toHaveLength(1);
  });

  test("the whole close (including the fallback) runs inside the mutation queue", async () => {
    const h = setup();
    h.http.script("/fapi/v1/order", () => jsonRes({ code: -2022, msg: "ReduceOnly Order is rejected." }, 400));
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "cls-queued", type: "MARKET", status: "FILLED" })));

    const release = await acquireRiskMutationDrain();
    const closing = h.svc.closePosition("BTCUSDT");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(placeCalls(h.http)).toHaveLength(0);

    release();
    const result = await closing;
    expect(result.ok).toBe(true);
    expect(placeCalls(h.http)).toHaveLength(2);
    // The fallback quantity is exactly the exchange position, never more.
    expect(queryOf(placeCalls(h.http)[1]).get("quantity")).toBe("0.002");
  });
});
