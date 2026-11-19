import type { VelaTheme, ThemeName } from './options';

// ── 0. True Black Palette (OLED: every surface #000, hairline borders separate) ──
export const BLACK_THEME: VelaTheme = {
    name: 'black',
    background: '#000000',
    textColor: '#d1d4dc',
    gridColor: '#141414',
    borderColor: '#222222',
    upColor: '#089981',
    downColor: '#f23645',
    fontFamily: 'sans-serif',
    bgPanel: '#000000',
    bgCard: '#000000',
    bgBar: '#000000',
    bgChip: '#1a1a1a',
    bgHover: '#1a1a1a',
    border: '#222222',
    textPrimary: '#d1d4dc',
    textSecondary: '#787b86',
    textMuted: '#4c525e',
};

// ── 1. Reference Vela Dark Palette (Muted, Matte, Desaturated Sage/Rose) ──
export const DARK_THEME: VelaTheme = {
    name: 'dark',
    background: '#202126',
    textColor: '#757882',
    gridColor: '#24252a',
    borderColor: '#262629',
    upColor: '#a7be94',
    downColor: '#af6870',
    fontFamily: 'sans-serif',
    bgPanel: '#121215',
    bgCard: '#232429',
    bgBar: '#191a1e',
    bgChip: '#292a2f',
    bgHover: '#2b2d34',
    border: '#262629',
    textPrimary: '#eeeef1',
    textSecondary: '#757882',
    textMuted: '#46474b',
};

// ── 2. Standard Classic Palette (Original TradingView: Neon Turquoise & Bright Red) ──
export const CLASSIC_THEME: VelaTheme = {
    name: 'classic',
    background: '#131722',
    textColor: '#d1d4dc',
    gridColor: '#1e222d',
    borderColor: '#2a2e39',
    upColor: '#089981',
    downColor: '#f23645',
    fontFamily: 'sans-serif',
    bgPanel: '#1e222d',
    bgCard: '#2a2e39',
    bgBar: '#171b26',
    bgChip: '#2a2e39',
    bgHover: '#363a45',
    border: '#2a2e39',
    textPrimary: '#ffffff',
    textSecondary: '#d1d4dc',
    textMuted: '#787b86',
};

// ── 3. Gruvbox Dark Palette (hardcoded gruvbox colorscheme: bg0/fg1 + neutral greens/reds) ──
export const GRUVBOX_THEME: VelaTheme = {
    name: 'gruvbox',
    background: '#282828',
    textColor: '#bdae93',
    gridColor: '#32302f',
    borderColor: '#3c3836',
    upColor: '#d2b48c',
    downColor: '#a0522d',
    upWickColor: '#b87333',
    downWickColor: '#b87333',
    upBorderColor: '#c19a6b',
    downBorderColor: '#8b4513',
    fontFamily: 'sans-serif',
    bgPanel: '#282828',
    bgCard: '#3c3836',
    bgBar: '#1d2021',
    bgChip: '#3c3836',
    bgHover: '#504945',
    // Dropdown/popover surfaces sit on the settings-dialog surface (bg0) so
    // menus match the global settings menu instead of the lighter bg1 card tone.
    bgOverlay: '#282828',
    border: '#3c3836',
    textPrimary: '#ebdbb2',
    textSecondary: '#bdae93',
    textMuted: '#665c54',
};

// ── 4. Light Palette ──
export const LIGHT_THEME: VelaTheme = {
    name: 'light',
    background: '#ffffff',
    textColor: '#1e293b',
    gridColor: '#e0e3eb',
    borderColor: '#d4dae3',
    upColor: '#26a69a',  // BULLISH — standard green
    downColor: '#ef5350',  // BEARISH — standard red
    fontFamily: 'sans-serif',
    bgPanel: '#f8f9fa',
    bgCard: '#ffffff',
    bgBar: '#f1f3f5',
    bgChip: '#e9ecef',
    bgHover: '#dee2e6',
    border: '#d4dae3',
    textPrimary: '#000000',
    textSecondary: '#64748b',
    textMuted: '#94a3b8',
};

export function resolveTheme(theme?: ThemeName | VelaTheme): VelaTheme {
    if (theme === 'black') return BLACK_THEME;
    if (!theme || theme === 'dark' || theme === 'vela') return DARK_THEME;
    if (theme === 'classic' || theme === 'standard') return CLASSIC_THEME;
    if (theme === 'gruvbox') return GRUVBOX_THEME;
    if (theme === 'light') return LIGHT_THEME;
    return {
        ...DARK_THEME,
        ...theme,
        upColor: theme.upColor || DARK_THEME.upColor,
        downColor: theme.downColor || DARK_THEME.downColor,
    };
}

export interface ThemeIndicatorColors {
    vwap: string;
    ema: string;
    bbBasis: string;
    bbUpper: string;
    bbLower: string;
    rsi: string;
    stochK: string;
    stochD: string;
    atr: string;
    adx: string;
}

export const THEME_INDICATOR_COLORS: Record<string, ThemeIndicatorColors> = {
    black: {
        vwap: '#2962ff',
        ema: '#2962ff',
        bbBasis: '#2962ff',
        bbUpper: '#f23645',
        bbLower: '#089981',
        rsi: '#ab47bc',
        stochK: '#2962ff',
        stochD: '#ff6d00',
        atr: '#ffa726',
        adx: '#2962ff',
    },
    dark: {
        vwap: '#7aa2f7',
        ema: '#89ddff',
        bbBasis: '#7aa2f7',
        bbUpper: '#af6870',
        bbLower: '#a7be94',
        rsi: '#bb9af7',
        stochK: '#7aa2f7',
        stochD: '#e0af68',
        atr: '#e0af68',
        adx: '#7dcfff',
    },
    classic: {
        vwap: '#2962ff',
        ema: '#2962ff',
        bbBasis: '#2962ff',
        bbUpper: '#f23645',
        bbLower: '#089981',
        rsi: '#ab47bc',
        stochK: '#2962ff',
        stochD: '#ff6d00',
        atr: '#ffa726',
        adx: '#2962ff',
    },
    gruvbox: {
        vwap: '#83a598',
        ema: '#8ec07c',
        bbBasis: '#83a598',
        bbUpper: '#cc241d',
        bbLower: '#98971a',
        rsi: '#d3869b',
        stochK: '#83a598',
        stochD: '#fe8019',
        atr: '#fabd2f',
        adx: '#8ec07c',
    },
    light: {
        vwap: '#1d4ed8',
        ema: '#0284c7',
        bbBasis: '#1d4ed8',
        bbUpper: '#dc2626',
        bbLower: '#16a34a',
        rsi: '#7c3aed',
        stochK: '#1d4ed8',
        stochD: '#ea580c',
        atr: '#d97706',
        adx: '#0284c7',
    },
};

export function resolveThemeIndicatorColors(theme?: ThemeName | string): ThemeIndicatorColors {
    const key = (theme || 'dark').toLowerCase();
    return THEME_INDICATOR_COLORS[key] || THEME_INDICATOR_COLORS.dark;
}
