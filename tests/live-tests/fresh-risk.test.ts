/**
 * FIX D — risk-increasing orders are authorised only by freshly read data.
 *
 * account + positionRisk are fetched inside the mutation queue right before
 * checkRisk; a failed fetch rejects. Close paths never pay the extra requests
 * and are never blocked by them.
 */

import { BinanceRestClient } from "@/lib/server/binance/rest";
import { RateLimiter } from "@/lib/server/binance/ratelimit";
import { OrderService } from "@/lib/server/binance/orders";
import { extractConstraints } from "@/lib/server/binance/filters";
import { liveState } from "@/lib/server/binance/state";
import { resetMutationQueueForTests } from "@/lib/server/binance/mutation-queue";
import { resetAlertsForTests } from "@/lib/server/alerts/dispatch";
import { RUNTIME_KEYS, setRuntime } from "@/lib/server/runtime/flags";
import { persistenceProfileFromConfig } from "@/lib/server/profile/context";
import type { EnvConfig } from "@/lib/server/env/config";
import type { RiskSnapshot } from "@/lib/server/binance/risk";
import { BTCUSDT_INFO, FakeHttp, freshEnv, installFakes, jsonRes, makeCfg, orderFixture } from "./helpers";

const freshSnapshot = (): RiskSnapshot => ({
  balanceUsd: 1000,
  grossExposureUsd: 0,
  openOrderCount: 0,
  openPositionCount: 0,
  realizedTodayUsd: 0,
  unrealizedPnlUsd: 0,
  unrealizedPnlFresh: true,
  marginRatio: 0.1,
  marginDataFresh: true,
  liquidationDistancesPct: [20],
});

function setup(options: {
  fetchFreshRisk?: () => Promise<{ account: never; positions: never }>;
  getRiskSnapshot?: () => RiskSnapshot;
} = {}) {
  resetMutationQueueForTests();
  resetAlertsForTests();
  const base = freshEnv(makeCfg());
  const http = new FakeHttp();
  installFakes(http);
  const cfg: EnvConfig = base;
  const profile = persistenceProfileFromConfig(cfg);
  const rest = new BinanceRestClient(cfg, new RateLimiter(cfg.rateInternalPerMin), async () => undefined);
  rest.setTransportForTests(http);
  setRuntime(RUNTIME_KEYS.executionEnabled, "true", Date.now(), profile);
  setRuntime(RUNTIME_KEYS.killSwitch, "false", Date.now(), profile);
  setRuntime(RUNTIME_KEYS.frozen, "false", Date.now(), profile);
  liveState().symbolLeverage.set("BTCUSDT", "1");

  const fetchCalls: number[] = [];
  const svc = new OrderService({
    cfg,
    rest,
    getConstraints: () => extractConstraints(BTCUSDT_INFO),
    getReferencePrice: async () => ({ price: "50000", at: Date.now() }),
    getRiskSnapshot: options.getRiskSnapshot ?? freshSnapshot,
    fetchFreshRisk: options.fetchFreshRisk
      ? async () => {
          fetchCalls.push(Date.now());
          return options.fetchFreshRisk!() as never;
        }
      : async () => {
          fetchCalls.push(Date.now());
          const [account, positions] = await Promise.all([rest.getAccount(), rest.getPositionRisk()]);
          return { account, positions };
        },
    freeze: () => undefined,
    emit: () => undefined,
    sleep: async () => undefined,
  });
  http.route("/fapi/v2/account", () =>
    jsonRes({
      totalWalletBalance: "1234",
      totalUnrealizedProfit: "0",
      totalMarginBalance: "1234",
      totalMaintMargin: "0",
      availableBalance: "1234",
      maxWithdrawAmount: "1234",
      assets: [],
    }),
  );
  http.route("/fapi/v2/positionRisk", () => jsonRes([]));
  http.route("/fapi/v1/order", () => jsonRes(orderFixture({ type: "MARKET", status: "NEW" })));
  return { http, svc, fetchCalls };
}

const openOrder = {
  symbol: "BTCUSDT",
  side: "BUY" as const,
  type: "MARKET" as const,
  qty: "0.001",
};

describe("fresh risk data for risk-increasing orders", () => {
  test("fetches account + positionRisk inside the queue and applies them before the check", async () => {
    const h = setup();
    const result = await h.svc.submitOrder(openOrder);

    expect(result.ok).toBe(true);
    expect(h.fetchCalls).toHaveLength(1);
    expect(liveState().account?.totalWalletBalance).toBe("1234");
  });

  test("a failed fresh fetch rejects and never reaches checkRisk", async () => {
    const h = setup({
      fetchFreshRisk: async () => {
        throw new Error("rest unavailable");
      },
      getRiskSnapshot: () => {
        throw new Error("stale snapshot reached checkRisk");
      },
    });

    const result = await h.svc.submitOrder(openOrder);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("RISK_DATA_UNAVAILABLE");
    expect(h.http.callsTo("/fapi/v1/order").filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("closes, reduce-only and closePosition orders do not fetch fresh risk data", async () => {
    const h = setup();
    h.http.route("/fapi/v2/positionRisk", () =>
      jsonRes([{ symbol: "BTCUSDT", positionAmt: "0.002", entryPrice: "49000", markPrice: "50000", unRealizedProfit: "2", leverage: "1", liquidationPrice: "0" }]),
    );
    h.http.route("/fapi/v1/openOrders", () => jsonRes([]));

    const close = await h.svc.closePosition("BTCUSDT");
    expect(close.ok).toBe(true);

    const reduceOnly = await h.svc.submitOrder({
      symbol: "BTCUSDT",
      side: "SELL",
      type: "MARKET",
      qty: "0.001",
      reduceOnly: true,
      clientOrderId: "ro-1",
    });
    expect(reduceOnly.ok).toBe(true);

    const closePosition = await h.svc.submitOrder({
      symbol: "BTCUSDT",
      side: "SELL",
      type: "MARKET",
      qty: "0.001",
      closePosition: true,
      clientOrderId: "cp-1",
    });
    expect(closePosition.ok).toBe(true);
    expect(h.fetchCalls).toHaveLength(0);
  });

  test("a risk-increasing order is the only path that pays the two extra reads", async () => {
    const h = setup();
    await h.svc.submitOrder(openOrder);
    const riskCalls = h.http.callsTo("/fapi/v2/positionRisk").length + h.http.callsTo("/fapi/v2/account").length;
    // Two signed reads per risk-increasing order: /fapi/v2/account + /fapi/v2/positionRisk.
    expect(riskCalls).toBe(2);
  });
});
