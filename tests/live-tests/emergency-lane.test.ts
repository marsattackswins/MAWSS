/**
 * FIX F — emergency priority lane in the mutation queue.
 *
 * The lane joins the front of the waiting line, never preempts the running
 * task, and after its 3 s budget proceeds without the lock: fresh reads,
 * reduce-only order, post-close verification and an alert if the position is
 * still open.
 */

import { BinanceRestClient } from "@/lib/server/binance/rest";
import { RateLimiter } from "@/lib/server/binance/ratelimit";
import { OrderService } from "@/lib/server/binance/orders";
import { extractConstraints } from "@/lib/server/binance/filters";
import { liveState } from "@/lib/server/binance/state";
import {
  acquireRiskMutationDrain,
  resetMutationQueueForTests,
  withEmergencyMutation,
  withRiskMutation,
} from "@/lib/server/binance/mutation-queue";
import { getDb } from "@/lib/server/db/connection";
import { getProtectionIntent } from "@/lib/server/binance/protection";
import { resetAlertsForTests } from "@/lib/server/alerts/dispatch";
import { RUNTIME_KEYS, setRuntime } from "@/lib/server/runtime/flags";
import { persistenceProfileFromConfig } from "@/lib/server/profile/context";
import { BTCUSDT_INFO, FakeHttp, freshEnv, installFakes, jsonRes, makeCfg, orderFixture } from "./helpers";

const tick = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("emergency priority lane (queue)", () => {
  test("emergency goes to the front of the waiting line but never preempts the running task", async () => {
    resetMutationQueueForTests();
    const order: string[] = [];
    const release = await acquireRiskMutationDrain();

    const normal = withRiskMutation(async () => {
      order.push("normal");
    });
    await tick();
    const emergency = withEmergencyMutation(async () => {
      order.push("emergency");
    });
    await tick();

    // The running task still holds the queue; nothing else started.
    expect(order).toEqual([]);

    release();
    await Promise.all([normal, emergency]);
    expect(order).toEqual(["emergency", "normal"]);
  });

  test("gives up after the wait budget and runs without the lock", async () => {
    resetMutationQueueForTests();
    const release = await acquireRiskMutationDrain();
    let ran = false;

    const started = Date.now();
    const outcome = await withEmergencyMutation(async () => {
      ran = true;
      return "done";
    }, 20);

    expect(outcome).toEqual({ result: "done", waitedOut: true });
    expect(ran).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    release();
  });

  test("a timed-out lane leaves the queue usable", async () => {
    resetMutationQueueForTests();
    const release = await acquireRiskMutationDrain();
    await withEmergencyMutation(async () => undefined, 10);
    release();

    let ran = false;
    await withRiskMutation(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

function setup() {
  resetMutationQueueForTests();
  resetAlertsForTests();
  const base = freshEnv(makeCfg());
  const http = new FakeHttp();
  installFakes(http);
  const profile = persistenceProfileFromConfig(base);
  const rest = new BinanceRestClient(base, new RateLimiter(base.rateInternalPerMin), async () => undefined);
  rest.setTransportForTests(http);
  setRuntime(RUNTIME_KEYS.executionEnabled, "true", Date.now(), profile);
  setRuntime(RUNTIME_KEYS.killSwitch, "false", Date.now(), profile);
  setRuntime(RUNTIME_KEYS.frozen, "false", Date.now(), profile);
  liveState().symbolLeverage.set("BTCUSDT", "1");

  const svc = new OrderService({
    cfg: base,
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
    emergencyMaxWaitMs: 10,
  });
  http.route("/fapi/v2/positionRisk", () =>
    jsonRes([{ symbol: "BTCUSDT", positionAmt: "0.002", entryPrice: "49000", markPrice: "50000", unRealizedProfit: "2", leverage: "1", liquidationPrice: "0" }]),
  );
  http.route("/fapi/v1/allOpenOrders", () => jsonRes([]));
  http.route("/fapi/v1/openOrders", () => jsonRes([]));
  http.route("/fapi/v1/order", () => jsonRes(orderFixture({ type: "MARKET", status: "FILLED" })));
  return { http, svc, profile };
}

describe("emergency priority lane (orders)", () => {
  test("a lane timeout verifies the close and records a remaining position", async () => {
    const h = setup();
    const release = await acquireRiskMutationDrain();

    const result = await h.svc.emergencyClosePosition("BTCUSDT");
    release();

    expect(result.ok).toBe(true);
    const audits = getDb()
      .prepare(`SELECT action FROM audit_log WHERE action LIKE 'position.emergency.%'`)
      .all() as Array<{ action: string }>;
    const actions = audits.map((row) => row.action);
    expect(actions).toContain("position.emergency.priority_lane_timeout");
    expect(actions).toContain("position.emergency.position_remaining");
    // Fresh read before the close + verification read afterwards.
    expect(h.http.callsTo("/fapi/v2/positionRisk")).toHaveLength(2);
    expect(getProtectionIntent("BTCUSDT")).toBeNull();
  });

  test("the normal (non-timed-out) emergency path does no extra verification read", async () => {
    const h = setup();
    const result = await h.svc.emergencyClosePosition("BTCUSDT");
    expect(result.ok).toBe(true);
    expect(h.http.callsTo("/fapi/v2/positionRisk")).toHaveLength(1);
    const audits = getDb().prepare(`SELECT action FROM audit_log WHERE action LIKE 'position.emergency.%'`).all();
    expect(audits).toEqual([]);
  });
});
