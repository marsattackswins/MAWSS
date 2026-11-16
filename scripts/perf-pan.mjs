/**
 * Chart pan/zoom frame-timing harness (local only — never wired into CI).
 *
 * Serves the app with the e2e disposable setup (scratch DB, throwaway operator,
 * no exchange credentials), logs in through the real login route, feeds the
 * chart from the fake Binance fixture, and measures frame deltas, canvas paints
 * and pointer-to-draw latency in a headed GPU browser.
 *
 *   npm run perf:pan -- --name baseline
 *   npm run perf:pan -- --name dev-chrome --dev --channel chrome
 *
 * Modes: production build (default) or `--dev` (next dev, own dist dir).
 * Browsers: bundled Chromium (default) or `--channel chrome|msedge`.
 * Writes %USERPROFILE%/maws-perf/<name>.json and prints the summary table.
 */
import { execFileSync, spawn } from "node:child_process";
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
let RUNS = 5; // --runs N overrides (smoke runs only)
const PAN_MS = 5_000;
const BUDGET_MS = 1000 / 120;
const OUT_DIR = path.join(os.homedir(), "maws-perf");
const CANDLES = 5_000;
const HEAVY_CANDLES = 20_000;
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
const DEV = args.get("dev") === "true";
const CHANNEL = args.get("channel") ?? null;
const NAME = args.get("name") ?? `${DEV ? "dev" : "prod"}-${CHANNEL ?? "bundled"}`;
const NO_BUILD = args.get("no-build") === "true";
if (args.get("runs")) RUNS = Math.max(1, Number(args.get("runs")) || 1);

const disposable = createDisposableContext({ source: {}, purpose: "e2e" });
let server = null;
let feed = null;
let browser = null;
let tickTimer = null;

function log(...parts) {
  console.log(...parts);
}

/** Where an installed browser lives on Windows (Playwright channels reuse it). */
function channelExecutable(channel) {
  if (process.platform !== "win32") return null;
  const candidates =
    channel === "chrome"
      ? [
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
          "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
          path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
        ]
      : channel === "msedge"
        ? [
            "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
            "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
            path.join(process.env.LOCALAPPDATA ?? "", "Microsoft/Edge/Application/msedge.exe"),
          ]
        : [];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

/** Read-only peek at the Windows per-app GPU preference. Never writes. */
function gpuPreferenceFor(executable) {
  if (process.platform !== "win32" || !executable) return "n/a";
  const base = path.basename(executable).toLowerCase();
  const out = spawnSyncLines([
    "powershell",
    ["-NoProfile", "-Command", 'reg query "HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences"'],
  ]);
  const line = out.find((l) => l.toLowerCase().includes(base));
  return line ? line.replace(/\s+/g, " ").trim() : "not set (system default)";
}

function spawnSyncLines([cmd, argv]) {
  try {
    const stdout = execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
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

/**
 * Canvas paint evidence. rAF deltas only prove the main thread was free; this
 * records the frames in which a 2D context actually drew, and the time from
 * each pointermove to the first drawing frame after it.
 */
const PAINT_SCRIPT = () => {
  const proto = CanvasRenderingContext2D.prototype;
  const state = {
    on: false,
    paints: 0,
    paintedFrames: 0,
    frames: 0,
    dirty: false,
    pending: [],
    latencies: [],
    moves: 0,
  };
  window.__mawsPaint = state;
  const mark = () => {
    if (!state.on) return;
    state.paints += 1;
    state.dirty = true;
    if (state.pending.length > 0) {
      const now = performance.now();
      for (const at of state.pending) state.latencies.push(now - at);
      state.pending.length = 0;
    }
  };
  const names = [
    "drawImage",
    "fillRect",
    "strokeRect",
    "fill",
    "stroke",
    "clearRect",
    "fillText",
    "strokeText",
    "putImageData",
  ];
  for (const name of names) {
    const original = proto[name];
    if (typeof original !== "function") continue;
    proto[name] = function instrumented(...rest) {
      mark();
      return original.apply(this, rest);
    };
  }
  window.addEventListener(
    "pointermove",
    () => {
      if (!state.on) return;
      state.moves += 1;
      state.pending.push(performance.now());
      if (state.pending.length > 400) state.pending.shift();
    },
    true,
  );
  const loop = () => {
    if (state.on) {
      state.frames += 1;
      if (state.dirty) {
        state.paintedFrames += 1;
        state.dirty = false;
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.__mawsPaintReset = () => {
    state.paints = 0;
    state.paintedFrames = 0;
    state.frames = 0;
    state.dirty = false;
    state.pending.length = 0;
    state.latencies.length = 0;
    state.moves = 0;
    state.on = true;
  };
  window.__mawsPaintStop = () => {
    state.on = false;
    return {
      paints: state.paints,
      paintedFrames: state.paintedFrames,
      frames: state.frames,
      latencies: state.latencies.slice(),
      moves: state.moves,
    };
  };
};

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

/** The app's own persisted layout: 4 panes, VPVR on, three more indicators. */
async function seedHeavyLayout(page) {
  const applied = await page.evaluate(() => {
    const key = "maws.workspace.v6";
    const raw = window.localStorage.getItem(key);
    if (!raw) return { panes: 0, indicators: 0 };
    const parsed = JSON.parse(raw);
    const state = parsed.state ?? parsed;
    state.layoutCount = 4;
    const natives = ["volume", { type: "vpvr" }, { type: "ema", inputs: { length: 21 } }, { type: "sma", inputs: { length: 50 } }, { type: "rsi" }];
    state.panes = (state.panes ?? []).slice(0, 4).map((pane) => ({
      ...pane,
      velaState: { ...(pane.velaState ?? {}), indicators: { natives, manifest: [] } },
    }));
    window.localStorage.setItem(key, JSON.stringify(parsed));
    return { panes: state.panes.length, indicators: natives.length };
  });
  await page.reload();
  await page.waitForSelector("[data-chart-host]", { timeout: 180_000 });
  await page.waitForTimeout(2500);
  // Read back through the app's own cell-state bridge: proof the layout stuck.
  const confirmed = await page.evaluate(() => {
    const raw = window.localStorage.getItem("maws.workspace.v6");
    if (!raw) return { panes: 0, indicators: 0, vpvr: 0 };
    const parsed = JSON.parse(raw);
    const state = parsed.state ?? parsed;
    const panes = state.panes ?? [];
    const first = panes[0]?.velaState?.indicators?.natives ?? [];
    return {
      panes: panes.length,
      indicators: first.length,
      vpvr: first.some((n) => (typeof n === "string" ? n : n?.type) === "vpvr") ? 1 : 0,
    };
  });
  return { applied, confirmed };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const executable = CHANNEL ? channelExecutable(CHANNEL) : null;
  if (CHANNEL && !executable) {
    log(`channel "${CHANNEL}" is not installed on this machine — skipped (no JSON written)`);
    return;
  }

  const port = await freePort(3001);
  const distDir = DEV ? ".next-perf-dev" : ".next-perf";
  const base = `http://localhost:${port}`;
  const env = serverEnv(port, distDir);

  if (DEV) {
    log(`starting dev server on ${port} (distDir ${distDir}) …`);
    server = spawn("npx", ["next", "dev", "-p", String(port)], {
      shell: true,
      env,
      stdio: ["ignore", "ignore", "inherit"],
    });
  } else {
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
  }
  await waitFor(`${base}/api/liveness`, DEV ? 300_000 : 120_000);

  feed = new FakeBinanceFeed(WS_PORT);
  let price = 64_230.1;
  const setTickRate = (perSecond) => {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      price += (Math.random() - 0.5) * 6;
      const nowSec = Math.floor(Date.now() / 1000);
      const minute = Math.floor(nowSec / 60) * 60;
      feed.broadcast(klineEvent(`${SYMBOL.toLowerCase()}@kline_1m`, SYMBOL, "1m", minute, price));
      feed.broadcast(miniTickerEvent(`${SYMBOL.toLowerCase()}@miniTicker`, SYMBOL, price, Date.now()));
    }, Math.round(1000 / perSecond));
  };
  setTickRate(10);

  const launchOptions = {
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
  };
  if (CHANNEL) launchOptions.channel = CHANNEL;
  browser = await chromium.launch(launchOptions);
  const browserVersion = browser.version();
  const browserSession = await browser.newBrowserCDPSession();
  let sysInfo = null;
  try {
    sysInfo = await browserSession.send("SystemInfo.getInfo");
  } catch {
    /* older builds */
  }
  await browserSession.detach().catch(() => {});
  const gpuDevice = sysInfo?.gpu?.devices?.[0] ?? null;
  const features = sysInfo?.gpu?.featureStatus ?? {};
  const canvasAccelerated = features.canvas ?? features["gpu_compositing"] ?? "unknown";
  const executablePath = CHANNEL ? executable : chromium.executablePath();

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(PAINT_SCRIPT);
  await context.addInitScript(SAMPLER);
  const login = await context.request.post(`${base}/api/auth/login`, {
    headers: { origin: base },
    data: { password: disposable.password },
  });
  if (login.status() !== 200) {
    const body = await login.text();
    // Status + a short reason only: never the request body or any env value.
    throw new Error(`login failed: ${login.status()} ${body.slice(0, 120)}`);
  }

  let klineRows = minuteKlineRows(CANDLES);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.bringToFront();
  await page.route("**/api/binance/klines*", (route) => route.fulfill({ json: klineRows }));
  await page.route("**/api/binance/symbols*", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/binance/ticker*", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/news/**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/calendar/**", (route) => route.fulfill({ json: [] }));

  await page.goto(base);
  await page.waitForSelector("[data-chart-host]", { timeout: DEV ? 240_000 : 90_000 });
  await page.waitForTimeout(DEV ? 4000 : 3000);

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
  const adapter = await page.evaluate(() => {
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
        const s = window.__mawsPerf;
        s.deltas = [];
        s.long = 0;
        s.last = 0;
        s.on = true;
        window.__mawsPaintReset();
      });
      const before = await cdpMetrics(cdp);
      const startedAt = Date.now();
      const moves = await action();
      const elapsedMs = Date.now() - startedAt;
      const afterMetrics = await cdpMetrics(cdp);
      const raw = await page.evaluate(() => {
        const s = window.__mawsPerf;
        s.on = false;
        return { deltas: s.deltas, long: s.long, paint: window.__mawsPaintStop() };
      });
      const summary = summarise(raw.deltas, raw.long);
      const paintLatencies = [...raw.paint.latencies].sort((a, b) => a - b);
      const paintFps = +(raw.paint.paintedFrames / (elapsedMs / 1000)).toFixed(1);
      const metrics = {
        layouts: Math.round(afterMetrics.LayoutCount - before.LayoutCount),
        styleRecalcs: Math.round(afterMetrics.RecalcStyleCount - before.RecalcStyleCount),
        taskMs: Math.round((afterMetrics.TaskDuration - before.TaskDuration) * 1000),
        paintFps,
        paintFrames: raw.paint.paintedFrames,
        paintCalls: raw.paint.paints,
        pointerMoves: raw.paint.moves,
        toDrawP50: +percentile(paintLatencies, 50).toFixed(2),
        toDrawP95: +percentile(paintLatencies, 95).toFixed(2),
        toDrawP99: +percentile(paintLatencies, 99).toFixed(2),
        toDrawSamples: paintLatencies.length,
      };
      // A frame longer than 100ms is the browser throttling an occluded window
      // (exactly ~1000ms), not the app: discard and retry that run.
      if (summary.worst > 100) {
        log(`  (discarded a throttled run: worst ${summary.worst}ms)`);
        await page.waitForTimeout(400);
        continue;
      }
      runs.push({ ...summary, ...metrics, moves, elapsedMs });
      await page.waitForTimeout(600);
    }
    const keys = [
      "p50",
      "p95",
      "p99",
      "worst",
      "frames",
      "overBudget",
      "over16",
      "longTasks",
      "moves",
      "layouts",
      "styleRecalcs",
      "taskMs",
      "paintFps",
      "paintFrames",
      "paintCalls",
      "pointerMoves",
      "toDrawP50",
      "toDrawP95",
      "toDrawP99",
      "toDrawSamples",
    ];
    const medians = {};
    for (const key of keys) medians[key] = median(runs.map((r) => r[key] ?? 0));
    results[label] = { runs, median: medians };
    log(
      `${label}: raf p99 ${medians.p99}ms · worst ${medians.worst}ms · paint ${medians.paintFps}fps · ` +
        `pointer→draw p50 ${medians.toDrawP50}ms p99 ${medians.toDrawP99}ms · longtasks ${medians.longTasks} · ` +
        `layouts ${medians.layouts} · task ${medians.taskMs}ms`,
    );
  };

  setTickRate(10);
  await measure("pan-1pane", () => pan(page, box, PAN_MS));
  await measure("wheel-zoom", () => wheelBurst(page, box));

  // Heavier: 4 panes, VPVR + 3 indicators, 5,000 candles.
  const heavy = await seedHeavyLayout(page);
  log(
    `heavy layout: panes ${heavy.confirmed.panes}, indicators ${heavy.confirmed.indicators}${heavy.confirmed.vpvr ? " (vpvr on)" : " (vpvr MISSING)"}`,
  );
  const grid = await page.locator("[data-chart-host]").first().boundingBox();
  if (!grid) throw new Error("4-pane chart host has no box");
  await measure("pan-4pane-5k", () => pan(page, grid, PAN_MS));

  // Same layout, 50 ticks/second.
  setTickRate(50);
  await measure("pan-4pane-burst-50tps", () => pan(page, grid, PAN_MS));
  setTickRate(10);

  // Same layout on 20,000 candles.
  klineRows = minuteKlineRows(HEAVY_CANDLES);
  await page.reload();
  await page.waitForSelector("[data-chart-host]", { timeout: DEV ? 240_000 : 90_000 });
  await page.waitForTimeout(DEV ? 4000 : 2500);
  const grid20k = await page.locator("[data-chart-host]").first().boundingBox();
  if (!grid20k) throw new Error("4-pane 20k chart host has no box");
  await measure("pan-4pane-20k", () => pan(page, grid20k, PAN_MS));

  const machine = {
    mode: DEV ? "dev" : "prod",
    channel: CHANNEL ?? "bundled-chromium",
    browserVersion,
    executablePath,
    canvasAccelerated,
    gpuFeatureStatus: features,
    gpuDevice: gpuDevice
      ? {
          vendorId: gpuDevice.vendorId,
          deviceId: gpuDevice.deviceId,
          vendorString: gpuDevice.vendorString,
          deviceString: gpuDevice.deviceString,
          driverVendor: gpuDevice.driverVendor,
        }
      : null,
    webglAdapter: adapter,
    windowsGpuPreference: gpuPreferenceFor(executablePath),
    cpu: await readCpuName(),
    refreshHz,
    refreshMedianMs: +percentile(sortedRefresh, 50).toFixed(2),
    viewport: "1440x900",
    headed: true,
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    budgetMs: +BUDGET_MS.toFixed(2),
    candles: CANDLES,
    heavyCandles: HEAVY_CANDLES,
    ticksPerSecond: [10, 50],
    runsPerScenario: RUNS,
    heavyLayout: heavy.confirmed,
  };

  const payload = { name: NAME, takenAt: new Date().toISOString(), machine, scenarios: results };
  const file = path.join(OUT_DIR, `${NAME}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));

  log("");
  log(
    `machine: ${machine.mode}/${machine.channel} · browser ${browserVersion} · ${refreshHz}Hz · canvas ${canvasAccelerated} · ${adapter}`,
  );
  log(`  gpu pref: ${machine.windowsGpuPreference}`);
  log("");
  const header = [
    "scenario",
    "raf p99",
    "worst",
    "paint fps",
    "→draw p50",
    "→draw p99",
    "longtasks",
    "over 8.3",
    "layouts",
    "task ms",
  ];
  log(header.join("\t"));
  for (const [label, data] of Object.entries(results)) {
    const m = data.median;
    log(
      [
        label,
        m.p99,
        m.worst,
        m.paintFps,
        m.toDrawP50,
        m.toDrawP99,
        m.longTasks,
        m.overBudget,
        m.layouts,
        m.taskMs,
      ].join("\t"),
    );
  }
  log("");
  log(`saved ${file}`);

  if (tickTimer) clearInterval(tickTimer);
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
  if (tickTimer) clearInterval(tickTimer);
  stopServer();
  disposable.cleanup();
  process.exit(1);
});
