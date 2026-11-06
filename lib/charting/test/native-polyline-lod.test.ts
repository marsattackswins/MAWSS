// Performance regression coverage for the WebGL2 line-series LOD: at sub-pixel bar
// spacing every round join/cap is invisible, so dense navigation must not emit the
// per-vertex triangle fans. The assertion is on GEOMETRY (deterministic vertex counts),
// never on frame timing, so it stays stable on any machine.
import { describe, it, expect, vi } from 'vitest';

// parseColor reads colors through a canvas (absent in the node test env); the geometry
// assertions only care about vertex counts, so a fixed color is enough.
vi.mock('../renderers/native/backend/gl/color', () => ({ parseColor: () => [0, 0, 1, 1] }));

import { Batch, StripBatch } from '../renderers/native/backend/gl/Batch';
import { emitFillStripGeometry, emitPolylineGeometry } from '../renderers/native/backend/WebGL2Backend';
import { LINE_JOIN_MIN_SPACING, lineJoinsVisible } from '../renderers/native/backend/candle-lod';
import type { CoordinateSystem } from '../renderers/native/core/CoordinateSystem';
import type { PaneNode } from '../renderers/native/core/SceneGraph';
import type { LineLikeSeries } from '../core/model/series';
import type { IndicatorModel } from '../core/model/indicator';
import type { Fill } from '../core/model/scene';

const SPACING = 0.5;
const WIDTH = 1000;
const HEIGHT = 400;
const POINTS = 20_000;

function coordsAt(spacing: number, dpr = 1): CoordinateSystem {
    return {
        dpr,
        pxPerBar: () => spacing,
        logicalToX: (i: number) => i * spacing,
        priceToY: (price: number, scale: { min: number; max: number }, bounds: { top: number; height: number }) =>
            bounds.top + (1 - (price - scale.min) / (scale.max - scale.min)) * bounds.height,
    } as unknown as CoordinateSystem;
}

const pane = {
    id: 'price',
    kind: 'price',
    order: 0,
    heightWeight: 1,
    bounds: { top: 0, height: HEIGHT },
    scale: { min: 0, max: 200 },
    scaleTarget: { min: 0, max: 200 },
    initialized: true,
    manualScale: null,
    collapsed: false,
    percentBaseline: 0,
} as unknown as PaneNode;

function series(): LineLikeSeries {
    const points = Array.from({ length: POINTS }, (_, i) => ({
        time: 1_700_000_000_000 + i * 3_600_000,
        value: 100 + Math.sin(i / 13) * 40,
    }));
    return { id: 'lod:line:0', title: 'LOD', kind: 'line', points, style: { color: '#2962ff', width: 1, lineStyle: 'solid' } } as unknown as LineLikeSeries;
}

/** A dense frame's visible points — 2 CSS px apart at 0.5 px/bar. */
function denseVertices(): number {
    const b = new Batch();
    emitPolylineGeometry(b, series(), pane, coordsAt(SPACING), 0, WIDTH * 2 - 1, false);
    return b.vertexCount;
}

describe('WebGL2 polyline LOD (dense navigation geometry)', () => {
    it('turns round joins off until the corners are actually visible', () => {
        expect(lineJoinsVisible(SPACING)).toBe(false);
        expect(lineJoinsVisible(2)).toBe(false); // a 1px-radius join at 2px spacing is invisible
        expect(lineJoinsVisible(3.5)).toBe(false);
        expect(lineJoinsVisible(LINE_JOIN_MIN_SPACING - 0.001)).toBe(false);
        expect(lineJoinsVisible(LINE_JOIN_MIN_SPACING)).toBe(true);
        expect(lineJoinsVisible(8)).toBe(true);
    });

    it('emits no join fans at 3px spacing (only the visible corners keep them)', () => {
        const b = new Batch();
        const segments = 300;
        emitPolylineGeometry(b, series(), pane, coordsAt(3), 0, segments, false);
        expect(b.vertexCount).toBe(segments * 6);
    });

    it('emits only connecting quads (no join fans) for a dense line', () => {
        const segments = WIDTH * 2 - 1; // i = 1 … i1
        expect(denseVertices()).toBe(segments * 6);
    });

    it('a sparse line still carries its round joins (quality is preserved when visible)', () => {
        const sparse = new Batch();
        const visiblePoints = 200;
        emitPolylineGeometry(sparse, series(), pane, coordsAt(10), 0, visiblePoints - 1, false);
        // ~24 verts per point: one 6-vert segment plus an 18-vert join fan (6-segment circle).
        expect(sparse.vertexCount / visiblePoints).toBeGreaterThan(10);
        expect(denseVertices() / (WIDTH * 2)).toBeLessThan(7); // dense: one 6-vert segment per point
    });

    it('routes dense 1px lines to the 2-vertex GL_LINES batch (6 → 2 vertices per point)', () => {
        const b = new Batch();
        const thin = new Batch();
        const segments = WIDTH * 2 - 1;
        emitPolylineGeometry(b, series(), pane, coordsAt(SPACING), 0, segments, false, 0, thin);
        expect(b.vertexCount).toBe(0); // no AA quads for the dense hairline path
        expect(thin.vertexCount).toBe(segments * 2);
    });

    it('keeps AA quads (ignores the line batch) when the zoom makes the stroke visible', () => {
        const b = new Batch();
        const thin = new Batch();
        emitPolylineGeometry(b, series(), pane, coordsAt(10), 0, 199, false, 0, thin);
        expect(thin.vertexCount).toBe(0);
        expect(b.vertexCount).toBeGreaterThan(199 * 6);
    });

    it('keeps a 1 CSS px stroke on integer HiDPI with device-pixel hairlines', () => {
        const segments = 100;
        for (const [dpr, verts] of [[1, 2], [2, 4], [3, 6]] as const) {
            const b = new Batch();
            const thin = new Batch();
            emitPolylineGeometry(b, series(), pane, coordsAt(SPACING, dpr), 0, segments, false, 0, thin);
            expect(b.vertexCount).toBe(0);
            expect(thin.vertexCount).toBe(segments * verts);
        }
    });

    it('keeps analytic-AA quads at fractional DPR instead of rounding line width up', () => {
        for (const dpr of [1.25, 1.5, 1.75]) {
            const b = new Batch();
            const thin = new Batch();
            emitPolylineGeometry(b, series(), pane, coordsAt(SPACING, dpr), 0, 100, false, 0, thin);
            expect(thin.vertexCount).toBe(0);
            expect(b.vertexCount).toBe(100 * 6);
        }
    });
});

describe('WebGL2 fill-band LOD (dense single-color bands)', () => {
    function band(gapAt = -1): IndicatorModel {
        const top = Array.from({ length: 20 }, (_, i) => ({ time: i, value: i === gapAt ? null : 10 + i }));
        const bottom = Array.from({ length: 20 }, (_, i) => ({ time: i, value: i === gapAt ? null : 5 + i }));
        return {
            series: [
                { id: 'top', title: 'Top', kind: 'line', points: top, style: { color: '#fff', width: 1, lineStyle: 'solid' } },
                { id: 'bottom', title: 'Bottom', kind: 'line', points: bottom, style: { color: '#fff', width: 1, lineStyle: 'solid' } },
            ],
        } as unknown as IndicatorModel;
    }
    const fill = (extra: Partial<Fill> = {}): Fill => ({
        id: 'f',
        paneId: 'price',
        fromSeriesId: 'top',
        toSeriesId: 'bottom',
        color: '#2962ff',
        ...extra,
    });

    it('uses two vertices per column instead of a 6-vertex quad', () => {
        const strip = new StripBatch();
        expect(emitFillStripGeometry(strip, band(), fill(), pane, coordsAt(SPACING), 0, 19)).toBe(true);
        expect(strip.vertexCount).toBe(20 * 2); // one top + one bottom vertex per bar
        expect(strip.runStarts).toHaveLength(1);
    });

    it('breaks the strip at a gap so no bridge is drawn across missing data', () => {
        const strip = new StripBatch();
        expect(emitFillStripGeometry(strip, band(8), fill(), pane, coordsAt(SPACING), 0, 19)).toBe(true);
        expect(strip.vertexCount).toBe(19 * 2);
        expect(strip.runStarts).toHaveLength(2);
    });

    it('keeps adjacent fills as separate runs in one uploadable strip buffer', () => {
        const strip = new StripBatch();
        expect(emitFillStripGeometry(strip, band(), fill(), pane, coordsAt(SPACING), 0, 19)).toBe(true);
        expect(emitFillStripGeometry(strip, band(), fill({ id: 'second' }), pane, coordsAt(SPACING), 0, 19)).toBe(true);
        expect(strip.vertexCount).toBe(40 * 2);
        expect(strip.runStarts).toEqual([0, 40]);
    });

    it('keeps the quad path for per-bar colors and gradients', () => {
        for (const extra of [{ colors: ['#fff'] }, { gradient: [null] }] as Partial<Fill>[]) {
            const strip = new StripBatch();
            expect(emitFillStripGeometry(strip, band(), fill(extra), pane, coordsAt(SPACING), 0, 19)).toBe(false);
            expect(strip.vertexCount).toBe(0);
        }
    });
});
