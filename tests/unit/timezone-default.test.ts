import { describe, expect, test } from "@jest/globals";
import { normalizeTimezone, TIMEZONE_OPTIONS } from "@/lib/timezone";
import { DEFAULT_CHART_SETTINGS } from "@/types";

describe("timezone default and retired-default migration", () => {
  test("the chart default is the single universal UTC entry", () => {
    expect(DEFAULT_CHART_SETTINGS.timezone).toBe("UTC");
  });

  test("the curated list carries exactly one UTC+0 entry (UTC)", () => {
    const utcZero = TIMEZONE_OPTIONS.filter(
      (o) => o.iana === "UTC" || o.iana === "Africa/Casablanca",
    );
    expect(utcZero.map((o) => o.iana)).toEqual(["UTC"]);
  });

  test("the retired UTC+0 default folds onto UTC (persisted workspaces migrate)", () => {
    expect(normalizeTimezone("Africa/Casablanca")).toBe("UTC");
  });

  test("missing or invalid values fall back to UTC", () => {
    expect(normalizeTimezone(undefined)).toBe("UTC");
    expect(normalizeTimezone(null)).toBe("UTC");
    expect(normalizeTimezone("")).toBe("UTC");
    expect(normalizeTimezone("BadZone")).toBe("UTC");
  });

  test("legacy offset aliases keep their zone mappings", () => {
    expect(normalizeTimezone("UTC+1")).toBe("Europe/Paris");
    expect(normalizeTimezone("UTC+8")).toBe("Asia/Hong_Kong");
    expect(normalizeTimezone("UTC")).toBe("UTC");
  });

  test("explicit IANA zones pass through untouched", () => {
    expect(normalizeTimezone("America/New_York")).toBe("America/New_York");
    expect(normalizeTimezone("Asia/Tokyo")).toBe("Asia/Tokyo");
  });
});