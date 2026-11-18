"use client";

import type { TechnicalsRow } from "@/lib/technicals-lean";
import { useEffect, useRef, useState, type ReactNode } from "react";

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

/* Needle travel: the track spans the full card width, the needle is inset by
 * NUB% so it never leaves the rounded caps. */
const NUB = 2;

/** Side pip color in the fold-out rows — the app's up/down hues, muted when flat. */
const SIDE_COLOR: Record<string, string> = {
  bullish: "var(--app-up)",
  bearish: "var(--app-down)",
  flat: "var(--app-muted)",
};

/**
 * The gauge's fold-out detail: one row per check — label left, live reading
 * right, and a small meaning-encoding pip that colors by which side the check
 * currently votes for.
 */
export function TechnicalsRows({ rows }: { rows: TechnicalsRow[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.label} className="flex items-center justify-between gap-2">
          <span className="truncate text-[12px] leading-4 text-(--app-muted)">{row.label}</span>
          <span className="flex shrink-0 items-center gap-2">
            <span className="text-[12px] leading-4 tabular-nums text-(--app-text)">
              {row.value}
            </span>
            <span
              aria-hidden
              className="h-[5px] w-[5px] shrink-0 rounded-full"
              style={{ background: SIDE_COLOR[row.side] }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The red→grey→blue lean track, shared by the full gauge and the dock's tiny meter. */
const TRACK_GRADIENT =
  "linear-gradient(90deg, var(--app-down) 0%, rgba(122,124,134,.5) 50%, var(--app-up) 100%)";

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
        className="absolute top-1/2 -translate-y-1/2 rounded-full bg-(--app-text)"
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

  // Natural height of the fold-out content, so the drawer animates to a fixed
  // pixel value instead of `auto` (the News/Sessions measurement pattern).
  const detailRef = useRef<HTMLDivElement>(null);
  const [detailHeight, setDetailHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = detailRef.current;
    if (!el) return;
    const measure = () => setDetailHeight(el.offsetHeight);
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

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
        className={`rounded-[8px] border border-(--app-border) bg-(--app-elevated) px-3 py-2 ${
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
              className="absolute top-1/2 h-[11px] w-[3px] -translate-y-1/2 rounded-full bg-(--app-text)"
              style={{ left: `${needleLeft(lean)}%` }}
            />
          </div>
        </div>

        {/* Collapsible drawer window — the indicator rows. Same measured-height
            slide as the News and Sessions cards: the un-clipped content keeps
            its natural height so the fold animates to a fixed pixel value. */}
        {children !== undefined && (
          <div
            className="overflow-hidden transition-[height] duration-200 ease-out"
            style={{ height: expanded ? detailHeight ?? "auto" : 0 }}
          >
            <div ref={detailRef} className="pt-4 pb-1">
              {children}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
