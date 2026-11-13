import { afterAll, afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { NextRequest } from "next/server";

import { freshEnv, makeCfg } from "../live-tests/helpers";
import {
  assertLocalDevBinding,
  localDevEnabled,
  localDevHostAllowed,
  isLoopbackBinding,
} from "@/lib/server/auth/local-dev";
import { isChartPageAuthorized, isOperatorPageAuthorized } from "@/lib/server/auth/page-guard";
import { GET as tickerGet } from "@/app/api/binance/ticker/route";
import { GET as klinesGet } from "@/app/api/binance/klines/route";
import { GET as symbolsGet } from "@/app/api/binance/symbols/route";
import { GET as logoGet } from "@/app/api/logo/route";
import { GET as finnhubGet } from "@/app/api/news/finnhub/route";
import { GET as xoomarGet } from "@/app/api/calendar/xoomar/route";
import { GET as liveStateGet } from "@/app/api/live/state/route";
import { GET as liveProfileGet } from "@/app/api/live/profile/route";
import { POST as profileSwitchPost } from "@/app/api/live/profile/switch/route";
import { POST as ordersPost } from "@/app/api/live/orders/route";
import { GET as adminConfigGet } from "@/app/api/admin/config/route";
import { proxy } from "@/proxy";

/**
 * Local-dev convenience mode: the launcher marker plus the exact loopback Host
 * is the only way an anonymous request may read the chart and public market
 * data. Everything account-shaped stays 401 in every mode.
 */
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function setNodeEnv(value: string | undefined): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

function enterLocalDev(bind = "127.0.0.1"): void {
  process.env.MAWS_LOCAL_DEV = "1";
  process.env.MAWS_LOCAL_DEV_BIND = bind;
}

function leaveLocalDev(): void {
  delete process.env.MAWS_LOCAL_DEV;
  delete process.env.MAWS_LOCAL_DEV_BIND;
}

beforeEach(() => {
  freshEnv(makeCfg({ env: "testnet", allowedOrigin: null }));
  leaveLocalDev();
  setNodeEnv(ORIGINAL_NODE_ENV);
});

afterEach(() => {
  leaveLocalDev();
  setNodeEnv(ORIGINAL_NODE_ENV);
});

afterAll(() => {
  setNodeEnv(ORIGINAL_NODE_ENV);
});

function get(url: string, host = "localhost:3000") {
  return new NextRequest(url, { headers: { host } });
}

function post(url: string, host = "localhost:3000") {
  return new NextRequest(url, {
    method: "POST",
    headers: { host, origin: `http://${host}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

const PUBLIC_READS = [
  {
    name: "/api/binance/ticker",
    url: "http://localhost:3000/api/binance/ticker?symbol=BTCUSDT",
    run: tickerGet,
  },
  {
    name: "/api/binance/klines",
    url: "http://localhost:3000/api/binance/klines?symbol=BTCUSDT&interval=15m",
    run: klinesGet,
  },
  { name: "/api/binance/symbols", url: "http://localhost:3000/api/binance/symbols", run: symbolsGet },
  { name: "/api/logo", url: "http://localhost:3000/api/logo?symbol=a", run: logoGet },
  { name: "/api/news/finnhub", url: "http://localhost:3000/api/news/finnhub", run: finnhubGet },
  {
    name: "/api/calendar/xoomar",
    url: "http://localhost:3000/api/calendar/xoomar?from=2026-01-02&to=2026-01-01",
    run: xoomarGet,
  },
] as const;

const ACCOUNT_SURFACES = [
  { name: "GET /api/live/profile", run: () => liveProfileGet(get("http://localhost:3000/api/live/profile")) },
  {
    name: "POST /api/live/profile/switch",
    run: () => profileSwitchPost(post("http://localhost:3000/api/live/profile/switch")),
  },
  { name: "POST /api/live/orders", run: () => ordersPost(post("http://localhost:3000/api/live/orders")) },
  {
    name: "GET /api/admin/config",
    run: () => adminConfigGet(get("http://localhost:3000/api/admin/config")),
  },
] as const;

describe("mode predicate", () => {
  test("requires the marker, a loopback bind, and a non-production runtime", () => {
    expect(localDevEnabled()).toBe(false);

    enterLocalDev();
    expect(localDevEnabled()).toBe(true);

    setNodeEnv("production");
    expect(localDevEnabled()).toBe(false);
    setNodeEnv(ORIGINAL_NODE_ENV);

    expect(localDevEnabled()).toBe(true);
    enterLocalDev("0.0.0.0");
    expect(localDevEnabled()).toBe(false);
  });

  test("accepts only the two exact loopback Hosts on port 3000", () => {
    expect(localDevHostAllowed("localhost:3000")).toBe(true);
    expect(localDevHostAllowed("127.0.0.1:3000")).toBe(true);
    expect(localDevHostAllowed("LOCALHOST:3000")).toBe(true);
    for (const host of [
      "evil.example",
      "evil.example:3000",
      "localhost:3001",
      "127.0.0.1:3001",
      "localhost",
      "localhost:3000.evil.example",
      "sub.localhost:3000",
      "192.168.1.5:3000",
      "",
      null,
    ]) {
      expect(localDevHostAllowed(host)).toBe(false);
    }
  });

  test("loopback binding accepts names and literals only", () => {
    expect(isLoopbackBinding("127.0.0.1")).toBe(true);
    expect(isLoopbackBinding("::1")).toBe(true);
    expect(isLoopbackBinding("[::1]")).toBe(true);
    expect(isLoopbackBinding("localhost")).toBe(true);
    expect(isLoopbackBinding("0.0.0.0")).toBe(false);
    expect(isLoopbackBinding("::")).toBe(false);
    expect(isLoopbackBinding("10.0.0.4")).toBe(false);
    expect(isLoopbackBinding(undefined)).toBe(false);
  });

  test("startup refuses a marker without a loopback bind", () => {
    expect(() => assertLocalDevBinding()).not.toThrow();

    enterLocalDev();
    expect(() => assertLocalDevBinding()).not.toThrow();

    enterLocalDev("0.0.0.0");
    expect(() => assertLocalDevBinding()).toThrow(/localhost-only/);

    process.env.MAWS_LOCAL_DEV = "1";
    delete process.env.MAWS_LOCAL_DEV_BIND;
    expect(() => assertLocalDevBinding()).toThrow(/localhost-only/);
  });
});

describe("public-data proxies in local-dev mode", () => {
  for (const route of PUBLIC_READS) {
    test(`${route.name} answers anonymously with the marker and a localhost Host`, async () => {
      enterLocalDev();
      const response = await route.run(get(route.url) as never);
      // Past the auth gate: the upstream is blocked by the test network guard
      // (or validation fails), but never 401.
      expect(response.status).not.toBe(401);
    });

    test(`${route.name} still returns 401 without the marker`, async () => {
      const response = await route.run(get(route.url) as never);
      expect(response.status).toBe(401);
    });

    test(`${route.name} returns 401 for a foreign Host even with the marker`, async () => {
      enterLocalDev();
      const response = await route.run(get(route.url, "evil.example") as never);
      expect(response.status).toBe(401);
    });

    test(`${route.name} returns 401 in a production runtime even with the marker`, async () => {
      enterLocalDev();
      setNodeEnv("production");
      const response = await route.run(get(route.url) as never);
      expect(response.status).toBe(401);
    });
  }
});

describe("account and admin surfaces never take the anonymous path", () => {
  for (const surface of ACCOUNT_SURFACES) {
    test(`${surface.name} returns 401 with the marker and a localhost Host`, async () => {
      enterLocalDev();
      const response = await surface.run();
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("unauthenticated");
    });
  }

  test("GET /api/live/state answers only the minimal signed-out stub", async () => {
    enterLocalDev();
    const response = await liveStateGet(get("http://localhost:3000/api/live/state"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attached: false, loginRequired: true });
  });

  test("GET /api/live/state requires a session without the marker", async () => {
    const response = await liveStateGet(get("http://localhost:3000/api/live/state"));
    expect(response.status).toBe(401);
  });
});

describe("the proxy gate", () => {
  function call(pathname: string, host = "localhost:3000") {
    return proxy(new NextRequest(`http://localhost:3000${pathname}`, { headers: { host } }));
  }

  test("serves the chart and public data anonymously only in local-dev mode", () => {
    expect(call("/").status).toBe(307);
    expect(call("/api/binance/ticker").status).toBe(401);

    enterLocalDev();
    expect(call("/").status).toBe(200);
    expect(call("/api/binance/ticker").status).toBe(200);
    expect(call("/api/binance/klines").status).toBe(200);
    expect(call("/api/binance/symbols").status).toBe(200);
    expect(call("/api/logo").status).toBe(200);
    expect(call("/api/news/finnhub").status).toBe(200);
    expect(call("/api/calendar/xoomar").status).toBe(200);
    expect(call("/api/live/state").status).toBe(200);
  });

  test("keeps every account, admin, status and journal path behind the login", () => {
    enterLocalDev();
    for (const pathname of [
      "/admin",
      "/status",
      "/journal",
      "/api/admin/config",
      "/api/live/profile",
      "/api/live/profiles",
      "/api/binance/ticker/extra",
    ]) {
      expect(call(pathname).status).not.toBe(200);
    }
  });

  test("ignores the marker for a foreign Host", () => {
    enterLocalDev();
    expect(call("/", "evil.example").status).toBe(307);
    expect(call("/api/binance/ticker", "evil.example").status).toBe(401);
  });

  test("ignores the marker in a production runtime", () => {
    enterLocalDev();
    setNodeEnv("production");
    expect(call("/").status).toBe(307);
    expect(call("/api/binance/ticker").status).toBe(401);
  });
});

describe("page guards", () => {
  test("the chart opens anonymously only in local-dev mode", () => {
    const headers = { get: (name: string) => (name.toLowerCase() === "host" ? "localhost:3000" : null) };
    expect(isChartPageAuthorized(headers)).toBe(false);

    enterLocalDev();
    expect(isChartPageAuthorized(headers)).toBe(true);

    const foreignHost = { get: (name: string) => (name.toLowerCase() === "host" ? "evil.example" : null) };
    expect(isChartPageAuthorized(foreignHost)).toBe(false);
  });

  test("operator pages require a session even in local-dev mode", () => {
    enterLocalDev();
    const headers = { get: (name: string) => (name.toLowerCase() === "host" ? "localhost:3000" : null) };
    expect(isOperatorPageAuthorized(null)).toBe(false);
    expect(isChartPageAuthorized(headers)).toBe(true);
  });
});
