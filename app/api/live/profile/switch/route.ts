import { serverConfig } from "@/lib/server/env/config";
import { authenticate, isAuthFailure, jsonError, jsonOk, readJson } from "@/lib/server/http/guards";
import {
  ProfileCoordinatorError,
  profileCoordinator,
  profileErrorStatus,
  type ProfileSwitchRequest,
} from "@/lib/server/profile/coordinator";

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
  const body = await readJson<ProfileSwitchRequest>(req);
  if (!body || typeof body !== "object" || !("profileId" in body)) {
    return jsonError(400, "invalid_profile", "A supported profileId is required");
  }
  const allowedKeys = new Set(["profileId", "confirmProduction", "requestId"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    return jsonError(400, "invalid_profile", "Only profileId, confirmation, and requestId are accepted");
  }
  try {
    return jsonOk(await profileCoordinator().switchProfile(body));
  } catch (error) {
    if (error instanceof ProfileCoordinatorError) {
      const message = error.code === "production_risk_limits_invalid"
        ? error.message
        : "Profile operation could not be completed";
      return jsonError(profileErrorStatus(error.code), error.code, message);
    }
    return jsonError(503, "target_start_failed", "Profile operation could not be completed");
  }
}
