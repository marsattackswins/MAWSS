import "server-only";

import { serverConfig } from "../env/config";
import { log } from "../log/logger";
import { enqueueAlert, isCriticalAlert } from "./outbox";

const RATE_WINDOW_MS = 60_000;
const lastSent = new Map<string, number>();

export function resetAlertsForTests(): void {
  lastSent.clear();
}

export function alert(event: string, detail: Record<string, unknown>): void {
  let url: string | null;
  try {
    url = serverConfig().alertWebhookUrl;
  } catch {
    return;
  }
  if (!url) return;

  // Critical events are durable: a transient webhook failure must not drop an
  // unprotected position, a freeze or a listen-key fault.
  if (isCriticalAlert(event)) {
    enqueueAlert(event, detail, serverConfig().env);
    return;
  }

  const now = Date.now();
  const prev = lastSent.get(event);
  if (prev != null && now - prev < RATE_WINDOW_MS) return;
  lastSent.set(event, now);

  const body = JSON.stringify({ event, detail, env: serverConfig().env, ts: now });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5_000);

  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: ac.signal,
  })
    .then((res) => {
      if (!res.ok) log.warn("alert webhook returned non-2xx", { event, status: res.status });
    })
    .catch((err) => {
      log.warn("alert webhook failed", { event, error: String(err) });
    })
    .finally(() => clearTimeout(timer));
}
