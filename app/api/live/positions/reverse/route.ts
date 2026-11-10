import { audit } from "@/lib/server/audit/log";
import { getBroker } from "@/lib/server/broker/factory";
import { serverConfig } from "@/lib/server/env/config";
import { authenticate, isAuthFailure, jsonError, jsonOk, readJson } from "@/lib/server/http/guards";
import { runBrokerMutation } from "@/lib/server/response/broker-mutation";
import { withMutationLog } from "@/lib/server/log/request-log";
import { observeLiveMutationLatency, LIVE_MUTATION_OPERATIONS } from "@/lib/server/metrics/collector";
import { checkRateLimit, recordRequest, rateLimitedResponse } from "@/lib/server/rate-limit";
import { assertProfileMutationRequest, ProfileCoordinatorError, profileErrorStatus } from "@/lib/server/profile/coordinator";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return withMutationLog(req, async (logCtx) => {
    let cfg;
    try {
      cfg = serverConfig();
    } catch {
      return jsonError(503, "config", "Server configuration invalid");
    }
    const ctx = authenticate(req, cfg, { allowLocal: true });
    if (isAuthFailure(ctx)) return ctx.response;
    try {
      assertProfileMutationRequest(req);
    } catch (error) {
      if (error instanceof ProfileCoordinatorError) {
        return jsonError(profileErrorStatus(error.code), error.code, "Profile runtime changed; retry the request");
      }
      throw error;
    }

    const body = await readJson<{
      symbol?: unknown;
      newQty?: unknown;
      expectedPositionQty?: unknown;
      expectedPositionSide?: unknown;
      clientOrderId?: unknown;
    }>(req);
    if (
      !body ||
      typeof body.symbol !== "string" ||
      typeof body.newQty !== "string" ||
      typeof body.expectedPositionQty !== "string" ||
      (body.expectedPositionSide !== "long" && body.expectedPositionSide !== "short") ||
      typeof body.clientOrderId !== "string"
    ) {
      return jsonError(400, "bad_request", "symbol, newQty, expected position side/quantity, and clientOrderId are required");
    }
    const symbol = body.symbol;
    const newQty = body.newQty;
    const expectedPositionQty = body.expectedPositionQty;
    const expectedPositionSide = body.expectedPositionSide;
    const clientOrderId = body.clientOrderId;
    logCtx.symbol = symbol;

    const rate = checkRateLimit(symbol, LIVE_MUTATION_OPERATIONS.REVERSE_POSITION);
    if (!rate.allowed) {
      return rateLimitedResponse(rate.retryAfterSec, rate.limit, rate.remaining, rate.resetAt);
    }
    const start = performance.now();
    let result;
    try {
      result = await runBrokerMutation(
        () => {
          assertProfileMutationRequest(req);
          return getBroker().reversePosition({
            symbol,
            newQty,
            expectedPositionQty,
            expectedPositionSide,
            clientOrderId,
          });
        },
        { symbol },
      );
    } catch (error) {
      if (error instanceof ProfileCoordinatorError) {
        return jsonError(profileErrorStatus(error.code), error.code, "Profile runtime changed; retry the request");
      }
      audit("operator", "position.ui.reverse_failed", {
        symbol,
        clientOrderId,
        error: String(error),
      }, ctx.ip);
      throw error;
    }
    observeLiveMutationLatency(
      symbol,
      LIVE_MUTATION_OPERATIONS.REVERSE_POSITION,
      Math.round(performance.now() - start),
    );
    recordRequest(symbol, LIVE_MUTATION_OPERATIONS.REVERSE_POSITION);
    if (result instanceof Response) return result;

    audit("operator", result.ok ? "position.ui.reversed" : "position.ui.reverse_rejected", {
      symbol,
      clientOrderId,
      resultingPosition: result.resultingPosition,
      error: result.error,
    }, ctx.ip);
    return jsonOk(result, { status: result.ok ? 200 : 422 });
  });
}
