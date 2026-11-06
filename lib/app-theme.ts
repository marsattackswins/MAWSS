/** Chrome colors for shell UI (everything except the chart canvas). */

import { LIGHT_THEME, resolveTheme, resolveThemeIndicatorColors, type ThemeName } from "@/lib/charting";
import type { ChartSettings, IndicatorInstance, IndicatorSettingsMap } from "@/types";

export type AppSettings = {
  /** Page / shell background */
  backgroundColor: string;
  /** Watchlist, docks, side panels */
  panelColor: string;
  /** Chips, menus, elevated surfaces */
  elevatedColor: string;
  /** Dividers and outlines */
  borderColor: string;
  /** Bars and rails (top bar, dock strips) — Vela's `bgBar` surface */
  barColor: string;
  /** Row / control hover */
  hoverColor: string;
  /** Primary text */
  textColor: string;
  /** Secondary / muted text */
  mutedColor: string;
  /** Tertiary / faint text */
  faintColor?: string;
  /** Bullish / positive values */
  upColor?: string;
  /** Bearish / negative values */
  downColor?: string;
  /** Accent / interactive highlights */
  accentColor?: string;
  /** When true, individual color pickers are visible in the Theme settings tab. */
  advancedColors?: boolean;
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  backgroundColor: "#000000",
  panelColor: "#111111",
  elevatedColor: "#1a1a1a",
  borderColor: "#222222",
  barColor: "#171b26",
  hoverColor: "#1a1a1a",
  textColor: "#d1d4dc",
  mutedColor: "#787b86",
  faintColor: "#4c525e",
  upColor: "#089981",
  downColor: "#f23645",
  accentColor: "#2962ff",
};

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function colorOr(fallback: string, value?: string | null) {
  if (typeof value === "string" && HEX.test(value.trim())) return value.trim();
  return fallback;
}

export function normalizeAppSettings(
  raw: Partial<AppSettings> | null | undefined,
): AppSettings {
  const base = DEFAULT_APP_SETTINGS;
  return {
    backgroundColor: colorOr(base.backgroundColor, raw?.backgroundColor),
    panelColor: colorOr(base.panelColor, raw?.panelColor),
    elevatedColor: colorOr(base.elevatedColor, raw?.elevatedColor),
    borderColor: colorOr(base.borderColor, raw?.borderColor),
    barColor: colorOr(base.barColor, raw?.barColor),
    hoverColor: colorOr(base.hoverColor, raw?.hoverColor),
    textColor: colorOr(base.textColor, raw?.textColor),
    mutedColor: colorOr(base.mutedColor, raw?.mutedColor),
    faintColor: colorOr(base.faintColor || "#4c525e", raw?.faintColor),
    upColor: colorOr(base.upColor || "#089981", raw?.upColor),
    downColor: colorOr(base.downColor || "#f23645", raw?.downColor),
    accentColor: colorOr(base.accentColor || "#2962ff", raw?.accentColor),
    advancedColors: raw?.advancedColors ?? false,
  };
}

/** Push app chrome colors onto :root as CSS variables. */
export function applyAppTheme(settings: AppSettings) {
  if (typeof document === "undefined") return;
  const s = normalizeAppSettings(settings);
  const root = document.documentElement;
  root.style.setProperty("--app-bg", s.backgroundColor);
  root.style.setProperty("--app-panel", s.panelColor);
  root.style.setProperty("--app-elevated", s.elevatedColor);
  root.style.setProperty("--app-border", s.borderColor);
  root.style.setProperty("--app-bar", s.barColor);
  root.style.setProperty("--app-hover", s.hoverColor);
  root.style.setProperty("--app-text", s.textColor);
  root.style.setProperty("--app-muted", s.mutedColor);
  root.style.setProperty("--app-faint", s.faintColor || "#4c525e");
  root.style.setProperty("--app-up", s.upColor || "#089981");
  root.style.setProperty("--app-down", s.downColor || "#f23645");
  root.style.setProperty("--app-accent", s.accentColor || "#2962ff");

  // Alias used by some shell widgets
  root.style.setProperty("--maws-bg", s.backgroundColor);
  root.style.setProperty("--maws-panel", s.panelColor);
  root.style.setProperty("--maws-elevated", s.elevatedColor);
  root.style.setProperty("--maws-border", s.borderColor);
  root.style.setProperty("--maws-bar", s.barColor);
  root.style.setProperty("--maws-hover", s.hoverColor);
  root.style.setProperty("--maws-text", s.textColor);
  root.style.setProperty("--maws-muted", s.mutedColor);
  root.style.setProperty("--maws-faint", s.faintColor || "#4c525e");
  root.style.setProperty("--maws-up", s.upColor || "#089981");
  root.style.setProperty("--maws-down", s.downColor || "#f23645");
  root.style.setProperty("--maws-accent", s.accentColor || "#2962ff");

  // Keep legacy TV tokens in sync for anything still referencing them.
  root.style.setProperty("--color-tv-bg", s.backgroundColor);
  root.style.setProperty("--color-tv-panel", s.panelColor);
  root.style.setProperty("--color-tv-settings", s.elevatedColor);
  root.style.setProperty("--color-tv-settings-input", s.elevatedColor);
  root.style.setProperty("--color-tv-border", s.borderColor);
  root.style.setProperty("--color-tv-text", s.textColor);
  root.style.setProperty("--color-tv-muted", s.mutedColor);
  root.style.setProperty("--color-tv-faint", s.faintColor || "#4c525e");
  root.style.setProperty("--color-tv-green", s.upColor || "#089981");
  root.style.setProperty("--color-tv-red", s.downColor || "#f23645");
  root.style.setProperty("--color-tv-blue", s.accentColor || "#2962ff");
}

// ── Vela theme ↔ app theme ─────────────────────────────────────────────────

/** AppSettings built from a resolved Vela theme — one palette drives charts
 *  AND every shell panel (TopBar, watchlist, docks, modals). */
export function appSettingsFromVelaTheme(themeName: ThemeName): AppSettings {
  const t = resolveTheme(themeName);
  const accent = themeName === "gruvbox" ? "#fabd2f" : "#2962ff";
  const faint = t.textMuted ?? (themeName === "light" ? "#94a3b8" : "#4c525e");
  return {
    backgroundColor: t.background,
    panelColor: t.background,
    elevatedColor: t.bgCard ?? t.background,
    borderColor: t.border ?? t.borderColor,
    barColor: t.bgBar ?? t.bgPanel ?? t.background,
    hoverColor: t.bgHover ?? t.bgChip ?? t.border ?? t.borderColor,
    textColor: t.textPrimary ?? t.textColor,
    mutedColor: t.textSecondary ?? t.textColor,
    faintColor: faint,
    upColor: t.upColor,
    downColor: t.downColor,
    accentColor: accent,
  };
}

/** The Vela theme matching a persisted AppSettings. Vela themes don't survive a
 *  reload on their own, so ChartCanvas re-derives the theme from the store's
 *  chrome colors on mount — every theme maps to a distinct backgroundColor. */
export function velaThemeNameFromAppSettings(settings: AppSettings): ThemeName {
  const bg = settings.backgroundColor.trim().toLowerCase();
  // Defensive reads: a stubbed/custom theme may omit `background` — never
  // throw while deriving a name from persisted chrome colors.
  const themeBg = (t: { background?: string }): string =>
    typeof t?.background === "string" ? t.background.trim().toLowerCase() : "";
  const light = themeBg(LIGHT_THEME);
  const classic = themeBg(resolveTheme("classic"));
  const gruvbox = themeBg(resolveTheme("gruvbox"));
  if (light && bg === light) return "light";
  if (classic && bg === classic) return "classic";
  if (gruvbox && bg === gruvbox) return "gruvbox";
  return "dark";
}

/** Migrate a persisted LEGACY-default palette to Vela's dark theme so the
 *  shell matches Vela's chart chrome out of the box. Explicit custom colors
 *  are left untouched. */
export function migrateLegacyAppSettings(settings: AppSettings): AppSettings {
  const legacy = DEFAULT_APP_SETTINGS;
  const isLegacy = (Object.keys(legacy) as Array<keyof AppSettings>).every((k) => {
    const sv = settings[k];
    const lv = legacy[k];
    if (typeof sv !== "string" || typeof lv !== "string") return true; // skip non-color keys
    return sv.toLowerCase() === lv.toLowerCase();
  });
  return isLegacy ? appSettingsFromVelaTheme("dark") : settings;
}

/** One-time refresh for sessions that picked a theme before the panel-surface
 *  fix: they carry the old `bgPanel` token persisted as `panelColor` (dark
 *  #121215, classic #1e222d, light #f8f9fa), which made the docks read as a
 *  different color from the chart after the theme pick. Only the token values
 *  are migrated — explicit custom colors are left untouched. */
export function migrateMutedPanelColor(settings: AppSettings): AppSettings {
  const fromPanel: Record<string, string> = {
    "#121215": appSettingsFromVelaTheme("dark").panelColor,
    "#1e222d": appSettingsFromVelaTheme("classic").panelColor,
    "#f8f9fa": appSettingsFromVelaTheme("light").panelColor,
  };
  const panel = typeof settings.panelColor === "string" ? settings.panelColor.trim().toLowerCase() : "";
  const replacement = fromPanel[panel];
  return replacement ? { ...settings, panelColor: replacement } : settings;
}

/** A Vela theme pick from the chart-settings dialog: reskin the WHOLE app
 *  (chrome tokens + every live chart). Returns the resolved theme for callers
 *  that also want to persist the name. */
export function applyVelaThemeEverywhere(themeName: ThemeName): AppSettings {
  const next = appSettingsFromVelaTheme(themeName);
  applyAppTheme(next); // shell chrome (all panels, modals, top bar)
  return next;
}

// ── Vela theme ↔ chart cosmetics ──────────────────────────────────────────────

/** Chart-cosmetic keys a Vela theme owns — exactly the slots the renderer
 *  resolves from its live theme in `getConfig()`. */
export const THEME_OWNED_CHART_KEYS = [
  "backgroundColor",
  "bodyUpColor",
  "bodyDownColor",
  "borderUpColor",
  "borderDownColor",
  "wickUpColor",
  "wickDownColor",
  "horzGridColor",
  "vertGridColor",
  "paneSeparatorColor",
  "crosshairColor",
  "scaleTextColor",
  "scaleLineColor",
] as const satisfies ReadonlyArray<keyof ChartSettings>;

/** The chart cosmetics a Vela theme owns — the values `getConfig()` resolves
 *  after `setTheme`. Chart mounts replay `mawsToVelaConfig(chartSettings)`
 *  OVER the theme, so the persisted `chartSettings` must track the active
 *  theme or every remount (refresh, timeframe/symbol change) reverts the
 *  chart to the store's stale palette. */
export function chartSettingsFromVelaTheme(
  themeName: ThemeName,
): Partial<ChartSettings> {
  const t = resolveTheme(themeName);
  return {
    backgroundColor: t.background,
    bodyUpColor: t.upColor,
    bodyDownColor: t.downColor,
    borderUpColor: t.upColor,
    borderDownColor: t.downColor,
    wickUpColor: t.upColor,
    wickDownColor: t.downColor,
    horzGridColor: t.gridColor,
    vertGridColor: t.gridColor,
    paneSeparatorColor: t.borderColor,
    crosshairColor: t.textColor,
    scaleTextColor: t.textColor,
    scaleLineColor: t.borderColor,
  };
}

/** Updates default indicator settings to match a newly selected theme. */
export function themeIndicatorSettings(
  themeName: ThemeName,
  current: IndicatorSettingsMap,
): IndicatorSettingsMap {
  const p = resolveThemeIndicatorColors(themeName);
  return {
    ...current,
    vwap: { ...current.vwap, color: p.vwap },
    ema: { ...current.ema, color: p.ema },
    bb: {
      ...current.bb,
      basis: { ...current.bb.basis, color: p.bbBasis },
      upper: { ...current.bb.upper, color: p.bbUpper },
      lower: { ...current.bb.lower, color: p.bbLower },
      backgroundColor: p.bbBasis,
    },
    rsi: { ...current.rsi, color: p.rsi },
    stoch: {
      ...current.stoch,
      k: { ...current.stoch.k, color: p.stochK },
      d: { ...current.stoch.d, color: p.stochD },
    },
    atr: { ...current.atr, color: p.atr },
    adx: { ...current.adx, color: p.adx },
  };
}

/** Recolor an active study to match the theme if it was using default theme colors. */
export function themeStudySettings(themeName: ThemeName, study: IndicatorInstance): IndicatorInstance {
  const p = resolveThemeIndicatorColors(themeName);
  // Cast to any so spread-merging a single color field doesn't conflict with
  // the strict discriminated-union on IndicatorInstance["settings"].
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = study.settings as any;
  if (!s) return study;
  switch (study.type) {
    case "vwap":
      return { ...study, settings: { ...s, color: p.vwap } as IndicatorInstance["settings"] };
    case "ema":
      return { ...study, settings: { ...s, color: p.ema } as IndicatorInstance["settings"] };
    case "bb":
      return {
        ...study,
        settings: {
          ...s,
          basis: s.basis ? { ...s.basis, color: p.bbBasis } : s.basis,
          upper: s.upper ? { ...s.upper, color: p.bbUpper } : s.upper,
          lower: s.lower ? { ...s.lower, color: p.bbLower } : s.lower,
          backgroundColor: p.bbBasis,
        } as IndicatorInstance["settings"],
      };
    case "rsi":
      return { ...study, settings: { ...s, color: p.rsi } as IndicatorInstance["settings"] };
    case "stoch":
      return {
        ...study,
        settings: {
          ...s,
          k: s.k ? { ...s.k, color: p.stochK } : s.k,
          d: s.d ? { ...s.d, color: p.stochD } : s.d,
        } as IndicatorInstance["settings"],
      };
    case "atr":
      return { ...study, settings: { ...s, color: p.atr } as IndicatorInstance["settings"] };
    case "adx":
      return { ...study, settings: { ...s, color: p.adx } as IndicatorInstance["settings"] };
    default:
      return study;
  }
}
