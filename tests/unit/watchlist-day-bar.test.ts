import { describe, it, expect } from "@jest/globals";
import { dayBarGeometry } from "@/components/maws/StrategyScreener";
import { dayStatsFromTip } from "@/lib/market/binance-feed";
import type { Candle } from "@/types";

/**
 * The watchlist move bar is a center-anchored diverging gauge: the center is
 * the UTC day's open, the left end the day's low and the right end the day's
 * high (each half scaled to its own extreme). The fill grows from the center
 * toward the last price. dayBarGeometry is the pure layout math;
 * dayStatsFromTip derives the day's open/high/low from the forming 1D bar.
 */

const DAY_SEC = 86_400;
/** A UTC midnight (1_700_006_400 = 19_676 * 86_400). */
const DAY_START = 1_700_006_400;
const NOW_MS = (DAY_START + 3_600) * 1_000;

const candle = (over: Partial<Candle> = {}): Candle => ({
  time: DAY_START,
  open: 100,
  high: 110,
  low: 90,
  close: 105,
  volume: 1_000,
  ...over,
});

describe("dayBarGeometry (center-open diverging gauge)", () => {
  const day = { open: 100, high: 110, low: 90 };

  it("grows rightward from the center when the price is above the open", () => {
    const bar = dayBarGeometry(day, 105);
    expect(bar).toEqual({ lastPct: 75, fillLeft: 50, fillWidth: 25 });
  });

  it("grows leftward from the center when the price is below the open", () => {
    const bar = dayBarGeometry(day, 95);
    expect(bar).toEqual({ lastPct: 25, fillLeft: 25, fillWidth: 25 });
  });

  it("keeps a 2% minimum fill when the price sits exactly on the open", () => {
    const bar = dayBarGeometry(day, 100);
    expect(bar).toEqual({ lastPct: 50, fillLeft: 50, fillWidth: 2 });
  });

  it("scales each half to its own extreme: a full side move reaches the end cap", () => {
    const asym = { open: 92, high: 110, low: 90 };
    expect(dayBarGeometry(asym, 110)).toEqual({ lastPct: 100, fillLeft: 50, fillWidth: 50 });
    expect(dayBarGeometry(asym, 90)).toEqual({ lastPct: 0, fillLeft: 0, fillWidth: 50 });
  });

  it("maps a quarter of the side's move to a quarter of that half", () => {
    expect(dayBarGeometry(day, 102.5)).toEqual({ lastPct: 62.5, fillLeft: 50, fillWidth: 12.5 });
  });

  it("clamps prices outside the day's range to the end caps", () => {
    expect(dayBarGeometry(day, 120)?.lastPct).toBe(100);
    expect(dayBarGeometry(day, 80)?.lastPct).toBe(0);
  });

  it("returns null for a degenerate range or missing prices", () => {
    expect(dayBarGeometry({ open: 100, high: 100, low: 100 }, 100)).toBeNull();
    expect(dayBarGeometry({ open: 0, high: 110, low: 90 }, 105)).toBeNull();
    expect(dayBarGeometry(day, 0)).toBeNull();
  });
});

describe("dayStatsFromTip (UTC day open/high/low)", () => {
  it("takes the open from the forming daily bar and extends high/low with the last price", () => {
    expect(dayStatsFromTip(candle(), 115, {}, NOW_MS, false)).toEqual({
      dayOpen: 100,
      dayHigh: 115,
      dayLow: 90,
    });
    expect(dayStatsFromTip(candle(), 85, {}, NOW_MS, false)).toEqual({
      dayOpen: 100,
      dayHigh: 110,
      dayLow: 85,
    });
  });

  it("keeps same-day extremes observed earlier (anchored prev)", () => {
    const prev = { dayOpen: 100, dayHigh: 120, dayLow: 80 };
    expect(dayStatsFromTip(candle(), 105, prev, NOW_MS, true)).toEqual({
      dayOpen: 100,
      dayHigh: 120,
      dayLow: 80,
    });
  });

  it("resets yesterday's extremes when the anchor breaks (new UTC day)", () => {
    const prev = { dayOpen: 100, dayHigh: 120, dayLow: 80 };
    expect(dayStatsFromTip(candle(), 105, prev, NOW_MS, false)).toEqual({
      dayOpen: 100,
      dayHigh: 110,
      dayLow: 90,
    });
  });

  it("clears the fields when the tip is yesterday's or missing", () => {
    const stale = candle({ time: DAY_START - DAY_SEC });
    expect(dayStatsFromTip(stale, 105, {}, NOW_MS, true)).toEqual({
      dayOpen: undefined,
      dayHigh: undefined,
      dayLow: undefined,
    });
    expect(dayStatsFromTip(undefined, 105, {}, NOW_MS, true)).toEqual({
      dayOpen: undefined,
      dayHigh: undefined,
      dayLow: undefined,
    });
  });

  it("falls back to the bar's own high/low when no valid last price exists", () => {
    expect(dayStatsFromTip(candle(), 0, {}, NOW_MS, false)).toEqual({
      dayOpen: 100,
      dayHigh: 110,
      dayLow: 90,
    });
    expect(dayStatsFromTip(candle(), NaN, {}, NOW_MS, false)).toEqual({
      dayOpen: 100,
      dayHigh: 110,
      dayLow: 90,
    });
  });
});