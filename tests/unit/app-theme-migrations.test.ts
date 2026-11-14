import { DEFAULT_APP_SETTINGS, LIFTED_BORDERS, migrateLiftedBorder } from "@/lib/app-theme";
import {
  CLASSIC_THEME,
  DARK_THEME,
  GRUVBOX_THEME,
  LIGHT_THEME,
} from "../../lib/charting/core/theme";

/**
 * The border-contrast floor briefly persisted contrast-lifted divider tones as
 * `borderColor`. Those hairlines made every separator and panel edge read as a
 * drawn line, so the repair rewrites exactly those tones — and nothing else —
 * on load.
 */
const LIFTED: Array<{ lifted: string; theme: typeof DARK_THEME }> = [
  { lifted: "#414146", theme: DARK_THEME },
  { lifted: "#444a5c", theme: CLASSIC_THEME },
  { lifted: "#5a5451", theme: GRUVBOX_THEME },
  { lifted: "#cbd2dd", theme: LIGHT_THEME },
];

function settingsWith(borderColor: string, advancedColors = false) {
  return { ...DEFAULT_APP_SETTINGS, borderColor, advancedColors };
}

describe("migrateLiftedBorder", () => {
  it.each(LIFTED)("maps $lifted back to its palette border", ({ lifted, theme }) => {
    const paletteBorder = theme.border ?? theme.borderColor;
    expect(LIFTED_BORDERS[lifted]).toBe(paletteBorder);

    const migrated = migrateLiftedBorder(settingsWith(lifted));
    expect(migrated.borderColor).toBe(paletteBorder);
  });

  it("leaves unrelated colours untouched", () => {
    for (const borderColor of ["#123456", "#262629", "#ffffff", "#000000"]) {
      expect(migrateLiftedBorder(settingsWith(borderColor)).borderColor).toBe(borderColor);
    }
  });

  it("leaves advanced-colour themes alone", () => {
    for (const { lifted } of LIFTED) {
      const settings = settingsWith(lifted, true);
      expect(migrateLiftedBorder(settings)).toBe(settings);
      expect(migrateLiftedBorder(settings).borderColor).toBe(lifted);
    }
  });
});
