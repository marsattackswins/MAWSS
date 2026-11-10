import { describe, test, expect, beforeEach } from "@jest/globals";
import { NextRequest } from "next/server";
import { GET as healthGet } from "@/app/api/health/route";
import { GET as brokerHealthGet } from "@/app/api/health/broker/route";
import { GET as adminHealthGet } from "@/app/api/admin/health/route";
import { GET as adminMetricsGet } from "@/app/api/admin/metrics/route";
import { GET as adminRiskGet } from "@/app/api/admin/risk/route";
import { GET as adminConfigGet } from "@/app/api/admin/config/route";
import { GET as adminLogsGet } from "@/app/api/admin/logs/route";
import { GET as adminPerformanceGet } from "@/app/api/admin/performance/route";
import { GET as tradingHealthGet } from "@/app/api/status/trading-health/route";
import { GET as liveStateGet } from "@/app/api/live/state/route";
import { GET as liveHistoryGet } from "@/app/api/live/history/route";
import { GET as liveEventsGet } from "@/app/api/live/events/route";
import { POST as connectPost } from "@/app/api/live/connect/route";
import { POST as disconnectPost } from "@/app/api/live/disconnect/route";
import { POST as gatesPost } from "@/app/api/live/gates/route";
import { POST as ordersPost } from "@/app/api/live/orders/route";
import { POST as flattenPost } from "@/app/api/live/emergency/flatten/route";
import { POST as protectPost } from "@/app/api/live/protect/route";
import { POST as reconcilePost } from "@/app/api/live/reconcile/route";
import { POST as closePost } from "@/app/api/live/positions/close/route";
import { POST as cancelPost } from "@/app/api/live/orders/cancel/route";
import { POST as profileSwitchPost } from "@/app/api/live/profile/switch/route";
import { POST as reversePost } from "@/app/api/live/positions/reverse/route";
import { POST as removeProtectionPost } from "@/app/api/live/protect/remove/route";
import { POST as powerPost } from "@/app/api/admin/power/route";
import { POST as logoutPost } from "@/app/api/auth/logout/route";
import { POST as revokeAllPost } from "@/app/api/auth/revoke-all/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { verifyRateLimitedToken, resetTokenAttemptsForTests } from "@/lib/server/auth/token-attempts";
import { getDb } from "@/lib/server/db/connection";
import { freshEnv, FakeHttp, installFakes, jsonRes, makeCfg } from "./helpers";

const HEALTH_TOKEN = "health-token-" + "h".repeat(32);
const EMERGENCY_TOKEN = "emergency-token-" + "e".repeat(32);

function request(path: string, method: "GET" | "POST", headers: Record<string, string> = {}, body: unknown = {}): NextRequest {
  const requestHeaders = new Headers({
    host: "localhost:3000",
    origin: "http://localhost:3000",
    ...headers,
  });
  if (method === "POST") requestHeaders.set("content-type", "application/json");
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: requestHeaders,
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

const mutations = [
  ["POST /api/live/connect", connectPost, "/api/live/connect"],
  ["POST /api/live/disconnect", disconnectPost, "/api/live/disconnect"],
  ["POST /api/live/gates", gatesPost, "/api/live/gates"],
  ["POST /api/live/orders", ordersPost, "/api/live/orders"],
  ["POST /api/live/protect", protectPost, "/api/live/protect"],
  ["POST /api/live/reconcile", reconcilePost, "/api/live/reconcile"],
  ["POST /api/live/positions/close", closePost, "/api/live/positions/close"],
  ["POST /api/live/orders/cancel", cancelPost, "/api/live/orders/cancel"],
  ["POST /api/live/profile/switch", profileSwitchPost, "/api/live/profile/switch"],
  ["POST /api/live/positions/reverse", reversePost, "/api/live/positions/reverse"],
  ["POST /api/live/protect/remove", removeProtectionPost, "/api/live/protect/remove"],
  ["POST /api/admin/power", powerPost, "/api/admin/power"],
  ["POST /api/auth/revoke-all", revokeAllPost, "/api/auth/revoke-all"],
  ["POST /api/auth/login", loginPost, "/api/auth/login"],
] as const;

const protectedReads = [
  ["GET /api/live/state", liveStateGet, "/api/live/state"],
  ["GET /api/live/history", liveHistoryGet, "/api/live/history"],
  ["GET /api/live/events", liveEventsGet, "/api/live/events"],
  ["GET /api/admin/risk", adminRiskGet, "/api/admin/risk"],
  ["GET /api/admin/config", adminConfigGet, "/api/admin/config"],
  ["GET /api/admin/logs", adminLogsGet, "/api/admin/logs"],
  ["GET /api/admin/performance", adminPerformanceGet, "/api/admin/performance"],
  ["GET /api/status/trading-health", tradingHealthGet, "/api/status/trading-health"],
] as const;

describe("split health and emergency token authorization", () => {
  beforeEach(() => {
    resetTokenAttemptsForTests();
    const http = new FakeHttp();
    http.route("/fapi/v1/ping", () => jsonRes({}));
    freshEnv(makeCfg({
      env: "testnet",
      allowedOrigin: "http://localhost:3000",
      healthToken: HEALTH_TOKEN,
      emergencyToken: EMERGENCY_TOKEN,
    }));
    installFakes(http);
  });

  test("invalid token attempts are rate-limited per token type and client IP", () => {
    for (let i = 0; i < 5; i++) {
      expect(verifyRateLimitedToken("bad", HEALTH_TOKEN, "192.0.2.1", "health", 1000 + i).rateLimited).toBe(false);
    }
    expect(verifyRateLimitedToken("bad", HEALTH_TOKEN, "192.0.2.1", "health", 1006).rateLimited).toBe(true);
    expect(verifyRateLimitedToken("bad", EMERGENCY_TOKEN, "192.0.2.1", "emergency", 1006).rateLimited).toBe(false);
    expect(verifyRateLimitedToken("bad", HEALTH_TOKEN, "192.0.2.2", "health", 1006).rateLimited).toBe(false);
  });

  test("failed health-token attempts do not rate-limit the emergency token", () => {
    for (let i = 0; i < 5; i++) {
      verifyRateLimitedToken("bad", HEALTH_TOKEN, "192.0.2.3", "health", 2000 + i);
    }
    expect(
      verifyRateLimitedToken(EMERGENCY_TOKEN, EMERGENCY_TOKEN, "192.0.2.3", "emergency", 2006),
    ).toEqual({ authorized: true, rateLimited: false });
  });

  test.each(mutations)("%s rejects the read-only health token", async (_name, handler, path) => {
    const response = await handler(request(path, "POST", { "x-maws-health-token": HEALTH_TOKEN }));
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  test.each(protectedReads)("%s rejects the health token for trading data", async (_name, handler, path) => {
    const response = await handler(request(path, "GET", { "x-maws-health-token": HEALTH_TOKEN }));
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  test("emergency token is rejected by every other protected read and mutation route", async () => {
    for (const [_name, handler, path] of protectedReads) {
      const response = await handler(request(path, "GET", { "x-maws-emergency-token": EMERGENCY_TOKEN }));
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    for (const [_name, handler, path] of mutations) {
      const response = await handler(request(path, "POST", { "x-maws-emergency-token": EMERGENCY_TOKEN }));
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    const health = await healthGet(request("/api/health", "GET", { "x-maws-emergency-token": EMERGENCY_TOKEN }));
    expect(health.status).toBe(401);
    const broker = await brokerHealthGet(request("/api/health/broker", "GET", { "x-maws-emergency-token": EMERGENCY_TOKEN }));
    expect(broker.status).toBe(401);
    const adminHealth = await adminHealthGet(request("/api/admin/health", "GET", { "x-maws-emergency-token": EMERGENCY_TOKEN }));
    expect(adminHealth.status).toBeGreaterThanOrEqual(400);
    const metrics = await adminMetricsGet(request("/api/admin/metrics", "GET", { "x-maws-emergency-token": EMERGENCY_TOKEN }));
    expect(metrics.status).toBeGreaterThanOrEqual(400);
  });

  test("logout remains idempotent and does not treat either token as authorization", async () => {
    const tokenHeaders: Array<Record<string, string>> = [
      { "x-maws-health-token": HEALTH_TOKEN },
      { "x-maws-emergency-token": EMERGENCY_TOKEN },
    ];
    for (const tokenHeader of tokenHeaders) {
      const response = await logoutPost(request("/api/auth/logout", "POST", tokenHeader));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
    }
  });

  test("health endpoints accept the health token but return no trading data", async () => {
    const health = await healthGet(request("/api/health", "GET", { "x-maws-health-token": HEALTH_TOKEN }));
    const healthBody = await health.json();
    expect(health.status).toBe(200);
    expect(healthBody).not.toHaveProperty("unprotectedPositions");
    expect(healthBody).not.toHaveProperty("positions");
    expect(healthBody).not.toHaveProperty("orders");
    expect(healthBody).not.toHaveProperty("metrics");

    const broker = await brokerHealthGet(request("/api/health/broker", "GET", { "x-maws-health-token": HEALTH_TOKEN }));
    expect(broker.status).toBe(200);

    const adminHealth = await adminHealthGet(request("/api/admin/health", "GET", { "x-maws-health-token": HEALTH_TOKEN }));
    const adminHealthBody = await adminHealth.json();
    expect(adminHealth.status).toBe(200);
    expect(adminHealthBody).not.toHaveProperty("trading");

    const metrics = await adminMetricsGet(request("/api/admin/metrics", "GET", { "x-maws-health-token": HEALTH_TOKEN }));
    const metricsBody = await metrics.json();
    expect(metrics.status).toBe(200);
    expect(Object.keys(metricsBody).sort()).toEqual(["timestamp", "uptime_seconds"]);
  });

  test("health token cannot authorize emergency flatten", async () => {
    const response = await flattenPost(request("/api/live/emergency/flatten", "POST", {
      "x-maws-health-token": HEALTH_TOKEN,
    }));
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  async function expectFlattenNotAuthorizedWithoutEmergencyToken(
    headers: Record<string, string>,
  ): Promise<void> {
    const http = new FakeHttp();
    http.route("/fapi/v1/ping", () => jsonRes({}));
    freshEnv(makeCfg({
      env: "testnet",
      allowedOrigin: "http://localhost:3000",
      healthToken: HEALTH_TOKEN,
      emergencyToken: null,
    }));
    installFakes(http);

    const response = await flattenPost(request("/api/live/emergency/flatten", "POST", headers));
    expect(response.status).toBe(401);
    const authorizedRows = getDb().prepare(
      "SELECT id FROM audit_log WHERE action = 'emergency.flatten.authorized'",
    ).all();
    expect(authorizedRows).toHaveLength(0);
    expect(http.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  }

  test("with MAWS_EMERGENCY_TOKEN unset, no header never reaches the authorized flatten branch", async () => {
    await expectFlattenNotAuthorizedWithoutEmergencyToken({});
  });

  test("with MAWS_EMERGENCY_TOKEN unset, an empty header never reaches the authorized flatten branch", async () => {
    await expectFlattenNotAuthorizedWithoutEmergencyToken({ "x-maws-emergency-token": "" });
  });

  test("with MAWS_EMERGENCY_TOKEN unset, an arbitrary header never reaches the authorized flatten branch", async () => {
    await expectFlattenNotAuthorizedWithoutEmergencyToken({ "x-maws-emergency-token": "arbitrary" });
  });
});
