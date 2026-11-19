/**
 * Operator unfreeze API and clear semantics.
 *
 * Covers the auth surface (session + CSRF + Origin only, never a service
 * token), every operator-class code, a blocked clear that changes nothing, and
 * the invariant that unfreezing never enables execution or the kill switch.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

import { GET as getFreezes, POST as postFreezes } from "@/app/api/live/freezes/route";
import { createSession, sessionCookieName } from "@/lib/server/auth/session";
import { freshEnv, makeCfg } from "./helpers";
import { getDb } from "@/lib/server/db/connection";
import { persistenceProfileFromConfig } from "@/lib/server/profile/context";
import { getRuntime, RUNTIME_KEYS, setRuntime } from "@/lib/server/runtime/flags";
import { resetRateLimitWindows } from "@/lib/server/rate-limit";
import { activeFreezes, registerFreeze, resetFreezeReasonsForTests } from "@/lib/server/binance/freeze";

const ORIGIN = "http://localhost:3000";

let session: { sessionId: string; csrfToken: string };
let profile: ReturnType<typeof persistenceProfileFromConfig>;

function request(path: string, init: RequestInit = {}, opts: { csrf?: string | null; session?: boolean } = {}): Request {
  const headers = new Headers(init.headers);
  if (opts.session !== false) headers.set("cookie", `${sessionCookieName(false)}=${session.sessionId}`);
  headers.set("origin", ORIGIN);
  if (opts.csrf) headers.set("x-maws-csrf", opts.csrf);
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

function post(body: unknown, opts: { csrf?: string | null; session?: boolean; headers?: Record<string, string> } = {}): Request {
  return request(
    "/api/live/freezes",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
    },
    { csrf: opts.csrf === undefined ? session.csrfToken : opts.csrf, session: opts.session },
  );
}

function cleanReconAt(at: number): void {
  getDb()
    .prepare(
      `INSERT INTO reconciliation_runs (profile_id, started_at, finished_at, trigger, result, details)
       VALUES (?, ?, ?, 'test', 'ok', '{}')`,
    )
    .run(profile.id, at - 1, at);
}

beforeEach(() => {
  freshEnv(makeCfg());
  resetRateLimitWindows();
  session = createSession("operator-unfreeze-test");
  profile = persistenceProfileFromConfig(makeCfg());
  resetFreezeReasonsForTests(profile);
});

afterEach(() => {
  resetRateLimitWindows();
});

describe("POST /api/live/freezes auth", () => {
  test("no session, no CSRF, and service tokens are all refused without clearing anything", async () => {
    registerFreeze("OPERATOR", "operator hold", { profile });

    const anonymous = await postFreezes(post({ confirm: true }, { session: false }));
    expect(anonymous.status).toBe(401);

    const noCsrf = await postFreezes(post({ confirm: true }, { csrf: null }));
    expect(noCsrf.status).toBe(403);
    expect((await noCsrf.json()).error.code).toBe("csrf");

    const healthToken = await postFreezes(
      post({ confirm: true }, { session: false, headers: { "x-maws-health-token": "h".repeat(32) } }),
    );
    expect(healthToken.status).toBe(403);
    expect((await healthToken.json()).error.code).toBe("operator_session_required");

    const emergencyToken = await postFreezes(
      post({ confirm: true }, { session: false, headers: { "x-maws-emergency-token": "e".repeat(32) } }),
    );
    expect(emergencyToken.status).toBe(403);
    expect((await emergencyToken.json()).error.code).toBe("operator_session_required");

    expect(activeFreezes(profile).map((row) => row.code)).toEqual(["OPERATOR"]);
  });

  test("requires an explicit confirm and a known code", async () => {
    registerFreeze("OPERATOR", "operator hold", { profile });

    const unconfirmed = await postFreezes(post({ code: "OPERATOR" }));
    expect(unconfirmed.status).toBe(400);
    expect((await unconfirmed.json()).error.code).toBe("confirm_required");

    const unknown = await postFreezes(post({ code: "NOT_A_CODE", confirm: true }));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error.code).toBe("unknown_freeze_code");
    expect(activeFreezes(profile)).toHaveLength(1);
  });

  test("is rate limited", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      statuses.push((await postFreezes(post({ confirm: true }))).status);
    }
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe("operator-class clears", () => {
  test("clears OPERATOR and leaves execution disabled and the kill switch untouched", async () => {
    setRuntime(RUNTIME_KEYS.executionEnabled, "false", Date.now(), profile);
    setRuntime(RUNTIME_KEYS.killSwitch, "true", Date.now(), profile);
    registerFreeze("OPERATOR", "manual hold for maintenance", { profile });
    expect(getRuntime(RUNTIME_KEYS.frozen, "", profile)).toBe("true");

    const response = await postFreezes(post({ confirm: true }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.cleared).toEqual(["OPERATOR"]);
    expect(body.frozen).toBe(false);
    expect(body.freezes).toEqual([]);

    expect(getRuntime(RUNTIME_KEYS.frozen, "", profile)).toBe("false");
    expect(getRuntime(RUNTIME_KEYS.executionEnabled, "", profile)).toBe("false");
    expect(getRuntime(RUNTIME_KEYS.killSwitch, "", profile)).toBe("true");
  });

  test("clears only the requested code", async () => {
    registerFreeze("OPERATOR", "hold", { profile });
    registerFreeze("KEY_REJECTED", "api key rejected", { profile });

    const first = await postFreezes(post({ code: "OPERATOR", confirm: true }));
    const firstBody = await first.json();
    expect(firstBody.cleared).toEqual(["OPERATOR"]);
    expect(firstBody.freezes.map((freeze: { code: string }) => freeze.code)).toEqual(["KEY_REJECTED"]);
    expect(getRuntime(RUNTIME_KEYS.frozen, "", profile)).toBe("true");
  });

  test("KEY_REJECTED needs the operator action (never clears automatically)", async () => {
    registerFreeze("KEY_REJECTED", "api key rejected (-2015)", { profile });

    // A clean reconciliation alone must not clear it.
    cleanReconAt(Date.now() + 1_000);
    const read = await getFreezes(request("/api/live/freezes"));
    const readBody = await read.json();
    expect(readBody.freezes).toHaveLength(1);
    expect(readBody.freezes[0].blockingReason).toBe("needs an explicit operator unfreeze");
    // The action itself satisfies the rule, so the UI may press the button.
    expect(readBody.freezes[0]).toMatchObject({ clearsWithOperator: true, operatorCanClearNow: true });

    const cleared = await postFreezes(post({ code: "KEY_REJECTED", confirm: true }));
    expect((await cleared.json()).cleared).toEqual(["KEY_REJECTED"]);
  });

  test("LEGACY needs a clean reconciliation and then the operator action", async () => {
    const setAt = Date.now();
    registerFreeze("LEGACY", "frozen before typed freeze reasons", { profile, now: setAt });

    const blocked = await postFreezes(post({ confirm: true }));
    const blockedBody = await blocked.json();
    expect(blockedBody.cleared).toEqual([]);
    expect(blockedBody.frozen).toBe(true);
    expect(blockedBody.freezes[0].blockingReason).toContain("needs a clean reconciliation after");
    expect(activeFreezes(profile)).toHaveLength(1);

    cleanReconAt(setAt + 60_000);
    const cleared = await postFreezes(post({ confirm: true }));
    expect((await cleared.json()).cleared).toEqual(["LEGACY"]);
    expect(getRuntime(RUNTIME_KEYS.frozen, "", profile)).toBe("false");
  });

  test("an unmet non-operator condition reports the blocking reason and changes nothing", async () => {
    registerFreeze("RECON_DRIFT", "reconciliation drift", { profile });

    const response = await postFreezes(post({ confirm: true }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.cleared).toEqual([]);
    expect(body.frozen).toBe(true);
    expect(body.freezes[0].code).toBe("RECON_DRIFT");
    expect(body.freezes[0].blockingReason).toContain("needs a clean reconciliation after");
    expect(body.freezes[0]).toMatchObject({ clearsWithOperator: false, operatorCanClearNow: false });
    expect(activeFreezes(profile).map((row) => row.code)).toEqual(["RECON_DRIFT"]);
    expect(getRuntime(RUNTIME_KEYS.frozen, "", profile)).toBe("true");
  });
});

describe("GET /api/live/freezes", () => {
  test("lists code, reason, since and what clears each freeze", async () => {
    const now = Date.now();
    registerFreeze("IP_BAN", "ip ban", { profile, now, detail: { banExpiresAt: now + 60_000 } });

    const response = await getFreezes(request("/api/live/freezes"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.frozen).toBe(true);
    expect(body.freezes[0]).toMatchObject({ code: "IP_BAN", reason: "ip ban", since: now, clearsWithOperator: false });
    expect(body.freezes[0].blockingReason).toContain("ban window ends");
  });

  test("requires a session", async () => {
    const response = await getFreezes(request("/api/live/freezes", {}, { session: false }));
    expect(response.status).toBe(401);
  });
});
