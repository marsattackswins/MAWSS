import { appSettingsFromTheme } from "@/lib/app-theme";
import type { ThemeName } from "@/lib/charting";
import {
  BLACK_THEME,
  CLASSIC_THEME,
  DARK_THEME,
  GRUVBOX_THEME,
  LIGHT_THEME,
} from "../../lib/charting/core/theme";
import { CONTRAST, contrastRatio, formatRatio, resolveAppTokens } from "@/lib/theme-contrast";

/**
 * Every built-in palette must keep its text legible.
 *
 * The shell's readability rule: text and meta text clear WCAG AA (4.5:1) on all
 * three shell surfaces, faint text is decoration only (3:1), borders are
 * visible (1.5:1), accent-filled buttons have readable ink (4.5:1) and the
 * bullish/bearish colours stay readable as text (4.5:1).
 *
 * Failure output is the worklist: one line per failing token pair.
 */
/** The real palettes, read from the charting source: jest stubs `@/lib/charting`
 *  for component tests, so the palette table is imported directly. */
const PALETTES: Array<[ThemeName, typeof DARK_THEME]> = [
  ["black", BLACK_THEME],
  ["dark", DARK_THEME],
  ["classic", CLASSIC_THEME],
  ["gruvbox", GRUVBOX_THEME],
  ["light", LIGHT_THEME],
];

type Check = { palette: string; token: string; rgb: string; surface: string; ratio: number; min: number };

function worstSurface(
  surfaces: Array<{ name: string; rgb: string }>,
  color: string,
): { name: string; rgb: string; ratio: number } {
  return surfaces
    .map((surface) => ({ ...surface, ratio: contrastRatio(color, surface.rgb) }))
    .reduce((worst, next) => (next.ratio < worst.ratio ? next : worst));
}

function collect(): Check[] {
  const checks: Check[] = [];
  for (const [palette, theme] of PALETTES) {
    const tokens = resolveAppTokens(appSettingsFromTheme(theme, palette));
    const surfaces = [
      { name: "bg", rgb: tokens.surfaces.background },
      { name: "panel", rgb: tokens.surfaces.panel },
      { name: "elevated", rgb: tokens.surfaces.elevated },
    ];

    for (const [token, rgb, min] of [
      ["text", tokens.text, CONTRAST.text],
      ["meta", tokens.meta, CONTRAST.meta],
      ["faint", tokens.faint, CONTRAST.faint],
      ["up", tokens.up, CONTRAST.market],
      ["down", tokens.down, CONTRAST.market],
    ] as const) {
      const worst = worstSurface(surfaces, rgb);
      checks.push({ palette, token, rgb, surface: worst.name, ratio: worst.ratio, min });
    }

    checks.push({
      palette,
      token: "accent-ink",
      rgb: tokens.accentInk,
      surface: "accent",
      ratio: contrastRatio(tokens.accentInk, tokens.accent),
      min: CONTRAST.accentInk,
    });
  }
  return checks;
}

function report(checks: Check[]): string {
  const rows = checks
    .map(
      (c) =>
        `${c.palette.padEnd(8)} ${c.token.padEnd(10)} ${c.rgb.padEnd(9)} on ${c.surface.padEnd(9)} ` +
        `${formatRatio(c.ratio).padStart(7)} (min ${c.min.toFixed(1)})`,
    )
    .join("\n");
  return `\ncontrast audit\n${"-".repeat(70)}\n${rows}\n`;
}

describe("theme contrast", () => {
  const checks = collect();

  it("prints the audit table", () => {
    // eslint-disable-next-line no-console
    console.log(report(checks));
    expect(checks.length).toBeGreaterThan(0);
  });

  it("keeps every palette's separators decorative", () => {
    // Borders are structure, not content: each palette keeps its own hairline
    // tone, never a contrast-lifted one (that read as drawn lines everywhere).
    for (const [palette, theme] of PALETTES) {
      const tokens = resolveAppTokens(appSettingsFromTheme(theme, palette));
      expect({ palette, border: tokens.border }).toEqual({
        palette,
        border: theme.border ?? theme.borderColor,
      });
    }
  });

  it("keeps true black OLED: every shell surface at #000000", () => {
    const settings = appSettingsFromTheme(BLACK_THEME, "black");
    expect({
      background: settings.backgroundColor,
      panel: settings.panelColor,
      elevated: settings.elevatedColor,
      bar: settings.barColor,
    }).toEqual({
      background: "#000000",
      panel: "#000000",
      elevated: "#000000",
      bar: "#000000",
    });
  });

  it("keeps every token above its readable floor", () => {
    const failures = checks.filter((c) => c.ratio < c.min);
    expect(
      failures.map(
        (c) => `${c.palette}/${c.token}: ${formatRatio(c.ratio)} < ${c.min.toFixed(1)} on ${c.surface}`,
      ),
    ).toEqual([]);
  });
});
