import { expect, test } from "./fixtures";

/**
 * Topbar reachability: every drawing-bar control must be the topmost element at
 * its own centre, at the widths the app is actually used at.
 *
 * Regression this locks down: the bar's row was 600px wide inside a ~516px slot,
 * so with `overflow: visible` its tail spilled under the Template and broker
 * clusters — `document.elementFromPoint` returned those buttons instead, and the
 * Magnet / Long-Short cells could not be clicked at all at 1440px.
 *
 * Real mouse clicks only: no chart API shortcut, so the test fails if the DOM
 * button is covered again.
 */
const WIDTHS = [1440, 1280, 1024] as const;

for (const width of WIDTHS) {
  test(`drawing bar controls are clickable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.locator("[data-chart-host]").first()).toBeVisible({ timeout: 60_000 });

    const magnet = page.getByRole("button", { name: "Magnet snap", exact: true });
    const position = page.getByRole("button", { name: "Long/Short Position", exact: true });

    for (const control of [magnet, position]) {
      await expect(control).toBeVisible();
      await control.scrollIntoViewIfNeeded();
      const hit = await control.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {
          self: top === el || (top !== null && el.contains(top)),
          tag: top?.tagName ?? null,
          label: top?.getAttribute("aria-label") ?? null,
        };
      });
      const name = await control.getAttribute("aria-label");
      expect(hit.self, `${name} is covered by ${hit.tag}${hit.label ? ` (${hit.label})` : ""}`).toBe(
        true,
      );
    }

    // A covered button never receives the press, so the magnet toggle is the proof
    // the click landed: it ships on (weak) and flips off/on.
    const magnetCell = magnet.locator("xpath=..");
    await expect(magnetCell).toHaveAttribute("data-active", "1");
    await magnet.click();
    await expect(magnetCell).toHaveAttribute("data-active", "");
    await magnet.click();
    await expect(magnetCell).toHaveAttribute("data-active", "1");

    // Arming the position tool tints its own group cell.
    const positionCell = position.locator("xpath=..");
    await position.click();
    await expect(positionCell).toHaveAttribute("data-active", "1");
  });
}
