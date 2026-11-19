import { expect, test } from "./fixtures";

/**
 * UI coverage for the submission-freeze banner (login-first, stubbed state).
 *
 * These specs do not exercise the Binance path: the profile, state and freeze
 * endpoints are stubbed so the banner can be asserted deterministically. The
 * server-side clear semantics are covered by tests/live-tests/operator-unfreeze.test.ts.
 */
const ORIGIN = "http://localhost:3001";

const READY_PROFILE = {
  profileId: "binance-testnet",
  environment: "testnet",
  phase: "ready",
  ready: true,
  managerStatus: "ready",
  managerError: null,
  streamHealthy: true,
  executionAllowed: false,
  generation: 7,
  reasonCode: null,
};

const EMPTY_STATE = {
  account: null,
  accountMetrics: null,
  positions: [],
  orders: [],
  fills: [],
};

const BLOCKED_FREEZE = {
  code: "RECON_DRIFT",
  reason: "reconciliation drift: position mismatch",
  since: 1_700_000_000_000,
  clearRule: "clean_recon",
  clearsWithOperator: false,
  blockingReason: "needs a clean reconciliation after 2023-11-14T22:13:20.000Z",
};

const OPERATOR_FREEZE = {
  code: "OPERATOR",
  reason: "manual hold for maintenance",
  since: 1_700_000_000_000,
  clearRule: "operator",
  clearsWithOperator: true,
  blockingReason: "needs an explicit operator unfreeze",
};

async function stubLive(page: import("@playwright/test").Page, freezes: unknown[], onClear?: () => unknown[]) {
  await page.route("**/api/live/profile", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(READY_PROFILE) }),
  );
  await page.route("**/api/live/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(EMPTY_STATE) }),
  );
  // No server stream in this stubbed run: an empty event body keeps the bridge
  // quiet without inventing health payloads.
  await page.route("**/api/live/events", (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: ": stubbed\n\n" }),
  );
  let current = freezes;
  await page.route("**/api/live/freezes", async (route) => {
    if (route.request().method() === "POST") {
      current = onClear ? onClear() : [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, cleared: ["OPERATOR"], frozen: current.length > 0, freezes: current }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ frozen: current.length > 0, freezes: current }),
    });
  });
}

test("lists active freezes and keeps clearing disabled until every condition is met", async ({ page }) => {
  await stubLive(page, [BLOCKED_FREEZE]);
  await page.goto(`${ORIGIN}/`);

  const banner = page.getByTestId("freeze-banner");
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(banner).toContainText("RECON_DRIFT");
  await expect(banner).toContainText("needs a clean reconciliation after");
  await expect(page.getByTestId("freeze-clear")).toBeDisabled();
  await expect(page.getByTestId("freeze-clear-blocked")).toContainText("needs a clean reconciliation after");
});

test("opens a confirmation naming the reasons, then clears through the API", async ({ page }) => {
  await stubLive(page, [OPERATOR_FREEZE], () => []);
  await page.goto(`${ORIGIN}/`);

  const clear = page.getByTestId("freeze-clear");
  await expect(clear).toBeVisible({ timeout: 20_000 });
  await expect(clear).toBeEnabled();
  await clear.click();

  const dialog = page.getByTestId("freeze-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("freeze-dialog-reasons")).toContainText("OPERATOR");
  await expect(page.getByTestId("freeze-dialog-reasons")).toContainText("manual hold for maintenance");

  await page.getByTestId("freeze-confirm").click();
  await expect(page.getByTestId("freeze-dialog")).toHaveCount(0);
  await expect(page.getByTestId("freeze-banner")).toHaveCount(0);
});
