// Loading affordance — a seven-candle mark plus its "Loading SYMBOL · TF" caption,
// shown while a bar load is in flight with nothing painted (first load, or a
// symbol/timeframe switch). Local addition (see lib/charting/README.md).
//
// It carries its own styles and Web-Animations-driven motion, so no stylesheet crosses
// the renderer boundary, and it is re-tinted in place when the theme changes under it.
import { timeframeLabel } from '../../../widget/timeframe';
import { parseSymbol } from '../../../data/ProviderRegistry';
import type { ChartLoadingContext } from '../../../core/ports/IChartRenderer';

export type { ChartLoadingContext };

/** The two theme values the mark needs: the plot's ink and the surface it sits on. */
export interface LoadingSurface {
    textColor: string;
    background: string;
}

/**
 * The band the mark's ink is held to, in WCAG contrast against the plot background.
 * Below `MIN` it disappears on dim palettes; above `MAX` it glares on a bright one — and
 * the reference design sits in this band (roughly 8:1 at full strength, ~5:1 after the
 * body opacity). Hue is preserved: it is the theme's own text colour, moved toward the
 * surface or toward white/black, never replaced.
 */
const MIN_CONTRAST = 4;
const MAX_CONTRAST = 7;
/** Body opacity at full ink — the mark is ambient, never louder than the candles. */
const BODY_OPACITY = 0.95;
/** Wicks sit below their bodies; the 1 px line needs less ink to read. */
const WICK_OPACITY = 0.55;

/**
 * The mark's bars — a miniature candle series, not a baseline equalizer: each candle
 * carries a wick (high→low) and a body (open→close) at its OWN level, so the row reads as
 * a price series. Levels are px inside the 22 px frame, measured off the reference design.
 */
interface MiniCandle {
    high: number;
    low: number;
    bodyTop: number;
    bodyBottom: number;
    /** Down candles draw hollow, up candles filled — the usual convention at this size. */
    hollow: boolean;
}

const CANDLES: readonly MiniCandle[] = [
    { high: 5, low: 16, bodyTop: 8, bodyBottom: 14, hollow: true },
    { high: 10, low: 21, bodyTop: 13, bodyBottom: 18, hollow: true },
    { high: 5, low: 21, bodyTop: 8, bodyBottom: 18, hollow: false },
    { high: 3, low: 11, bodyTop: 7, bodyBottom: 10, hollow: false },
    { high: 0, low: 8, bodyTop: 3, bodyBottom: 6, hollow: false },
    { high: 0, low: 17, bodyTop: 3, bodyBottom: 14, hollow: true },
    { high: 10, low: 18, bodyTop: 13, bodyBottom: 18, hollow: false },
];

/** Candle pitch and body width, matched to the reference: 5 px bodies, 1 px wicks. */
const SLOT_PX = 11;
const BODY_PX = 5;
const FRAME_PX = 22;
const CAPTION_ATTR = 'data-vela-loading-caption';

type Rgb = [number, number, number];

function parseHexColor(value: string): Rgb | null {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? '').trim());
    if (!m) return null;
    let hex = m[1]!;
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function toHex([r, g, b]: Rgb): string {
    const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}`;
}

function linear(channel: number): number {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#rgb` / `#rrggbb` colour. */
export function relativeLuminance(color: string): number {
    const rgb = parseHexColor(color);
    if (!rgb) return 0;
    return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

/** WCAG contrast ratio (1–21) between two colours; 1 when either cannot be parsed. */
export function contrastRatio(a: string, b: string): number {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
}

function mix(from: Rgb, to: Rgb, t: number): Rgb {
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
}

/**
 * The mark's ink for a theme: its own text colour, held inside the contrast band above.
 * Dim palettes (the default dark chart) are lifted toward white, bright ones (classic,
 * light) are eased toward the surface so the mark stays ambient, and palettes already in
 * the band — gruvbox's warm beige, OLED's cool grey — are used exactly as authored.
 */
export function loadingAccent(textColor: string, background: string): string {
    const ink = parseHexColor(textColor);
    const bg = parseHexColor(background);
    if (!ink || !bg) return textColor;
    const current = contrastRatio(textColor, background);
    if (current >= MIN_CONTRAST && current <= MAX_CONTRAST) return toHex(ink);
    // Toward the surface when the ink is too strong; toward white/black when too weak.
    const target: Rgb = current > MAX_CONTRAST
        ? bg
        : relativeLuminance(background) > 0.18 ? [0, 0, 0] : [255, 255, 255];
    for (let step = 1; step <= 25; step += 1) {
        const candidate = toHex(mix(ink, target, step * 0.04));
        const ratio = contrastRatio(candidate, background);
        if (current < MIN_CONTRAST ? ratio >= MIN_CONTRAST : ratio <= MAX_CONTRAST) {
            return candidate;
        }
    }
    return toHex(target);
}

/**
 * "Loading BTCUSDT · 30m". The provider prefix is routing identity, not content, so only
 * the bare ticker shows; a missing part is dropped rather than printed as "undefined".
 */
export function loadingCaption(context?: ChartLoadingContext): string {
    const symbol = context?.symbol ? parseSymbol(context.symbol).ticker : '';
    const timeframe = context?.timeframe ? timeframeLabel(context.timeframe) : '';
    const what = [symbol, timeframe].filter(Boolean).join(' · ');
    return what ? `Loading ${what}` : 'Loading';
}

export class LoadingAffordance {
    readonly el: HTMLElement;
    private readonly captionEl: HTMLElement;
    private readonly wicks: HTMLElement[] = [];
    private readonly bodies: HTMLElement[] = [];
    private readonly hollow: boolean[] = [];
    private accent: string;

    constructor(doc: Document, surface: LoadingSurface, context?: ChartLoadingContext) {
        this.accent = loadingAccent(surface.textColor, surface.background);

        this.el = doc.createElement('div');
        this.el.className = 'vela-loading'; // stable hook for probes and host styling
        Object.assign(this.el.style, {
            position: 'absolute',
            inset: '0',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '11px',
            pointerEvents: 'none',
        } satisfies Partial<CSSStyleDeclaration>);

        this.el.appendChild(this.mark(doc));

        this.captionEl = doc.createElement('div');
        this.captionEl.setAttribute(CAPTION_ATTR, '');
        Object.assign(this.captionEl.style, {
            font: '500 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            letterSpacing: '0.09em',
            color: this.accent,
            opacity: '0.85',
            whiteSpace: 'nowrap',
        } satisfies Partial<CSSStyleDeclaration>);
        this.captionEl.textContent = loadingCaption(context);
        this.el.appendChild(this.captionEl);
    }

    /** Re-tint in place — a theme swap with a load in flight never rebuilds the mark. */
    retheme(surface: LoadingSurface): void {
        this.accent = loadingAccent(surface.textColor, surface.background);
        for (const wick of this.wicks) wick.style.background = this.accent;
        this.bodies.forEach((body, i) => {
            body.style.background = this.hollow[i] ? 'transparent' : this.accent;
            body.style.borderColor = this.hollow[i] ? this.accent : 'transparent';
        });
        this.captionEl.style.color = this.accent;
    }

    /** Re-aim the caption at a newer load without rebuilding the mark. */
    setCaption(context?: ChartLoadingContext): void {
        this.captionEl.textContent = loadingCaption(context);
    }

    /** The mark: a row of miniature candles, each with its wick, wavering in place. */
    private mark(doc: Document): HTMLElement {
        const mark = doc.createElement('div');
        Object.assign(mark.style, {
            position: 'relative',
            width: `${CANDLES.length * SLOT_PX - (SLOT_PX - BODY_PX)}px`,
            height: `${FRAME_PX}px`,
        } satisfies Partial<CSSStyleDeclaration>);

        CANDLES.forEach((candle, i) => {
            const column = doc.createElement('span');
            Object.assign(column.style, {
                position: 'absolute',
                left: `${i * SLOT_PX}px`,
                top: '0',
                width: `${BODY_PX}px`,
                height: `${FRAME_PX}px`,
                transformOrigin: 'center',
            } satisfies Partial<CSSStyleDeclaration>);

            // The wick spans the candle's range; the body sits on open→close inside it.
            const wick = doc.createElement('span');
            Object.assign(wick.style, {
                position: 'absolute',
                left: `${Math.floor(BODY_PX / 2)}px`,
                top: `${candle.high}px`,
                width: '1px',
                height: `${candle.low - candle.high}px`,
                background: this.accent,
                opacity: String(WICK_OPACITY),
            } satisfies Partial<CSSStyleDeclaration>);

            const body = doc.createElement('span');
            Object.assign(body.style, {
                position: 'absolute',
                left: '0',
                top: `${candle.bodyTop}px`,
                width: `${BODY_PX}px`,
                height: `${candle.bodyBottom - candle.bodyTop}px`,
                boxSizing: 'border-box',
                borderRadius: '1px',
                background: candle.hollow ? 'transparent' : this.accent,
                border: `1px solid ${candle.hollow ? this.accent : 'transparent'}`,
                opacity: String(BODY_OPACITY),
            } satisfies Partial<CSSStyleDeclaration>);

            column.append(wick, body);
            // A slow, staggered breath — negative delays stagger it from the first frame.
            column.animate([{ opacity: 1 }, { opacity: 0.45 }], {
                duration: 1100,
                iterations: Infinity,
                direction: 'alternate',
                easing: 'ease-in-out',
                delay: -i * 140,
            });

            this.wicks.push(wick);
            this.bodies.push(body);
            this.hollow.push(candle.hollow);
            mark.appendChild(column);
        });

        return mark;
    }
}
