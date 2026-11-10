import { describe, it, expect } from 'vitest';
import { DARK_THEME, GRUVBOX_THEME, resolveTheme } from '../core/theme';

describe('gruvbox theme (MAWS local palette)', () => {
    it('resolves the "gruvbox" name to the gruvbox palette', () => {
        expect(resolveTheme('gruvbox')).toBe(GRUVBOX_THEME);
        expect(GRUVBOX_THEME.name).toBe('gruvbox');
        // Hardcoded gruvbox dark: bg0 canvas, fg1 text, neutral green/red candles.
        expect(GRUVBOX_THEME.background).toBe('#282828');
        expect(GRUVBOX_THEME.textPrimary).toBe('#ebdbb2');
        expect(GRUVBOX_THEME.upColor).toBe('#98971a');
        expect(GRUVBOX_THEME.downColor).toBe('#cc241d');
    });

    it('leaves the upstream names resolving as before', () => {
        expect(resolveTheme('dark')).toBe(DARK_THEME);
        expect(resolveTheme(undefined)).toBe(DARK_THEME);
        expect(resolveTheme('classic').name).toBe('classic');
        expect(resolveTheme('light').name).toBe('light');
    });
});
