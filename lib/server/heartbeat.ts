import "server-only";

import { log } from "./log/logger";

/**
 * Optional dead-man's-switch ping (MAWS_HEARTBEAT_URL).
 *
 * A GET every interval while a profile is attached. Nothing depends on the
 * response: failures are logged, and a missed ping is exactly what an external
 * monitor is meant to alert on (this app cannot report its own silence).
 */
export interface HeartbeatMonitor {
  stop(): void;
}

export interface HeartbeatOptions {
  url: string | null;
  /** Only ping while this returns true (a profile is attached and running). */
  isActive: () => boolean;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}

export const HEARTBEAT_INTERVAL_MS = 60_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;

export function createHeartbeatMonitor(options: HeartbeatOptions): HeartbeatMonitor | null {
  const url = options.url?.trim();
  if (!url) return null;
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    // Not attached right now: keep the cadence so attaching resumes pings
    // without waiting for a new monitor.
    if (!options.isActive()) {
      timer = setTimeout(() => void tick(), intervalMs);
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, { method: "GET", signal: controller.signal });
      if (!response.ok) log.warn("heartbeat ping returned non-2xx", { status: response.status });
    } catch (err) {
      log.warn("heartbeat ping failed", { error: String(err) });
    } finally {
      clearTimeout(timeout);
    }
    if (!stopped && options.isActive()) timer = setTimeout(() => void tick(), intervalMs);
  };

  timer = setTimeout(() => void tick(), intervalMs);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
