import {
  loadEnvConfig,
  safeProfileMetadata,
  type ProfileId,
} from "@/lib/server/env/config";

const AUTH = "0123456789abcdef:fedcba9876543210";
const RISK_CAPS = {
  MAWS_RISK_MAX_ORDER_NOTIONAL: "50",
  MAWS_RISK_MAX_GROSS_EXPOSURE: "100",
  MAWS_RISK_MAX_OPEN_ORDERS: "10",
  MAWS_RISK_MAX_OPEN_POSITIONS: "3",
  MAWS_RISK_DAILY_LOSS_PCT: "50",
  MAWS_RISK_PRICE_COLLAR_PCT: "5",
  MAWS_RISK_MAX_LEVERAGE: "10",
  MAWS_RISK_MAX_MARGIN_RATIO: "0.5",
  MAWS_RISK_MIN_LIQ_DISTANCE_PCT: "10",
};

/** Valid two-mode defaults: operator auth is required on every launch. */
function env(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { MAWS_ENV: "testnet", MAWS_OPERATOR_AUTH: AUTH, ...values } as unknown as NodeJS.ProcessEnv;
}

describe("server profile configuration", () => {
  test("protection recovery age defaults to two minutes and is configurable", () => {
    expect(loadEnvConfig(env({})).protectionPendingMaxAgeMs).toBe(120_000);
    expect(loadEnvConfig(env({ MAWS_PROTECTION_PENDING_MAX_AGE_MS: "45000" })).protectionPendingMaxAgeMs).toBe(45_000);
  });

  test("parses separate testnet and production credentials", () => {
    const cfg = loadEnvConfig(env({
      MAWS_BINANCE_TESTNET_API_KEY: "testnet-key",
      MAWS_BINANCE_TESTNET_API_SECRET: "testnet-secret",
      MAWS_BINANCE_PRODUCTION_API_KEY: "production-key",
      MAWS_BINANCE_PRODUCTION_API_SECRET: "production-secret",
    }));

    // The base config never carries credentials or an attached profile; only
    // the coordinator's explicit attach does.
    expect(cfg.activeProfileId).toBeNull();
    expect(cfg.binanceApiKey).toBeNull();
    expect(cfg.binanceApiSecret).toBeNull();
    expect(cfg.profiles["binance-testnet"]).toMatchObject({
      configured: true,
      apiKey: "testnet-key",
      apiSecret: "testnet-secret",
    });
    expect(cfg.profiles["binance-production"]).toMatchObject({
      configured: true,
      apiKey: "production-key",
      apiSecret: "production-secret",
    });
  });

  test("missing testnet credentials do not populate production", () => {
    const cfg = loadEnvConfig(env({
      MAWS_BINANCE_PRODUCTION_API_KEY: "production-key",
      MAWS_BINANCE_PRODUCTION_API_SECRET: "production-secret",
    }));

    expect(cfg.profiles["binance-testnet"].configured).toBe(false);
    expect(cfg.profiles["binance-testnet"].apiKey).toBeNull();
    expect(cfg.profiles["binance-testnet"].apiSecret).toBeNull();
    expect(cfg.profiles["binance-production"].configured).toBe(true);
  });

  test("missing production credentials do not populate testnet", () => {
    const cfg = loadEnvConfig(env({
      MAWS_BINANCE_TESTNET_API_KEY: "testnet-key",
      MAWS_BINANCE_TESTNET_API_SECRET: "testnet-secret",
    }));

    expect(cfg.profiles["binance-production"].configured).toBe(false);
    expect(cfg.profiles["binance-production"].apiKey).toBeNull();
    expect(cfg.profiles["binance-production"].apiSecret).toBeNull();
    expect(cfg.profiles["binance-testnet"].configured).toBe(true);
  });

  test("rejects retired MAWS_ENV values with an actionable error", () => {
    for (const retired of ["local", "shadow", "paper"]) {
      expect(() => loadEnvConfig(env({ MAWS_ENV: retired }))).toThrow(
        /MAWS_ENV must be testnet\|production/,
      );
    }
  });

  test("rejects retired MAWS_DEFAULT_PROFILE values", () => {
    for (const retired of ["local", "shadow", "paper"]) {
      expect(() => loadEnvConfig(env({ MAWS_DEFAULT_PROFILE: retired }))).toThrow(
        /MAWS_DEFAULT_PROFILE must be binance-testnet\|binance-production/,
      );
    }
  });

  test("keeps legacy single-key variables compatible for the active environment", () => {
    const cfg = loadEnvConfig(env({
      MAWS_BINANCE_API_KEY: "legacy-key",
      MAWS_BINANCE_API_SECRET: "legacy-secret",
    }));

    // Legacy keys feed the profile matching MAWS_ENV, never the base config.
    expect(cfg.binanceApiKey).toBeNull();
    expect(cfg.binanceApiSecret).toBeNull();
    expect(cfg.profiles["binance-testnet"].apiKey).toBe("legacy-key");
    expect(cfg.profiles["binance-testnet"].apiSecret).toBe("legacy-secret");
    expect(cfg.profiles["binance-production"].configured).toBe(false);
  });

  test("legacy production keys feed the production profile in production mode", () => {
    const cfg = loadEnvConfig(env({
      MAWS_ENV: "production",
      MAWS_BINANCE_API_KEY: "legacy-production-key",
      MAWS_BINANCE_API_SECRET: "legacy-production-secret",
      ...RISK_CAPS,
    }));

    expect(cfg.profiles["binance-production"].apiKey).toBe("legacy-production-key");
    expect(cfg.profiles["binance-testnet"].configured).toBe(false);
  });

  test("fails closed on conflicting active legacy and profile credentials", () => {
    expect(() =>
      loadEnvConfig(env({
        MAWS_BINANCE_API_KEY: "legacy-key",
        MAWS_BINANCE_API_SECRET: "legacy-secret",
        MAWS_BINANCE_TESTNET_API_KEY: "different-key",
        MAWS_BINANCE_TESTNET_API_SECRET: "different-secret",
      })),
    ).toThrow("MAWS_PROFILE_CONFIGURATION_INVALID");
  });

  test("boots Disconnected while exposing configured profiles", () => {
    const cfg = loadEnvConfig(env({
      MAWS_BINANCE_TESTNET_API_KEY: "testnet-key",
      MAWS_BINANCE_TESTNET_API_SECRET: "testnet-secret",
    }));
    expect(cfg.env).toBe("testnet");
    // Startup never attaches: the operator attaches Testnet or Live explicitly.
    expect(cfg.activeProfileId).toBeNull();
    expect(cfg.profiles["binance-testnet"].configured).toBe(true);
    expect(cfg.defaultProfile).toBe("binance-testnet");
  });

  test("configured production credentials mark the profile execution-capable", () => {
    const enabled = loadEnvConfig(env({
      MAWS_ENV: "production",
      MAWS_BINANCE_PRODUCTION_API_KEY: "production-key",
      MAWS_BINANCE_PRODUCTION_API_SECRET: "production-secret",
      ...RISK_CAPS,
    }));
    expect(enabled.profiles["binance-production"].executionEnabled).toBe(true);
  });

  test("safe metadata is allowlisted and never contains credentials or endpoints", () => {
    const sentinelKey = "SENTINEL_PROFILE_API_KEY";
    const sentinelSecret = "SENTINEL_PROFILE_API_SECRET";
    const cfg = loadEnvConfig(env({
      MAWS_BINANCE_TESTNET_API_KEY: sentinelKey,
      MAWS_BINANCE_TESTNET_API_SECRET: sentinelSecret,
      MAWS_BINANCE_PRODUCTION_API_KEY: "production-key",
      MAWS_BINANCE_PRODUCTION_API_SECRET: "production-secret",
    }));

    const metadata = safeProfileMetadata(cfg.profiles);
    const serialized = JSON.stringify(metadata);
    const profileIds: ProfileId[] = ["binance-testnet", "binance-production"];

    expect(serialized).not.toContain(sentinelKey);
    expect(serialized).not.toContain(sentinelSecret);
    expect(serialized).not.toContain("https://");
    expect(metadata.map((profile) => profile.profileId)).toEqual(profileIds);
    expect(metadata.map((profile) => profile.label)).toEqual(["Testnet", "Live"]);
    expect(Object.keys(metadata[0])).toEqual([
      "profileId",
      "label",
      "environment",
      "configured",
      "requiresProductionConfirmation",
      "executionEnabled",
      "confirmOrders",
    ]);
  });

  test("default profile is binance-testnet unless explicitly configured and does not switch startup mode", () => {
    const cfg = loadEnvConfig(env({
      MAWS_DEFAULT_PROFILE: "binance-production",
      MAWS_BINANCE_TESTNET_API_KEY: "testnet-key",
      MAWS_BINANCE_TESTNET_API_SECRET: "testnet-secret",
    }));

    expect(loadEnvConfig(env({})).defaultProfile).toBe("binance-testnet");
    expect(cfg.defaultProfile).toBe("binance-production");
    expect(cfg.env).toBe("testnet");
    expect(cfg.activeProfileId).toBeNull();
  });
});
