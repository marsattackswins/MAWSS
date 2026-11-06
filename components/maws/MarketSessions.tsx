"use client";

/**
 * MarketSessions.tsx — the watchlist's Sessions card: a 24-hour strip of the three cash
 * sessions, for every instrument, with the live one named above it.
 *
 * Adapted from the market-sessions widget of the Vela playground
 * (github.com/infinitegithub/vela `playground/watchlist-panel.ts`), which mirrors the
 * card the official Vela client renders under its watchlist. Vela is © LuxAlgo,
 * Apache-2.0 — the same attribution the vendored `lib/charting` carries.
 *
 * The card is a world clock, the same for every instrument: three cash sessions and
 * which of them is running right now. BTCUSDT.P and XAUUSDT.P both show Tokyo, London
 * and New York — a 24/7 asset is still "in" a session, and gold keeps trading through
 * Asia even though its home market is London. There is no "always open" row, because
 * the card answers "which session in time are we in?".
 *
 * The widget's animated world map is gone: the strip is the whole card.
 */

import {
  MARKET_SESSIONS,
  hourLabel,
  isSessionOpen,
  sessionDayRuns,
  sessionState,
  type SessionDef,
  type SessionState,
} from "@/lib/market-sessions";
import { useEffect, useRef, useState } from "react";

/** Roomier than the widget's own pitch: three rows with air between them read better
 * than a tight block, and nothing else on the card competes for the space. */
const TIMELINE_ROW_TOP = 8;
const TIMELINE_ROW_PITCH = 23;
/** Session pill height — taller than the rail it rides, so live windows read raised. */
const TIMELINE_ROW_HEIGHT = 8;
/** The rail every session rides: a quiet 4px hairline instead of a second full bar. */
const TIMELINE_TRACK_HEIGHT = 4;
/** Hour-label gutter under the rows. The chip on the axis sits on its baseline, so this
 * is what sets how far the time strip sits below the last session bar: rows end at
 * ROW_TOP + 2*PITCH + ROW_HEIGHT = 62, and the axis starts ~22px lower. */
const TIMELINE_AXIS_GUTTER = 40;
/** Row-label gutter — a colour pip plus the longest venue name ("New York") at 10px. */
const TIMELINE_LABEL_WIDTH = 72;

/** One timeline row per venue, plus the hour-label gutter under them. */
function timelineHeight(rows: number): number {
  return (
    TIMELINE_ROW_TOP + (rows - 1) * TIMELINE_ROW_PITCH + TIMELINE_ROW_HEIGHT + TIMELINE_AXIS_GUTTER
  );
}

/** The card's rows: the same three cash sessions for every instrument. */
const VENUES: readonly SessionDef[] = MARKET_SESSIONS;

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

type Ink = {
  light: boolean;
  /** Session rail behind the pills. */
  track: string;
  /** Name of the venue trading right now — the ink of the "Sessions" header above it. */
  label: string;
  /** Quiet venue names and axis ticks — the ink of the Technicals fold's row labels. */
  hour: string;
  now: string;
};

const DARK_INK: Ink = {
  light: false,
  track: "rgba(255,255,255,0.055)",
  label: "#d1d4dc",
  hour: "#787b86",
  now: "#ffffff",
};

const LIGHT_INK: Ink = {
  light: true,
  track: "rgba(17,19,24,0.07)",
  label: "#23262f",
  hour: "#8b8f9a",
  now: "#111318",
};

/** A `#rgb` / `#rrggbb` custom property, or null when it is absent or not a plain hex. */
function themeHex(styles: CSSStyleDeclaration, name: string): string | null {
  const raw = styles.getPropertyValue(name).trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw) ? raw : null;
}

/** Hex → `rgba()` with an explicit alpha (the canvas has no colour-alpha helper). */
function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Lift a session colour toward white for the pill's top highlight. */
function lift(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const up = (c: number) => Math.round(c + (255 - c) * amount);
  return `rgb(${up((n >> 16) & 255)}, ${up((n >> 8) & 255)}, ${up(n & 255)})`;
}

/** `roundRect` with a squared fallback; the radius never exceeds half the shorter side. */
function pill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, h / 2, w / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, Math.max(1, w), h, radius);
  else ctx.rect(x, y, Math.max(1, w), h);
}

/** Canvas letter-spacing is optional in the DOM lib; set it only where the engine has it. */
function tracking(ctx: CanvasRenderingContext2D, value: string): void {
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if ("letterSpacing" in c) c.letterSpacing = value;
}

/** Size a canvas for the device pixel ratio and hand back a CSS-pixel context. */
function fitCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
): [CanvasRenderingContext2D, number, number] {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(80, Math.round(cssWidth));
  const h = Math.max(20, Math.round(cssHeight));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx as CanvasRenderingContext2D, w, h];
}

/** The 24-hour strip: a quiet rail per session, filled windows as raised pills, and a
 *  hairline at "now" that fades into the axis. */
function drawTimeline(
  ctx: CanvasRenderingContext2D,
  w: number,
  at: number,
  ink: Ink,
  venues: readonly SessionDef[],
): void {
  const h = timelineHeight(venues.length);
  ctx.clearRect(0, 0, w, h);
  const x0 = TIMELINE_LABEL_WIDTH;
  const trackW = w - x0 - 2;
  const now = new Date(at);
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  const rowsBottom =
    TIMELINE_ROW_TOP + (venues.length - 1) * TIMELINE_ROW_PITCH + TIMELINE_ROW_HEIGHT;

  venues.forEach((session, i) => {
    const y = TIMELINE_ROW_TOP + i * TIMELINE_ROW_PITCH;
    const centre = y + TIMELINE_ROW_HEIGHT / 2;

    // Rail: a hairline the pills ride on, not a second full-height bar.
    ctx.fillStyle = ink.track;
    pill(ctx, x0, centre - TIMELINE_TRACK_HEIGHT / 2, trackW, TIMELINE_TRACK_HEIGHT, 2);
    ctx.fill();

    const open = isSessionOpen(session, at);
    // Colour pip + micro-caps name tie the row to its pill; quiet rows recede.
    ctx.globalAlpha = open ? 1 : 0.5;
    ctx.fillStyle = session.color;
    ctx.beginPath();
    ctx.arc(3, centre, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // 9px caps deliver far less ink than the 11–12px DOM labels beside them, which reads
    // as a fainter grey even at an identical colour — so the strip sets 10px bold.
    ctx.font = `600 10px ${FONT}`;
    tracking(ctx, "0.08em");
    ctx.textAlign = "left";
    // The live venue takes the header's ink; the rest sit on the muted ink the
    // Technicals rows use.
    ctx.fillStyle = open ? ink.label : ink.hour;
    ctx.fillText(session.name.toUpperCase(), 11, centre + 3);

    for (const [a, b] of sessionDayRuns(session, at)) {
      // A window that crosses UTC midnight wraps into a right-edge tail; the strip's
      // left edge IS 12am, so drop the tail and let the bar read continuously from the
      // left. A genuine full-day run (starts at 0, ends at 1440) is kept.
      if (b >= 1440 && a > 0) continue;
      const live = minuteOfDay >= a && minuteOfDay < b;
      const runX = x0 + (a / 1440) * trackW;
      const runW = ((b - a) / 1440) * trackW;
      // Vertical sheen: a lifted top edge reads as a rounded solid, not a flat block.
      const grad = ctx.createLinearGradient(0, y, 0, y + TIMELINE_ROW_HEIGHT);
      grad.addColorStop(0, lift(session.color, live ? 0.2 : 0.1));
      grad.addColorStop(1, session.color);
      ctx.fillStyle = grad;
      ctx.globalAlpha = live ? 1 : 0.45;
      if (live) {
        // A soft bloom under the running window — lit, never glued on.
        ctx.shadowColor = withAlpha(session.color, 0.5);
        ctx.shadowBlur = 7;
      }
      pill(ctx, runX, y, runW, TIMELINE_ROW_HEIGHT, TIMELINE_ROW_HEIGHT / 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";
      ctx.globalAlpha = 1;
    }
  });

  const x = x0 + (minuteOfDay / 1440) * trackW;
  const axisY = h - 7;

  // Axis ticks: the same muted ink and size as the quiet venue names. The now-line
  // below already marks the moment, so no time chip rides the axis — every hour tick
  // stays visible.
  ctx.font = `600 10px ${FONT}`;
  tracking(ctx, "0.04em");
  ctx.fillStyle = ink.hour;
  const ticks: Array<{ hour: number; align: CanvasTextAlign }> = [
    { hour: 0, align: "left" },
    { hour: 6, align: "center" },
    { hour: 12, align: "center" },
    { hour: 18, align: "center" },
    { hour: 24, align: "right" },
  ];
  for (const tick of ticks) {
    const tickX = x0 + (tick.hour / 24) * trackW;
    ctx.textAlign = tick.align;
    ctx.fillText(hourLabel(tick.hour), tickX, axisY);
  }
  tracking(ctx, "0px");

  // Now marker: a plain hairline that fades downward — no cap dot at the tip.
  const marker = ctx.createLinearGradient(0, 0, 0, rowsBottom + 4);
  marker.addColorStop(0, withAlpha(ink.now, 0.45));
  marker.addColorStop(1, withAlpha(ink.now, 0.1));
  ctx.strokeStyle = marker;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, 1.5);
  ctx.lineTo(x, rowsBottom + 2);
  ctx.stroke();
}

/** One unit only — `45m` / `12h` / `3d`, never `12h 55m`. */
function countdownText(minutes: number, label = "Opens"): string {
  let value: string;
  if (minutes < 60) value = `${minutes}m`;
  else if (minutes < 60 * 24) value = `${Math.floor(minutes / 60)}h`;
  else value = `${Math.floor(minutes / (60 * 24))}d`;
  return `${label} in ${value}`;
}

/** Ink follows the shell theme: the card's own background decides light or dark, and the
 *  app's text variables carry the same two weights the neighbouring DOM rows use. */
function inkFor(element: HTMLElement): Ink {
  const styles = getComputedStyle(element);
  const hex = styles.getPropertyValue("--app-elevated").trim();
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex) ?? /^#([0-9a-fA-F]{3})$/.exec(hex);
  const base = (() => {
    if (!m) return DARK_INK;
    const raw = m[1]!;
    const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance > 0.55 ? LIGHT_INK : DARK_INK;
  })();
  return {
    ...base,
    label: themeHex(styles, "--app-text") ?? base.label,
    hour: themeHex(styles, "--app-muted") ?? base.hour,
  };
}

export function MarketSessions({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLCanvasElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<SessionState>(() => sessionState(Date.now()));
  // Folded = only the Current/Next summary; the label line + 24-hour strip collapse.
  const [detailHeight, setDetailHeight] = useState<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const timelineCanvas = timelineRef.current;
    if (!host || !timelineCanvas) return;

    let ctx: CanvasRenderingContext2D | null = null;
    let timelineW = 0;
    let ink = inkFor(host);

    const paint = () => {
      if (ctx) drawTimeline(ctx, timelineW, Date.now(), ink, VENUES);
    };

    const resize = () => {
      const width = Math.max(120, Math.round(host.clientWidth - 24));
      [ctx, timelineW] = fitCanvas(timelineCanvas, width, timelineHeight(VENUES.length));
      paint();
    };

    resize();
    // The strip is static, so a once-a-second tick is all it needs: the text rows and
    // the "now" line both move on the minute. The canvas stays mounted while folded, so
    // the Current/Next countdowns keep ticking down even with the strip clipped away.
    const textTimer = window.setInterval(() => {
      setState(sessionState(Date.now()));
      ink = inkFor(host);
      paint();
    }, 1000);

    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => resize()) : null;
    observer?.observe(host);
    window.addEventListener("resize", resize);

    return () => {
      window.clearInterval(textTimer);
      window.removeEventListener("resize", resize);
      observer?.disconnect();
    };
  }, []);

  // Natural height of the collapsible detail (label + strip), so folding can animate it.
  // `detailRef` is the un-clipped content inside the animated window, so its offsetHeight
  // is the real target even while the window is at 0.
  useEffect(() => {
    const el = detailRef.current;
    if (!el) return;
    const measure = () => setDetailHeight(el.offsetHeight);
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  // No countdown means nothing is waiting to open: every session of the clock is live.
  const nextLabel = state.next ? `Next · ${state.next.session.name}` : "All sessions open";
  // The venue(s) trading right now; the "Closes in" value counts down to whichever shuts first.
  const currentNames = state.current.map((s) => s.name).join(" · ");

  return (
    <div className="px-3 pt-3">
      <div
        ref={hostRef}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        title={expanded ? "Collapse the session timeline" : "Show the session timeline"}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className="cursor-pointer rounded-[8px] border border-(--app-border) bg-(--app-elevated) px-3 py-2.5"
      >
        {/* Fixed header — stays put while the strip below it slides, so folding reads
            as a drawer opening under a label, exactly like the News card. */}
        <div className="flex items-center justify-between gap-2">
          <div className="text-[13px] font-semibold text-(--app-text)">Sessions</div>
          <span className="shrink-0 text-[13px] font-semibold text-(--app-text)">
            {state.badge}
          </span>
        </div>

        {/* Collapsible drawer window — the 24-hour strip. The un-clipped content keeps
            its natural height so the slide animates to a fixed pixel value, not `auto`. */}
        <div
          className="overflow-hidden transition-[height] duration-200 ease-out"
          style={{ height: expanded ? detailHeight ?? "auto" : 0 }}
        >
          <div ref={detailRef} className="pt-3">
            <canvas ref={timelineRef} className="block w-full" aria-hidden="true" />
          </div>
        </div>

        {/* Summary rows — always visible; this is the card's folded state. */}
        <div
          className={
            expanded
              ? "mt-3 space-y-1.5 border-t border-(--app-border) pt-2.5 text-[11px]"
              : "mt-4 space-y-1.5 text-[11px]"
          }
        >
          {currentNames ? (
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5 text-(--app-text)">
              {/* Each pip borrows its venue's own timeline colour, so the rows read as
                  "these sessions" rather than generic open/closed status dots. With an
                  overlap the first (earliest-opening) venue claims the current pip. */}
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: state.current[0]?.color ?? "var(--app-up)" }}
              />
              <span className="truncate">Current · {currentNames}</span>
              </span>
              <span className="shrink-0 tabular-nums text-(--app-muted)">
                {state.currentClosing ? countdownText(state.closesInMinutes, "Closes") : ""}
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-(--app-text)">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: state.next ? state.next.session.color : "var(--app-up)" }}
              />
              <span className="truncate">{nextLabel}</span>
            </span>
            <span className="shrink-0 tabular-nums text-(--app-muted)">
              {state.next ? countdownText(state.nextInMinutes) : ""}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
