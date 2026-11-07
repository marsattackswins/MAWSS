import { beforeEach, describe, expect, test } from "@jest/globals";

import { BinanceApiError, BinanceRestClient } from "@/lib/server/binance/rest";
import { RateLimiter } from "@/lib/server/binance/ratelimit";
import { FakeHttp, freshEnv, installFakes, jsonRes, makeCfg } from "./helpers";

const algoResponse = {
  algoId: 321,
  clientAlgoId: "maws-sl-321",
  algoType: "CONDITIONAL",
  orderType: "STOP_MARKET",
  symbol: "BTCUSDT",
  side: "SELL",
  positionSide: "BOTH",
  algoStatus: "NEW",
  triggerPrice: "49000",
  quantity: "",
  closePosition: true,
  createTime: 1_700_000_000_000,
  updateTime: 1_700_000_000_000,
  actualOrderId: "",
};

describe("Binance Algo Order REST methods", () => {
  let http: FakeHttp;
  let rest: BinanceRestClient;

  beforeEach(() => {
    const cfg = freshEnv(makeCfg());
    http = new FakeHttp();
    installFakes(http);
    http.route("/fapi/v1/algoOrder", () => jsonRes(algoResponse));
    http.route("/fapi/v1/openAlgoOrders", () => jsonRes([algoResponse]));
    http.route("/fapi/v1/algoOpenOrders", () => jsonRes([algoResponse]));
    http.route("/fapi/v1/openOrders", () => jsonRes([]));
    rest = new BinanceRestClient(cfg, new RateLimiter(cfg.rateInternalPerMin), async () => undefined);
  });

  test("places, queries, lists, and cancels conditional algo orders through their dedicated endpoints", async () => {
    const placed = await rest.placeAlgoOrder({
      algoType: "CONDITIONAL",
      symbol: "BTCUSDT",
      side: "SELL",
      type: "STOP_MARKET",
      triggerPrice: "49000",
      closePosition: true,
      workingType: "MARK_PRICE",
      priceProtect: true,
      clientAlgoId: "maws-sl-321",
    });
    const listed = await rest.getOpenAlgoOrders("BTCUSDT");
    const queried = await rest.getAlgoOrder({ clientAlgoId: "maws-sl-321" });
    const canceled = await rest.cancelAlgoOrder({ algoId: 321 });
    const canceledAll = await rest.cancelAllAlgoOrders("BTCUSDT");

    expect(placed.algoId).toBe(321);
    expect(listed).toHaveLength(1);
    expect(queried.clientAlgoId).toBe("maws-sl-321");
    expect(canceled.algoStatus).toBe("NEW");
    expect(canceledAll).toHaveLength(1);

    const calls = http.calls;
    expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ["POST", "/fapi/v1/algoOrder"],
      ["GET", "/fapi/v1/openAlgoOrders"],
      ["GET", "/fapi/v1/algoOrder"],
      ["DELETE", "/fapi/v1/algoOrder"],
      ["DELETE", "/fapi/v1/algoOpenOrders"],
    ]);

    const placeParams = new URL(calls[0].url).searchParams;
    expect(placeParams.get("algoType")).toBe("CONDITIONAL");
    expect(placeParams.get("type")).toBe("STOP_MARKET");
    expect(placeParams.get("triggerPrice")).toBe("49000");
    expect(placeParams.get("closePosition")).toBe("true");
    expect(placeParams.get("workingType")).toBe("MARK_PRICE");
    expect(placeParams.get("priceProtect")).toBe("true");
    expect(placeParams.get("clientAlgoId")).toBe("maws-sl-321");
    expect(placeParams.has("quantity")).toBe(false);
    expect(placeParams.has("reduceOnly")).toBe(false);

    expect(new URL(calls[1].url).searchParams.get("symbol")).toBe("BTCUSDT");
    expect(new URL(calls[2].url).searchParams.get("clientAlgoId")).toBe("maws-sl-321");
    expect(new URL(calls[3].url).searchParams.get("algoId")).toBe("321");
    expect(new URL(calls[4].url).searchParams.get("symbol")).toBe("BTCUSDT");
    for (const call of calls) {
      const params = new URL(call.url).searchParams;
      expect(params.has("timestamp")).toBe(true);
      expect(params.has("recvWindow")).toBe(true);
      expect(params.has("signature")).toBe(true);
      expect(call.headers?.["X-MBX-APIKEY"]).toBe("test-api-key");
    }

    expect(await rest.getOpenOrders("BTCUSDT")).toEqual([]);
    expect(http.calls.at(-1)?.url).toContain("/fapi/v1/openOrders");
  });

  test("rejects missing identifiers, missing list symbols, and invalid algo client IDs before I/O", () => {
    expect(() => rest.getOpenAlgoOrders("")).toThrow("A symbol is required");
    expect(() => rest.cancelAllAlgoOrders("")).toThrow("A symbol is required");
    expect(() => rest.getAlgoOrder({})).toThrow("Provide exactly one");
    expect(() => rest.cancelAlgoOrder({ algoId: 321, clientAlgoId: "maws-sl-321" })).toThrow(
      "Provide exactly one",
    );
    expect(() =>
      rest.placeAlgoOrder({
        algoType: "CONDITIONAL",
        symbol: "BTCUSDT",
        side: "SELL",
        type: "STOP_MARKET",
        triggerPrice: "49000",
        closePosition: true,
        clientAlgoId: "invalid id",
      }),
    ).toThrow("clientAlgoId");
    expect(http.calls).toHaveLength(0);
  });

  test("never submits conditional types to the standard order endpoint", () => {
    expect(() => rest.placeOrder({
      symbol: "BTCUSDT",
      side: "SELL",
      type: "STOP_MARKET",
      quantity: "0.001",
      stopPrice: "49000",
    })).toThrow("must be submitted through the Binance Algo Order API");
    expect(http.calls).toHaveLength(0);
  });

  test("honors a 429 Retry-After once before returning control to the caller", async () => {
    const waits: number[] = [];
    rest.setSleeperForTests(async (ms) => { waits.push(ms); });
    http.script("/fapi/v1/algoOrder", () => {
      const response = jsonRes({ code: -1003, msg: "Too many requests" }, 429);
      response.headers = { "Retry-After": "2" };
      return response;
    });

    await expect(rest.placeAlgoOrder({
      algoType: "CONDITIONAL",
      symbol: "BTCUSDT",
      side: "SELL",
      type: "STOP_MARKET",
      triggerPrice: "49000",
      closePosition: true,
    })).rejects.toMatchObject({ httpStatus: 429, retryAfterMs: 2000 });
    expect(waits).toEqual([2000]);
    expect(http.calls).toHaveLength(1);
  });

  test("418 pauses subsequent Binance requests until Retry-After expires", async () => {
    http.script("/fapi/v1/openAlgoOrders", () => {
      const response = jsonRes({ code: -1003, msg: "IP banned" }, 418);
      response.headers = { "Retry-After": "60" };
      return response;
    });

    await expect(rest.getOpenAlgoOrders("BTCUSDT")).rejects.toBeInstanceOf(BinanceApiError);
    await expect(rest.getOpenOrders("BTCUSDT")).rejects.toMatchObject({ httpStatus: 418 });
    expect(http.calls).toHaveLength(1);
  });
});
