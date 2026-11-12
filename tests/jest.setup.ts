import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs before any test module is imported. Tests that call `freshEnv` install
 * their own isolated temp DB, but anything that reaches the database without
 * that harness (e.g. the CircuitBreaker audit logging) would otherwise fall
 * through to `.maws/maws.db` — the dev server's live database. Redirect it.
 */
process.env.MAWS_DB_PATH ??= join(tmpdir(), `maws-jest-${process.pid}-${Date.now()}.db`);

/**
 * Network guard: unit tests must never reach a real exchange. Any fetch or
 * WebSocket to a Binance host (live or Demo Trading) fails loudly here so a
 * test that silently depends on the network shows up as a failure instead of a
 * flaky pass. Injected/mocked transports are untouched — they either replace
 * these globals after this file runs or never use them.
 */
const BLOCKED_HOST = /^(?:[a-z0-9-]+\.)*(?:binance\.com|binancefuture\.com|binance\.us)$/i;

function hostOf(target: unknown): string | null {
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
  const host = hostOf(target);
  return host !== null && BLOCKED_HOST.test(host);
}

const guardMessage = (kind: string, target: unknown) =>
  `network guard: blocked real ${kind} to ${String(target)} — unit tests must not reach a live ` +
  `exchange. Inject a fake transport (or stub fetch/WebSocket) in the test instead.`;

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
