import "server-only";

import { getDb } from "../db/connection";
import {
  activePersistenceProfile,
  assertPersistenceProfile,
  type PersistenceProfile,
} from "../profile/context";

export type ProtectionStatus = "PROTECTED" | "UNPROTECTED";

export interface ProtectionIntent {
  symbol: string;
  side: "long" | "short";
  tpPrice: string | null;
  slPrice: string | null;
  updatedAt: number;
  status: ProtectionStatus;
  failureReason: string | null;
  restoreAttemptedAt: number;
}

interface ProtectionRow {
  symbol: string;
  side: "long" | "short";
  tp_price: string | null;
  sl_price: string | null;
  updated_at: number;
  status: ProtectionStatus;
  failure_reason: string | null;
  restore_attempted_at: number;
}

function fromRow(row: ProtectionRow): ProtectionIntent {
  return {
    symbol: row.symbol,
    side: row.side,
    tpPrice: row.tp_price,
    slPrice: row.sl_price,
    updatedAt: row.updated_at,
    status: row.status,
    failureReason: row.failure_reason,
    restoreAttemptedAt: row.restore_attempted_at,
  };
}

export function getProtectionIntent(
  symbol: string,
  profile: PersistenceProfile = activePersistenceProfile(),
): ProtectionIntent | null {
  assertPersistenceProfile(profile);
  const row = getDb()
    .prepare(`SELECT symbol, side, tp_price, sl_price, updated_at, status, failure_reason, restore_attempted_at
      FROM protection_intents WHERE profile_id = ? AND symbol = ?`)
    .get(profile.id, symbol) as ProtectionRow | undefined;
  return row ? fromRow(row) : null;
}

export function listProtectionIntents(
  profile: PersistenceProfile = activePersistenceProfile(),
): ProtectionIntent[] {
  assertPersistenceProfile(profile);
  const rows = getDb()
    .prepare(`SELECT symbol, side, tp_price, sl_price, updated_at, status, failure_reason, restore_attempted_at
      FROM protection_intents WHERE profile_id = ? ORDER BY symbol`)
    .all(profile.id) as ProtectionRow[];
  return rows.map(fromRow);
}

export function saveProtectionIntent(
  intent: Pick<ProtectionIntent, "symbol" | "side" | "tpPrice" | "slPrice">,
  now = Date.now(),
  profile: PersistenceProfile = activePersistenceProfile(),
): void {
  assertPersistenceProfile(profile);
  getDb()
    .prepare(`INSERT INTO protection_intents
      (profile_id, symbol, side, tp_price, sl_price, updated_at, status, failure_reason, restore_attempted_at)
      VALUES (?, ?, ?, ?, ?, ?, 'UNPROTECTED', 'Protection update in progress', 0)
      ON CONFLICT(profile_id, symbol) DO UPDATE SET
        side = excluded.side,
        tp_price = excluded.tp_price,
        sl_price = excluded.sl_price,
        updated_at = excluded.updated_at,
        status = 'UNPROTECTED',
        failure_reason = 'Protection update in progress',
        restore_attempted_at = 0`)
    .run(profile.id, intent.symbol, intent.side, intent.tpPrice, intent.slPrice, now);
}

export function setProtectionStatus(
  symbol: string,
  status: ProtectionStatus,
  failureReason: string | null = null,
  profile: PersistenceProfile = activePersistenceProfile(),
): void {
  assertPersistenceProfile(profile);
  getDb()
    .prepare(`UPDATE protection_intents SET status = ?, failure_reason = ? WHERE profile_id = ? AND symbol = ?`)
    .run(status, failureReason, profile.id, symbol);
}

export function markProtectionRestoreAttempted(
  symbol: string,
  attemptedAt: number,
  profile: PersistenceProfile = activePersistenceProfile(),
): void {
  assertPersistenceProfile(profile);
  getDb()
    .prepare(`UPDATE protection_intents SET restore_attempted_at = ? WHERE profile_id = ? AND symbol = ?`)
    .run(attemptedAt, profile.id, symbol);
}

export function deleteProtectionIntent(
  symbol: string,
  profile: PersistenceProfile = activePersistenceProfile(),
): void {
  assertPersistenceProfile(profile);
  getDb().prepare(`DELETE FROM protection_intents WHERE profile_id = ? AND symbol = ?`).run(profile.id, symbol);
}

export function unprotectedProtectionSymbols(
  profile: PersistenceProfile = activePersistenceProfile(),
): string[] {
  assertPersistenceProfile(profile);
  return (
    getDb()
      .prepare(`SELECT symbol FROM protection_intents WHERE profile_id = ? AND status = 'UNPROTECTED' ORDER BY symbol`)
      .all(profile.id) as Array<{ symbol: string }>
  ).map((row) => row.symbol);
}
