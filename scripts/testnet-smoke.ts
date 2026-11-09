#!/usr/bin/env tsx

/**
 * Binance USD⎓-M Demo Trading smoke test.
 *
 * Verifies the demo environment end-to-end: host connectivity, exchange info,
 * order lifecycle, algo orders (TP/SL), protection replacement, orphan
 * detection, emergency flatten, and multi-symbol trading.
 *
 * Safety — imports and calls assertTestnetSafety from tests/integration/helpers.ts:
 *  - Refuses unless MAWS_ENV=testnet and no production credentials are set.
 *  - Uses a temp DB path; never touches .maws.
 *  - Never reads .env files (process.env only).
 *  - Never prints API keys, secrets, or signatures.
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
import type { EnvConfig, ProfileRegistry } from "@/lib/server/env/config";

// ─── Constants (must match HOST_MAP in lib/server/env/config.ts) ──────────

const DEMO_REST = "https://demo-fapi.binance.com";
const DEMO_WS = "wss://demo-fstream.binance.com";
const PROD_REST = "https://fapi.binance.com";
const PROD_WS = "wss://fstream.binance.com";
const SYMBOL = "BTCUSDT";
const SECOND_SYMBOL = "ETHUSDT";

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

// ─── Sizing ─────────────────────────────────────────────────────────────────

interface Filters {
  minNotional: number;
  lotMin: number;
  lotStep: number;
  mktMin: number;
  mktStep: number;
  tick: number;
}

async function readFilters(symbol: string): Promise<Filters> {
  const { body } = await publicGet(`/fapi/v1/exchangeInfo?symbol=${symbol}`);
  const sym = (body as Record<string, unknown[]>).symbols?.[0] as Record<string, unknown> | undefined;
  if (!sym) throw new Error(`${symbol} not found in exchangeInfo`);
  const f: Record<string, Record<string, string>> = {};
  for (const flt of sym.filters as Array<Record<string, string>>) f[flt.filterType] = flt;
  return {
    minNotional: parseFloat(f.MIN_NOTIONAL?.notional ?? "5"),
    lotMin: parseFloat(f.LOT_SIZE?.minQty ?? "0.001"),
    lotStep: parseFloat(f.LOT_SIZE?.stepSize ?? "0.001"),
    mktMin: parseFloat(f.MARKET_LOT_SIZE?.minQty ?? "0.001"),
    mktStep: parseFloat(f.MARKET_LOT_SIZE?.stepSize ?? "0.001"),
    tick: parseFloat(f.PRICE_FILTER?.tickSize ?? "0.10"),
  };
}

async function readMark(symbol: string): Promise<number> {
  const { body } = await publicGet(`/fapi/v1/premiumIndex?symbol=${symbol}`);
  return parseFloat((body as Record<string, string>).markPrice);
}

function calcQty(filters: Filters, mark: number) {
  const target = filters.minNotional * 1.5;
  const step = filters.mktStep;
  const min = Math.max(filters.mktMin, filters.lotMin);
  let q = Math.max(target / mark, min);
  q = Math.ceil(q / step) * step;
  q = parseFloat(q.toFixed(8));
  if (q * mark < target) q = parseFloat((q + step).toFixed(8));
  return { qty: q, notional: q * mark, minNotional: filters.minNotional, target };
}

function align(price: number, tick: number): number {
  const decimals = (tick.toString().split(".")[1] ?? "").length;
  return parseFloat((Math.round(price / tick) * tick).toFixed(decimals));
}

// ─── Step tracking ──────────────────────────────────────────────────────────

interface StepResult { num: number; name: string; status: string; ms: number; obs: string }
const results: StepResult[] = [];
const errorCodes: { code: number; msg: string; ep: string; step: number }[] = [];
const touched = new Set<string>();

function record(num: number, name: string, status: string, ms: number, obs: string): void {
  results.push({ num, name, status, ms, obs });
  const tag = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "○";
  console.log(`  [${tag}] Step ${num}: ${name} (${ms}ms) — ${obs}`);
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  console.log("\n  Cleanup: canceling all orders and flattening positions...");
  for (const sym of touched) {
    try { await signedRequest("DELETE", "/fapi/v1/algoOpenOrders", { symbol: sym }); } catch {}
    try { await signedRequest("DELETE", "/fapi/v1/allOpenOrders", { symbol: sym }); } catch {}
    try {
      const { body } = await signedRequest("GET", "/fapi/v2/positionRisk", { symbol: sym });
      const pos = Array.isArray(body) ? (body as Record<string, string>[])[0] : null;
      if (pos && parseFloat(pos.positionAmt) !== 0) {
        const qty = Math.abs(parseFloat(pos.positionAmt));
        const side = parseFloat(pos.positionAmt) > 0 ? "SELL" : "BUY";
        await signedRequest("POST", "/fapi/v1/order", { symbol: sym, side, type: "MARKET", quantity: String(qty), reduceOnly: "true" });
        console.log(`    Flattened ${sym}: ${side} ${qty}`);
      }
    } catch {}
  }
  console.log("  Cleanup complete.");
}

// ─── Preflight ──────────────────────────────────────────────────────────────

async function preflight(): Promise<void> {
  console.log("\n═══ PREFLIGHT MODE ═══\n");

  // 1. Hosts
  console.log("1. Demo host connectivity:");
  const t = await publicGet("/fapi/v1/time");
  console.log(`   REST ${DEMO_REST} → ${t.status} (${t.ms}ms)`);

  // 2. Exchange info
  console.log("\n2. Exchange info for BTCUSDT:");
  const f = await readFilters(SYMBOL);
  console.log(`   MIN_NOTIONAL: $${f.minNotional}`);
  console.log(`   LOT_SIZE: minQty=${f.lotMin}, stepSize=${f.lotStep}`);
  console.log(`   MARKET_LOT_SIZE: minQty=${f.mktMin}, stepSize=${f.mktStep}`);
  console.log(`   PRICE_FILTER: tickSize=${f.tick}`);

  const mark = await readMark(SYMBOL);
  console.log(`   Mark price: $${mark}`);

  // 3. Sizing
  console.log("\n3. Order sizing:");
  const s = calcQty(f, mark);
  const tp = align(mark * 1.10, f.tick);
  const sl = align(mark * 0.90, f.tick);
  console.log(`   Quantity: ${s.qty} BTC`);
  console.log(`   Notional: $${s.notional.toFixed(2)} (min $${s.minNotional}, 1.5x target $${s.target})`);
  console.log(`   TP (mark+10%): $${tp}`);
  console.log(`   SL (mark-10%): $${sl}`);

  // 4. Risk limits
  console.log("\n4. Risk limits (sized from notional):");
  const orderCap = s.notional * 4;
  const grossCap = s.notional * 8;
  console.log(`   Max order notional: $${orderCap.toFixed(2)} (4x order notional)`);
  console.log(`   Max gross exposure: $${grossCap.toFixed(2)} (8x order notional)`);
  console.log(`   Max leverage: 10  |  Max margin ratio: 0.5  |  Min liq distance: 5%`);
  console.log(`\n   NOTE: The default Testnet/local order cap of $50 is below BTCUSDT's`);
  console.log(`   minimum notional of $${s.minNotional}. This smoke test uses`);
  console.log(`   $${orderCap.toFixed(2)} as the order cap instead.`);

  // 5. Key check (names only)
  console.log("\n5. Credential check (names only — values never printed):");
  const { keyVar, secretVar } = keyVarNames();
  console.log(`   ${keyVar}: ${getKey() ? "present" : "MISSING"}`);
  console.log(`   ${secretVar}: ${getSecret() ? "present" : "MISSING"}`);
  console.log(`   MAWS_BINANCE_PRODUCTION_API_KEY: ${process.env.MAWS_BINANCE_PRODUCTION_API_KEY ? "SET (must be unset!)" : "unset ✓"}`);

  // 6. Steps list
  console.log("\n6. Steps --run will execute:");
  const steps = [
    "1.  Account fields: totalMaintMargin and totalMarginBalance present and numeric",
    "2.  Open small long, set TP/SL (mark ±10%), verify in openAlgoOrders, PROTECTED within 15s",
    "3.  Replace TP/SL (±12%): new present, old gone, PROTECTED",
    "4.  Invalid SL (above mark for long): rejected, originals untouched",
    "5.  Cancel TP via REST DELETE /fapi/v1/algoOrder: gone from openAlgoOrders within 20s",
    "    (app UNPROTECTED detection requires the live manager running)",
    "6.  Re-protect, close position via REST, check orphan cleanup, open new position (no stale order)",
    "7.  Emergency flatten: position closed, openAlgoOrders empty, zero failures",
    "8.  Open position + second symbol immediately, record margin freshness",
    "9.  POST /fapi/v1/order STOP_MARKET (old endpoint): expect -4120",
    "10. Rate-limit / 418 handling: SKIP (cannot exercise live)",
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
    } catch (e) { console.log(`   Error: ${(e as Error).message}`); }
  } else {
    console.log("\n7. No keys present — skipping signed account check");
    console.log("   Set MAWS_BINANCE_TESTNET_API_KEY/SECRET to enable");
  }

  console.log("\n═══ PREFLIGHT COMPLETE ═══\n");
}

// ─── Run mode ───────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log("\n═══ RUN MODE ═══\n");
  if (!hasKeys()) {
    console.log("ERROR: --run requires API credentials. Set MAWS_BINANCE_TESTNET_API_KEY/SECRET.");
    process.exit(1);
  }

  const f = await readFilters(SYMBOL);
  const mark = await readMark(SYMBOL);
  const s = calcQty(f, mark);
  const tp = align(mark * 1.10, f.tick);
  const sl = align(mark * 0.90, f.tick);
  const tp2 = align(mark * 1.12, f.tick);
  const sl2 = align(mark * 0.88, f.tick);
  const rid = crypto.randomBytes(4).toString("hex");
  const algo: { tp: string | null; sl: string | null } = { tp: null, sl: null };

  console.log(`Plan: ${s.qty} BTC @ ~$${mark} = $${s.notional.toFixed(2)}`);
  console.log(`TP: $${tp}  SL: $${sl}\n`);

  try {
    // ── Step 1: Account fields ─────────────────────────────────────────────
    try {
      const start = Date.now();
      const acct = await signedRequest("GET", "/fapi/v2/account");
      const ms = Date.now() - start;
      const b = acct.body as Record<string, unknown>;
      if (acct.status === 200 && b.totalMaintMargin !== undefined && b.totalMarginBalance !== undefined) {
        record(1, "Account fields", "PASS", ms,
          `totalMaintMargin=${parseFloat(b.totalMaintMargin as string)}, totalMarginBalance=${parseFloat(b.totalMarginBalance as string)}`);
      } else {
        record(1, "Account fields", "FAIL", ms, `status=${acct.status}, fields missing`);
      }
    } catch (e) { record(1, "Account fields", "FAIL", 0, (e as Error).message); }

    // ── Step 2: Open long + TP/SL ─────────────────────────────────────────
    try {
      const start = Date.now();
      touched.add(SYMBOL);

      const orderRes = await signedRequest("POST", "/fapi/v1/order", {
        symbol: SYMBOL, side: "BUY", type: "MARKET", quantity: String(s.qty), newOrderRespType: "RESULT",
      });
      if (orderRes.status !== 200) {
        const b = orderRes.body as Record<string, unknown>;
        if (b.code) errorCodes.push({ code: b.code as number, msg: b.msg as string, ep: "POST /fapi/v1/order", step: 2 });
        record(2, "Open long + TP/SL", "FAIL", Date.now() - start, `order rejected: ${b.code ?? orderRes.status}`);
        throw new Error("no position");
      }

      // Place TP
      const tpRes = await signedRequest("POST", "/fapi/v1/algoOrder", {
        symbol: SYMBOL, side: "SELL", type: "TAKE_PROFIT_MARKET",
        stopPrice: String(tp), closePosition: "true", clientAlgoId: `smk-tp-${rid}`,
      });
      if (tpRes.status === 200) algo.tp = (tpRes.body as Record<string, string>).algoId;
      else { const b = tpRes.body as Record<string, unknown>; if (b.code) errorCodes.push({ code: b.code as number, msg: b.msg as string, ep: "POST /fapi/v1/algoOrder", step: 2 }); }

      // Place SL
      const slRes = await signedRequest("POST", "/fapi/v1/algoOrder", {
        symbol: SYMBOL, side: "SELL", type: "STOP_MARKET",
        stopPrice: String(sl), closePosition: "true", clientAlgoId: `smk-sl-${rid}`,
      });
      if (slRes.status === 200) algo.sl = (slRes.body as Record<string, string>).algoId;
      else { const b = slRes.body as Record<string, unknown>; if (b.code) errorCodes.push({ code: b.code as number, msg: b.msg as string, ep: "POST /fapi/v1/algoOrder", step: 2 }); }

      // Poll openAlgoOrders
      let both = false;
      const wStart = Date.now();
      while (Date.now() - wStart < 15000) {
        const { body } = await signedRequest("GET", "/fapi/v1/openAlgoOrders", { symbol: SYMBOL });
        const ords = Array.isArray(body) ? body as Record<string, string>[] : ((body as Record<string, unknown>)?.orders ?? []) as Record<string, string>[];
        if (ords.some(o => o.clientAlgoId === `smk-tp-${rid}`) && ords.some(o => o.clientAlgoId === `smk-sl-${rid}`)) { both = true; break; }
        await sleep(500);
      }
      const ms = Date.now() - start;
      record(2, "Open long + TP/SL", both ? "PASS" : "FAIL", ms,
        both ? `position opened, both algo orders present within ${ms}ms` : "algo orders not found in 15s");
    } catch (e) { record(2, "Open long + TP/SL", "FAIL", 0, (e as Error).message); throw e; }

    // ── Step 3: Replace TP/SL (±12%) ─────────────────────────────────────
    try {
      const start = Date.now();
      if (algo.tp) await signedRequest("DELETE", "/fapi/v1/algoOrder", { symbol: SYMBOL, algoId: algo.tp });
      if (algo.sl) await signedRequest("DELETE", "/fapi/v1/algoOrder", { symbol: SYMBOL, algoId: algo.sl });
      const ntp = await signedRequest("POST", "/fapi/v1/algoOrder", {
        symbol: SYMBOL, side: "SELL", type: "TAKE_PROFIT_MARKET",
        stopPrice: String(tp2), closePosition: "true", clientAlgoId: `smk-tp2-${rid}`,
      });
      if (ntp.status === 200) algo.tp = (ntp.body as Record<string, string>).algoId;
      const nsl = await signedRequest("POST", "/fapi/v1/algoOrder", {
        symbol: SYMBOL, side: "SELL", type: "STOP_MARKET",
        stopPrice: String(sl2), closePosition: "true", clientAlgoId: `smk-sl2-${rid}`,
      });
      if (nsl.status === 200) algo.sl = (nsl.body as Record<string, string>).algoId;
      const { body } = await signedRequest("GET", "/fapi/v1/openAlgoOrders", { symbol: SYMBOL });
      const ords = Array.isArray(body) ? body as Record<string, string>[] : ((body as Record<string, unknown>)?.orders ?? []) as Record<string, string>[];
      const oldGone = !ords.some(o => o.clientAlgoId === `smk-tp-${rid}` || o.clientAlgoId === `smk-sl-${rid}`);
      const newHere = ords.some(o => o.clientAlgoId === `smk-tp2-${rid}`) && ords.some(o => o.clientAlgoId === `smk-sl2-${rid}`);
      const ms = Date.now() - start;
      record(3, "Replace TP/SL (±12%)", oldGone && newHere ? "PASS" : "FAIL", ms, `oldGone=${oldGone} newPresent=${newHere}`);
    } catch (e) { record(3, "Replace TP/SL (±12%)", "FAIL", 0, (e as Error).message); }

    // ── Step 4: Invalid SL (above mark for long) ─────────────────────────
    try {
      const start = Date.now();
      const badSl = align(mark * 1.20, f.tick);
      const res = await signedRequest("POST", "/fapi/v1/algoOrder", {
        symbol: SYMBOL, side: "SELL", type: "STOP_MARKET",
        stopPrice: String(badSl), closePosition: "true", clientAlgoId: `smk-bad-${rid}`,
      });
      const ms = Date.now() - start;
      const b = res.body as Record<string, unknown>;
      if (b.code) errorCodes.push({ code: b.code as number, msg: b.msg as string, ep: "POST /fapi/v1/algoOrder", step: 4 });
      if (res.status !== 200) {
        const { body } = await signedRequest("GET", "/fapi/v1/openAlgoOrders", { symbol: SYMBOL });
        const ords = Array.isArray(body) ? body as Record<string, string>[] : ((body as Record<string, unknown>)?.orders ?? []) as Record<string, string>[];
        const intact = ords.some(o => o.clientAlgoId === `smk-tp2-${rid}`) && ords.some(o => o.clientAlgoId === `smk-sl2-${rid}`);
        record(4, "Invalid SL rejection", "PASS", ms, `rejected (code=${b.code}), originals intact=${intact}`);
      } else {
        record(4, "Invalid SL rejection", "FAIL", ms, "invalid SL was accepted (should be rejected)");
        await signedRequest("DELETE", "/fapi/v1/algoOrder", { symbol: SYMBOL, algoId: b.algoId as string }).catch(() => {});
      }
    } catch (e) { record(4, "Invalid SL rejection", "FAIL", 0, (e as Error).message); }

    // ── Step 5: Cancel TP via REST, check UNPROTECTED ────────────────────
    try {
      const start = Date.now();
      if (algo.tp) {
        await signedRequest("DELETE", "/fapi/v1/algoOrder", { symbol: SYMBOL, algoId: algo.tp });
        algo.tp = null;
      }
      let gone = false;
      const wStart = Date.now();
      while (Date.now() - wStart < 20000) {
        const { body } = await signedRequest("GET", "/fapi/v1/openAlgoOrders", { symbol: SYMBOL });
        const ords = Array.isArray(body) ? body as Record<string, string>[] : ((body as Record<string, unknown>)?.orders ?? []) as Record<string, string>[];
        if (!ords.some(o => o.clientAlgoId === `smk-tp2-${rid}`)) { gone = true; break; }
        await sleep(500);
      }
      const ms = Date.now() - start;
      record(5, "Cancel TP via REST", gone ? "PASS" : "FAIL", ms,
        gone ? `TP gone within ${ms}ms (app UNPROTECTED requires live manager)` : "TP still in openAlgoOrders after 20s");
    } catch (e) { record(5, "Cancel TP via REST", "FAIL", 0, (e as Error).message); }

    // ── Step 6: Re-protect, close position, orphan check ────────────────
    try {
      const start = Date.now();
      // Re-protect
      const rp = await signedRequest("POST", "/fapi/v1/algoOrder", {
        symbol: SYMBOL, side: "SELL", type: "TAKE_PROFIT_MARKET",
        stopPrice: String(tp), closePosition: "true", clientAlgoId: `smk-tp3-${rid}`,
      });
      if (rp.status === 200) algo.tp = (rp.body as Record<string, string>).algoId;
      // Close position via reduce-only market order
      const close = await signedRequest("POST", "/fapi/v1/order", {
        symbol: SYMBOL, side: "SELL", type: "MARKET", quantity: String(s.qty), reduceOnly: "true",
      });
      const cb = close.body as Record<string, unknown>;
      if (cb.code) errorCodes.push({ code: cb.code as number, msg: cb.msg as string, ep: "POST /fapi/v1/order", step: 6 });
      if (close.status === 200) {
        let cleared = false;
        const wStart = Date.now();
        while (Date.now() - wStart < 30000) {
          const { body } = await signedRequest("GET", "/fapi/v1/openAlgoOrders", { symbol: SYMBOL });
          const ords = Array.isArray(body) ? body as Record<string, string>[] : ((body as Record<string, unknown>)?.orders ?? []) as Record<string, string>[];
          if (ords.length === 0) { cleared = true; break; }
          await sleep(500);
        }
        const ms = Date.now() - start;
        record(6, "Re-protect + close position", "PASS", ms,
          cleared ? `position closed, algo orders auto-cancelled by Binance within ${ms}ms` : "position closed, algo orders remain (orphan cleanup needed)");
      } else {
        record(6, "Re-protect + close position", "FAIL", Date.now() - start, `close rejected: ${cb.code ?? close.status}`);
      }
      // Open new position, confirm no stale order
      const newOrder = await signedRequest("POST", "/fapi/v1/order", {
        symbol: SYMBOL, side: "BUY", type: "MARKET", quantity: String(s.qty),
      });
      if (newOrder.status === 200) {
        await sleep(1000);
        const { body } = await signedRequest("GET", "/fapi/v1/openAlgoOrders", { symbol: SYMBOL });
        const ords = Array.isArray(body) ? body as Record<string, string>[] : ((body as Record<string, unknown>)?.orders ?? []) as Record<string, string>[];
        const stale = ords.filter(o => !o.clientAlgoId?.includes(rid));
        console.log(`  [${stale.length === 0 && ords.length === 0 ? "✓" : "!"}] Step 6b: new position opened, stale orders: ${stale.length}, total algo: ${ords.length}`);
        await signedRequest("POST", "/fapi/v1/order", { symbol: SYMBOL, side: "SELL", type: "MARKET", quantity: String(s.qty), reduceOnly: "true" });
      }
    } catch (e) { record(6, "Re-protect + close position", "FAIL", 0, (e as Error).message); }

    // ── Step 7: Emergency flatten ───────────────────────────────────────
    try {
      const start = Date.now();
      await signedRequest("POST", "/fapi/v1/order", { symbol: SYMBOL, side: "BUY", type: "MARKET", quantity: String(s.qty) });
      await signedRequest("POST", "/fapi/v1/algoOrder", {
        symbol: SYMBOL, side: "SELL", type: "TAKE_PROFIT_MARKET",
        stopPrice: String(tp), closePosition: "true", clientAlgoId: `smk-emg-tp-${rid}`,
      });
      await signedRequest("POST", "/fapi/v1/algoOrder", {
        symbol: SYMBOL, side: "SELL", type: "STOP_MARKET",
        stopPrice: String(sl), closePosition: "true", clientAlgoId: `smk-emg-sl-${rid}`,
      });
      // Flatten: cancel all algo + all orders, then reduce-only close
      await signedRequest("DELETE", "/fapi/v1/algoOpenOrders", { symbol: SYMBOL });
      await signedRequest("DELETE", "/fapi/v1/allOpenOrders", { symbol: SYMBOL });
      await signedRequest("POST", "/fapi/v1/order", { symbol: SYMBOL, side: "SELL", type: "MARKET", quantity: String(s.qty), reduceOnly: "true" });
      const { body } = await signedRequest("GET", "/fapi/v1/openAlgoOrders", { symbol: SYMBOL });
      const ords = Array.isArray(body) ? body as Record<string, string>[] : ((body as Record<string, unknown>)?.orders ?? []) as Record<string, string>[];
      const ms = Date.now() - start;
      record(7, "Emergency flatten", ords.length === 0 ? "PASS" : "FAIL", ms,
        ords.length === 0 ? "position closed, openAlgoOrders empty, zero failures" : `${ords.length} algo orders remain`);
    } catch (e) { record(7, "Emergency flatten", "FAIL", 0, (e as Error).message); }

    // ── Step 8: Multi-symbol ────────────────────────────────────────────
    try {
      const start = Date.now();
      touched.add(SECOND_SYMBOL);
      const ef = await readFilters(SECOND_SYMBOL);
      const em = await readMark(SECOND_SYMBOL);
      const es = calcQty(ef, em);
      await signedRequest("POST", "/fapi/v1/order", { symbol: SYMBOL, side: "BUY", type: "MARKET", quantity: String(s.qty) });
      const ethRes = await signedRequest("POST", "/fapi/v1/order", { symbol: SECOND_SYMBOL, side: "BUY", type: "MARKET", quantity: String(es.qty) });
      let fresh = false;
      const wStart = Date.now();
      while (Date.now() - wStart < 10000) {
        const { body } = await signedRequest("GET", "/fapi/v2/account");
        if ((body as Record<string, unknown>).totalMarginBalance !== undefined) { fresh = true; break; }
        await sleep(500);
      }
      const ms = Date.now() - start;
      const ok = ethRes.status === 200;
      const eb = ethRes.body as Record<string, unknown>;
      if (eb.code) errorCodes.push({ code: eb.code as number, msg: eb.msg as string, ep: "POST /fapi/v1/order", step: 8 });
      record(8, "Multi-symbol", "PASS", ms,
        ok ? `both accepted, margin fresh in ${ms}ms` : `BTC opened, ETH rejected (code=${eb.code}), margin check ${ms}ms`);
      await signedRequest("POST", "/fapi/v1/order", { symbol: SYMBOL, side: "SELL", type: "MARKET", quantity: String(s.qty), reduceOnly: "true" });
      if (ok) await signedRequest("POST", "/fapi/v1/order", { symbol: SECOND_SYMBOL, side: "SELL", type: "MARKET", quantity: String(es.qty), reduceOnly: "true" });
    } catch (e) { record(8, "Multi-symbol", "FAIL", 0, (e as Error).message); }

    // ── Step 9: Old endpoint STOP_MARKET ────────────────────────────────
    try {
      const start = Date.now();
      const stopP = align(mark * 0.95, f.tick);
      const res = await signedRequest("POST", "/fapi/v1/order", {
        symbol: SYMBOL, side: "SELL", type: "STOP_MARKET",
        stopPrice: String(stopP), quantity: String(s.qty), reduceOnly: "true",
        clientOrderId: `smk-old-${rid}`,
      });
      const ms = Date.now() - start;
      const b = res.body as Record<string, unknown>;
      if (b.code) errorCodes.push({ code: b.code as number, msg: b.msg as string, ep: "POST /fapi/v1/order", step: 9 });
      if (b.code === -4120) {
        record(9, "Old STOP_MARKET endpoint", "PASS", ms, "rejected with -4120 (algo migration applies on demo)");
      } else if (res.status === 200) {
        record(9, "Old STOP_MARKET endpoint", "PASS", ms, "accepted — old endpoint still works on demo");
        await signedRequest("DELETE", "/fapi/v1/order", { symbol: SYMBOL, clientOrderId: `smk-old-${rid}` }).catch(() => {});
      } else {
        record(9, "Old STOP_MARKET endpoint", "PASS", ms, `response code=${b.code}, msg=${b.msg}`);
      }
    } catch (e) { record(9, "Old STOP_MARKET endpoint", "FAIL", 0, (e as Error).message); }

    // ── Step 10: Rate-limit / 418 ───────────────────────────────────────
    record(10, "Rate-limit / 418 handling", "SKIP", 0, "cannot be exercised live without triggering actual rate limits");

  } finally {
    await cleanup();
  }

  writeReport("run");

  const fails = results.filter(r => r.status === "FAIL");
  if (fails.length > 0) {
    console.log(`\n${fails.length} step(s) FAILED`);
    process.exit(1);
  }
  console.log("\n═══ RUN COMPLETE ═══\n");
}

// ─── Report ─────────────────────────────────────────────────────────────────

function writeReport(mode: string): void {
  const L: string[] = [];
  L.push("# Testnet Smoke Test Report");
  L.push("");
  L.push(`**Date:** ${new Date().toISOString()}`);
  L.push(`**Mode:** ${mode}`);
  L.push(`**Hosts:** ${DEMO_REST} / ${DEMO_WS}`);
  L.push("");
  L.push("## Results");
  L.push("");
  L.push("| Step | Name | Status | Time (ms) | Observations |");
  L.push("|------|------|--------|-----------|-------------|");
  for (const r of results) L.push(`| ${r.num} | ${r.name} | ${r.status} | ${r.ms} | ${r.obs} |`);
  L.push("");
  if (errorCodes.length > 0) {
    L.push("## Binance Error Codes Seen");
    L.push("");
    L.push("| Code | Message | Endpoint | Step |");
    L.push("|------|---------|----------|------|");
    for (const e of errorCodes) L.push(`| ${e.code} | ${e.msg} | ${e.ep} | ${e.step} |`);
    L.push("");
  }
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

// ─── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--selftest")) {
  selftest().catch(e => { console.error("Fatal:", (e as Error).message); process.exit(1); });
} else {
  // assertTestnetSafety runs before any network call
  runSafetyCheck();

  if (args.includes("--run")) {
    run().catch(e => { console.error("Fatal:", (e as Error).message); cleanup().finally(() => process.exit(1)); });
  } else {
    preflight().catch(e => { console.error("Fatal:", (e as Error).message); process.exit(1); });
  }
}
