import { audit } from "@/lib/server/audit/log";
import { serverConfig } from "@/lib/server/env/config";
import { profileCoordinator, ProfileCoordinatorError, profileErrorStatus } from "@/lib/server/profile/coordinator";
import { authenticate, isAuthFailure, jsonError, jsonOk } from "@/lib/server/http/guards";

export const dynamic = "force-dynamic";

/** Stop the attached profile only after the coordinator's exposure checks. */
export async function POST(req: Request): Promise<Response> {
  let cfg;
  try {
    cfg = serverConfig();
  } catch {
    return jsonError(503, "config", "Server configuration invalid");
  }
  const ctx = authenticate(req, cfg);
  if (isAuthFailure(ctx)) return ctx.response;
  try {
    const status = await profileCoordinator().detach();
    audit("operator", "live.detach", {}, ctx.ip);
    return jsonOk(status);
  } catch (error) {
    if (error instanceof ProfileCoordinatorError) {
      return jsonError(profileErrorStatus(error.code), error.code, "Profile operation could not be completed");
    }
    return jsonError(503, "detach_failed", "Profile could not be disconnected");
  }
}
