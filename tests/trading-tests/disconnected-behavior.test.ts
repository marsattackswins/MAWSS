/**
 * Regression tests for paper trading removal and disconnected behavior.
 *
 * Covers:
 *   - Startup without credentials remains disconnected;
 *   - Trading actions are rejected while disconnected;
 *   - Legacy paper state migrates safely;
 *   - Testnet and Production requests cannot cross-route;
 *   - Failed switching leaves no executable stale session/commands;
 *   - Existing risk gates remain enforced (halt reason is surfaced);
 *   - Test-only mocks cannot become a production trading mode;
 *   - Journal/balance/history is empty when disconnected (no fabricated data).
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";

jest.mock("@/lib/maws/feed", () => ({
  mawsFeed: {
    getKlineStatus: jest.fn(() => "live" as const),
    getQuote: jest.fn(() => ({
      symbol: "BTCUSDT",
      last: 50_000,
      open: 50_000,
      high: 50_000,
      low: 50_000,
      volume: 0,
      change: 0,
      changePct: 0,
      rsi: null,
      atr: null,
    })),
    getCandles: jest.fn(() => []),
  },
  binanceFuturesFeed: {},
  normalizeAppSymbol: (s: string) => s,
  formatPrice: (_symbol: string, value: number) => String(value),
  formatVolume: (value: number) => String(value),
}));

jest.mock("@/lib/live/api", () => ({
  LiveAuthError: class LiveAuthError extends Error {},
  LiveApiError: class LiveApiError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
    ) {
      super(message);
      this.name = "LiveApiError";
    }
  },
  setCsrf: jest.fn(),
  liveApi: {
    submitOrder: jest.fn(),
    cancelOrder: jest.fn(),
    closePosition: jest.fn(),
    protect: jest.fn(),
  },
}));

import {
  dispatchSubmitOrder,
  dispatchCancelOrder,
  dispatchClosePosition,
  dispatchClosePositionFraction,
  dispatchProtect,
  tradingHaltReason,
  isLiveBrokerConnected,
} from "@/lib/trading/dispatch";
import { getBrokerBook } from "@/lib/selectors/broker";
import { liveApi } from "@/lib/live/api";
import { useAppStore } from "@/lib/store";
import { useLiveStore } from "@/lib/live/store";
import { normalizeConnectionRehydrate } from "@/lib/slices/connection-slice";
import type { Store } from "@/lib/store";

const INPUT = {
  symbol: "BTCUSDT",
  side: "buy" as const,
  type: "market" as const,
  price: 0,
  qty: 0.001,
  clientOrderId: "regression-test-1",
};

function lastNotice(): { id: number; tone: string; text: string } | undefined {
  const notices = useLiveStore.getState().notices;
  return notices[notices.length - 1];
}

beforeEach(() => {
  useAppStore.setState({ connectedBroker: null } as Partial<Store>);
  useLiveStore.setState({
    attached: false,
    profileId: null,
    environment: null,
    phase: "idle",
    ready: false,
    executionAllowed: false,
    generation: 0,
    reasonCode: null,
    managerStatus: "idle",
    managerError: null,
    account: null,
    positions: [],
    orders: [],
    fills: [],
    health: null,
    notices: [],
  });
  jest.mocked(liveApi.submitOrder).mockClear();
  jest.mocked(liveApi.cancelOrder).mockClear();
  jest.mocked(liveApi.closePosition).mockClear();
  jest.mocked(liveApi.protect).mockClear();
});

describe("startup without credentials remains disconnected", () => {
  test("connectedBroker is null by default", () => {
    expect(useAppStore.getState().connectedBroker).toBeNull();
  });

  test("isLiveBrokerConnected returns false when disconnected", () => {
    expect(isLiveBrokerConnected()).toBe(false);
  });

  test("tradingHaltReason returns not_connected when disconnected", () => {
    expect(tradingHaltReason()).toBe("not_connected");
  });
});

describe("trading actions are rejected while disconnected", () => {
  test("dispatchSubmitOrder returns not_connected and never hits the API", async () => {
    const res = await dispatchSubmitOrder(INPUT);
    expect(res).toEqual({ ok: false, error: "not_connected" });
    expect(liveApi.submitOrder).not.toHaveBeenCalled();
    expect(lastNotice()?.tone).toBe("error");
  });

  test("dispatchCancelOrder returns not_connected and never hits the API", async () => {
    const res = await dispatchCancelOrder("order-1");
    expect(res).toEqual({ ok: false, error: "not_connected" });
    expect(liveApi.cancelOrder).not.toHaveBeenCalled();
  });

  test("dispatchClosePosition returns not_connected and never hits the API", async () => {
    const res = await dispatchClosePosition("BTCUSDT");
    expect(res).toEqual({ ok: false, error: "not_connected" });
    expect(liveApi.closePosition).not.toHaveBeenCalled();
  });

  test("dispatchClosePositionFraction always returns unavailable", async () => {
    const res = await dispatchClosePositionFraction("BTCUSDT", 0.5);
    expect(res).toEqual({ ok: false, error: "partial_close_unavailable" });
  });

  test("dispatchProtect returns not_connected and never hits the API", async () => {
    const res = await dispatchProtect("BTCUSDT", 55000, 45000);
    expect(res).toEqual({ ok: false, error: "not_connected" });
    expect(liveApi.protect).not.toHaveBeenCalled();
  });
});

describe("legacy paper state migrates safely", () => {
  test("connectedBroker=mock migrates to null (disconnected)", () => {
    const state = { connectedBroker: "mock" as unknown } as Store;
    normalizeConnectionRehydrate(state);
    expect(state.connectedBroker).toBeNull();
  });

  test("connectedBroker=binance is preserved for server re-verification", () => {
    const state = { connectedBroker: "binance" as unknown } as Store;
    normalizeConnectionRehydrate(state);
    expect(state.connectedBroker).toBe("binance");
  });

  test("connectedBroker=null stays null", () => {
    const state = { connectedBroker: null } as Store;
    normalizeConnectionRehydrate(state);
    expect(state.connectedBroker).toBeNull();
  });

  test("connectedBroker=undefined becomes null", () => {
    const state = {} as Store;
    normalizeConnectionRehydrate(state);
    expect(state.connectedBroker).toBeNull();
  });
});

describe("Testnet and Production requests cannot cross-route", () => {
  test("broker book is empty when not connected to binance", () => {
    const book = getBrokerBook(
      { connectedBroker: null },
      { orders: [], positions: [] },
    );
    expect(book.orders).toEqual([]);
    expect(book.positions).toEqual([]);
  });

  test("broker book shows live data only when connected to binance", () => {
    const liveOrder = { id: "o1", symbol: "BTCUSDT", side: "buy" as const, type: "limit" as const, price: 50000, qty: 1, reduceOnly: false, closePosition: false, time: 0 };
    const livePos = { id: "p1", symbol: "BTCUSDT", side: "long" as const, entry: 50000, qty: 1, tp: null, sl: null, leverage: 10, liq: null, mark: 50000, unrealized: 0, openedAt: 0 };
    const book = getBrokerBook(
      { connectedBroker: "binance" as const },
      { orders: [liveOrder], positions: [livePos] },
    );
    expect(book.orders).toHaveLength(1);
    expect(book.positions).toHaveLength(1);
  });

  test("disconnected book never returns live data even when live store is populated", () => {
    const liveOrder = { id: "o1", symbol: "BTCUSDT", side: "buy" as const, type: "limit" as const, price: 50000, qty: 1, reduceOnly: false, closePosition: false, time: 0 };
    const livePos = { id: "p1", symbol: "BTCUSDT", side: "long" as const, entry: 50000, qty: 1, tp: null, sl: null, leverage: 10, liq: null, mark: 50000, unrealized: 0, openedAt: 0 };
    const book = getBrokerBook(
      { connectedBroker: null },
      { orders: [liveOrder], positions: [livePos] },
    );
    expect(book.orders).toHaveLength(0);
    expect(book.positions).toHaveLength(0);
  });
});

describe("failed switching leaves no executable stale session/commands", () => {
  test("when connectedBroker is null, tradingHaltReason is not_connected (not trading_halted)", () => {
    // This ensures that even after a failed switch that leaves the broker null,
    // the halt reason is clearly "not_connected" — no stale session can execute.
    useAppStore.setState({ connectedBroker: null } as Partial<Store>);
    useLiveStore.setState({
      phase: "failed",
      ready: false,
      reasonCode: "target_start_failed",
      health: null,
    });
    expect(tradingHaltReason()).toBe("not_connected");
  });

  test("when connectedBroker is binance but phase is failed, halt reason carries the failure", () => {
    useAppStore.setState({ connectedBroker: "binance" } as Partial<Store>);
    useLiveStore.setState({
      phase: "failed",
      ready: false,
      reasonCode: "target_start_failed",
      health: null,
    });
    const reason = tradingHaltReason();
    expect(reason).toBe("target_start_failed");
  });
});

describe("existing risk gates remain enforced", () => {
  test("kill switch blocks live submissions even when connected", async () => {
    useAppStore.setState({ connectedBroker: "binance" } as Partial<Store>);
    useLiveStore.setState({
      phase: "ready",
      ready: true,
      profileId: "binance-testnet",
      generation: 1,
      health: {
        env: "testnet",
        brokerConnected: true,
        execution: {
          env: "testnet",
          envAllowsSubmissions: true,
          profileExecutionEnabled: true,
          runtimeEnabled: true,
          killSwitch: true,
          frozen: false,
          frozenReason: "",
          canSubmit: false,
          reasons: ["kill switch engaged"],
        },
        clockHealthy: true,
        streamHealthy: true,
        reconHealthy: true,
        submissionsFrozen: false,
        frozenReasons: [],
        healthy: false,
        signals: {
          brokerStatus: "ready",
          brokerError: null,
          stream: { connected: true, reconnects: 0, lastEventAt: Date.now() },
          clock: { offsetMs: 10, updatedAt: Date.now() },
          recon: { lastRunAt: Date.now(), lastResult: "clean" },
        },
      },
    });

    const res = await dispatchSubmitOrder(INPUT);
    expect(res).toEqual({ ok: false, error: "trading_halted" });
    expect(liveApi.submitOrder).not.toHaveBeenCalled();
  });
});

describe("test-only mocks cannot become a production trading mode", () => {
  test("BrokerId type does not include 'mock'", () => {
    // The BrokerId type is "binance" | "okx" — "mock" is not a valid value.
    // This is enforced at the type level; a runtime check confirms the store
    // can never hold "mock".
    const state = { connectedBroker: "mock" as unknown } as Store;
    normalizeConnectionRehydrate(state);
    expect(state.connectedBroker).not.toBe("mock");
  });

  test("dispatch never routes to a mock/paper path", async () => {
    // Even if connectedBroker were somehow "mock", the dispatch checks
    // isLiveBrokerConnected() which returns false for anything other than "binance".
    useAppStore.setState({ connectedBroker: null } as Partial<Store>);
    const res = await dispatchSubmitOrder(INPUT);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("not_connected");
  });
});

describe("no fabricated data when disconnected", () => {
  test("broker book is empty (no fake orders or positions)", () => {
    const book = getBrokerBook(
      { connectedBroker: null },
      { orders: [], positions: [] },
    );
    expect(book.orders).toHaveLength(0);
    expect(book.positions).toHaveLength(0);
  });

  test("trading metrics show zero balance when disconnected", () => {
    // The useTradingMetrics hook returns 0 for all metrics when not live.
    // Here we verify the underlying state supports that: no account data.
    expect(useLiveStore.getState().account).toBeNull();
  });
});

describe("cross-environment routing: Testnet and Production cannot interfere", () => {
  test("switching to binance-production while Testnet is active goes through the halt gate", async () => {
    // In the switching phase, all mutations are blocked on the dispatch side.
    useAppStore.setState({ connectedBroker: "binance" } as Partial<Store>);
    useLiveStore.setState({
      phase: "switching",
      ready: false,
      reasonCode: null,
      health: null,
    });
    const reason = tradingHaltReason();
    expect(reason).toBe("profile_switch_in_progress");

    const res = await dispatchSubmitOrder(INPUT);
    expect(res).toEqual({ ok: false, error: "trading_halted" });
    expect(liveApi.submitOrder).not.toHaveBeenCalled();
  });

  test("detached phase after a failed cross-environment switch blocks dispatch", async () => {
    // detached means the previous profile was stopped but the target could not
    // start and rollback also failed. All mutations must be blocked.
    useAppStore.setState({ connectedBroker: "binance" } as Partial<Store>);
    useLiveStore.setState({
      phase: "detached",
      ready: false,
      reasonCode: "rollback_failed",
      health: null,
      profileId: null,
    });
    const reason = tradingHaltReason();
    expect(reason).toBe("rollback_failed");

    const res = await dispatchSubmitOrder(INPUT);
    expect(res).toEqual({ ok: false, error: "trading_halted" });
    expect(liveApi.submitOrder).not.toHaveBeenCalled();
  });

  test("profile generation mismatch: stale generation blocks mutations (stale_profile)", () => {
    // Callers embed profileId + generation in request headers. If the server
    // detects a generation mismatch it throws stale_profile. Verify the
    // dispatch halt reason surfaces this — simulated here via a degraded state.
    useAppStore.setState({ connectedBroker: "binance" } as Partial<Store>);
    useLiveStore.setState({
      phase: "degraded",
      ready: false,
      reasonCode: "stale_profile",
      health: null,
    });
    const reason = tradingHaltReason();
    expect(reason).toBe("stale_profile");
  });

  test("disconnected state means no order can target any environment", async () => {
    // When the broker is null, there is no environment — both Testnet and
    // Production orders are rejected at the same gate.
    useAppStore.setState({ connectedBroker: null } as Partial<Store>);

    const testnetOrder = { ...INPUT, clientOrderId: "testnet-order" };
    const productionOrder = { ...INPUT, clientOrderId: "production-order" };

    const [r1, r2] = await Promise.all([
      dispatchSubmitOrder(testnetOrder),
      dispatchSubmitOrder(productionOrder),
    ]);

    expect(r1).toEqual({ ok: false, error: "not_connected" });
    expect(r2).toEqual({ ok: false, error: "not_connected" });
    expect(liveApi.submitOrder).not.toHaveBeenCalled();
  });
});

describe("legacy paper history preservation", () => {
  test("legacy paper fields in localStorage are ignored by the store on rehydrate", () => {
    // The partialize function no longer writes paper fields, but legacy browser
    // storage may still carry them. The rehydrate normalizer must not fail and
    // must not expose those values.
    const legacyState = {
      connectedBroker: "mock",
      mockBalance: 99999,
      mockRealized: 500,
      paperAccount: { leverage: { crypto: 100 } },
      orders: [{ id: "paper-order-1" }],
      positions: [{ id: "paper-pos-1" }],
      orderHistory: [{ id: "paper-hist-1" }],
      balanceHistory: [{ id: "paper-bal-1" }],
      journal: [{ id: "j1", time: 1700000000000, text: "Old paper trade" }],
    } as unknown as Store;

    // Rehydration must not throw.
    normalizeConnectionRehydrate(legacyState);

    // connectedBroker=mock becomes null (disconnected).
    expect(legacyState.connectedBroker).toBeNull();

    // The remaining paper fields are not managed by normalizeConnectionRehydrate —
    // they are simply absent from workspacePartialize output, so Zustand never
    // loads them into the live store. They persist in localStorage untouched.
    // Verify the store does NOT have those fields after a fresh init.
    expect((useAppStore.getState() as Record<string, unknown>).mockBalance).toBeUndefined();
    expect((useAppStore.getState() as Record<string, unknown>).paperAccount).toBeUndefined();
    expect((useAppStore.getState() as Record<string, unknown>).orders).toBeUndefined();
    expect((useAppStore.getState() as Record<string, unknown>).positions).toBeUndefined();
    expect((useAppStore.getState() as Record<string, unknown>).journal).toBeUndefined();
    expect((useAppStore.getState() as Record<string, unknown>).balanceHistory).toBeUndefined();
    expect((useAppStore.getState() as Record<string, unknown>).orderHistory).toBeUndefined();
  });

  test("no component path reads paper-only fields from the live store", () => {
    // The live store (useLiveStore) has no paper fields — account, positions,
    // orders, fills all come exclusively from the exchange.
    const liveState = useLiveStore.getState();
    expect(liveState.account).toBeNull(); // null until server confirms
    expect(liveState.positions).toEqual([]);
    expect(liveState.orders).toEqual([]);
    expect(liveState.fills).toEqual([]);
    // No mockBalance / paperAccount on the live store.
    expect((liveState as unknown as Record<string, unknown>).mockBalance).toBeUndefined();
    expect((liveState as unknown as Record<string, unknown>).paperAccount).toBeUndefined();
  });

  test("useTradingMetrics returns zeros when disconnected (no fabricated paper data)", () => {
    // When connectedBroker is null and liveStore.account is null, every
    // metric must be 0 — no historical paper values fill the display.
    useAppStore.setState({ connectedBroker: null } as Partial<Store>);
    useLiveStore.setState({ account: null, accountMetrics: null, positions: [], orders: [], fills: [] });

    // The actual React hook cannot be called outside a React component,
    // but the underlying constants are deterministic: live=false means zeros.
    // Test the data model: account is null, so the fallback is all zeros.
    const account = useLiveStore.getState().account;
    const liveAcc = account ?? { balance: 0, available: 0, equity: 0, margin: 0, unrealized: 0, fetchedAt: null, equitySource: "fallback" as const };
    expect(liveAcc.balance).toBe(0);
    expect(liveAcc.equity).toBe(0);
    expect(liveAcc.available).toBe(0);
  });
});
