import type { VpvrProfile } from './profile';

/** Row fill opacity inside / outside the value area (the profile overlays the candles). */
export const VPVR_VA_ALPHA = 0.62;
export const VPVR_OUTSIDE_ALPHA = 0.28;
/** Opacity of the point-of-control row outline. */
export const VPVR_POC_ALPHA = 0.9;

/** Geometry the layer hands the painter (pane-resolved price→y + the profile's anchor edge). */
export interface VpvrGeom {
    /** Right pixel edge of the data area (rows hug this, extending left). */
    rightX: number;
    /** Pixel width of the largest row (the profile's horizontal scale). */
    maxW: number;
    /** price → pixel y. */
    yOf(price: number): number;
}

export interface VpvrPaintStyle {
    upColor: string;
    downColor: string;
    showPoc: boolean;
    /** Outline color for the POC row (the theme's text color). */
    pocColor: string;
}

/**
 * Paint the visible-range volume profile: one horizontal row per price bucket, anchored
 * to the right edge and extending left, width proportional to the row's total volume
 * relative to the largest row. Each row splits into an up segment (left part) and a down
 * segment (right part, against the axis). Rows inside the value area draw brighter; the
 * POC row is outlined. Pure — every coordinate comes from `geom`.
 *
 * Segments are collected into four buckets (value-area × colour) and filled once each:
 * a `fillStyle` + `globalAlpha` write per row was this layer's dominant cost, and rows
 * never overlap, so bucketing cannot change the result.
 */
export function paintVpvr(
    ctx: CanvasRenderingContext2D,
    profile: VpvrProfile,
    geom: VpvrGeom,
    style: VpvrPaintStyle,
): void {
    const { rows, rowH, maxTotal, poc, vaFrom, vaTo } = profile;
    const { rightX, maxW, yOf } = geom;
    if (maxTotal <= 0 || maxW <= 0) return;

    // [value area up, value area down, outside up, outside down] — flat x,y,w,h lists.
    const buckets: number[][] = [[], [], [], []];
    for (let k = 0; k < rows.length; k += 1) {
        const row = rows[k]!;
        const total = row.up + row.down;
        if (total <= 0) continue;
        const yTop = yOf(row.price + rowH);
        const h = Math.max(1, yOf(row.price) - yTop - 1); // 1px inter-row gap
        const w = (total / maxTotal) * maxW;
        const upW = (row.up / total) * w;
        const base = k >= vaFrom && k <= vaTo ? 0 : 2;
        if (upW > 0) buckets[base]!.push(rightX - w, yTop, upW, h);
        if (w - upW > 0) buckets[base + 1]!.push(rightX - w + upW, yTop, w - upW, h);
    }
    for (let i = 0; i < buckets.length; i += 1) {
        const list = buckets[i]!;
        if (list.length === 0) continue;
        ctx.globalAlpha = i < 2 ? VPVR_VA_ALPHA : VPVR_OUTSIDE_ALPHA;
        ctx.fillStyle = i % 2 === 0 ? style.upColor : style.downColor;
        ctx.beginPath();
        for (let j = 0; j < list.length; j += 4) ctx.rect(list[j]!, list[j + 1]!, list[j + 2]!, list[j + 3]!);
        ctx.fill();
    }

    if (style.showPoc) {
        const row = rows[poc]!;
        const yTop = yOf(row.price + rowH);
        const h = Math.max(1, yOf(row.price) - yTop - 1);
        ctx.globalAlpha = VPVR_POC_ALPHA;
        ctx.strokeStyle = style.pocColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(rightX - maxW + 0.5, yTop + 0.5, maxW - 1, h);
    }
    ctx.globalAlpha = 1;
}
