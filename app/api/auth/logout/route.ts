import { revokeSession } from "@/lib/server/auth/session";
import { serverConfig } from "@/lib/server/env/config";
import { audit } from "@/lib/server/audit/log";
import { authenticate, isAuthFailure, clearSessionCookieAttributes, jsonError, jsonOk } from "@/lib/server/http/guards";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let cfg;
  try {
    cfg = serverConfig();
  } catch {
    return jsonError(503, "config", "Server configuration invalid");
  }
  const auth = authenticate(req, cfg);
  if (isAuthFailure(auth)) return auth.response;
  const revoked = revokeSession(auth.sessionId);
  audit("operator", "logout", { revoked }, auth.ip);
  return jsonOk({ ok: true }, { headers: { "set-cookie": clearSessionCookieAttributes(cfg) } });
}
