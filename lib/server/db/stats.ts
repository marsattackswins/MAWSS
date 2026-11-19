import "server-only";

import fs from "node:fs";

import { serverConfig } from "../env/config";
import { getDb } from "./connection";

/**
 * Database size and row counts for health.
 *
 * Counting rows on every health read would be wasteful (health is rebuilt on
 * each SSE event), so the snapshot is cached for a minute. The size includes
 * the WAL, because that is what actually occupies disk between checkpoints.
 */

const CACHE_MS = 60_000;

export interface DbStats {
  sizeBytes: number;
  walBytes: number;
  totalBytes: number;
  warningBytes: number;
  /** True when the database exceeds the configured warning size. */
  sizeWarning: boolean;
  rowCounts: {
    orderEvents: number;
    unprocessedOrderEvents: number;
    auditLog: number;
    orderIntents: number;
    fills: number;
    income: number;
    protectionIntents: number;
    reconciliationRuns: number;
  };
  sampledAt: number;
}

let cached: DbStats | null = null;

function fileSize(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}

function count(sql: string): number {
  try {
    const row = getDb().prepare(sql).get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

export function databaseStats(now = Date.now()): DbStats {
  if (cached && now - cached.sampledAt < CACHE_MS) return cached;
  const cfg = serverConfig();
  const sizeBytes = fileSize(cfg.dbPath);
  const walBytes = fileSize(`${cfg.dbPath}-wal`);
  const totalBytes = sizeBytes + walBytes;
  const warningBytes = cfg.dbSizeWarnBytes;
  const stats: DbStats = {
    sizeBytes,
    walBytes,
    totalBytes,
    warningBytes,
    sizeWarning: totalBytes > warningBytes,
    rowCounts: {
      orderEvents: count("SELECT COUNT(*) AS n FROM order_events"),
      unprocessedOrderEvents: count("SELECT COUNT(*) AS n FROM order_events WHERE processed = 0"),
      auditLog: count("SELECT COUNT(*) AS n FROM audit_log"),
      orderIntents: count("SELECT COUNT(*) AS n FROM order_intents"),
      fills: count("SELECT COUNT(*) AS n FROM fills_log"),
      income: count("SELECT COUNT(*) AS n FROM account_income"),
      protectionIntents: count("SELECT COUNT(*) AS n FROM protection_intents"),
      reconciliationRuns: count("SELECT COUNT(*) AS n FROM reconciliation_runs"),
    },
    sampledAt: now,
  };
  cached = stats;
  return stats;
}

export function resetDatabaseStatsForTests(): void {
  cached = null;
}
