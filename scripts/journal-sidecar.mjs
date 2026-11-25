// ── Journal sidecar (vendored LuxAlgo Trade Journal on :3400) ───────────────
//
// The vendored journal app (vendor/trade-journal) is a separate Next server that
// the main app proxies same-origin at /journal (see next.config.ts). Nothing
// listens on 3400 unless a launcher starts it, and the proxy turns that refused
// connection into an "Internal Server Error" on the journal button — so the
// sidecar needs an owner, not a manual `npm run journal` step that never comes
// back after a restart. Both entry points call into here and own it identically:
// install the journal's dependencies on a fresh clone (its node_modules is not
// committed), reuse an instance that is already up, otherwise start it (with a
// one-time build when nothing is built) and respawn it if it dies, then stop it
// when the launcher itself exits so an old sidecar never strands the port.

import { exec, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { platform } from "node:os";
import { buildJournal, ensureJournalDependencies, journalPaths } from "./journal-setup.mjs";

export const JOURNAL_PORT = 3400;

const READY_POLL_MS = 300;
const READY_TIMEOUT_MS = 30_000;
const RESPAWN_DELAY_MS = 3_000;
const MAX_RESPAWNS = 5;

/** @type {import('node:child_process').ChildProcess | null} */
let proc = null;
/** @type {Promise<void> | null} */
let starting = null;
let stopping = false;
let respawns = 0;

function sidecarPaths(root) {
  return { ...journalPaths(root), logFile: path.join(root, ".next", "journal.log") };
}

export async function journalReady() {
  try {
    const res = await fetch(`http://127.0.0.1:${JOURNAL_PORT}/journal`, {
      signal: AbortSignal.timeout(1_500),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

// MAWS_JOURNAL_UPSTREAM moves the proxy target (see lib/maws/journal.ts). When it
// points somewhere that is not this machine's 3400, the journal lives elsewhere
// and starting a local copy would be wrong.
function upstreamIsLocal() {
  const override = process.env.MAWS_JOURNAL_UPSTREAM?.trim();
  if (!override) return true;
  try {
    const target = new URL(override);
    return (
      target.hostname === "127.0.0.1" ||
      target.hostname === "localhost" ||
      target.hostname === "[::1]"
    ) && Number(target.port || 80) === JOURNAL_PORT;
  } catch {
    return true;
  }
}

function spawnServer({ root, log, error }) {
  const { dir, nextBin, logFile } = sidecarPaths(root);
  const stream = fs.createWriteStream(logFile, { flags: "a" });
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(JOURNAL_PORT)], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  proc = child;

  child.on("error", (err) => {
    proc = null;
    stream.end();
    error(`[journal] could not start the server: ${err.message}`);
  });

  child.on("exit", (code, signal) => {
    proc = null;
    stream.end();
    if (stopping) return;
    if (++respawns > MAX_RESPAWNS) {
      error(`[journal] exited ${respawns} times — giving up. Check ${logFile}`);
      return;
    }
    log(`[journal] server exited (code=${code ?? signal}) — restarting in ~${RESPAWN_DELAY_MS / 1000}s.`);
    setTimeout(() => {
      if (!stopping) spawnServer({ root, log, error });
    }, RESPAWN_DELAY_MS).unref?.();
  });
}

/**
 * Bring the journal up and keep it up for this process's lifetime. Resolves once
 * the sidecar answers (or fails to); concurrent calls share one attempt.
 */
export function ensureJournalSidecar({ root = process.cwd(), log = () => {}, error = log } = {}) {
  if (starting) return starting;
  starting = (async () => {
    if (!upstreamIsLocal()) {
      log(`[journal] upstream is ${process.env.MAWS_JOURNAL_UPSTREAM} — not starting a local sidecar.`);
      return;
    }
    if (await journalReady()) {
      log(`[journal] reusing the already-running Trade Journal on :${JOURNAL_PORT}.`);
      return;
    }
    const { logFile } = sidecarPaths(root);
    // The journal's source is committed, but its dependencies are not: install
    // them from the committed lockfile before anything else.
    try {
      await ensureJournalDependencies({ root, log: (message) => log(`[journal] ${message}`) });
    } catch (err) {
      error(`[journal] setup failed: ${err.message}`);
      return;
    }
    // A missing production build only happens on a fresh clone: `next start`
    // needs one. Build once (slow), then start.
    try {
      await buildJournal({ root, log: (message) => log(`[journal] ${message}`) });
    } catch (err) {
      error(`[journal] ${err.message} — check ${logFile}`);
      return;
    }
    spawnServer({ root, log, error });
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await journalReady()) {
        log(`[journal] ready on :${JOURNAL_PORT} — proxied at /journal.`);
        return;
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    error(`[journal] did not become ready in ${READY_TIMEOUT_MS / 1000}s — check ${logFile}`);
  })().finally(() => {
    starting = null;
  });
  return starting;
}

/** Tear the sidecar down. Called when the owning launcher exits, so the port is
 *  free for the next one and no orphan keeps serving stale builds. */
export function stopJournalSidecar() {
  stopping = true;
  const child = proc;
  if (!child || child.exitCode !== null) return;
  // Windows cannot deliver a signal into another process tree, so kill it outright.
  if (platform() === "win32") {
    exec(`taskkill /PID ${child.pid} /T /F`, () => {});
  } else {
    child.kill("SIGTERM");
  }
}
