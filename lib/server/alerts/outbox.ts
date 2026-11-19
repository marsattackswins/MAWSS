import "server-only";

import { getDb } from "../db/connection";
import { serverConfig } from "../env/config";
import { log } from "../log/logger";

/**
 * Durable outbox for critical alerts.
 *
 * The webhook used to be fire-and-forget behind a 60 s per-event throttle, so
 * one transient network failure silently dropped an unprotected position or a
 * freeze. Critical events are now rows: delivered on success, retried with
 * backoff, and abandoned only after 24 hours (still visible as undelivered).
 * Non-critical alerts keep the cheap in-memory throttle.
 */

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 60 * 60 * 1000;
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DELIVERY_TIMEOUT_MS = 5_000;
const BATCH_LIMIT = 20;
const RETRY_TICK_MS = 60_000;

const CRITICAL_EVENTS = new Set([
  "freeze",
  "binance_ip_ban",
  "flatten_incomplete",
  "order.reduce_only_rejected_production",
]);

/** Critical events that carry a `:SYMBOL` suffix. */
const CRITICAL_PREFIXES = ["position_unprotected", "listen_key_", "emergency_algo_orders_remaining"];

export function isCriticalAlert(event: string): boolean {
  if (CRITICAL_EVENTS.has(event)) return true;
  return CRITICAL_PREFIXES.some((prefix) => event.startsWith(prefix));
}

/** Backoff before attempt N (attempts already recorded). */
export function alertBackoffMs(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRetryTick(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void deliverPendingAlerts().finally(() => {
      if (pendingCount() > 0) scheduleRetryTick();
    });
  }, RETRY_TICK_MS);
  retryTimer.unref?.();
}

export function enqueueAlert(event: string, detail: Record<string, unknown>, env: string, now = Date.now()): void {
  getDb()
    .prepare(
      `INSERT INTO alert_outbox (created_at, event, payload, attempts, next_attempt_at, delivered_at, last_error)
       VALUES (?, ?, ?, 0, ?, NULL, NULL)`,
    )
    .run(now, event, JSON.stringify({ event, detail, env }), now);
  scheduleRetryTick();
  void deliverPendingAlerts(now);
}

export function pendingCount(now = Date.now()): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM alert_outbox
        WHERE delivered_at IS NULL AND created_at > ?`,
    )
    .get(now - OUTBOX_MAX_AGE_MS) as { n: number };
  return row.n;
}

interface OutboxRow {
  id: number;
  created_at: number;
  event: string;
  payload: string;
  attempts: number;
}

/**
 * Attempts every due, undelivered, not-yet-expired row once. Never throws:
 * delivery problems are recorded on the row and retried later.
 */
export async function deliverPendingAlerts(now = Date.now()): Promise<{ delivered: number; failed: number }> {
  let url: string | null;
  try {
    url = serverConfig().alertWebhookUrl;
  } catch {
    return { delivered: 0, failed: 0 };
  }
  if (!url) return { delivered: 0, failed: 0 };

  const rows = getDb()
    .prepare(
      `SELECT id, created_at, event, payload, attempts FROM alert_outbox
        WHERE delivered_at IS NULL AND next_attempt_at <= ? AND created_at > ?
        ORDER BY id LIMIT ?`,
    )
    .all(now, now - OUTBOX_MAX_AGE_MS, BATCH_LIMIT) as OutboxRow[];

  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: row.payload,
        signal: ac.signal,
      });
      if (!response.ok) throw new Error(`webhook HTTP ${response.status}`);
      getDb().prepare(`UPDATE alert_outbox SET delivered_at = ?, last_error = NULL WHERE id = ?`).run(now, row.id);
      delivered += 1;
    } catch (err) {
      const attempts = row.attempts + 1;
      getDb()
        .prepare(`UPDATE alert_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`)
        .run(attempts, now + alertBackoffMs(attempts), String(err), row.id);
      log.warn("critical alert delivery failed; will retry", { event: row.event, attempts, error: String(err) });
      failed += 1;
    } finally {
      clearTimeout(timer);
    }
  }
  return { delivered, failed };
}

export function resetAlertOutboxForTests(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  try {
    getDb().prepare(`DELETE FROM alert_outbox`).run();
  } catch {
    // No database yet.
  }
}
