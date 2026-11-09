#!/usr/bin/env tsx

/**
 * One-command Binance Demo Trading verification.
 *
 * Runs, in order:
 *   1. npm run smoke:testnet -- --selftest   (guard self-test; stops on failure)
 *   2. npm run smoke:testnet -- --preflight  (connectivity/filters; stops on failure)
 *   3. npm run smoke:testnet -- --run        (live exchange probe)
 *   4. jest tests/integration/account-margin-fields...
 *   5. jest tests/integration/algo-protection...
 *   6. jest tests/integration/algo-protection-failures...
 *
 * Writes testnet-verification-report.md (gitignored) with one results table
 * and the probe's cleanup verification, then exits non-zero when anything
 * failed or was left open.
 *
 * Credentials:
 *  - Read from MAWS_BINANCE_TESTNET_API_KEY / MAWS_BINANCE_TESTNET_API_SECRET
 *    when both are set, otherwise prompted with hidden input (no echo, no
 *    shell history, not stored in any file).
 *  - Passed only as environment variables of child processes. The parent's
 *    process.env is never assigned a key, and all captured output is redacted
 *    before it is printed or written to the report.
 *  - Never read from .env files: process.env only.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface Credentials {
  apiKey: string;
  apiSecret: string;
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Raw combined stdout/stderr. Redact before printing. */
  output: string;
  ms: number;
  timedOut: boolean;
}

interface StepRow {
  step: string;
  suite: string;
  status: "PASS" | "FAIL" | "SKIP";
  observation: string;
  ms: number;
  codes: string[];
}

const ROOT = process.cwd();
const REPORT_PATH = path.join(ROOT, "testnet-verification-report.md");
const SMOKE_REPORT_PATH = path.join(ROOT, "testnet-smoke-report.md");
const JEST_CLI = path.join(ROOT, "node_modules", "jest", "bin", "jest.js");

const TESTNET_SUITES = [
  { suite: "account-margin-fields", pattern: "tests/integration/account-margin-fields.integration.test.ts" },
  { suite: "algo-protection", pattern: "tests/integration/algo-protection.integration.test.ts" },
  { suite: "algo-protection-failures", pattern: "tests/integration/algo-protection-failures.integration.test.ts" },
];

const CHILD_TIMEOUTS = {
  selftest: 180_000,
  preflight: 240_000,
  smokeRun: 15 * 60_000,
  suite: 10 * 60_000,
};

/** Only set once the credentials are resolved; used by every redaction. */
let activeCredentials: Credentials | null = null;

// ─── Redaction and error-code extraction ────────────────────────────────────

function redact(text: string): string {
  if (!activeCredentials) return text;
  const { apiKey, apiSecret } = activeCredentials;
  let redacted = text;
  for (const secret of [apiSecret, apiKey]) {
    if (secret.length > 0) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function binanceCodes(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/code["']?\s*[:=]\s*(-?\d{3,5})\b/g)) {
    if (match[1].startsWith("-")) found.add(match[1]);
  }
  for (const match of text.matchAll(/(?<![-\w])-201[45]\b/g)) found.add(match[0]);
  return [...found];
}

function detectRejectedKeys(text: string): string | null {
  const match = text.match(/(?:code["']?\s*[:=]\s*)?(-201[45])\b/);
  return match ? match[1] : null;
}

/** Short human-readable observation from a child's captured output. */
function summarize(result: ChildResult): string {
  const output = redact(result.output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (result.timedOut) return `timed out after ${result.ms}ms`;
  const failure = output.find((line) => /(✗|FAIL|failed|Error:|rejected)/i.test(line));
  if (failure) return failure.slice(0, 300);
  const last = output[output.length - 1] ?? "no output";
  return last.slice(0, 300);
}

function tail(result: ChildResult, lines = 25): void {
  const output = redact(result.output).split(/\r?\n/).filter((line) => line.trim() !== "");
  for (const line of output.slice(-lines)) console.log(`    ${line}`);
}

// ─── Child processes ────────────────────────────────────────────────────────

function runChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ChildResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      shell: process.platform === "win32" && command === "npm",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let raw = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      raw += `\n[verify] failed to start ${command}: ${String(error)}\n`;
      resolve({ code: 1, signal: null, output: raw, ms: Date.now() - started, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output: raw, ms: Date.now() - started, timedOut });
    });
  });
}

/**
 * Environment for one child process. The credentials live only in this object:
 * the parent's process.env is never mutated, so no key can leak into a later
 * unrelated process or into this process's own diagnostics.
 */
function childEnv(credentials: Credentials | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, MAWS_ENV: "testnet" };
  if (credentials) {
    env.MAWS_BINANCE_TESTNET_API_KEY = credentials.apiKey;
    env.MAWS_BINANCE_TESTNET_API_SECRET = credentials.apiSecret;
  }
  return env;
}

function runNpm(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ChildResult> {
  return runChild("npm", args, env, timeoutMs);
}

function runSuite(pattern: string, env: NodeJS.ProcessEnv): Promise<ChildResult> {
  return runChild(
    process.execPath,
    [
      JEST_CLI,
      `--testPathPatterns=${pattern}`,
      "--testPathIgnorePatterns=/node_modules/",
      "--testPathIgnorePatterns=/lib/charting/",
      "--runInBand",
    ],
    env,
    CHILD_TIMEOUTS.suite,
  );
}

// ─── Hidden credential prompt ───────────────────────────────────────────────

/**
 * Reads one line with terminal echo disabled. Raw mode gives per-keystroke
 * control, so the value is never rendered, never buffered by the shell, and
 * never appears in history. Requires an interactive TTY; without one we refuse
 * rather than fall back to echoed input.
 */
async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "No interactive terminal available for a hidden prompt. Set MAWS_BINANCE_TESTNET_API_KEY and MAWS_BINANCE_TESTNET_API_SECRET instead.",
    );
  }
  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const finish = (settle: () => void) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      settle();
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish(() => resolve(value));
        if (char === "\u0003") return finish(() => reject(new Error("Cancelled.")));
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " ") value += char;
      }
    };

    stdin.on("data", onData);
    stdin.on("error", (error) => finish(() => reject(error)));
  });
}

async function resolveCredentials(): Promise<Credentials> {
  const envKey = (process.env.MAWS_BINANCE_TESTNET_API_KEY ?? "").trim();
  const envSecret = (process.env.MAWS_BINANCE_TESTNET_API_SECRET ?? "").trim();
  if (envKey && envSecret) {
    console.log("Using MAWS_BINANCE_TESTNET_API_KEY / MAWS_BINANCE_TESTNET_API_SECRET from the environment.");
    return { apiKey: envKey, apiSecret: envSecret };
  }
  if (envKey || envSecret) {
    throw new Error(
      "Set both MAWS_BINANCE_TESTNET_API_KEY and MAWS_BINANCE_TESTNET_API_SECRET, or neither (to be prompted).",
    );
  }
  console.log("Binance Demo Trading credentials (input hidden, not stored, not added to shell history):");
  const apiKey = (await readHidden("  API key: ")).trim();
  const apiSecret = (await readHidden("  API secret: ")).trim();
  if (!apiKey || !apiSecret) throw new Error("Both the API key and the API secret are required.");
  return { apiKey, apiSecret };
}

// ─── Smoke cleanup verification ─────────────────────────────────────────────

function readCleanupStatus(): { status: "PASS" | "FAIL" | "SKIP"; detail: string } {
  if (!fs.existsSync(SMOKE_REPORT_PATH)) {
    return { status: "FAIL", detail: "testnet-smoke-report.md was not written, so cleanup was not verified" };
  }
  const report = fs.readFileSync(SMOKE_REPORT_PATH, "utf8");
  const section = report.split("## Cleanup")[1] ?? "";
  const bullets = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
  const stillOpen = bullets.filter((line) => line.startsWith("STILL OPEN"));
  if (stillOpen.length > 0) return { status: "FAIL", detail: stillOpen.join("; ") };
  if (bullets.length === 1 && bullets[0] === "all flat") return { status: "PASS", detail: "all flat" };
  if (bullets.length === 0) return { status: "FAIL", detail: "cleanup result missing from testnet-smoke-report.md" };
  return { status: "FAIL", detail: `cleanup reported: ${bullets.join("; ")}` };
}

// ─── Report ─────────────────────────────────────────────────────────────────

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 500) || "—";
}

function writeReport(rows: StepRow[], stopped: string | null): void {
  const lines: string[] = [
    "# Testnet Verification Report",
    "",
    `**Date:** ${new Date().toISOString()}`,
    "**Hosts:** https://demo-fapi.binance.com / wss://demo-fstream.binance.com (Binance USDⓈ-M Demo Trading)",
    "**Credentials:** provided via environment or hidden prompt; not printed, not stored, redacted from captured output.",
    "",
  ];
  if (stopped) lines.push(`**Stopped early:** ${stopped}`, "");

  lines.push("| Step | Suite / Check | Status | Observation | Time | Binance codes |");
  lines.push("|------|---------------|--------|-------------|------|---------------|");
  for (const row of rows) {
    lines.push(
      `| ${row.step} | ${cell(row.suite)} | ${row.status} | ${cell(row.observation)} | ${row.ms}ms | ${row.codes.length > 0 ? row.codes.join(", ") : "—"} |`,
    );
  }
  lines.push("");

  const cleanup = rows.find((row) => row.suite.startsWith("Cleanup verification"));
  lines.push("## Cleanup verification");
  lines.push("");
  lines.push(cleanup ? `- ${cleanup.status}: ${cleanup.observation}` : "- not run");
  lines.push("");

  const counts = {
    PASS: rows.filter((row) => row.status === "PASS").length,
    FAIL: rows.filter((row) => row.status === "FAIL").length,
    SKIP: rows.filter((row) => row.status === "SKIP").length,
  };
  lines.push("## Summary");
  lines.push("");
  lines.push(`- PASS: ${counts.PASS}`);
  lines.push(`- FAIL: ${counts.FAIL}`);
  lines.push(`- SKIP: ${counts.SKIP}`);
  lines.push("");

  fs.writeFileSync(REPORT_PATH, redact(lines.join("\n")));
  console.log(`\nReport written to ${REPORT_PATH}`);
}

function finish(rows: StepRow[], stopped: string | null): void {
  writeReport(rows, stopped);
  const failed = rows.filter((row) => row.status === "FAIL");
  const stillOpen = rows.some((row) => row.observation.includes("STILL OPEN"));
  if (stopped) console.error(`\nSTOPPED: ${stopped}`);
  if (failed.length > 0) console.error(`\n${failed.length} check(s) FAILED`);
  if (stillOpen) console.error("\nCleanup left positions or orders open");
  if (failed.length > 0 || stillOpen || stopped) process.exitCode = 1;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rows: StepRow[] = [];
  const record = (row: StepRow): void => {
    rows.push(row);
    const tag = row.status === "PASS" ? "✓" : row.status === "FAIL" ? "✗" : "○";
    console.log(`  [${tag}] ${row.suite} — ${row.status} (${row.ms}ms): ${row.observation}`);
  };

  // 1. Safety self-test
  console.log("\n1. assertTestnetSafety self-test");
  const selftest = await runNpm(["run", "smoke:testnet", "--", "--selftest"], childEnv(null), CHILD_TIMEOUTS.selftest);
  const selftestOutput = redact(selftest.output);
  record({
    step: "1",
    suite: "smoke:testnet --selftest",
    status: selftest.code === 0 ? "PASS" : "FAIL",
    observation: selftest.code === 0 ? "guard self-test passed" : summarize(selftest),
    ms: selftest.ms,
    codes: [],
  });
  if (selftest.code !== 0) {
    tail(selftest);
    return finish(rows, "The safety self-test failed; no exchange call was made.");
  }

  // 2. Preflight
  console.log("\n2. Exchange preflight");
  const preflight = await runNpm(["run", "smoke:testnet", "--", "--preflight"], childEnv(null), CHILD_TIMEOUTS.preflight);
  record({
    step: "2",
    suite: "smoke:testnet --preflight",
    status: preflight.code === 0 ? "PASS" : "FAIL",
    observation: preflight.code === 0 ? "hosts, exchangeInfo, mark price and sizing reachable" : summarize(preflight),
    ms: preflight.ms,
    codes: binanceCodes(redact(preflight.output)),
  });
  if (preflight.code !== 0) {
    tail(preflight);
    return finish(rows, "Preflight failed; no orders were sent.");
  }

  // 3. Credentials
  let credentials: Credentials;
  try {
    credentials = await resolveCredentials();
    activeCredentials = credentials;
  } catch (error) {
    record({
      step: "3",
      suite: "Demo Trading credentials",
      status: "FAIL",
      observation: error instanceof Error ? error.message : String(error),
      ms: 0,
      codes: [],
    });
    return finish(rows, "No usable credentials.");
  }
  console.log("  [✓] credentials resolved (values hidden and never written)\n");

  // 4. Live exchange probe
  console.log("4. Live exchange probe (smoke:testnet --run)");
  const smoke = await runNpm(["run", "smoke:testnet", "--", "--run"], childEnv(credentials), CHILD_TIMEOUTS.smokeRun);
  const smokeOutput = redact(smoke.output);
  const rejected = detectRejectedKeys(smokeOutput);
  record({
    step: "4",
    suite: "smoke:testnet --run",
    status: smoke.code === 0 && !rejected ? "PASS" : "FAIL",
    observation: rejected ? `credentials rejected: code ${rejected}` : summarize(smoke),
    ms: smoke.ms,
    codes: binanceCodes(smokeOutput),
  });
  tail(smoke);

  // 5. Cleanup verification from the probe's report
  const cleanup = readCleanupStatus();
  record({
    step: "5",
    suite: "Cleanup verification (probe)",
    status: cleanup.status,
    observation: cleanup.detail,
    ms: 0,
    codes: [],
  });

  if (rejected) {
    return finish(
      rows,
      `Binance rejected the Demo Trading API key (code ${rejected}). Stopped before the integration suites; check the key, its IP restrictions and that it belongs to Demo Trading.`,
    );
  }

  // 6+. App-level integration suites, each in its own child process.
  const suitesStart = Date.now();
  let stepNumber = 6;
  for (const suite of TESTNET_SUITES) {
    console.log(`\n${stepNumber}. Integration suite: ${suite.suite}`);
    const result = await runSuite(suite.pattern, childEnv(credentials));
    const output = redact(result.output);
    const suiteRejected = detectRejectedKeys(output);
    record({
      step: String(stepNumber),
      suite: `jest ${suite.suite}`,
      status: result.code === 0 && !suiteRejected ? "PASS" : "FAIL",
      observation: suiteRejected ? `credentials rejected: code ${suiteRejected}` : summarize(result),
      ms: result.ms,
      codes: binanceCodes(output),
    });
    if (result.code !== 0) tail(result);
    if (suiteRejected) {
      return finish(rows, `Binance rejected the Demo Trading API key (code ${suiteRejected}) during ${suite.suite}.`);
    }
    stepNumber++;
  }
  console.log(`\nIntegration suites took ${Date.now() - suitesStart}ms in total`);

  const failed = rows.filter((row) => row.status === "FAIL");
  finish(rows, null);
  if (failed.length === 0 && cleanup.status === "PASS") console.log("\n═══ TESTNET VERIFICATION PASSED ═══\n");
  else console.log("\n═══ TESTNET VERIFICATION FAILED ═══\n");
}

main().catch((error) => {
  console.error("Fatal:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
