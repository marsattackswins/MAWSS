import "server-only";

import { serverConfig, type EnvConfig, type MawsEnv } from "../env/config";

/**
 * The "paper" id is kept as a valid DB key for legacy read-only history rows
 * written before paper trading was removed. New rows are never written under
 * this id; the local (disconnected) mode has no server-side profile writes.
 */
export type PersistenceProfileId = "paper" | "binance-testnet" | "binance-production" | "shadow";

export interface PersistenceProfile {
  id: PersistenceProfileId;
  environment: MawsEnv;
}

/** Maps only trusted server configuration to the persistence scope. */
export function persistenceProfileFromConfig(config: Pick<EnvConfig, "env">): PersistenceProfile {
  switch (config.env) {
    case "local":
      // Disconnected/local mode: use the legacy "paper" db key so that any
      // runtime_config reads/writes in local mode continue to find their rows.
      // No new trading data is ever written in this mode.
      return { id: "paper", environment: "local" };
    case "testnet":
      return { id: "binance-testnet", environment: "testnet" };
    case "production":
      return { id: "binance-production", environment: "production" };
    case "shadow":
      return { id: "shadow", environment: "shadow" };
    default: {
      const impossibleEnvironment: never = config.env;
      throw new Error(`MAWS_PERSISTENCE_PROFILE_INVALID: unsupported environment ${String(impossibleEnvironment)}`);
    }
  }
}

/** Resolves the profile from the cached server configuration, never request data. */
export function activePersistenceProfile(): PersistenceProfile {
  return persistenceProfileFromConfig(serverConfig());
}

/** Validates a profile crossing a persistence-service boundary. */
export function assertPersistenceProfile(profile: PersistenceProfile): PersistenceProfile {
  const expected = persistenceProfileFromConfig({ env: profile.environment });
  if (expected.id !== profile.id) {
    throw new Error("MAWS_PERSISTENCE_PROFILE_INVALID: profile/environment mismatch");
  }
  return profile;
}
