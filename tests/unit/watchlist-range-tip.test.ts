import { describe, expect, it } from "@jest/globals";
import { placeRangeTip } from "@/components/maws/StrategyScreener";

/**
 * The range tooltip anchors beside its row, over the chart. On narrow windows
 * there is no room beside the row, so it falls back inside the viewport edge
 * instead of opening off-screen; vertically it centres on the row and clamps
 * at both viewport edges.
 */
const TIP = { w: 248, h: 155 };

describe("placeRangeTip", () => {
  it("sits 8px left of the row, centred on it, when there is room", () => {
    const row = { left: 551, top: 185, height: 36 };
    const { x, y } = placeRangeTip(row, TIP.w, TIP.h, 950, 900);
    expect(x).toBe(551 - TIP.w - 8);
    expect(y).toBe(185 + 18 - TIP.h / 2);
  });

  it("falls back inside the viewport when the row hugs the left edge", () => {
    const row = { left: 200, top: 300, height: 36 };
    const { x } = placeRangeTip(row, TIP.w, TIP.h, 400, 900);
    expect(x).toBeGreaterThanOrEqual(8);
    expect(x + TIP.w).toBeLessThanOrEqual(400 - 8);
  });

  it("pins to the left edge when the viewport is narrower than the tip", () => {
    const row = { left: 100, top: 300, height: 36 };
    const { x } = placeRangeTip(row, TIP.w, TIP.h, 200, 900);
    expect(x).toBe(8);
  });

  it("clamps at the top and bottom viewport edges", () => {
    const top = placeRangeTip({ left: 551, top: 0, height: 36 }, TIP.w, TIP.h, 950, 900);
    expect(top.y).toBe(8);
    const bottom = placeRangeTip({ left: 551, top: 880, height: 36 }, TIP.w, TIP.h, 950, 900);
    expect(bottom.y).toBe(900 - TIP.h - 8);
  });
});