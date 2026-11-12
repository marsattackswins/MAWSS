import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

import { GET as getProfiles } from "@/app/api/live/profiles/route";
import { GET as getProfile } from "@/app/api/live/profile/route";
import { POST as switchProfile } from "@/app/api/live/profile/switch/route";
import { createSession, sessionCookieName } from "@/lib/server/auth/session";
import {
  ProfileCoordinatorError,
  profileCoordinator,
  resetProfileCoordinatorForTests,
} from "@/lib/server/profile/coordinator";
import { freshEnv, makeCfg } from "./helpers";

function authenticatedRequest(path: string, init: RequestInit = {}, csrf: string | null = null): Request {
  const headers = new Headers(init.headers);
  headers.set("cookie", `${sessionCookieName(false)}=${session.sessionId}`);
  headers.set("origin", "http://localhost:3000");
  if (csrf) headers.set("x-maws-csrf", csrf);
  return new Request(`http://localhost:3000${path}`, { ...init, headers });
}

let session: { sessionId: string; csrfToken: string };

beforeEach(() => {
  freshEnv(makeCfg({ env: "testnet" }));
  session = createSession("profile-api-test");
});

afterEach(() => {
  resetProfileCoordinatorForTests();
});

describe("profile API", () => {
  test("rejects unauthenticated requests and requires CSRF/origin for switching", async () => {
    const unauthenticated = await getProfiles(new Request("http://localhost:3000/api/live/profiles"));
    expect(unauthenticated.status).toBe(401);

    const csrfFailure = await switchProfile(authenticatedRequest("/api/live/profile/switch", {
      method: "POST",
      body: JSON.stringify({ profileId: "binance-testnet" }),
      headers: { "content-type": "application/json" },
    }));
    expect(csrfFailure.status).toBe(403);
    expect((await csrfFailure.json()).error.code).toBe("csrf");

    const originFailure = await switchProfile(new Request("http://localhost:3000/api/live/profile/switch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${sessionCookieName(false)}=${session.sessionId}`,
        "x-maws-csrf": session.csrfToken,
        origin: "http://evil.example",
      },
      body: JSON.stringify({ profileId: "binance-testnet" }),
    }));
    expect(originFailure.status).toBe(403);
  });

  test("rejects invalid profiles and requires production confirmation", async () => {
    const invalid = await switchProfile(authenticatedRequest("/api/live/profile/switch", {
      method: "POST",
      body: JSON.stringify({ profileId: "shadow" }),
      headers: { "content-type": "application/json" },
    }, session.csrfToken));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("invalid_profile");

    const invalidPaper = await switchProfile(authenticatedRequest("/api/live/profile/switch", {
      method: "POST",
      body: JSON.stringify({ profileId: "paper" }),
      headers: { "content-type": "application/json" },
    }, session.csrfToken));
    expect(invalidPaper.status).toBe(400);
    expect((await invalidPaper.json()).error.code).toBe("invalid_profile");

    const confirmation = await switchProfile(authenticatedRequest("/api/live/profile/switch", {
      method: "POST",
      body: JSON.stringify({ profileId: "binance-production", confirmProduction: false }),
      headers: { "content-type": "application/json" },
    }, session.csrfToken));
    expect(confirmation.status).toBe(400);
    expect((await confirmation.json()).error.code).toBe("production_confirmation_required");
  });

  test("disconnected base configuration exposes safe metadata", async () => {
    const baseCfg = makeCfg({ activeProfileId: null, binanceApiKey: null, binanceApiSecret: null });
    freshEnv(baseCfg);
    session = createSession("profile-api-base-test");

    const publicMetadata = await getProfiles(authenticatedRequest("/api/live/profiles"));
    expect(publicMetadata.status).toBe(200);
    expect((await publicMetadata.json()).profiles).toHaveLength(2);
  });

  test("disconnected base configuration attaches through the route", async () => {
    const baseCfg = makeCfg({ activeProfileId: null, binanceApiKey: null, binanceApiSecret: null });
    freshEnv(baseCfg);
    session = createSession("profile-api-base-attach-test");
    const switchSpy = jest.spyOn(profileCoordinator(), "switchProfile").mockResolvedValue({
      profileId: "binance-testnet",
      environment: "testnet",
      phase: "ready",
      ready: true,
      managerStatus: "ready",
      streamHealthy: true,
      executionAllowed: false,
      generation: 1,
      reasonCode: null,
    });

    const response = await switchProfile(authenticatedRequest("/api/live/profile/switch", {
      method: "POST",
      body: JSON.stringify({ profileId: "binance-testnet" }),
      headers: { "content-type": "application/json" },
    }, session.csrfToken));

    expect(response.status).toBe(200);
    expect(switchSpy).toHaveBeenCalledWith({ profileId: "binance-testnet" });
  });

  test("profile API delegates a configured profile switch to the coordinator", async () => {
    const switchSpy = jest.spyOn(profileCoordinator(), "switchProfile").mockResolvedValue({
      profileId: "binance-testnet",
      environment: "testnet",
      phase: "ready",
      ready: true,
      managerStatus: "ready",
      streamHealthy: true,
      executionAllowed: false,
      generation: 1,
      reasonCode: null,
    });

    const response = await switchProfile(authenticatedRequest("/api/live/profile/switch", {
      method: "POST",
      body: JSON.stringify({ profileId: "binance-testnet" }),
      headers: { "content-type": "application/json" },
    }, session.csrfToken));

    expect(response.status).toBe(200);
    expect(switchSpy).toHaveBeenCalledWith({ profileId: "binance-testnet" });
  });

  test("returns missing Production risk variable names from profile attachment errors", async () => {
    const names = [
      "MAWS_RISK_MAX_ORDER_NOTIONAL",
      "MAWS_RISK_MAX_GROSS_EXPOSURE",
      "MAWS_RISK_MAX_OPEN_ORDERS",
      "MAWS_RISK_MAX_OPEN_POSITIONS",
      "MAWS_RISK_DAILY_LOSS_PCT",
      "MAWS_RISK_PRICE_COLLAR_PCT",
      "MAWS_RISK_MAX_LEVERAGE",
      "MAWS_RISK_MAX_MARGIN_RATIO",
      "MAWS_RISK_MIN_LIQ_DISTANCE_PCT",
    ];
    jest.spyOn(profileCoordinator(), "switchProfile").mockRejectedValue(
      new ProfileCoordinatorError(
        "production_risk_limits_invalid",
        `Production risk limits must be explicitly configured; missing: ${names.join(", ")}`,
      ),
    );

    const response = await switchProfile(authenticatedRequest("/api/live/profile/switch", {
      method: "POST",
      body: JSON.stringify({ profileId: "binance-production", confirmProduction: true }),
      headers: { "content-type": "application/json" },
    }, session.csrfToken));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe("production_risk_limits_invalid");
    for (const name of names) expect(body.error.message).toContain(name);
  });

  test("returns no-store safe metadata and excludes internal profiles and secrets", async () => {
    const profiles = await getProfiles(authenticatedRequest("/api/live/profiles"));
    expect(profiles.headers.get("cache-control")).toBe("private, no-store");
    const profileBody = (await profiles.json()) as { profiles: Array<Record<string, unknown>> };
    expect(profileBody.profiles.map((profile) => profile.profileId)).toEqual([
      "binance-testnet",
      "binance-production",
    ]);
    expect(JSON.stringify(profileBody)).not.toContain("apiKey");
    expect(JSON.stringify(profileBody)).not.toContain("apiSecret");
    expect(JSON.stringify(profileBody)).not.toContain("https://");

    const current = await getProfile(authenticatedRequest("/api/live/profile"));
    expect(current.headers.get("cache-control")).toBe("private, no-store");
    expect((await current.json()).phase).toBe("idle");
  });
});
