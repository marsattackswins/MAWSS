import {
  DEFAULT_APP_SETTINGS,
  LIFTED_BORDERS,
  migrateLiftedBorder,
  migrateOledBlackSurfaces,
  RAISED_BLACK_SURFACES,
} from "@/lib/app-theme";
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

/**
 * The black theme went OLED true black: its panels/cards/bars were raised
 * greys, and sessions that persisted them keep painting grey surfaces beside
 * the black chart until exactly those tones drop to #000 on load.
 */
describe("migrateOledBlackSurfaces", () => {
  it("drops the old raised panel, card and bar tones to true black", () => {
    const settings = {
      ...DEFAULT_APP_SETTINGS,
      panelColor: "#111111",
      elevatedColor: "#1a1a1a",
      barColor: "#171b26",
    };
    const migrated = migrateOledBlackSurfaces(settings);
    expect(migrated.panelColor).toBe("#000000");
    expect(migrated.elevatedColor).toBe("#000000");
    expect(migrated.barColor).toBe("#000000");
    // Hover is feedback, not a surface — it keeps its lifted tone.
    expect(migrated.hoverColor).toBe(settings.hoverColor);
  });

  it("recognises only the exact tones the old palette wrote", () => {
    expect(Object.keys(RAISED_BLACK_SURFACES).sort()).toEqual(
      ["#111111", "#171b26", "#1a1a1a"].sort(),
    );
    const settings = {
      ...DEFAULT_APP_SETTINGS,
      panelColor: "#0d0d0d",
      elevatedColor: "#202020",
      barColor: "#101014",
    };
    expect(migrateOledBlackSurfaces(settings)).toBe(settings);
  });

  it("leaves other themes' surfaces alone", () => {
    const settings = {
      ...DEFAULT_APP_SETTINGS,
      backgroundColor: "#202126",
      panelColor: "#111111",
      elevatedColor: "#1a1a1a",
      barColor: "#171b26",
    };
    expect(migrateOledBlackSurfaces(settings)).toBe(settings);
  });

  it("leaves advanced-colour themes alone", () => {
    const settings = { ...DEFAULT_APP_SETTINGS, advancedColors: true };
    expect(migrateOledBlackSurfaces(settings)).toBe(settings);
  });

  it("is a no-op on an already-OLED palette", () => {
    const settings = {
      ...DEFAULT_APP_SETTINGS,
      panelColor: "#000000",
      elevatedColor: "#000000",
      barColor: "#000000",
    };
    expect(migrateOledBlackSurfaces(settings)).toBe(settings);
  });
});
