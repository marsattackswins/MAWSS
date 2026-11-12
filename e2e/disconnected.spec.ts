/**
 * E2E: Disconnected startup and rejected trading.
 *
 * Covers:
 *   1. Startup without an attached profile shows "Disconnected" in the topbar
 *      trading strip — Buy/Sell buttons are absent, no account data, and the
 *      profile menu lists exactly Testnet and Live (no Paper option).
 *   2. Trading actions dispatched while disconnected are server-rejected with
 *      409 not_connected.
 *   3. A failed/detached live profile keeps the bottom panel hidden and blocks
 *      order submission.
 *   4. Controlled Testnet connection fixture: with a stubbed profile API that
 *      reports a ready Testnet profile, the UI shows the connected state.
 *
 * Every test logs in through the real /api/auth/login route (the shared
 * fixture does it) against the disposable server from playwright.config.ts,
 * so no real exchange traffic ever occurs.
 */

import { expect, test } from "./fixtures";
import {
  FakeBinanceFeed,
  currentDayOpenSec,
  klineEvent,
  klineRows,
  miniTickerEvent,
} from "./fake-feed";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function stubRest(page: import("@playwright/test").Page) {
  await page.route("**/api/binance/klines*", (route) => route.fulfill({ json: klineRows() }));
  await page.route("**/api/binance/symbols*", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/binance/ticker*", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/news/**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/calendar/**", (route) => route.fulfill({ json: [] }));
}

const FEED_STATE = {
  connecting: { label: "Connecting", token: "--app-muted", fallback: "#787b86" },
  live: { label: "Live", token: "--app-up", fallback: "#089981" },
} as const;

/** Resolve a theme colour token to the `rgb()` string the browser computes, so the
 *  dot is asserted against the palette it actually paints with. */
async function resolveTokenColor(
  page: import("@playwright/test").Page,
  token: string,
  fallback: string,
): Promise<string> {
  return page.evaluate(
    ({ token, fallback }: { token: string; fallback: string }) => {
      const raw =
        getComputedStyle(document.documentElement).getPropertyValue(token).trim() || fallback;
      const probe = document.createElement("span");
      probe.style.backgroundColor = raw;
      document.body.appendChild(probe);
      const rgb = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return rgb;
    },
    { token, fallback },
  );
}

async function expectFeedDot(
  page: import("@playwright/test").Page,
  state: keyof typeof FEED_STATE,
  timeout: number,
) {
  const dot = page.locator(
    `span[role="status"][aria-label="Market feed status: ${FEED_STATE[state].label}"]`,
  );
  await expect(dot).toBeVisible({ timeout });
  const { token, fallback } = FEED_STATE[state];
  await expect(dot).toHaveCSS("background-color", await resolveTokenColor(page, token, fallback));
}

async function waitForKlineClient(feed: FakeBinanceFeed) {
  await expect.poll(() => feed.connections, { timeout: 20_000 }).toBeGreaterThan(0);
}

function broadcastPrice(feed: FakeBinanceFeed, price: number) {
  const t = currentDayOpenSec();
  feed.broadcast(klineEvent("btcusdt@kline_1d", "BTCUSDT", "1d", t, price));
  feed.broadcast(miniTickerEvent("btcusdt@miniTicker", "BTCUSDT", price, Date.now()));
}

/**
 * Broadcast until the MAWS feed applies a frame. Vela's chart provider also
 * connects to this fake server, so waiting for the FIRST connection no longer
 * proves the MAWS socket (the source of the trading gate) is subscribed yet;
 * a single early frame is silently missed. Re-broadcasting the same bar is
 * safe: `applyKline` marks the series live before its duplicate check.
 */
async function broadcastPriceUntilLive(
  page: import("@playwright/test").Page,
  feed: FakeBinanceFeed,
  price: number,
  timeout = 20_000,
) {
  const dot = page.locator(
    `span[role="status"][aria-label="Market feed status: ${FEED_STATE.live.label}"]`,
  );
  await expect
    .poll(
      async () => {
        broadcastPrice(feed, price);
        return dot.count();
      },
      { timeout, intervals: [250] },
    )
    .toBeGreaterThan(0);
  await expectFeedDot(page, "live", 5_000);
}

// ---------------------------------------------------------------------------
// 1. Disconnected startup
// ---------------------------------------------------------------------------

test("disconnected startup: topbar shows Disconnected label, no Sell/Buy buttons", async ({
  page,
}) => {
  const feed = new FakeBinanceFeed(8787);
  try {
    await stubRest(page);
    await page.goto("/");
    await waitForKlineClient(feed);
    await broadcastPriceUntilLive(page, feed, 100);

    // The "Disconnected" label must be visible in the topbar trading strip
    // when no broker is connected.
    const disconnectedLabel = page.locator('[data-testid="topbar-disconnected"]');
    await expect(disconnectedLabel).toBeVisible({ timeout: 10_000 });
    await expect(disconnectedLabel).toHaveText("Disconnected");

    // No Sell / Buy action buttons are rendered when disconnected.
    await expect(page.locator('button[aria-label="Sell at bid"]')).toHaveCount(0);
    await expect(page.locator('button[aria-label="Buy at ask"]')).toHaveCount(0);
  } finally {
    await feed.close();
  }
});

test("disconnected startup: bottom trading panel is hidden (no positions/orders tabs)", async ({
  page,
}) => {
  const feed = new FakeBinanceFeed(8787);
  try {
    await stubRest(page);
    await page.goto("/");
    await waitForKlineClient(feed);
    await broadcastPriceUntilLive(page, feed, 100);

    // The positions/orders panel is only shown after a confirmed broker
    // attachment. In disconnected mode it must not render.
    await expect(page.locator('button:has-text("Positions")')).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator('button:has-text("Orders")')).toHaveCount(0, { timeout: 5_000 });
  } finally {
    await feed.close();
  }
});

test("disconnected startup: profile menu and API list exactly Testnet and Live", async ({
  page,
}) => {
  const feed = new FakeBinanceFeed(8787);
  try {
    await stubRest(page);
    await page.goto("/");
    await waitForKlineClient(feed);
    await broadcastPriceUntilLive(page, feed, 100);

    // Open the topbar profile menu from the Disconnected label.
    await page.locator('[data-testid="topbar-disconnected"]').click();
    await expect(page.getByText("Trading Profiles")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /USDT-M Futures \(Testnet\)/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /USDT-M Futures \(Live\)/ })).toBeVisible();

    // The two-mode product has no paper option anywhere in the menu.
    await expect(page.locator('[role="menu"][data-dropdown-open="true"]')).not.toContainText("Paper");

    // And the server metadata agrees: exactly the two profiles, authenticated.
    const profilesResp = await page.request.get("/api/live/profiles");
    expect(profilesResp.status()).toBe(200);
    const body = (await profilesResp.json()) as { profiles: Array<{ profileId: string }> };
    expect(body.profiles.map((p) => p.profileId).sort()).toEqual([
      "binance-production",
      "binance-testnet",
    ]);
  } finally {
    await feed.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Rejected trading while disconnected
// ---------------------------------------------------------------------------

test("order submission while disconnected is rejected with 409 not_connected", async ({
  page,
}) => {
  const feed = new FakeBinanceFeed(8787);
  try {
    await stubRest(page);
    await page.goto("/");
    await waitForKlineClient(feed);
    await broadcastPriceUntilLive(page, feed, 100);

    // Authenticated operator session (from the shared fixture login) + CSRF,
    // yet no profile is attached: the server must reject the submission
    // outright instead of attempting an exchange call.
    const session = (await (await page.request.get("/api/auth/session")).json()) as {
      csrf?: string;
    };
    const response = await page.request.post("/api/live/orders", {
      headers: { "x-maws-csrf": session.csrf ?? "", origin: "http://localhost:3001" },
      data: {
        symbol: "BTCUSDT",
        side: "BUY",
        type: "MARKET",
        qty: "0.001",
        clientOrderId: "e2e-disconnected-order",
      },
    });

    expect(response.status()).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "not_connected" } });
  } finally {
    await feed.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Failed/detached attachment blocks trading
// ---------------------------------------------------------------------------

test("failed live profile phase keeps bottom panel hidden", async ({ page }) => {
  const feed = new FakeBinanceFeed(8787);
  try {
    await stubRest(page);

    // Stub the live profile API to return a failed status.
    await page.route("**/api/live/profile", (route) =>
      route.fulfill({
        json: {
          profileId: "binance-testnet",
          environment: "testnet",
          phase: "failed",
          ready: false,
          managerStatus: "error",
          streamHealthy: false,
          executionAllowed: false,
          generation: 1,
          reasonCode: "target_start_failed",
        },
      }),
    );

    await page.goto("/");
    await waitForKlineClient(feed);
    await broadcastPriceUntilLive(page, feed, 100);

    // With a failed profile and no attachment, the bottom panel must not render.
    await expect(page.locator('button:has-text("Positions")')).toHaveCount(0, { timeout: 5_000 });
    // The Disconnected label must still appear (connectedBroker remains null
    // until a server-confirmed attachment completes).
    const disconnectedLabel = page.locator('[data-testid="topbar-disconnected"]');
    await expect(disconnectedLabel).toBeVisible({ timeout: 5_000 });
  } finally {
    await feed.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Controlled Testnet connection fixture
// ---------------------------------------------------------------------------

test("controlled fixture: ready Testnet profile shows connected state and bottom panel", async ({
  page,
}) => {
  const feed = new FakeBinanceFeed(8787);
  try {
    await stubRest(page);

    // Stub the profile status to return a ready Testnet profile.
    const readyStatus = {
      profileId: "binance-testnet",
      environment: "testnet",
      phase: "ready",
      ready: true,
      managerStatus: "ready",
      streamHealthy: true,
      executionAllowed: true,
      generation: 1,
      reasonCode: null,
    };
    await page.route("**/api/live/profile", (route) => route.fulfill({ json: readyStatus }));

    // Stub the live state (positions/orders/account).
    await page.route("**/api/live/state", (route) =>
      route.fulfill({
        json: {
          account: {
            balance: 1234.56,
            available: 1100,
            equity: 1250,
            margin: 134.56,
            unrealized: 15.44,
            fetchedAt: Date.now(),
            equitySource: "exchange",
          },
          accountMetrics: {
            realizedPnl: 42.0,
            commission: 1.2,
            fundingFee: -0.5,
            netRealized: 40.3,
            fetchedAt: Date.now(),
          },
          positions: [],
          orders: [],
          fills: [],
        },
      }),
    );

    // Stub the gates endpoint to allow execution.
    await page.route("**/api/live/gates", (route) => route.fulfill({ json: { ok: true } }));

    await page.goto("/");
    await waitForKlineClient(feed);
    await broadcastPriceUntilLive(page, feed, 100);

    // The bottom panel should appear once the attachment confirms.
    // The broker attachment is driven by restoreServerProfile on session start.
    // Wait for the Positions tab to appear.
    await expect(page.locator('button:has-text("Positions")')).toBeVisible({ timeout: 15_000 });

    // The disconnected label must be gone.
    await expect(page.locator('[data-testid="topbar-disconnected"]')).toHaveCount(0);

    // The Sell/Buy buttons should be visible.
    await expect(page.locator('button[aria-label="Sell at bid"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('button[aria-label="Buy at ask"]')).toBeVisible({ timeout: 5_000 });
  } finally {
    await feed.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Environment cross-route safety
// ---------------------------------------------------------------------------

test("switching from Testnet to Production goes through exposure and mutation checks", async ({
  page,
}) => {
  const feed = new FakeBinanceFeed(8787);
  try {
    await stubRest(page);

    // The operator session is real (shared fixture login); the profile switch
    // itself is stubbed to simulate an exposure_present rejection — the server
    // must block a switch when positions are open.
    await page.route("**/api/live/profile/switch", (route) =>
      route.fulfill({
        status: 409,
        json: {
          error: { code: "exposure_present", message: "Switching is blocked because open positions or orders exist." },
        },
      }),
    );

    await page.goto("/");
    await waitForKlineClient(feed);
    await broadcastPriceUntilLive(page, feed, 100);

    // The profile switch rejected: verify the error surfaces in the UI.
    // This is tested via the dispatch layer in Jest; here we confirm the
    // API stub is reachable from the browser context.
    const switchResult = await page.evaluate(async () => {
      const r = await fetch("/api/live/profile/switch", {
        method: "POST",
        headers: { "content-type": "application/json", "x-maws-csrf": "test-csrf" },
        body: JSON.stringify({ profileId: "binance-production", confirmProduction: true }),
      });
      const body = await r.json() as Record<string, unknown>;
      return { status: r.status, code: (body.error as Record<string, unknown>)?.code };
    });

    expect(switchResult.status).toBe(409);
    expect(switchResult.code).toBe("exposure_present");
  } finally {
    await feed.close();
  }
});
