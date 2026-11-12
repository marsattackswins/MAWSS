import { resolveOperatorSession } from "@/lib/server/auth/session-guard";
import { HOST_MAP, serverConfig } from "@/lib/server/env/config";
import { profileRuntimeStatus } from "@/lib/server/profile/coordinator";
import { jsonOk } from "@/lib/server/http/guards";

export const dynamic = "force-dynamic";

/** Anonymous bootstrap exposes no configuration or attachment information. */
export async function GET(req: Request): Promise<Response> {
  let cfg;
  try {
    cfg = serverConfig();
  } catch {
    return jsonOk({ authenticated: false });
  }
  const session = resolveOperatorSession(req.headers.get("cookie"), cfg);
  if (!session) return jsonOk({ authenticated: false });
  const status = profileRuntimeStatus();
  return jsonOk({
    authenticated: true,
    csrf: session.csrfToken,
    env: status.environment,
    envLabel: status.environment ? HOST_MAP[status.environment].label : null,
    profileId: status.profileId,
    connectedBroker: status.profileId ? "binance" : "",
    profile: status,
    sessionExpiresAt: session.expiresAt,
  });
}
