/**
 * vela-workspace-layouts.test.ts — MAWS→Vela layout bridge tests (pure, no DOM).
 */
import { areasForTemplate, buildMawsWorkspaceLayout, mawsWorkspaceLayoutId, mawsWorkspaceLayouts } from "../vela-workspace-layouts";
import { layoutTemplate } from "@/lib/layouts";
import type { LayoutDefinition } from "@/lib/charting/workspace";

describe("mawsWorkspaceLayoutId", () => {
  it('maps every count to its "-h" id; only 2 and 6 get "-v" variants', () => {
    expect(mawsWorkspaceLayoutId(1, "h")).toBe("1-h");
    expect(mawsWorkspaceLayoutId(12, "h")).toBe("12-h");
    expect(mawsWorkspaceLayoutId(2, "v")).toBe("2-v");
    expect(mawsWorkspaceLayoutId(6, "v")).toBe("6-v");
    // Counts without an orientation branch pin to -h (geometry is identical).
    expect(mawsWorkspaceLayoutId(3, "v")).toBe("3-h");
    expect(mawsWorkspaceLayoutId(8, "v")).toBe("8-h");
  });
});

describe("areasForTemplate", () => {
  it("uniform grids stay area-less (auto-flow row-major)", () => {
    const { rows, cellAreas } = areasForTemplate(layoutTemplate(4, "h"));
    expect(rows).toBeUndefined();
    expect(cellAreas).toBeUndefined();
  });

  it("featured-left templates (3) expand to named areas matching ChartGrid geometry", () => {
    const { rows, cellAreas } = areasForTemplate(layoutTemplate(3, "h"));
    // ChartGrid's 3-template: featured cell "1 / 1 / 3 / 2" = c1 spans both rows.
    expect(rows).toEqual(["c1 c2", "c1 c3"]);
    expect(cellAreas).toEqual(["c1", "c2", "c3"]);
  });

  it("featured-left 11 (3 rows of 12 tracks) expands each block without overlaps", () => {
    const { rows } = areasForTemplate(layoutTemplate(11, "h"));
    // Block layout: featured 4-wide cells on row 1, then 3-wide blocks below —
    // every track is covered, none is shared.
    expect(rows).toEqual([
      "c1 c1 c1 c1 c2 c2 c2 c2 c3 c3 c3 c3",
      "c4 c4 c4 c5 c5 c5 c6 c6 c6 c7 c7 c7",
      "c8 c8 c8 c9 c9 c9 c10 c10 c10 c11 c11 c11",
    ]);
  });
});

describe("buildMawsWorkspaceLayout", () => {
  it("produces a valid LayoutDefinition per template (cells match the template)", () => {
    const asymmetric = ["3-h", "5-h", "7-h", "11-h"];
    for (const def of mawsWorkspaceLayouts()) {
      const d = def as LayoutDefinition;
      const count = Number(d.id.split("-")[0]) as Parameters<typeof layoutTemplate>[0];
      const t = layoutTemplate(count, d.id.endsWith("-v") ? "v" : "h");
      expect(d.cells).toHaveLength(t.areas.length);
      expect(d.cells.map((c) => c.id)).toEqual(
        Array.from({ length: t.areas.length }, (_, i) => `c${i + 1}`),
      );
      expect(d.cols).toEqual(t.colFr);
      expect(d.rows).toEqual(t.rowFr);
      // Asymmetric layouts must carry named areas; uniform ones must not.
      expect(Boolean(d.areas)).toBe(asymmetric.includes(d.id));
    }
  });

  it("2-v mirrors ChartGrid's stacked template", () => {
    const def = buildMawsWorkspaceLayout(2, "v");
    expect(def.rows).toEqual([1, 1]);
    expect(def.cols).toEqual([1]);
    expect(def.areas).toBeUndefined();
  });
});
