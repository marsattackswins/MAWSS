import { BinanceLiveManager, resetLiveManagerForTests } from "@/lib/server/binance/manager";
import { createIntent, findByClientOrderId, updateIntent } from "@/lib/server/binance/intents";
import { applyPositionSnapshot, isAlgoStateStale, liveState } from "@/lib/server/binance/state";
import { MARK_STALE_AFTER_MS } from "@/lib/server/binance/mark-price-stream";
import { getRuntime, RUNTIME_KEYS, setRuntime } from "@/lib/server/runtime/flags";
import { getDb } from "@/lib/server/db/connection";
import { sseBus } from "@/lib/server/binance/sse";
import { FakeHttp, FakeWs, freshEnv, installFakes, jsonRes, makeCfg, accountFixture, BTCUSDT_INFO, orderEvent, orderFixture } from "./helpers";
import { healthSignals } from "@/lib/server/health/state";
import { getMetrics, METRICS } from "@/lib/server/metrics/collector";
import { getProtectionIntent, savePendingProtectionIntent, saveProtectionIntent, withProtectionIntentLock } from "@/lib/server/binance/protection";

/**
 * End-to-end broker lifecycle against an in-memory testnet: startup, clock
 * sync, metadata, snapshot, private stream, order submission, stream-driven
 * fills, reconciliation. No real network is ever touched.
 */

let manager: BinanceLiveManager;
let http: FakeHttp;
let events: Array<{ event: string; data: unknown }>;
let unsub: (() => void) | null = null;

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

async function waitForRiskSnapshot(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for account-update risk snapshot");
}

async function applyManagerAccountUpdate(event: unknown): Promise<void> {
  const processEvent = (manager as unknown as {
    processEvent: (event: unknown) => void | Promise<void>;
  }).processEvent.bind(manager);
  await processEvent(event);
}

async function startManager(
  overrides: Record<string, () => unknown> = {},
  cfgOverrides: Parameters<typeof makeCfg>[0] = {},
) {
  const cfg = freshEnv(makeCfg(cfgOverrides));
  http = new FakeHttp();
  installFakes(http);

  http.route("/fapi/v1/time", () => jsonRes({ serverTime: Date.now() }));
  http.route("/fapi/v1/exchangeInfo", () => jsonRes({ symbols: [BTCUSDT_INFO] }));
  http.route("/fapi/v1/ticker/price", () => jsonRes({ symbol: "BTCUSDT", price: "50000" }));
  http.route("/fapi/v2/account", () => jsonRes(accountFixture()));
  http.route("/fapi/v2/positionRisk", () => jsonRes([]));
  http.route("/fapi/v1/openOrders", () => jsonRes([]));
  http.route("/fapi/v1/listenKey", () => jsonRes({ listenKey: "LK-E2E" }));
  http.route("/fapi/v1/leverageBracket", () => jsonRes([]));
  http.route("/fapi/v1/leverage", () => jsonRes({ leverage: 1, maxNotionalValue: "1000000" }));
  http.route("/fapi/v1/userTrades", () => jsonRes([]));
  for (const [pathPart, respond] of Object.entries(overrides)) {
    http.route(pathPart, () => jsonRes(respond()));
  }

  setRuntime(RUNTIME_KEYS.executionEnabled, "true");
  manager = new BinanceLiveManager(cfg);
  resetLiveManagerForTests(manager);
  events = [];
  unsub = sseBus.subscribe((event, data) => events.push({ event, data }));
  await manager.ensureStarted();
}

afterEach(() => {
  unsub?.();
  unsub = null;
  manager?.stop();
  resetLiveManagerForTests();
});

function algoOrderFixture(clientAlgoId: string, triggerPrice: string): unknown {
  return {
    algoId: 900 + clientAlgoId.length,
    clientAlgoId,
    algoType: "CONDITIONAL",
    orderType: "STOP_MARKET",
    symbol: "BTCUSDT",
    side: "SELL",
    positionSide: "BOTH",
    algoStatus: "NEW",
    triggerPrice,
    quantity: "",
    closePosition: true,
    createTime: Date.now(),
    updateTime: Date.now(),
    actualOrderId: "",
  };
}

function algoUpdateEvent(clientAlgoId: string): unknown {
  return {
    e: "ALGO_UPDATE",
    E: Date.now(),
    T: Date.now(),
    o: {
      caid: clientAlgoId,
      aid: 71,
      at: "CONDITIONAL",
      o: "STOP_MARKET",
      s: "BTCUSDT",
      S: "SELL",
      ps: "BOTH",
      X: "NEW",
      ai: "",
    },
  };
}

describe("BinanceLiveManager end-to-end (fake testnet)", () => {
  test("risk snapshot sums fresh mark-derived P&L and marks stale or missing sources unavailable", async () => {
    await startManager();
    const positionRow = {
      symbol: "BTCUSDT",
      positionAmt: "0.001",
      entryPrice: "50000",
      markPrice: "49000",
      unRealizedProfit: "-1",
      liquidationPrice: "0",
      leverage: "5",
      positionSide: "BOTH",
    };

    applyPositionSnapshot([positionRow], Date.now());
    expect(manager.getRiskSnapshot()).toMatchObject({
      unrealizedPnlUsd: -1,
      unrealizedPnlFresh: true,
      marginDataFresh: true,
      marginRatio: 0,
      liquidationDistancesPct: [],
    });

    applyPositionSnapshot([positionRow], Date.now() - MARK_STALE_AFTER_MS - 1);
    expect(manager.getRiskSnapshot()).toMatchObject({
      unrealizedPnlUsd: null,
      unrealizedPnlFresh: false,
      marginDataFresh: false,
    });

    applyPositionSnapshot([positionRow], Date.now());
    liveState().positions.set("BTCUSDT", {
      ...liveState().positions.get("BTCUSDT")!,
      markPriceSource: "fill-fallback",
    });
    expect(manager.getRiskSnapshot()).toMatchObject({
      unrealizedPnlUsd: null,
      unrealizedPnlFresh: false,
      marginDataFresh: false,
    });
  });

  test("risk snapshot computes margin ratio and directional liquidation distance", async () => {
    await startManager({
      "/fapi/v2/account": () => accountFixture({ totalMaintMargin: "200" }),
    });
    const now = Date.now();
    applyPositionSnapshot([
      {
        symbol: "BTCUSDT",
        positionAmt: "1",
        entryPrice: "100",
        markPrice: "100",
        unRealizedProfit: "0",
        liquidationPrice: "90",
        leverage: "5",
        positionSide: "BOTH",
      },
      {
        symbol: "ETHUSDT",
        positionAmt: "-1",
        entryPrice: "100",
        markPrice: "100",
        unRealizedProfit: "0",
        liquidationPrice: "110",
        leverage: "5",
        positionSide: "BOTH",
      },
    ], now);

    expect(manager.getRiskSnapshot()).toMatchObject({
      marginRatio: 0.2,
      marginDataFresh: true,
      liquidationDistancesPct: [10, 10],
    });
  });

  test("missing maintenance margin or stale margin snapshot is unavailable with open positions", async () => {
    await startManager();
    applyPositionSnapshot([{
      symbol: "BTCUSDT",
      positionAmt: "1",
      entryPrice: "100",
      markPrice: "100",
      unRealizedProfit: "0",
      liquidationPrice: "0",
      leverage: "5",
      positionSide: "BOTH",
    }]);

    liveState().account!.maintenanceMargin = "";
    expect(manager.getRiskSnapshot().marginDataFresh).toBe(false);

    liveState().account!.maintenanceMargin = "0";
    liveState().account!.marginHealthFetchedAt = Date.now() - makeCfg().snapshotMaxAgeMs - 1;
    expect(manager.getRiskSnapshot().marginDataFresh).toBe(false);
  });

  test("stale liquidation snapshot remains unavailable despite fresh mark updates", async () => {
    await startManager();
    const now = Date.now();
    applyPositionSnapshot([{
      symbol: "BTCUSDT",
      positionAmt: "1",
      entryPrice: "100",
      markPrice: "100",
      unRealizedProfit: "0",
      liquidationPrice: "90",
      leverage: "5",
      positionSide: "BOTH",
    }], now);
    liveState().positions.get("BTCUSDT")!.riskSnapshotFetchedAt =
      now - makeCfg().snapshotMaxAgeMs - 1;
    liveState().positions.get("BTCUSDT")!.updatedAt = now;

    expect(manager.getRiskSnapshot().marginDataFresh).toBe(false);
  });

  test("zero or missing liquidation prices produce no liquidation-distance constraint", async () => {
    await startManager();
    applyPositionSnapshot([
      {
        symbol: "BTCUSDT",
        positionAmt: "1",
        entryPrice: "100",
        markPrice: "100",
        unRealizedProfit: "0",
        liquidationPrice: "0",
        leverage: "5",
        positionSide: "BOTH",
      },
      {
        symbol: "ETHUSDT",
        positionAmt: "-1",
        entryPrice: "100",
        markPrice: "100",
        unRealizedProfit: "0",
        liquidationPrice: "",
        leverage: "5",
        positionSide: "BOTH",
      },
    ]);

    expect(manager.getRiskSnapshot()).toMatchObject({
      marginDataFresh: true,
      liquidationDistancesPct: [],
    });
  });

  test("malformed liquidation data is unavailable while a position is open", async () => {
    await startManager();
    applyPositionSnapshot([{
      symbol: "BTCUSDT",
      positionAmt: "1",
      entryPrice: "100",
      markPrice: "100",
      unRealizedProfit: "0",
      liquidationPrice: "invalid",
      leverage: "5",
      positionSide: "BOTH",
    }]);

    expect(manager.getRiskSnapshot().marginDataFresh).toBe(false);
  });

  test("startup: clock, metadata, snapshot, stream, recon all reach ready", async () => {
    await startManager();
    expect(manager.status).toBe("ready");
    expect(manager.getRiskSnapshot()).toMatchObject({
      openPositionCount: 0,
      marginDataFresh: true,
      marginRatio: null,
      liquidationDistancesPct: [],
    });

    expect(manager.metadata.symbolCount()).toBeGreaterThanOrEqual(1);
    expect(manager.metadata.getConstraints("BTCUSDT")).not.toBeNull();
    expect(liveState().account?.totalWalletBalance).toBe("1000");
    expect(http.callsTo("/fapi/v1/time").length).toBeGreaterThanOrEqual(3); // clock samples
    expect(FakeWs.last().url).toContain("LK-E2E");

    // startup reconciliation recorded
    const runs = getDb().prepare(`SELECT trigger, result FROM reconciliation_runs`).all() as Array<{ trigger: string; result: string }>;
    expect(runs.some((r) => r.trigger === "startup")).toBe(true);
  });

  test("startup snapshots algo orders for open position symbols", async () => {
    const position = {
      symbol: "BTCUSDT",
      positionAmt: "0.001",
      entryPrice: "50000",
      markPrice: "50000",
      unRealizedProfit: "0",
      liquidationPrice: "0",
      leverage: "1",
      positionSide: "BOTH",
    };
    const algo = {
      algoId: 45,
      clientAlgoId: "startup-sl-45",
      algoType: "CONDITIONAL",
      orderType: "STOP_MARKET",
      symbol: "BTCUSDT",
      side: "SELL",
      positionSide: "BOTH",
      algoStatus: "NEW",
      triggerPrice: "49000",
      quantity: "",
      closePosition: true,
      createTime: Date.now(),
      updateTime: Date.now(),
      actualOrderId: "",
    };
    await startManager({
      "/fapi/v2/positionRisk": () => [position],
      "/fapi/v1/openAlgoOrders": () => [algo],
    });

    expect(http.callsTo("/fapi/v1/openAlgoOrders").length).toBeGreaterThanOrEqual(1);
    expect(new URL(http.callsTo("/fapi/v1/openAlgoOrders")[0].url).searchParams.get("symbol")).toBe("BTCUSDT");
    expect(liveState().openOrders.get("startup-sl-45")).toMatchObject({
      kind: "algo",
      algoId: 45,
      closePosition: true,
      stopPrice: "49000",
    });
  });

  test("ALGO_UPDATE refreshes exchange truth and marks failed open protection unprotected", async () => {
    const position = {
      symbol: "BTCUSDT",
      positionAmt: "0.001",
      entryPrice: "50000",
      markPrice: "50000",
      unRealizedProfit: "0",
      liquidationPrice: "0",
      leverage: "1",
      positionSide: "BOTH",
    };
    let algoOrders: unknown[] = [];
    await startManager({
      "/fapi/v2/positionRisk": () => [position],
      "/fapi/v1/openAlgoOrders": () => algoOrders,
    });
    saveProtectionIntent({
      symbol: "BTCUSDT",
      side: "long",
      tpPrice: null,
      slPrice: "49000",
    });
    const ws = FakeWs.instances.find((instance) => instance.url.includes("LK-E2E"))!;
    ws.emitMessage({
      e: "ALGO_UPDATE",
      E: Date.now(),
      T: Date.now(),
      o: {
        caid: "stream-sl-46",
        aid: 46,
        at: "CONDITIONAL",
        o: "STOP_MARKET",
        s: "BTCUSDT",
        S: "SELL",
        ps: "BOTH",
        X: "CANCELED",
        ai: "",
        rm: "position side mismatch",
      },
    });
    expect(getProtectionIntent("BTCUSDT")?.protectionStatus).toBe("UNPROTECTED");

    algoOrders = [{
      algoId: 47,
      clientAlgoId: "stream-sl-47",
      algoType: "CONDITIONAL",
      orderType: "STOP_MARKET",
      symbol: "BTCUSDT",
      side: "SELL",
      positionSide: "BOTH",
      algoStatus: "NEW",
      triggerPrice: "48800",
      quantity: "",
      closePosition: true,
      createTime: Date.now(),
      updateTime: Date.now(),
      actualOrderId: "",
    }];
    await waitForRiskSnapshot(() => liveState().openOrders.has("stream-sl-47"));
    expect(liveState().openOrders.has("stream-sl-46")).toBe(false);
    expect(http.callsTo("/fapi/v1/openAlgoOrders").length).toBeGreaterThanOrEqual(2);
  });

  test("a TP/SL cancelled on the exchange is flagged unprotected right after the refresh", async () => {
    const position = {
      symbol: "BTCUSDT",
      positionAmt: "0.001",
      entryPrice: "50000",
      markPrice: "50000",
      unRealizedProfit: "0",
      liquidationPrice: "0",
      leverage: "1",
      positionSide: "BOTH",
    };
    let algoOrders: unknown[] = [algoOrderFixture("cancelled-sl", "49000")];
    await startManager({
      "/fapi/v2/positionRisk": () => [position],
      "/fapi/v1/openAlgoOrders": () => algoOrders,
    }, { alertWebhookUrl: "https://alerts.example.test/hook" });
    saveProtectionIntent({ symbol: "BTCUSDT", side: "long", tpPrice: null, slPrice: "49000" });
    expect(getProtectionIntent("BTCUSDT")?.protectionStatus).toBe("PROTECTED");
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const unprotectedAlerts = () => fetchSpy.mock.calls
      .map(([, init]) => String((init as RequestInit | undefined)?.body ?? ""))
      .filter((body) => body.includes("position_unprotected:BTCUSDT"));
    const unprotectedAudits = () => (getDb()
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'position.protection.unprotected'")
      .get() as { n: number }).n;
    try {
      // The order is gone from the exchange but no removal reason arrived.
      algoOrders = [];
      const ws = FakeWs.instances.find((instance) => instance.url.includes("LK-E2E"))!;
      ws.emitMessage(algoUpdateEvent("cancelled-sl"));

      await waitForRiskSnapshot(() => getProtectionIntent("BTCUSDT")?.protectionStatus === "UNPROTECTED");
      expect(unprotectedAlerts()).toHaveLength(1);
      expect(unprotectedAudits()).toBe(1);

      ws.emitMessage(algoUpdateEvent("cancelled-sl"));
      await waitForRiskSnapshot(() => http.callsTo("/fapi/v1/openAlgoOrders").length >= 3);
      expect(unprotectedAlerts()).toHaveLength(1);
      expect(unprotectedAudits()).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("the refresh-time protection check leaves a replace in flight alone", async () => {
    const position = {
      symbol: "BTCUSDT",
      positionAmt: "0.001",
      entryPrice: "50000",
      markPrice: "50000",
      unRealizedProfit: "0",
      liquidationPrice: "0",
      leverage: "1",
      positionSide: "BOTH",
    };
    const algoOrders: unknown[] = [];
    await startManager({
      "/fapi/v2/positionRisk": () => [position],
      "/fapi/v1/openAlgoOrders": () => algoOrders,
    }, { alertWebhookUrl: "https://alerts.example.test/hook" });
    savePendingProtectionIntent({
      symbol: "BTCUSDT",
      side: "long",
      tpPrice: "52000",
      slPrice: null,
      previousTpPrice: null,
      previousSlPrice: null,
    });
    const before = getProtectionIntent("BTCUSDT")!;
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    let releaseLock!: () => void;
    const held = new Promise<void>((resolve) => { releaseLock = resolve; });
    const lockHolder = withProtectionIntentLock("BTCUSDT", () => held);
    try {
      const baseline = http.callsTo("/fapi/v1/openAlgoOrders").length;
      const ws = FakeWs.instances.find((instance) => instance.url.includes("LK-E2E"))!;
      ws.emitMessage(algoUpdateEvent("replace-in-flight"));
      await waitForRiskSnapshot(() => http.callsTo("/fapi/v1/openAlgoOrders").length >= baseline + 1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(getProtectionIntent("BTCUSDT")).toMatchObject({
        status: before.status,
        protectionStatus: before.protectionStatus,
        failureReason: before.failureReason,
      });
      const bodies = fetchSpy.mock.calls.map(([, init]) => String((init as RequestInit | undefined)?.body ?? ""));
      expect(bodies.some((body) => body.includes("position_unprotected:BTCUSDT"))).toBe(false);
    } finally {
      releaseLock();
      await lockHolder;
      fetchSpy.mockRestore();
    }
  });

  test("ALGO_UPDATE EXPIRED with a removal reason marks the position unprotected", async () => {
    const position = {
      symbol: "BTCUSDT",
      positionAmt: "0.001",
      entryPrice: "50000",
      markPrice: "50000",
      unRealizedProfit: "0",
      liquidationPrice: "0",
      leverage: "1",
      positionSide: "BOTH",
    };
    let algoOrders: unknown[] = [algoOrderFixture("expired-sl", "49000")];
    await startManager({
      "/fapi/v2/positionRisk": () => [position],
      "/fapi/v1/openAlgoOrders": () => algoOrders,
    });
    saveProtectionIntent({ symbol: "BTCUSDT", side: "long", tpPrice: null, slPrice: "49000" });
    algoOrders = [];
    const ws = FakeWs.instances.find((instance) => instance.url.includes("LK-E2E"))!;
    ws.emitMessage({
      e: "ALGO_UPDATE",
      E: Date.now(),
      T: Date.now(),
      o: {
        caid: "expired-sl",
        aid: 72,
        at: "CONDITIONAL",
        o: "STOP_MARKET",
        s: "BTCUSDT",
        S: "SELL",
        ps: "BOTH",
        X: "EXPIRED",
        ai: "",
        rm: "expired",
      },
    });

    expect(getProtectionIntent("BTCUSDT")).toMatchObject({
      protectionStatus: "UNPROTECTED",
      failureReason: "Binance removed protective algo order: expired",
    });
    const audited = getDb()
      .prepare("SELECT id FROM audit_log WHERE action = 'position.protection.algo_rejected'")
      .get();
    expect(audited).toBeTruthy();
  });
  test("a failed post-ALGO_UPDATE algo refresh retries once and clears staleness", async () => {
    const position = {
      symbol: "BTCUSDT",
      positionAmt: "0.001",
      entryPrice: "50000",
      markPrice: "50000",
      unRealizedProfit: "0",
      liquidationPrice: "0",
      leverage: "1",
      positionSide: "BOTH",
    };
    let algoOrders: unknown[] = [];
    await startManager({
      "/fapi/v2/positionRisk": () => [position],
      "/fapi/v1/openAlgoOrders": () => algoOrders,
    });
    manager.algoOrderRefreshRetryMs = 5;
    algoOrders = [algoOrderFixture("retry-sl", "49000")];
    http.script("/fapi/v1/openAlgoOrders", () => new Error("conditional order read failed"));
    const ws = FakeWs.instances.find((instance) => instance.url.includes("LK-E2E"))!;

    ws.emitMessage(algoUpdateEvent("retry-sl"));

    await waitForRiskSnapshot(() => liveState().openOrders.has("retry-sl"));
    expect(isAlgoStateStale("BTCUSDT")).toBe(false);
  });

  test("algo state stays stale after a failed retry and clears on the next successful refresh", async () => {
    const position = {
      symbol: "BTCUSDT",
      positionAmt: "0.001",
      entryPrice: "50000",
      markPrice: "50000",
      unRealizedProfit: "0",
      liquidationPrice: "0",
      leverage: "1",
      positionSide: "BOTH",
    };
    let algoOrders: unknown[] = [];
    await startManager({
      "/fapi/v2/positionRisk": () => [position],
      "/fapi/v1/openAlgoOrders": () => algoOrders,
    });
    manager.algoOrderRefreshRetryMs = 5;
    const baseline = http.callsTo("/fapi/v1/openAlgoOrders").length;
    http.script("/fapi/v1/openAlgoOrders", () => new Error("conditional order read failed once"));
    http.script("/fapi/v1/openAlgoOrders", () => new Error("conditional order read failed twice"));
    const ws = FakeWs.instances.find((instance) => instance.url.includes("LK-E2E"))!;

    ws.emitMessage(algoUpdateEvent("stale-sl"));

    await waitForRiskSnapshot(() => isAlgoStateStale("BTCUSDT"));
    await waitForRiskSnapshot(() => http.callsTo("/fapi/v1/openAlgoOrders").length >= baseline + 2);
    expect(liveState().openOrders.has("fresh-sl")).toBe(false);

    algoOrders = [algoOrderFixture("fresh-sl", "48800")];
    ws.emitMessage(algoUpdateEvent("stale-sl"));

    await waitForRiskSnapshot(() => !isAlgoStateStale("BTCUSDT"));
    expect(liveState().openOrders.has("fresh-sl")).toBe(true);
  });

  test("ALGO_UPDATE FINISHED does not assume the actual order filled", async () => {
    await startManager({});
    createIntent({
      clientOrderId: "stream-algo-finished",
      clientAlgoId: "stream-algo-finished",
      kind: "algo",
      symbol: "BTCUSDT",
      side: "SELL",
      type: "TAKE_PROFIT_MARKET",
      qty: "",
    });
    updateIntent("stream-algo-finished", { status: "SUBMITTED" });
    const ws = FakeWs.instances.find((instance) => instance.url.includes("LK-E2E"))!;

    ws.emitMessage({
      e: "ALGO_UPDATE",
      E: Date.now(),
      T: Date.now(),
      o: {
        caid: "stream-algo-finished",
        aid: 78,
        at: "CONDITIONAL",
        o: "TAKE_PROFIT_MARKET",
        s: "BTCUSDT",
        S: "SELL",
        X: "FINISHED",
        ai: 12345,
      },
    });

    // FINISHED means the conditional order completed, not that it filled.
    expect(findByClientOrderId("stream-algo-finished")?.status).toBe("SUBMITTED");
  });

  test("local env can construct a manager (for public data access)", () => {
    freshEnv(makeCfg({ env: "local" }));
    // Should not throw - local mode now allows manager for public data
    expect(() => new BinanceLiveManager()).not.toThrow();
  });

  test("hedge mode is detected and leaves live submissions disabled", async () => {
    await startManager({ "/fapi/v1/positionSide/dual": () => ({ dualSidePosition: true }) });
    expect(healthSignals().positionMode).toMatchObject({ mode: "hedge" });
    const ws = FakeWs.last();
    ws.emitOpen();
    await flush();
    const result = await manager.orders.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "hedge-blocked" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Hedge position mode");
  });

  test("full order lifecycle: submit -> stream NEW -> partial fills -> FILLED", async () => {
    await startManager();
    const ws = FakeWs.last();
    ws.emitOpen();
    await flush();

    http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "e2e-1", type: "LIMIT", status: "NEW", price: "50000", origQty: "0.001" })));
    const res = await manager.orders.submitOrder({
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      qty: "0.001",
      price: "50000",
      leverage: 1,
      clientOrderId: "e2e-1",
    });
    expect(res.ok).toBe(true);
    expect(findByClientOrderId("e2e-1")?.status).toBe("SUBMITTED");

    ws.emitMessage(orderEvent({ clientOrderId: "e2e-1", orderId: 555, tradeId: 7001, status: "PARTIALLY_FILLED", lastFilledQty: "0.0005", cumQty: "0.0005", lastFilledPrice: "50000", price: "50000", E: Date.now() + 1000 }));
    await flush();
    expect(findByClientOrderId("e2e-1")?.status).toBe("PARTIALLY_FILLED");
    expect(liveState().fills).toHaveLength(1);

    ws.emitMessage(orderEvent({ clientOrderId: "e2e-1", orderId: 555, tradeId: 7002, status: "FILLED", lastFilledQty: "0.0005", cumQty: "0.001", lastFilledPrice: "50001", price: "50000", E: Date.now() + 2000 }));
    await flush();
    expect(findByClientOrderId("e2e-1")?.status).toBe("FILLED");
    expect(liveState().orders.get("e2e-1")?.avgPrice).toBe("50000.5");
    expect(liveState().fills).toHaveLength(2);
    expect(liveState().openOrders.has("e2e-1")).toBe(false);

    // Replaying the same execution is a no-op for fills and realized P&L.
    ws.emitMessage(orderEvent({ clientOrderId: "e2e-1", orderId: 555, tradeId: 7002, status: "FILLED", lastFilledQty: "0.0005", cumQty: "0.001", lastFilledPrice: "50001", price: "50000", E: Date.now() + 3000 }));
    await flush();
    expect(liveState().fills).toHaveLength(2);

    // durable records
    const fillsRows = getDb().prepare(`SELECT COUNT(*) AS n FROM fills_log`).get() as { n: number };
    expect(fillsRows.n).toBe(2);
    const eventRows = getDb().prepare(`SELECT COUNT(*) AS n FROM order_events WHERE source = 'stream'`).get() as { n: number };
    expect(eventRows.n).toBe(3);
    const processedRows = getDb().prepare(`SELECT COUNT(*) AS n FROM order_events WHERE source = 'stream' AND processed = 1`).get() as { n: number };
    expect(processedRows.n).toBe(3);

    // SSE fan-out reached subscribers
    expect(events.some((e) => e.event === "order-update")).toBe(true);
    expect(events.some((e) => e.event === "fills")).toBe(true);
    expect(getMetrics().getCounter(METRICS.WS_MESSAGE_RECEIVED)).toBeGreaterThanOrEqual(3);
    expect(getMetrics().getCounter(METRICS.FILL_RECEIVED)).toBeGreaterThanOrEqual(2);
    expect(getMetrics().getCounter(METRICS.ORDER_SUBMITTED)).toBeGreaterThanOrEqual(1);
  });

  test("a failed fill transaction leaves the stream event unprocessed for retry", async () => {
    await startManager();
    const processEvent = (manager as unknown as { processEvent: (event: unknown) => void }).processEvent.bind(manager);
    const event = orderEvent({ clientOrderId: "retry-fill", orderId: 777, tradeId: 8777, status: "FILLED", lastFilledQty: "0.001", cumQty: "0.001", lastFilledPrice: "50000" });
    getDb().exec(`CREATE TRIGGER fail_fill_insert BEFORE INSERT ON fills_log BEGIN SELECT RAISE(ABORT, 'forced fill failure'); END`);
    expect(() => processEvent(event)).toThrow("forced fill failure");
    const failed = getDb().prepare(`SELECT processed FROM order_events WHERE client_order_id = ? ORDER BY id DESC LIMIT 1`).get("retry-fill") as { processed: number };
    expect(failed.processed).toBe(0);

    getDb().exec(`DROP TRIGGER fail_fill_insert`);
    processEvent(event);
    const retried = getDb().prepare(`SELECT processed FROM order_events WHERE client_order_id = ? ORDER BY id DESC LIMIT 1`).get("retry-fill") as { processed: number };
    expect(retried.processed).toBe(1);
    const fillCount = getDb().prepare(`SELECT COUNT(*) AS n FROM fills_log WHERE trade_id = ?`).get("8777") as { n: number };
    expect(fillCount.n).toBe(1);
  });

  test("ACCOUNT_UPDATE events refresh balance state", async () => {
    await startManager();
    http.route("/fapi/v2/account", () =>
      jsonRes(accountFixture({
        totalWalletBalance: "1500",
        totalMarginBalance: "1500",
        availableBalance: "1500",
      })),
    );
    http.route("/fapi/v2/positionRisk", () => jsonRes([{
      symbol: "BTCUSDT",
      positionAmt: "0.001",
      entryPrice: "50000",
      markPrice: "50000",
      unRealizedProfit: "1",
      liquidationPrice: "40000",
      leverage: "5",
      positionSide: "BOTH",
    }]));
    const ws = FakeWs.last();
    ws.emitOpen();
    await flush();
    ws.emitMessage({
      e: "ACCOUNT_UPDATE",
      E: Date.now() + 1000,
      T: Date.now() + 1000,
      a: {
        B: [{ a: "USDT", wb: "1500", cw: "1500", bc: "0" }],
        P: [{ s: "BTCUSDT", pa: "0.001", ep: "50000", cr: "0", up: "1", mt: "cross", iw: "0", ps: "BOTH" }],
      },
    });
    await flush();
    expect(liveState().account?.totalWalletBalance).toBe("1500");
    expect(liveState().positions.get("BTCUSDT")?.qty).toBe("0.001");
    expect(events.some((e) => e.event === "account-update")).toBe(true);
  });

  test("position fill marks margin risk stale until the account and position snapshot refresh lands", async () => {
    let positionRows = [{
      symbol: "BTCUSDT",
      positionAmt: "0.001",
      entryPrice: "50000",
      markPrice: "50000",
      unRealizedProfit: "0",
      liquidationPrice: "40000",
      leverage: "5",
      positionSide: "BOTH",
    }];
    await startManager({
      "/fapi/v2/account": () => accountFixture({ totalMaintMargin: "25" }),
      "/fapi/v2/positionRisk": () => positionRows,
    });
    const initialMarginSnapshotAt = liveState().account!.marginHealthFetchedAt;
    expect(manager.getRiskSnapshot().marginDataFresh).toBe(true);

    positionRows = [{ ...positionRows[0], positionAmt: "0.002", liquidationPrice: "42000" }];
    await applyManagerAccountUpdate({
      e: "ACCOUNT_UPDATE",
      E: Date.now(),
      T: Date.now(),
      a: {
        B: [{ a: "USDT", wb: "1000", cw: "950", bc: "0" }],
        P: [{ s: "BTCUSDT", pa: "0.002", ep: "50000", cr: "0", up: "0", mt: "isolated", iw: "0", ps: "BOTH" }],
      },
    });

    const fillPosition = liveState().positions.get("BTCUSDT")!;
    expect(fillPosition.riskSnapshotFetchedAt).toBe(0);
    expect(fillPosition.liquidationPrice).toBe("");
    expect(manager.getRiskSnapshot().marginDataFresh).toBe(false);
    expect(liveState().account).toMatchObject({
      maintenanceMargin: "25",
      marginHealthBalance: "1000",
      marginHealthFetchedAt: initialMarginSnapshotAt,
    });

    await waitForRiskSnapshot(() =>
      liveState().positions.get("BTCUSDT")?.liquidationPrice === "42000" &&
      manager.getRiskSnapshot().marginDataFresh === true,
    );
    expect(liveState().positions.get("BTCUSDT")?.qty).toBe("0.002");
  });

  test("failed account-update position refresh leaves liquidation risk stale", async () => {
    const positionRows = [{
      symbol: "BTCUSDT",
      positionAmt: "0.001",
      entryPrice: "50000",
      markPrice: "50000",
      unRealizedProfit: "0",
      liquidationPrice: "40000",
      leverage: "5",
      positionSide: "BOTH",
    }];
    await startManager({
      "/fapi/v2/positionRisk": () => positionRows,
    });
    const positionRiskCallCount = http.callsTo("/fapi/v2/positionRisk").length;
    http.scriptApiError("/fapi/v2/positionRisk", -1000, "test refresh failure");

    await applyManagerAccountUpdate({
      e: "ACCOUNT_UPDATE",
      E: Date.now(),
      T: Date.now(),
      a: {
        B: [{ a: "USDT", wb: "1000", cw: "950", bc: "0" }],
        P: [{ s: "BTCUSDT", pa: "0.002", ep: "50000", cr: "0", up: "0", mt: "isolated", iw: "0", ps: "BOTH" }],
      },
    });
    await waitForRiskSnapshot(
      () => http.callsTo("/fapi/v2/positionRisk").length > positionRiskCallCount,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(liveState().positions.get("BTCUSDT")?.liquidationPrice).toBe("");
    expect(manager.getRiskSnapshot().marginDataFresh).toBe(false);
  });

  test("failed account-update refresh retries once and restores fresh margin data", async () => {
    let positionRows = [{
      symbol: "BTCUSDT",
      positionAmt: "0.001",
      entryPrice: "50000",
      markPrice: "50000",
      unRealizedProfit: "0",
      liquidationPrice: "40000",
      leverage: "5",
      positionSide: "BOTH",
    }];
    await startManager({
      "/fapi/v2/account": () => accountFixture({ totalMaintMargin: "25" }),
      "/fapi/v2/positionRisk": () => positionRows,
    });
    const accountCallsBefore = http.callsTo("/fapi/v2/account").length;
    const positionRiskCallsBefore = http.callsTo("/fapi/v2/positionRisk").length;
    http.scriptApiError("/fapi/v2/positionRisk", -1000, "transient refresh failure");

    await applyManagerAccountUpdate({
      e: "ACCOUNT_UPDATE",
      E: Date.now(),
      T: Date.now(),
      a: {
        B: [{ a: "USDT", wb: "1000", cw: "950", bc: "0" }],
        P: [{ s: "BTCUSDT", pa: "0.002", ep: "50000", cr: "0", up: "0", mt: "isolated", iw: "0", ps: "BOTH" }],
      },
    });
    positionRows = [{ ...positionRows[0], positionAmt: "0.002", liquidationPrice: "42000" }];
    expect(manager.getRiskSnapshot().marginDataFresh).toBe(false);

    await waitForRiskSnapshot(
      () => manager.getRiskSnapshot().marginDataFresh === true,
      5_000,
    );
    expect(liveState().positions.get("BTCUSDT")?.qty).toBe("0.002");
    expect(liveState().positions.get("BTCUSDT")?.liquidationPrice).toBe("42000");
    expect(http.callsTo("/fapi/v2/account")).toHaveLength(accountCallsBefore + 2);
    expect(http.callsTo("/fapi/v2/positionRisk")).toHaveLength(positionRiskCallsBefore + 2);
  });

  test("bursts of position ACCOUNT_UPDATE events coalesce into one risk snapshot refresh", async () => {
    let positionRows = [{
      symbol: "BTCUSDT",
      positionAmt: "0.001",
      entryPrice: "50000",
      markPrice: "50000",
      unRealizedProfit: "0",
      liquidationPrice: "40000",
      leverage: "5",
      positionSide: "BOTH",
    }];
    await startManager({
      "/fapi/v2/positionRisk": () => positionRows,
    });
    const accountCallsBefore = http.callsTo("/fapi/v2/account").length;
    const positionRiskCallsBefore = http.callsTo("/fapi/v2/positionRisk").length;

    for (const qty of ["0.002", "0.003", "0.004"]) {
      positionRows = [{ ...positionRows[0], positionAmt: qty, liquidationPrice: "42000" }];
      await applyManagerAccountUpdate({
        e: "ACCOUNT_UPDATE",
        E: Date.now(),
        T: Date.now(),
        a: {
          B: [{ a: "USDT", wb: "1000", cw: "950", bc: "0" }],
          P: [{ s: "BTCUSDT", pa: qty, ep: "50000", cr: "0", up: "0", mt: "isolated", iw: "0", ps: "BOTH" }],
        },
      });
    }

    await waitForRiskSnapshot(() =>
      liveState().positions.get("BTCUSDT")?.qty === "0.004" &&
      liveState().positions.get("BTCUSDT")?.liquidationPrice === "42000" &&
      manager.getRiskSnapshot().marginDataFresh === true,
    );
    expect(http.callsTo("/fapi/v2/account")).toHaveLength(accountCallsBefore + 1);
    expect(http.callsTo("/fapi/v2/positionRisk")).toHaveLength(positionRiskCallsBefore + 1);
  });

  test("kill switch engaged mid-session blocks new submissions", async () => {
    await startManager();
    setRuntime(RUNTIME_KEYS.killSwitch, "true");
    const res = await manager.orders.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "ks-e2e" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("kill switch");
    expect(findByClientOrderId("ks-e2e")).toBeNull();
  });

  test("reconciliation drift freezes submissions; clean recon unfreezes", async () => {
    await startManager({
      "/fapi/v1/openOrders": () => [orderFixture({ clientOrderId: "ghost-order", status: "NEW", type: "LIMIT", price: "50000" })],
    });
    // startup recon already saw the ghost -> drift freeze expected
    expect(getRuntime(RUNTIME_KEYS.frozen)).toBe("true");
    const blocked = await manager.orders.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", clientOrderId: "dr1" });
    expect(blocked.ok).toBe(false);

    // Heal: ghost disappears from the exchange.
    http.route("/fapi/v1/openOrders", () => jsonRes([]));
    const result = await manager.reconcileRun("manual");
    expect(result.result).toBe("ok");
    expect(getRuntime(RUNTIME_KEYS.frozen)).toBe("false");
    // The stream-health gate requires a live stream before submissions pass.
    FakeWs.last().emitOpen();
    await flush();
    http.route("/fapi/v1/order", () => jsonRes(orderFixture({ clientOrderId: "dr2", status: "NEW" })));
    const ok = await manager.orders.submitOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", qty: "0.001", leverage: 1, clientOrderId: "dr2" });
    expect(ok.ok).toBe(true);
  });

  test("reference price comes from mark price when a position exists", async () => {
    await startManager();
    const now = Date.now();
    liveState().positions.set("BTCUSDT", {
      symbol: "BTCUSDT", side: "long", qty: "0.001", entryPrice: "49000", markPrice: "50123.4",
      unrealizedProfit: "1", leverage: "1", liquidationPrice: "0", notional: "50", updatedAt: now,
    });
    const fromMark = await manager.getReferencePrice("BTCUSDT");
    expect(fromMark).toEqual({ price: "50123.4", at: now });
    liveState().positions.delete("BTCUSDT");
    const fromTicker = await manager.getReferencePrice("BTCUSDT");
    expect(fromTicker?.price).toBe("50000"); // ticker fallback
    expect(Date.now() - (fromTicker?.at ?? 0)).toBeLessThan(5_000);
  });

  test("client order ids are unique, prefixed and within the 36-char limit", async () => {
    await startManager();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = manager.newClientOrderId("ord");
      expect(id.length).toBeLessThanOrEqual(36);
      expect(id.startsWith("ord")).toBe(true);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});
