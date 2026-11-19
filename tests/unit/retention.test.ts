/**
 * Retention (D): batched deletion of old processed events and audit rows.
 *
 * The safety property under test is what is NOT deleted: unprocessed events
 * are obligations, and intents, fills, income and protection rows are trading
 * history. Only `order_events.processed = 1` rows older than the window and
 * `audit_log` rows older than its window go.
 */

import { beforeEach, describe, expect, test } from "@jest/globals";

import { getDb } from "@/lib/server/db/connection";
import { runRetentionPass, RETENTION_DEFAULTS } from "@/lib/server/db/retention";
import { databaseStats, resetDatabaseStatsForTests } from "@/lib/server/db/stats";
import { persistenceProfileFromConfig } from "@/lib/server/profile/context";
import { freshEnv, makeCfg } from "../live-tests/helpers";

const DAY = 24 * 60 * 60 * 1000;
let profileId: string;

function insertEvent(ts: number, processed: 0 | 1): void {
  getDb()
    .prepare(
      `INSERT INTO order_events (profile_id, ts, event_time, source, event_type, payload, processed)
       VALUES (?, ?, ?, 'stream', 'ORDER_TRADE_UPDATE', '{}', ?)`,
    )
    .run(profileId, ts, ts, processed);
}

function insertAudit(ts: number): void {
  getDb()
    .prepare(`INSERT INTO audit_log (profile_id, ts, actor, action, detail, ip) VALUES (?, ?, 'operator', 'test', '{}', NULL)`)
    .run(profileId, ts);
}

function insertIntent(ts: number): void {
  getDb()
    .prepare(
      `INSERT INTO order_intents (profile_id, client_order_id, kind, symbol, side, type, qty, status, created_at, updated_at)
       VALUES (?, ?, 'order', 'BTCUSDT', 'BUY', 'LIMIT', '0.01', 'FILLED', ?, ?)`,
    )
    .run(profileId, `cid-${ts}-${Math.random()}`, ts, ts);
}

function insertFill(ts: number): void {
  getDb()
    .prepare(
      `INSERT INTO fills_log (profile_id, ts, trade_id, symbol, side, qty, price, source)
       VALUES (?, ?, NULL, 'BTCUSDT', 'BUY', '0.01', '50000', 'stream')`,
    )
    .run(profileId, ts);
}

function insertIncome(ts: number): void {
  getDb()
    .prepare(
      `INSERT INTO account_income (profile_id, income_id, ts, income_type, symbol, amount, asset, source)
       VALUES (?, ?, ?, 'COMMISSION', 'BTCUSDT', '-0.1', 'USDT', 'rest')`,
    )
    .run(profileId, `inc-${ts}-${Math.random()}`, ts);
}

function insertProtection(ts: number): void {
  getDb()
    .prepare(
      `INSERT INTO protection_intents (profile_id, symbol, side, tp_price, sl_price, updated_at, status)
       VALUES (?, ?, 'long', '60000', '40000', ?, 'PROTECTED')`,
    )
    .run(profileId, `SYM${ts}`, ts);
}

beforeEach(() => {
  freshEnv(makeCfg());
  resetDatabaseStatsForTests();
  profileId = persistenceProfileFromConfig(makeCfg()).id;
});

describe("runRetentionPass", () => {
  test("deletes only old processed events and old audit rows", () => {
    const now = Date.now();
    insertEvent(now - 15 * DAY, 1); // old + processed → deleted
    insertEvent(now - 13 * DAY, 1); // inside window → kept
    insertEvent(now - 15 * DAY, 0); // old but unprocessed → kept
    insertAudit(now - 181 * DAY); // old → deleted
    insertAudit(now - 179 * DAY); // kept

    const result = runRetentionPass({ now });
    expect(result.orderEventsDeleted).toBe(1);
    expect(result.auditLogDeleted).toBe(1);
    expect(result.stoppedBy).toBe("empty");

    const rows = getDb().prepare(`SELECT processed, ts FROM order_events ORDER BY ts`).all() as Array<{
      processed: number;
      ts: number;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.processed === 0 && row.ts === now - 15 * DAY)).toBe(true);
    expect(rows.some((row) => row.ts === now - 13 * DAY)).toBe(true);
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number }).n).toBe(1);
  });

  test("never deletes intents, fills, income or protection history", () => {
    const now = Date.now();
    insertIntent(now - 400 * DAY);
    insertFill(now - 400 * DAY);
    insertIncome(now - 400 * DAY);
    insertProtection(now - 400 * DAY);
    insertEvent(now - 30 * DAY, 1);

    runRetentionPass({ now, orderEventsDays: 1 });

    const count = (table: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count("order_intents")).toBe(1);
    expect(count("fills_log")).toBe(1);
    expect(count("account_income")).toBe(1);
    expect(count("protection_intents")).toBe(1);
    expect(count("order_events")).toBe(0);
  });

  test("drains in batches instead of one unbounded delete", () => {
    const now = Date.now();
    for (let i = 0; i < 1_200; i += 1) insertEvent(now - 20 * DAY, 1);

    const result = runRetentionPass({ now, batchSize: 500, timeBudgetMs: 60_000 });
    expect(result.orderEventsDeleted).toBe(1_200);
    expect(result.batches).toBe(4); // 500 + 500 + 200 + empty probe
    expect(result.stoppedBy).toBe("empty");
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM order_events`).get() as { n: number }).n).toBe(0);
  });

  test("honours the day overrides", () => {
    const now = Date.now();
    insertEvent(now - 3 * DAY, 1);
    expect(runRetentionPass({ now, orderEventsDays: RETENTION_DEFAULTS.orderEventsDays }).orderEventsDeleted).toBe(0);
    expect(runRetentionPass({ now, orderEventsDays: 1 }).orderEventsDeleted).toBe(1);
  });
});

describe("databaseStats", () => {
  test("reports row counts and a size warning above the configured limit", () => {
    insertEvent(Date.now(), 1);
    insertEvent(Date.now(), 0);
    insertAudit(Date.now());

    const stats = databaseStats(Date.now());
    expect(stats.rowCounts.orderEvents).toBe(2);
    expect(stats.rowCounts.unprocessedOrderEvents).toBe(1);
    expect(stats.rowCounts.auditLog).toBe(1);
    expect(stats.totalBytes).toBeGreaterThan(0);
    // makeCfg uses the 2 GiB default, so a temp DB is far below it.
    expect(stats.sizeWarning).toBe(false);

    resetDatabaseStatsForTests();
    freshEnv(makeCfg({ dbSizeWarnBytes: 1 }));
    expect(databaseStats(Date.now()).sizeWarning).toBe(true);
  });
});
