import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

/**
 * The browser guard (e2e/fixtures.ts) cannot see the Next server's own outbound
 * calls, so playwright.config.ts preloads e2e/server-network-guard.cjs into the
 * web server. This spec proves that guard is actually loaded: a route that
 * proxies Binance must fail deterministically instead of returning live data,
 * and the attempt must be recorded by the guard.
 */
const GUARD_LOG = path.resolve(
  process.env.MAWS_E2E_GUARD_LOG ?? path.join("test-results", "server-network-guard.log"),
);

function guardLog(): string {
  try {
    return readFileSync(GUARD_LOG, "utf8");
  } catch {
    return "";
  }
}

test("server network guard blocks the app's own Binance proxy call", async ({ request }) => {
  // /api/binance/ticker fetches fapi.binance.com from the server process. With
  // the guard loaded the upstream call is blocked, so the route answers with its
  // generic upstream failure (502) rather than live market data.
  const response = await request.get("/api/binance/ticker?symbol=BTCUSDT");
  expect(response.status()).toBe(502);
  expect(await response.json()).toEqual({ error: "Upstream service unavailable" });

  await expect
    .poll(guardLog, { timeout: 15_000, intervals: [250] })
    .toMatch(/blocked \S+ fetch https:\/\/fapi\.binance\.com\/fapi\/v1\/ticker/);
});
