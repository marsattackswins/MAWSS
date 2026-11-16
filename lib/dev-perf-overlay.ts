/**
 * Pure helpers behind the dev-only perf overlay (`?perf=1`).
 *
 * Kept free of DOM access so the gate can be unit-tested in the node jest
 * environment, and so the overlay itself decides what to do with the answer.
 */

/** The query flag that asks for the overlay. */
export const PERF_OVERLAY_PARAM = "perf";

/** `?perf=1` (or `perf=1` without the leading `?`). Anything else is off. */
export function perfOverlayRequested(search: string): boolean {
  if (!search) return false;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return params.get(PERF_OVERLAY_PARAM) === "1";
}

/** The overlay is a development aid: never in a production build. */
export function perfOverlayAllowed(nodeEnv: string | undefined): boolean {
  return nodeEnv !== "production";
}

/**
 * Both gates. A production build returns false even with `?perf=1`, so the
 * flag can never switch app instrumentation on in a shipped bundle.
 */
export function perfOverlayEnabled(search: string, nodeEnv: string | undefined): boolean {
  return perfOverlayAllowed(nodeEnv) && perfOverlayRequested(search);
}

export type BrowserIdentity = { name: string; version: string };

/**
 * Browser name + version from the user-agent. Deliberately small: this only has
 * to name the browser a dev is looking at, not identify every build.
 */
export function describeBrowser(userAgent: string): BrowserIdentity {
  const ua = userAgent || "";
  const match = (pattern: RegExp): string | null => {
    const hit = pattern.exec(ua);
    return hit?.[1] ?? null;
  };
  const edge = match(/Edg\/([\d.]+)/);
  if (edge) return { name: "Edge", version: edge };
  const opera = match(/OPR\/([\d.]+)/);
  if (opera) return { name: "Opera", version: opera };
  const firefox = match(/Firefox\/([\d.]+)/);
  if (firefox) return { name: "Firefox", version: firefox };
  const chrome = match(/Chrome\/([\d.]+)/);
  if (chrome) return { name: "Chrome", version: chrome };
  const safari = match(/Version\/([\d.]+).*Safari/);
  if (safari) return { name: "Safari", version: safari };
  return { name: "unknown", version: "unknown" };
}

/** Nearest-rank percentile of an ascending-sorted list. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export type FrameStats = { samples: number; fps: number; medianMs: number; p99Ms: number };

/** FPS plus the frame-interval distribution for a window of rAF deltas. */
export function frameStats(intervals: readonly number[]): FrameStats {
  const clean = intervals.filter((v) => Number.isFinite(v) && v > 0);
  if (clean.length === 0) return { samples: 0, fps: 0, medianMs: 0, p99Ms: 0 };
  const sorted = [...clean].sort((a, b) => a - b);
  const total = clean.reduce((sum, v) => sum + v, 0);
  const round = (v: number) => +v.toFixed(2);
  return {
    samples: clean.length,
    fps: total > 0 ? +(1000 / (total / clean.length)).toFixed(1) : 0,
    medianMs: round(percentile(sorted, 50)),
    p99Ms: round(percentile(sorted, 99)),
  };
}
