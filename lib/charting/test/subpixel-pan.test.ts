import { describe, it, expect, vi } from 'vitest';
import { NativeRenderer } from '../renderers/native/NativeRenderer';

/**
 * A pan or zoom smaller than half a device pixel cannot move a single pixel on screen.
 * High-rate pointers and slow drags produce plenty of those, and each one used to
 * invalidate a Full frame — clearing and repainting every canvas for an invisible
 * change. applyViewport must skip them (and still move for anything visible).
 */
type AnyRenderer = Record<string, any>;

function setup(): { r: AnyRenderer; setViewport: ReturnType<typeof vi.fn>; invalidate: ReturnType<typeof vi.fn> } {
    const renderer = new NativeRenderer();
    const r = renderer as unknown as AnyRenderer;
    const setViewport = vi.fn();
    const invalidate = vi.fn();
    r.animator = { stop: () => {}, active: false };
    r.scheduler = { invalidate, flushNow: () => {} };
    r.panVelocity = 0;
    r.scrollTargetRO = null;
    r.coords = {
        getViewport: () => ({ barSpacing: 10, rightOffset: 0 }),
        setViewport,
        pxPerBar: () => 10,
        barCount: 5_000,
        width: 800,
        spacingScale: 1,
    };
    r.clampViewport = (barSpacing: number, rightOffset: number) => ({ barSpacing, rightOffset });
    return { r, setViewport, invalidate };
}

describe('applyViewport ignores pans too small to see', () => {
    it('skips a sub-half-pixel pan', () => {
        const { r, setViewport, invalidate } = setup();
        r.applyViewport({ barSpacing: 10, rightOffset: 0.02 }); // 0.2 px
        expect(setViewport).not.toHaveBeenCalled();
        expect(invalidate).not.toHaveBeenCalled();
    });

    it('paints a pan of half a pixel or more', () => {
        const { r, setViewport, invalidate } = setup();
        r.applyViewport({ barSpacing: 10, rightOffset: 0.05 }); // 0.5 px
        expect(setViewport).toHaveBeenCalledWith({ barSpacing: 10, rightOffset: 0.05 });
        expect(invalidate).toHaveBeenCalled();
    });

    it('always paints a zoom, however small', () => {
        const { r, setViewport } = setup();
        r.applyViewport({ barSpacing: 10.0001, rightOffset: 0 });
        expect(setViewport).toHaveBeenCalled();
    });

    it('still stops an in-flight animation on a skipped pan', () => {
        const { r } = setup();
        const stop = vi.fn();
        r.animator = { stop, active: false };
        r.applyViewport({ barSpacing: 10, rightOffset: 0.01 });
        expect(stop).toHaveBeenCalledTimes(1);
    });
});
