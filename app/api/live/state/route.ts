import { accountDto, accountMetricsDto, fillsDto, ordersDto, positionsDto } from "@/lib/server/binance/dto";
import { serverConfig } from "@/lib/server/env/config";
import { authenticate, isAuthFailure, jsonError, jsonOk } from "@/lib/server/http/guards";
import { localDevEnabled } from "@/lib/server/auth/local-dev";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  let cfg;
  try {
    cfg = serverConfig();
  } catch {
    return jsonError(503, "config", "Server configuration invalid");
  }
  const ctx = authenticate(req, cfg);
  if (isAuthFailure(ctx)) {
    // The one account read a Disconnected, signed-out chart may make: it says
    // only that nothing is attached and that connecting needs a login. No
    // balances, positions, orders or fills are ever produced without a session.
    if (ctx.response.status === 401 && localDevEnabled()) {
      return jsonOk({ attached: false, loginRequired: true });
    }
    return ctx.response;
  }
  return jsonOk({
    account: accountDto(),
    accountMetrics: accountMetricsDto(),
    positions: positionsDto(),
    orders: ordersDto(),
    fills: fillsDto(50),
  });
}
