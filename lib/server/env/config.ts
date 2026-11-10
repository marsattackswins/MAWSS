import "server-only";

import { compareSecretTokens } from "../auth/token";
import { verifyOperatorPassword } from "../auth/password";

export type MawsEnv = "local" | "testnet" | "shadow" | "production";
export type BrokerType = "binance";
export type ProfileId = "binance-testnet" | "binance-production";
export type ProfileEnvironment = "testnet" | "production";

export const PROFILE_IDS: readonly ProfileId[] = [
  "binance-testnet",
  "binance-production",
];

export interface ServerProfileConfig {
  profileId: ProfileId;
  label: string;
  environment: ProfileEnvironment;
  configured: boolean;
  executionEnabled: boolean;
  confirmOrders?: boolean;
  apiKey: string | null;
  apiSecret: string | null;
  restEndpoint: string;
  webSocketEndpoint: string;
}

export const PRODUCTION_RISK_LIMITS = [
  ["MAWS_RISK_MAX_ORDER_NOTIONAL", "maxOrderNotionalUsd"],
  ["MAWS_RISK_MAX_GROSS_EXPOSURE", "maxGrossExposureUsd"],
  ["MAWS_RISK_MAX_OPEN_ORDERS", "maxOpenOrders"],
  ["MAWS_RISK_MAX_OPEN_POSITIONS", "maxOpenPositions"],
  ["MAWS_RISK_DAILY_LOSS_PCT", "dailyLossPct"],
  ["MAWS_RISK_PRICE_COLLAR_PCT", "priceCollarPct"],
  ["MAWS_RISK_MAX_LEVERAGE", "maxLeverage"],
  ["MAWS_RISK_MAX_MARGIN_RATIO", "maxMarginRatio"],
  ["MAWS_RISK_MIN_LIQ_DISTANCE_PCT", "minLiquidationDistancePct"],
] as const satisfies readonly (readonly [string, keyof EnvConfig["risk"]])[];

export function productionRiskConfigurationError(cfg: EnvConfig): string | null {
  const missing = cfg.missingProductionRiskLimitVariables ?? PRODUCTION_RISK_LIMITS.map(([name]) => name);
  if (missing.length > 0) {
    return `Production risk limits must be explicitly configured; missing: ${missing.join(", ")}`;
  }
  for (const [name, key] of PRODUCTION_RISK_LIMITS) {
    const value = cfg.risk[key];
    if (!Number.isFinite(value) || value <= 0) {
      return `${name} must be a positive finite number in production, got: ${value}`;
    }
  }
  return null;
}

function validateAuthTokens(cfg: EnvConfig): void {
  const tokens = [
    ["MAWS_HEALTH_TOKEN", cfg.healthToken],
    ["MAWS_EMERGENCY_TOKEN", cfg.emergencyToken],
  ] as const;
  for (const [name, token] of tokens) {
    if (token && token.length < 32) throw new Error(`${name} must be at least 32 characters`);
  }
  if (cfg.healthToken && cfg.emergencyToken && compareSecretTokens(cfg.healthToken, cfg.emergencyToken)) {
    throw new Error("MAWS_HEALTH_TOKEN and MAWS_EMERGENCY_TOKEN must differ");
  }
  if (cfg.operatorAuth) {
    const operatorMaterial = [cfg.operatorAuth, ...cfg.operatorAuth.split(":")];
    for (const [name, token] of tokens) {
      if (token && (
        verifyOperatorPassword(token, cfg.operatorAuth) ||
        operatorMaterial.some((material) => compareSecretTokens(token, material))
      )) {
        throw new Error(`${name} must differ from MAWS_OPERATOR_AUTH material`);
      }
    }
  }
}

export type ProfileRegistry = Record<ProfileId, ServerProfileConfig>;

export interface SafeProfileMetadata {
  profileId: ProfileId;
  label: string;
  environment: ProfileEnvironment;
  configured: boolean;
  requiresProductionConfirmation: boolean;
  executionEnabled: boolean;
  confirmOrders?: boolean;
}

export interface EnvConfig {
  env: MawsEnv;
  brokerType: BrokerType;
  /** Future profile default; it does not select or switch the startup broker. */
  defaultProfile: ProfileId;
  /** Null for shadow because shadow is an internal server mode, not a browser profile. */
  activeProfileId: ProfileId | null;
  profiles: ProfileRegistry;
  dbPath: string;
  operatorAuth: string | null;
  allowedOrigin: string | null;
  trustProxy: boolean;
  backupKey: Buffer | null;
  healthToken: string | null;
  emergencyToken: string | null;
  reverseEnabled: boolean;
  binanceApiKey: string | null;
  binanceApiSecret: string | null;
  recvWindowMs: number;
  rateInternalPerMin: number;
  reconIntervalMs: number;
  /** Mark-price poll cadence for open positions (unrealized PnL refresh). */
  markPriceIntervalMs: number;
  /**
   * Lookback window for REST history backfill (fills + orders) when no
   * intent or order timestamps exist for a symbol. Covers positions opened
   * before process startup; Binance caps userTrades/allOrders at 7-day
   * windows, so anything beyond this is unreachable anyway.
   */
  historyBackfillMs: number;
  leaseTtlMs: number;
  /** Maximum age of the last authoritative account/positions/orders snapshot. */
  snapshotMaxAgeMs: number;
  /** Maximum age for automatically restoring an interrupted protection replacement. */
  protectionPendingMaxAgeMs: number;
  alertWebhookUrl: string | null;
  /** Production risk variables absent from the source environment. */
  missingProductionRiskLimitVariables?: string[];
  risk: {
    maxOrderNotionalUsd: number;
    maxGrossExposureUsd: number;
    maxOpenOrders: number;
    maxOpenPositions: number;
    dailyLossPct: number;
    priceCollarPct: number;
    maxLeverage: number;
    maxMarginRatio: number;
    minLiquidationDistancePct: number;
  };
  circuitBreaker: {
    // Binance REST API breaker
    restFailureThreshold: number;
    restFailureWindowMs: number;
    restRecoveryTimeoutMs: number;
    restSuccessThreshold: number;
    // WebSocket stream breaker
    streamFailureThreshold: number;
    streamFailureWindowMs: number;
    streamRecoveryTimeoutMs: number;
    streamSuccessThreshold: number;
    // Reconciliation breaker
    reconFailureThreshold: number;
    reconFailureWindowMs: number;
    reconRecoveryTimeoutMs: number;
    reconSuccessThreshold: number;
  };
}

/**
 * Fixed literal host map. Base URLs are never configurable via environment.
 * local uses production public endpoints (chart only); testnet uses Binance
 * USDⓈ-M Demo Trading; shadow/production use the real USD-M Futures endpoints.
 */
export const HOST_MAP: Record<MawsEnv, { rest: string; uds: string; label: string }> = {
  local: {
    rest: "https://fapi.binance.com",
    uds: "wss://fstream.binance.com",
    label: "Binance USD-M Futures (local, public data only)",
  },
  testnet: {
    rest: "https://demo-fapi.binance.com",
    uds: "wss://demo-fstream.binance.com",
    label: "Binance USD-M Futures Demo Trading",
  },
  shadow: {
    rest: "https://fapi.binance.com",
    uds: "wss://fstream.binance.com",
    label: "Binance USD-M Futures (shadow, read-only)",
  },
  production: {
    rest: "https://fapi.binance.com",
    uds: "wss://fstream.binance.com",
    label: "Binance USD-M Futures (production)",
  },
};

/** Retired Binance testnet hosts — startup fails if any profile resolves to these. */
const LEGACY_HOSTS = ["testnet.binancefuture.com", "fstream.binancefuture.com"];

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function assertNoLegacyHosts(profiles: ProfileRegistry): void {
  for (const profile of Object.values(profiles)) {
    const hosts = [hostnameOf(profile.restEndpoint), hostnameOf(profile.webSocketEndpoint)];
    for (const host of hosts) {
      if (LEGACY_HOSTS.includes(host)) {
        throw new Error(
          `Legacy Binance testnet host "${host}" is retired. ` +
          `Demo Trading uses demo-fapi.binance.com (REST) and ` +
          `demo-fstream.binance.com (WebSocket). Update your configuration.`,
        );
      }
    }
  }
}

const PROFILE_CONFIGURATION_ERROR = "MAWS_PROFILE_CONFIGURATION_INVALID";

type CredentialPair = {
  apiKey: string | null;
  apiSecret: string | null;
};

function cleanCredential(raw: string | undefined): string | null {
  return raw?.trim() || null;
}

function readCredentialPair(source: NodeJS.ProcessEnv, keyName: string, secretName: string): CredentialPair {
  return {
    apiKey: cleanCredential(source[keyName]),
    apiSecret: cleanCredential(source[secretName]),
  };
}

function isComplete(pair: CredentialPair): boolean {
  return pair.apiKey !== null && pair.apiSecret !== null;
}

function assertCompletePair(pair: CredentialPair, keyName: string, secretName: string): void {
  if ((pair.apiKey === null) !== (pair.apiSecret === null)) {
    throw new Error(`${PROFILE_CONFIGURATION_ERROR}: ${keyName}/${secretName} must be provided together`);
  }
}

function pairsEqual(left: CredentialPair, right: CredentialPair): boolean {
  return left.apiKey === right.apiKey && left.apiSecret === right.apiSecret;
}

function parseDefaultProfile(raw: string | undefined): ProfileId {
  const value = (raw ?? "binance-testnet").trim().toLowerCase();
  if (value === "binance-testnet" || value === "binance-production") {
    return value;
  }
  // Legacy "paper" value — treat as no preference (default to testnet).
  if (value === "paper") return "binance-testnet";
  throw new Error(
    "MAWS_DEFAULT_PROFILE must be one of binance-testnet|binance-production",
  );
}

function profileForEnvironment(env: MawsEnv): ProfileId | null {
  if (env === "local") return null;
  if (env === "testnet") return "binance-testnet";
  if (env === "production") return "binance-production";
  return null;
}

function credentialProfileForEnvironment(env: MawsEnv): ProfileId | null {
  if (env === "shadow") return "binance-production";
  return profileForEnvironment(env);
}

function profileEndpoints(profileId: ProfileId): { rest: string; uds: string } {
  if (profileId === "binance-testnet") return HOST_MAP.testnet;
  return HOST_MAP.production;
}

function makeProfile(
  profileId: ProfileId,
  label: string,
  environment: ProfileEnvironment,
  source: CredentialPair,
  executionEnabled: boolean,
  confirmOrders?: boolean,
): ServerProfileConfig {
  const endpoints = profileEndpoints(profileId);
  return {
    profileId,
    label,
    environment,
    configured: isComplete(source),
    executionEnabled,
    confirmOrders,
    apiKey: source.apiKey,
    apiSecret: source.apiSecret,
    restEndpoint: endpoints.rest,
    webSocketEndpoint: endpoints.uds,
  };
}

function buildProfiles(
  source: NodeJS.ProcessEnv,
  resolvedActiveCredentials: CredentialPair,
  activeProfileId: ProfileId | null,
): ProfileRegistry {
  const testnetCredentials = readCredentialPair(
    source,
    "MAWS_BINANCE_TESTNET_API_KEY",
    "MAWS_BINANCE_TESTNET_API_SECRET",
  );
  const productionCredentials = readCredentialPair(
    source,
    "MAWS_BINANCE_PRODUCTION_API_KEY",
    "MAWS_BINANCE_PRODUCTION_API_SECRET",
  );
  if (activeProfileId === "binance-testnet") {
    testnetCredentials.apiKey = resolvedActiveCredentials.apiKey;
    testnetCredentials.apiSecret = resolvedActiveCredentials.apiSecret;
  }
  if (activeProfileId === "binance-production") {
    productionCredentials.apiKey = resolvedActiveCredentials.apiKey;
    productionCredentials.apiSecret = resolvedActiveCredentials.apiSecret;
  }

  return {
    "binance-testnet": makeProfile(
      "binance-testnet",
      "Binance Demo Trading",
      "testnet",
      testnetCredentials,
      isComplete(testnetCredentials),
      source.MAWS_BINANCE_TESTNET_CONFIRM_ORDERS === "true" || false,
    ),
    "binance-production": makeProfile(
      "binance-production",
      "Binance Live",
      "production",
      productionCredentials,
      isComplete(productionCredentials),
      source.MAWS_BINANCE_PRODUCTION_CONFIRM_ORDERS === "true" || false,
    ),
  };
}

/** Allowlisted metadata for authenticated server status/config responses. */
export function safeProfileMetadata(profiles: ProfileRegistry): SafeProfileMetadata[] {
  return PROFILE_IDS.map((profileId) => {
    const profile = profiles[profileId];
    return {
      profileId: profile.profileId,
      label: profile.label,
      environment: profile.environment,
      configured: profile.configured,
      requiresProductionConfirmation: profile.profileId === "binance-production",
      executionEnabled: profile.executionEnabled,
      confirmOrders: profile.confirmOrders ?? false,
    };
  });
}

function resolveCredentials(
  source: NodeJS.ProcessEnv,
  env: MawsEnv,
): { activeProfileId: ProfileId | null; activeCredentials: CredentialPair } {
  const legacy = readCredentialPair(source, "MAWS_BINANCE_API_KEY", "MAWS_BINANCE_API_SECRET");
  const testnet = readCredentialPair(
    source,
    "MAWS_BINANCE_TESTNET_API_KEY",
    "MAWS_BINANCE_TESTNET_API_SECRET",
  );
  const production = readCredentialPair(
    source,
    "MAWS_BINANCE_PRODUCTION_API_KEY",
    "MAWS_BINANCE_PRODUCTION_API_SECRET",
  );
  const activeProfileId = profileForEnvironment(env);
  const credentialProfileId = credentialProfileForEnvironment(env);
  const activeProfileCredentials =
    credentialProfileId === "binance-testnet"
      ? testnet
      : credentialProfileId === "binance-production"
        ? production
        : { apiKey: null, apiSecret: null };

  if (env === "local" && (legacy.apiKey !== null || legacy.apiSecret !== null)) {
    throw new Error("MAWS_ENV=local does not accept legacy Binance credentials; use profile-specific credentials");
  }
  assertCompletePair(testnet, "MAWS_BINANCE_TESTNET_API_KEY", "MAWS_BINANCE_TESTNET_API_SECRET");
  assertCompletePair(
    production,
    "MAWS_BINANCE_PRODUCTION_API_KEY",
    "MAWS_BINANCE_PRODUCTION_API_SECRET",
  );
  if (env !== "local") assertCompletePair(legacy, "MAWS_BINANCE_API_KEY", "MAWS_BINANCE_API_SECRET");

  if (env === "local") return { activeProfileId, activeCredentials: activeProfileCredentials };
  if (isComplete(legacy) && isComplete(activeProfileCredentials) && !pairsEqual(legacy, activeProfileCredentials)) {
    throw new Error(
      `${PROFILE_CONFIGURATION_ERROR}: legacy credentials conflict with the active profile credentials`,
    );
  }

  const activeCredentials = isComplete(activeProfileCredentials) ? activeProfileCredentials : legacy;
  if (!isComplete(activeCredentials)) {
    throw new Error(`MAWS_BINANCE_API_KEY/MAWS_BINANCE_API_SECRET are required when MAWS_ENV=${env}`);
  }
  return { activeProfileId, activeCredentials };
}

function parseEnv(raw: string | undefined): MawsEnv {
  const v = (raw ?? "local").trim().toLowerCase();
  if (v === "local" || v === "testnet" || v === "shadow" || v === "production") return v;
  throw new Error(`MAWS_ENV must be one of local|testnet|shadow|production, got: ${raw}`);
}

function parseBrokerType(raw: string | undefined): BrokerType {
  const v = (raw ?? "binance").trim().toLowerCase();
  if (v === "binance") return v;
  throw new Error(`MAWS_BROKER_TYPE must be 'binance' (only supported broker currently), got: ${raw}`);
}

function num(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric MAWS env value: ${raw}`);
  return n;
}

function hexKey(raw: string | undefined): Buffer | null {
  if (!raw || raw.trim() === "") return null;
  const t = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(t)) {
    throw new Error("MAWS_BACKUP_KEY must be 64 hex characters (32 bytes)");
  }
  return Buffer.from(t, "hex");
}

/** Reads and validates the server environment. Throws on invalid values (fail closed). */
export function loadEnvConfig(source: NodeJS.ProcessEnv = process.env): EnvConfig {
  const env = parseEnv(source.MAWS_ENV);
  const brokerType = parseBrokerType(source.MAWS_BROKER_TYPE);
  const defaultProfile = parseDefaultProfile(source.MAWS_DEFAULT_PROFILE);
  const { activeProfileId, activeCredentials } = resolveCredentials(source, env);
  const missingProductionRiskLimitVariables = PRODUCTION_RISK_LIMITS
    .map(([name]) => name)
    .filter((name) => !source[name]?.trim());
  const profiles = buildProfiles(
    source,
    activeCredentials,
    credentialProfileForEnvironment(env),
  );
  assertNoLegacyHosts(profiles);
  const cfg: EnvConfig = {
    env,
    brokerType,
    defaultProfile,
    activeProfileId,
    profiles,
    dbPath: source.MAWS_DB_PATH?.trim() || ".maws/maws.db",
    operatorAuth: source.MAWS_OPERATOR_AUTH?.trim() || null,
    allowedOrigin: source.MAWS_ALLOWED_ORIGIN?.trim() || null,
    trustProxy: source.MAWS_TRUST_PROXY === "true",
    backupKey: hexKey(source.MAWS_BACKUP_KEY),
    healthToken: source.MAWS_HEALTH_TOKEN?.trim() || null,
    emergencyToken: source.MAWS_EMERGENCY_TOKEN?.trim() || null,
    reverseEnabled: source.MAWS_ENABLE_REVERSE === "true",
    // Keep the legacy active fields so all existing broker code retains its
    // process-startup behavior while credentials migrate to profile variables.
    binanceApiKey: activeCredentials.apiKey,
    binanceApiSecret: activeCredentials.apiSecret,
    recvWindowMs: num(source.MAWS_RECV_WINDOW_MS, 5000),
    rateInternalPerMin: num(source.MAWS_RATE_INTERNAL_PER_MIN, 60),
    reconIntervalMs: num(source.MAWS_RECON_INTERVAL_MS, 60_000),
    markPriceIntervalMs: num(source.MAWS_MARK_PRICE_INTERVAL_MS, 15_000),
    historyBackfillMs: num(source.MAWS_HISTORY_BACKFILL_MS, 3 * 24 * 60 * 60 * 1000),
    leaseTtlMs: num(source.MAWS_LEASE_TTL_MS, 5 * 60_000),
    snapshotMaxAgeMs: num(source.MAWS_SNAPSHOT_MAX_AGE_MS, 5 * 60_000),
    protectionPendingMaxAgeMs: num(source.MAWS_PROTECTION_PENDING_MAX_AGE_MS, 2 * 60_000),
    alertWebhookUrl: source.MAWS_ALERT_WEBHOOK_URL?.trim() || null,
    missingProductionRiskLimitVariables,
    risk: {
      maxOrderNotionalUsd: num(source.MAWS_RISK_MAX_ORDER_NOTIONAL, 50),
      maxGrossExposureUsd: num(source.MAWS_RISK_MAX_GROSS_EXPOSURE, 100),
      maxOpenOrders: num(source.MAWS_RISK_MAX_OPEN_ORDERS, 10),
      maxOpenPositions: num(source.MAWS_RISK_MAX_OPEN_POSITIONS, 3),
      dailyLossPct: num(source.MAWS_RISK_DAILY_LOSS_PCT, 50),
      priceCollarPct: num(source.MAWS_RISK_PRICE_COLLAR_PCT, 5),
      maxLeverage: num(source.MAWS_RISK_MAX_LEVERAGE, 10),
      maxMarginRatio: num(source.MAWS_RISK_MAX_MARGIN_RATIO, 0.5),
      minLiquidationDistancePct: num(source.MAWS_RISK_MIN_LIQ_DISTANCE_PCT, 5),
    },
    circuitBreaker: {
      // Binance REST API breaker (open after 5 failures in 60s, retry after 30s)
      restFailureThreshold: num(source.MAWS_CB_REST_FAILURE_THRESHOLD, 5),
      restFailureWindowMs: num(source.MAWS_CB_REST_FAILURE_WINDOW_MS, 60_000),
      restRecoveryTimeoutMs: num(source.MAWS_CB_REST_RECOVERY_TIMEOUT_MS, 30_000),
      restSuccessThreshold: num(source.MAWS_CB_REST_SUCCESS_THRESHOLD, 2),
      // WebSocket stream breaker (open after 3 failures in 5min, retry after 60s)
      streamFailureThreshold: num(source.MAWS_CB_STREAM_FAILURE_THRESHOLD, 3),
      streamFailureWindowMs: num(source.MAWS_CB_STREAM_FAILURE_WINDOW_MS, 300_000),
      streamRecoveryTimeoutMs: num(source.MAWS_CB_STREAM_RECOVERY_TIMEOUT_MS, 60_000),
      streamSuccessThreshold: num(source.MAWS_CB_STREAM_SUCCESS_THRESHOLD, 1),
      // Reconciliation breaker (open after 3 failures in 10min, retry after 120s)
      reconFailureThreshold: num(source.MAWS_CB_RECON_FAILURE_THRESHOLD, 3),
      reconFailureWindowMs: num(source.MAWS_CB_RECON_FAILURE_WINDOW_MS, 600_000),
      reconRecoveryTimeoutMs: num(source.MAWS_CB_RECON_RECOVERY_TIMEOUT_MS, 120_000),
      reconSuccessThreshold: num(source.MAWS_CB_RECON_SUCCESS_THRESHOLD, 2),
    },
  };

  validateAuthTokens(cfg);
  if (env !== "local") {
    if (!cfg.operatorAuth) {
      throw new Error(`MAWS_OPERATOR_AUTH is required when MAWS_ENV=${env}`);
    }
    if (!/^[0-9a-f]{16,}:[0-9a-f]{16,}$/i.test(cfg.operatorAuth)) {
      throw new Error("MAWS_OPERATOR_AUTH must be '<hex salt>:<hex scrypt hash>'");
    }
  }

  // resolveCredentials above preserves the existing startup credential gate and
  // keeps shadow internal: it has production endpoints but no selectable profile ID.

  if (env === "production") {
    if (cfg.reverseEnabled) {
      throw new Error("MAWS_ENABLE_REVERSE cannot be enabled in production");
    }
    const error = productionRiskConfigurationError(cfg);
    if (error) throw new Error(error);
  }

  return cfg;
}

let cached: EnvConfig | null = null;

/** Process-wide config; loaded once so every module sees the same view. */
export function serverConfig(): EnvConfig {
  if (!cached) cached = loadEnvConfig();
  return cached;
}

/** Test seam. */
export function resetServerConfigForTests(cfg?: EnvConfig): void {
  cached = cfg ?? null;
}
