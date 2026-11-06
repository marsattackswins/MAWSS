import { BinanceLiveManager } from "@/lib/server/binance/manager";
import { createTestnetManager, log } from "./helpers";

describe("Account margin fields Integration (Binance Testnet)", () => {
  let manager: BinanceLiveManager;

  beforeAll(async () => {
    manager = await createTestnetManager();
  }, 30_000);

  afterAll(() => {
    manager?.stop();
  });

  test("fetches numeric totalMaintMargin and totalMarginBalance without placing orders", async () => {
    const account = await manager.rest.getAccount();
    const totalMaintMarginNumeric =
      typeof account.totalMaintMargin === "string" &&
      account.totalMaintMargin.trim() !== "" &&
      Number.isFinite(Number(account.totalMaintMargin));
    const totalMarginBalanceNumeric =
      typeof account.totalMarginBalance === "string" &&
      account.totalMarginBalance.trim() !== "" &&
      Number.isFinite(Number(account.totalMarginBalance));

    log("GET /fapi/v2/account margin fields", {
      totalMaintMarginPresentAndNumeric: totalMaintMarginNumeric,
      totalMarginBalancePresentAndNumeric: totalMarginBalanceNumeric,
    });

    expect(totalMaintMarginNumeric).toBe(true);
    expect(totalMarginBalanceNumeric).toBe(true);
  }, 30_000);
});
