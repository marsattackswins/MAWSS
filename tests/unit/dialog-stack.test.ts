import { closeDialog, openDialog, ownsEscape, resetDialogStack, routeEscape } from "@/lib/ui/dialog-stack";

/**
 * Escape must close the innermost dialog only. A nested step (the Live
 * connection warning inside the profile chooser) used to hand the key to the
 * shell handler, which tore down the chooser behind it.
 */
describe("dialog stack", () => {
  beforeEach(() => resetDialogStack());

  it("gives Escape to the newest dialog", () => {
    const chooser = openDialog();
    const confirm = openDialog();
    expect(ownsEscape(chooser)).toBe(false);
    expect(ownsEscape(confirm)).toBe(true);
  });

  it("closes one layer per press and hands the key back to the parent", () => {
    const chooser = openDialog();
    const confirm = openDialog();
    const closed: string[] = [];

    expect(routeEscape(chooser, () => closed.push("chooser"))).toBe(false);
    expect(routeEscape(confirm, () => closed.push("confirm"))).toBe(true);
    closeDialog(confirm);

    expect(closed).toEqual(["confirm"]);
    expect(routeEscape(chooser, () => closed.push("chooser"))).toBe(true);
    expect(closed).toEqual(["confirm", "chooser"]);
  });

  it("ignores a dialog that already unregistered", () => {
    const first = openDialog();
    closeDialog(first);
    expect(ownsEscape(first)).toBe(false);
    expect(routeEscape(first, () => {})).toBe(false);
  });

  it("survives a cleanup that runs twice", () => {
    const id = openDialog();
    closeDialog(id);
    closeDialog(id);
    expect(ownsEscape(id)).toBe(false);
  });

  it("never consumes Escape when nothing is open", () => {
    const stale = openDialog();
    closeDialog(stale);
    expect(routeEscape(stale, () => {})).toBe(false);
  });
});
