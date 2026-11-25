import { describe, it, expect } from "vitest";
import {
  defaultFee,
  defaultRisk,
  EMPTY_DEFAULTS,
  type JournalDefaults,
} from "../src/lib/journal-defaults";
import { attachmentMime } from "../src/lib/attachment-validation";
const defaults: JournalDefaults = {
  ...EMPTY_DEFAULTS,
  feeRules: [{ id: "1", accountId: "a", symbol: "ES", amount: 2, mode: "unit" }],
  riskRules: [{ id: "r", accountId: "", symbol: "", stop: 1, target: 3, mode: "percent" }],
};
describe("journal defaults are opt-in and scoped", () => {
  it("preserves source fees and applies only the first matching zero-fee rule", () => {
    expect(defaultFee(5, 2, "a", "ES", defaults)).toBe(5);
    expect(defaultFee(0, 2, "a", "es", defaults)).toBe(4);
    expect(defaultFee(0, 2, "b", "ES", defaults)).toBe(0);
    expect(defaultFee(0, 2, "a", "NQ", defaults)).toBe(0);
  });
  it("derives direction-aware percentage stop and target prices", () => {
    expect(defaultRisk(200, "long", "a", "ES", defaults)).toEqual({
      stopLoss: 198,
      profitTarget: 206,
    });
    expect(defaultRisk(200, "short", "a", "ES", defaults)).toEqual({
      stopLoss: 202,
      profitTarget: 194,
    });
    expect(defaultRisk(200, "long", "a", "ES", EMPTY_DEFAULTS)).toEqual({});
  });
});
describe("attachment type checks", () => {
  it("accepts supported signatures and rejects HTML/SVG content", () => {
    expect(attachmentMime(new TextEncoder().encode("%PDF-1.7"))).toBe("application/pdf");
    expect(attachmentMime(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))).toBe("image/png");
    expect(attachmentMime(new TextEncoder().encode('<svg onload="alert(1)"></svg>'))).toBeNull();
    expect(attachmentMime(new Uint8Array())).toBeNull();
  });
});
