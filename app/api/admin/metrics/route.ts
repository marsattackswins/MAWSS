import { NextRequest, NextResponse } from "next/server";
import { metricsSnapshot } from "@/lib/server/metrics/collector";
import { pnl24h } from "@/lib/server/metrics/pnl";
import { serverConfig } from "@/lib/server/env/config";
import { authenticate, isAuthFailure } from "@/lib/server/http/guards";
import { verifyRequestToken } from "@/lib/server/auth/token-attempts";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/metrics
 * Returns current metrics snapshot (JSON format).
 * In local mode: No authentication required.
 * A health token receives only non-trading process metrics.
 */
export async function GET(req: NextRequest) {
  const cfg = serverConfig();

  let healthTokenOnly = false;
  if (cfg.env !== "local") {
    const ctx = authenticate(req, cfg);
    const tokenAttempt = verifyRequestToken(req, cfg, "x-maws-health-token", cfg.healthToken, "health");
    if (isAuthFailure(ctx)) {
      if (tokenAttempt.rateLimited) {
        return NextResponse.json({ error: "Too many invalid token attempts" }, { status: 429 });
      }
      if (!tokenAttempt.authorized) return ctx.response;
      healthTokenOnly = true;
    }
  }

  try {
    const snapshot = metricsSnapshot();
    if (healthTokenOnly) {
      return NextResponse.json({
        timestamp: Date.now(),
        uptime_seconds: Math.floor((Date.now() - snapshot.startTime) / 1000),
      });
    }

    // Unrealized P&L across open positions. Computed from
    // already-maintained in-memory state; no DB or network calls.
    const pnl = pnl24h();

    // Format for JSON response
    const response = {
      timestamp: Date.now(),
      uptime_seconds: Math.floor((Date.now() - snapshot.startTime) / 1000),
      pnl_24h: pnl,
      counters: snapshot.counters,
      gauges: snapshot.gauges,
      histograms: Object.entries(snapshot.histograms).reduce((acc, [key, hist]) => {
        acc[key] = {
          count: hist.count,
          sum: hist.sum,
          min: hist.min,
          max: hist.max,
          avg: hist.count > 0 ? hist.sum / hist.count : 0,
          p50: hist.p50,
          p95: hist.p95,
          p99: hist.p99,
        };
        return acc;
      }, {} as Record<string, unknown>),
      recent_events: snapshot.events.slice(-20),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Metrics error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to collect metrics",
        timestamp: Date.now(),
      },
      { status: 500 }
    );
  }
}
