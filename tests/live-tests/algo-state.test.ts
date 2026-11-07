import { beforeEach, describe, expect, test } from "@jest/globals";

import {
  applyAlgoOrderEvent,
  applyOpenOrdersSnapshot,
  liveState,
  resetLiveStateForTests,
} from "@/lib/server/binance/state";
import type { BinanceAlgoOrder } from "@/lib/server/binance/types";
import { freshEnv, makeCfg } from "./helpers";

const algoOrder: BinanceAlgoOrder = {
  algoId: 91,
  clientAlgoId: "maws-sl-91",
  algoType: "CONDITIONAL",
  orderType: "STOP_MARKET",
  symbol: "BTCUSDT",
  side: "SELL",
  positionSide: "BOTH",
  algoStatus: "NEW",
  triggerPrice: "49000",
  quantity: "",
  closePosition: true,
  createTime: 100,
  updateTime: 101,
  actualOrderId: "",
};

describe("algo order live-state normalization", () => {
  beforeEach(() => {
    freshEnv(makeCfg());
    resetLiveStateForTests();
  });

  test("normalizes open algo orders into the shared protective-order state", () => {
    applyOpenOrdersSnapshot([], [algoOrder]);

    expect(liveState().openOrders.get("maws-sl-91")).toMatchObject({
      clientOrderId: "maws-sl-91",
      kind: "algo",
      algoId: 91,
      exchangeOrderId: null,
      type: "STOP_MARKET",
      side: "SELL",
      closePosition: true,
      stopPrice: "49000",
      status: "NEW",
    });
  });

  test("triggered algo events mark history and remove the algo from open orders", () => {
    applyOpenOrdersSnapshot([], [algoOrder]);
    const updated = applyAlgoOrderEvent({
      e: "ALGO_UPDATE",
      E: 120,
      T: 119,
      o: {
        caid: "maws-sl-91",
        aid: 91,
        at: "CONDITIONAL",
        o: "STOP_MARKET",
        s: "BTCUSDT",
        S: "SELL",
        ps: "BOTH",
        q: "",
        X: "TRIGGERED",
        ai: 9001,
      },
    });

    expect(updated).toMatchObject({
      kind: "algo",
      status: "TRIGGERED",
      algoId: 91,
      exchangeOrderId: 9001,
    });
    expect(liveState().openOrders.has("maws-sl-91")).toBe(false);
    expect(liveState().orders.get("maws-sl-91")?.status).toBe("TRIGGERED");
  });

  test("unknown algo statuses are retained without being treated as working", () => {
    const updated = applyAlgoOrderEvent({
      e: "ALGO_UPDATE",
      o: {
        caid: "maws-sl-unknown",
        aid: 92,
        o: "STOP_MARKET",
        s: "BTCUSDT",
        S: "SELL",
        X: "FUTURE_STATUS",
      },
    });
    expect(updated?.status).toBe("FUTURE_STATUS");
    expect(liveState().openOrders.has("maws-sl-unknown")).toBe(false);
  });
});
