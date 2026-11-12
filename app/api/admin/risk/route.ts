import { NextRequest, NextResponse } from "next/server";
import { accountDto, ordersDto, positionsDto } from "@/lib/server/binance/dto";
import { realizedSinceUtcMidnight } from "@/lib/server/binance/risk";
import { aggregateRiskCockpit } from "@/lib/server/risk/cockpit";
import { serverConfig } from "@/lib/server/env/config";
import { activeProfileConfig, activeProfileManager } from "@/lib/server/profile/coordinator";
import { authenticate, isAuthFailure } from "@/lib/server/http/guards";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/risk
 * Returns a read-only risk and exposure snapshot from server-owned live state.
 * While Disconnected it returns configured limits without trading state.
 */
export async function GET(req: NextRequest) {
  const cfg = serverConfig();
  const runtimeCfg = activeProfileConfig();

  const ctx = authenticate(req, cfg);
  if (isAuthFailure(ctx)) return ctx.response;

  try {
    const sourceAvailable = activeProfileManager() !== null;
    const snapshot = aggregateRiskCockpit({
      env: runtimeCfg.env,
      risk: runtimeCfg.risk,
      account: sourceAvailable ? accountDto() : null,
      positions: sourceAvailable ? positionsDto() : [],
      orders: sourceAvailable ? ordersDto() : [],
      realizedTodayUsd: sourceAvailable ? realizedSinceUtcMidnight() : 0,
      sourceAvailable,
    });

    return NextResponse.json(snapshot, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("Risk cockpit error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to collect risk snapshot",
        timestamp: Date.now(),
      },
      { status: 500 },
    );
  }
}
