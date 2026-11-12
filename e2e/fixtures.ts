import { expect, test as base } from "@playwright/test";

/**
 * Shared Playwright fixture with a network guard.
 *
 * Every spec imports `test` from here instead of "@playwright/test". Any
 * request to a real Binance host (live or Demo Trading) is aborted, and any
 * WebSocket to one is closed, so a spec cannot pass on live market data by
 * accident: the chart feed only ever comes from FakeBinanceFeed on localhost.
 *
 * Requests are aborted rather than failed on purpose — the assertion is that
 * the app still renders its own state (Connecting / Disconnected) rather than
 * depending on an exchange reply. The blocked URLs are attached to the test
 * report so a hidden dependency is easy to find.
 */
const BLOCKED_HOST =
  /^(?:[a-z0-9-]+\.)*(?:binance\.com|binancefuture\.com|binance\.us)$/i;

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
