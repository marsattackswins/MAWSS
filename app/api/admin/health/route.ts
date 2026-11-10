import { NextRequest, NextResponse } from "next/server";
import { buildAdminHealthStatus } from "@/lib/server/health/status";
import { metricsSnapshot } from "@/lib/server/metrics/collector";
import { serverConfig } from "@/lib/server/env/config";

import { authenticate, isAuthFailure } from "@/lib/server/http/guards";
import { verifyRequestToken } from "@/lib/server/auth/token-attempts";

/**
 * GET /api/admin/health
 * Returns health status of all components.
 * In local mode: No authentication required.
 * A health token receives component health only; operator sessions receive
 * the full trading health response.
 */
export async function GET(req: NextRequest) {
  const cfg = serverConfig();

  // Local mode is intentionally unauthenticated, but it still reports the
  // real manager, stream, database, and metrics state below.
  if (cfg.env !== "local") {
    // Non-local mode: check authentication
    const ctx = authenticate(req, cfg);
    const tokenAttempt = verifyRequestToken(req, cfg, "x-maws-health-token", cfg.healthToken, "health");
    if (isAuthFailure(ctx)) {
      if (tokenAttempt.rateLimited) {
        return NextResponse.json({ error: "Too many invalid token attempts" }, { status: 429 });
      }
      if (!tokenAttempt.authorized) return ctx.response;
      try {
        const health = buildAdminHealthStatus(cfg);
        return NextResponse.json({
          overall: health.overall,
          components: Object.fromEntries(
            Object.entries(health.components).map(([name, component]) => [
              name,
              { status: component.status, lastCheck: component.lastCheck },
            ]),
          ),
          uptime: health.uptime,
          lastUpdated: health.lastUpdated,
        });
      } catch (error) {
        console.error("Health check error:", error);
        return NextResponse.json({ overall: "down" }, { status: 500 });
      }
    }
  }

  try {
    const health = buildAdminHealthStatus(cfg);
    return NextResponse.json({ ...health, metrics: metricsSnapshot() });
  } catch (error) {
    console.error("Health check error:", error);
    return NextResponse.json(
      {
        overall: "down",
        error: error instanceof Error ? error.message : "Health check failed",
        lastUpdated: Date.now(),
      },
      { status: 500 }
    );
  }
}
