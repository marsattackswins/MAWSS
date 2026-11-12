import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { resolveOperatorSession } from "@/lib/server/auth/session-guard";
import { serverConfig } from "@/lib/server/env/config";

// Token validation and response sanitization remain in the specific handlers.
function hasScopedToken(request: NextRequest): boolean {
  const path = request.nextUrl.pathname;
  if (request.method === "GET" && ["/api/health", "/api/health/broker", "/api/admin/health", "/api/admin/metrics"].includes(path)) {
    return request.headers.has("x-maws-health-token");
  }
  if (request.method === "POST" && path === "/api/live/emergency/flatten") {
    return request.headers.has("x-maws-emergency-token");
  }
  return ["GET", "POST"].includes(request.method) && path === "/api/admin/power" && request.headers.has("x-maws-supervisor-token");
}

/** Protect pages (including rewrites) and APIs; handlers recheck auth and CSRF. */
export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (["/login", "/api/auth/login", "/api/auth/session", "/api/liveness"].includes(pathname) || hasScopedToken(request)) {
    return NextResponse.next();
  }
  try {
    const cfg = serverConfig();
    if (resolveOperatorSession(request.headers.get("cookie"), cfg)) {
      const response = NextResponse.next();
      response.headers.set("cache-control", "private, no-store");
      return response;
    }
  } catch {
    return NextResponse.json({ error: { code: "config", message: "Service unavailable" } }, {
      status: 503, headers: { "cache-control": "private, no-store" },
    });
  }
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: { code: "unauthenticated", message: "Sign in required" } }, {
      status: 401, headers: { "cache-control": "private, no-store" },
    });
  }
  const response = NextResponse.redirect(new URL("/login", request.url));
  response.headers.set("cache-control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/", "/admin/:path*", "/status/:path*", "/journal/:path*", "/api/:path*"],
};
