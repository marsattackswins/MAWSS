/**
 * Reconciliation-level coverage for orphaned conditional orders (a flat symbol
 * keeps the leg that did not fire) and for a stale conditional-order view.
 */

import { BinanceRestClient } from "@/lib/server/binance/rest";
import { RateLimiter } from "@/lib/server/binance/ratelimit";
import { Reconciler } from "@/lib/server/binance/recon";
import { applyOpenOrdersSnapshot, applyPositionSnapshot, liveState } from "@/lib/server/binance/state";
import {
  getProtectionIntent,
  saveProtectionIntent,
  setProtectionStatus,
} from "@/lib/server/binance/protection";
import { getDb } from "@/lib/server/db/connection";
import { persistenceProfileFromConfig, type PersistenceProfile } from "@/lib/server/profile/context";
import type { EnvConfig } from "@/lib/server/env/config";
import type { BinanceAlgoOrder, BinanceAlgoOrderType, PositionRiskRow } from "@/lib/server/binance/types";
import { FakeHttp, freshEnv, installFakes, jsonRes, makeCfg } from "./helpers";

function positionRow(): PositionRiskRow {
  return {
    symbol: "BTCUSDT",
    positionAmt: "0.001",
    entryPrice: "50000",
    markPrice: "50000",
    unRealizedProfit: "0",
    liquidationPrice: "0",
    leverage: "1",
    positionSide: "BOTH",
  } as PositionRiskRow;
}

function algoOrder(clientAlgoId: string, orderType: BinanceAlgoOrderType, triggerPrice: string): BinanceAlgoOrder {
  return {
    algoId: 501,
    clientAlgoId,
    algoType: "CONDITIONAL",
    orderType,
    symbol: "BTCUSDT",
    side: "SELL",
    positionSide: "BOTH",
    algoStatus: "NEW",
    triggerPrice,
    quantity: "",
    closePosition: true,
    createTime: 1,
    updateTime: 2,
    actualOrderId: "",
  };
}

interface Harness {
  cfg: EnvConfig;
  http: FakeHttp;
  profile: PersistenceProfile;
  recon: Reconciler;
  /** Exchange truth: open conditional orders for BTCUSDT. */
  algoOrders: BinanceAlgoOrder[];
  /** Exchange truth: open positions. */
  positions: PositionRiskRow[];
}

function setup(overrides: Partial<EnvConfig> = {}): Harness {
  const cfg = freshEnv(makeCfg(overrides));
  const http = new FakeHttp();
  installFakes(http);
  const rest = new BinanceRestClient(cfg, new RateLimiter(cfg.rateInternalPerMin), async () => undefined);
  rest.setTransportForTests(http);
  const profile = persistenceProfileFromConfig(cfg);
  const harness: Harness = {
    cfg,
    http,
    profile,
    recon: undefined as unknown as Reconciler,
    algoOrders: [],
    positions: [],
  };

  http.route("/fapi/v1/openAlgoOrders", () => jsonRes(harness.algoOrders));
  http.route("/fapi/v1/algoOrder", () => {
    const request = http.calls[http.calls.length - 1];
    const clientAlgoId = new URL(request.url).searchParams.get("clientAlgoId") ?? "";
    const index = harness.algoOrders.findIndex((order) => order.clientAlgoId === clientAlgoId);
    if (index < 0) return jsonRes({ code: -2011, msg: "Unknown algo order sent." }, 400);
    harness.algoOrders.splice(index, 1);
    return jsonRes({ code: "200", msg: "success" });
  });
  http.route("/fapi/v1/userTrades", () => jsonRes([]));

  harness.recon = new Reconciler({
    persistenceProfile: profile,
    rest,
    snapshot: async () => {
      applyPositionSnapshot(harness.positions);
      applyOpenOrdersSnapshot([], harness.algoOrders);
    },
    freeze: () => undefined,
    unfreeze: () => undefined,
  });
  return harness;
}

function alertBodies(fetchSpy: { mock: { calls: unknown[][] } }): string[] {
  return fetchSpy.mock.calls.map(([, init]) => String((init as RequestInit | undefined)?.body ?? ""));
}

test("a flat symbol's leftover closePosition order is cancelled during reconciliation", async () => {
  const h = setup();
  h.algoOrders = [algoOrder("legacy-tp", "TAKE_PROFIT_MARKET", "51000")];

  const result = await h.recon.run("orphan-recon");

  expect(result.result).toBe("ok");
  expect(h.algoOrders).toHaveLength(0);
  expect(liveState().openOrders.has("legacy-tp")).toBe(false);
  expect(h.http.callsTo("/fapi/v1/algoOrder").some((call) => call.method === "DELETE")).toBe(true);
  expect(result.diffs.some((diff) => diff.includes("cancelled 1 orphaned conditional order"))).toBe(true);
  expect(
    getDb().prepare(`SELECT id FROM audit_log WHERE action = 'position.algo_orphan.cleaned'`).get(),
  ).toBeTruthy();
});

test("a failed orphan cancel alerts and the leftover order never protects a later position", async () => {
  const h = setup({ alertWebhookUrl: "https://alerts.example.test/hook" });
  h.algoOrders = [algoOrder("legacy-tp", "TAKE_PROFIT_MARKET", "51000")];
  h.http.script("/fapi/v1/algoOrder", () => jsonRes({ code: -1000, msg: "cancel failed" }, 400));
  const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  try {
    const first = await h.recon.run("orphan-failure");

    expect(first.diffs.some((diff) => diff.includes("remain open for flat BTCUSDT"))).toBe(true);
    expect(h.algoOrders.map((order) => order.clientAlgoId)).toEqual(["legacy-tp"]);
    expect(alertBodies(fetchSpy).some((body) => body.includes("position_algo_orphan_cleanup_failed:BTCUSDT"))).toBe(true);

    // A new position on the same symbol whose intent trigger happens to match
    // the leftover order must still not be treated as protected.
    h.positions = [positionRow()];
    saveProtectionIntent({ symbol: "BTCUSDT", side: "long", tpPrice: "51000", slPrice: null }, Date.now(), h.profile);
    setProtectionStatus("BTCUSDT", "UNPROTECTED", "new position awaiting protection", h.profile);

    await h.recon.run("new-position");

    expect(getProtectionIntent("BTCUSDT", h.profile)?.protectionStatus).toBe("UNPROTECTED");
  } finally {
    fetchSpy.mockRestore();
  }
});

