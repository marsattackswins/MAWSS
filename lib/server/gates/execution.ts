import "server-only";

import type { EnvConfig } from "../env/config";
import { persistenceProfileFromConfig } from "../profile/context";
import { getRuntime, RUNTIME_KEYS } from "../runtime/flags";
import { healthSignals } from "../health/state";

export interface ExecutionDecision {
  env: string;
  envAllowsSubmissions: boolean;
  profileExecutionEnabled: boolean;
  runtimeEnabled: boolean;
  killSwitch: boolean;
  frozen: boolean;
  frozenReason: string;
  managerReady: boolean;
  streamLeaseOwned: boolean;
  streamHealthy: boolean;
  snapshotFresh: boolean;
  positionModeVerified: boolean;
  canSubmit: boolean;
  reasons: string[];
}

/**
 * Submission requires ALL of:
 *  - an env that permits submissions (testnet or production),
 *  - an authenticated, configured Binance profile,
 *  - the DB runtime execution flag (enabled automatically after profile attachment),
 *  - kill switch disengaged,
 *  - not frozen by health/reconciliation,
 *  - manager ready, stream lease owned, healthy private stream, and a recent
 *    authoritative snapshot,
 *  - Binance position mode verified as one-way.
 */
const STREAM_EVENT_STALE_MS = 60 * 1000;
const PRIVATE_STREAM_HEARTBEAT_MS = 5 * 60 * 1000;

export function executionDecision(cfg: EnvConfig): ExecutionDecision {
  const profile = persistenceProfileFromConfig(cfg);
  const runtimeEnabled = getRuntime(RUNTIME_KEYS.executionEnabled, "", profile) === "true";
  const killSwitch = getRuntime(RUNTIME_KEYS.killSwitch, "", profile) === "true";
  const frozen = getRuntime(RUNTIME_KEYS.frozen, "", profile) === "true";
  const frozenReason = getRuntime(RUNTIME_KEYS.frozenReason, "", profile);
  // Only an explicitly attached profile can permit submissions; the base
  // configuration never carries an active profile or private credentials.
  const profileExecutionEnabled =
    cfg.activeProfileId !== null && cfg.profiles[cfg.activeProfileId].configured;
  const signals = healthSignals();
  const managerReady = signals.brokerStatus === "ready";
  const stream = signals.stream;
  const streamLeaseOwned = stream?.leaseOwned === true;
  // Only real application events count as heartbeat; null means "no events yet",
  // not "stale" — falling back to startedAt froze submissions on quiet accounts.
  const streamHeartbeatAt = stream?.lastApplicationEventAt ?? null;
  const streamHealthy =
    stream != null &&
    stream.connected &&
    stream.phase !== "degraded" &&
    stream.phase !== "reconnecting" &&
    stream.phase !== "standby" &&
    stream.phase !== "snapshot" &&
    stream.phase !== "buffer-overflow" &&
    stream.phase !== "circuit-open" &&
    !stream.bufferOverflow &&
    stream.circuitState !== "open" &&
    (stream.lastEventAt == null || Date.now() - stream.lastEventAt <= STREAM_EVENT_STALE_MS) &&
    (streamHeartbeatAt == null || Date.now() - streamHeartbeatAt <= PRIVATE_STREAM_HEARTBEAT_MS);
  const snapshotFresh =
    signals.snapshot != null &&
    Date.now() - signals.snapshot.fetchedAt <= cfg.snapshotMaxAgeMs;
  const positionModeVerified = signals.positionMode.mode === "one-way" && signals.positionMode.error == null;

  const reasons: string[] = [];
  let canSubmit = true;
  if (!profileExecutionEnabled) {
    canSubmit = false;
    reasons.push("Binance credentials are not configured for the active profile");
  }

  if (!runtimeEnabled) {
    canSubmit = false;
    reasons.push("runtime execution flag is disabled");
  }
  if (killSwitch) {
    canSubmit = false;
    reasons.push("kill switch engaged");
  }
  if (frozen) {
    canSubmit = false;
    reasons.push(frozenReason || "frozen");
  }
  if (!managerReady) {
    canSubmit = false;
    reasons.push("manager not ready");
  }
  if (!streamLeaseOwned) {
    canSubmit = false;
    reasons.push("stream lease not owned");
  }
  if (!streamHealthy) {
    canSubmit = false;
    reasons.push("stream degraded");
  }
  if (!snapshotFresh) {
    canSubmit = false;
    reasons.push(signals.snapshot ? "snapshot too old" : "authoritative snapshot unavailable");
  }
  if (!positionModeVerified) {
    canSubmit = false;
    reasons.push(signals.positionMode.error ?? "position mode not verified as one-way");
  }

  return {
    env: cfg.env,
    // Both environments permit submissions; detachment is enforced by the
    // coordinator (not_connected), not by the execution gate.
    envAllowsSubmissions: true,
    profileExecutionEnabled,
    runtimeEnabled,
    killSwitch,
    frozen,
    frozenReason,
    managerReady,
    streamLeaseOwned,
    streamHealthy,
    snapshotFresh,
    positionModeVerified,
    canSubmit,
    reasons,
  };
}

export class SubmissionBlockedError extends Error {
  readonly reasons: string[];
  constructor(decision: ExecutionDecision) {
    super(`Submission blocked: ${decision.reasons.join("; ")}`);
    this.name = "SubmissionBlockedError";
    this.reasons = decision.reasons;
  }
}

export function requireSubmissionAllowed(cfg: EnvConfig): ExecutionDecision {
  const d = executionDecision(cfg);
  if (!d.canSubmit) throw new SubmissionBlockedError(d);
  return d;
}
