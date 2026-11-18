import { describe, it, expect } from "@jest/globals";
import { alertSymbolKey, findCrossings, isCrossing } from "@/lib/alerts/crossing";
import type { PriceAlert } from "@/types";

const alert = (over: Partial<PriceAlert> = {}): PriceAlert => ({
  id: "a1",
  symbol: "BTCUSDT.P",
  price: 100,
  side: "above",
  enabled: true,
  ...over,
});

describe("alertSymbolKey", () => {
  it("strips the .P suffix and cases up, so quotes and alerts meet", () => {
    expect(alertSymbolKey("btcusdt.p")).toBe("BTCUSDT");
    expect(alertSymbolKey("BTCUSDT")).toBe("BTCUSDT");
  });
});

describe("isCrossing", () => {
  it("fires when an up alert's level is reached", () => {
    expect(isCrossing(alert(), 99, 100)).toBe(true);
    expect(isCrossing(alert(), 99, 101)).toBe(true);
  });

  it("does not fire while the price stays on one side", () => {
    expect(isCrossing(alert(), 100, 104)).toBe(false);
    expect(isCrossing(alert(), 98, 99.5)).toBe(false);
  });

  it("fires when a down alert's level is reached", () => {
    const down = alert({ side: "below" });
    expect(isCrossing(down, 101, 100)).toBe(true);
    expect(isCrossing(down, 101, 99)).toBe(true);
    expect(isCrossing(down, 100, 98)).toBe(false);
  });

  it("ignores disabled alerts and unusable prices", () => {
    expect(isCrossing(alert({ enabled: false }), 99, 101)).toBe(false);
    expect(isCrossing(alert(), Number.NaN, 100)).toBe(false);
    expect(isCrossing(alert({ price: Number.NaN }), 99, 100)).toBe(false);
  });
});

describe("findCrossings", () => {
  it("reports each crossed alert with the quote that crossed it", () => {
    const prev = new Map([["BTCUSDT", 99]]);
    const next = new Map([["BTCUSDT", 100.5]]);
    const hits = findCrossings([alert()], prev, next, 1700);
    expect(hits).toHaveLength(1);
    expect(hits[0].last).toBe(100.5);
    expect(hits[0].at).toBe(1700);
  });

  it("arms a symbol it has never seen instead of firing on history", () => {
    const next = new Map([["BTCUSDT", 120]]);
    expect(findCrossings([alert()], new Map(), next, 1700)).toEqual([]);
  });

  it("skips symbols with no fresh quote and disabled alerts", () => {
    const prev = new Map([["BTCUSDT", 99]]);
    const next = new Map([["BTCUSDT", 101]]);
    expect(findCrossings([alert({ enabled: false })], prev, next, 1700)).toEqual([]);
    expect(findCrossings([alert({ symbol: "ETHUSDT.P" })], prev, next, 1700)).toEqual([]);
  });

  it("matches a saved .P alert against a bare feed symbol", () => {
    const prev = new Map([["BTCUSDT", 99]]);
    const next = new Map([["BTCUSDT", 101]]);
    expect(findCrossings([alert({ symbol: "btcusdt.p" })], prev, next, 1700)).toHaveLength(1);
  });
});
