import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { expect, test } from "./fixtures";
import { parseGuardLog, violations } from "./disconnected-policy";

/**
 * E2E: the disconnected network policy.
 *
 * The app sits behind the operator session (the shared fixture logs in through
 * the real /api/auth/login route), no profile is attached, and the server-side
 * guard records every real Binance request the app attempts. This spec drives a
 * normal Disconnected session and proves the contract: only allowlisted,
 * unsigned public market GETs, no WebSocket, no listenKey, no Demo Trading host.
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

test("a Disconnected session issues only allowlisted, unsigned public requests", async ({ page }) => {
  // The log accumulates across specs; only this test's attempts are relevant.
  rmSync(GUARD_LOG, { force: true });

  await page.goto("/");
  await expect(page.locator('[data-testid="topbar-disconnected"]')).toBeVisible({ timeout: 20_000 });

  // Loading the workspace asks the server for the ticker/symbol catalogue.
  await expect
    .poll(() => guardLog().includes("fapi.binance.com"), { timeout: 30_000, intervals: [250] })
    .toBe(true);

  const entries = parseGuardLog(guardLog());
  expect(entries.length).toBeGreaterThan(0);

  // The proxy traffic that the chart needs is really being exercised.
  expect(entries.some((e) => /\/fapi\/v1\/(ticker\/24hr|klines|exchangeInfo)/.test(e.url))).toBe(true);

  // Nothing order-, account- or socket-shaped, nothing signed, nothing from
  // Demo Trading: the whole point of staying Disconnected.
  expect(violations(entries)).toEqual([]);
  expect(entries.filter((e) => e.kind === "websocket")).toEqual([]);
  expect(entries.filter((e) => /listenKey|userData/i.test(e.url))).toEqual([]);
});
