import type { NextRequest } from "next/server";
import { BINANCE_FAPI_REST } from "@/lib/market/binance-intervals";
import { mapUpstreamError, upstreamErrorResponse } from "@/lib/server/validation/proxy-error";
import { tickerAggregator } from "@/lib/server/log/market-logger";
import { serverConfig } from "@/lib/server/env/config";
import { resolveOperatorSession } from "@/lib/server/auth/session-guard";
import { canReadPublicDataWithoutSession } from "@/lib/server/auth/local-dev";

export const dynamic = "force-dynamic";

/**
 * Proxy Binance USDT-M 24h ticker (includes openPrice + priceChangePercent).
 * GET /api/binance/ticker           → all symbols
 * GET /api/binance/ticker?symbol=X  → one symbol
 */
export async function GET(req: NextRequest) {
  let cfg;
  try {
    cfg = serverConfig();
  } catch {
    return Response.json({ error: "Service unavailable" }, { status: 503 });
  }
  if (!resolveOperatorSession(req.headers.get("cookie"), cfg) && !canReadPublicDataWithoutSession(req)) {
    return Response.json(
      { error: { code: "unauthenticated", message: "Sign in required" } },
      { status: 401 },
    );
  }

  const start = Date.now();
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "").toUpperCase();
  if (symbol && !/^[A-Z0-9]{4,32}$/.test(symbol)) {
    tickerAggregator.record(symbol || "invalid", Date.now() - start, false, "400 Invalid symbol format");
    return Response.json({ error: "Invalid symbol" }, { status: 400 });
  }

  const url = symbol
    ? `${BINANCE_FAPI_REST}/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`
    : `${BINANCE_FAPI_REST}/fapi/v1/ticker/24hr`;

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) {
      tickerAggregator.record(symbol || "ALL", Date.now() - start, false, `${res.status} ${res.statusText || "Upstream Error"}`);
      return mapUpstreamError(res.status);
    }
    const body = await res.text();
    tickerAggregator.record(symbol || "ALL", Date.now() - start, true);
    return new Response(body, {
      status: res.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    tickerAggregator.record(symbol || "ALL", Date.now() - start, false, "Network error or fetch failed");
    return upstreamErrorResponse();
  }
}
