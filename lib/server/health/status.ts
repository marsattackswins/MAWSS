import "server-only";

import type { EnvConfig } from "../env/config";
import { persistenceProfileFromConfig } from "../profile/context";
import { executionDecision, type ExecutionDecision } from "../gates/execution";
import { getMetrics, METRICS } from "../metrics/collector";
import { liveState } from "../binance/state";
import { getRuntime, RUNTIME_KEYS } from "../runtime/flags";

import { getDb } from "../db/connection";
import { databaseStats, type DbStats } from "../db/stats";

import { healthSignals, type HealthSignals } from "./state";
import { circuitRegistry } from "../resilience/circuit-registry";
import { unprotectedProtectionSymbols } from "../binance/protection";

export interface HealthStatus {
  env: string;
  brokerConnected: boolean;
  signals: HealthSignals;
  execution: ExecutionDecision;
  clockHealthy: boolean;
  streamHealthy: boolean;
  reconHealthy: boolean;
  positionModeHealthy: boolean;
  circuitBreakersHealthy: boolean;
  openCircuits: string[];
  circuitBreakerStates: Record<string, string>;
  submissionsFrozen: boolean;
  frozenReasons: string[];
  protectionHealthy: boolean;
  unprotectedPositions: string[];
  /** Size and row counts; `sizeWarning` is set above MAWS_DB_SIZE_WARN_BYTES. */
  database: DbStats;
  healthy: boolean;
}

const CLOCK_STALE_MS = 5 * 60 * 1000;
const CLOCK_MAX_OFFSET_MS = 1000;
const STREAM_STALE_MS = 60 * 1000;
const PRIVATE_STREAM_HEARTBEAT_MS = 5 * 60 * 1000;

export interface ComponentHealth {
  status: "healthy" | "degraded" | "down";
  message: string;
  lastCheck: number;
}

export interface AdminHealthStatus {
  overall: "healthy" | "degraded" | "down";
  components: {
    webSocket: ComponentHealth;
    api: ComponentHealth;
    clock: ComponentHealth;
    database: ComponentHealth;
  };
  trading: {
    openOrders: number;
    openPositions: number;
    grossExposureUsd: number;
    balanceUsd: number;
    frozen: boolean;
    executionEnabled: boolean;
    unprotectedPositions: string[];
    protectionHealthy: boolean;
  };
  uptime: {
    seconds: number;
    formatted: string;
  };
  lastUpdated: number;
  managerStatus: string;
  managerError: string | null;
  managerReady: boolean;
  streamHealthy: boolean;
  reconHealthy: boolean;
  positionModeHealthy: boolean;
  positionMode: { mode: string; checkedAt: number | null; error: string | null };
  circuitBreakersHealthy: boolean;
  openCircuits: string[];
  circuitBreakerStates: Record<string, string>;
}

export function buildHealthStatus(cfg: EnvConfig): HealthStatus {
  const signals = healthSignals();
  const execution = executionDecision(cfg);
  const openSymbols = new Set(liveState().positions.keys());
  const unprotectedPositions = unprotectedProtectionSymbols(persistenceProfileFromConfig(cfg))
    .filter((symbol) => openSymbols.has(symbol));
  const protectionHealthy = unprotectedPositions.length === 0;

  const now = Date.now();
  const circuitStats = circuitRegistry.getAllStats();
  const circuitBreakerStates = Object.fromEntries(Object.entries(circuitStats).map(([name, stats]) => [name, stats.state]));
  const unhealthyCircuits = Object.entries(circuitBreakerStates).filter(([, state]) => state !== "closed").map(([name]) => name);
  const circuitBreakersHealthy = unhealthyCircuits.length === 0;
  const positionModeHealthy = signals.positionMode.mode === "one-way" && signals.positionMode.error == null;

  // Health requires actual clock/stream data. While Disconnected (no attached
  // manager) every runtime signal is simply absent, so the report reads
  // unhealthy for trading components without implying a server failure.
  const clockHealthy =
    signals.clock != null &&
    now - signals.clock.updatedAt < CLOCK_STALE_MS &&
    Math.abs(signals.clock.offsetMs) <= CLOCK_MAX_OFFSET_MS;

  const applicationHeartbeatAt = signals.stream?.lastApplicationEventAt ?? null;
  const heartbeatHealthy = applicationHeartbeatAt == null || now - applicationHeartbeatAt < PRIVATE_STREAM_HEARTBEAT_MS;
  const streamHealthy =
    signals.stream != null &&
    signals.stream.connected &&
    signals.stream.leaseOwned === true &&
    !signals.stream.bufferOverflow &&
    signals.stream.circuitState !== "open" &&
    (signals.stream.lastEventAt == null || now - signals.stream.lastEventAt < STREAM_STALE_MS) &&
    heartbeatHealthy;

  const openCircuits = circuitRegistry.getOpenCircuits();
  const reconCircuitOpen = unhealthyCircuits.includes("reconciliation");
  const reconHealthy = signals.recon.lastResult !== "drift" && signals.recon.lastResult !== "error" && !reconCircuitOpen;

  const frozenReasons = [...execution.reasons];
  if (!protectionHealthy) frozenReasons.push(`Unprotected positions: ${unprotectedPositions.join(", ")}`);
  if (!circuitBreakersHealthy) {
    frozenReasons.push(`Circuit breakers degraded: ${unhealthyCircuits.join(", ")}`);
  }
  const submissionsFrozen = !execution.canSubmit;

  return {
    env: cfg.env,
    brokerConnected: signals.managerRunning && signals.brokerStatus === "ready" && streamHealthy && positionModeHealthy,
    signals,
    execution,
    clockHealthy,
    streamHealthy,
    reconHealthy,
    positionModeHealthy,
    circuitBreakersHealthy,
    openCircuits,
    circuitBreakerStates,
    submissionsFrozen,
    frozenReasons,
    protectionHealthy,
    unprotectedPositions,
    database: databaseStats(now),
    healthy: signals.managerRunning && signals.brokerStatus === "ready" && clockHealthy && streamHealthy && reconHealthy && positionModeHealthy && circuitBreakersHealthy && protectionHealthy && !submissionsFrozen,
  };
}

/**
 * Builds the legacy admin dashboard contract from the operational health
 * snapshot. The detailed component fields remain presentation-specific, while
 * manager, stream, reconciliation, position, and circuit state come from the
 * single operational health calculation above.
 */
export function buildAdminHealthStatus(cfg: EnvConfig): AdminHealthStatus {
  const profile = persistenceProfileFromConfig(cfg);
  const metrics = getMetrics();
  const now = Date.now();
  const state = liveState();
  const signals = healthSignals();
  const operational = buildHealthStatus(cfg);

  const lastEventAge = state.lastEventTime ? now - state.lastEventTime : null;
  const streamMessage = !signals.managerRunning || signals.brokerStatus !== "ready"
    ? `Manager ${signals.brokerStatus}`
    : operational.streamHealthy
      ? lastEventAge !== null
        ? `Last event ${Math.floor(lastEventAge / 1000)}s ago`
        : "Connected; no application event yet"
      : signals.stream?.phase === "standby"
        ? "Stream lease is owned by another process"
        : "Private stream degraded";
  const webSocket: ComponentHealth = {
    status: operational.streamHealthy ? "healthy" : signals.stream?.connected ? "degraded" : "down",
    message: streamMessage,
    lastCheck: now,
  };

  const apiErrors = metrics.getCounter(METRICS.API_ERROR);
  const apiRequests = metrics.getCounter(METRICS.API_REQUEST);
  const errorRate = apiRequests > 0 ? apiErrors / apiRequests : 0;
  const api: ComponentHealth = {
    status: errorRate < 0.05 ? "healthy" : errorRate < 0.2 ? "degraded" : "down",
    message: apiRequests > 0
      ? `${apiErrors} errors / ${apiRequests} requests (${(errorRate * 100).toFixed(1)}%)`
      : "No requests yet",
    lastCheck: now,
  };

  const clock: ComponentHealth = {
    status: operational.clockHealthy ? "healthy" : "degraded",
    message: operational.clockHealthy ? "Synced" : "Drift detected",
    lastCheck: now,
  };

  let database: ComponentHealth;
  try {
    getDb().prepare("SELECT 1 AS ok").get();
    database = { status: "healthy", message: "Operational", lastCheck: now };
  } catch (err) {
    database = { status: "down", message: `SQLite unavailable: ${String(err)}`, lastCheck: now };
  }

  const frozen = getRuntime(RUNTIME_KEYS.frozen, "", profile) === "true";
  const executionEnabled = getRuntime(RUNTIME_KEYS.executionEnabled, "", profile) === "true";
  const componentStatuses: ComponentHealth["status"][] = [
    webSocket.status,
    api.status,
    clock.status,
    database.status,
  ];
  if (!operational.reconHealthy || !operational.protectionHealthy || !operational.positionModeHealthy) {
    componentStatuses.push("degraded");
  }

  const overall = componentStatuses.every((status) => status === "healthy")
    ? "healthy"
    : componentStatuses.some((status) => status === "down")
      ? "down"
      : "degraded";
  const uptimeSeconds = metrics.getUptimeSeconds();

  return {
    overall,
    components: { webSocket, api, clock, database },
    trading: {
      openOrders: state.openOrders.size,
      openPositions: state.positions.size,
      grossExposureUsd: metrics.getGauge(METRICS.GROSS_EXPOSURE_USD),
      balanceUsd: metrics.getGauge(METRICS.BALANCE_USD),
      frozen,
      executionEnabled,
      unprotectedPositions: operational.unprotectedPositions,
      protectionHealthy: operational.protectionHealthy,
    },
    uptime: {
      seconds: uptimeSeconds,
      formatted: formatUptime(uptimeSeconds),
    },
    lastUpdated: now,
    managerStatus: signals.brokerStatus,
    managerError: signals.brokerError,
    managerReady: signals.managerRunning && signals.brokerStatus === "ready",
    streamHealthy: operational.streamHealthy,
    reconHealthy: operational.reconHealthy,
    positionModeHealthy: operational.positionModeHealthy,
    positionMode: signals.positionMode,
    circuitBreakersHealthy: operational.circuitBreakersHealthy,
    openCircuits: operational.openCircuits,
    circuitBreakerStates: operational.circuitBreakerStates,
  };
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}
