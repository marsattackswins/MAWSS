import { NextRequest, NextResponse } from "next/server";
import {
  installTerminalCapture,
  terminalLogsSnapshot,
} from "@/lib/server/log/terminal-capture";
import { serverConfig } from "@/lib/server/env/config";
import { authenticate, isAuthFailure } from "@/lib/server/http/guards";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/logs
 * Returns the most recent server terminal output (stdout/stderr) captured
 * in memory by the running process. Shown on /admin under "Terminal logs".
 * Requires operator authentication.
 */
export async function GET(req: NextRequest) {
  const cfg = serverConfig();
  const ctx = authenticate(req, cfg);
  if (isAuthFailure(ctx)) return ctx.response;
  installTerminalCapture();

  const parsed = Number.parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(parsed) ? parsed : 200;

  return NextResponse.json(terminalLogsSnapshot(limit), {
    headers: { "cache-control": "no-store" },
  });
}
