import { describe, test, expect, beforeEach } from "@jest/globals";
import { NextRequest } from "next/server";
import { resolveOperatorSession } from "@/lib/server/auth/session-guard";
import { createSession, revokeSession, sessionCookieName, SESSION_TTL_MS } from "@/lib/server/auth/session";
import { secureCookieContext } from "@/lib/server/http/guards";
import { freshEnv, makeCfg } from "./helpers";
import { GET as finnhubGet } from "@/app/api/news/finnhub/route";
import { GET as xoomarGet } from "@/app/api/calendar/xoomar/route";
import { GET as klinesGet } from "@/app/api/binance/klines/route";
import { GET as tickerGet } from "@/app/api/binance/ticker/route";
import { GET as symbolsGet } from "@/app/api/binance/symbols/route";

describe("session resolution primitive", () => {
  beforeEach(() => {
    freshEnv(makeCfg());
  });

  test("testnet: valid session returns SessionRecord", () => {
    const cfg = makeCfg({ env: "testnet" });
    const { sessionId } = createSession("test-agent");
    const cookieName = sessionCookieName(secureCookieContext(cfg));
    const cookieHeader = `${cookieName}=${sessionId}`;

    const session = resolveOperatorSession(cookieHeader, cfg);
    expect(session).not.toBeNull();
    expect(session?.csrfToken).toBeTruthy();
  });

  test("missing cookie returns null", () => {
    const cfg = makeCfg({ env: "testnet" });
    const session = resolveOperatorSession(null, cfg);
    expect(session).toBeNull();
  });

  test("malformed session ID returns null", () => {
    const cfg = makeCfg({ env: "testnet" });
    const cookieName = sessionCookieName(secureCookieContext(cfg));
    const cookieHeader = `${cookieName}=not-a-valid-hex-session`;

    const session = resolveOperatorSession(cookieHeader, cfg);
    expect(session).toBeNull();
  });

  test("expired session returns null", () => {
    const cfg = makeCfg({ env: "testnet" });
    const now = Date.now();
    const { sessionId } = createSession("test-agent", now - SESSION_TTL_MS - 1000);
    const cookieName = sessionCookieName(secureCookieContext(cfg));
    const cookieHeader = `${cookieName}=${sessionId}`;

    const session = resolveOperatorSession(cookieHeader, cfg);
    expect(session).toBeNull();
  });

  test("revoked session returns null", () => {
    const cfg = makeCfg({ env: "testnet" });
    const { sessionId } = createSession("test-agent");
    revokeSession(sessionId);
    const cookieName = sessionCookieName(secureCookieContext(cfg));
    const cookieHeader = `${cookieName}=${sessionId}`;

    const session = resolveOperatorSession(cookieHeader, cfg);
    expect(session).toBeNull();
  });

  test("wrong cookie name returns null", () => {
    const cfg = makeCfg({ env: "testnet" });
    const { sessionId } = createSession("test-agent");
    // Use the wrong cookie name (secure when should be plain, or vice versa)
    const wrongName = secureCookieContext(cfg) ? "maws.session" : "__Host-maws.session";
    const cookieHeader = `${wrongName}=${sessionId}`;

    const session = resolveOperatorSession(cookieHeader, cfg);
    expect(session).toBeNull();
  });

  test("production mode: valid session works", () => {
    const cfg = makeCfg({ env: "production" });
    const { sessionId } = createSession("test-agent");
    const cookieName = sessionCookieName(secureCookieContext(cfg));
    const cookieHeader = `${cookieName}=${sessionId}`;

    const session = resolveOperatorSession(cookieHeader, cfg);
    expect(session).not.toBeNull();
  });
});

/**
 * The public-data proxy routes are no longer anonymous in any environment:
 * market data and news are operator surfaces like everything else. Each route
 * must reject a cookie-less request before it reaches its upstream fetch.
 */
describe("public-data proxy routes require an operator session", () => {
  const ROUTES = [
    { name: "/api/binance/klines", url: "http://localhost:3000/api/binance/klines?symbol=BTCUSDT&interval=15m", get: klinesGet },
    { name: "/api/binance/ticker", url: "http://localhost:3000/api/binance/ticker?symbol=BTCUSDT", get: tickerGet },
    { name: "/api/binance/symbols", url: "http://localhost:3000/api/binance/symbols", get: symbolsGet },
    { name: "/api/news/finnhub", url: "http://localhost:3000/api/news/finnhub?category=all", get: finnhubGet },
    { name: "/api/calendar/xoomar", url: "http://localhost:3000/api/calendar/xoomar?from=2026-01-01&to=2026-01-02", get: xoomarGet },
  ] as const;

  beforeEach(() => {
    freshEnv(makeCfg());
  });

  for (const env of ["testnet", "production"] as const) {
    for (const route of ROUTES) {
      test(`${route.name} rejects anonymous requests in ${env}`, async () => {
        freshEnv(makeCfg({ env }));
        const response = await route.get(new NextRequest(route.url));
        expect(response.status).toBe(401);
        const body = (await response.json()) as { error: { code: string } };
        expect(body.error.code).toBe("unauthenticated");
      });
    }
  }

  test("a valid operator session passes the auth gate before validation", async () => {
    const cfg = freshEnv(makeCfg({ env: "testnet" })) as ReturnType<typeof makeCfg>;
    const { sessionId } = createSession("proxy-session");
    const cookie = `${sessionCookieName(secureCookieContext(cfg))}=${sessionId}`;

    // Invalid inputs prove the request got past authentication without any
    // exchange or Finnhub call: both fail validation with 400, not 401.
    const klines = await klinesGet(
      new NextRequest("http://localhost:3000/api/binance/klines?symbol=x&interval=15m", {
        headers: { cookie },
      }),
    );
    expect(klines.status).toBe(400);

    const xoomar = await xoomarGet(
      new NextRequest("http://localhost:3000/api/calendar/xoomar", { headers: { cookie } }),
    );
    expect(xoomar.status).toBe(400);
  });
});
