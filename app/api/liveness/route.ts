/**
 * Anonymous process liveness for infrastructure probes (Docker HEALTHCHECK,
 * systemd, nginx, Playwright readiness, the supervisor). It imports nothing
 * from the configuration, database, or broker layers: if the HTTP server can
 * answer at all, the process is alive. Attach/config state is deliberately
 * not reported here — that is /api/health, which stays authenticated.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  });
}
