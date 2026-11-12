import { exec, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { platform } from "node:os";
import nextEnv from "@next/env";
import { APP_PORT } from "./app-port.mjs";
import { ensureJournalSidecar, stopJournalSidecar } from "./journal-sidecar.mjs";
import { createDisposableContext, passwordAnnouncement, requireOperatorAuth } from "./disposable-bootstrap.mjs";

const { loadEnvConfig } = nextEnv;

// Pinned to 3000, never env-selected and never "next free port": the browser's
// saved workspace is keyed by origin, so any other port is a fresh empty
// workspace (see app-port.mjs).
const port = String(APP_PORT);
const url = `http://localhost:${port}`;
const probe = `http://127.0.0.1:${port}`;

const cyan = "\x1b[36m";
const bold = "\x1b[1m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

// The environment may ask for another port (launchers often pass PORT=0). Say so
// once, without echoing any env value, then serve on APP_PORT anyway — the app
// has exactly one address.
const asksOtherPort = [process.env.MAWS_PORT, process.env.PORT].some(
  (value) => value !== undefined && String(value).trim() !== port,
);
if (asksOtherPort) {
  console.log(
    `${dim}  ignoring PORT/MAWS_PORT overrides — MAWS always serves on ${port} so the browser keeps its saved state.${reset}`,
  );
}

console.log(`
${cyan}${bold}  ███╗   ███╗    █████╗    ██╗    ██╗   ███████╗
  ████╗ ████║   ██╔══██╗   ██║    ██║   ██╔════╝
  ██╔████╔██║   ███████║   ██║ █╗ ██║   ███████╗
  ██║╚██╔╝██║   ██╔══██║   ██║███╗██║   ╚════██║
  ██║ ╚═╝ ██║   ██║  ██║   ╚███╔███╔╝   ███████║
  ╚═╝     ╚═╝   ╚═╝  ╚═╝    ╚══╝╚══╝    ╚══════╝${reset}
  ${dim}Market Analysis & Workflow System • Dev Server${reset}
`);

// ── Reuse an already-running dev server for this project ────────────────────
//
// Next 16 guards its dev server with an OS-level lockfile at
// `<distDir>/lock` (JSON: { pid, port, appUrl, ... }). A second `next dev`
// in the same directory fails with "Another next dev server is already
// running" — which used to bite whenever a stale server survived (crashed
// agent sessions, detached terminals, a Freebuff restart).
//
// Instead of failing, we discover the live server and hand the user its URL:
//  1. Fast path — if OUR configured port answers, it's the server; reuse it.
//  2. Lockfile path — read `.next/dev/lock`; if its PID is alive and its HTTP
//     port answers, reuse that (it may run on a different port than ours).
// A stale lockfile (dead PID / dead port) is reported and ignored, so the
// normal spawn proceeds. `npm run dev:restart` kills the running server and
// starts fresh.

const DIST_DIR = path.resolve(process.cwd(), ".next", "dev");
const LOCK_PATH = path.join(DIST_DIR, "lock");

function readLockfileServer() {
  try {
    const info = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
    if (info && Number.isFinite(info.pid) && typeof info.appUrl === "string") {
      return info;
    }
  } catch {
    /* no lockfile / unparsable — nothing running (or a foreign lock) */
  }
  return null;
}

function pidAlive(pid) {
  if (!Number.isFinite(pid)) return false;
  try {
    // Signal 0 probes liveness without killing. On Windows, `process.kill`
    // resolves through the same syscall and throws ESRCH for dead PIDs.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function httpAlive(probeUrl, timeoutMs = 1500) {
  try {
    const res = await fetch(probeUrl, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    // Any HTTP response means something is serving there.
    return res.status > 0;
  } catch {
    return false;
  }
}

/** The running MAWS dev server for this project, if any: { appUrl, pid, port }. */
async function findRunningServer() {
  // 1) Our own port.
  if (await httpAlive(probe)) {
    return { appUrl: url, pid: null, port };
  }
  // 2) The Next dev lockfile (server may be on a different PORT than ours).
  const info = readLockfileServer();
  if (info && pidAlive(info.pid) && (await httpAlive(info.appUrl))) {
    return { appUrl: info.appUrl, pid: info.pid, port: info.port };
  }
  return null;
}

async function killRunningServer(server) {
  // The lockfile PID is the `next-server` worker; on Windows the `node
  // .../next dev` parent we spawned is a separate PID, so kill the whole
  // tree when we can identify it.
  const pids = new Set();
  if (server.pid) pids.add(server.pid);
  if (platform() === "win32") {
    // Find the listener on the server's port and its parent too.
    const find = (p) =>
      new Promise((resolve) => {
        exec(`netstat -ano | findstr :${p}`, (err, stdout) => resolve(err ? "" : String(stdout)));
      });
    const out = await find(server.port);
    for (const m of out.matchAll(/\s(\d+)\s*$/gm)) pids.add(Number(m[1]));
  }
  for (const pid of pids) {
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const cmd = platform() === "win32" ? `taskkill /PID ${pid} /T /F` : `kill ${pid}`;
    await new Promise((resolve) => exec(cmd, () => resolve()));
  }
  // Wait for the port to actually free up.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await httpAlive(server.appUrl, 800))) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const restartFlag = process.argv.includes("--restart");
const reuseFlag = process.argv.includes("--reuse");
const throwawayFlag = process.argv.includes("--throwaway");

if (throwawayFlag && reuseFlag) {
  console.error(
    "--throwaway starts an isolated scratch workspace; there is nothing to reuse.\n  Stop any running dev server, then run `npm run dev:throwaway` on its own.",
  );
  process.exit(1);
}

let existing = await findRunningServer();

// --reuse: hand over an already-running server. Nothing fresh is launched, so
// no launch-configuration requirements apply on this path.
if (existing && reuseFlag && !restartFlag) {
  console.log(`${cyan}Dev server already running at ${bold}${existing.appUrl}${reset}${cyan} — reusing it.${reset}`);
  exec(platform() === "win32" ? `cmd /c start "" "${existing.appUrl}"` : platform() === "darwin" ? `open "${existing.appUrl}"` : `xdg-open "${existing.appUrl}"`);
  process.exit(0);
}

// ── Launch configuration ────────────────────────────────────────────────────
//
// Operator auth is required on every fresh dev launch: the whole app sits
// behind the operator session, so a server without MAWS_OPERATOR_AUTH boots
// into nothing usable. The explicit throwaway launch instead mints a fresh
// verifier, prints its password once, and runs against a scratch database.
//
// Both paths inspect the EFFECTIVE configuration — .env files loaded through
// the same loader and precedence Next itself applies — so what we validate is
// exactly what the server would read. Values are inspected, never printed.
loadEnvConfig(process.cwd(), true, () => {});

let childEnv;
let disposable = null;
if (throwawayFlag) {
  try {
    // Refuses when any Live credential component is configured (effective
    // configuration, .env files included) and when a real operator verifier
    // would be overwritten. The child env is otherwise fully isolated.
    disposable = createDisposableContext({ source: { ...process.env }, purpose: "throwaway" });
    childEnv = { ...disposable.env, PORT: port };
    // Human terminal only; written exactly once. The password is never stored.
    passwordAnnouncement(disposable.password, process.stdout)();
  } catch (error) {
    disposable?.cleanup();
    console.error(`\n${bold}Throwaway launch refused.${reset}\n  ${error.message}\n`);
    process.exit(1);
  }
} else {
  try {
    requireOperatorAuth(process.env);
  } catch (error) {
    console.error(`\n${bold}Dev server cannot start.${reset}\n  ${error.message}\n`);
    process.exit(1);
  }
  childEnv = { ...process.env, PORT: port };
}

// Always kill stale processes on our port before spawning Next — this prevents
// Next's silent port-increment behaviour (EADDRINUSE → port+1, up to 10 times)
// which is what causes the app to start on a different port every run.
// Use `--reuse` to skip this and reuse instead.
if (existing && (restartFlag || !reuseFlag)) {
  if (restartFlag) {
    console.log(`${dim}Killing existing dev server (${existing.appUrl})…${reset}`);
  } else {
    console.log(`${dim}Stale dev server found at ${existing.appUrl} — clearing it to free port ${port}…${reset}`);
    console.log(`${dim}(Run \`npm run dev:restart\` to do this explicitly, or \`npm run dev -- --reuse\` to reuse instead.)${reset}`);
  }
  const killed = await killRunningServer(existing);
  if (!killed) {
    console.error(`Could not free ${existing.appUrl} — kill the process manually.`);
    process.exit(1);
  }
  existing = null;
}

/** Is something already listening on the app port? A CONNECT probe is the reliable
 *  signal: on Windows a plain `listen` succeeds against an occupied port, so a bind
 *  test alone reports "free" while the first request goes to the other process. The
 *  bind test is kept as a second signal for a socket that accepts nothing. */
async function portInUse(p) {
  const connected = await new Promise((resolve) => {
    const sock = net.connect({ port: p, host: "127.0.0.1" });
    const finish = (value) => {
      sock.destroy();
      resolve(value);
    };
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.setTimeout(700, () => finish(false));
  });
  if (connected) return true;
  const bindable = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(p, "0.0.0.0", () => probe.close(() => resolve(true)));
  });
  return !bindable;
}

// ── Spawn Next as usual ─────────────────────────────────────────────────────
// Next silently walks up the port range (3000 → 3001 → …) when the port is taken.
// That would put the app on an address with none of the saved workspace, so refuse
// to start instead: a clear failure beats a second, empty origin.
if (await portInUse(Number(port))) {
  console.error(
    `\n${bold}Port ${port} is already in use.${reset}\n  MAWS only runs on ${port} — starting elsewhere would open with an empty workspace.\n  Free the port (or stop the other server) and run \`npm run dev\` again.`,
  );
  process.exit(1);
}

const nextBin = path.resolve(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "dev", "-p", port], {
  stdio: "inherit",
  // PORT pinned as well as the flag: nothing in the toolchain may read a launcher's
  // PORT=0 and build URLs from it.
  env: childEnv,
});

// ── Journal sidecar (vendored LuxAlgo Trade Journal on :3400) ───────────────
//
// The journal is a separate Next server that the app proxies at /journal, and it
// used to be a manual `npm run journal` step that never came back after a dev
// restart — the journal button served connection-refused. The ownership rules
// live in scripts/journal-sidecar.mjs (shared with the supervisor): reuse an
// already-running instance, otherwise start it (one-time build if needed) and
// respawn it if it dies. It dies with the dev server — Ctrl-C cleans up both.
void ensureJournalSidecar({
  log: (message) => console.log(`${dim}${message}${reset}`),
  error: (message) => console.error(message),
});

let stopping = false;
const stopChild = (signal = "SIGTERM") => {
  if (stopping) return;
  stopping = true;
  if (!child.killed) child.kill(signal);
  // The sidecar is our child too: a dev-storm restart must not strand an old
  // journal server holding port 3400.
  stopJournalSidecar();
  const fallback = setTimeout(() => {
    if (child.exitCode === null) child.kill();
  }, 5_000);
  fallback.unref();
};
process.once("SIGINT", () => stopChild("SIGINT"));
process.once("SIGTERM", () => stopChild("SIGTERM"));

child.on("exit", (code, signal) => {
  // Throwaway runs own a scratch DB/state directory under the OS temp dir;
  // once the server is gone it must not linger.
  disposable?.cleanup();
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await fetch(probe, { redirect: "manual" });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return false;
}

function openBrowser() {
  const cmd =
    platform() === "win32"
      ? `cmd /c start "" "${url}"`
      : platform() === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd);
}

waitForServer().then((ok) => {
  if (ok) openBrowser();
});
