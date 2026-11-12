import { audit } from "@/lib/server/audit/log";
import { getBroker } from "@/lib/server/broker/factory";
import { serverConfig } from "@/lib/server/env/config";
import { authenticate, isAuthFailure, jsonError, jsonOk } from "@/lib/server/http/guards";
import { clientIp } from "@/lib/server/auth/guard";
import { verifyRequestToken } from "@/lib/server/auth/token-attempts";
import { runBrokerMutation } from "@/lib/server/response/broker-mutation";
import { assertProfileMutationRequest, ProfileCoordinatorError, profileErrorStatus } from "@/lib/server/profile/coordinator";

export const dynamic = "force-dynamic";

/** Cancel every working order and submit reduce-only market closes. */
export async function POST(req: Request): Promise<Response> {
  let cfg;
  try {
    cfg = serverConfig();
  } catch {
    return jsonError(503, "config", "Server configuration invalid");
  }

  const auth = authenticate(req, cfg);
  const tokenAttempt = verifyRequestToken(req, cfg, "x-maws-emergency-token", cfg.emergencyToken, "emergency");
  const emergencyTokenAuthorized = tokenAttempt.authorized;
  // Authorization comes first so an anonymous caller cannot learn attachment
  // state (409 not_connected) before proving a session or emergency token.
  if (isAuthFailure(auth)) {
    if (tokenAttempt.rateLimited) return jsonError(429, "token_rate_limited", "Too many invalid token attempts");
    if (!emergencyTokenAuthorized) return auth.response;
  }
  try {
    // Emergency actions bypass the freeze/kill-switch gates but still require
    // an attached profile: while Disconnected this rejects with 409 not_connected.
    assertProfileMutationRequest(req);
  } catch (error) {
    if (error instanceof ProfileCoordinatorError) return jsonError(profileErrorStatus(error.code), error.code, "Profile runtime changed; retry the request");
    throw error;
  }
  const authorizedBy = isAuthFailure(auth) ? "emergency_token" : "session";
  const triggeredBy = isAuthFailure(auth) ? "system:emergency-token" : `operator:${auth.sessionId}`;
  const auditIp = isAuthFailure(auth) ? clientIp(req, cfg) : auth.ip;

  audit("operator", "emergency.flatten.authorized", { authorizedBy }, auditIp);

  let result;
  try {
    result = await runBrokerMutation(
      () => {
        assertProfileMutationRequest(req);
        return getBroker().emergencyFlatten(triggeredBy);
      },
    );
  } catch (error) {
    if (error instanceof ProfileCoordinatorError) return jsonError(profileErrorStatus(error.code), error.code, "Profile runtime changed; retry the request");
    throw error;
  }
  if (result instanceof Response) return result;

  audit("operator", "emergency.flatten.requested", {
    authorizedBy,
    triggeredBy,
    canceled: result.canceledOrderIds.length,
    closed: result.closedPositions.length,
    failures: result.failures.length,
  }, auditIp);
  return jsonOk(result, { status: result.failures.length > 0 ? 207 : 200 });
}
