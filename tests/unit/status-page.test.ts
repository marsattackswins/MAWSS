import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { createSession, sessionCookieName } from "@/lib/server/auth/session";
import { secureCookieContext } from "@/lib/server/http/guards";
import { freshEnv, makeCfg } from "../live-tests/helpers";

// The broker probe would reach the exchange; everything else (config, sessions,
// auth guard, health route) is the real implementation so this file exercises
// the actual universal-authentication contract.
jest.mock("@/lib/server/binance/broker-ping", () => ({
  pingBroker: () =>
    Promise.resolve({
      ok: true,
      broker: "binance",
      latencyMs: 42,
    }),
}));

jest.mock("@/lib/server/health/status", () => ({
  buildHealthStatus: () => ({
    env: "testnet",
    healthy: true,
    brokerConnected: false,
    clockHealthy: false,
    streamHealthy: false,
    reconHealthy: true,
    protectionHealthy: true,
    positionModeHealthy: false,
    circuitBreakersHealthy: true,
    openCircuits: [],
    circuitBreakerStates: {},
    unprotectedPositions: [],
    submissionsFrozen: true,
    frozenReasons: ["manager not ready"],
    signals: {
      managerRunning: false,
      brokerStatus: "idle",
      brokerError: null,
      clock: null,
      stream: null,
      snapshot: null,
      recon: { lastResult: "clean" },
      positionMode: { mode: "unknown", checkedAt: null, error: null },
    },
    execution: {
      env: "testnet",
      envAllowsSubmissions: true,
      profileExecutionEnabled: false,
      runtimeEnabled: false,
      killSwitch: false,
      frozen: false,
      frozenReason: "",
      managerReady: false,
      streamLeaseOwned: false,
      streamHealthy: false,
      snapshotFresh: false,
      positionModeVerified: false,
      canSubmit: false,
      reasons: ["manager not ready"],
    },
  }),
}));

function request(path: string, cookie?: string): Request {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return new Request(`http://localhost:3000${path}`, { method: "GET", headers });
}

function operatorCookie(): string {
  const cfg = makeCfg({ env: "testnet" });
  const { sessionId } = createSession("status-page-session");
  return `${sessionCookieName(secureCookieContext(cfg))}=${sessionId}`;
}

describe("status page", () => {
  beforeEach(() => {
    freshEnv(makeCfg({ env: "testnet", allowedOrigin: null }));
  });

  describe("health endpoints", () => {
    test("/api/health requires an operator session", async () => {
      const { GET: healthGet } = await import("@/app/api/health/route");
      const res = await healthGet(request("/api/health"));
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("unauthenticated");
    });

    test("/api/health/broker requires an operator session", async () => {
      const { GET: brokerHealthGet } = await import("@/app/api/health/broker/route");
      const res = await brokerHealthGet(request("/api/health/broker"));
      expect(res.status).toBe(401);
    });

    test("/api/health returns health status when authenticated", async () => {
      const { GET: healthGet } = await import("@/app/api/health/route");
      const res = await healthGet(request("/api/health", operatorCookie()));
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toHaveProperty("healthy");
      expect(data).toHaveProperty("env");
      expect(data).toHaveProperty("brokerConnected");
      expect(data).toHaveProperty("version");
      expect(data).toHaveProperty("startedAt");
      expect(data).toHaveProperty("uptimeSeconds");
      expect(typeof data.uptimeSeconds).toBe("number");
    });

    test("/api/health/broker returns broker status when authenticated", async () => {
      const { GET: brokerHealthGet } = await import("@/app/api/health/broker/route");
      const res = await brokerHealthGet(request("/api/health/broker", operatorCookie()));
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toHaveProperty("status");
      expect(data).toHaveProperty("broker");
      expect(data).toHaveProperty("latency_ms");
      expect(["ok", "degraded"]).toContain(data.status);
    });
  });

  describe("status page rendering", () => {
    test("status page entry exists and redirects to the Operations Console", async () => {
      const { default: StatusRedirect } = await import("@/app/status/page");
      // The standalone status page was merged into the Operations Console.
      // The /status route remains as an authorized redirect to /admin.
      expect(typeof StatusRedirect).toBe("function");
    });
  });
});
