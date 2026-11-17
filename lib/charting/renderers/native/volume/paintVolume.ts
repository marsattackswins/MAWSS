import type { OHLCV } from '../../../core/model/ohlcv';

/** Fill opacity of the volume columns — the candles behind/above must stay readable. */
export const VOLUME_FILL_ALPHA = 0.5;

/**
 * Geometry the layer precomputes once per frame (keeps this painter free of the
 * CoordinateSystem and therefore unit-testable with a fake 2d context).
 */
export interface VolumeGeom {
    /** Inclusive visible bar-index range into `bars`. */
    i0: number;
    i1: number;
    /** bar index → pixel x of the bar's center. */
    xOf(i: number): number;
    /** Half-width (px) of one column (matched to the candle body). */
    halfW: number;
    /** Pixel y of the pane's bottom edge (columns grow upward from here). */
    bottomY: number;
    /** Pixel height of the tallest visible bar (the layer's own scale). */
    maxH: number;
    /** Largest visible volume (normalization; caller guarantees > 0). */
    maxVol: number;
}

/**
 * Paint the bottom-anchored volume columns: one per visible bar, height proportional to
 * volume relative to the VISIBLE max, colored by bar direction. Pure — every coordinate
 * comes from `geom`.
 *
 * Columns of the same direction share one path and one fill: assigning `fillStyle` and
 * calling `fillRect` per bar dominated this layer's frame cost (a colour string parse
 * per column, every frame). Runs are built in bar order, so the paint order — and the
 * blending of the translucent overlapping edges — is unchanged.
 */
export function paintVolume(
    ctx: CanvasRenderingContext2D,
    bars: readonly OHLCV[],
    geom: VolumeGeom,
    colors: { up: string; down: string },
): void {
    const { i0, i1, xOf, halfW, bottomY, maxH, maxVol } = geom;
    if (maxVol <= 0 || maxH <= 0) return;
    const w = halfW * 2;
    let runUp: boolean | null = null;
    let runOpen = false;
    const flush = (): void => {
        if (!runOpen) return;
        ctx.globalAlpha = VOLUME_FILL_ALPHA;
        ctx.fillStyle = runUp ? colors.up : colors.down;
        ctx.fill();
        runOpen = false;
    };
    for (let i = i0; i <= i1; i += 1) {
        const b = bars[i];
        const v = b?.volume;
        if (b == null || v == null || !(v > 0)) continue; // volume is optional on OHLCV
        const up = b.close >= b.open;
        if (!runOpen || up !== runUp) {
            flush(); // a direction flip closes the previous run
            runUp = up;
            ctx.beginPath();
            runOpen = true;
        }
        const h = Math.max(1, (v / maxVol) * maxH);
        ctx.rect(xOf(i) - halfW, bottomY - h, w, h);
    }
    flush();
    ctx.globalAlpha = 1;
}
