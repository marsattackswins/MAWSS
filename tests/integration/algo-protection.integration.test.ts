import { BinanceLiveManager } from "@/lib/server/binance/manager";
import { liveState } from "@/lib/server/binance/state";
import {
  cleanupTestnetState,
  createTestnetManager,
  getCurrentMarkPrice,
  waitForPosition,
} from "./helpers";

const hasTestnetCredentials = Boolean(
  (process.env.MAWS_BINANCE_TESTNET_API_KEY && process.env.MAWS_BINANCE_TESTNET_API_SECRET) ||
  (process.env.MAWS_BINANCE_API_KEY && process.env.MAWS_BINANCE_API_SECRET),
);
const testnetDescribe = hasTestnetCredentials ? describe : describe.skip;

testnetDescribe("Conditional Algo protection integration (Binance Testnet only)", () => {
  let manager: BinanceLiveManager;
  const symbol = "BTCUSDT";

  beforeAll(async () => {
    manager = await createTestnetManager();
    if (manager.cfg.env !== "testnet" || manager.cfg.activeProfileId !== "binance-testnet") {
      throw new Error("Conditional Algo integration test requires the Binance Testnet profile");
    }
  }, 30_000);

  afterEach(async () => {
    if (manager) await cleanupTestnetState(manager);
  }, 30_000);

  afterAll(() => manager?.stop());

  test("opens, replaces, cancels and flattens Algo protection", async () => {
    const position = await manager.orders.submitOrder({
      symbol,
      side: "BUY",
      type: "MARKET",
      qty: "0.001",
      clientOrderId: manager.newClientOrderId("algoit"),
    });
    if (!position.ok) throw new Error(`Testnet position open failed: ${position.error ?? "unknown error"}`);
    await waitForPosition(symbol, true, 15_000);

    const mark = await getCurrentMarkPrice(symbol);
    const first = {
      tpPrice: (mark * 1.1).toFixed(1),
      slPrice: (mark * 0.9).toFixed(1),
    };
    const placed = await manager.orders.protectPosition({ symbol, ...first });
    if (!placed.tp?.ok || !placed.sl?.ok) {
      throw new Error(`Testnet Algo protection placement failed: ${placed.tp?.error ?? placed.sl?.error ?? "unknown error"}`);
    }
    await manager.reconcileRun("algo-protection-integration");

    const listed = await manager.rest.getOpenAlgoOrders(symbol);
    expect(listed.map((order) => order.orderType).sort()).toEqual(["STOP_MARKET", "TAKE_PROFIT_MARKET"]);
    expect([...liveState().openOrders.values()]
      .filter((order) => order.symbol === symbol && order.kind === "algo")
      .map((order) => order.type)
      .sort()).toEqual(["STOP_MARKET", "TAKE_PROFIT_MARKET"]);

    const replaced = await manager.orders.protectPosition({
      symbol,
      tpPrice: (mark * 1.12).toFixed(1),
      slPrice: (mark * 0.88).toFixed(1),
    });
    if (!replaced.tp?.ok || !replaced.sl?.ok) {
      throw new Error(`Testnet Algo protection replacement failed: ${replaced.tp?.error ?? replaced.sl?.error ?? "unknown error"}`);
    }

    const removed = await manager.orders.removeProtection(symbol);
    if (!removed.ok) throw new Error(`Testnet Algo protection removal failed: ${removed.error ?? "unknown error"}`);
    expect(await manager.rest.getOpenAlgoOrders(symbol)).toHaveLength(0);

    const finalProtection = await manager.orders.protectPosition({
      symbol,
      tpPrice: (mark * 1.1).toFixed(1),
      slPrice: (mark * 0.9).toFixed(1),
    });
    if (!finalProtection.tp?.ok || !finalProtection.sl?.ok) {
      throw new Error(`Testnet Algo protection placement before flatten failed: ${finalProtection.tp?.error ?? finalProtection.sl?.error ?? "unknown error"}`);
    }

    const flattened = await manager.emergencyFlatten("integration:algo-protection");
    expect(flattened.failures).toHaveLength(0);
    expect(await manager.rest.getOpenAlgoOrders(symbol)).toHaveLength(0);
    await waitForPosition(symbol, false, 15_000);
  }, 90_000);
});
