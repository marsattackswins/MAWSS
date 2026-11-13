import { expect, test } from "./fixtures";

/**
 * Local-dev convenience mode (the second e2e web server on :3000).
 *
 * `npm run dev` starts the app with MAWS_LOCAL_DEV=1 on loopback; the chart and
 * public market data then open without a login, while connecting Testnet/Live,
 * orders, and admin stay behind the operator session. This spec never signs in:
 * it proves the anonymous chart works, that the exact Host is required, and
 * that every account/admin surface still answers 401.
 */
const APP = "http://localhost:3000";

test("the chart opens with no login in dev-convenience mode", async ({ page }) => {
  await page.goto(`${APP}/`);

  // No redirect to /login: the chart shell renders anonymously.
  await expect(page).toHaveURL(/localhost:3000\/$/);
  await expect(page.locator('[data-testid="topbar-disconnected"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="topbar-disconnected"]')).toHaveText("Disconnected");
});

test("public data proxies answer without a session in dev-convenience mode", async ({ request }) => {
  // The proxy runs; the server-side network guard blocks the upstream call, so
  // the answer is the upstream failure, never 401.
  const ticker = await request.get(`${APP}/api/binance/ticker?symbol=BTCUSDT`);
  expect(ticker.status()).not.toBe(401);

  const klines = await request.get(`${APP}/api/binance/klines?symbol=BTCUSDT&interval=15m`);
  expect(klines.status()).not.toBe(401);

  const symbols = await request.get(`${APP}/api/binance/symbols`);
  expect(symbols.status()).not.toBe(401);
});

test("a foreign Host gets 401 even in dev-convenience mode", async ({ request }) => {
  const response = await request.get(`${APP}/api/binance/ticker?symbol=BTCUSDT`, {
    headers: { host: "evil.example" },
  });
  expect(response.status()).toBe(401);
});

test("account and admin surfaces return 401 without a session", async ({ request }) => {
  const state = await request.get(`${APP}/api/live/state`);
  expect(state.status()).toBe(200);
  expect(await state.json()).toEqual({ attached: false, loginRequired: true });

  const profile = await request.get(`${APP}/api/live/profile`);
  expect(profile.status()).toBe(401);
  expect((await profile.json()).error.code).toBe("unauthenticated");

  const profileSwitch = await request.post(`${APP}/api/live/profile/switch`, {
    headers: { origin: APP, "content-type": "application/json" },
    data: { profileId: "binance-testnet" },
  });
  expect(profileSwitch.status()).toBe(401);

  const adminConfig = await request.get(`${APP}/api/admin/config`);
  expect(adminConfig.status()).toBe(401);
});
