"use client";

import { useEffect, useRef } from "react";
import type { MouseEvent, ReactNode, Ref } from "react";
import { X } from "lucide-react";
import { closeDialog, openDialog, routeEscape } from "@/lib/ui/dialog-stack";

/**
 * One frame for every pop-up in the app: the same title bar, the same close
 * button, the same body and footer measurements, and the same closing rules
 * (Escape, click outside, focus back to the control that opened it).
 *
 * Settings palettes keep a clear backdrop on purpose — you change them while
 * watching the chart, so dimming the screen would hide the thing you are
 * adjusting. Blocking dialogs (profile, Live confirm) dim it.
 */

export const dialogFrame = {
  backdrop: "fixed inset-0 flex items-center justify-center bg-black/60",
  clearBackdrop: "fixed inset-0 flex items-center justify-center bg-transparent",
  panel:
    "flex max-h-[calc(100vh-64px)] flex-col overflow-hidden rounded-[8px] border border-(--app-border) bg-(--app-elevated) shadow-[var(--app-shadow-dialog)]",
  // Alignment (centre for one-line titles, top for title + subtitle) is the
  // caller's job, so a header can never end up with both in one class list.
  header:
    "flex shrink-0 justify-between gap-3 border-b border-(--app-border) px-5 py-3",
  titleGroup: "min-w-0",
  title: "text-[16px] font-semibold text-(--app-text)",
  subtitle: "mt-1 text-[12px] text-(--app-muted)",
  closeBtn:
    "flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] text-(--app-muted) hover:bg-(--app-hover) hover:text-(--app-text)",
  body: "min-h-0 flex-1 overflow-y-auto px-5 py-4",
  footer:
    "flex shrink-0 items-center justify-between gap-2 border-t border-(--app-border) px-5 py-3",
} as const;

/**
 * Escape + focus return for one pop-up. Register it in every dialog, nested
 * ones included: the innermost dialog owns Escape and stops it from reaching
 * the shell's global handler.
 */
export function useDialogDismiss(isOpen: boolean, onClose: () => void): void {
  const returnToRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const id = openDialog();
    const from = document.activeElement;
    returnToRef.current = from instanceof HTMLElement ? from : null;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (routeEscape(id, () => onCloseRef.current())) event.stopPropagation();
    };
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      closeDialog(id);
      const back = returnToRef.current;
      returnToRef.current = null;
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, [isOpen]);
}

/** Full-screen holder: dims the app, or stays clear for chart palettes. */
export function DialogBackdrop({
  onClose,
  children,
  zIndex = 80,
  clear = false,
  align = "center",
  className = "",
}: {
  onClose?: () => void;
  children: ReactNode;
  zIndex?: number;
  clear?: boolean;
  /** Centred modals, or top-anchored pickers (the indicator library). */
  align?: "center" | "start";
  className?: string;
}) {
  const alignClass = align === "start" ? "items-start" : "items-center";
  return (
    <div
      className={`${clear ? dialogFrame.clearBackdrop : dialogFrame.backdrop} ${alignClass} ${className}`}
      style={{ zIndex }}
      onMouseDown={
        onClose
          ? (event: MouseEvent<HTMLDivElement>) => {
              if (event.target === event.currentTarget) onClose();
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}

/** The surface itself: rounded, elevated, scrolling body, sticky header/footer. */
export function DialogPanel({
  children,
  className = "",
  labelledBy,
  describedBy,
  onMouseDown,
}: {
  children: ReactNode;
  className?: string;
  labelledBy?: string;
  describedBy?: string;
  onMouseDown?: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={`${dialogFrame.panel} ${className}`}
      onMouseDown={onMouseDown ?? ((event) => event.stopPropagation())}
    >
      {children}
    </div>
  );
}

/** Title bar: title, optional one-line subtitle, optional extra action, close. */
export function DialogHeader({
  title,
  subtitle,
  titleId,
  onClose,
  trailing,
  onMouseDown,
  closeRef,
  closeLabel = "Close",
  className = "",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  titleId?: string;
  onClose: () => void;
  trailing?: ReactNode;
  /** Drag handle — settings palettes stay movable. */
  onMouseDown?: (event: MouseEvent<HTMLDivElement>) => void;
  /** Lets a dialog put focus on the close button when it opens. */
  closeRef?: Ref<HTMLButtonElement>;
  closeLabel?: string;
  className?: string;
}) {
  return (
    <div
      className={`${dialogFrame.header} ${subtitle ? "items-start" : "items-center"} ${onMouseDown ? "cursor-move select-none" : ""} ${className}`}
      onMouseDown={onMouseDown}
    >
      <div className={`${dialogFrame.titleGroup} ${subtitle ? "" : "flex items-center"}`}>
        <div id={titleId} className={dialogFrame.title}>
          {title}
        </div>
        {subtitle ? <div className={dialogFrame.subtitle}>{subtitle}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {trailing}
        <button
          ref={closeRef}
          type="button"
          className={dialogFrame.closeBtn}
          onClick={onClose}
          aria-label={closeLabel}
          title={closeLabel}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

export function DialogBody({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`${dialogFrame.body} ${className}`}>{children}</div>;
}

/** Footer: an optional note on the left, the actions on the right. */
export function DialogFooter({
  left,
  children,
  className = "",
}: {
  left?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`${dialogFrame.footer} ${className}`}>
      <div className="min-w-0">{left}</div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
