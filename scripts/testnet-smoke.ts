#!/usr/bin/env tsx

/**
 * Binance USDⓈ-M Demo Trading EXCHANGE PROBE.
 *
 * This script talks to the exchange directly. It never starts the MAWS app,
 * so it cannot verify app-level behaviour: the app's PROTECTED/UNPROTECTED
 * protection status, orphan cleanup performed by the manager, and risk-snapshot
 * freshness are covered by tests/integration/algo-protection-failures.integration.test.ts.
 * Every step below is labelled [exchange] in the report.
 *
 * Verifies the demo environment end-to-end: host connectivity, exchange info,
 * order lifecycle, Algo conditional orders (TP/SL), protection replacement,
 * the orphan outcome after a direct close, emergency flatten, and multi-symbol
 * trading.
 *
 * Safety — imports and calls assertTestnetSafety from tests/integration/helpers.ts:
 *  - Refuses unless MAWS_ENV=testnet and no production credentials are set.
 *  - Uses a temp DB path; never touches .maws.
 *  - Never reads .env files (process.env only).
 *  - Never prints API keys, secrets, or signatures.
 *
 * Failure semantics: any failed setup call FAILS its step and skips the checks
 * that depend on it. Cleanup always re-reads positionRisk, openOrders and
 * openAlgoOrders for every touched symbol, reports leftovers as
 * "STILL OPEN: <symbol> <qty> <side>" (or "all flat"), and exits non-zero when
 * anything is left open. Quantities are exact decimal strings from the
 * exchange (never parseFloat/String on order quantities).
 *
 * Usage:
 *   tsx scripts/testnet-smoke.ts              # preflight (default)
 *   tsx scripts/testnet-smoke.ts --preflight  # explicit preflight
 *   tsx scripts/testnet-smoke.ts --run        # live orders (requires keys)
 *   tsx scripts/testnet-smoke.ts --selftest   # verify the guard refuses bad inputs
 */

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { assertTestnetSafety } from "../tests/integration/helpers";
import {
  absoluteDecimalString,
  calcQty,
  decimalToString,
  isZeroDecimal,
  priceFromPct,
  readFilters,
  readMark,
} from "../tests/integration/testnet-sizing";
import type { EnvConfig, ProfileRegistry } from "@/lib/server/env/config";

// ─── Constants (must match HOST_MAP in lib/server/env/config.ts) ──────────

const DEMO_REST = "https://demo-fapi.binance.com";
const DEMO_WS = "wss://demo-fstream.binance.com";
const PROD_REST = "https://fapi.binance.com";
const PROD_WS = "wss://fstream.binance.com";
const SYMBOL = "BTCUSDT";
const SECOND_SYMBOL = "ETHUSDT";
const RUN_LABEL = "EXCHANGE PROBE";
const APP_LEVEL_SUITE = "tests/integration/algo-protection-failures.integration.test.ts";

// ─── Credentials (never print values) ──────────────────────────────────────

function getKey(): string {
  return (process.env.MAWS_BINANCE_TESTNET_API_KEY ?? process.env.MAWS_BINANCE_API_KEY ?? "").trim();
}
function getSecret(): string {
  return (process.env.MAWS_BINANCE_TESTNET_API_SECRET ?? process.env.MAWS_BINANCE_API_SECRET ?? "").trim();
}
function hasKeys(): boolean { return getKey().length > 0 && getSecret().length > 0; }

function keyVarNames(): { keyVar: string; secretVar: string } {
  return {
    keyVar: process.env.MAWS_BINANCE_TESTNET_API_KEY ? "MAWS_BINANCE_TESTNET_API_KEY" : "MAWS_BINANCE_API_KEY",
    secretVar: process.env.MAWS_BINANCE_TESTNET_API_SECRET ? "MAWS_BINANCE_TESTNET_API_SECRET" : "MAWS_BINANCE_API_SECRET",
  };
}

// ─── Config builder for assertTestnetSafety ────────────────────────────────

function buildSafetyConfig(): EnvConfig {
  const dbPath = path.join(os.tmpdir(), `maws-smoke-${crypto.randomBytes(8).toString("hex")}.db`);
  const profiles: ProfileRegistry = {
    "binance-testnet": {
      profileId: "binance-testnet",
      label: "Binance Demo Trading",
      environment: "testnet",
      configured: hasKeys(),
      executionEnabled: hasKeys(),
      apiKey: getKey() || null,
      apiSecret: getSecret() || null,
      restEndpoint: DEMO_REST,
      webSocketEndpoint: DEMO_WS,
    },
    "binance-production": {
      profileId: "binance-production",
      label: "Binance Live",
      environment: "production",
      configured: false,
      executionEnabled: false,
      apiKey: null,
      apiSecret: null,
      restEndpoint: PROD_REST,
      webSocketEndpoint: PROD_WS,
    },
  };
  return {
    env: "testnet",
    brokerType: "binance",
    defaultProfile: "binance-testnet",
    activeProfileId: "binance-testnet",
    profiles,
    dbPath,
    operatorAuth: null,
    allowedOrigin: null,
    trustProxy: false,
    backupKey: null,
    healthToken: null,
    emergencyToken: null,
    reverseEnabled: false,
    binanceApiKey: getKey() || null,
    binanceApiSecret: getSecret() || null,
    recvWindowMs: 5000,
    rateInternalPerMin: 60,
    reconIntervalMs: 10_000,
    markPriceIntervalMs: 15_000,
    historyBackfillMs: 3 * 24 * 60 * 60 * 1000,
    leaseTtlMs: 60_000,
    snapshotMaxAgeMs: 5 * 60_000,
    protectionPendingMaxAgeMs: 2 * 60_000,
    alertWebhookUrl: null,
    missingProductionRiskLimitVariables: [],
    risk: {
      maxOrderNotionalUsd: 200,
      maxGrossExposureUsd: 400,
      maxOpenOrders: 20,
      maxOpenPositions: 5,
      dailyLossPct: 80,
      priceCollarPct: 10,
      maxLeverage: 10,
      maxMarginRatio: 0.5,
      minLiquidationDistancePct: 5,
    },
    circuitBreaker: {
      restFailureThreshold: 10,
      restFailureWindowMs: 60_000,
      restRecoveryTimeoutMs: 30_000,
      restSuccessThreshold: 2,
      streamFailureThreshold: 5,
      streamFailureWindowMs: 300_000,
      streamRecoveryTimeoutMs: 60_000,
      streamSuccessThreshold: 1,
      reconFailureThreshold: 5,
      reconFailureWindowMs: 600_000,
      reconRecoveryTimeoutMs: 120_000,
      reconSuccessThreshold: 2,
    },
  };
}

// ─── Safety guard (delegates to assertTestnetSafety) ────────────────────────

function runSafetyCheck(): EnvConfig {
  const cfg = buildSafetyConfig();
  assertTestnetSafety(cfg, process.env, process.cwd());
  return cfg;
}

// ─── Self-test ──────────────────────────────────────────────────────────────

async function selftest(): Promise<void> {
  console.log("Running assertTestnetSafety self-test...\n");
  let passed = 0;
  let failed = 0;

  const cfg = buildSafetyConfig();
  const baseEnv: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    MAWS_ENV: "testnet",
    MAWS_DB_PATH: cfg.dbPath,
  };

  // Baseline: valid config + env should pass
  try {
    assertTestnetSafety(cfg, baseEnv, process.cwd());
    console.log("  ✓ PASS: baseline (valid config + env)");
    passed++;
  } catch (e) {
    console.log(`  ✗ FAIL: baseline should pass — ${(e as Error).message}`);
    failed++;
  }

  // Test 1: MAWS_ENV unset should throw
  try {
    assertTestnetSafety(cfg, { ...baseEnv, MAWS_ENV: undefined }, process.cwd());
    console.log("  ✗ FAIL: should reject MAWS_ENV unset");
    failed++;
  } catch {
    console.log("  ✓ PASS: rejects MAWS_ENV unset");
    passed++;
  }

  // Test 2: production key set should throw
  try {
    assertTestnetSafety(cfg, { ...baseEnv, MAWS_BINANCE_PRODUCTION_API_KEY: "prod-key" }, process.cwd());
    console.log("  ✗ FAIL: should reject production key set");
    failed++;
  } catch {
    console.log("  ✓ PASS: rejects production key set");
    passed++;
  }

  // Test 3: .maws db path should throw
  try {
    const badCfg = { ...cfg, dbPath: ".maws/maws.db" };
    assertTestnetSafety(badCfg, { ...baseEnv, MAWS_DB_PATH: ".maws/maws.db" }, process.cwd());
    console.log("  ✗ FAIL: should reject .maws db path");
    failed++;
  } catch {
    console.log("  ✓ PASS: rejects .maws db path");
    passed++;
  }

  console.log(`\nSelf-test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

async function publicGet(p: string) {
  const start = Date.now();
  const res = await fetch(`${DEMO_REST}${p}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, ms: Date.now() - start };
}

/** Signed request — never logs the URL (contains signature) or key. */
async function signedRequest(method: string, p: string, params: Record<string, string> = {}) {
  const apiKey = getKey();
  const apiSecret = getSecret();
  if (!apiKey || !apiSecret) throw new Error("No credentials for signed request");
  const allParams = { ...params, timestamp: String(Date.now()), recvWindow: "10000" };
  const query = new URLSearchParams(allParams).toString();
  const signature = crypto.createHmac("sha256", apiSecret).update(query).digest("hex");
  const start = Date.now();
  const res = await fetch(`${DEMO_REST}${p}?${query}&signature=${signature}`, {
    method,
    headers: { "X-MBX-APIKEY": apiKey },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, ms: Date.now() - start };
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── API answer helpers ─────────────────────────────────────────────────────

interface ApiAnswer {
  ok: boolean;
  status: number;
  code?: number;
  msg?: string;
  body: Record<string, unknown>;
}

function interpret(res: { status: number; body: unknown }, endpoint: string, stepNumber: number | "C"): ApiAnswer {
  const body = (res.body ?? {}) as Record<string, unknown>;
  const rawCode = body.code;
  const failedByCode = rawCode !== undefined && String(rawCode) !== "200";
  const ok = res.status === 200 && !failedByCode;
  const code = rawCode !== undefined && Number.isFinite(Number(rawCode)) ? Number(rawCode) : undefined;
  const msg = typeof body.msg === "string" ? body.msg : undefined;
  if (!ok && code !== undefined) {
    errorCodes.push({ code, msg: msg ?? `HTTP ${res.status}`, ep: endpoint, step: stepNumber });
  }
  return { ok, status: res.status, code, msg, body };
}

function describeApi(answer: ApiAnswer): string {
  return `status=${answer.status} code=${answer.code ?? "?"} msg="${answer.msg ?? ""}"`;
}

async function placeMarket(
  symbol: string,
  side: "BUY" | "SELL",
  quantity: string,
  stepNumber: number | "C",
  reduceOnly = false,
): Promise<ApiAnswer> {
  const res = await signedRequest("POST", "/fapi/v1/order", {
    symbol,
    side,
    type: "MARKET",
    quantity,
    newOrderRespType: "RESULT",
    ...(reduceOnly ? { reduceOnly: "true" } : {}),
  });
  return interpret(res, "POST /fapi/v1/order", stepNumber);
}

interface AlgoPlacement {
  ok: boolean;
  clientAlgoId: string;
  algoId?: string;
  error?: string;
}

/**
 * Places a closePosition conditional order on the Algo endpoint with every
 * parameter the endpoint requires: algoType=CONDITIONAL, triggerPrice,
 * closePosition=true, workingType=MARK_PRICE.
 */
async function placeClosePositionAlgo(
  params: {
    symbol: string;
    side: "BUY" | "SELL";
    type: "TAKE_PROFIT_MARKET" | "STOP_MARKET";
    triggerPrice: string;
    clientAlgoId: string;
  },
  stepNumber: number | "C",
): Promise<AlgoPlacement> {
  const res = await signedRequest("POST", "/fapi/v1/algoOrder", {
    algoType: "CONDITIONAL",
    symbol: params.symbol,
    side: params.side,
    type: params.type,
    triggerPrice: params.triggerPrice,
    closePosition: "true",
    workingType: "MARK_PRICE",
    clientAlgoId: params.clientAlgoId,
  });
  const answer = interpret(res, "POST /fapi/v1/algoOrder", stepNumber);
  if (!answer.ok) {
    return { ok: false, clientAlgoId: params.clientAlgoId, error: describeApi(answer) };
  }
  return {
    ok: true,
    clientAlgoId: params.clientAlgoId,
    algoId: answer.body.algoId === undefined ? undefined : String(answer.body.algoId),
  };
}

async function deleteAlgo(clientAlgoId: string, stepNumber: number | "C"): Promise<ApiAnswer> {
  const res = await signedRequest("DELETE", "/fapi/v1/algoOrder", { clientAlgoId });
  return interpret(res, "DELETE /fapi/v1/algoOrder", stepNumber);
}

async function listOpenAlgoOrders(symbol: string): Promise<Record<string, unknown>[]> {
  const res = await signedRequest("GET", "/fapi/v1/openAlgoOrders", { symbol });
  if (res.status !== 200) throw new Error(`GET /fapi/v1/openAlgoOrders → ${res.status}`);
  const body = res.body as unknown;
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  const nested = (body as { orders?: unknown }).orders;
  return Array.isArray(nested) ? nested as Record<string, unknown>[] : [];
}

function hasClientAlgoId(orders: Record<string, unknown>[], clientAlgoId: string): boolean {
  return orders.some((order) => order.clientAlgoId === clientAlgoId);
}

async function waitForAlgoIds(symbol: string, clientAlgoIds: string[], timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const orders = await listOpenAlgoOrders(symbol);
    if (clientAlgoIds.every((id) => hasClientAlgoId(orders, id))) return true;
    await sleep(500);
  }
  return false;
}

async function readPositionAmt(symbol: string): Promise<string | null> {
  const res = await signedRequest("GET", "/fapi/v2/positionRisk", { symbol });
  if (res.status !== 200 || !Array.isArray(res.body)) return null;
  const rows = res.body as Record<string, string>[];
  const row = rows.find((candidate) => candidate.symbol === symbol) ?? rows[0];
  return row?.positionAmt ?? "0";
}

// ─── Step tracking ──────────────────────────────────────────────────────────

interface StepResult { num: number | "C"; name: string; status: string; ms: number; obs: string }
const results: StepResult[] = [];
const errorCodes: { code: number; msg: string; ep: string; step: number | "C" }[] = [];
const touched = new Set<string>();

/** A step's setup failed; the step is recorded FAIL and dependent checks are skipped. */
class StepFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepFailure";
  }
}

function record(num: number | "C", name: string, status: string, ms: number, obs: string): void {
  results.push({ num, name, status, ms, obs });
  const tag = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "○";
  const label = num === "C" ? "Cleanup" : `Step ${num}`;
  console.log(`  [${tag}] ${label} [exchange]: ${name} (${ms}ms) — ${obs}`);
}

async function step(num: number, name: string, fn: () => Promise<string>): Promise<boolean> {
  const start = Date.now();
  try {
    const obs = await fn();
    record(num, name, "PASS", Date.now() - start, obs);
    return true;
  } catch (error) {
    record(num, name, "FAIL", Date.now() - start, errorMessage(error));
    return false;
  }
}

function skip(num: number, name: string, reason: string): false {
  record(num, name, "SKIP", 0, reason);
  return false;
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

interface OpenLeftover {
  symbol: string;
  qty: string;
  side: string;
  kind: "position" | "order" | "algo";
}

interface CleanupResult {
  failures: string[];
  stillOpen: OpenLeftover[];
}

/**
 * Flattens one symbol with the exchange's exact positionAmt decimal string.
 * Testnet occasionally rejects a reduce-only close with -2022 even in one-way
 * mode; that definite rejection is retried once WITHOUT reduceOnly, and only
 * after re-reading the position and confirming it is unchanged.
 */
async function flattenPosition(symbol: string): Promise<string | null> {
  const positionAmt = await readPositionAmt(symbol);
  if (positionAmt === null) throw new Error("positionRisk unreadable before flatten");
  if (isZeroDecimal(positionAmt)) return null;
  const short = positionAmt.trim().startsWith("-");
  const qty = absoluteDecimalString(positionAmt);
  const side = short ? "BUY" : "SELL";

  const closed = await placeMarket(symbol, side, qty, "C", true);
  if (closed.ok) return `${side} ${qty} reduce-only MARKET`;
  if (closed.code !== -2022) throw new Error(`flatten ${side} ${qty} rejected (${describeApi(closed)})`);

  const after = await readPositionAmt(symbol);
  if (after === null || after.trim() !== positionAmt.trim()) {
    throw new Error(
      `position changed after the -2022 rejection; not retrying without reduceOnly (before=${positionAmt}, after=${after ?? "unreadable"})`,
    );
  }
  const retry = await placeMarket(symbol, side, qty, "C", false);
  if (!retry.ok) throw new Error(`flatten retry without reduceOnly rejected (${describeApi(retry)})`);
  return `${side} ${qty} MARKET after -2022 reduce-only rejection (testnet fallback)`;
}

/**
 * Cancels everything the probe touched, flattens positions with the exchange's
 * exact positionAmt string, and then re-reads positionRisk, openOrders and
 * openAlgoOrders for every touched symbol. Nothing is swallowed: cancel and
 * flatten errors are collected and the final verification is authoritative.
 */
async function cleanup(): Promise<CleanupResult> {
  const failures: string[] = [];
  const symbols = [...touched];
  console.log(`\n  Cleanup [${RUN_LABEL}]: canceling orders and flattening ${symbols.length} symbol(s)...`);

  for (const symbol of symbols) {
    try {
      const algoCancel = await signedRequest("DELETE", "/fapi/v1/algoOpenOrders", { symbol });
      if (algoCancel.status !== 200) failures.push(`${symbol}: cancel all Algo orders → status ${algoCancel.status}`);
    } catch (error) {
      failures.push(`${symbol}: cancel all Algo orders threw: ${errorMessage(error)}`);
    }
    try {
      const orderCancel = await signedRequest("DELETE", "/fapi/v1/allOpenOrders", { symbol });
      if (orderCancel.status !== 200) failures.push(`${symbol}: cancel all orders → status ${orderCancel.status}`);
    } catch (error) {
      failures.push(`${symbol}: cancel all orders threw: ${errorMessage(error)}`);
    }
    try {
      const mechanism = await flattenPosition(symbol);
      if (mechanism) console.log(`    Flattened ${symbol}: ${mechanism}`);
    } catch (error) {
      failures.push(`${symbol}: flatten failed: ${errorMessage(error)}`);
    }
  }

  const stillOpen: OpenLeftover[] = [];
  for (const symbol of symbols) {
    try {
      const positionAmt = await readPositionAmt(symbol);
      if (positionAmt === null) {
        failures.push(`${symbol}: positionRisk unreadable during final verification`);
      } else if (!isZeroDecimal(positionAmt)) {
        stillOpen.push({
          symbol,
          qty: absoluteDecimalString(positionAmt),
          side: positionAmt.trim().startsWith("-") ? "short" : "long",
          kind: "position",
        });
      }
    } catch (error) {
      failures.push(`${symbol}: position verification failed: ${errorMessage(error)}`);
    }

    try {
      const res = await signedRequest("GET", "/fapi/v1/openOrders", { symbol });
      if (res.status !== 200 || !Array.isArray(res.body)) {
        failures.push(`${symbol}: openOrders unreadable during final verification (status ${res.status})`);
      } else {
        for (const order of res.body as Record<string, unknown>[]) {
          stillOpen.push({
            symbol,
            qty: String(order.origQty ?? "0"),
            side: String(order.side ?? "?"),
            kind: "order",
          });
        }
      }
    } catch (error) {
      failures.push(`${symbol}: openOrders verification failed: ${errorMessage(error)}`);
    }

    try {
      for (const order of await listOpenAlgoOrders(symbol)) {
        stillOpen.push({
          symbol,
          qty: order.closePosition === true ? "closePosition" : String(order.quantity ?? "0"),
          side: String(order.side ?? "?"),
          kind: "algo",
        });
      }
    } catch (error) {
      failures.push(`${symbol}: openAlgoOrders verification failed: ${errorMessage(error)}`);
    }
  }

  console.log("  Cleanup verification:");
  if (stillOpen.length === 0) console.log("    all flat");
  else for (const item of stillOpen) console.log(`    STILL OPEN: ${item.symbol} ${item.qty} ${item.side} (${item.kind})`);
  for (const failure of failures) console.log(`    CLEANUP ERROR: ${failure}`);

  const clean = stillOpen.length === 0 && failures.length === 0;
  const observation = stillOpen.length === 0
    ? (failures.length === 0 ? `all flat (verified ${symbols.join(", ")})` : `all flat but ${failures.length} cleanup error(s): ${failures.join("; ")}`)
    : `${stillOpen.map((item) => `STILL OPEN: ${item.symbol} ${item.qty} ${item.side} (${item.kind})`).join("; ")}`
      + (failures.length > 0 ? `; cleanup errors: ${failures.join("; ")}` : "");
  record("C", "Final verification", clean ? "PASS" : "FAIL", 0, observation);
  return { failures, stillOpen };
}

// ─── Preflight ──────────────────────────────────────────────────────────────

async function preflight(): Promise<void> {
  console.log("\n═══ PREFLIGHT MODE — EXCHANGE PROBE ═══\n");
  console.log("This probe talks to Binance directly and never starts the MAWS app.");
  console.log(`App-level protection checks live in ${APP_LEVEL_SUITE}.\n`);

  // 1. Hosts
  console.log("1. Demo host connectivity:");
  const t = await publicGet("/fapi/v1/time");
  console.log(`   REST ${DEMO_REST} → ${t.status} (${t.ms}ms)`);

  // 2. Exchange info
  console.log("\n2. Exchange info for BTCUSDT:");
  const f = await readFilters(SYMBOL);
  console.log(`   MIN_NOTIONAL: $${decimalToString(f.minNotional)}`);
  console.log(`   LOT_SIZE: minQty=${decimalToString(f.lotMin)}, stepSize=${decimalToString(f.lotStep)}`);
  console.log(`   MARKET_LOT_SIZE: minQty=${decimalToString(f.mktMin)}, stepSize=${decimalToString(f.mktStep)}`);
  console.log(`   PRICE_FILTER: tickSize=${decimalToString(f.tick)}`);

  const mark = await readMark(SYMBOL);
  console.log(`   Mark price: $${mark}`);

  // 3. Sizing
  console.log("\n3. Order sizing (exact decimal strings):");
  const s = calcQty(f, mark);
  const tp = priceFromPct(mark, 110, f.tick);
  const sl = priceFromPct(mark, 90, f.tick);
  console.log(`   Quantity: ${s.qty} BTC`);
  console.log(`   Notional: $${s.notionalUsd.toFixed(2)} (min $${decimalToString(f.minNotional)}, 1.5x target $${s.targetUsd.toFixed(2)})`);
  console.log(`   TP (mark+10%): $${tp}`);
  console.log(`   SL (mark-10%): $${sl}`);

  // 4. Risk limits
  console.log("\n4. Risk limits (sized from notional):");
  const orderCap = s.notionalUsd * 4;
  const grossCap = s.notionalUsd * 8;
  console.log(`   Max order notional: $${orderCap.toFixed(2)} (4x order notional)`);
  console.log(`   Max gross exposure: $${grossCap.toFixed(2)} (8x order notional)`);
  console.log(`   Max leverage: 10  |  Max margin ratio: 0.5  |  Min liq distance: 5%`);
  console.log(`\n   NOTE: The default Testnet/local order cap of $50 is below BTCUSDT's`);
  console.log(`   minimum notional of $${decimalToString(f.minNotional)}. This probe uses`);
  console.log(`   $${orderCap.toFixed(2)} as the order cap instead.`);

  // 5. Key check (names only)
  console.log("\n5. Credential check (names only — values never printed):");
  const { keyVar, secretVar } = keyVarNames();
  console.log(`   ${keyVar}: ${getKey() ? "present" : "MISSING"}`);
  console.log(`   ${secretVar}: ${getSecret() ? "present" : "MISSING"}`);
  console.log(`   MAWS_BINANCE_PRODUCTION_API_KEY: ${process.env.MAWS_BINANCE_PRODUCTION_API_KEY ? "SET (must be unset!)" : "unset ✓"}`);

  // 6. Steps list
  console.log("\n6. Steps --run will execute (all tagged [exchange]):");
  const steps = [
    "1.  [exchange] Account fields: totalMaintMargin and totalMarginBalance present and numeric",
    "2.  [exchange] Open small long, place TP/SL on the Algo API (CONDITIONAL, triggerPrice, closePosition, MARK_PRICE)",
    "3.  [exchange] Replace TP/SL (±12%): new present, old gone",
    "4.  [exchange] Invalid SL (above mark for long): record Binance's code and message, originals untouched",
    "5.  [exchange] DELETE the TP and confirm it leaves openAlgoOrders (app UNPROTECTED is NOT tested here)",
    "6.  [exchange] Re-protect, close the position via reduce-only REST MARKET, observe which legs Binance removes, reopen and check for stale orders",
    "7.  [exchange] Emergency flatten: position flat, openAlgoOrders empty, zero failures",
    "8.  [exchange] Open a position on both symbols, record margin-field freshness",
    "9.  [exchange] POST /fapi/v1/order STOP_MARKET (legacy endpoint): expect rejection, record code/msg",
    "10. [exchange] Rate-limit / 418 handling: SKIP (cannot exercise live)",
  ];
  for (const st of steps) console.log(`   ${st}`);

  // 7. Signed account check if keys present
  if (hasKeys()) {
    console.log("\n7. Signed read-only account check:");
    try {
      const acct = await signedRequest("GET", "/fapi/v2/account");
      if (acct.status === 200) {
        console.log(`   GET /fapi/v2/account → ${acct.status} (${acct.ms}ms) ✓`);
        const b = acct.body as Record<string, unknown>;
        if (b.totalMaintMargin !== undefined) console.log(`   totalMaintMargin present ✓`);
        if (b.totalMarginBalance !== undefined) console.log(`   totalMarginBalance present ✓`);
      } else {
        console.log(`   GET /fapi/v2/account → ${acct.status} (credentials may be invalid)`);
      }
    } catch (e) { console.log(`   Error: ${errorMessage(e)}`); }
  } else {
    console.log("\n7. No keys present — skipping signed account check");
    console.log("   Set MAWS_BINANCE_TESTNET_API_KEY/SECRET to enable");
  }

  console.log("\n═══ PREFLIGHT COMPLETE ═══\n");
}

// ─── Run mode ───────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log(`\n═══ RUN MODE — ${RUN_LABEL} ═══\n`);
  console.log("No MAWS app is started: these steps probe Binance directly. Protection");
  console.log("status (UNPROTECTED), manager orphan cleanup and margin freshness are");
  console.log(`app-level and are covered by ${APP_LEVEL_SUITE}.\n`);
  if (!hasKeys()) {
    console.log("ERROR: --run requires API credentials. Set MAWS_BINANCE_TESTNET_API_KEY/SECRET.");
    process.exit(1);
  }

  const f = await readFilters(SYMBOL);
  const mark = await readMark(SYMBOL);
  const s = calcQty(f, mark);
  const tp = priceFromPct(mark, 110, f.tick);
  const sl = priceFromPct(mark, 90, f.tick);
  const tp2 = priceFromPct(mark, 112, f.tick);
  const sl2 = priceFromPct(mark, 88, f.tick);
  const rid = crypto.randomBytes(4).toString("hex");
  const ids: { tp: string | null; sl: string | null } = { tp: null, sl: null };

  console.log(`Plan: ${s.qty} ${SYMBOL} @ ~$${mark} = $${s.notionalUsd.toFixed(2)} (exact decimal quantity)`);
  console.log(`TP: ${tp}  SL: ${sl}\n`);

  let cleanupResult: CleanupResult | null = null;

  try {
    // ── Step 1: Account fields ─────────────────────────────────────────────
    await step(1, "Account fields", async () => {
      const acct = await signedRequest("GET", "/fapi/v2/account");
      if (acct.status !== 200) throw new StepFailure(`GET /fapi/v2/account → ${acct.status}`);
      const body = acct.body as Record<string, unknown>;
      const maintenance = body.totalMaintMargin;
      const balance = body.totalMarginBalance;
      if (maintenance === undefined || balance === undefined) {
        throw new StepFailure("totalMaintMargin / totalMarginBalance missing");
      }
      if (!Number.isFinite(Number(maintenance)) || !Number.isFinite(Number(balance))) {
        throw new StepFailure("totalMaintMargin / totalMarginBalance are not numeric");
      }
      return `totalMaintMargin=${String(maintenance)}, totalMarginBalance=${String(balance)}`;
    });

    // ── Step 2: Open long + TP/SL on the Algo API ──────────────────────────
    const opened = await step(2, "Open long + TP/SL (Algo API)", async () => {
      touched.add(SYMBOL);
      const entry = await placeMarket(SYMBOL, "BUY", s.qty, 2);
      if (!entry.ok) throw new StepFailure(`entry rejected: ${describeApi(entry)}`);

      const tpOrder = await placeClosePositionAlgo({
        symbol: SYMBOL, side: "SELL", type: "TAKE_PROFIT_MARKET",
        triggerPrice: tp, clientAlgoId: `smk-tp-${rid}`,
      }, 2);
      if (!tpOrder.ok) throw new StepFailure(`TP placement failed: ${tpOrder.error}`);
      ids.tp = tpOrder.clientAlgoId;

      const slOrder = await placeClosePositionAlgo({
        symbol: SYMBOL, side: "SELL", type: "STOP_MARKET",
        triggerPrice: sl, clientAlgoId: `smk-sl-${rid}`,
      }, 2);
      if (!slOrder.ok) throw new StepFailure(`SL placement failed: ${slOrder.error}`);
      ids.sl = slOrder.clientAlgoId;

      if (!(await waitForAlgoIds(SYMBOL, [`smk-tp-${rid}`, `smk-sl-${rid}`], 15_000))) {
        throw new StepFailure("TP/SL not visible in openAlgoOrders within 15s");
      }
      return "position opened; both Algo legs present (algoType=CONDITIONAL, triggerPrice, closePosition=true, workingType=MARK_PRICE)";
    });

    // ── Step 3: Replace TP/SL (±12%) ───────────────────────────────────────
    const replaced = opened ? await step(3, "Replace TP/SL (±12%)", async () => {
      const oldTp = ids.tp;
      const oldSl = ids.sl;
      if (!oldTp || !oldSl) throw new StepFailure("step 2 did not place both legs");

      const cancelTp = await deleteAlgo(oldTp, 3);
      if (!cancelTp.ok) throw new StepFailure(`cancel old TP failed: ${describeApi(cancelTp)}`);
      const cancelSl = await deleteAlgo(oldSl, 3);
      if (!cancelSl.ok) throw new StepFailure(`cancel old SL failed: ${describeApi(cancelSl)}`);
      ids.tp = null;
      ids.sl = null;

      const newTp = await placeClosePositionAlgo({
        symbol: SYMBOL, side: "SELL", type: "TAKE_PROFIT_MARKET",
        triggerPrice: tp2, clientAlgoId: `smk-tp2-${rid}`,
      }, 3);
      if (!newTp.ok) throw new StepFailure(`new TP placement failed: ${newTp.error}`);
      ids.tp = newTp.clientAlgoId;

      const newSl = await placeClosePositionAlgo({
        symbol: SYMBOL, side: "SELL", type: "STOP_MARKET",
        triggerPrice: sl2, clientAlgoId: `smk-sl2-${rid}`,
      }, 3);
      if (!newSl.ok) throw new StepFailure(`new SL placement failed: ${newSl.error}`);
      ids.sl = newSl.clientAlgoId;

      const orders = await listOpenAlgoOrders(SYMBOL);
      const oldGone = !hasClientAlgoId(orders, oldTp) && !hasClientAlgoId(orders, oldSl);
      const newPresent = hasClientAlgoId(orders, `smk-tp2-${rid}`) && hasClientAlgoId(orders, `smk-sl2-${rid}`);
      if (!oldGone || !newPresent) {
        throw new StepFailure(`oldGone=${oldGone} newPresent=${newPresent}`);
      }
      return "old legs gone, new legs present";
    }) : skip(3, "Replace TP/SL (±12%)", "step 2 failed");

    // ── Step 4: Invalid SL (above mark for long) ───────────────────────────
    const invalidOk = replaced ? await step(4, "Invalid SL rejection (Algo API)", async () => {
      const badSl = priceFromPct(mark, 120, f.tick);
      const res = await signedRequest("POST", "/fapi/v1/algoOrder", {
        algoType: "CONDITIONAL",
        symbol: SYMBOL,
        side: "SELL",
        type: "STOP_MARKET",
        triggerPrice: badSl,
        closePosition: "true",
        workingType: "MARK_PRICE",
        clientAlgoId: `smk-bad-${rid}`,
      });
      const answer = interpret(res, "POST /fapi/v1/algoOrder", 4);
      if (answer.ok) {
        await deleteAlgo(`smk-bad-${rid}`, 4);
        throw new StepFailure("invalid SL was ACCEPTED (expected a rejection)");
      }
      const orders = await listOpenAlgoOrders(SYMBOL);
      const originalsIntact = hasClientAlgoId(orders, `smk-tp2-${rid}`) && hasClientAlgoId(orders, `smk-sl2-${rid}`);
      if (!originalsIntact) {
        throw new StepFailure(`rejected code=${answer.code ?? "?"} msg="${answer.msg ?? ""}" but the original TP/SL are not intact`);
      }
      return `Binance answered code=${answer.code ?? "?"} msg="${answer.msg ?? ""}"; original TP/SL intact`;
    }) : skip(4, "Invalid SL rejection (Algo API)", "step 3 failed");

    // ── Step 5: Cancel TP via REST (exchange visibility only) ──────────────
    const canceled = invalidOk ? await step(5, "Cancel TP via REST (exchange visibility only)", async () => {
      const tpClientAlgoId = `smk-tp2-${rid}`;
      const ack = await deleteAlgo(tpClientAlgoId, 5);
      ids.tp = null;
      if (!ack.ok) throw new StepFailure(`DELETE TP failed: ${describeApi(ack)}`);

      const started = Date.now();
      let gone = false;
      while (Date.now() - started < 20_000) {
        if (!hasClientAlgoId(await listOpenAlgoOrders(SYMBOL), tpClientAlgoId)) { gone = true; break; }
        await sleep(500);
      }
      if (!gone) throw new StepFailure("TP still listed in openAlgoOrders 20s after a confirmed DELETE");
      return `DELETE answered code=${ack.code ?? "200"}; TP absent after ${Date.now() - started}ms. EXCHANGE PROBE only: this step cancels the order itself, so the app's UNPROTECTED flag is NOT checked here (see ${APP_LEVEL_SUITE})`;
    }) : skip(5, "Cancel TP via REST (exchange visibility only)", "step 4 failed");

    // ── Step 6: Re-protect, close, orphan outcome ──────────────────────────
    const reProtected = canceled ? await step(6, "Re-protect, close, orphan outcome", async () => {
      const reProtect = await placeClosePositionAlgo({
        symbol: SYMBOL, side: "SELL", type: "TAKE_PROFIT_MARKET",
        triggerPrice: tp, clientAlgoId: `smk-tp3-${rid}`,
      }, 6);
      if (!reProtect.ok) throw new StepFailure(`re-protect failed: ${reProtect.error}`);
      ids.tp = reProtect.clientAlgoId;

      const close = await placeMarket(SYMBOL, "SELL", s.qty, 6, true);
      if (!close.ok) throw new StepFailure(`reduce-only close rejected: ${describeApi(close)}`);

      const closeStarted = Date.now();
      let cleared = false;
      while (Date.now() - closeStarted < 30_000) {
        if ((await listOpenAlgoOrders(SYMBOL)).length === 0) { cleared = true; break; }
        await sleep(500);
      }
      const clearedInMs = Date.now() - closeStarted;
      let clearing: string;
      if (cleared) {
        clearing = `Algo orders gone ${clearedInMs}ms after the close (Binance auto-cancel observed)`;
      } else {
        // No app is running here, so this is Binance's own behaviour. Leaving
        // the legs open would fail the probe for something the app must handle:
        // record it, cancel them, and continue to the stale-order check.
        const remaining = await listOpenAlgoOrders(SYMBOL);
        const cancelAll = await signedRequest("DELETE", "/fapi/v1/algoOpenOrders", { symbol: SYMBOL });
        if (cancelAll.status !== 200) {
          throw new StepFailure(`NO Binance auto-cancel and manual Algo cancel-all failed with status ${cancelAll.status}`);
        }
        clearing = `NO Binance auto-cancel: app orphan cleanup required (${remaining.length} leg(s) still listed ${clearedInMs}ms after the close; probe canceled them via DELETE /fapi/v1/algoOpenOrders)`;
      }

      const reopened = await placeMarket(SYMBOL, "BUY", s.qty, 6);
      if (!reopened.ok) throw new StepFailure(`new position rejected: ${describeApi(reopened)}`);
      await sleep(1_000);
      const stale = await listOpenAlgoOrders(SYMBOL);
      if (stale.length > 0) {
        throw new StepFailure(`new position inherited ${stale.length} stale Algo order(s): ${stale.map((order) => String(order.clientAlgoId)).join(", ")}`);
      }

      const flatten = await placeMarket(SYMBOL, "SELL", s.qty, 6, true);
      if (!flatten.ok) throw new StepFailure(`new position close rejected: ${describeApi(flatten)}`);
      return `re-protect ok; ${clearing}; new position had 0 stale Algo orders (app-level orphan cleanup is covered by ${APP_LEVEL_SUITE})`;
    }) : skip(6, "Re-protect, close, orphan outcome", "step 5 failed");

    // ── Step 7: Emergency flatten ──────────────────────────────────────────
    await step(7, "Emergency flatten (probe-level)", async () => {
      touched.add(SYMBOL);
      const entry = await placeMarket(SYMBOL, "BUY", s.qty, 7);
      if (!entry.ok) throw new StepFailure(`entry rejected: ${describeApi(entry)}`);

      const tpOrder = await placeClosePositionAlgo({
        symbol: SYMBOL, side: "SELL", type: "TAKE_PROFIT_MARKET",
        triggerPrice: tp, clientAlgoId: `smk-emg-tp-${rid}`,
      }, 7);
      if (!tpOrder.ok) throw new StepFailure(`TP placement failed: ${tpOrder.error}`);

      const slOrder = await placeClosePositionAlgo({
        symbol: SYMBOL, side: "SELL", type: "STOP_MARKET",
        triggerPrice: sl, clientAlgoId: `smk-emg-sl-${rid}`,
      }, 7);
      if (!slOrder.ok) throw new StepFailure(`SL placement failed: ${slOrder.error}`);

      const cancelAlgos = await signedRequest("DELETE", "/fapi/v1/algoOpenOrders", { symbol: SYMBOL });
      if (cancelAlgos.status !== 200) throw new StepFailure(`cancel all Algo orders → ${cancelAlgos.status}`);
      const cancelOrders = await signedRequest("DELETE", "/fapi/v1/allOpenOrders", { symbol: SYMBOL });
      if (cancelOrders.status !== 200) throw new StepFailure(`cancel all orders → ${cancelOrders.status}`);

      const close = await placeMarket(SYMBOL, "SELL", s.qty, 7, true);
      if (!close.ok) throw new StepFailure(`flatten rejected: ${describeApi(close)}`);

      const remaining = await listOpenAlgoOrders(SYMBOL);
      if (remaining.length > 0) throw new StepFailure(`${remaining.length} Algo order(s) remain after cancel-all`);
      const positionAmt = await readPositionAmt(SYMBOL);
      if (positionAmt === null) throw new StepFailure("could not verify the position after flatten");
      if (!isZeroDecimal(positionAmt)) throw new StepFailure(`position still open after flatten: ${positionAmt}`);
      return "position flat, openAlgoOrders empty, zero failures";
    });

    // ── Step 8: Multi-symbol + margin freshness ────────────────────────────
    await step(8, "Multi-symbol + margin freshness", async () => {
      touched.add(SYMBOL);
      touched.add(SECOND_SYMBOL);
      const ethFilters = await readFilters(SECOND_SYMBOL);
      const ethMark = await readMark(SECOND_SYMBOL);
      const ethSize = calcQty(ethFilters, ethMark);

      const btcEntry = await placeMarket(SYMBOL, "BUY", s.qty, 8);
      if (!btcEntry.ok) throw new StepFailure(`BTC entry rejected: ${describeApi(btcEntry)}`);
      const ethEntry = await placeMarket(SECOND_SYMBOL, "BUY", ethSize.qty, 8);
      if (!ethEntry.ok) throw new StepFailure(`ETH entry rejected: ${describeApi(ethEntry)}`);

      const started = Date.now();
      let fresh = false;
      while (Date.now() - started < 10_000) {
        const acct = await signedRequest("GET", "/fapi/v2/account");
        const body = acct.body as Record<string, unknown>;
        if (
          acct.status === 200 &&
          body.totalMaintMargin !== undefined &&
          body.totalMarginBalance !== undefined &&
          Number.isFinite(Number(body.totalMaintMargin)) &&
          Number.isFinite(Number(body.totalMarginBalance))
        ) { fresh = true; break; }
        await sleep(500);
      }
      if (!fresh) throw new StepFailure("margin fields did not become fresh within 10s");

      const closeBtc = await placeMarket(SYMBOL, "SELL", s.qty, 8, true);
      if (!closeBtc.ok) throw new StepFailure(`BTC flatten rejected: ${describeApi(closeBtc)}`);
      const closeEth = await placeMarket(SECOND_SYMBOL, "SELL", ethSize.qty, 8, true);
      if (!closeEth.ok) throw new StepFailure(`ETH flatten rejected: ${describeApi(closeEth)}`);
      return `both entries accepted; margin fields fresh in ${Date.now() - started}ms`;
    });

    // ── Step 9: Legacy endpoint STOP_MARKET ────────────────────────────────
    await step(9, "Legacy /fapi/v1/order STOP_MARKET probe", async () => {
      const stopPrice = priceFromPct(mark, 95, f.tick);
      const res = await signedRequest("POST", "/fapi/v1/order", {
        symbol: SYMBOL,
        side: "SELL",
        type: "STOP_MARKET",
        stopPrice,
        quantity: s.qty,
        reduceOnly: "true",
        clientOrderId: `smk-old-${rid}`,
      });
      const answer = interpret(res, "POST /fapi/v1/order", 9);
      if (answer.ok) {
        await signedRequest("DELETE", "/fapi/v1/order", { symbol: SYMBOL, origClientOrderId: `smk-old-${rid}` });
        throw new StepFailure("legacy endpoint ACCEPTED a conditional order (expected -4120)");
      }
      return `rejected with code=${answer.code ?? "?"} msg="${answer.msg ?? ""}" (expected -4120: conditional orders require the Algo API)`;
    });

    // ── Step 10: Rate-limit / 418 ──────────────────────────────────────────
    record(10, "Rate-limit / 418 handling", "SKIP", 0, "cannot be exercised live without triggering actual rate limits");

    if (reProtected) {
      // Kept only to make the dependency chain explicit in the console output.
      console.log("  [exchange] step 6 completed its re-protect / close / reopen sequence");
    }
  } finally {
    cleanupResult = await cleanup();
  }

  writeReport("run", cleanupResult);
  printIntegrationFollowup();

  const failed = results.filter((result) => result.status === "FAIL");
  if (failed.length > 0 || cleanupResult === null || cleanupResult.stillOpen.length > 0 || cleanupResult.failures.length > 0) {
    if (cleanupResult && cleanupResult.stillOpen.length > 0) {
      console.log(`\n${cleanupResult.stillOpen.length} item(s) STILL OPEN after cleanup`);
    }
    console.log(`\n${failed.length} step(s) FAILED or cleanup incomplete`);
    process.exit(1);
  }
  console.log("\n═══ RUN COMPLETE ═══\n");
}

// ─── Report ─────────────────────────────────────────────────────────────────

function writeReport(mode: string, cleanupResult: CleanupResult | null): void {
  const L: string[] = [];
  L.push("# Testnet Exchange Probe Report");
  L.push("");
  L.push(`**Date:** ${new Date().toISOString()}`);
  L.push(`**Mode:** ${mode}`);
  L.push(`**Kind:** ${RUN_LABEL} — every step below talks to Binance directly and none of them exercises the MAWS app.`);
  L.push(`**Hosts:** ${DEMO_REST} / ${DEMO_WS}`);
  L.push("");
  L.push("App-level checks (protection status, manager orphan cleanup, risk freshness) are not covered here;");
  L.push(`run \`npm run test:integration\` (suite: \`${APP_LEVEL_SUITE}\`).`);
  L.push("");
  L.push("## Results");
  L.push("");
  L.push("| Step | Name | Status | Time (ms) | Observations |");
  L.push("|------|------|--------|-----------|-------------|");
  for (const r of results) L.push(`| ${r.num} | [exchange] ${r.name} | ${r.status} | ${r.ms} | ${r.obs} |`);
  L.push("");
  if (errorCodes.length > 0) {
    L.push("## Binance Error Codes Seen");
    L.push("");
    L.push("| Code | Message | Endpoint | Step |");
    L.push("|------|---------|----------|------|");
    for (const e of errorCodes) L.push(`| ${e.code} | ${e.msg} | ${e.ep} | ${e.step} |`);
    L.push("");
  }
  L.push("## Cleanup");
  L.push("");
  if (cleanupResult === null) {
    L.push("- cleanup did not run");
  } else {
    if (cleanupResult.stillOpen.length === 0) L.push("- all flat");
    else for (const item of cleanupResult.stillOpen) L.push(`- STILL OPEN: ${item.symbol} ${item.qty} ${item.side} (${item.kind})`);
    if (cleanupResult.failures.length > 0) {
      L.push("");
      L.push("Cleanup errors:");
      for (const failure of cleanupResult.failures) L.push(`- ${failure}`);
    }
  }
  L.push("");
  const pass = results.filter(r => r.status === "PASS").length;
  const fail = results.filter(r => r.status === "FAIL").length;
  const skip = results.filter(r => r.status === "SKIP").length;
  L.push("## Summary");
  L.push("");
  L.push(`- PASS: ${pass}`);
  L.push(`- FAIL: ${fail}`);
  L.push(`- SKIP: ${skip}`);
  L.push(`- Total: ${results.length}`);
  L.push("");
  fs.writeFileSync(path.join(process.cwd(), "testnet-smoke-report.md"), L.join("\n"));
  console.log("\nReport written to testnet-smoke-report.md");
}

function printIntegrationFollowup(): void {
  console.log("\nApp-level checks the exchange probe cannot perform:");
  console.log("  npm run test:integration");
  console.log(`  (suite: ${APP_LEVEL_SUITE})`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--selftest")) {
  selftest().catch(e => { console.error("Fatal:", errorMessage(e)); process.exit(1); });
} else {
  // assertTestnetSafety runs before any network call
  runSafetyCheck();

  if (args.includes("--run")) {
    run().catch(async (error) => {
      console.error("Fatal:", errorMessage(error));
      await cleanup().catch((cleanupError) => console.error("Cleanup failed:", errorMessage(cleanupError)));
      printIntegrationFollowup();
      process.exit(1);
    });
  } else {
    preflight().catch(e => { console.error("Fatal:", errorMessage(e)); process.exit(1); });
  }
}
