/**
 * FIX C — listenKey expiry and stream liveness.
 *
 * The fake WS plus ManualTimers drive every path: the listenKeyExpired event,
 * keepalive retry/rotation, -1125, server-ping liveness and the absence of
 * false positives on a quiet (but pinged) account.
 */

import { BinanceRestClient } from "@/lib/server/binance/rest";
import { RateLimiter } from "@/lib/server/binance/ratelimit";
import { StreamOwnerLease } from "@/lib/server/binance/lease";
import { PING_TIMEOUT_MS, SERVER_PING_INTERVAL_MS, UserDataStream } from "@/lib/server/binance/stream";
import { FakeHttp, FakeWs, ManualTimers, freshEnv, installFakes, jsonRes, makeCfg } from "./helpers";

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function setup() {
  const cfg = freshEnv(makeCfg());
  const http = new FakeHttp();
  installFakes(http);
  let posts = 0;
  http.route("/fapi/v1/listenKey", () => {
    const last = http.calls[http.calls.length - 1];
    if (last?.method === "POST") posts += 1;
    return jsonRes({ listenKey: `LK-${Math.max(1, posts)}` });
  });
  const rest = new BinanceRestClient(cfg, new RateLimiter(cfg.rateInternalPerMin), async () => undefined);
  rest.setTransportForTests(http);
  const timers = new ManualTimers();
  const clock = { now: 1_700_000_000_000 };
  const freezes: Array<{ reason: string; code?: string }> = [];
  const alerts: Array<{ key: string; data: Record<string, unknown> }> = [];
  let snapshotCalls = 0;
  const stream = new UserDataStream({
    cfgEnv: "testnet",
    rest,
    lease: new StreamOwnerLease("liveness", cfg.leaseTtlMs),
    takeSnapshot: async () => {
      snapshotCalls += 1;
    },
    processEvent: () => undefined,
    freeze: (reason, code) => freezes.push({ reason, code }),
    alert: (key, data) => alerts.push({ key, data }),
    onStatus: () => undefined,
    timers,
    now: () => clock.now,
  });
  return {
    http,
    timers,
    clock,
    stream,
    freezes,
    alerts,
    snapshotCalls: () => snapshotCalls,
    posts: () => http.callsTo("/fapi/v1/listenKey").filter((c) => c.method === "POST").length,
  };
}

async function started() {
  const h = setup();
  await h.stream.start();
  FakeWs.last().emitOpen();
  await flush();
  return h;
}

describe("listenKey expiry and stream liveness", () => {
  test("listenKeyExpired creates a new key, reconnects, resnapshots, freezes and alerts", async () => {
    const h = await started();
    expect(h.snapshotCalls()).toBe(1);

    FakeWs.last().emitMessage({ e: "listenKeyExpired" });
    await flush();

    expect(h.posts()).toBe(2);
    expect(FakeWs.instances).toHaveLength(2);
    expect(FakeWs.last().url).toContain("LK-2");
    expect(h.freezes.some((f) => f.code === "LISTEN_KEY_EXPIRED")).toBe(true);

    FakeWs.last().emitOpen();
    await flush();
    expect(h.snapshotCalls()).toBe(2);
    expect(h.alerts.map((a) => a.key)).toContain("listen_key_expired");
    h.stream.stop();
  });

  test("a keepalive that fails once retries with backoff and keeps the key", async () => {
    const h = await started();
    h.http.script("/fapi/v1/listenKey", () => jsonRes({ code: -1001, msg: "timeout" }, 500));

    h.timers.advance(25 * 60 * 1000);
    await flush();
    h.timers.advance(1_000);
    await flush();

    const puts = h.http.callsTo("/fapi/v1/listenKey").filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(h.posts()).toBe(1);
    expect(FakeWs.instances).toHaveLength(1);
    h.stream.stop();
  });

  test("three consecutive keepalive failures rotate the key and reconnect", async () => {
    const h = await started();
    for (let i = 0; i < 3; i++) h.http.script("/fapi/v1/listenKey", () => jsonRes({ code: -1001, msg: "timeout" }, 500));

    h.timers.advance(25 * 60 * 1000);
    await flush();
    h.timers.advance(1_000); // retry 1
    await flush();
    h.timers.advance(2_000); // retry 2
    await flush();

    expect(h.posts()).toBe(2);
    expect(FakeWs.instances).toHaveLength(2);
    expect(h.freezes.some((f) => f.code === "STREAM_DOWN")).toBe(true);
    expect(h.alerts.map((a) => a.key)).toContain("listen_key_rotation");
    h.stream.stop();
  });

  test("-1125 from the keepalive rotates immediately", async () => {
    const h = await started();
    h.http.scriptApiError("/fapi/v1/listenKey", -1125, "This listenKey does not exist.", 400);

    h.timers.advance(25 * 60 * 1000);
    await flush();

    expect(h.posts()).toBe(2);
    expect(h.freezes.some((f) => f.code === "STREAM_DOWN")).toBe(true);
    h.stream.stop();
  });

  test("no ping or message within the liveness limit reconnects with the same key", async () => {
    const h = await started();
    const first = FakeWs.last();

    h.clock.now += PING_TIMEOUT_MS + 1;
    h.timers.advance(SERVER_PING_INTERVAL_MS);
    h.timers.advance(1_000); // reconnect backoff scheduled by the check
    await flush();

    expect(FakeWs.instances).toHaveLength(2);
    expect(FakeWs.last().url).toBe(first.url);
    expect(h.freezes.some((f) => f.code === "STREAM_DOWN")).toBe(true);
    expect(h.alerts.map((a) => a.key)).toContain("stream_ping_timeout");
    h.stream.stop();
  });

  test("a quiet account that keeps answering server pings is never treated as dead", async () => {
    const h = await started();
    for (let i = 0; i < 5; i++) {
      h.clock.now += SERVER_PING_INTERVAL_MS;
      FakeWs.last().emitPing();
      h.timers.advance(SERVER_PING_INTERVAL_MS);
      await flush();
    }
    expect(FakeWs.instances).toHaveLength(1);
    expect(h.freezes).toEqual([]);
    h.stream.stop();
  });

  test("three failed reconnects on one key rotate it", async () => {
    const h = await started();
    for (const delay of [1_000, 2_000, 4_000]) {
      FakeWs.last().emitClose();
      h.timers.advance(delay);
      await flush();
    }
    expect(h.posts()).toBe(1);

    FakeWs.last().emitClose();
    h.timers.advance(8_000);
    await flush();

    expect(h.posts()).toBe(2);
    expect(FakeWs.last().url).toContain("LK-2");
    h.stream.stop();
  });
});
