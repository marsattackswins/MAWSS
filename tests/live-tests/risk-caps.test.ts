import { BinanceRestClient } from "@/lib/server/binance/rest";
import { RateLimiter } from "@/lib/server/binance/ratelimit";
import { OrderService, type ReferencePrice } from "@/lib/server/binance/orders";
import { extractConstraints } from "@/lib/server/binance/filters";
import { checkRisk } from "@/lib/server/binance/risk";
import { liveState } from "@/lib/server/binance/state";
import { RUNTIME_KEYS, setRuntime } from "@/lib/server/runtime/flags";
import type { EnvConfig } from "@/lib/server/env/config";
import { BTCUSDT_INFO, FakeHttp, freshEnv, installFakes, jsonRes, makeCfg, orderFixture } from "./helpers";

interface Harness {
  cfg: EnvConfig;
  http: FakeHttp;
  svc: OrderService;
  freezes: string[];
}

type SetupOverrides = Omit<Partial<EnvConfig>, 'risk'> & {
  risk?: Partial<EnvConfig['risk']>;
};

function setup(
  cfgOverrides: SetupOverrides = {},
  riskSnapshot?: {
    balanceUsd?: number;
    grossExposureUsd?: number;
    openOrderCount?: number;
    openPositionCount?: number;
    realizedTodayUsd?: number;
    unrealizedPnlUsd?: number | null;
    unrealizedPnlFresh?: boolean;
  },
): Harness {
  const baseCfg = makeCfg();
  const base = freshEnv(baseCfg);
  liveState().symbolLeverage.set("BTCUSDT", "1");
  const http = new FakeHttp();
  installFakes(http);
  
  // Merge risk properly - partial risk overrides merge with base risk
  const cfg: EnvConfig = { 
    ...base, 
    ...cfgOverrides,
    risk: cfgOverrides.risk ? { ...base.risk, ...cfgOverrides.risk } : base.risk
  };
  
  const rest = new BinanceRestClient(cfg, new RateLimiter(cfg.rateInternalPerMin), async () => undefined);
  rest.setTransportForTests(http);
  setRuntime(RUNTIME_KEYS.executionEnabled, "true");

  const constraints = extractConstraints(BTCUSDT_INFO);
  const freezes: string[] = [];
  const snap = riskSnapshot ?? {
    balanceUsd: 1000,
    grossExposureUsd: 0,
    openOrderCount: 0,
    openPositionCount: 0,
    realizedTodayUsd: 0,
    unrealizedPnlUsd: 0,
    unrealizedPnlFresh: true,
  };
  const svc = new OrderService({
    cfg,
    rest,
    getConstraints: (s) => (s === "BTCUSDT" ? constraints : null),
    getReferencePrice: async () => ({ price: "50000", at: Date.now() }),
    getRiskSnapshot: () => ({
      balanceUsd: snap.balanceUsd ?? 1000,
      grossExposureUsd: snap.grossExposureUsd ?? 0,
      openOrderCount: snap.openOrderCount ?? 0,
      openPositionCount: snap.openPositionCount ?? 0,
      realizedTodayUsd: snap.realizedTodayUsd ?? 0,
      unrealizedPnlUsd: snap.unrealizedPnlUsd === undefined ? 0 : snap.unrealizedPnlUsd,
      unrealizedPnlFresh: snap.unrealizedPnlFresh ?? true,
    }),
    freeze: (reason) => {
      freezes.push(reason);
      setRuntime(RUNTIME_KEYS.frozen, "true");
      setRuntime(RUNTIME_KEYS.frozenReason, reason);
    },
    emit: () => {},
    sleep: async () => undefined,
  });
  return { cfg, http, svc, freezes };
}

const placeCalls = (h: Harness) => h.http.callsTo("/fapi/v1/order").filter((c) => c.method === "POST");

describe("server-side risk caps", () => {
  test("order over $100 notional is rejected even with forged lower client-side value", async () => {
    const h = setup({ risk: { maxOrderNotionalUsd: 100 } });
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "big1", status: "NEW" })));

    // qty=0.01 at price=50000 = $500 notional, well over $100 cap
    const res = await h.svc.submitOrder({
      symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.01", clientOrderId: "big1",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("RISK_MAX_ORDER_NOTIONAL");
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("price collar violations use a dedicated error code", () => {
    const cfg = makeCfg({ risk: { ...makeCfg().risk, priceCollarPct: 5 } });
    const errors = checkRisk(
      cfg,
      {
        balanceUsd: 1000,
        grossExposureUsd: 0,
        openOrderCount: 0,
        openPositionCount: 0,
        realizedTodayUsd: 0,
        unrealizedPnlUsd: 0,
        unrealizedPnlFresh: true,
      },
      { type: "LIMIT", qty: "0.0001", effectivePrice: "53000", reduceOnly: false },
      "50000",
    );

    expect(errors).toContain(
      "RISK_PRICE_COLLAR: price 53000 is 6.00% from reference 50000; collar is 5%",
    );
    expect(errors.join(";")).not.toContain("RISK_MAX_ORDER_NOTIONAL");
  });

  test("order that would exceed gross exposure cap is rejected", async () => {
    const h = setup(
      { risk: { maxGrossExposureUsd: 100 } },
      { grossExposureUsd: 80 },
    );
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "exp1", status: "NEW" })));

    // qty=0.001 at price=50000 = $50 notional; 80 + 50 = 130 > 100
    const res = await h.svc.submitOrder({
      symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "exp1",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("RISK_MAX_GROSS_EXPOSURE");
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("open position cap rejects new non-reduce-only orders", async () => {
    const h = setup(
      { risk: { maxOpenPositions: 1 } },
      { openPositionCount: 1 },
    );
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "pos1", status: "NEW" })));

    const res = await h.svc.submitOrder({
      symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "pos1",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("RISK_MAX_OPEN_POSITIONS");
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("reduce-only orders bypass the open position cap", async () => {
    const h = setup(
      { risk: { maxOpenPositions: 1 } },
      { openPositionCount: 1 },
    );
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "red1", status: "NEW" })));

    const res = await h.svc.submitOrder({
      symbol: "BTCUSDT", side: "SELL", type: "MARKET", qty: "0.001", reduceOnly: true, clientOrderId: "red1",
    });
    expect(res.ok).toBe(true);
    expect(placeCalls(h)).toHaveLength(1);
  });

  test("leverage at the configured cap is allowed", async () => {
    const h = setup({ risk: { maxLeverage: 10 } });
    h.http.route("/fapi/v1/leverage", () => jsonRes({ leverage: 10, maxNotionalValue: "1000000" }));
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "lev10", status: "NEW" })));

    const res = await h.svc.submitOrder({
      symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", leverage: 10, clientOrderId: "lev10",
    });

    expect(res.ok).toBe(true);
    expect(h.http.callsTo("/fapi/v1/leverage")).toHaveLength(1);
    expect(placeCalls(h)).toHaveLength(1);
  });

  test("leverage above the configured cap is rejected before changing leverage or placing an order", async () => {
    const h = setup({ risk: { maxLeverage: 10 } });

    const res = await h.svc.submitOrder({
      symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", leverage: 11, clientOrderId: "lev11",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("RISK_MAX_LEVERAGE");
    expect(h.http.callsTo("/fapi/v1/leverage")).toHaveLength(0);
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("orders without a leverage request reject when the known symbol leverage is above the cap", async () => {
    const h = setup({ risk: { maxLeverage: 10 } });
    liveState().symbolLeverage.set("BTCUSDT", "11");

    const res = await h.svc.submitOrder({
      symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "current-lev11",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("RISK_MAX_LEVERAGE");
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("orders without a requested or known leverage fail closed", async () => {
    const h = setup();
    liveState().symbolLeverage.delete("BTCUSDT");

    const res = await h.svc.submitOrder({
      symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "unknown-lev",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("current leverage is unknown");
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("reduce-only close is not blocked by an over-limit leverage value", async () => {
    const h = setup({ risk: { maxLeverage: 2 } });
    h.http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "red-lev", status: "NEW" })));

    const res = await h.svc.submitOrder({
      symbol: "BTCUSDT",
      side: "SELL",
      type: "MARKET",
      qty: "0.001",
      leverage: 20,
      reduceOnly: true,
      clientOrderId: "red-lev",
    });

    expect(res.ok).toBe(true);
    expect(h.http.callsTo("/fapi/v1/leverage")).toHaveLength(0);
    expect(placeCalls(h)).toHaveLength(1);
  });

  test("combined realized and unrealized loss rejects exactly at and just beyond the limit", () => {
    const cfg = makeCfg({ risk: { ...makeCfg().risk, dailyLossPct: 10 } });
    const base = {
      balanceUsd: 1000,
      grossExposureUsd: 0,
      openOrderCount: 0,
      openPositionCount: 0,
      realizedTodayUsd: -25,
      unrealizedPnlFresh: true,
    };
    const order = { type: "MARKET", qty: "0.001", effectivePrice: "50000", reduceOnly: false };

    const belowLimit = checkRisk(cfg, { ...base, unrealizedPnlUsd: -74.99 }, order, "50000");
    const atLimit = checkRisk(cfg, { ...base, unrealizedPnlUsd: -75 }, order, "50000");
    const justOver = checkRisk(cfg, { ...base, unrealizedPnlUsd: -75.01 }, order, "50000");

    expect(belowLimit.join(";")).not.toContain("daily realized and unrealized loss limit reached");
    expect(atLimit.join(";")).toContain("daily realized and unrealized loss limit reached");
    expect(justOver.join(";")).toContain("daily realized and unrealized loss limit reached");
  });

  test("realized-only daily loss threshold remains independently enforced", () => {
    const cfg = makeCfg({ risk: { ...makeCfg().risk, dailyLossPct: 10 } });
    const errors = checkRisk(
      cfg,
      {
        balanceUsd: 1000,
        grossExposureUsd: 0,
        openOrderCount: 0,
        openPositionCount: 0,
        realizedTodayUsd: -100,
        unrealizedPnlUsd: 50,
        unrealizedPnlFresh: true,
      },
      { type: "MARKET", qty: "0.001", effectivePrice: "50000", reduceOnly: false },
      "50000",
    );

    expect(errors.join(";")).toContain("daily realized loss limit reached");
  });

  test("stale or missing unrealized P&L rejects risk-increasing orders", () => {
    const cfg = makeCfg();
    const order = { type: "MARKET", qty: "0.001", effectivePrice: "50000", reduceOnly: false };
    const base = {
      balanceUsd: 1000,
      grossExposureUsd: 0,
      openOrderCount: 0,
      openPositionCount: 0,
      realizedTodayUsd: 0,
    };

    expect(checkRisk(cfg, {
      ...base,
      unrealizedPnlUsd: -1,
      unrealizedPnlFresh: false,
    }, order, "50000").join(";")).toContain("unrealized P&L is unavailable or stale");
    expect(checkRisk(cfg, {
      ...base,
      unrealizedPnlFresh: true,
    }, order, "50000").join(";")).toContain("unrealized P&L is unavailable or stale");
  });

  test.each([
    ["reduce-only", { reduceOnly: true }],
    ["close-position", { closePosition: true }],
    ["emergency-close", { emergencyClose: true }],
    ["close path", { isClose: true }],
  ])("%s orders bypass all risk checks", (_name, exemption) => {
    const cfg = makeCfg({ risk: { ...makeCfg().risk, maxLeverage: 1 } });
    const errors = checkRisk(
      cfg,
      {
        balanceUsd: 100,
        grossExposureUsd: 1000,
        openOrderCount: 100,
        openPositionCount: 100,
        realizedTodayUsd: -100,
        unrealizedPnlUsd: null,
        unrealizedPnlFresh: false,
      },
      {
        type: "LIMIT",
        qty: "100",
        effectivePrice: "50000",
        reduceOnly: false,
        ...exemption,
      },
      "1",
    );
    expect(errors).toEqual([]);
  });

  test("open order cap rejects LIMIT orders when at limit", async () => {
    const h = setup(
      { risk: { maxOpenOrders: 1 } },
      { openOrderCount: 1 },
    );

    const res = await h.svc.submitOrder({
      symbol: "BTCUSDT", side: "BUY", type: "LIMIT", qty: "0.001", price: "50000", clientOrderId: "ord1",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("RISK_MAX_OPEN_ORDERS");
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("unhealthy execution state rejects submission via execution gate", async () => {
    const h = setup();
    setRuntime(RUNTIME_KEYS.frozen, "true");
    setRuntime(RUNTIME_KEYS.frozenReason, "stream disconnected");

    const res = await h.svc.submitOrder({
      symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "frz1",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("kill switch blocks submission without calling Binance", async () => {
    const h = setup();
    setRuntime(RUNTIME_KEYS.killSwitch, "true");

    const res = await h.svc.submitOrder({
      symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "ks1",
    });

    expect(res.ok).toBe(false);
    expect(placeCalls(h)).toHaveLength(0);
  });

  test("rejected risk check makes zero Binance network requests", async () => {
    const h = setup({ risk: { maxOrderNotionalUsd: 10 } });

    await h.svc.submitOrder({
      symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "nr1",
    });

    expect(h.http.calls).toHaveLength(0);
  });
});
