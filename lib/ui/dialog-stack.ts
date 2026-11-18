/**
 * Open-dialog stack.
 *
 * Escape belongs to the INNERMOST pop-up. Before this, the shell's single
 * Escape handler only knew the top-level dialogs, so pressing Escape inside a
 * confirm step (the Live-connection warning, the profile password prompt)
 * closed the whole chooser behind it instead of the step you were looking at.
 *
 * The stack is process-wide and mutated only through these helpers, so a
 * dialog's cleanup can always remove exactly its own entry.
 */

const openIds: symbol[] = [];

/** Register an open dialog; the newest one owns Escape. */
export function openDialog(): symbol {
  const id = Symbol("dialog");
  openIds.push(id);
  return id;
}

/** Remove one dialog's entry (idempotent). */
export function closeDialog(id: symbol): void {
  const index = openIds.lastIndexOf(id);
  if (index >= 0) openIds.splice(index, 1);
}

/** True when `id` is the innermost open dialog. */
export function ownsEscape(id: symbol): boolean {
  return openIds.length > 0 && openIds[openIds.length - 1] === id;
}

/**
 * Route one Escape press: the innermost dialog closes itself and reports that
 * it consumed the key; every other listener stays silent so the shell's global
 * handler does not also close the dialog underneath.
 */
export function routeEscape(id: symbol, close: () => void): boolean {
  if (!ownsEscape(id)) return false;
  close();
  return true;
}

/** Test seam — the stack is process-wide. */
export function resetDialogStack(): void {
  openIds.length = 0;
}
