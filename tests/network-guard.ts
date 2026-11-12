/**
 * Shared network guard for the Jest suites.
 *
 * Unit tests must never talk to a real exchange: the guard replaces global
 * `fetch`/`WebSocket` with versions that throw for any Binance host. The
 * integration runner is the one exception — it drives `npm run
 * test:integration` against Binance Demo Trading on purpose — so it exports
 * `MAWS_ALLOW_REAL_NETWORK=1`, and only when every safety condition below also
 * holds. Those conditions mirror `assertTestnetSafety()` in
 * tests/integration/helpers.ts, which the integration suites still call before
 * creating any client.
 */

/** Environment bag accepted by the guard (a plain map keeps tests simple). */
export type NetworkGuardEnv = Record<string, string | undefined>;

/** Live and Demo Trading hosts are all blocked by default. */
const BLOCKED_HOST = /^(?:[a-z0-9-]+\.)*(?:binance\.com|binancefuture\.com|binance\.us)$/i;

/** The only hosts allowed when the runner opts out of the guard. */
const DEMO_HOSTS = ["demo-fapi.binance.com", "demo-fstream.binance.com"] as const;

/** Production credentials must be absent for an integration run. */
const PRODUCTION_KEY_VARIABLES = [
  "MAWS_BINANCE_PRODUCTION_API_KEY",
  "MAWS_BINANCE_PRODUCTION_API_SECRET",
] as const;

export const ALLOW_REAL_NETWORK_VAR = "MAWS_ALLOW_REAL_NETWORK";

const GUARD_PREFIX = "network guard";

export function hostnameOf(target: unknown): string | null {
  try {
    if (typeof target === "string") return new URL(target).hostname;
    if (target instanceof URL) return target.hostname;
    if (target && typeof target === "object" && "url" in target) {
      return new URL(String((target as { url: unknown }).url)).hostname;
    }
  } catch {
    return null;
  }
  return null;
}

export function isBlockedExchangeHost(target: unknown): boolean {
  const host = hostnameOf(target);
  return host !== null && BLOCKED_HOST.test(host);
}

export function guardMessage(kind: string, target: unknown): string {
  return (
    `${GUARD_PREFIX}: blocked real ${kind} to ${String(target)} — unit tests must not reach a ` +
    `live exchange. Inject a fake transport (or stub fetch/WebSocket) in the test instead.`
  );
}

/**
 * True only for the integration runner: it sets MAWS_ALLOW_REAL_NETWORK=1, the
 * environment resolves to testnet, no production credentials are present, and
 * every Binance URL in the environment points at a Demo Trading host.
 */
export function realNetworkAllowed(env: NetworkGuardEnv = process.env): boolean {
  if ((env[ALLOW_REAL_NETWORK_VAR] ?? "").trim() !== "1") return false;
  if ((env.MAWS_ENV ?? "").trim().toLowerCase() !== "testnet") return false;

  for (const name of PRODUCTION_KEY_VARIABLES) {
    if ((env[name] ?? "").trim() !== "") return false;
  }

  for (const value of Object.values(env)) {
    if (!value) continue;
    const host = hostnameOf(value.trim());
    if (host === null || !BLOCKED_HOST.test(host)) continue;
    if (!(DEMO_HOSTS as readonly string[]).includes(host)) return false;
  }

  return true;
}

let installed: "enforced" | "disabled" | null = null;

/**
 * Installs (or, for the integration runner, deliberately skips) the guard.
 * Idempotent: repeated calls report the state chosen on the first call.
 */
export function installNetworkGuard(env: NetworkGuardEnv = process.env): "enforced" | "disabled" {
  if (installed !== null) return installed;

  if (realNetworkAllowed(env)) {
    installed = "disabled";
    return installed;
  }

  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch === "function") {
    globalThis.fetch = function guardedFetch(input: RequestInfo | URL, init?: RequestInit) {
      if (isBlockedExchangeHost(input)) throw new Error(guardMessage("fetch", input));
      return nativeFetch(input, init);
    } as typeof globalThis.fetch;
  }

  const NativeWebSocket = globalThis.WebSocket;
  if (typeof NativeWebSocket === "function") {
    class GuardedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (isBlockedExchangeHost(url)) throw new Error(guardMessage("WebSocket", url));
        super(url, protocols);
      }
    }
    globalThis.WebSocket = GuardedWebSocket as unknown as typeof globalThis.WebSocket;
  }

  installed = "enforced";
  return installed;
}

/** Test-only: lets a suite assert which state the guard chose. */
export function networkGuardState(): "enforced" | "disabled" | null {
  return installed;
}
