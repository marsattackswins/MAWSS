/**
 * Preload for the e2e web server (`node --require ./e2e/server-network-guard.cjs`).
 *
 * The browser-side guard in e2e/fixtures.ts only covers page traffic; the Next
 * server process has its own outbound clients (proxy routes, the Binance live
 * manager, ws streams). This file blocks every real Binance host there too, with
 * the same message the Jest guard uses, and records each attempt to stderr and
 * to a log file so an unexpected call is visible instead of silent.
 *
 * Loaded through NODE_OPTIONS by playwright.config.ts, so it also applies to
 * child processes the Next CLI spawns.
 */
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const BLOCKED_HOST = /^(?:[a-z0-9-]+\.)*(?:binance\.com|binancefuture\.com|binance\.us)$/i;
const LOG_PATH =
  process.env.MAWS_E2E_GUARD_LOG || path.join(process.cwd(), "test-results", "server-network-guard.log");

function hostnameOf(target) {
  try {
    if (typeof target === "string") return new URL(target).hostname;
    if (target instanceof URL) return target.hostname;
    if (target && typeof target === "object" && typeof target.href === "string") {
      return new URL(target.href).hostname;
    }
    if (target && typeof target === "object" && typeof target.url === "string") {
      return new URL(target.url).hostname;
    }
    if (target && typeof target === "object") {
      const host = target.hostname || target.host;
      if (typeof host === "string") return host.split(":")[0];
    }
  } catch {
    return null;
  }
  return null;
}

function isBlocked(target) {
  const host = hostnameOf(target);
  return host !== null && BLOCKED_HOST.test(host);
}

function record(kind, target) {
  const url = typeof target === "string" ? target : target && (target.href || target.url) ? String(target.href || target.url) : String(target);
  const line = `${new Date().toISOString()} ${kind} ${url}`;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `blocked ${line}\n`);
  } catch {
    /* logging must never break the server */
  }
  process.stderr.write(`[server-network-guard] blocked ${kind}: ${url}\n`);
}

function blockedError(kind, target) {
  return new Error(
    `network guard: blocked real ${kind} to ${String(target)} — e2e runs must not reach a live ` +
      `exchange. Use FakeBinanceFeed (e2e/fake-feed.ts) or stub the API route instead.`,
  );
}

// --- fetch (undici, used by Next route handlers) ---------------------------
const nativeFetch = globalThis.fetch;
if (typeof nativeFetch === "function") {
  globalThis.fetch = function guardedFetch(input, init) {
    if (isBlocked(input)) {
      record("fetch", input);
      return Promise.reject(blockedError("fetch", input));
    }
    return nativeFetch(input, init);
  };
}

// --- node http / https ----------------------------------------------------
for (const [name, mod] of [
  ["http", http],
  ["https", https],
]) {
  for (const method of ["request", "get"]) {
    const native = mod[method];
    if (typeof native !== "function") continue;
    mod[method] = function guarded(target, ...rest) {
      if (isBlocked(target)) {
        record(name, target);
        throw blockedError(name, target);
      }
      return native.call(this, target, ...rest);
    };
  }
}

// --- WebSocket clients (ws package and the Node global) -------------------
try {
  const ws = require("ws");
  const NativeWebSocket = ws.WebSocket;
  if (typeof NativeWebSocket === "function") {
    class GuardedWebSocket extends NativeWebSocket {
      constructor(address, protocols, options) {
        if (isBlocked(address)) {
          record("websocket", address);
          throw blockedError("websocket", address);
        }
        super(address, protocols, options);
      }
    }
    ws.WebSocket = GuardedWebSocket;
  }
} catch {
  /* ws not resolvable in this process; nothing to patch */
}

const NativeGlobalWebSocket = globalThis.WebSocket;
if (typeof NativeGlobalWebSocket === "function") {
  class GuardedGlobalWebSocket extends NativeGlobalWebSocket {
    constructor(url, protocols) {
      if (isBlocked(url)) {
        record("websocket", url);
        throw blockedError("websocket", url);
      }
      super(url, protocols);
    }
  }
  globalThis.WebSocket = GuardedGlobalWebSocket;
}

process.stderr.write("[server-network-guard] active — outbound Binance hosts are blocked\n");
