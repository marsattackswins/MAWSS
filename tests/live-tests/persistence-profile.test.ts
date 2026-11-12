import type { EnvConfig } from "@/lib/server/env/config";
import {
  activePersistenceProfile,
  assertPersistenceProfile,
  persistenceProfileFromConfig,
} from "@/lib/server/profile/context";
import { resetServerConfigForTests } from "@/lib/server/env/config";
import { makeCfg } from "./helpers";

describe("persistence profile context", () => {
  afterEach(() => {
    resetServerConfigForTests();
  });

  test.each([
    ["testnet", "binance-testnet"],
    ["production", "binance-production"],
  ] as const)("maps %s to %s", (env, id) => {
    expect(persistenceProfileFromConfig(makeCfg({ env }))).toEqual({ id, environment: env });
  });

  test("retired local/shadow environments fail closed", () => {
    for (const retired of ["local", "shadow", "paper", "unknown"]) {
      const invalid = { env: retired } as unknown as Pick<EnvConfig, "env">;
      expect(() => persistenceProfileFromConfig(invalid)).toThrow("MAWS_PERSISTENCE_PROFILE_INVALID");
    }
  });

  test("rejects a mismatched profile and environment", () => {
    expect(() =>
      assertPersistenceProfile({ id: "binance-production", environment: "testnet" }),
    ).toThrow("MAWS_PERSISTENCE_PROFILE_INVALID");
  });

  test("active profile comes from server configuration only", () => {
    resetServerConfigForTests(makeCfg({ env: "production" }));
    expect(activePersistenceProfile()).toEqual({ id: "binance-production", environment: "production" });
  });

  test("profile context contains no credentials or endpoint secrets", () => {
    const profile = persistenceProfileFromConfig(makeCfg({ env: "testnet" }));
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toContain("test-api-key");
    expect(serialized).not.toContain("test-api-secret");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("wss://");
    expect(Object.keys(profile)).toEqual(["id", "environment"]);
  });

  test("legacy paper/shadow rows keep their DB identity without a live mapping", () => {
    // Rows written before the two-mode change stay readable: "paper" and
    // "shadow" remain valid persistence keys, but no configuration maps to
    // them anymore — the mapping is total over testnet|production only.
    expect(persistenceProfileFromConfig(makeCfg({ env: "testnet" })).id).toBe("binance-testnet");
    expect(persistenceProfileFromConfig(makeCfg({ env: "production" })).id).toBe("binance-production");
    expect(() => persistenceProfileFromConfig({ env: "shadow" } as unknown as Pick<EnvConfig, "env">)).toThrow(
      "MAWS_PERSISTENCE_PROFILE_INVALID",
    );
  });
});
