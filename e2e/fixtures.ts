import { expect, test as base, type BrowserContext } from "@playwright/test";

/**
 * Shared Playwright fixture with a network guard and operator login.
 *
 * Every spec imports `test` from here instead of "@playwright/test". Any
 * request to a real Binance host (live or Demo Trading) is aborted, and any
 * WebSocket to one is closed, so a spec cannot pass on live market data by
 * accident: the chart feed only ever comes from FakeBinanceFeed on localhost.
 * Each test is also logged in through the real /api/auth/login route with the
 * disposable run's operator password, because the whole app sits behind the
 * operator session.
 *
 * Requests are aborted rather than failed on purpose — the assertion is that
 * the app still renders its own state (Connecting / Disconnected) rather than
 * depending on an exchange reply. The blocked URLs are attached to the test
 * report so a hidden dependency is easy to find.
 */
const BLOCKED_HOST =
  /^(?:[a-z0-9-]+\.)*(?:binance\.com|binancefuture\.com|binance\.us)$/i;

/** Every page is behind the operator session: without a login the proxy
 *  redirects to /login before any spec assertion can run. The password is the
 *  one minted for this run by playwright.config.ts; it never appears on disk. */
// One session per worker: the login route rate-limits real attempts (5 per
// 15 minutes), and repeat-each runs would otherwise exhaust it before the suite
// finishes. The cookie stays in memory for this run only.
let cachedCookies: Awaited<ReturnType<BrowserContext["cookies"]>> | null = null;

async function loginOperator(page: import("@playwright/test").Page): Promise<void> {
  if (cachedCookies) {
    await page.context().addCookies(cachedCookies);
    return;
  }
  const password = process.env.MAWS_E2E_OPERATOR_PASSWORD;
  if (!password) {
    throw new Error("MAWS_E2E_OPERATOR_PASSWORD is missing — e2e must run through playwright.config.ts");
  }
  // APIRequestContext is not a browser fetch: it sends no Origin header, and
  // the login route requires one for every mutation. Pin the same origin the
  // disposable server was configured with.
  const login = await page.request.post("/api/auth/login", {
    headers: { origin: "http://localhost:3001" },
    data: { password },
  });
  if (login.status() !== 200) {
    throw new Error(`Operator login failed (${login.status()}) — the disposable server rejected the generated password`);
  }
  cachedCookies = await page.context().cookies();
}

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const blocked: string[] = [];

    await page.route("**/*", (route) => {
      let host = "";
      try {
        host = new URL(route.request().url()).hostname;
      } catch {
        return route.fallback();
      }
      if (BLOCKED_HOST.test(host)) {
        blocked.push(route.request().url());
        console.warn(`[network-guard] aborted real Binance request: ${route.request().url()}`);
        return route.abort("blockedbyclient");
      }
      return route.fallback();
    });

    // WebSocket interception is separate from HTTP routing: without it, a
    // provider that opened wss://fstream.binance.com would reach the network.
    await page.routeWebSocket(/binance/i, (ws) => {
      blocked.push(ws.url());
      console.warn(`[network-guard] closed real Binance WebSocket: ${ws.url()}`);
      ws.close();
    });

    // page.request shares the browser context cookie jar, so the session set
    // here covers page.goto and in-page fetches alike.
    await loginOperator(page);

    await use(page);

    if (blocked.length > 0) {
      await testInfo.attach("blocked-binance-requests", {
        body: blocked.join("\n"),
        contentType: "text/plain",
      });
    }
  },
});

export { expect };
