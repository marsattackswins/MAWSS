/**
 * Local-dev convenience mode: charts and public market data without a login.
 *
 * `npm run dev` binds Next to loopback and sets MAWS_LOCAL_DEV=1 plus the bind
 * address it used. Only when all three hold — marker, non-production runtime,
 * loopback bind — does the app serve the chart shell and the public-data
 * proxies to an anonymous request. Account and admin surfaces never use this
 * helper; they require an operator session in every mode.
 *
 * The Host header must be exactly localhost:3000 or 127.0.0.1:3000. That is a
 * DNS-rebinding defence: a page served from another origin that resolves to
 * 127.0.0.1 still sends its own Host, so it gets the normal 401 instead of a
 * login-free trading terminal. Anything bound off loopback is not this mode at
 * all, and startup refuses rather than honoring the marker.
 */
export const LOCAL_DEV_PORT = 3000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** IPv4/IPv6/name loopback literal? Anything else — including 0.0.0.0 — no. */
export function isLoopbackBinding(bind: string | null | undefined): boolean {
  if (typeof bind !== "string") return false;
  return LOOPBACK_HOSTS.has(bind.trim().toLowerCase().replace(/^\[|\]$/g, ""));
}

/** The bind address the launcher reported. Unknown is not loopback. */
export function localDevBindAddress(source: NodeJS.ProcessEnv = process.env): string | null {
  const raw = source.MAWS_LOCAL_DEV_BIND;
  return raw && raw.trim() ? raw.trim().toLowerCase() : null;
}

/** Is the login-free chart mode active for this process? */
export function localDevEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  if (source.MAWS_LOCAL_DEV !== "1") return false;
  if (source.NODE_ENV === "production") return false;
  return isLoopbackBinding(localDevBindAddress(source));
}

/** Exact, port-pinned Host match. No suffix or prefix matching. */
export function localDevHostAllowed(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  return host === `localhost:${LOCAL_DEV_PORT}` || host === `127.0.0.1:${LOCAL_DEV_PORT}`;
}

/**
 * Anonymous read access to the chart shell and public market data. The only
 * sanctioned bypass in the app: enabled by the launcher, loopback-only, and
 * bound to the exact Host the browser uses.
 */
export function canReadPublicDataWithoutSession(req: {
  headers: { get(name: string): string | null };
}): boolean {
  return localDevEnabled() && localDevHostAllowed(req.headers.get("host"));
}

/**
 * The exact surfaces the login-free chart mode may serve. Anything not listed —
 * account, admin, status, journal, and every write — keeps the normal 401.
 */
const PUBLIC_PATHS = new Set([
  "/",
  "/api/binance/ticker",
  "/api/binance/klines",
  "/api/binance/symbols",
  "/api/logo",
  "/api/news/finnhub",
  "/api/calendar/xoomar",
  // Handler answers only { attached: false, loginRequired: true } when signed out.
  "/api/live/state",
]);

export function isLocalDevPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

/**
 * Startup refusal. A marker without a loopback bind is not ignored quietly: the
 * process must not boot a login-free terminal on a reachable interface.
 * next.config.ts calls this so the failure happens before Next starts serving.
 */
export function assertLocalDevBinding(source: NodeJS.ProcessEnv = process.env): void {
  if (source.MAWS_LOCAL_DEV !== "1") return;
  if (!isLoopbackBinding(localDevBindAddress(source))) {
    throw new Error(
      "MAWS_LOCAL_DEV=1 is localhost-only: set MAWS_LOCAL_DEV_BIND=127.0.0.1 and bind the server to loopback, or unset MAWS_LOCAL_DEV. Refusing to start.",
    );
  }
}
