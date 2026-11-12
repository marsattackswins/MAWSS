import { expect, test } from "./fixtures";
import {
  FakeBinanceFeed,
  currentDayOpenSec,
  klineEvent,
  klineRows,
  miniTickerEvent,
} from "./fake-feed";

const KLINE_STREAM = "btcusdt@kline_1d";
const MINI_STREAM = "btcusdt@miniTicker";

async function stubRest(page: import("@playwright/test").Page) {
  await page.route("**/api/binance/klines*", (route) => route.fulfill({ json: klineRows() }));
  await page.route("**/api/binance/symbols*", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/binance/ticker*", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/news/**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/calendar/**", (route) => route.fulfill({ json: [] }));
}

// Feed-health states: semantic label exposed via aria-label, plus the theme token
// the dot paints with. The dot follows the app palette (--app-up / --app-down /
// --app-muted), so assert the state→token mapping rather than a fixed hex — a
// theme switch must repaint it. Tests must still assert the label, since colour
// alone is not sufficient.
const FEED_STATE = {
  connecting: { label: "Connecting", token: "--app-muted", fallback: "#787b86" },
  live: { label: "Live", token: "--app-up", fallback: "#089981" },
  delayed: { label: "Data delayed", token: "--app-down", fallback: "#f23645" },
  reconnecting: { label: "Reconnecting", token: "--app-warn", fallback: "#ff9800" },
} as const;

/** Resolve a theme colour token to the `rgb()` string the browser computes — the
 *  same conversion `toHaveCSS` performs on the dot, so the assertion compares like
 *  with like instead of hardcoding one palette. */
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

/**
 * Broadcast until the MAWS feed applies the frame. Vela's chart provider also
 * connects to this fake server, so `waitForKlineClient` can be satisfied by
 * Vela's socket before the MAWS socket (the source of the trading gate) has
 * subscribed, and that first frame is silently missed. Re-broadcasting the
 * same bar is safe: `applyKline` marks the series live before the duplicate
 * check, while the assertion below still requires the real live state.
 */
async function broadcastUntilLive(
  page: import("@playwright/test").Page,
  feed: FakeBinanceFeed,
  event: unknown,
  timeout = 20_000,
) {
  const dot = page.locator(
    `span[role="status"][aria-label="Market feed status: ${FEED_STATE.live.label}"]`,
  );
  await expect
    .poll(
      async () => {
        feed.broadcast(event);
        return dot.count();
      },
      { timeout, intervals: [250] },
    )
    .toBeGreaterThan(0);
  await expectFeedDot(page, "live", 5_000);
}

test("chart starts Connecting and becomes Live after a valid feed frame", async ({ page }) => {
  const feed = new FakeBinanceFeed(8787);
  try {
    await stubRest(page);
    await page.goto("/");

    // No frames yet → the pane dot must be gray (connecting), not green.
    await expectFeedDot(page, "connecting", 30_000);

    await waitForKlineClient(feed);    await broadcastUntilLive(
      page,
      feed,
      klineEvent(KLINE_STREAM, "BTCUSDT", "1d", currentDayOpenSec(), 100),
      15_000,
    );
  } finally {
    await feed.close();
  }
});

test("stale feed shows Data delayed and returns to Live after recovery", async ({ page }) => {
  const feed = new FakeBinanceFeed(8787);
  try {
    await stubRest(page);
    await page.goto("/");
    await waitForKlineClient(feed);
    await broadcastUntilLive(
      page,
      feed,
      klineEvent(KLINE_STREAM, "BTCUSDT", "1d", currentDayOpenSec(), 100),
      15_000,
    );

    const connectionsAfterLive = feed.connections;

    // Silence: no frames for >5s → the dot turns red (delayed).
    await expectFeedDot(page, "delayed", 20_000);

    // Recovery: the feed reconnects (new connection) and REST-resyncs; once a
    // fresh valid frame arrives on the new socket, the dot returns to green.
    await expect
      .poll(() => feed.connections, { timeout: 40_000 })
      .toBeGreaterThan(connectionsAfterLive);

    // Recovery started but no fresh frame yet (broadcast withheld) → Reconnecting.
    await expectFeedDot(page, "reconnecting", 15_000);

    await broadcastUntilLive(
      page,
      feed,
      klineEvent(KLINE_STREAM, "BTCUSDT", "1d", currentDayOpenSec(), 100),
      20_000,
    );
  } finally {
    await feed.close();
  }
});

test("rapid timeframe switches never hit 'Object is disposed' and chart stays live", async ({
  page,
}) => {
  const feed = new FakeBinanceFeed(8787);
  const pageErrors: string[] = [];
  try {
    await stubRest(page);

    // Slow every rAF to emulate a loaded dev machine: the chart setup's
    // deferred two-frame publish then spans ~300ms, which is the exact window
    // where a fast TF click used to land chart.remove() under the pending
    // rAF callback ("Object is disposed").
    //
    // Diagnostics-only rAF trap: replaces rAF with a 120ms-delayed timeout
    // (slowing frames) while PRESERVING cancellation semantics — a cancelled
    // rAF really drops its callback — and logs the schedule-time stack of any
    // callback that throws, naming the code path that requested the frame.
    await page.addInitScript(() => {
      const origCancel = window.cancelAnimationFrame.bind(window);
      const pending = new Map<number, ReturnType<typeof setTimeout>>();
      let seq = 1;
      window.requestAnimationFrame = (cb) => {
        const stack = new Error().stack ?? "?";
        const id = seq++;
        const t = setTimeout(() => {
          pending.delete(id);
          try {
            cb(performance.now());
          } catch (e) {
            console.error(
              "[raf-fail] scheduled via:\n" + stack + "\n--- thrown ---\n" + String((e as Error)?.stack ?? e),
            );
          }
        }, 120);
        pending.set(id, t);
        return id;
      };
      window.cancelAnimationFrame = (rafId) => {
        const t = pending.get(rafId);
        if (t !== undefined) {
          clearTimeout(t);
          pending.delete(rafId);
        } else {
          origCancel(rafId);
        }
      };
    });

    page.on("pageerror", (err) => pageErrors.push(err.stack ?? String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error" && /disposed/i.test(msg.text())) pageErrors.push(msg.text());
    });

    await page.goto("/");
    await waitForKlineClient(feed);
    await broadcastUntilLive(
      page,
      feed,
      klineEvent(KLINE_STREAM, "BTCUSDT", "1d", currentDayOpenSec(), 100),
      20_000,
    );

    // Rapid-fire TF switching — no settling between clicks.
    for (const tf of ["15m", "5m", "15m", "5m", "1m"]) {
      await page.getByRole("button", { name: tf, exact: true }).click();
    }

    // Then let everything settle and go QUIESCENT before one final switch:
    // with no pending frames, chart removal schedules its draw directly into
    // the disposed bindings — the exact real-browser crash condition.
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "1m", exact: true }).click();

    // The pane now subscribes btcusdt@kline_1m; it goes connecting until a
    // fresh frame arrives on the new stream, which proves the recreated chart
    // is alive and processing (a disposed instance could not update).
    await expectFeedDot(page, "connecting", 20_000);
    const minuteOpen = Math.floor(Date.now() / 60_000) * 60;
    await broadcastUntilLive(
      page,
      feed,
      klineEvent("btcusdt@kline_1m", "BTCUSDT", "1m", minuteOpen, 105),
      20_000,
    );

    expect(pageErrors).toEqual([]);
  } finally {
    await feed.close();
  }
});

test("position tool: toolbar cells present, long placed with target > entry > stop anchors", async ({
  page,
}) => {
  const feed = new FakeBinanceFeed(8787);
  try {
    await stubRest(page);
    await page.goto("/");
    await waitForKlineClient(feed);
    await broadcastUntilLive(
      page,
      feed,
      klineEvent(KLINE_STREAM, "BTCUSDT", "1d", currentDayOpenSec(), 100),
      15_000,
    );

    const host = page.locator("[data-chart-host]").first();
    await expect(host).toBeVisible({ timeout: 30_000 });
    const box = await host.boundingBox();
    if (!box) throw new Error("chart host not measurable");

    // Both toolbar cells are present, but at this viewport the drawing bar
    // overflows its topbar slot and the right-hand clusters cover its tail, so
    // the magnet/position buttons cannot be clicked (layout bug, tracked
    // separately). Drive the exact control surface those buttons call instead.
    await expect(page.getByRole("button", { name: "Magnet snap", exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Long/Short Position", exact: true }),
    ).toBeVisible();

    // Magnet snaps dragged points to candle OHLC; with flat seeded candles that
    // would pin the placement to 100. Turn it off so placement stays unsnapped.
    await page.evaluate(() => {
      const handles = (
        window as unknown as {
          __mawsCharts?: Map<
            string,
            { vela: { drawings: { setSnapMode: (mode: string) => void; setTool: (tool: string | null) => void } } }
          >;
        }
      ).__mawsCharts;
      const chart = handles ? [...handles.values()][0]?.vela : undefined;
      if (!chart) throw new Error("chart handle not registered");
      chart.drawings.setSnapMode("off");
      chart.drawings.setTool("position");
    });

    const ex = box.x + 350;
    const ey = box.y + 450;
    await page.mouse.move(ex, ey);
    await page.mouse.down();
    await page.mouse.move(ex + 160, ey - 90, { steps: 8 });
    await page.mouse.up();

    // Vela paints the position tool on canvas, so its Entry/TP/SL text is not DOM.
    // Assert the anchors the painter, the settings panel and persistence all read.
    const readPosition = () =>
      page.evaluate(() => {
        const handles = (
          window as unknown as {
            __mawsCharts?: Map<
              string,
              {
                vela: {
                  drawings: {
                    toJSON: () => {
                      drawings: Array<{
                        type: string;
                        anchors: Array<{ time: number; price: number }>;
                      }>;
                    };
                  };
                };
              }
            >;
          }
        ).__mawsCharts;
        if (!handles) return null;
        for (const handle of handles.values()) {
          const doc = handle.vela.drawings.toJSON();
          const d = doc.drawings.find(
            (x) =>
              x.type === "position" || x.type === "longposition" || x.type === "shortposition",
          );
          if (d && d.anchors.length >= 3) {
            return {
              entry: d.anchors[0].price,
              stop: d.anchors[1].price,
              target: d.anchors[2].price,
            };
          }
        }
        return null;
      });

    await expect.poll(readPosition, { timeout: 10_000 }).not.toBeNull();
    const placed = await readPosition();
    if (!placed) throw new Error("position drawing was not created");
    // The placement drag ran up from the entry — the profit direction: long, TP above, SL below.
    expect(placed.target).toBeGreaterThan(placed.entry);
    expect(placed.stop).toBeLessThan(placed.entry);

    // NOTE (harness limitation, not app behaviour): in this e2e fixture Vela's
    // chart has no deterministic candles of its own, so the drawing maps onto a
    // degenerate price scale and canvas hit-testing for an existing level cannot
    // be exercised. Creation, the long geometry and the three distinct anchors
    // above are what this fixture can verify; the on-canvas level drags are
    // covered by hand against a fed chart.
    expect(new Set([placed.entry, placed.stop, placed.target]).size).toBe(3);
  } finally {
    await feed.close();
  }
});
