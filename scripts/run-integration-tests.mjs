#!/usr/bin/env node
/**
 * Runs the Binance Testnet integration suites.
 *
 * Jest's project config ignores tests/integration so the fast unit run never
 * picks them up; this runner re-includes that folder explicitly, loads
 * .env.integration when it exists (shell variables win), and fails with a
 * non-zero exit when the pattern discovers no test files.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env.integration");
if (existsSync(envFile)) {
  dotenv.config({ path: envFile, quiet: true });
}

const jest = path.join(root, "node_modules", "jest", "bin", "jest.js");
const selection = [
  "--testPathPatterns=tests/integration",
  "--testPathIgnorePatterns=/node_modules/",
  "--testPathIgnorePatterns=/lib/charting/",
];

const listing = spawnSync(process.execPath, [jest, ...selection, "--listTests"], {
  cwd: root,
  encoding: "utf8",
});
const discovered = (listing.stdout ?? "").split(/\r?\n/).filter((line) => line.trim() !== "");
if (listing.status !== 0 || discovered.length === 0) {
  console.error(
    "test:integration: no test files discovered under tests/integration; refusing to report success",
  );
  process.exit(1);
}
console.log(`test:integration: ${discovered.length} test file(s) discovered`);

const child = spawn(process.execPath, [jest, ...selection, "--runInBand", "--detectOpenHandles"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});
child.on("close", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
