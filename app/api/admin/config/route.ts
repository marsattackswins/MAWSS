import { NextRequest, NextResponse } from "next/server";
import { serverConfig, HOST_MAP, safeProfileMetadata, type EnvConfig } from "@/lib/server/env/config";
import { authenticate, isAuthFailure } from "@/lib/server/http/guards";

export const dynamic = "force-dynamic";

/**
 * Field descriptions for the config response.
 * Each key maps to a human-readable description.
 */
const FIELD_DESCRIPTIONS: Record<string, string> = {
  env: "Configured trading environment (testnet or production)",
  defaultProfile: "Default profile preference (does not attach anything at startup)",
  activeProfileId: "Currently attached profile; null while Disconnected",
  brokerType: "Broker type (currently only 'binance' supported)",
  dbPath: "Path to the SQLite database file",
  allowedOrigin: "Allowed CORS origin for browser requests",
  trustProxy: "Whether to trust X-Forwarded-For header for client IP",

  recvWindowMs: "Binance API request validity window in milliseconds",
  rateInternalPerMin: "Maximum internal requests per minute",
  reconIntervalMs: "Interval between reconciliation runs in milliseconds",
  leaseTtlMs: "Lease time-to-live for distributed locking in milliseconds",
  gateSnapshotMaxAgeMs: "Maximum age of the authoritative account snapshot for the execution gate, in milliseconds",
  riskDataMaxAgeMs: "Maximum age of account, margin and liquidation data used by risk checks, in milliseconds",
  alertWebhookUrl: "Webhook URL for alert notifications",
  "risk.maxOrderNotionalUsd": "Maximum order size in USD",
  "risk.maxGrossExposureUsd": "Maximum total exposure across all positions in USD",
  "risk.maxOpenOrders": "Maximum number of open orders allowed",
  "risk.maxOpenPositions": "Maximum number of open positions allowed",
  "risk.dailyLossPct": "Daily loss limit as percentage (triggers freeze)",
  "risk.priceCollarPct": "Price deviation collar percentage for validation",
  "circuitBreaker.restFailureThreshold": "REST API breaker: failures before opening",
  "circuitBreaker.restFailureWindowMs": "REST API breaker: failure counting window in ms",
  "circuitBreaker.restRecoveryTimeoutMs": "REST API breaker: recovery timeout in ms",
  "circuitBreaker.restSuccessThreshold": "REST API breaker: successes needed to close",
  "circuitBreaker.streamFailureThreshold": "WebSocket breaker: failures before opening",
  "circuitBreaker.streamFailureWindowMs": "WebSocket breaker: failure counting window in ms",
  "circuitBreaker.streamRecoveryTimeoutMs": "WebSocket breaker: recovery timeout in ms",
  "circuitBreaker.streamSuccessThreshold": "WebSocket breaker: successes needed to close",
  "circuitBreaker.reconFailureThreshold": "Reconciliation breaker: failures before opening",
  "circuitBreaker.reconFailureWindowMs": "Reconciliation breaker: failure counting window in ms",
  "circuitBreaker.reconRecoveryTimeoutMs": "Reconciliation breaker: recovery timeout in ms",
  "circuitBreaker.reconSuccessThreshold": "Reconciliation breaker: successes needed to close",
};

/**
 * Explicit allowlist: the response is built only from these fields, so a
 * newly added sensitive config field (credentials, auth material, tokens)
 * cannot leak by default. The profile registry is replaced by
 * safeProfileMetadata in the response.
 */
function safeConfigResponse(cfg: EnvConfig): unknown {
  return {
    env: cfg.env,
    defaultProfile: cfg.defaultProfile,
    activeProfileId: cfg.activeProfileId,
    brokerType: cfg.brokerType,
    dbPath: cfg.dbPath,
    allowedOrigin: cfg.allowedOrigin,
    trustProxy: cfg.trustProxy,
    recvWindowMs: cfg.recvWindowMs,
    rateInternalPerMin: cfg.rateInternalPerMin,
    reconIntervalMs: cfg.reconIntervalMs,
    markPriceIntervalMs: cfg.markPriceIntervalMs,
    historyBackfillMs: cfg.historyBackfillMs,
    leaseTtlMs: cfg.leaseTtlMs,
    gateSnapshotMaxAgeMs: cfg.gateSnapshotMaxAgeMs,
    riskDataMaxAgeMs: cfg.riskDataMaxAgeMs,
    protectionPendingMaxAgeMs: cfg.protectionPendingMaxAgeMs,
    alertWebhookUrl: cfg.alertWebhookUrl,
    risk: { ...cfg.risk },
    circuitBreaker: { ...cfg.circuitBreaker },
  };
}

/**
 * GET /api/admin/config
 * Returns non-secret runtime configuration as JSON. Requires operator
 * authentication.
 *
 * Response shape:
 * {
 *   config: { ... allowlisted config ... },
 *   profileMetadata: [ ... safe profile metadata ... ],
 *   descriptions: { "field.path": "description", ... },
 *   host: { rest: string, uds: string, label: string }
 * }
 */
export async function GET(req: NextRequest) {
  let cfg;
  try {
    cfg = serverConfig();
  } catch {
    return NextResponse.json(
      { error: "Server configuration invalid" },
      { status: 503 }
    );
  }

  const ctx = authenticate(req, cfg);
  if (isAuthFailure(ctx)) {
    return ctx.response;
  }

  return NextResponse.json({
    config: safeConfigResponse(cfg),
    profileMetadata: safeProfileMetadata(cfg.profiles),
    descriptions: FIELD_DESCRIPTIONS,
    host: HOST_MAP[cfg.env],
  });
}
