"use client";

import type { ReactNode } from "react";

export type GaugeLean =
  | "strongShort"
  | "short"
  | "neutral"
  | "long"
  | "strongLong";

const LEAN_LABEL: Record<GaugeLean, string> = {
  strongShort: "Strong sell",
  short: "Sell",
  neutral: "Neutral",
  long: "Buy",
  strongLong: "Strong buy",
};

/** Needle position 0 (strong sell) → 100 (strong buy). */
const LEAN_SCORE: Record<GaugeLean, number> = {
  strongShort: 10,
  short: 30,
  neutral: 50,
  long: 70,
  strongLong: 90,
};

/** Legacy RSI fallback for the details dock (not strategy-pegged). */
export function leanFromRsi(rsi: number): GaugeLean {
  const clamped = Math.max(0, Math.min(100, rsi));
  if (clamped >= 80) return "strongLong";
  if (clamped >= 60) return "long";
  if (clamped >= 40) return "neutral";
  if (clamped >= 20) return "short";
  return "strongShort";
}

/* Needle travel: the track spans the full card width, the needle is inset by
 * NUB% so it never leaves the rounded caps. */
const NUB = 2;

/** The red→grey→blue lean track, shared by the full gauge and the dock's tiny meter. */
const TRACK_GRADIENT =
  "linear-gradient(90deg, rgba(175,104,112,.9) 0%, rgba(175,104,112,.45) 28%, rgba(122,124,134,.5) 46%, rgba(122,124,134,.5) 54%, rgba(78,122,214,.55) 72%, rgba(78,122,214,.95) 100%)";

/** Needle position as a left-inset percentage of the track. */
function needleLeft(lean: GaugeLean): number {
  return NUB + (LEAN_SCORE[lean] / 100) * (100 - 2 * NUB);
}

/**
 * The lean track on its own — no label, no card. The docked strip uses this tiny
 * form in place of the Open/Overlap pill; `width`/`height` size it for that row.
 */
export function TechnicalsMeter({
  lean,
  width = 44,
  height = 4,
}: {
  lean: GaugeLean;
  width?: number;
  height?: number;
}) {
  return (
    <span
      role="img"
      aria-label={`Technicals: ${LEAN_LABEL[lean]}`}
      className="relative inline-block shrink-0 rounded-full align-middle"
      style={{ width, height, background: TRACK_GRADIENT }}
    >
      <span
        className="absolute top-1/2 -translate-y-1/2 rounded-full bg-[#eef0f4]"
        style={{ left: `${needleLeft(lean)}%`, width: 2, height: height + 4 }}
      />
    </span>
  );
}

/**
 * Technicals block — an elevated, bordered card. Its top line carries the label
 * + lean word ("Technicals" + lean); the thin desaturated red→grey→blue track
 * and its small white needle sit below as the FOLDED preview, always visible.
 * No Sell/Buy captions.
 *
 * Anything passed as `children` is the folded-out detail: it animates open with
 * `expanded` (the Sessions/News drawer pattern) and turns the header into a
 * toggle. With no `children` there is nothing to fold out, so the card stays a
 * static gauge readout — the fold lights up once more content is added.
 */
export function TechnicalsGauge({
  lean,
  expanded = true,
  onToggle,
  children,
}: {
  lean: GaugeLean;
  expanded?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}) {
  const label = LEAN_LABEL[lean];
  const collapsible = onToggle !== undefined && children !== undefined;

  return (
    <div className="px-3 pt-3">
      <div
        role={collapsible ? "button" : undefined}
        tabIndex={collapsible ? 0 : undefined}
        aria-expanded={collapsible ? expanded : undefined}
        title={collapsible ? (expanded ? "Collapse technicals" : "Show technicals") : undefined}
        onClick={collapsible ? onToggle : undefined}
        onKeyDown={
          collapsible
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggle?.();
                }
              }
            : undefined
        }
        className={`rounded-[8px] border border-(--app-border) bg-(--app-elevated) px-3 py-2.5 ${
          collapsible ? "cursor-pointer" : ""
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="text-[13px] font-semibold text-(--app-text)">Technicals</div>
          <span className="text-[13px] font-semibold text-(--app-text)">{label}</span>
        </div>

        {/* Folded preview — the lean track, always visible. */}
        <div className="pt-4 pb-1">
          <div
            role="img"
            aria-label={`Technicals: ${label}`}
            className="relative h-[5px] rounded-full"
            style={{ background: TRACK_GRADIENT }}
          >
            <span
              className="absolute top-1/2 h-[11px] w-[3px] -translate-y-1/2 rounded-full bg-[#eef0f4]"
              style={{ left: `${needleLeft(lean)}%` }}
            />
          </div>
        </div>

        {/* Folded-out detail — future rows land here; collapses with the drawer. */}
        {children !== undefined && (
          <div
            className="grid transition-[grid-template-rows] duration-200 ease-out"
            style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
          >
            <div className="overflow-hidden">
              <div className="pt-2 pb-1">{children}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
