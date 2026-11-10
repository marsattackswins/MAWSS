import { HOST_MAP, loadEnvConfig, type EnvConfig } from "@/lib/server/env/config";
import { hashPassword } from "@/lib/server/auth/password";
import { persistenceProfileFromConfig } from "@/lib/server/profile/context";
import { executionDecision, requireEmergencyActionAllowed, requireSubmissionAllowed, SubmissionBlockedError } from "@/lib/server/gates/execution";
import { RUNTIME_KEYS, setRuntime, getRuntime, allRuntime } from "@/lib/server/runtime/flags";
import { freshEnv, makeCfg } from "./helpers";
import { resetHealthSignalsForTests, setHealthSignal } from "@/lib/server/health/state";

const AUTH = "0123456789abcdef:fedcba9876543210";
const KEYS = { MAWS_BINANCE_API_KEY: "k", MAWS_BINANCE_API_SECRET: "s" };
const VALID_RISK_CAPS = {
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

/** loadEnvConfig takes ProcessEnv; tests pass plain partial maps. */
const envSrc = (src: Record<string, string>) => src as unknown as NodeJS.ProcessEnv;

describe("environment configuration (fail closed)", () => {
  test("host map is fixed: local -> production public endpoints, testnet -> demo hosts, shadow/production -> real fapi hosts", () => {
    expect(HOST_MAP.local.rest).toBe("https://fapi.binance.com");
    expect(HOST_MAP.local.uds).toBe("wss://fstream.binance.com");
    expect(HOST_MAP.testnet.rest).toBe("https://demo-fapi.binance.com");
    expect(HOST_MAP.testnet.uds).toBe("wss://demo-fstream.binance.com");
    expect(HOST_MAP.shadow.rest).toBe("https://fapi.binance.com");
    expect(HOST_MAP.production.rest).toBe("https://fapi.binance.com");
    expect(HOST_MAP.production.uds).toBe("wss://fstream.binance.com");
  });

  test("testnet profile resolves only to demo hosts", () => {
    expect(HOST_MAP.testnet.rest).toBe("https://demo-fapi.binance.com");
    expect(HOST_MAP.testnet.uds).toBe("wss://demo-fstream.binance.com");
  });

  test("production profile resolves only to production hosts", () => {
    expect(HOST_MAP.production.rest).toBe("https://fapi.binance.com");
    expect(HOST_MAP.production.uds).toBe("wss://fstream.binance.com");
  });

  test("no env/profile combination mixes demo and production hosts", () => {
    const testnetCfg = loadEnvConfig(envSrc({
      MAWS_ENV: "testnet",
      MAWS_OPERATOR_AUTH: AUTH,
      ...KEYS,
    }));
    expect(testnetCfg.profiles["binance-testnet"].restEndpoint).toBe("https://demo-fapi.binance.com");
    expect(testnetCfg.profiles["binance-testnet"].webSocketEndpoint).toBe("wss://demo-fstream.binance.com");
    expect(testnetCfg.profiles["binance-production"].restEndpoint).toBe("https://fapi.binance.com");
    expect(testnetCfg.profiles["binance-production"].webSocketEndpoint).toBe("wss://fstream.binance.com");

    const prodCfg = loadEnvConfig(envSrc({
      MAWS_ENV: "production",
      MAWS_OPERATOR_AUTH: AUTH,
      ...KEYS,
      ...VALID_RISK_CAPS,
    }));
    expect(prodCfg.profiles["binance-testnet"].restEndpoint).toBe("https://demo-fapi.binance.com");
    expect(prodCfg.profiles["binance-testnet"].webSocketEndpoint).toBe("wss://demo-fstream.binance.com");
    expect(prodCfg.profiles["binance-production"].restEndpoint).toBe("https://fapi.binance.com");
    expect(prodCfg.profiles["binance-production"].webSocketEndpoint).toBe("wss://fstream.binance.com");
  });

  test("testnet credentials are bound to demo hosts, never production hosts", () => {
    const cfg = loadEnvConfig(envSrc({
      MAWS_ENV: "testnet",
      MAWS_OPERATOR_AUTH: AUTH,
      MAWS_BINANCE_TESTNET_API_KEY: "demo-key",
      MAWS_BINANCE_TESTNET_API_SECRET: "demo-secret",
      MAWS_BINANCE_PRODUCTION_API_KEY: "prod-key",
      MAWS_BINANCE_PRODUCTION_API_SECRET: "prod-secret",
    }));
    // Testnet profile carries demo credentials and demo hosts
    expect(cfg.profiles["binance-testnet"].apiKey).toBe("demo-key");
    expect(cfg.profiles["binance-testnet"].restEndpoint).toBe("https://demo-fapi.binance.com");
    // Production profile carries production credentials and production hosts
    expect(cfg.profiles["binance-production"].apiKey).toBe("prod-key");
    expect(cfg.profiles["binance-production"].restEndpoint).toBe("https://fapi.binance.com");
    // Active credentials come from the testnet profile, not production
    expect(cfg.binanceApiKey).toBe("demo-key");
    expect(cfg.binanceApiKey).not.toBe("prod-key");
  });

  test("legacy testnet hosts are absent from the host map", () => {
    for (const entry of Object.values(HOST_MAP)) {
      expect(entry.rest).not.toContain("binancefuture.com");
      expect(entry.uds).not.toContain("binancefuture.com");
    }
  });

  test("defaults to local with no config", () => {
    const cfg = loadEnvConfig(envSrc({}));
    expect(cfg.env).toBe("local");
    expect(cfg.recvWindowMs).toBe(5000);
    expect(cfg.reverseEnabled).toBe(false);

    expect(cfg.risk.maxOrderNotionalUsd).toBe(50);
    expect(cfg.risk.maxLeverage).toBe(10);
    expect(cfg.risk.maxMarginRatio).toBe(0.5);
    expect(cfg.risk.minLiquidationDistancePct).toBe(5);
  });

  test("non-local envs require operator auth in salt:hash form", () => {
    expect(() => loadEnvConfig(envSrc({ MAWS_ENV: "testnet", ...KEYS }))).toThrow(/MAWS_OPERATOR_AUTH/);
    expect(() => loadEnvConfig(envSrc({ MAWS_ENV: "testnet", MAWS_OPERATOR_AUTH: "plaintext-password", ...KEYS }))).toThrow(/hex/);
    const testnet = loadEnvConfig(envSrc({ MAWS_ENV: "testnet", MAWS_OPERATOR_AUTH: AUTH, ...KEYS }));
    expect(testnet.env).toBe("testnet");
    expect(testnet.risk).toEqual({
      maxOrderNotionalUsd: 50,
      maxGrossExposureUsd: 100,
      maxOpenOrders: 10,
      maxOpenPositions: 3,
      dailyLossPct: 50,
      priceCollarPct: 5,
      maxLeverage: 10,
      maxMarginRatio: 0.5,
      minLiquidationDistancePct: 5,
    });

  });

  test("configured monitoring tokens are long, distinct, and separate from operator password material", () => {
    const base = { MAWS_ENV: "testnet", MAWS_OPERATOR_AUTH: AUTH, ...KEYS };
    expect(() => loadEnvConfig(envSrc({ ...base, MAWS_HEALTH_TOKEN: "short" })))
      .toThrow(/MAWS_HEALTH_TOKEN must be at least 32 characters/);
    expect(() => loadEnvConfig(envSrc({ ...base, MAWS_EMERGENCY_TOKEN: "short" })))
      .toThrow(/MAWS_EMERGENCY_TOKEN must be at least 32 characters/);
    expect(() => loadEnvConfig(envSrc({
      ...base,
      MAWS_HEALTH_TOKEN: "h".repeat(32),
      MAWS_EMERGENCY_TOKEN: "h".repeat(32),
    }))).toThrow(/MAWS_HEALTH_TOKEN and MAWS_EMERGENCY_TOKEN must differ/);

    const password = "operator-password-that-is-not-a-token";
    const operatorAuth = hashPassword(password);
    for (const tokenName of ["MAWS_HEALTH_TOKEN", "MAWS_EMERGENCY_TOKEN"] as const) {
      expect(() => loadEnvConfig(envSrc({
        ...base,
        MAWS_OPERATOR_AUTH: operatorAuth,
        [tokenName]: password,
      }))).toThrow(new RegExp(`${tokenName} must differ from MAWS_OPERATOR_AUTH material`));
    }

    const valid = loadEnvConfig(envSrc({
      ...base,
      MAWS_HEALTH_TOKEN: "health-" + "h".repeat(32),
      MAWS_EMERGENCY_TOKEN: "emergency-" + "e".repeat(32),
    }));
    expect(valid.healthToken).toBe("health-" + "h".repeat(32));
    expect(valid.emergencyToken).toBe("emergency-" + "e".repeat(32));
  });

  test("Binance credentials are required for testnet/shadow/production", () => {
    for (const env of ["testnet", "shadow", "production"]) {
      expect(() => loadEnvConfig(envSrc({ MAWS_ENV: env, MAWS_OPERATOR_AUTH: AUTH }))).toThrow(/BINANCE_API/);
    }
  });

  test("local chart-only mode accepts separate profile credentials", () => {
    const cfg = loadEnvConfig(envSrc({
      MAWS_ENV: "local",
      MAWS_BINANCE_TESTNET_API_KEY: "testnet-key",
      MAWS_BINANCE_TESTNET_API_SECRET: "testnet-secret",
      MAWS_BINANCE_PRODUCTION_API_KEY: "production-key",
      MAWS_BINANCE_PRODUCTION_API_SECRET: "production-secret",
    }));
    expect(cfg.activeProfileId).toBeNull();
    expect(cfg.binanceApiKey).toBeNull();
    expect(cfg.profiles["binance-testnet"].configured).toBe(true);
    expect(cfg.profiles["binance-production"].configured).toBe(true);
  });

  test("invalid env values and numbers are rejected", () => {
    expect(() => loadEnvConfig(envSrc({ MAWS_ENV: "prod" }))).toThrow();
    expect(() =>
      loadEnvConfig(envSrc({ MAWS_ENV: "testnet", MAWS_OPERATOR_AUTH: AUTH, ...KEYS, MAWS_RECV_WINDOW_MS: "abc" })),
    ).toThrow(/numeric/);
  });

  test("backup key must be 64 hex chars", () => {
    expect(() => loadEnvConfig(envSrc({ MAWS_BACKUP_KEY: "short" }))).toThrow(/64 hex/);
    const cfg = loadEnvConfig(envSrc({ MAWS_BACKUP_KEY: "ab".repeat(32) }));
    expect(cfg.backupKey?.length).toBe(32);
  });


  test("production rejects zero risk caps (fail closed)", () => {
    const base = { MAWS_ENV: "production", MAWS_OPERATOR_AUTH: AUTH, ...KEYS };
    expect(() => loadEnvConfig(envSrc({
      ...base,
      ...VALID_RISK_CAPS,
      MAWS_RISK_MAX_ORDER_NOTIONAL: "0",
    }))).toThrow(/positive finite/);
  });

  test("reverse can be explicitly enabled outside production only", () => {
    const testnet = loadEnvConfig(envSrc({
      MAWS_ENV: "testnet",
      MAWS_OPERATOR_AUTH: AUTH,
      MAWS_ENABLE_REVERSE: "true",
      ...KEYS,
    }));
    expect(testnet.reverseEnabled).toBe(true);

    const production = { MAWS_ENV: "production", MAWS_OPERATOR_AUTH: AUTH, ...KEYS, ...VALID_RISK_CAPS };
    expect(() => loadEnvConfig(envSrc({ ...production, MAWS_ENABLE_REVERSE: "true" })))
      .toThrow(/MAWS_ENABLE_REVERSE cannot be enabled in production/);
    expect(loadEnvConfig(envSrc(production)).reverseEnabled).toBe(false);
  });

  test("production rejects negative risk caps", () => {
    const base = { MAWS_ENV: "production", MAWS_OPERATOR_AUTH: AUTH, ...KEYS };
    expect(() => loadEnvConfig(envSrc({
      ...base,
      ...VALID_RISK_CAPS,
      MAWS_RISK_MAX_GROSS_EXPOSURE: "-100",
    }))).toThrow(/positive finite/);
  });

  test("production rejects NaN risk caps", () => {
    const base = { MAWS_ENV: "production", MAWS_OPERATOR_AUTH: AUTH, ...KEYS };
    expect(() => loadEnvConfig(envSrc({
      ...base,
      ...VALID_RISK_CAPS,
      MAWS_RISK_MAX_OPEN_ORDERS: "abc",
    }))).toThrow(/numeric/);
  });

  test("production rejects a zero maximum leverage", () => {
    const base = { MAWS_ENV: "production", MAWS_OPERATOR_AUTH: AUTH, ...KEYS };
    expect(() => loadEnvConfig(envSrc({
      ...base,
      ...VALID_RISK_CAPS,
      MAWS_RISK_MAX_LEVERAGE: "0",
    }))).toThrow(/MAWS_RISK_MAX_LEVERAGE must be a positive finite number/);
  });

  test.each([
    ["MAWS_RISK_MAX_MARGIN_RATIO", "0"],
    ["MAWS_RISK_MIN_LIQ_DISTANCE_PCT", "0"],
  ])("production rejects %s set to zero", (name, value) => {
    const base = { MAWS_ENV: "production", MAWS_OPERATOR_AUTH: AUTH, ...KEYS };
    expect(() => loadEnvConfig(envSrc({
      ...base,
      ...VALID_RISK_CAPS,
      [name]: value,
    }))).toThrow(new RegExp(`${name} must be a positive finite number`));
  });

  test("production requires every risk limit to be explicitly configured and names all missing variables", () => {
    const base = { MAWS_ENV: "production", MAWS_OPERATOR_AUTH: AUTH, ...KEYS };
    let message = "";
    try {
      loadEnvConfig(envSrc(base));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("explicitly configured");
    for (const name of [
      "MAWS_RISK_MAX_ORDER_NOTIONAL",
      "MAWS_RISK_MAX_GROSS_EXPOSURE",
      "MAWS_RISK_MAX_OPEN_ORDERS",
      "MAWS_RISK_MAX_OPEN_POSITIONS",
      "MAWS_RISK_DAILY_LOSS_PCT",
      "MAWS_RISK_PRICE_COLLAR_PCT",
      "MAWS_RISK_MAX_LEVERAGE",
      "MAWS_RISK_MAX_MARGIN_RATIO",
      "MAWS_RISK_MIN_LIQ_DISTANCE_PCT",
    ]) {
      expect(message).toContain(name);
    }
  });

  test("production accepts valid positive risk caps", () => {
    const base = { MAWS_ENV: "production", MAWS_OPERATOR_AUTH: AUTH, ...KEYS };
    const cfg = loadEnvConfig(envSrc({
      ...base,
      MAWS_RISK_MAX_ORDER_NOTIONAL: "100",
      MAWS_RISK_MAX_GROSS_EXPOSURE: "100",
      MAWS_RISK_MAX_OPEN_ORDERS: "1",
      MAWS_RISK_MAX_OPEN_POSITIONS: "1",
      MAWS_RISK_DAILY_LOSS_PCT: "10",
      MAWS_RISK_PRICE_COLLAR_PCT: "2",
      MAWS_RISK_MAX_LEVERAGE: "10",
      MAWS_RISK_MAX_MARGIN_RATIO: "0.5",
      MAWS_RISK_MIN_LIQ_DISTANCE_PCT: "10",
    }));
    expect(cfg.risk.maxOrderNotionalUsd).toBe(100);
    expect(cfg.risk.maxGrossExposureUsd).toBe(100);
    expect(cfg.risk.maxOpenOrders).toBe(1);
    expect(cfg.risk.maxOpenPositions).toBe(1);
    expect(cfg.risk.dailyLossPct).toBe(10);
    expect(cfg.risk.priceCollarPct).toBe(2);
    expect(cfg.risk.maxLeverage).toBe(10);
    expect(cfg.risk.maxMarginRatio).toBe(0.5);
    expect(cfg.risk.minLiquidationDistancePct).toBe(10);
  });
});

describe("execution gate matrix", () => {
  beforeEach(() => {
    freshEnv(makeCfg());
  });

  const decide = (cfg: EnvConfig) => executionDecision(cfg);

  test("testnet can submit once the runtime flag is on", () => {
    setRuntime(RUNTIME_KEYS.executionEnabled, "true");
    const d = decide(makeCfg({ env: "testnet" }));
    expect(d.canSubmit).toBe(true);
    expect(d.reasons).toEqual([]);
  });

  test("runtime flag off blocks even testnet", () => {
    const d = decide(makeCfg({ env: "testnet" }));
    expect(d.canSubmit).toBe(false);
    expect(d.reasons).toContain("runtime execution flag is disabled");
  });

  test("configured testnet credentials are sufficient for the profile gate", () => {
    const cfg = freshEnv(makeCfg());
    setRuntime(RUNTIME_KEYS.executionEnabled, "true");
    const profiles = {
      ...cfg.profiles,
      "binance-testnet": { ...cfg.profiles["binance-testnet"], executionEnabled: false },
    };
    const d = decide({ ...cfg, profiles });
    expect(d.canSubmit).toBe(true);
    expect(d.profileExecutionEnabled).toBe(true);
  });

  test("missing production credentials block the profile", () => {
    const cfg = freshEnv(makeCfg({ env: "production", activeProfileId: "binance-production" }));
    const production = persistenceProfileFromConfig(cfg);
    setRuntime(RUNTIME_KEYS.executionEnabled, "true", Date.now(), production);
    const d = decide(cfg);
    expect(d.canSubmit).toBe(false);
    expect(d.profileExecutionEnabled).toBe(false);
    expect(d.reasons).toContain("Binance credentials are not configured for the active profile");
  });

  test("shadow can never submit, regardless of flags", () => {
    setRuntime(RUNTIME_KEYS.executionEnabled, "true");
    const d = decide(makeCfg({ env: "shadow" }));
    expect(d.canSubmit).toBe(false);
    expect(d.reasons).toContain("shadow mode is read-only");
    expect(() => requireSubmissionAllowed(makeCfg({ env: "shadow" }))).toThrow(SubmissionBlockedError);
  });

  test("local can never submit", () => {
    setRuntime(RUNTIME_KEYS.executionEnabled, "true");
    expect(decide(makeCfg({ env: "local" })).canSubmit).toBe(false);
  });


  test("kill switch blocks submissions", () => {
    setRuntime(RUNTIME_KEYS.executionEnabled, "true");
    setRuntime(RUNTIME_KEYS.killSwitch, "true");
    const d = decide(makeCfg({ env: "testnet" }));
    expect(d.canSubmit).toBe(false);
    expect(d.killSwitch).toBe(true);
    expect(d.reasons).toContain("kill switch engaged");
  });

  test("freeze blocks submissions until lifted", () => {
    setRuntime(RUNTIME_KEYS.executionEnabled, "true");
    setRuntime(RUNTIME_KEYS.frozen, "true");
    setRuntime(RUNTIME_KEYS.frozenReason, "reconciliation drift");
    const d = decide(makeCfg({ env: "testnet" }));
    expect(d.canSubmit).toBe(false);
    expect(d.frozenReason).toBe("reconciliation drift");
  });

  test("manager readiness is mandatory", () => {
    resetHealthSignalsForTests();
    setRuntime(RUNTIME_KEYS.executionEnabled, "true");
    const d = decide(makeCfg({ env: "testnet" }));
    expect(d.canSubmit).toBe(false);
    expect(d.reasons).toContain("manager not ready");
  });

  test("stream lease ownership is mandatory", () => {
    const now = Date.now();
    setHealthSignal({
      stream: { connected: true, leaseOwned: false, phase: "live", startedAt: now, lastEventAt: now, lastApplicationEventAt: now, reconnects: 0, listenKeyRenewedAt: now, bufferOverflow: false, circuitState: "closed" },
    });
    setRuntime(RUNTIME_KEYS.executionEnabled, "true");
    const d = decide(makeCfg({ env: "testnet" }));
    expect(d.canSubmit).toBe(false);
    expect(d.reasons).toContain("stream lease not owned");
  });

  test("degraded stream and stale snapshot block submissions", () => {
    const now = Date.now();
    setHealthSignal({
      stream: { connected: false, leaseOwned: true, phase: "reconnecting", startedAt: now, lastEventAt: now, lastApplicationEventAt: now, reconnects: 1, listenKeyRenewedAt: now, bufferOverflow: false, circuitState: "closed" },
      snapshot: { fetchedAt: now - 6 * 60_000 },
    });
    setRuntime(RUNTIME_KEYS.executionEnabled, "true");
    const d = decide(makeCfg({ env: "testnet" }));
    expect(d.canSubmit).toBe(false);
    expect(d.reasons).toContain("stream degraded");
    expect(d.reasons).toContain("snapshot too old");
  });

  test("emergency action remains available when normal gates block", () => {
    resetHealthSignalsForTests();
    expect(() => requireEmergencyActionAllowed(makeCfg({ env: "testnet" }))).not.toThrow();
  });
});

describe("runtime flags store", () => {
  beforeEach(() => {
    freshEnv(makeCfg());
  });

  test("set/get/all round-trip persists in the database", () => {
    expect(getRuntime(RUNTIME_KEYS.killSwitch, "fallback")).toBe("fallback");
    setRuntime(RUNTIME_KEYS.killSwitch, "true", 123);
    expect(getRuntime(RUNTIME_KEYS.killSwitch)).toBe("true");
    setRuntime(RUNTIME_KEYS.killSwitch, "false");
    expect(allRuntime()[RUNTIME_KEYS.killSwitch]).toBe("false");
  });
});
