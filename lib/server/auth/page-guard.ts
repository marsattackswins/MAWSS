import "server-only";

import { resolveOperatorSession } from "./session-guard";
import { serverConfig } from "../env/config";

/**
 * Server-side page authentication guard.
 *
 * Returns true if the request should render protected page content:
 * - Requires a valid, unexpired, non-revoked operator session in both modes.
 *
 * Returns false if the page should redirect to /login.
 *
 * Throws if server configuration cannot be loaded (fail closed).
 */
export function isOperatorPageAuthorized(cookieHeader: string | null): boolean {
  const cfg = serverConfig(); // Throws on config error (fail closed)

  return resolveOperatorSession(cookieHeader, cfg) !== null;
}

/** @deprecated Use isOperatorPageAuthorized, which protects every operator page. */
export function isAdminPageAuthorized(cookieHeader: string | null): boolean {
  return isOperatorPageAuthorized(cookieHeader);
}
