import "server-only";

import { getDb } from "./connection";
import { log } from "../log/logger";
import { serverConfig } from "../env/config";

/**
 * Retention for the two append-only logs that grow without bound.
 *
 * Only rows nothing will ever look at again are deleted: processed
 * order_events (an unprocessed row is an obligation, not history) and old
 * audit_log rows. Intents, fills, income, protection rows and every
 * reconciliation run are never touched — they are trading history, not
 * transport noise.
 *
 * Each batch is one short DELETE, repeated until the table is drained or the
 * time budget is spent, so a first run on a large database cannot stall the
 * process or hold the risk mutation queue (this module never takes it).
 */

export const RETENTION_DEFAULTS = {
  orderEventsDays: 14,
  auditLogDays: 180,
  batchSize: 500,
  timeBudgetMs: 2_000,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BATCHES = 400;

export interface RetentionOptions {
  now?: number;
  orderEventsDays?: number;
  auditLogDays?: number;
  batchSize?: number;
  timeBudgetMs?: number;
}

export interface RetentionResult {
  orderEventsDeleted: number;
  auditLogDeleted: number;
  batches: number;
  stoppedBy: "empty" | "time_budget" | "batch_limit";
  durationMs: number;
}

/** Deletes processsed order events older than `cutoff`. Returns rows removed. */
function deleteProcessedEvents(cutoff: number, batchSize: number): number {
  const result = getDb()
    .prepare(
      `DELETE FROM order_events
        WHERE id IN (
          SELECT id FROM order_events
           WHERE processed = 1 AND ts < ?
           ORDER BY id
           LIMIT ?
        )`,
    )
    .run(cutoff, batchSize);
  return result.changes;
}

function deleteOldAuditRows(cutoff: number, batchSize: number): number {
  const result = getDb()
    .prepare(
      `DELETE FROM audit_log
        WHERE id IN (
          SELECT id FROM audit_log WHERE ts < ? ORDER BY id LIMIT ?
        )`,
    )
    .run(cutoff, batchSize);
  return result.changes;
}

export function runRetentionPass(options: RetentionOptions = {}): RetentionResult {
  const started = Date.now();
  const now = options.now ?? started;
  const cfg = serverConfig();
  const orderEventsDays = options.orderEventsDays ?? cfg.retentionOrderEventsDays ?? RETENTION_DEFAULTS.orderEventsDays;
  const auditLogDays = options.auditLogDays ?? cfg.retentionAuditLogDays ?? RETENTION_DEFAULTS.auditLogDays;
  const batchSize = Math.max(1, options.batchSize ?? RETENTION_DEFAULTS.batchSize);
  const timeBudgetMs = Math.max(1, options.timeBudgetMs ?? RETENTION_DEFAULTS.timeBudgetMs);

  const eventCutoff = now - orderEventsDays * DAY_MS;
  const auditCutoff = now - auditLogDays * DAY_MS;

  let orderEventsDeleted = 0;
  let auditLogDeleted = 0;
  let batches = 0;
  let stoppedBy: RetentionResult["stoppedBy"] = "empty";

  for (;;) {
    if (batches > 0 && Date.now() - started >= timeBudgetMs) {
      stoppedBy = "time_budget";
      break;
    }
    if (batches >= MAX_BATCHES) {
      stoppedBy = "batch_limit";
      break;
    }
    const events = deleteProcessedEvents(eventCutoff, batchSize);
    const audits = deleteOldAuditRows(auditCutoff, batchSize);
    orderEventsDeleted += events;
    auditLogDeleted += audits;
    batches += 1;
    if (events === 0 && audits === 0) {
      stoppedBy = "empty";
      break;
    }
  }

  const result: RetentionResult = {
    orderEventsDeleted,
    auditLogDeleted,
    batches,
    stoppedBy,
    durationMs: Date.now() - started,
  };
  if (result.orderEventsDeleted > 0 || result.auditLogDeleted > 0) {
    log.info("retention pass removed old rows", {
      orderEvents: result.orderEventsDeleted,
      auditLog: result.auditLogDeleted,
      batches: result.batches,
      stoppedBy: result.stoppedBy,
    });
  }
  return result;
}
