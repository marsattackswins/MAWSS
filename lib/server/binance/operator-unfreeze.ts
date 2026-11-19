import "server-only";

import { alert } from "../alerts/dispatch";
import { healthSignals } from "../health/state";
import { log } from "../log/logger";
import { audit } from "../audit/log";
import { activePersistenceProfile, type PersistenceProfile } from "../profile/context";
import { publishLive } from "./sse";
import { intentsInUncertainStates } from "./intents";
import {
  activeFreezes,
  clearOperatorFreezes,
  describeActiveFreezes,
  freezeStatuses,
  lastCleanReconAt,
  type FreezeClearContext,
  type FreezeCode,
  type FreezeStatus,
} from "./freeze";

export interface OperatorUnfreezeResult {
  cleared: FreezeCode[];
  active: FreezeStatus[];
}

/**
 * Evidence for every clear rule, read from runtime state rather than from the
 * caller. `restProbeOk` stays undefined: this path never probes the exchange,
 * so an IP_BAN freeze keeps its documented REST-probe requirement.
 */
export function currentFreezeContext(now = Date.now(), profile: PersistenceProfile = activePersistenceProfile()): FreezeClearContext {
  const stream = healthSignals().stream;
  return {
    now,
    hasUncertainIntents: intentsInUncertainStates(profile).length > 0,
    lastCleanReconAt: lastCleanReconAt(profile),
    streamRecovered: stream != null && stream.connected && (stream.phase === "live" || stream.phase === "reconciled"),
    operatorAction: false,
  };
}

/**
 * Clears the freezes whose own condition is met (or only `code`). It never
 * enables execution and never touches the kill switch: only freeze rows and
 * the legacy frozen flag they mirror are changed.
 */
export function operatorUnfreeze(
  profile: PersistenceProfile = activePersistenceProfile(),
  options: { code?: FreezeCode; ip?: string; now?: number } = {},
): OperatorUnfreezeResult {
  const now = options.now ?? Date.now();
  const ctx = currentFreezeContext(now, profile);
  const before = activeFreezes(profile).length;
  if (before === 0) {
    return { cleared: [], active: [] };
  }
  const result = clearOperatorFreezes(ctx, profile, options.code);
  const active = freezeStatuses(currentFreezeContext(now, profile), profile);
  if (result.cleared.length > 0) {
    audit(
      "operator",
      "live.freeze.operator_unfreeze",
      { cleared: result.cleared, requested: options.code ?? null, remaining: active.map((row) => row.code) },
      options.ip,
      profile,
    );
    if (active.length === 0) {
      alert("unfreeze", { cleared: result.cleared, by: "operator" });
      publishLive("health", { frozen: false });
    } else {
      publishLive("health", { frozen: true, reason: describeActiveFreezes(profile), cleared: result.cleared });
    }
    log.info("operator unfreeze cleared freezes", { cleared: result.cleared, remaining: active.map((row) => row.code) });
  }
  return { cleared: result.cleared, active };
}
