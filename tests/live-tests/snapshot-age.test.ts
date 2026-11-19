/**
 * FIX B (batch 1b) — the execution gate's snapshot-age bound must not fight
 * the reconciliation cadence, while a genuinely stale snapshot still blocks.
 *
 * Reconciliation refreshes the authoritative snapshot every 60 s (with up to
 * 5 s of REST latency), so a 60 s gate bound rejects orders for no reason
 * between passes. The gate now allows 180 s while risk-data freshness stays at
 * 60 s for the risk-increasing path.
 */

import { executionDecision } from "@/lib/server/gates/execution";
import { setHealthSignal } from "@/lib/server/health/state";
import { RUNTIME_KEYS, setRuntime } from "@/lib/server/runtime/flags";
import { persistenceProfileFromConfig } from "@/lib/server/profile/context";
import { freshEnv, makeCfg } from "./helpers";

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
const RECON_INTERVAL_MS = 60_000;
const REST_LATENCY_MS = 5_000;
const GATE_MAX_AGE_MS = 180_000;

function setup() {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  const cfg = freshEnv(
    makeCfg({
      gateSnapshotMaxAgeMs: GATE_MAX_AGE_MS,
      riskDataMaxAgeMs: 60_000,
      reconIntervalMs: RECON_INTERVAL_MS,
    }),
  );
  const profile = persistenceProfileFromConfig(cfg);
  setRuntime(RUNTIME_KEYS.executionEnabled, "true", T0, profile);
  setRuntime(RUNTIME_KEYS.killSwitch, "false", T0, profile);
  return cfg;
}

/** Rewrites the stream signals to "live right now" so only snapshot age varies. */
function markStreamLive(now: number): void {
  setHealthSignal({
    managerRunning: true,
    brokerStatus: "ready",
    stream: {
      connected: true,
      leaseOwned: true,
      phase: "live",
      startedAt: T0,
      lastEventAt: now,
      lastApplicationEventAt: now,
      reconnects: 0,
      listenKeyRenewedAt: null,
      generation: 1,
      bufferOverflow: false,
      circuitState: "closed",
    },
    recon: { lastRunAt: now, lastResult: "ok", driftCount: 0 },
    positionMode: { mode: "one-way", checkedAt: T0, error: null },
  });
}

describe("execution gate snapshot age vs reconciliation cadence", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("ten minutes of normal operation never rejects an order for snapshot staleness", () => {
    const cfg = setup();

    // The snapshot is refreshed when each reconciliation pass finishes.
    let snapshotFetchedAt = T0;
    setHealthSignal({ snapshot: { fetchedAt: snapshotFetchedAt } });

    let worstAgeMs = 0;
    for (let second = 0; second <= 600; second += 1) {
      const now = T0 + second * 1000;
      jest.setSystemTime(now);

      // A pass started 60 s ago completes now, after its REST latency.
      const sincePassStart = second * 1000;
      if (sincePassStart >= REST_LATENCY_MS && (sincePassStart - REST_LATENCY_MS) % RECON_INTERVAL_MS === 0) {
        snapshotFetchedAt = now;
        setHealthSignal({ snapshot: { fetchedAt: snapshotFetchedAt } });
      }

      markStreamLive(now);
      worstAgeMs = Math.max(worstAgeMs, now - snapshotFetchedAt);

      const decision = executionDecision(cfg);
      expect(decision.snapshotFresh).toBe(true);
      expect(decision.reasons).not.toContain("snapshot too old");
      // No order class is blocked for any other reason either: ordinary,
      // protective (TP/SL), reduce-only and close all pass the gate.
      expect(decision.canSubmit).toBe(true);
    }

    // The bound is what makes this hold: worst case is one cadence plus latency.
    expect(worstAgeMs).toBeLessThanOrEqual(RECON_INTERVAL_MS + REST_LATENCY_MS);
    // It does reach one cadence: a 60 s bound would have rejected orders here.
    expect(worstAgeMs).toBeGreaterThanOrEqual(RECON_INTERVAL_MS - REST_LATENCY_MS);
  });

  test("a snapshot left behind by four minutes of failing reconciliation blocks orders", () => {
    const cfg = setup();
    setHealthSignal({ snapshot: { fetchedAt: T0 } });

    // Reconciliation keeps failing: no new snapshot for four minutes.
    const now = T0 + 4 * 60_000;
    jest.setSystemTime(now);
    markStreamLive(now);
    setHealthSignal({ recon: { lastRunAt: now, lastResult: "error", driftCount: 0 } });

    const decision = executionDecision(cfg);
    expect(decision.snapshotFresh).toBe(false);
    expect(decision.canSubmit).toBe(false);
    expect(decision.reasons).toContain("snapshot too old");
  });
});
