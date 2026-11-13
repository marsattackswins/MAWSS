import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { createDisposableContext } from "./scripts/disposable-bootstrap.mjs";

const FAKE_WS_PORT = 8787;

// Isolated launch: scratch DB/state under the OS temp dir, a fresh operator
// verifier, every Binance credential name blanked, origin pinned to the e2e
// port. The generated password stays in this process only (picked up by
// login-first specs via MAWS_E2E_OPERATOR_PASSWORD); it is never printed and
// never written to disk.
const disposable = createDisposableContext({ source: {}, purpose: "e2e" });
// Separate scratch database for the local-dev convenience server on 3000, so
// the two servers never share SQLite files or state.
const localDevContext = createDisposableContext({ source: {}, purpose: "e2e" });
const localDevEnv = localDevContext.env as Record<string, string>;
// Playwright reloads this config in every worker process. Keep the password
// minted by the main process, which started the server with matching verifier.
process.env.MAWS_E2E_OPERATOR_PASSWORD ??= disposable.password;
// The worker caches its operator session here so a worker restart does not
// spend another login against the route's 5-per-15-minutes limiter. The path
// is unique per run and inherited by every worker.
if (!process.env.MAWS_E2E_SESSION_FILE) {
  process.env.MAWS_E2E_SESSION_FILE = path.join(os.tmpdir(), `maws-e2e-session-${crypto.randomUUID()}.json`);
  fs.rmSync(process.env.MAWS_E2E_SESSION_FILE, { force: true });
}

// Playwright merges `env` over process.env, so also blank every ambient
// MAWS_* variable (secrets included) so nothing leaks into e2e runs.
const webServerEnv: Record<string, string> = {};
for (const [name] of Object.entries(process.env)) {
  if (name.startsWith("MAWS_")) webServerEnv[name] = "";
}
Object.assign(webServerEnv, disposable.env, {
  NEXT_PUBLIC_BINANCE_FAPI_WS: `ws://127.0.0.1:${FAKE_WS_PORT}`,
  NEXT_PUBLIC_BINANCE_FAPI_WS_FALLBACK: `ws://127.0.0.1:${FAKE_WS_PORT}`,
  // The browser guard in e2e/fixtures.ts cannot see the Next server's own
  // outbound calls (proxy routes, the Binance live manager, ws streams).
  // Preload a guard into the server process — and, via NODE_OPTIONS, into any
  // child process the Next CLI spawns — so a real exchange call fails loudly
  // instead of reaching the network. e2e/server-guard.spec.ts proves it is on.
  NODE_OPTIONS: `--require ${path.resolve("e2e/server-network-guard.cjs")}`,
});

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  // Two retries in CI absorb runner-level flake without hiding a real
  // regression: a deterministic failure still fails all three attempts, and a
  // test that only passes on retry is visible in the report as "flaky".
  retries: process.env.CI ? 2 : 0,
  // The HTML report is what the e2e workflow uploads; the list reporter keeps
  // the job log readable.
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: "http://localhost:3001",
    viewport: { width: 1440, height: 900 },
    // Traces are captured for retried tests only, so green runs stay fast and
    // a flake ships its evidence with the report.
    trace: "on-first-retry",
  },
  // The CI workflow selects this project with `--project=chromium`. Without a
  // projects array Playwright reports `Project(s) "chromium" not found`.
  // devices["Desktop Chrome"] supplies the Chromium channel; the explicit
  // viewport keeps the 1440x900 layout the existing specs were written for.
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  // E2E CI POLICY (see .github/workflows/e2e.yml):
  // - Every spec runs against a disposable server: scratch DB, fresh operator
  //   account, no Binance credentials (scripts/disposable-bootstrap.mjs blanks
  //   all six credential names). Specs log in through the real /api/auth/login
  //   route and never reach the real exchange.
  // - disconnected.spec.ts and smoke.spec.ts use FakeBinanceFeed (no real
  //   exchange) and run in CI on every PR via the e2e.yml workflow.
  // - The webServer runs on port 3001 (isolated from the dev workspace on
  //   3000) so saved state keys (origin-scoped localStorage) cannot
  //   cross-contaminate; MAWS_ALLOWED_ORIGIN matches this port.
  webServer: [
    {
      command: "npx next dev -p 3001",
      // Readiness = the anonymous liveness endpoint answering, not merely the
      // port accepting connections.
      url: "http://127.0.0.1:3001/api/liveness",
      reuseExistingServer: false,
      timeout: 120_000,
      env: webServerEnv,
    },
    // Local-dev convenience mode: the login-free chart is localhost:3000 only.
    // A second, isolated server (own distDir and scratch DB) proves that mode
    // while every other spec keeps the 3001 server without the marker.
    {
      command: "npx next dev -H 127.0.0.1 -p 3000",
      url: "http://127.0.0.1:3000/api/liveness",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...webServerEnv,
        MAWS_ENV: "testnet",
        MAWS_OPERATOR_AUTH: localDevEnv.MAWS_OPERATOR_AUTH,
        MAWS_DB_PATH: localDevEnv.MAWS_DB_PATH,
        MAWS_STATE_DIR: localDevEnv.MAWS_STATE_DIR,
        MAWS_ALLOWED_ORIGIN: "http://localhost:3000",
        MAWS_TRUST_PROXY: "false",
        MAWS_ALLOW_REAL_NETWORK: "0",
        MAWS_NEXT_DIST_DIR: ".next-e2e-localdev",
        MAWS_LOCAL_DEV: "1",
        MAWS_LOCAL_DEV_BIND: "127.0.0.1",
        NEXT_PUBLIC_MAWS_LOCAL_DEV: "1",
        NEXT_PUBLIC_BINANCE_FAPI_WS: `ws://127.0.0.1:${FAKE_WS_PORT}`,
        NEXT_PUBLIC_BINANCE_FAPI_WS_FALLBACK: `ws://127.0.0.1:${FAKE_WS_PORT}`,
      },
    },
  ],
});
