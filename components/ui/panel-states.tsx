"use client";

import type { ReactNode } from "react";

/**
 * The three states every panel needs, in one place so they always read the
 * same: waiting (ghost rows at the real row height, so the panel never jumps
 * when the data lands), failed (one sentence plus Try again), and empty (one
 * sentence, an optional hint, an optional action).
 *
 * Only the ghost rows animate, and that pulse turns itself off when the system
 * asks for reduced motion.
 */

export const panelActionClass =
  "inline-flex h-7 shrink-0 items-center rounded-[4px] border border-(--app-border) bg-(--app-hover) px-3 text-[12px] font-medium text-(--app-text) hover:border-(--app-accent) hover:text-(--app-accent) disabled:cursor-not-allowed disabled:text-(--app-disabled)";

export function PanelButton({
  children,
  onClick,
  title,
  disabled = false,
}: {
  children: ReactNode;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={panelActionClass}
      onClick={onClick}
      title={title}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function PanelMessage({
  tone,
  text,
  hint,
  action,
  className = "",
}: {
  tone: "muted" | "error";
  text: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={`flex h-full min-h-[120px] flex-col items-center justify-center gap-2 px-4 py-6 text-center ${className}`}
    >
      <p
        className={`max-w-[46ch] text-[13px] leading-[18px] ${
          tone === "error" ? "text-(--app-text)" : "text-(--app-muted)"
        }`}
      >
        {text}
      </p>
      {hint ? (
        <p className="max-w-[46ch] text-[11px] leading-[16px] text-(--app-meta)">{hint}</p>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/** Nothing to show, and that is normal — say so in one sentence. */
export function PanelEmpty({
  text,
  hint,
  action,
  className,
}: {
  text: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return <PanelMessage tone="muted" text={text} hint={hint} action={action} className={className} />;
}

/** Something went wrong — what happened, and a way to ask again. */
export function PanelFailed({
  text,
  detail,
  onRetry,
  retryLabel = "Try again",
  className,
}: {
  text: ReactNode;
  detail?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <PanelMessage
      tone="error"
      text={text}
      hint={detail}
      action={onRetry ? <PanelButton onClick={onRetry}>{retryLabel}</PanelButton> : undefined}
      className={className}
    />
  );
}

/** Deterministic bar widths so repeated renders do not shimmer. */
const GHOST_BARS: Array<[number, number, number]> = [
  [42, 16, 12],
  [34, 22, 10],
  [50, 14, 18],
  [28, 18, 14],
];

export function PanelWaiting({
  label,
  rows = 6,
  rowHeight = 30,
  variant = "rows",
  className = "",
}: {
  label: string;
  rows?: number;
  /** Height of one ghost row — match the real row so nothing jumps. */
  rowHeight?: number;
  variant?: "rows" | "cards";
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={`min-h-[120px] ${className}`}
    >
      <span className="sr-only">{label}</span>
      <div
        className={`animate-pulse motion-reduce:animate-none ${
          variant === "cards" ? "flex flex-col gap-2" : ""
        }`}
      >
        {Array.from({ length: rows }, (_, i) => {
          const [a, b, c] = GHOST_BARS[i % GHOST_BARS.length];
          return variant === "cards" ? (
            <div
              key={i}
              className="rounded-[4px] border border-[var(--maws-border)] bg-[var(--maws-panel)] px-3 py-2"
              style={{ height: rowHeight }}
            >
              <span
                className="block h-2 rounded-[3px] bg-(--app-faint)"
                style={{ width: `${a}%` }}
              />
              <span
                className="mt-2 block h-2 rounded-[3px] bg-(--app-faint)"
                style={{ width: `${b + c}%` }}
              />
            </div>
          ) : (
            <div
              key={i}
              className="flex items-center gap-3 border-t border-(--app-border) first:border-t-0"
              style={{ height: rowHeight }}
            >
              <span className="h-2 rounded-[3px] bg-(--app-faint)" style={{ width: `${a}%` }} />
              <span className="h-2 rounded-[3px] bg-(--app-faint)" style={{ width: `${b}%` }} />
              <span
                className="ml-auto h-2 rounded-[3px] bg-(--app-faint)"
                style={{ width: `${c}%` }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
