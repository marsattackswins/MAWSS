// ── Vendored Trade Journal (vendor/trade-journal) ───────────────────────────
//
// /journal is proxied to the LuxAlgo Trade Journal, a second Next app whose
// source is committed under vendor/trade-journal (see next.config.ts and
// scripts/journal-sidecar.mjs). Source provenance: upstream
// https://github.com/LuxAlgo/trade-journal at commit
// 834e7b68f553d1aba0d7777875cdc4622f5a7eb5, committed here with this
// integration's local changes (MIT).
//
// Only the source is committed. Its dependencies are not — node_modules is
// hundreds of megabytes and better-sqlite3 compiles natively — and neither is
// its build output or its journal database. A fresh clone therefore has the
// source but nothing runnable yet, so this module:
//
//   pnpm install --frozen-lockfile   (vendor/trade-journal/pnpm-lock.yaml)
//   next build                       (once; `next start` needs the output)
//
// The sidecar calls it the first time a dev server starts; `npm run
// journal:setup` runs it (plus the build) explicitly. Both are idempotent: with
// node_modules and a build in place they do nothing.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";

// The upstream commit the committed source came from (provenance, not a fetch).
const JOURNAL_COMMIT = "834e7b68f553d1aba0d7777875cdc4622f5a7eb5";
const PNPM_VERSION = "11.0.8";

const win32 = platform() === "win32";

export function journalPaths(root) {
  const dir = path.join(root, "vendor", "trade-journal");
  const webDir = path.join(dir, "apps", "web");
  return {
    dir,
    webDir,
    nextBin: path.join(webDir, "node_modules", "next", "dist", "bin", "next"),
    buildId: path.join(webDir, ".next", "BUILD_ID"),
  };
}

/** Windows runs pnpm/npx through .cmd shims, which need a shell; node is a real
 *  executable and is spawned directly. */
const needsShell = (cmd) => win32 && (cmd === "pnpm" || cmd === "npx");

function spawnAsync(cmd, args, { cwd, stdio = "inherit" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio, shell: needsShell(cmd) });
    child.on("error", (error) => resolve({ ok: false, error }));
    child.on("exit", (code) => resolve({ ok: code === 0, code }));
  });
}

function commandOutput(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: needsShell(cmd),
    }).trim();
  } catch {
    return "";
  }
}

/** pnpm when installed, otherwise npm's npx pinned to the journal's own version
 *  (its package.json declares `packageManager: pnpm@11.0.8`). */
function pnpmRunner(cwd) {
  if (commandOutput("pnpm", ["--version"], cwd)) return { cmd: "pnpm", prefix: [] };
  return { cmd: "npx", prefix: ["--yes", `pnpm@${PNPM_VERSION}`] };
}

/** Where the journal stands, without touching the network or disk. */
export function journalState(root) {
  const { dir, webDir, nextBin } = journalPaths(root);
  return {
    dir,
    hasSource: fs.existsSync(path.join(webDir, "package.json")),
    hasDependencies: fs.existsSync(nextBin),
  };
}

async function installDependencies({ root, log }) {
  const { dir } = journalPaths(root);
  const { cmd, prefix } = pnpmRunner(dir);
  log("installing Trade Journal dependencies with pnpm (first run only — this takes a few minutes)…");
  const result = await spawnAsync(cmd, [...prefix, "install", "--frozen-lockfile"], { cwd: dir });
  if (!result.ok) throw new Error("pnpm install failed — see the output above.");
}

/**
 * Make the committed journal source runnable: install its workspace
 * dependencies when node_modules is missing. No-op once they are there.
 */
export async function ensureJournalDependencies({ root = process.cwd(), log = () => {} } = {}) {
  const state = journalState(root);
  if (!state.hasSource) {
    throw new Error(
      `${path.relative(root, state.dir)} is missing — its source is committed to this repo; ` +
        "restore it with `git checkout -- vendor/trade-journal`.",
    );
  }
  if (!state.hasDependencies) await installDependencies({ root, log });
}

/** Production build of the vendored journal — `next start` needs one. */
export async function buildJournal({ root = process.cwd(), log = () => {} } = {}) {
  const { webDir, nextBin, buildId } = journalPaths(root);
  if (!fs.existsSync(nextBin)) throw new Error("Trade Journal dependencies are not installed");
  if (fs.existsSync(buildId)) return;
  log("building the Trade Journal (this can take a minute)…");
  const result = await spawnAsync(process.execPath, [nextBin, "build"], { cwd: webDir });
  if (!result.ok) throw new Error("the Trade Journal build failed — see the output above.");
}

async function main() {
  const root = process.cwd();
  const log = (message) => console.log(`[journal] ${message}`);
  await ensureJournalDependencies({ root, log });
  await buildJournal({ root, log });
  log(`ready — /journal is proxied to :3400 (source: upstream ${JOURNAL_COMMIT.slice(0, 7)}).`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[journal] setup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
