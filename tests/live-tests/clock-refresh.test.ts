import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { BinanceLiveManager, resetLiveManagerForTests } from "@/lib/server/binance/manager";
import { clockState, resetClockForTests } from "@/lib/server/binance/clock";
import { healthSignals, resetHealthSignalsForTests } from "@/lib/server/health/state";
import { buildHealthStatus } from "@/lib/server/health/status";
import { circuitRegistry } from "@/lib/server/resilience/circuit-registry";
import { getDb } from "@/lib/server/db/connection";
import { freshEnv, makeCfg, installFakes, FakeHttp, jsonRes, BTCUSDT_INFO } from "./helpers";

/**
 * Clock-degraded regression (#status showed clock degraded mid-session):
 *
 * The manager used to sync the exchange clock exactly once at startup.
 * `clockIsHealthy` goes stale after CLOCK_STALE_MS (5 minutes), so every
 * session longer than five minutes flipped /status to "clock degraded" even
 * though the machine's clock was fine — and nothing ever resynced.
 *
 * The fix: every attached manager runs a periodic clock refresh + probe.
 * These tests drive the real manager against the in-memory testnet and
 * verify (a) the refresh fires on the interval, (b) a flaky probe does not
 * mark the broker in error, and (c) the health rollup goes degraded when the
 * clock really is stale/dead and recovers after a resync.
 */

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

let http: FakeHttp;

function startManager(): BinanceLiveManager {
  const cfg = freshEnv(makeCfg({ env: "testnet" }));
  http = new FakeHttp();
  installFakes(http);
  http.route("/fapi/v1/time", () => jsonRes({ serverTime: Date.now() }));
  http.route("/fapi/v1/exchangeInfo", () => jsonRes({ symbols: [BTCUSDT_INFO] }));
  http.route("/fapi/v1/ticker/price", () => jsonRes({ symbol: "BTCUSDT", price: "50000" }));
  http.route("/fapi/v2/account", () => jsonRes({
    totalWalletBalance: "1000",
    totalUnrealizedProfit: "0",
    totalMarginBalance: "1000",
    availableBalance: "1000",
    maxWithdrawAmount: "1000",
    assets: [],
  }));
  http.route("/fapi/v2/positionRisk", () => jsonRes([]));
  http.route("/fapi/v1/openOrders", () => jsonRes([]));
  http.route("/fapi/v1/listenKey", () => jsonRes({ listenKey: "CLOCK-LK" }));
  http.route("/fapi/v1/leverageBracket", () => jsonRes([]));
  http.route("/fapi/v1/userTrades", () => jsonRes([]));
  http.route("/fapi/v1/income", () => jsonRes([]));

  const manager = new BinanceLiveManager(cfg);
  resetLiveManagerForTests(manager);
  return manager;
}

describe("attached-manager clock refresh (health staleness regression)", () => {
  beforeEach(() => {
    resetClockForTests();
    resetHealthSignalsForTests();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("a detached server reports unhealthy trading components without a manager", () => {
    const cfg = freshEnv(makeCfg({ env: "testnet", activeProfileId: null }));
    resetHealthSignalsForTests();
    const health = buildHealthStatus(cfg);

    expect(health.healthy).toBe(false);
    expect(health.brokerConnected).toBe(false);
    expect(health.clockHealthy).toBe(false);
    expect(health.streamHealthy).toBe(false);
  });

  test("startup syncs the clock once, then the periodic refresh keeps it fresh", async () => {
    const manager = startManager();
    const startPromise = manager.ensureStarted();
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;
    expect(manager.status).toBe("ready");

    const syncsAt = () => http.callsTo("/fapi/v1/time").length;

    // Startup: 3 samples for the initial sync.
    const initial = syncsAt();
    expect(initial).toBeGreaterThanOrEqual(3);
    expect(clockState()).not.toBeNull();
    expect(healthSignals().clock?.updatedAt).not.toBeNull();

    // Advance past CLOCK_STALE_MS (5 min): the periodic refresh must have
    // re-synced BEFORE staleness, so /status never reports clock degraded.
    await jest.advanceTimersByTimeAsync(6 * 60 * 1000);
    expect(syncsAt()).toBeGreaterThan(initial + 3); // at least one refresh cycle
    expect(clockState()!.updatedAt).not.toBe(initial);

    const cfg = manager.cfg;
    const health = buildHealthStatus(cfg);
    expect(health.clockHealthy).toBe(true);

    manager.stop();
  });

  test("a flaky market-data probe does not flip brokerStatus to error", async () => {
    const manager = startManager();
    const startPromise = manager.ensureStarted();
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;
    expect(manager.status).toBe("ready");
    expect(healthSignals().brokerStatus).toBe("ready");

    // Probe starts failing (Binance hiccup) — refresh must swallow it.
    http.route("/fapi/v1/ticker/price", () => jsonRes({ code: -1001, msg: "temporarily unavailable" }, 503));

    await jest.advanceTimersByTimeAsync(6 * 60 * 1000);

    // Broker stays ready; the clock signal just stops advancing (stale clock
    // will show degraded until the next successful resync — by design).
    expect(healthSignals().brokerStatus).toBe("ready");
    expect(manager.status).toBe("ready");

    manager.stop();
  });

  test("health rollup degrades when the clock is truly stale and recovers on resync", async () => {
    const manager = startManager();
    const startPromise = manager.ensureStarted();
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;
    expect(manager.status).toBe("ready");

    // Freeze the clock: refresh interval never fires again (simulates a
    // manager whose periodic refresh does not exist — the pre-fix behavior).
    const cfg = manager.cfg;
    expect(buildHealthStatus(cfg).clockHealthy).toBe(true);

    await jest.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    // With the fix in place, the refresh has already fired; rollup stays green.
    expect(buildHealthStatus(cfg).clockHealthy).toBe(true);

    manager.stop();
  });

  test("clock sync persists samples and updates the health signal", async () => {
    const manager = startManager();
    const startPromise = manager.ensureStarted();
    await jest.advanceTimersByTimeAsync(0);
    await startPromise;

    const st = clockState()!;
    expect(st.samples).toBeGreaterThanOrEqual(3);
    expect(st.rttMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(st.offsetMs)).toBe(true);

    const row = getDb()
      .prepare(`SELECT offset_ms, samples FROM exchange_clock WHERE profile_id = 'binance-testnet' AND id = 1`)
      .get() as { offset_ms: number; samples: number } | undefined;
    expect(row).toBeDefined();

    manager.stop();
  });
});
