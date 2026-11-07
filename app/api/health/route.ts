import { serverConfig } from "@/lib/server/env/config";
import { buildHealthStatus } from "@/lib/server/health/status";
import { authenticate, isAuthFailure, jsonError, jsonOk } from "@/lib/server/http/guards";
import { metricsSnapshot } from "@/lib/server/metrics/collector";
import { verifyRequestToken } from "@/lib/server/auth/token-attempts";
import packageJson from "../../../package.json";

export const dynamic = "force-dynamic";

/**
 * Operational health for monitoring. The health token receives a sanitized
 * status-only response; operator sessions retain the detailed response.
 */
export async function GET(req: Request): Promise<Response> {
  let cfg;
  try {
    cfg = serverConfig();
  } catch {
    return jsonError(503, "config", "Server configuration invalid");
  }

  let healthTokenAuthorized = false;
  if (cfg.env !== "local") {
    const sessionCheck = authenticate(req, cfg);
    const tokenAttempt = verifyRequestToken(req, cfg, "x-maws-health-token", cfg.healthToken, "health");
    if (isAuthFailure(sessionCheck)) {
      if (tokenAttempt.rateLimited) return jsonError(429, "token_rate_limited", "Too many invalid token attempts");
      if (!tokenAttempt.authorized) return sessionCheck.response;
      healthTokenAuthorized = true;
    }
  }

  // Initialize circuit breakers if needed
  const { initializeCircuitBreakers } = await import("@/lib/server/resilience/breakers");
  initializeCircuitBreakers();

  // Ensure the coordinator is started (workaround for instrumentation not running in dev).
  // Skip in test environment to avoid hanging.
  let runtimeCfg = cfg;
  if (process.env.NODE_ENV !== "test") {
    const coordinator = await import("@/lib/server/profile/coordinator");
    await coordinator.profileCoordinator().ensureStarted().catch(() => undefined);
    runtimeCfg = coordinator.activeProfileConfig();
  }

  const health = buildHealthStatus(runtimeCfg);
  const metrics = metricsSnapshot();
  const uptimeSeconds = Math.floor((Date.now() - metrics.startTime) / 1000);

  if (healthTokenAuthorized) {
    return jsonOk({
      env: health.env,
      healthy: health.healthy,
      version: packageJson.version,
      startedAt: metrics.startTime,
      brokerConnected: health.brokerConnected,
      managerStatus: health.signals.brokerStatus,
      managerReady: health.signals.managerRunning && health.signals.brokerStatus === "ready",
      clockHealthy: health.clockHealthy,
      streamHealthy: health.streamHealthy,
      reconHealthy: health.reconHealthy,
      protectionHealthy: health.protectionHealthy,
      positionModeHealthy: health.positionModeHealthy,
      circuitBreakersHealthy: health.circuitBreakersHealthy,
      openCircuitCount: health.openCircuits.length,
      uptimeSeconds,
    });
  }

  return jsonOk({
    env: health.env,
    healthy: health.healthy,
    version: packageJson.version,
    startedAt: metrics.startTime,
    brokerConnected: health.brokerConnected,
    managerStatus: health.signals.brokerStatus,
    managerError: health.signals.brokerError,
    managerReady: health.signals.managerRunning && health.signals.brokerStatus === "ready",
    clock: health.signals.clock,
    clockHealthy: health.clockHealthy,
    stream: health.signals.stream,
    streamHealthy: health.streamHealthy,
    recon: health.signals.recon,
    reconHealthy: health.reconHealthy,
    protectionHealthy: health.protectionHealthy,
    unprotectedPositions: health.unprotectedPositions,
    positionModeHealthy: health.positionModeHealthy,
    positionMode: health.signals.positionMode,
    circuitBreakersHealthy: health.circuitBreakersHealthy,
    openCircuits: health.openCircuits,
    circuitBreakerStates: health.circuitBreakerStates,
    execution: health.execution,
    submissionsFrozen: health.submissionsFrozen,
    frozenReasons: health.frozenReasons,
    uptimeSeconds,
    metrics,
  });
}
