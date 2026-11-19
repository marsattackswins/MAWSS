import { accountDto, accountMetricsDto, fillsDto, ordersDto, positionsDto } from "@/lib/server/binance/dto";
import { sseBus } from "@/lib/server/binance/sse";
import { getSession } from "@/lib/server/auth/session";
import { serverConfig } from "@/lib/server/env/config";
import { buildHealthStatus } from "@/lib/server/health/status";
import { activeProfileConfig, profileRuntimeStatus } from "@/lib/server/profile/coordinator";
import { authenticate, isAuthFailure } from "@/lib/server/http/guards";

export const dynamic = "force-dynamic";

/** Heartbeat cadence; also the session revalidation cadence. */
export const SSE_HEARTBEAT_MS = 25_000;

/**
 * Events a client may fall behind by before it is closed as slow. The bytes
 * are small, but an unbounded queue would let one stalled tab grow the server
 * process without limit.
 */
export const SSE_MAX_PENDING_EVENTS = 50;

function frame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Authenticated server-sent events bridge. EventSource sends the session
 * cookie automatically; the route refuses without a valid session and
 * revalidates it on every heartbeat, so a revoked or expired session cannot
 * keep receiving account data. A client that stops draining its queue is
 * closed with a final `stream-closed` event instead of being buffered.
 */
export async function GET(req: Request): Promise<Response> {
  let cfg;
  try {
    cfg = serverConfig();
  } catch {
    return new Response("config invalid", { status: 503 });
  }
  const ctx = authenticate(req, cfg);
  if (isAuthFailure(ctx)) return ctx.response;

  const subscribedGeneration = profileRuntimeStatus().generation;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        const shutdown = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = null;
          unsubscribe?.();
          unsubscribe = null;
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        };
        /** Enqueues even when the queue is full; used for the final event. */
        const sendFinal = (event: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(frame(event, data));
          } catch {
            // The consumer is already gone.
          }
          shutdown();
        };
        const send = (event: string, data: unknown): boolean => {
          if (closed) return false;
          const desired = controller.desiredSize;
          if (desired !== null && desired <= 0) {
            sendFinal("stream-closed", { reason: "slow_client", at: Date.now() });
            return false;
          }
          try {
            controller.enqueue(frame(event, data));
            return true;
          } catch {
            shutdown();
            return false;
          }
        };

        send("hello", { at: Date.now(), env: activeProfileConfig().env });
        send("state", {
          account: accountDto(),
          accountMetrics: accountMetricsDto(),
          positions: positionsDto(),
          orders: ordersDto(),
          fills: fillsDto(50),
        });
        send("health", buildHealthStatus(activeProfileConfig()));

        unsubscribe = sseBus.subscribe((event, data) => {
          if (profileRuntimeStatus().generation !== subscribedGeneration) return;
          if (event === "health") send("health", buildHealthStatus(activeProfileConfig()));
          else send(event, data);
        });

        heartbeat = setInterval(() => {
          // Revalidate: an expired or revoked session closes the stream with a
          // terminal event the client turns into a login redirect.
          if (!getSession(ctx.sessionId)) {
            sendFinal("session-expired", { at: Date.now() });
            return;
          }
          send("ping", { at: Date.now() });
        }, SSE_HEARTBEAT_MS);

        req.signal.addEventListener("abort", shutdown);
      },
      cancel() {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        unsubscribe?.();
        unsubscribe = null;
      },
    },
    { highWaterMark: SSE_MAX_PENDING_EVENTS },
  );

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
