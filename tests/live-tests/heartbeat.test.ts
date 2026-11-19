/**
 * F2 — optional dead-man's-switch heartbeat.
 *
 * A GET every 60 s while a profile is attached. Failures are logged and never
 * throw into the caller: silence is the signal an external monitor watches.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

import { createHeartbeatMonitor, HEARTBEAT_INTERVAL_MS } from "@/lib/server/heartbeat";

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("heartbeat monitor", () => {
  test("is disabled without a URL", () => {
    expect(createHeartbeatMonitor({ url: null, isActive: () => true })).toBeNull();
    expect(createHeartbeatMonitor({ url: "   ", isActive: () => true })).toBeNull();
  });

  test("pings once per interval while a profile is attached", async () => {
    const fetchImpl = jest.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response("ok", { status: 200 }),
    );
    const monitor = createHeartbeatMonitor({ url: "https://hc.test/ping", isActive: () => true, fetchImpl: fetchImpl as unknown as typeof fetch })!;

    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://hc.test/ping");

    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    monitor.stop();
  });

  test("stops pinging when detached or stopped", async () => {
    const fetchImpl = jest.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response("ok", { status: 200 }),
    );
    let active = false;
    const monitor = createHeartbeatMonitor({ url: "https://hc.test/ping", isActive: () => active, fetchImpl: fetchImpl as unknown as typeof fetch })!;

    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(fetchImpl).not.toHaveBeenCalled();

    active = true;
    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    monitor.stop();
    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("a failing ping is swallowed and the next one is still scheduled", async () => {
    const fetchImpl = jest
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new Error("dns failure"))
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const monitor = createHeartbeatMonitor({ url: "https://hc.test/ping", isActive: () => true, fetchImpl: fetchImpl as unknown as typeof fetch })!;

    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    monitor.stop();
  });
});
