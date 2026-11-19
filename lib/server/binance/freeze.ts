import "server-only";

import { getDb } from "../db/connection";
import { log } from "../log/logger";
import {
  activePersistenceProfile,
  assertPersistenceProfile,
  type PersistenceProfile,
} from "../profile/context";
import { getRuntime, RUNTIME_KEYS, setRuntime } from "../runtime/flags";

/**
 * Typed submission freezes.
 *
 * A freeze used to be a single `frozen` flag plus one `frozen_reason` string,
 * so any terminal order event cleared whatever had frozen submissions, and a
 * second freeze overwrote the first instead of joining it. Freezes are now
 * rows: several can be active at once, each clears only under its own
 * documented condition, and none overwrites another.
 *
 * The legacy runtime flag is still written (frozen + a joined reason text) so
 * the execution gate and dashboards keep their existing contract.
 */
export type FreezeCode =
  | "UNCERTAIN_INTENT"
  | "TIMEOUT_UNKNOWN"
  | "CANCEL_UNKNOWN"
  | "ORDER_HTTP_5XX"
  | "ORDER_TRANSPORT_UNKNOWN"
  | "REVERSE_UNCERTAIN"
  | "EVENT_PROCESSING_FAILED"
  | "RECON_DRIFT"
  | "RECON_FAILED"
  | "RECON_UNAVAILABLE"
  | "SNAPSHOT_FAILED"
  | "STREAM_DOWN"
  | "STREAM_OVERFLOW"
  | "LISTEN_KEY_EXPIRED"
  | "IP_BAN"
  | "KEY_REJECTED"
  | "OPERATOR"
  | "LEGACY";

export type FreezeClearRule =
  /** Clears when no order intent is in an uncertain state. */
  | "intents"
  /** Clears only after a clean reconciliation pass with a fresh snapshot. */
  | "clean_recon"
  /** Clears when the stream is live, snapshot recovery finished, and a clean recon ran since the freeze. */
  | "stream_recovered"
  /** Clears after the ban window passed, a REST probe succeeded, and a clean recon ran since. */
  | "ip_ban"
  /** Clears only by explicit operator action. */
  | "operator"
  /** Pre-migration row: needs a clean recon AND an explicit operator unfreeze. */
  | "legacy";

export interface FreezeDefinition {
  code: FreezeCode;
  label: string;
  setBy: string;
  clearRule: FreezeClearRule;
  /** Where the freeze is raised (kept next to the table for the runbook). */
  location: string;
}

export const FREEZE_DEFINITIONS: readonly FreezeDefinition[] = [
  { code: "UNCERTAIN_INTENT", label: "Order outcome uncertain", setBy: "reconciliation / operator tooling", clearRule: "intents", location: "lib/server/binance/freeze.ts" },
  { code: "TIMEOUT_UNKNOWN", label: "Submission timed out", setBy: "OrderService.submitOrder", clearRule: "intents", location: "lib/server/binance/orders.ts" },
  { code: "CANCEL_UNKNOWN", label: "Cancel outcome uncertain", setBy: "OrderService.cancelOrder", clearRule: "intents", location: "lib/server/binance/orders.ts" },
  { code: "ORDER_HTTP_5XX", label: "Submission returned HTTP 5xx", setBy: "OrderService.submitOrder", clearRule: "intents", location: "lib/server/binance/orders.ts" },
  { code: "ORDER_TRANSPORT_UNKNOWN", label: "Submission transport failed", setBy: "OrderService.submitOrder", clearRule: "intents", location: "lib/server/binance/orders.ts" },
  { code: "REVERSE_UNCERTAIN", label: "Reverse position outcome uncertain", setBy: "OrderService.reversePosition", clearRule: "intents", location: "lib/server/binance/orders.ts" },
  { code: "EVENT_PROCESSING_FAILED", label: "User-data event processing failed", setBy: "manager / stream event loop", clearRule: "clean_recon", location: "lib/server/binance/manager.ts" },
  { code: "RECON_DRIFT", label: "Reconciliation drift", setBy: "Reconciler", clearRule: "clean_recon", location: "lib/server/binance/recon.ts" },
  { code: "RECON_FAILED", label: "Reconciliation failed to complete", setBy: "Reconciler", clearRule: "clean_recon", location: "lib/server/binance/recon.ts" },
  { code: "RECON_UNAVAILABLE", label: "Reconciliation circuit open", setBy: "Reconciler", clearRule: "clean_recon", location: "lib/server/binance/recon.ts" },
  { code: "SNAPSHOT_FAILED", label: "Stream snapshot recovery failed", setBy: "UserDataStream", clearRule: "clean_recon", location: "lib/server/binance/stream.ts" },
  { code: "STREAM_DOWN", label: "User-data stream disconnected", setBy: "UserDataStream", clearRule: "stream_recovered", location: "lib/server/binance/stream.ts" },
  { code: "STREAM_OVERFLOW", label: "User-data stream buffer overflow", setBy: "UserDataStream", clearRule: "stream_recovered", location: "lib/server/binance/stream.ts" },
  { code: "LISTEN_KEY_EXPIRED", label: "listenKey expired", setBy: "UserDataStream", clearRule: "stream_recovered", location: "lib/server/binance/stream.ts" },
  { code: "IP_BAN", label: "Binance IP ban (HTTP 418)", setBy: "OrderService.submitOrder", clearRule: "ip_ban", location: "lib/server/binance/orders.ts" },
  { code: "KEY_REJECTED", label: "API key rejected (-2015)", setBy: "OrderService.submitOrder", clearRule: "operator", location: "lib/server/binance/orders.ts" },
  { code: "OPERATOR", label: "Operator freeze", setBy: "operator action", clearRule: "operator", location: "lib/server/binance/freeze.ts" },
  { code: "LEGACY", label: "Frozen before typed reasons (migration)", setBy: "schema migration M0012", clearRule: "legacy", location: "lib/server/db/migrate.ts" },
] as const;

export interface FreezeRow {
  id: number;
  code: FreezeCode;
  reason: string;
  setAt: number;
  detail: Record<string, unknown> | null;
}

export interface FreezeClearContext {
  now: number;
  hasUncertainIntents: boolean;
  /** finished_at of the newest successful reconciliation run, if any. */
  lastCleanReconAt: number | null;
  /** Stream is connected, snapshot recovery finished, and it is serving events. */
  streamRecovered: boolean;
  /** True only when the caller actually probed REST and it succeeded. */
  restProbeOk?: boolean;
  /** Set for an explicit operator unfreeze. */
  operatorAction?: boolean;
}

function parseDetail(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function lastCleanReconAt(profile: PersistenceProfile = activePersistenceProfile()): number | null {
  assertPersistenceProfile(profile);
  const row = getDb()
    .prepare(
      `SELECT MAX(finished_at) AS at FROM reconciliation_runs
        WHERE profile_id = ? AND result = 'ok' AND finished_at IS NOT NULL`,
    )
    .get(profile.id) as { at: number | null };
  return row.at ?? null;
}

export function activeFreezes(profile: PersistenceProfile = activePersistenceProfile()): FreezeRow[] {
  assertPersistenceProfile(profile);
  const rows = getDb()
    .prepare(
      `SELECT id, code, reason, set_at, detail FROM freeze_reasons
        WHERE profile_id = ? AND cleared_at IS NULL ORDER BY id`,
    )
    .all(profile.id) as Array<{ id: number; code: string; reason: string; set_at: number; detail: string | null }>;
  return rows.map((row) => ({
    id: row.id,
    code: row.code as FreezeCode,
    reason: row.reason,
    setAt: row.set_at,
    detail: parseDetail(row.detail),
  }));
}

export function hasActiveFreeze(code: FreezeCode, profile: PersistenceProfile = activePersistenceProfile()): boolean {
  return activeFreezes(profile).some((row) => row.code === code);
}

/** Joins active freezes into the legacy single-string reason (execution gate contract). */
export function describeActiveFreezes(profile: PersistenceProfile = activePersistenceProfile()): string {
  return activeFreezes(profile)
    .map((row) => (row.reason ? `${row.code}: ${row.reason}` : row.code))
    .join(" | ");
}

function syncRuntimeState(now: number, profile: PersistenceProfile): FreezeRow[] {
  const active = activeFreezes(profile);
  setRuntime(RUNTIME_KEYS.frozen, active.length > 0 ? "true" : "false", now, profile);
  setRuntime(RUNTIME_KEYS.frozenReason, active.length > 0 ? describeActiveFreezes(profile) : "", now, profile);
  return active;
}

/**
 * Records a freeze. A second freeze with the same code while the first is
 * still active does not overwrite its reason: the earlier cause stays visible
 * until it clears. Different codes stack.
 */
export function registerFreeze(
  code: FreezeCode,
  reason: string,
  opts: { detail?: Record<string, unknown>; now?: number; profile?: PersistenceProfile } = {},
): boolean {
  const profile = opts.profile ?? activePersistenceProfile();
  const now = opts.now ?? Date.now();
  assertPersistenceProfile(profile);
  if (hasActiveFreeze(code, profile)) {
    log.warn("submission freeze already active; keeping the original reason", { code, reason });
    return false;
  }
  getDb()
    .prepare(
      `INSERT INTO freeze_reasons (profile_id, code, reason, set_at, detail, cleared_at, cleared_by)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(profile.id, code, reason, now, opts.detail ? JSON.stringify(opts.detail) : null);
  syncRuntimeState(now, profile);
  log.warn("submission freeze raised", { code, reason });
  return true;
}

export function clearFreeze(
  code: FreezeCode,
  clearedBy: string,
  now = Date.now(),
  profile: PersistenceProfile = activePersistenceProfile(),
): boolean {
  assertPersistenceProfile(profile);
  const result = getDb()
    .prepare(
      `UPDATE freeze_reasons SET cleared_at = ?, cleared_by = ?
        WHERE profile_id = ? AND code = ? AND cleared_at IS NULL`,
    )
    .run(now, clearedBy, profile.id, code);
  if (result.changes === 0) return false;
  syncRuntimeState(now, profile);
  log.info("submission freeze cleared", { code, clearedBy });
  return true;
}

function ipBanExpired(row: FreezeRow, now: number): boolean {
  const expiresAt = row.detail?.banExpiresAt;
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) && now >= expiresAt;
}

function cleanReconSince(row: FreezeRow, ctx: FreezeClearContext): boolean {
  return ctx.lastCleanReconAt != null && ctx.lastCleanReconAt >= row.setAt;
}

/** Pure decision: should this active freeze clear under the supplied evidence? */
export function isFreezeClearable(row: FreezeRow, ctx: FreezeClearContext): boolean {
  switch (FREEZE_DEFINITIONS.find((definition) => definition.code === row.code)?.clearRule) {
    case "intents":
      return !ctx.hasUncertainIntents;
    case "clean_recon":
      return cleanReconSince(row, ctx);
    case "stream_recovered":
      return ctx.streamRecovered && cleanReconSince(row, ctx);
    case "ip_ban":
      return ipBanExpired(row, ctx.now) && ctx.restProbeOk === true && cleanReconSince(row, ctx);
    case "operator":
      return ctx.operatorAction === true;
    case "legacy":
      return ctx.operatorAction === true && cleanReconSince(row, ctx);
    default:
      return false;
  }
}

export interface FreezeEvaluationResult {
  cleared: FreezeCode[];
  remaining: FreezeCode[];
}

/**
 * Applies every clear condition whose evidence is present. Clears are
 * independent: clearing one code never clears another.
 */
export function evaluateFreezes(
  ctx: FreezeClearContext,
  profile: PersistenceProfile = activePersistenceProfile(),
): FreezeEvaluationResult {
  assertPersistenceProfile(profile);
  const active = activeFreezes(profile);
  const cleared: FreezeCode[] = [];
  for (const row of active) {
    if (!isFreezeClearable(row, ctx)) continue;
    if (clearFreeze(row.code, ctx.operatorAction ? "operator" : "automatic", ctx.now, profile)) {
      cleared.push(row.code);
    }
  }
  const remaining = activeFreezes(profile).map((row) => row.code);
  return { cleared, remaining };
}

/** True when any active freeze does not clear on its own. */
export function activeFreezesNeedAttention(profile: PersistenceProfile = activePersistenceProfile()): FreezeCode[] {
  return activeFreezes(profile)
    .filter((row) => {
      const rule = FREEZE_DEFINITIONS.find((definition) => definition.code === row.code)?.clearRule;
      return rule === "operator" || rule === "legacy" || rule === "ip_ban";
    })
    .map((row) => row.code);
}

/** Test/reset seam: clear every row (does not touch runtime flags). */
export function resetFreezeReasonsForTests(profile: PersistenceProfile = activePersistenceProfile()): void {
  assertPersistenceProfile(profile);
  getDb().prepare(`DELETE FROM freeze_reasons WHERE profile_id = ?`).run(profile.id);
}

export function frozenRuntimeFlag(profile: PersistenceProfile = activePersistenceProfile()): string {
  return getRuntime(RUNTIME_KEYS.frozen, "", profile);
}
