/**
 * Chart pan/zoom frame-timing harness (local only — never wired into CI).
 *
 * Builds once into a dedicated dist dir, serves the production build with the
 * e2e disposable setup (scratch DB, throwaway operator, no exchange
 * credentials), logs in through the real login route, feeds the chart from the
 * fake Binance fixture, and measures frame deltas with a headed GPU Chromium.
 *
 *   npm run perf:pan -- --name baseline
 *
 * Writes %USERPROFILE%/maws-perf/<name>.json and prints the summary table.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createDisposableContext } from "./disposable-bootstrap.mjs";
import {
  FakeBinanceFeed,
  klineEvent,
  minuteKlineRows,
  miniTickerEvent,
} from "../e2e/fake-feed.ts";

const WS_PORT = 8787;
const RUNS = 5;
const PAN_MS = 5_000;
const BUDGET_MS = 1000 / 120;
const OUT_DIR = path.join(os.homedir(), "maws-perf");
const CANDLES = 5_000;
const SYMBOL = "BTCUSDT";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const raw = process.argv[i];
  if (!raw.startsWith("--")) continue;
  const [key, inline] = raw.slice(2).split("=");
  if (inline !== undefined) {
    args.set(key, inline);
  } else if (process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    args.set(key, process.argv[i + 1]);
    i += 1;
  } else {
    args.set(key, "true");
  }
}
const NAME = args.get("name") ?? "baseline";
const NO_BUILD = args.get("no-build") === "true";

const disposable = createDisposableContext({ source: {}, purpose: "e2e" });
let server = null;
let feed = null;
let browser = null;

function log(...parts) {
  console.log(...parts);
}

function freePort(start) {
  return new Promise((resolve, reject) => {
    const probe = (port) => {
      const srv = net.createServer();
      srv.once("error", () => (port < start + 20 ? probe(port + 1) : reject(new Error("no free port"))));
      srv.once("listening", () => srv.close(() => resolve(port)));
      srv.listen(port, "127.0.0.1");
    };
    probe(start);
  });
}

function serverEnv(port, distDir) {
  const env = { ...process.env, ...disposable.env };
  // Disposable sets the e2e port and dist dir; the harness owns both.
  env.MAWS_ALLOWED_ORIGIN = `http://localhost:${port}`;
  env.MAWS_NEXT_DIST_DIR = distDir;
  env.NEXT_PUBLIC_BINANCE_FAPI_WS = `ws://127.0.0.1:${WS_PORT}`;
  env.NEXT_PUBLIC_BINANCE_FAPI_WS_FALLBACK = `ws://127.0.0.1:${WS_PORT}`;
  env.NODE_OPTIONS = `--require ${path.resolve("e2e/server-network-guard.cjs")}`;
  env.NEXT_TELEMETRY_DISABLED = "1";
  for (const name of Object.keys(env)) {
    if (name.startsWith("MAWS_E2E_")) delete env[name];
  }
  return env;
}

function run(command, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

/** Kill the whole server tree: on Windows the npx wrapper leaves the real
 *  listener alive, and the next run would fail on EADDRINUSE. */
function stopServer() {
  if (!server || server.killed) return;
  const pid = server.pid;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      server.kill("SIGTERM");
    }
  } catch {
    /* already gone */
  }
}

async function waitFor(url, timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not answer at ${url}`);
}

function readCpuName() {
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Processor).Name"]);
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("exit", () => resolve(out.trim().split("\n")[0] ?? "unknown"));
    child.on("error", () => resolve("unknown"));
  });
}

/** Scripted pan: real pointer events for PAN_MS, ~120 moves/second. */
async function pan(page, box, durationMs) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const started = Date.now();
  let step = 0;
  while (Date.now() - started < durationMs) {
    const t = (Date.now() - started) / durationMs;
    // Sweep right then back, so the range stays inside the loaded history.
    const dx = Math.sin(t * Math.PI * 2) * Math.min(box.width / 4, 240);
    await page.mouse.move(cx + dx, cy, { steps: 1 });
    step += 1;
    await new Promise((r) => setTimeout(r, 4));
  }
  await page.mouse.up();
  return step;
}

async function wheelBurst(page, box) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 18; i += 1) {
    await page.mouse.wheel(0, -120);
    await new Promise((r) => setTimeout(r, 55));
  }
}

const SAMPLER = () => {
  const state = { deltas: [], long: 0, last: 0, on: false };
  window.__mawsPerf = state;
  const loop = (t) => {
    if (state.on) {
      if (state.last) state.deltas.push(t - state.last);
      state.last = t;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  try {
    new PerformanceObserver((list) => {
      if (state.on) state.long += list.getEntries().length;
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* longtask unsupported */
  }
};

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarise(deltas, longTasks) {
  const sorted = [...deltas].sort((a, b) => a - b);
  return {
    frames: deltas.length,
    p50: +percentile(sorted, 50).toFixed(2),
    p95: +percentile(sorted, 95).toFixed(2),
    p99: +percentile(sorted, 99).toFixed(2),
    worst: +(sorted[sorted.length - 1] ?? 0).toFixed(2),
    overBudget: deltas.filter((d) => d > BUDGET_MS + 0.4).length,
    over16: deltas.filter((d) => d > 16.7).length,
    longTasks,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return +(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2).toFixed(2);
}

async function cdpMetrics(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const map = {};
  for (const m of metrics) map[m.name] = m.value;
  return map;
}

async function seedLayout(page, count) {
  await page.evaluate((n) => {
    const key = "maws.workspace.v6";
    const raw = window.localStorage.getItem(key);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    parsed.state.layoutCount = n;
    window.localStorage.setItem(key, JSON.stringify(parsed));
    return true;
  }, count);
  await page.reload();
  await page.waitForSelector("[data-chart-host]", { timeout: 90_000 });
  await page.waitForTimeout(1500);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const port = await freePort(3001);
  const distDir = ".next-perf";
  const base = `http://localhost:${port}`;
  const env = serverEnv(port, distDir);

  if (!NO_BUILD) {
    log(`building (distDir ${distDir}) …`);
    await run("npx next build", env);
  }
  log(`starting production server on ${port} …`);
  server = spawn("npx", ["next", "start", "-p", String(port)], {
    shell: true,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitFor(`${base}/api/liveness`);

  feed = new FakeBinanceFeed(WS_PORT);
  let price = 64_230.1;
  const tick = setInterval(() => {
    price += (Math.random() - 0.5) * 6;
    const nowSec = Math.floor(Date.now() / 1000);
    const minute = Math.floor(nowSec / 60) * 60;
    feed.broadcast(klineEvent(`${SYMBOL.toLowerCase()}@kline_1m`, SYMBOL, "1m", minute, price));
    feed.broadcast(miniTickerEvent(`${SYMBOL.toLowerCase()}@miniTicker`, SYMBOL, price, Date.now()));
  }, 100);

  browser = await chromium.launch({
    headless: false,
    args: [
      "--enable-gpu",
      "--ignore-gpu-blocklist",
      "--enable-gpu-rasterization",
      // A headed window that is occluded or unfocused is throttled to 1 rAF/s
      // (or paused entirely), which would fake 1000ms frames. Keep it painting.
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-features=CalculateNativeWinOcclusion",
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const login = await context.request.post(`${base}/api/auth/login`, {
    headers: { origin: base },
    data: { password: disposable.password },
  });
  if (login.status() !== 200) {
    const body = await login.text();
    // Status + a short reason only: never the request body or any env value.
    throw new Error(`login failed: ${login.status()} ${body.slice(0, 120)}`);
  }

  const rows = minuteKlineRows(CANDLES);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.bringToFront();
  await page.route("**/api/binance/klines*", (route) => route.fulfill({ json: rows }));
  await page.route("**/api/binance/symbols*", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/binance/ticker*", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/news/**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/calendar/**", (route) => route.fulfill({ json: [] }));

  await page.goto(base);
  await page.waitForSelector("[data-chart-host]", { timeout: 90_000 });
  await page.waitForTimeout(3000);

  await page.bringToFront();
  const refresh = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const times = [];
        let last = 0;
        const loop = (t) => {
          if (last) times.push(t - last);
          last = t;
          if (times.length < 120) requestAnimationFrame(loop);
          else resolve(times);
        };
        requestAnimationFrame(loop);
      }),
  );
  const sortedRefresh = [...refresh].sort((a, b) => a - b);
  const refreshHz = +(1000 / percentile(sortedRefresh, 50)).toFixed(1);
  const gpu = await page.evaluate(() => {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "unknown";
    } catch {
      return "unknown";
    }
  });

  if (refreshHz < 30) {
    throw new Error(
      `refresh measured ${refreshHz}Hz — the browser window is throttled (occluded/minimised); numbers would be meaningless`,
    );
  }

  const box = await page.locator("[data-chart-host]").first().boundingBox();
  if (!box) throw new Error("chart host has no box");

  const results = {};
  const measure = async (label, action) => {
    const runs = [];
    let attempts = 0;
    while (runs.length < RUNS && attempts < RUNS + 3) {
      attempts += 1;
      await page.evaluate(() => {
        const w = window;
        if (!w.__mawsPerf) {
          w.__mawsPerf = { deltas: [], long: 0, last: 0, on: false };
          const state = w.__mawsPerf;
          const loop = (t) => {
            if (state.on) {
              if (state.last) state.deltas.push(t - state.last);
              state.last = t;
            }
            requestAnimationFrame(loop);
          };
          requestAnimationFrame(loop);
        }
        const s = w.__mawsPerf;
        s.deltas = [];
        s.long = 0;
        s.last = 0;
        s.on = true;
      });
      const before = await cdpMetrics(cdp);
      const moves = await action();
      const afterMetrics = await cdpMetrics(cdp);
      const raw = await page.evaluate(() => {
        const w = window;
        const s = w.__mawsPerf;
        if (!s) return { deltas: [], long: 0 };
        s.on = false;
        return { deltas: s.deltas, long: s.long };
      });
      const summary = summarise(raw.deltas, raw.long);
      const metrics = {
        layouts: Math.round(afterMetrics.LayoutCount - before.LayoutCount),
        styleRecalcs: Math.round(afterMetrics.RecalcStyleCount - before.RecalcStyleCount),
        taskMs: Math.round((afterMetrics.TaskDuration - before.TaskDuration) * 1000),
      };
      // A frame longer than 100ms is the browser throttling an occluded window
      // (exactly ~1000ms), not the app: discard and retry that run.
      if (summary.worst > 100) {
        log(`  (discarded a throttled run: worst ${summary.worst}ms)`);
        await page.waitForTimeout(400);
        continue;
      }
      runs.push({ ...summary, ...metrics, moves });
      await page.waitForTimeout(600);
    }
    const keys = ["p50", "p95", "p99", "worst", "frames", "overBudget", "over16", "longTasks", "moves", "layouts", "styleRecalcs", "taskMs"];
    const medians = {};
    for (const key of keys) medians[key] = median(runs.map((r) => r[key] ?? 0));
    results[label] = { runs, median: medians };
    log(`${label}: p99 ${medians.p99}ms · worst ${medians.worst}ms · over-budget ${medians.overBudget} · layouts ${medians.layouts} · style ${medians.styleRecalcs} · task ${medians.taskMs}ms`);
  };

  await measure("pan-1pane", () => pan(page, box, PAN_MS));
  await measure("wheel-zoom", () => wheelBurst(page, box));

  await seedLayout(page, 4);
  const grid = await page.locator("[data-chart-host]").first().boundingBox();
  if (!grid) throw new Error("4-pane chart host has no box");
  await measure("pan-4pane", () => pan(page, grid, PAN_MS));

  const machine = {
    cpu: await readCpuName(),
    gpu,
    refreshHz,
    refreshMedianMs: +percentile(sortedRefresh, 50).toFixed(2),
    viewport: "1440x900",
    headed: true,
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    budgetMs: +BUDGET_MS.toFixed(2),
    candles: CANDLES,
    ticksPerSecond: 10,
    runsPerScenario: RUNS,
  };

  const payload = { name: NAME, takenAt: new Date().toISOString(), machine, scenarios: results };
  const file = path.join(OUT_DIR, `${NAME}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));

  log("");
  log("machine:", JSON.stringify(machine));
  log("");
  const header = ["scenario", "p50", "p95", "p99", "worst", "over 8.3", "over 16.7", "longtasks", "layouts", "style", "task ms"];
  log(header.join("\t"));
  for (const [label, data] of Object.entries(results)) {
    const m = data.median;
    log([label, m.p50, m.p95, m.p99, m.worst, m.overBudget, m.over16, m.longTasks, m.layouts, m.styleRecalcs, m.taskMs].join("	"));
  }
  log("");
  log(`saved ${file}`);

  clearInterval(tick);
  await browser.close();
  await feed.close();
  stopServer();
  try {
    disposable.cleanup();
  } catch {
    /* SQLite file still locked by the server we just killed */
  }
}

main().catch(async (error) => {
  console.error(error);
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  try {
    await feed?.close();
  } catch {
    /* ignore */
  }
  stopServer();
  disposable.cleanup();
  process.exit(1);
});
