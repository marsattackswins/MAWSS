import { describe, it, expect } from 'vitest';
import { DARK_THEME, GRUVBOX_THEME, resolveTheme } from '../core/theme';

describe('gruvbox theme (MAWS local palette)', () => {
    it('resolves the "gruvbox" name to the gruvbox palette', () => {
        expect(resolveTheme('gruvbox')).toBe(GRUVBOX_THEME);
        expect(GRUVBOX_THEME.name).toBe('gruvbox');
        // Hardcoded gruvbox dark: bg0 canvas, fg1 text, earthy candle body/wick/border colors.
        expect(GRUVBOX_THEME.background).toBe('#282828');
        expect(GRUVBOX_THEME.textPrimary).toBe('#ebdbb2');
        expect(GRUVBOX_THEME.upColor).toBe('#d2b48c');
        expect(GRUVBOX_THEME.downColor).toBe('#a0522d');
        expect(GRUVBOX_THEME.upWickColor).toBe('#b87333');
        expect(GRUVBOX_THEME.downWickColor).toBe('#b87333');
        expect(GRUVBOX_THEME.upBorderColor).toBe('#c19a6b');
        expect(GRUVBOX_THEME.downBorderColor).toBe('#8b4513');
        // Dropdown/popover surfaces ride the dialog surface (bg0), not the bg1
        // card tone — menus match the global settings menu.
        expect(GRUVBOX_THEME.bgOverlay).toBe(GRUVBOX_THEME.background);
    });

    it('leaves the upstream names resolving as before', () => {
        expect(resolveTheme('dark')).toBe(DARK_THEME);
        expect(resolveTheme(undefined)).toBe(DARK_THEME);
        expect(resolveTheme('classic').name).toBe('classic');
        expect(resolveTheme('light').name).toBe('light');
    });
});
