/**
 * SSE (E): heartbeat session revalidation and a bounded per-client queue.
 *
 * Both defects are about a stream that outlives its right to exist: a revoked
 * session kept receiving account events, and a tab that stopped reading let
 * the server buffer without limit.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

import { GET, SSE_HEARTBEAT_MS, SSE_MAX_PENDING_EVENTS } from "@/app/api/live/events/route";
import { publishLive, sseBus } from "@/lib/server/binance/sse";
import { createSession, revokeSession, sessionCookieName } from "@/lib/server/auth/session";
import { freshEnv, makeCfg } from "./helpers";

let session: { sessionId: string; csrfToken: string };

function request(): Request {
  return new Request("http://localhost:3000/api/live/events", {
    headers: {
      cookie: `${sessionCookieName(false)}=${session.sessionId}`,
      origin: "http://localhost:3000",
    },
  });
}

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ text: string; done: boolean }> {
  const { value, done } = await reader.read();
  return { text: value ? new TextDecoder().decode(value) : "", done: done === true };
}

beforeEach(() => {
  freshEnv(makeCfg());
  sseBus.resetForTests();
  session = createSession("sse-route-test");
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  sseBus.resetForTests();
});

describe("SSE heartbeat", () => {
  test("closes the stream when the session is revoked", async () => {
    const response = await GET(request());
    const reader = response.body!.getReader();

    const hello = await readEvent(reader);
    expect(hello.text).toContain("event: hello");
    expect((await readEvent(reader)).text).toContain("event: state");
    expect((await readEvent(reader)).text).toContain("event: health");

    revokeSession(session.sessionId);
    jest.advanceTimersByTime(SSE_HEARTBEAT_MS);

    const expired = await readEvent(reader);
    expect(expired.text).toContain("event: session-expired");
    expect(expired.done).toBe(false);

    expect((await readEvent(reader)).done).toBe(true);
  });

  test("pings and keeps a valid session open", async () => {
    const response = await GET(request());
    const reader = response.body!.getReader();
    await readEvent(reader);
    await readEvent(reader);
    await readEvent(reader);

    jest.advanceTimersByTime(SSE_HEARTBEAT_MS);
    const ping = await readEvent(reader);
    expect(ping.text).toContain("event: ping");
    expect(ping.done).toBe(false);
  });

  test("rejects an unauthenticated request without opening a stream", async () => {
    const response = await GET(
      new Request("http://localhost:3000/api/live/events", { headers: { origin: "http://localhost:3000" } }),
    );
    expect(response.status).toBe(401);
  });
});

describe("SSE queue cap", () => {
  test("closes a client that stops draining with a final slow-client event", async () => {
    const response = await GET(request());
    const reader = response.body!.getReader();

    // Nobody reads: the queue fills, and further publishes close the stream.
    for (let i = 0; i < SSE_MAX_PENDING_EVENTS * 4; i += 1) {
      publishLive("account-update", { at: i });
    }

    const chunks: string[] = [];
    for (;;) {
      const next = await readEvent(reader);
      if (next.text) chunks.push(next.text);
      if (next.done) break;
      // Guard against a bug that leaves the stream open forever.
      if (chunks.length > SSE_MAX_PENDING_EVENTS * 4) break;
    }

    const last = chunks[chunks.length - 1] ?? "";
    expect(last).toContain("event: stream-closed");
    expect(last).toContain("\"reason\":\"slow_client\"");
    // Bounded: the initial three events + at most the high-water mark + final.
    expect(chunks.length).toBeLessThanOrEqual(SSE_MAX_PENDING_EVENTS + 4);
  });
});
