// @vitest-environment jsdom
// The status line re-walks its width ladder only when the readout's WIDTH can change.
// A hover/pan stream used to force `scrollWidth`/`clientWidth` layout on every pointer
// event (measured ~0.6 ms each in the app); same-digit value ticks must only rewrite text.
import { describe, it, expect, vi } from 'vitest';
import { Statusline } from '../widget/statusline';

// jsdom ships no CSS.escape; the kit's style injection needs it for its id lookup.
(globalThis as { CSS?: unknown }).CSS ??= { escape: (v: string) => v };

function ohlc(close: number) {
    return { time: 1_700_000_000_000, open: 100, high: 101, low: 99, close, volume: 1 };
}

function setup() {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const line = new Statusline(host, 'BINANCE:BTCUSDT');
    let cross: ((e: unknown) => void) | null = null;
    const chart = {
        on: () => () => {},
        replay: { state: { active: false } },
        renderer: {
            onCrosshairMove: (cb: (e: unknown) => void) => {
                cross = cb;
                return () => {};
            },
        },
    };
    line.onChart(chart as never);
    return {
        line,
        hover(close: number) {
            cross!({ time: 1, price: close, paneKind: 'price', values: new Map(), ohlc: ohlc(close) });
        },
    };
}

describe('Statusline width ladder', () => {
    it('skips the reflow when a value tick cannot change the chip width', () => {
        const { line, hover } = setup();
        const fit = vi.spyOn(line as unknown as { fit(): void }, 'fit');
        const values = vi.spyOn(line as unknown as { renderValues(): void }, 'renderValues');

        hover(101.51); // first readout settles the ladder
        fit.mockClear();
        values.mockClear();

        hover(101.52); // same digit counts — numbers only
        expect(fit).not.toHaveBeenCalled();
        expect(values).toHaveBeenCalledTimes(1);

        hover(1015.2); // one more digit — width changed, so the ladder must run
        expect(fit).toHaveBeenCalledTimes(1);
        line.destroy();
    });
});
