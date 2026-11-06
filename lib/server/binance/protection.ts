import "server-only";

import { getDb } from "../db/connection";
import {
  activePersistenceProfile,
  assertPersistenceProfile,
  type PersistenceProfile,
} from "../profile/context";

export type ProtectionStatus = "PROTECTED" | "UNPROTECTED";
export type ProtectionIntentStatus = "PENDING_REPLACE" | "CONFIRMED";

export interface ProtectionIntent {
  symbol: string;
  side: "long" | "short";
  tpPrice: string | null;
  slPrice: string | null;
  previousTpPrice: string | null;
  previousSlPrice: string | null;
  createdAt: number;
  updatedAt: number;
  status: ProtectionIntentStatus;
  protectionStatus: ProtectionStatus;
  failureReason: string | null;
  restoreAttemptedAt: number;
}

interface ProtectionRow {
  symbol: string;
  side: "long" | "short";
  tp_price: string | null;
  sl_price: string | null;
  previous_tp_price: string | null;
  previous_sl_price: string | null;
  created_at: number;
  updated_at: number;
  intent_status: ProtectionIntentStatus;
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
    previousTpPrice: row.previous_tp_price,
    previousSlPrice: row.previous_sl_price,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.intent_status,
    protectionStatus: row.status,
    failureReason: row.failure_reason,
    restoreAttemptedAt: row.restore_attempted_at,
  };
}

const INTENT_COLUMNS = `symbol, side, tp_price, sl_price, previous_tp_price, previous_sl_price,
  created_at, updated_at, intent_status, status, failure_reason, restore_attempted_at`;

interface ProtectionLock {
  tail: Promise<void>;
  users: number;
}

const protectionLocks = new Map<string, ProtectionLock>();

function protectionLockKey(profile: PersistenceProfile, symbol: string): string {
  return `${profile.id}:${symbol}`;
}

export function isProtectionIntentLocked(
  symbol: string,
  profile: PersistenceProfile = activePersistenceProfile(),
): boolean {
  assertPersistenceProfile(profile);
  return (protectionLocks.get(protectionLockKey(profile, symbol))?.users ?? 0) > 0;
}

export async function withProtectionIntentLock<T>(
  symbol: string,
  operation: () => Promise<T>,
  profile: PersistenceProfile = activePersistenceProfile(),
): Promise<T> {
  assertPersistenceProfile(profile);
  const key = protectionLockKey(profile, symbol);
  let lock = protectionLocks.get(key);
  if (!lock) {
    lock = { tail: Promise.resolve(), users: 0 };
    protectionLocks.set(key, lock);
  }
  lock.users += 1;
  const previous = lock.tail;
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  lock.tail = previous.then(() => turn);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    lock.users -= 1;
    if (lock.users === 0) protectionLocks.delete(key);
  }
}

export function getProtectionIntent(
  symbol: string,
  profile: PersistenceProfile = activePersistenceProfile(),
): ProtectionIntent | null {
  assertPersistenceProfile(profile);
  const row = getDb()
    .prepare(`SELECT ${INTENT_COLUMNS}
      FROM protection_intents WHERE profile_id = ? AND symbol = ?`)
    .get(profile.id, symbol) as ProtectionRow | undefined;
  return row ? fromRow(row) : null;
}

export function listProtectionIntents(
  profile: PersistenceProfile = activePersistenceProfile(),
): ProtectionIntent[] {
  assertPersistenceProfile(profile);
  const rows = getDb()
    .prepare(`SELECT ${INTENT_COLUMNS}
      FROM protection_intents WHERE profile_id = ? ORDER BY symbol`)
    .all(profile.id) as ProtectionRow[];
  return rows.map(fromRow);
}

export function saveProtectionIntent(
  intent: Pick<ProtectionIntent, "symbol" | "side" | "tpPrice" | "slPrice"> &
    Partial<Pick<ProtectionIntent, "previousTpPrice" | "previousSlPrice">>,
  now = Date.now(),
  profile: PersistenceProfile = activePersistenceProfile(),
): void {
  assertPersistenceProfile(profile);
  getDb()
    .prepare(`INSERT INTO protection_intents
      (profile_id, symbol, side, tp_price, sl_price, previous_tp_price, previous_sl_price,
       created_at, updated_at, intent_status, status, failure_reason, restore_attempted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', 'PROTECTED', NULL, 0)
      ON CONFLICT(profile_id, symbol) DO UPDATE SET
        side = excluded.side,
        tp_price = excluded.tp_price,
        sl_price = excluded.sl_price,
        updated_at = excluded.updated_at,
        previous_tp_price = excluded.previous_tp_price,
        previous_sl_price = excluded.previous_sl_price,
        created_at = excluded.created_at,
        intent_status = 'CONFIRMED',
        status = 'PROTECTED',
        failure_reason = NULL,
        restore_attempted_at = 0`)
    .run(
      profile.id,
      intent.symbol,
      intent.side,
      intent.tpPrice,
      intent.slPrice,
      intent.previousTpPrice ?? null,
      intent.previousSlPrice ?? null,
      now,
      now,
    );
}

export function savePendingProtectionIntent(
  intent: Pick<ProtectionIntent, "symbol" | "side" | "tpPrice" | "slPrice" | "previousTpPrice" | "previousSlPrice">,
  now = Date.now(),
  profile: PersistenceProfile = activePersistenceProfile(),
): void {
  assertPersistenceProfile(profile);
  getDb()
    .prepare(`INSERT INTO protection_intents
      (profile_id, symbol, side, tp_price, sl_price, previous_tp_price, previous_sl_price,
       created_at, updated_at, intent_status, status, failure_reason, restore_attempted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_REPLACE', 'UNPROTECTED', 'Protection update in progress', 0)
      ON CONFLICT(profile_id, symbol) DO UPDATE SET
        side = excluded.side,
        tp_price = excluded.tp_price,
        sl_price = excluded.sl_price,
        previous_tp_price = excluded.previous_tp_price,
        previous_sl_price = excluded.previous_sl_price,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        intent_status = 'PENDING_REPLACE',
        status = 'UNPROTECTED',
        failure_reason = 'Protection update in progress',
        restore_attempted_at = 0`)
    .run(
      profile.id,
      intent.symbol,
      intent.side,
      intent.tpPrice,
      intent.slPrice,
      intent.previousTpPrice,
      intent.previousSlPrice,
      now,
      now,
    );
}

export function confirmProtectionIntent(
  intent: Pick<ProtectionIntent, "symbol" | "side" | "tpPrice" | "slPrice">,
  now = Date.now(),
  profile: PersistenceProfile = activePersistenceProfile(),
): void {
  saveProtectionIntent(intent, now, profile);
}

export function revertProtectionIntent(
  intent: Pick<ProtectionIntent, "symbol" | "side" | "previousTpPrice" | "previousSlPrice">,
  now = Date.now(),
  profile: PersistenceProfile = activePersistenceProfile(),
): void {
  saveProtectionIntent({
    symbol: intent.symbol,
    side: intent.side,
    tpPrice: intent.previousTpPrice,
    slPrice: intent.previousSlPrice,
  }, now, profile);
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
