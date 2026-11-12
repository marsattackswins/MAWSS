import "server-only";

import type { EnvConfig } from "../env/config";

export type ProfileErrorCode =
  | "invalid_profile"
  | "production_confirmation_required"
  | "production_risk_limits_invalid"
  | "profile_switch_in_progress"
  | "exposure_present"
  | "exposure_unknown"
  | "in_flight_mutation"
  | "reconciliation_drift"
  | "target_start_failed"
  | "rollback_failed"
  | "configuration_unavailable"
  | "not_connected"
  | "stale_profile";

export class ProfileCoordinatorError extends Error {
  constructor(readonly code: ProfileErrorCode, message: string = code) {
    super(message);
    this.name = "ProfileCoordinatorError";
  }
}

/** Configuration-only guard for explicitly constructed private services. */
export function assertAttachedConfig(config: EnvConfig): void {
  const expected = config.env === "testnet" ? "binance-testnet" : "binance-production";
  if (config.activeProfileId !== expected) throw new ProfileCoordinatorError("not_connected");
}

export type ProfileMutationBlockReason = "profile_switch_in_progress" | "profile_runtime_unavailable";

let normalMutationBlockReason: ProfileMutationBlockReason | null = null;

export function blockNormalMutations(reason: ProfileMutationBlockReason): void {
  normalMutationBlockReason = reason;
}

export function allowNormalMutations(): void {
  normalMutationBlockReason = null;
}

export function normalMutationBlock(): ProfileMutationBlockReason | null {
  return normalMutationBlockReason;
}

export function resetProfileAdmissionForTests(): void {
  normalMutationBlockReason = null;
}
