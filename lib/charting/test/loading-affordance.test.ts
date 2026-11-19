// The loading affordance's theme fit — caption text and the contrast-banded ink that
// keeps the mark readable on every palette (OLED black, dim dark, classic, gruvbox, light).
import { describe, it, expect } from 'vitest';
import { BLACK_THEME, CLASSIC_THEME, DARK_THEME, GRUVBOX_THEME, LIGHT_THEME } from '../core/theme';
import { contrastRatio, loadingAccent, loadingCaption } from '../renderers/native/chrome/LoadingAffordance';

const PALETTES = [BLACK_THEME, DARK_THEME, CLASSIC_THEME, GRUVBOX_THEME, LIGHT_THEME];

describe('loadingCaption', () => {
    it('names the ticker and the compact timeframe', () => {
        expect(loadingCaption({ symbol: 'YSLA', timeframe: '30' })).toBe('Loading YSLA · 30m');
        expect(loadingCaption({ symbol: 'binance:BTCUSDT', timeframe: 'H' })).toBe('Loading BTCUSDT · 1h');
        expect(loadingCaption({ symbol: 'BTCUSDT.P', timeframe: '240' })).toBe('Loading BTCUSDT.P · 4h');
    });

    it('drops the parts it does not have instead of printing undefined', () => {
        expect(loadingCaption({ timeframe: '60' })).toBe('Loading 1h');
        expect(loadingCaption({ symbol: 'ETHUSDT' })).toBe('Loading ETHUSDT');
        expect(loadingCaption({})).toBe('Loading');
        expect(loadingCaption()).toBe('Loading');
    });
});

describe('loadingAccent — every bundled theme', () => {
    it.each(PALETTES.map((t) => [t.name, t] as const))('%s stays inside the contrast band', (_name, theme) => {
        const accent = loadingAccent(theme.textColor, theme.background);
        const ratio = contrastRatio(accent, theme.background);
        expect(ratio).toBeGreaterThanOrEqual(4);
        expect(ratio).toBeLessThanOrEqual(7.01);
    });

    it('keeps a palette already inside the band exactly as authored', () => {
        // gruvbox's warm beige is 6.9:1 on bg0 — no reason to touch it.
        expect(contrastRatio(GRUVBOX_THEME.textColor, GRUVBOX_THEME.background)).toBeGreaterThan(4);
        expect(loadingAccent(GRUVBOX_THEME.textColor, GRUVBOX_THEME.background)).toBe(GRUVBOX_THEME.textColor);
    });

    it('lifts a dim ink and eases a glaring one without losing its hue', () => {
        // The default dark chart's text is 3.6:1 on its own plot — lifted, still cool grey.
        const lifted = loadingAccent(DARK_THEME.textColor, DARK_THEME.background);
        expect(contrastRatio(lifted, DARK_THEME.background)).toBeGreaterThan(3.9);
        // Classic is ~11:1 — eased toward the surface so the mark stays ambient.
        const eased = loadingAccent(CLASSIC_THEME.textColor, CLASSIC_THEME.background);
        expect(contrastRatio(eased, CLASSIC_THEME.background)).toBeLessThan(7.01);
        // Grubvox semantic hue survives: red channel above blue.
        const warm = loadingAccent(GRUVBOX_THEME.textColor, GRUVBOX_THEME.background);
        expect(parseInt(warm.slice(1, 3), 16)).toBeGreaterThan(parseInt(warm.slice(5, 7), 16));
    });

    it('handles a near-invisible custom palette and unparsable input', () => {
        expect(contrastRatio(loadingAccent('#111111', '#0a0a0a'), '#0a0a0a')).toBeGreaterThan(3.9);
        expect(contrastRatio(loadingAccent('#3a3a3a', '#ffffff'), '#ffffff')).toBeGreaterThan(3.9);
        expect(loadingAccent('rgb(1,2,3)', '#000000')).toBe('rgb(1,2,3)');
    });

    it('never returns the raw ink with alpha handling left to the DOM', () => {
        for (const theme of PALETTES) {
            expect(loadingAccent(theme.textColor, theme.background)).toMatch(/^#[0-9a-f]{6}$/);
        }
    });
});
