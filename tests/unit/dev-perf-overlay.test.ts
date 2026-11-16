import {
  describeBrowser,
  frameStats,
  perfOverlayAllowed,
  perfOverlayEnabled,
  perfOverlayRequested,
  percentile,
} from "@/lib/dev-perf-overlay";

/**
 * The overlay is a development aid: it must never switch on without `?perf=1`,
 * and never in a production build even when the flag is there.
 */
describe("perf overlay gate", () => {
  it("is off when the flag is absent", () => {
    expect(perfOverlayRequested("")).toBe(false);
    expect(perfOverlayRequested("?")).toBe(false);
    expect(perfOverlayRequested("?symbol=BTCUSDT")).toBe(false);
    expect(perfOverlayEnabled("", "development")).toBe(false);
    expect(perfOverlayEnabled("?", "development")).toBe(false);
  });

  it("is on only for perf=1", () => {
    expect(perfOverlayRequested("?perf=1")).toBe(true);
    expect(perfOverlayRequested("?symbol=BTCUSDT&perf=1")).toBe(true);
    expect(perfOverlayRequested("perf=1")).toBe(true);
    expect(perfOverlayRequested("?perf=0")).toBe(false);
    expect(perfOverlayRequested("?perf=true")).toBe(false);
    expect(perfOverlayEnabled("?perf=1", "development")).toBe(true);
    expect(perfOverlayEnabled("?perf=1", "test")).toBe(true);
  });

  it("is never enabled in a production build, flag or not", () => {
    expect(perfOverlayAllowed("production")).toBe(false);
    expect(perfOverlayEnabled("?perf=1", "production")).toBe(false);
    expect(perfOverlayEnabled("", "production")).toBe(false);
  });
});

describe("describeBrowser", () => {
  it("names the installed browsers", () => {
    const chrome =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.8103.51 Safari/537.36";
    expect(describeBrowser(chrome)).toEqual({ name: "Chrome", version: "157.0.8103.51" });
    expect(describeBrowser(`${chrome} Edg/141.0.1`)).toEqual({ name: "Edge", version: "141.0.1" });
    expect(describeBrowser("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0")).toEqual({
      name: "Firefox",
      version: "130.0",
    });
    expect(describeBrowser("Mozilla/5.0 (Macintosh) Version/17.4 Safari/605.1.15")).toEqual({
      name: "Safari",
      version: "17.4",
    });
    expect(describeBrowser("")).toEqual({ name: "unknown", version: "unknown" });
  });
});

describe("frameStats", () => {
  it("reports fps, median and p99 frame interval", () => {
    // 120 frames at a steady 8ms plus one 40ms hitch. Nearest-rank p99 of 121
    // samples is the 120th value, so a single hitch shows up in the max, not p99.
    const intervals = [...Array(120).fill(8), 40];
    const stats = frameStats(intervals);
    expect(stats.samples).toBe(121);
    expect(stats.medianMs).toBe(8);
    expect(stats.p99Ms).toBe(8);
    expect(Math.max(...intervals)).toBe(40);
    // Two hitches out of 101 samples do reach p99.
    expect(frameStats([...Array(99).fill(8), 40, 40]).p99Ms).toBe(40);
    expect(stats.fps).toBeCloseTo(121000 / (120 * 8 + 40), 0);
  });

  it("ignores empty or bogus samples", () => {
    expect(frameStats([])).toEqual({ samples: 0, fps: 0, medianMs: 0, p99Ms: 0 });
    expect(frameStats([0, Number.NaN, -5])).toEqual({ samples: 0, fps: 0, medianMs: 0, p99Ms: 0 });
  });

  it("takes the nearest-rank percentile of a sorted list", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 99)).toBe(4);
    expect(percentile([], 99)).toBe(0);
  });
});
