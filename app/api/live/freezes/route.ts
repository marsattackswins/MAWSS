import { audit } from "@/lib/server/audit/log";
import { serverConfig } from "@/lib/server/env/config";
import { authenticate, isAuthFailure, jsonError, jsonOk, readJson } from "@/lib/server/http/guards";
import { activeProfileConfig } from "@/lib/server/profile/coordinator";
import { persistenceProfileFromConfig } from "@/lib/server/profile/context";
import { checkRateLimit, rateLimitedResponse, recordRequest } from "@/lib/server/rate-limit";
import { FREEZE_DEFINITIONS, freezeStatuses, type FreezeCode } from "@/lib/server/binance/freeze";
import { currentFreezeContext, operatorUnfreeze } from "@/lib/server/binance/operator-unfreeze";

export const dynamic = "force-dynamic";

/** Operator token headers have their own routes; this one is session-only. */
const OPERATOR_TOKEN_HEADERS = ["x-maws-health-token", "x-maws-emergency-token", "authorization"];

/**
 * Active submission freezes, each with the evidence it still needs. Readable
 * while detached so an operator can see what is holding submissions closed.
 */
export async function GET(req: Request): Promise<Response> {
  let cfg;
  try {
    cfg = serverConfig();
  } catch {
    return jsonError(503, "config", "Server configuration invalid");
  }
  const ctx = authenticate(req, cfg);
  if (isAuthFailure(ctx)) return ctx.response;

  const profile = persistenceProfileFromConfig(activeProfileConfig());
  const freezes = freezeStatuses(currentFreezeContext(Date.now(), profile), profile);
  return jsonOk({ frozen: freezes.length > 0, freezes });
}

/**
 * Explicit operator unfreeze. Requires the operator session (cookie + CSRF +
 * Origin) and `confirm: true` in the body. It clears only freezes whose own
 * clear condition is met and never enables execution or the kill switch.
 */
export async function POST(req: Request): Promise<Response> {
  let cfg;
  try {
    cfg = serverConfig();
  } catch {
    return jsonError(503, "config", "Server configuration invalid");
  }
  // A service token must never reach the operator surface, even when its value
  // happens to be valid elsewhere: refuse before the session guard so the
  // failure is explicit rather than a generic 401.
  for (const header of OPERATOR_TOKEN_HEADERS) {
    if (req.headers.get(header)) {
      return jsonError(403, "operator_session_required", "Token-authenticated callers cannot unfreeze");
    }
  }
  const ctx = authenticate(req, cfg);
  if (isAuthFailure(ctx)) return ctx.response;

  const body = await readJson<{ code?: unknown; confirm?: unknown }>(req);
  if (!body || typeof body !== "object") return jsonError(400, "bad_request", "Invalid JSON body");
  if (body.confirm !== true) {
    return jsonError(400, "confirm_required", "Sending confirm: true is required to clear a freeze");
  }
  let code: FreezeCode | undefined;
  if (body.code !== undefined) {
    if (typeof body.code !== "string" || !FREEZE_DEFINITIONS.some((definition) => definition.code === body.code)) {
      return jsonError(400, "unknown_freeze_code", "code must name an active freeze code");
    }
    code = body.code as FreezeCode;
  }

  const rate = checkRateLimit("operator", "unfreeze");
  if (!rate.allowed) {
    return rateLimitedResponse(rate.retryAfterSec, rate.limit, rate.remaining, rate.resetAt);
  }
  recordRequest("operator", "unfreeze");

  const profile = persistenceProfileFromConfig(activeProfileConfig());
  const result = operatorUnfreeze(profile, { code, ip: ctx.ip });
  // An empty `code` request is audited even when nothing cleared, so a click
  // that did nothing is still traceable.
  if (result.cleared.length === 0) {
    audit("operator", "live.freeze.operator_unfreeze.noop", { requested: code ?? null }, ctx.ip, profile);
  }
  return jsonOk({ ok: true, cleared: result.cleared, frozen: result.active.length > 0, freezes: result.active });
}

