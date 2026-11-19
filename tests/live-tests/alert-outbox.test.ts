/**
 * F1 — durable outbox for critical alerts.
 *
 * A dropped webhook used to lose the alert entirely. Critical events now
 * persist, retry with backoff, and only give up after 24 hours; non-critical
 * events keep the existing in-memory throttle.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

import { getDb } from "@/lib/server/db/connection";
import { alert, resetAlertsForTests } from "@/lib/server/alerts/dispatch";
import {
  alertBackoffMs,
  deliverPendingAlerts,
  isCriticalAlert,
  OUTBOX_MAX_AGE_MS,
  resetAlertOutboxForTests,
} from "@/lib/server/alerts/outbox";
import { freshEnv, makeCfg } from "./helpers";

const HOOK = "https://alerts.test/hook";

function rows(): Array<{ event: string; attempts: number; delivered_at: number | null; next_attempt_at: number; last_error: string | null }> {
  return getDb().prepare(`SELECT event, attempts, delivered_at, next_attempt_at, last_error FROM alert_outbox ORDER BY id`).all() as never;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  freshEnv(makeCfg({ alertWebhookUrl: HOOK }));
  resetAlertsForTests();
  resetAlertOutboxForTests();
});

afterEach(() => {
  resetAlertOutboxForTests();
  jest.restoreAllMocks();
});

describe("critical alert outbox", () => {
  test("classifies the critical events, including symbol-suffixed ones", () => {
    for (const event of [
      "freeze",
      "binance_ip_ban",
      "position_unprotected:BTCUSDT",
      "listen_key_expired",
      "listen_key_rotation_failed",
      "order.reduce_only_rejected_production",
      "emergency_algo_orders_remaining:BTCUSDT",
    ]) {
      expect(isCriticalAlert(event)).toBe(true);
    }
    for (const event of ["fill", "unfreeze", "stream_down", "manager_error"]) {
      expect(isCriticalAlert(event)).toBe(false);
    }
  });

  test("persists a critical alert and marks it delivered on success", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    alert("freeze", { reason: "reconciliation drift" });
    await flush();

    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0].event).toBe("freeze");
    expect(all[0].delivered_at).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(HOOK);
  });

  test("keeps an undelivered alert and retries with backoff", async () => {
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const now = Date.now();
    alert("binance_ip_ban", { status: 418 });
    await flush();

    const failed = rows()[0];
    expect(failed.delivered_at).toBeNull();
    expect(failed.attempts).toBe(1);
    expect(failed.last_error).toContain("offline");
    expect(failed.next_attempt_at).toBeGreaterThan(now);
    expect(alertBackoffMs(1)).toBe(30_000);
    expect(alertBackoffMs(2)).toBe(60_000);
    expect(alertBackoffMs(20)).toBe(60 * 60 * 1000);

    // Before the backoff elapses nothing is retried; after it, delivery lands.
    expect((await deliverPendingAlerts(now + 1_000)).delivered).toBe(0);
    const retried = await deliverPendingAlerts(failed.next_attempt_at + 1);
    expect(retried.delivered).toBe(1);
    expect(rows()[0].delivered_at).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("gives up after 24 hours", async () => {
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const now = Date.now();
    alert("freeze", {});
    await flush();

    const muchLater = now + OUTBOX_MAX_AGE_MS + 60_000;
    const result = await deliverPendingAlerts(muchLater);
    expect(result).toEqual({ delivered: 0, failed: 0 });
    expect(rows()[0].delivered_at).toBeNull();
  });

  test("non-critical alerts keep the in-memory throttle and no outbox row", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    alert("fill", { symbol: "BTCUSDT" });
    alert("fill", { symbol: "BTCUSDT" });
    await flush();

    expect(rows()).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does nothing without a configured webhook", async () => {
    freshEnv(makeCfg({ alertWebhookUrl: null }));
    const fetchMock = jest.spyOn(globalThis, "fetch");
    alert("freeze", {});
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });
});
