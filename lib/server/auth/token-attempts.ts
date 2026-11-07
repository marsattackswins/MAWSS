import "server-only";

import { clientIp, type GuardRequest } from "./guard";
import { compareSecretTokens } from "./token";
import type { EnvConfig } from "../env/config";

type AttemptWindow = { failures: number[] };

const WINDOW_MS = 60_000;
const MAX_FAILURES = 5;
const windows = new Map<string, AttemptWindow>();

export type TokenAttemptResult =
  | { authorized: true; rateLimited: false }
  | { authorized: false; rateLimited: boolean };

export function verifyRequestToken(
  req: Request,
  cfg: EnvConfig,
  headerName: string,
  expected: string | null,
): TokenAttemptResult {
  const guardReq: GuardRequest = {
    method: req.method,
    url: req.url,
    headers: req.headers,
  };
  return verifyRateLimitedToken(
    req.headers.get(headerName),
    expected,
    clientIp(guardReq, cfg),
  );
}

export function verifyRateLimitedToken(
  presented: string | null,
  expected: string | null,
  ip: string,
  now = Date.now(),
): TokenAttemptResult {
  if (!presented) return { authorized: false, rateLimited: false };
  const attemptKey = ip;
  const cutoff = now - WINDOW_MS;
  const window = windows.get(attemptKey);
  const failures = (window?.failures ?? []).filter((at) => at > cutoff);
  if (failures.length >= MAX_FAILURES) return { authorized: false, rateLimited: true };

  if (compareSecretTokens(presented, expected)) {
    return { authorized: true, rateLimited: false };
  }
  failures.push(now);
  windows.set(attemptKey, { failures });
  for (const [storedKey, storedWindow] of windows) {
    if (storedWindow.failures.every((at) => at <= cutoff)) windows.delete(storedKey);
  }
  return { authorized: false, rateLimited: false };
}

export function resetTokenAttemptsForTests(): void {
  windows.clear();
}
