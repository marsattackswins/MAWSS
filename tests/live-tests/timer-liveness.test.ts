import { BinanceLiveManager, resetLiveManagerForTests } from "@/lib/server/binance/manager";
import { liveState, resetLiveStateForTests } from "@/lib/server/binance/state";
import { getRuntime, RUNTIME_KEYS, setRuntime } from "@/lib/server/runtime/flags";
import { sseBus } from "@/lib/server/binance/sse";
import { FakeHttp, freshEnv, installFakes, jsonRes, makeCfg, accountFixture, BTCUSDT_INFO } from "./helpers";

/**
 * Diagnostic: after startup with an open position, do the reconciliation
 * interval and the mark-price poller keep firing? Guards against timers that
 * arm but never run their first tick (PnL freezes, recon goes silent).
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The reconciliation snapshot and the mark-price poller both write position PnL,
 * and their fixtures disagree (positionRisk reports "0", premiumIndex implies
 * 1.2), so whichever ran last at an arbitrary endpoint is a race. Liveness is
 * proven by PnL leaving the seeded value at *any* sample in the window.
 */
async function sleepWatchingPnl(symbol: string, ms: number): Promise<string[]> {
  const seen: string[] = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(50);
    const pnl = liveState().positions.get(symbol)?.unrealizedProfit;
    if (pnl !== undefined) seen.push(pnl);
  }
  return seen;
}

let manager: BinanceLiveManager;
let http: FakeHttp;
let events: Array<{ event: string; data: unknown }>;
let unsub: (() => void) | null = null;

async function startWithPosition() {
  const cfg = freshEnv(makeCfg({ reconIntervalMs: 2_000, markPriceIntervalMs: 1_500 }));
  http = new FakeHttp();
  installFakes(http);

  http.route("/fapi/v1/time", () => jsonRes({ serverTime: Date.now() }));
  http.route("/fapi/v1/exchangeInfo", () => jsonRes({ symbols: [BTCUSDT_INFO] }));
  http.route("/fapi/v1/ticker/price", () => jsonRes({ symbol: "BTCUSDT", price: "50000" }));
  http.route("/fapi/v2/account", () => jsonRes(accountFixture()));
  http.route("/fapi/v2/positionRisk", () =>
    jsonRes([
      { symbol: "BTCUSDT", positionAmt: "0.012", entryPrice: "50000", markPrice: "50000", unRealizedProfit: "0", liquidationPrice: "40000", leverage: "20", positionSide: "BOTH", notional: "600" },
    ]),
  );
  http.route("/fapi/v1/openOrders", () => jsonRes([]));
  http.route("/fapi/v1/listenKey", () => jsonRes({ listenKey: "LK-TIMER" }));
  http.route("/fapi/v1/leverageBracket", () => jsonRes([]));
  http.route("/fapi/v1/userTrades", () => jsonRes([]));
  http.route("/fapi/v1/premiumIndex", () => jsonRes({ symbol: "BTCUSDT", markPrice: "50100", time: Date.now() }));

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
  resetLiveStateForTests();
});

describe("timer liveness after startup", () => {
  test("recon interval and mark-price poller keep firing while a position is open", async () => {
    await startWithPosition();

    // Startup snapshot seeds the position.
    expect(liveState().positions.get("BTCUSDT")?.qty).toBe("0.012");

    const reconBefore = http.callsTo("/fapi/v2/positionRisk").length;
    events.length = 0;
    await sleepWatchingPnl("BTCUSDT", 7_500);

    // Reconciliation interval: positionRisk is refetched on each run.
    const reconRuns = http.callsTo("/fapi/v2/positionRisk").length - reconBefore;
    const markFetches = http.callsTo("/fapi/v1/premiumIndex").length;

    // eslint-disable-next-line no-console
    console.log(`timer-liveness: reconRuns=${reconRuns} markFetches=${markFetches} sse=${events.map((e) => e.event).join(",")}`);

    expect(reconRuns).toBeGreaterThanOrEqual(2); // ~3 ticks in 7.5s at 2s cadence
    // Deliberate change (request budget): the REST mark poll is now a fallback
    // that fetches only positions whose stream mark is missing or older than
    // 10 s. The startup snapshot is fresh, so the poll must stay quiet here;
    // its stale-mark path is covered by tests/live-tests/request-budget.test.ts.
    expect(markFetches).toBe(0);
    // No poll means no revalued-mark publishes: while the stream is the
    // primary source the SSE channel stays quiet instead of pushing a mark
    // refresh every tick.
    expect(events.some((e) => e.event === "account-update")).toBe(false);
  }, 20_000);

  test("overlapping ensureStarted calls (connect racing switch) keep timers alive", async () => {
    // Reproduces the coordinator's connect→profile-switch overlap: the
    // second ensureStarted lands while the first start is still in flight.
    // The old implementation returned the first generation's promise, whose
    // timers were bound to a superseded generation and silently no-oped.
    const cfg = freshEnv(makeCfg({ reconIntervalMs: 2_000, markPriceIntervalMs: 1_500 }));
    http = new FakeHttp();
    installFakes(http);

    http.route("/fapi/v1/time", () => jsonRes({ serverTime: Date.now() }));
    http.route("/fapi/v1/exchangeInfo", () => jsonRes({ symbols: [BTCUSDT_INFO] }));
    http.route("/fapi/v1/ticker/price", () => jsonRes({ symbol: "BTCUSDT", price: "50000" }));
    http.route("/fapi/v2/account", () => jsonRes(accountFixture()));
    http.route("/fapi/v2/positionRisk", () =>
      jsonRes([
        { symbol: "BTCUSDT", positionAmt: "0.012", entryPrice: "50000", markPrice: "50000", unRealizedProfit: "0", liquidationPrice: "40000", leverage: "20", positionSide: "BOTH", notional: "600" },
      ]),
    );
    http.route("/fapi/v1/openOrders", () => jsonRes([]));
    http.route("/fapi/v1/listenKey", () => jsonRes({ listenKey: "LK-RACE" }));
    http.route("/fapi/v1/leverageBracket", () => jsonRes([]));
    http.route("/fapi/v1/userTrades", () => jsonRes([]));
    http.route("/fapi/v1/premiumIndex", () => jsonRes({ symbol: "BTCUSDT", markPrice: "50100", time: Date.now() }));

    setRuntime(RUNTIME_KEYS.executionEnabled, "true");
    manager = new BinanceLiveManager(cfg);
    resetLiveManagerForTests(manager);

    // Fire two overlapping starts without awaiting the first.
    const first = manager.ensureStarted();
    const second = manager.ensureStarted();
    await Promise.all([first, second]);
    expect(manager.status).toBe("ready");

    const reconBefore = http.callsTo("/fapi/v2/positionRisk").length;
    await sleepWatchingPnl("BTCUSDT", 6_000);

    const reconRuns = http.callsTo("/fapi/v2/positionRisk").length - reconBefore;
    const markFetches = http.callsTo("/fapi/v1/premiumIndex").length;

    // eslint-disable-next-line no-console
    console.log(`race-liveness: reconRuns=${reconRuns} markFetches=${markFetches}`);

    expect(reconRuns).toBeGreaterThanOrEqual(1); // interval alive after the race
    // The fallback mark poll is quiet while the snapshot mark is fresh (see
    // the request-budget tests for the stale path).
    expect(markFetches).toBe(0);
  }, 20_000);
});
