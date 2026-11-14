/**
 * Contrast contract for the app chrome tokens.
 *
 * The shell colours come from a Vela palette (lib/charting/core/theme.ts) via
 * `appSettingsFromTheme`, and every panel paints with `--app-*` variables. Two
 * things made "muted" text unreadable across the four palettes: the faint token
 * was a chart-grid tone reused as text, and accent-filled buttons hardcoded
 * white ink (gruvbox's yellow accent made the label vanish).
 *
 * This module owns the measurement (WCAG 2.x relative luminance) and the
 * resolved token set the shell paints with. Adjustments move HSL lightness only,
 * so each palette keeps its hue and character. No dependencies, no DOM.
 */

import type { AppSettings } from "@/lib/app-theme";

/** WCAG minimums the UI promises. */
export const CONTRAST = {
  /** Body and label text. */
  text: 4.5,
  /** Secondary/meta text that still has to be read. */
  meta: 4.5,
  /** Faint text: decoration only (separators, disabled glyphs). */
  faint: 3,
  /** Hairlines and dividers: visible, not readable. */
  border: 1.5,
  /** Ink drawn on top of an accent-filled control. */
  accentInk: 4.5,
  /** Bullish / bearish values against their surface. */
  market: 4.5,
} as const;

/** Meta text sits a step above body-legibility: easy to read at 11–12px. */
export const META_TARGET = 5.5;

const HEX_SHORT = /^#([0-9a-f]{3})$/;
const HEX_LONG = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/;

export function parseHex(color: string | null | undefined): [number, number, number] | null {
  // Defensive: a stubbed or partially-custom theme can omit a token entirely.
  if (typeof color !== "string") return null;
  const value = color.trim().toLowerCase();
  const short = HEX_SHORT.exec(value);
  if (short) {
    const [r, g, b] = short[1].split("");
    return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)];
  }
  const long = HEX_LONG.exec(value);
  if (!long) return null;
  const hex = long[1];
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

export function toHex(rgb: [number, number, number]): string {
  const [r, g, b] = rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 (black) … 1 (white). */
export function relativeLuminance(color: string): number {
  const rgb = parseHex(color);
  if (!rgb) return 0;
  const [r, g, b] = rgb;
  return (
    0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
  );
}

/** WCAG contrast ratio between two opaque colours, 1 … 21. */
export function contrastRatio(a: string, b: string): number {
  if (!parseHex(a) || !parseHex(b)) return 1;
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

export function formatRatio(ratio: number): string {
  return `${ratio.toFixed(2)}:1`;
}

type Hsl = { h: number; s: number; l: number };

export function rgbToHsl([r, g, b]: [number, number, number]): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

export function hslToHex({ h, s, l }: Hsl): string {
  if (s === 0) {
    const v = Math.round(l * 255);
    return toHex([v, v, v]);
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return toHex([
    channel(h + 1 / 3) * 255,
    channel(h) * 255,
    channel(h - 1 / 3) * 255,
  ]);
}

/**
 * Nudge a colour's lightness (hue and saturation untouched) until it clears
 * `min` against `surface`. Light text on a dark surface moves up; text on a
 * light surface moves down. Returns the closest achievable colour otherwise.
 */
export function withMinContrast(color: string, surface: string, min: number): string {
  if (typeof color !== "string" || !parseHex(color)) return color;
  if (!parseHex(surface)) return color;
  if (contrastRatio(color, surface) >= min) return color;
  const rgb = parseHex(color);
  if (!rgb) return color;
  const base = rgbToHsl(rgb);
  const lighten = relativeLuminance(surface) < 0.35;
  let best = color;
  let bestRatio = contrastRatio(color, surface);
  for (let step = 1; step <= 100; step += 1) {
    const l = lighten ? base.l + step / 100 : base.l - step / 100;
    if (l < 0 || l > 1) break;
    const candidate = hslToHex({ ...base, l });
    const ratio = contrastRatio(candidate, surface);
    if (ratio >= min) return candidate;
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
  }
  return best;
}

/**
 * Ink for an accent-filled control: whichever of black, white or the page
 * background reads best on the accent, so a custom accent (gruvbox yellow, a
 * user pick) can never produce an unreadable label.
 */
export function readableInk(accent: string, background: string): string {
  if (!parseHex(accent)) return "#ffffff";
  const candidates = ["#ffffff", "#000000", background];
  let best = candidates[0];
  let bestRatio = 0;
  for (const candidate of candidates) {
    const ratio = contrastRatio(candidate, accent);
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
  }
  return best;
}

/** Tokens the shell paints with, after contrast resolution. */
export type ResolvedTokens = {
  text: string;
  muted: string;
  faint: string;
  meta: string;
  disabled: string;
  accentInk: string;
  up: string;
  down: string;
  surfaces: { background: string; panel: string; elevated: string };
  border: string;
  accent: string;
};

function worstSurfaceOf(surfaces: string[], color: string): string {
  return surfaces.reduce((worst, surface) =>
    contrastRatio(color, surface) < contrastRatio(color, worst) ? surface : worst,
  );
}

/** A string token or the given fallback (stubbed/custom themes may omit one). */
function token(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/**
 * Effective chrome tokens for a settings object.
 *
 * Floors apply to the built-in palettes and to normal (non-advanced) themes.
 * A user who has switched on advanced colours keeps their picks; meta text and
 * accent ink are still computed so those two never regress.
 */
export function resolveAppTokens(settings: AppSettings): ResolvedTokens {
  const surfaces = {
    background: settings.backgroundColor,
    panel: settings.panelColor,
    elevated: settings.elevatedColor,
  };
  const surfaceList = [surfaces.background, surfaces.panel, surfaces.elevated];
  const base = {
    text: token(settings.textColor, "#d1d4dc"),
    muted: token(settings.mutedColor, "#787b86"),
    faint: token(settings.faintColor, token(settings.mutedColor, "#4c525e")),
    up: token(settings.upColor, "#089981"),
    down: token(settings.downColor, "#f23645"),
    border: token(settings.borderColor, "#222222"),
  };
  const accent = token(settings.accentColor, "#2962ff");

  const lift = (color: string, min: number): string =>
    withMinContrast(color, worstSurfaceOf(surfaceList, color), min);

  const enforce = !settings.advancedColors;
  const muted = enforce ? lift(base.muted, CONTRAST.meta) : base.muted;

  return {
    text: enforce ? lift(base.text, CONTRAST.text) : base.text,
    muted,
    faint: enforce ? lift(base.faint, CONTRAST.faint) : base.faint,
    meta: lift(muted, META_TARGET),
    disabled: lift(muted, CONTRAST.text),
    accentInk: readableInk(accent, surfaces.background),
    up: enforce ? lift(base.up, CONTRAST.market) : base.up,
    down: enforce ? lift(base.down, CONTRAST.market) : base.down,
    surfaces,
    border: enforce ? lift(base.border, CONTRAST.border) : base.border,
    accent,
  };
}
