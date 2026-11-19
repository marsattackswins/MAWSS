/**
 * FIX A — typed, concurrent freeze reasons.
 *
 * These tests pin the two defects that motivated the change: any terminal
 * order event used to clear any freeze, and a second freeze overwrote the
 * first. They also cover every clear rule and the pre-migration row path.
 */

import { getDb } from "@/lib/server/db/connection";
import { runMigrations } from "@/lib/server/db/migrate";
import { persistenceProfileFromConfig } from "@/lib/server/profile/context";
import { getRuntime, RUNTIME_KEYS, setRuntime } from "@/lib/server/runtime/flags";
import {
  activeFreezes,
  clearFreeze,
  evaluateFreezes,
  isFreezeClearable,
  registerFreeze,
  type FreezeClearContext,
} from "@/lib/server/binance/freeze";
import { freshEnv, makeCfg } from "./helpers";

function setup() {
  const cfg = freshEnv(makeCfg());
  return { cfg, profile: persistenceProfileFromConfig(cfg) };
}

function cleanReconAt(at: number): void {
  getDb()
    .prepare(
      `INSERT INTO reconciliation_runs (profile_id, started_at, finished_at, trigger, result, details)
       VALUES (?, ?, ?, 'test', 'ok', '{}')`,
    )
    .run(persistenceProfileFromConfig(makeCfg()).id, at - 1, at);
}

function ctx(overrides: Partial<FreezeClearContext> = {}): FreezeClearContext {
  return {
    now: Date.now(),
    hasUncertainIntents: false,
    lastCleanReconAt: null,
    streamRecovered: false,
    operatorAction: false,
    ...overrides,
  };
}

describe("typed freeze reasons", () => {
  test("a drift freeze is not cleared by a fill (order events only settle intent reasons)", () => {
    const { profile } = setup();
    registerFreeze("RECON_DRIFT", "reconciliation drift: position mismatch", { profile });
    // A fill clears intents; it supplies no clean reconciliation.
    const result = evaluateFreezes(ctx({ hasUncertainIntents: false }), profile);
    expect(result.cleared).toEqual([]);
    expect(activeFreezes(profile).map((row) => row.code)).toEqual(["RECON_DRIFT"]);
    expect(getRuntime(RUNTIME_KEYS.frozen, "", profile)).toBe("true");
  });

  test("an IP-ban freeze is not cleared by a fill", () => {
    const { profile } = setup();
    const now = Date.now();
    registerFreeze("IP_BAN", "binance ip ban", {
      profile,
      now,
      detail: { banExpiresAt: now + 60_000 },
    });
    const result = evaluateFreezes(ctx({ now, hasUncertainIntents: false }), profile);
    expect(result.cleared).toEqual([]);
    expect(activeFreezes(profile).map((row) => row.code)).toEqual(["IP_BAN"]);
  });

  test("two simultaneous freezes: clearing one leaves the other active", () => {
    const { profile } = setup();
    const now = Date.now();
    registerFreeze("RECON_DRIFT", "drift", { profile, now });
    registerFreeze("STREAM_OVERFLOW", "buffer overflow", { profile, now });
    cleanReconAt(now + 10);

    const result = evaluateFreezes(ctx({ now: now + 20, lastCleanReconAt: now + 10 }), profile);
    expect(result.cleared).toEqual(["RECON_DRIFT"]);
    expect(activeFreezes(profile).map((row) => row.code)).toEqual(["STREAM_OVERFLOW"]);
    expect(getRuntime(RUNTIME_KEYS.frozen, "", profile)).toBe("true");
    expect(getRuntime(RUNTIME_KEYS.frozenReason, "", profile)).toContain("STREAM_OVERFLOW");

    // Explicitly clearing the last one empties the runtime flag.
    clearFreeze("STREAM_OVERFLOW", "test", now + 30, profile);
    expect(activeFreezes(profile)).toEqual([]);
    expect(getRuntime(RUNTIME_KEYS.frozen, "", profile)).toBe("false");
  });

  test("a new freeze never overwrites the reason of an active freeze of the same code", () => {
    const { profile } = setup();
    registerFreeze("RECON_DRIFT", "first drift", { profile });
    registerFreeze("RECON_DRIFT", "second drift", { profile });
    expect(activeFreezes(profile)).toHaveLength(1);
    expect(activeFreezes(profile)[0].reason).toBe("first drift");
  });

  test("intent reasons clear when no uncertain intent remains", () => {
    const { profile } = setup();
    registerFreeze("TIMEOUT_UNKNOWN", "submission timeout", { profile });
    expect(evaluateFreezes(ctx({ hasUncertainIntents: true }), profile).cleared).toEqual([]);
    expect(evaluateFreezes(ctx({ hasUncertainIntents: false }), profile).cleared).toEqual(["TIMEOUT_UNKNOWN"]);
  });

  test("RECON_* and EVENT_PROCESSING_FAILED clear only after a clean recon with a fresh snapshot", () => {
    const { profile } = setup();
    const now = Date.now();
    registerFreeze("RECON_FAILED", "recon failed", { profile, now });
    registerFreeze("SNAPSHOT_FAILED", "snapshot failed", { profile, now });

    // A clean recon that predates the freeze is not evidence.
    expect(evaluateFreezes(ctx({ now: now + 10, lastCleanReconAt: now - 5_000 }), profile).cleared).toEqual([]);

    cleanReconAt(now + 10);
    const result = evaluateFreezes(ctx({ now: now + 20, lastCleanReconAt: now + 10 }), profile);
    expect(result.cleared.sort()).toEqual(["RECON_FAILED", "SNAPSHOT_FAILED"]);
  });

  test("stream reasons need a live, snapshot-recovered stream and a clean recon since the freeze", () => {
    const { profile } = setup();
    const now = Date.now();
    registerFreeze("STREAM_DOWN", "stream down", { profile, now });
    registerFreeze("LISTEN_KEY_EXPIRED", "listenKey expired", { profile, now });
    cleanReconAt(now + 5);

    expect(evaluateFreezes(ctx({ now: now + 10, lastCleanReconAt: now + 5, streamRecovered: false }), profile).cleared).toEqual([]);
    const result = evaluateFreezes(ctx({ now: now + 10, lastCleanReconAt: now + 5, streamRecovered: true }), profile);
    expect(result.cleared.sort()).toEqual(["LISTEN_KEY_EXPIRED", "STREAM_DOWN"]);
  });

  test("IP_BAN clears only after the ban window, a successful REST probe and a clean recon", () => {
    const { profile } = setup();
    const now = Date.now();
    registerFreeze("IP_BAN", "ip ban", { profile, now, detail: { banExpiresAt: now + 1_000 } });
    cleanReconAt(now + 5);
    const base = { lastCleanReconAt: now + 5, hasUncertainIntents: false, streamRecovered: false };

    expect(evaluateFreezes(ctx({ ...base, now: now + 500, restProbeOk: true }), profile).cleared).toEqual([]);
    expect(evaluateFreezes(ctx({ ...base, now: now + 2_000, restProbeOk: false }), profile).cleared).toEqual([]);
    expect(evaluateFreezes(ctx({ ...base, now: now + 2_000, restProbeOk: true }), profile).cleared).toEqual(["IP_BAN"]);
  });

  test("KEY_REJECTED and OPERATOR clear only by explicit operator action", () => {
    const { profile } = setup();
    registerFreeze("KEY_REJECTED", "key rejected", { profile });
    registerFreeze("OPERATOR", "operator freeze", { profile });
    expect(evaluateFreezes(ctx({ operatorAction: false }), profile).cleared).toEqual([]);
    const result = evaluateFreezes(ctx({ operatorAction: true }), profile);
    expect(result.cleared.sort()).toEqual(["KEY_REJECTED", "OPERATOR"]);
  });

  test("operator unfreeze works for a migrated LEGACY row once a clean recon ran", () => {
    const { profile } = setup();
    const now = Date.now();
    registerFreeze("LEGACY", "frozen before typed reasons", { profile, now });
    expect(evaluateFreezes(ctx({ now: now + 10, operatorAction: true }), profile).cleared).toEqual([]);
    cleanReconAt(now + 10);
    const result = evaluateFreezes(ctx({ now: now + 20, lastCleanReconAt: now + 10, operatorAction: true }), profile);
    expect(result.cleared).toEqual(["LEGACY"]);
  });

  test("a pre-migration frozen row stays frozen until clean recon plus operator unfreeze", () => {
    const { cfg, profile } = setup();
    // Simulate a pre-M0012 database: drop typed rows, rewind user_version, keep
    // the legacy runtime flag, then run the migration again.
    getDb().prepare(`DELETE FROM freeze_reasons WHERE profile_id = ?`).run(profile.id);
    setRuntime(RUNTIME_KEYS.frozen, "true", 1_700_000_000_000, profile);
    setRuntime(RUNTIME_KEYS.frozenReason, "reconciliation drift", 1_700_000_000_000, profile);
    getDb().pragma("user_version = 11");
    runMigrations(getDb());

    const migrated = activeFreezes(profile);
    expect(migrated).toHaveLength(1);
    expect(migrated[0].code).toBe("LEGACY");
    expect(migrated[0].reason).toBe("reconciliation drift");
    expect(migrated[0].setAt).toBe(1_700_000_000_000);

    // Not clearable by intents or by time alone.
    expect(evaluateFreezes(ctx({ hasUncertainIntents: false, now: Date.now() + 60_000 }), profile).cleared).toEqual([]);
    cleanReconAt(Date.now());
    expect(evaluateFreezes(ctx({ lastCleanReconAt: Date.now(), operatorAction: false }), profile).cleared).toEqual([]);
    expect(evaluateFreezes(ctx({ lastCleanReconAt: Date.now(), operatorAction: true }), profile).cleared).toEqual(["LEGACY"]);
    expect(cfg.env).toBe("testnet");
  });

  test("clear decision is per-code, not global", () => {
    const { profile } = setup();
    const now = Date.now();
    registerFreeze("RECON_DRIFT", "drift", { profile, now });
    const [row] = activeFreezes(profile);
    expect(isFreezeClearable(row, ctx({ lastCleanReconAt: now + 1 }))).toBe(true);
    expect(isFreezeClearable(row, ctx({ lastCleanReconAt: null }))).toBe(false);
  });
});
