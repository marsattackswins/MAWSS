"use client";

import { AssetLogo } from "@/components/brand/AssetLogo";
import { TechnicalsGauge, TechnicalsMeter, TechnicalsRows } from "@/components/details/TechnicalsGauge";
import { MarketSessions } from "@/components/maws/MarketSessions";
import { formatPrice } from "@/lib/maws/feed";
import { formatTicker, getSymbol } from "@/lib/maws/universe";
import { fetchNews, formatNewsAge, type NewsItem } from "@/lib/news";
import { openSessions, sessionState } from "@/lib/market-sessions";
import { useTechnicalsReadout } from "@/lib/technicals-lean";
import { useAppStore } from "@/lib/store";
import { useQuote } from "@/lib/use-quotes";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The card's dock control, drawn as a state arrow: `ChevronDown` folds the
 * pane into the compact strip pinned under the watchlist, `ChevronUp` expands
 * the full details back above it.
 */
function DockToggle({ compact, className = "" }: { compact: boolean; className?: string }) {
  const setSymbolPanelDocked = useAppStore((s) => s.setSymbolPanelDocked);
  return (
    <button
      type="button"
      aria-pressed={compact}
      title={compact ? "Show full details" : "Dock compact under the watchlist"}
      aria-label={compact ? "Show full details" : "Dock compact under the watchlist"}
      onClick={(e) => { e.stopPropagation(); setSymbolPanelDocked(!compact); }}
      className={`flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[4px] text-(--app-muted) ${className}`}
    >
      {compact ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
    </button>
  );
}

/** Active-symbol name, price, market state, and news for the watchlist dock.
 *  `symbolPanelDocked` folds the card into the compact strip docked at the
 *  bottom of the sidebar — ticker, live price, and session state only. */
export function StrategySymbolPanel({ symbol }: { symbol: string }) {
  const compact = useAppStore((s) => s.symbolPanelDocked);
  const setSymbolPanelDocked = useAppStore((s) => s.setSymbolPanelDocked);
  const quote = useQuote(symbol);
  const info = getSymbol(symbol);
  const newsOpen = useAppStore((s) => s.symbolPanelNewsOpen);
  const sessionsOpen = useAppStore((s) => s.symbolPanelSessionsOpen);
  const technicalsOpen = useAppStore((s) => s.symbolPanelTechnicalsOpen);
  const toggleBlock = useAppStore((s) => s.toggleSymbolPanelBlock);
  const setBlock = useAppStore((s) => s.setSymbolPanelBlock);
  const technicalsReadout = useTechnicalsReadout(symbol);

  // A symbol switch folds the news drawer back to its headline preview.
  useEffect(() => {
    setBlock("news", false);
  }, [symbol, setBlock]);

  if (compact) {
    return <CompactSymbolPanel symbol={symbol} />;
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col border-t border-(--app-border) bg-(--app-panel)"
    >
      {/* Header stays outside the scroll box: the logo and dock chevron keep
          their exact positions relative to the rail whether the card is
          docked or expanded — no scrollbar reservation shifts them in and
          out of alignment. Clicking anywhere in the header row collapses the panel. */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Dock compact under the watchlist"
        onClick={() => setSymbolPanelDocked(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setSymbolPanelDocked(true);
          }
        }}
        className="flex w-full cursor-pointer items-center gap-2 px-3 pt-2"
      >
        <AssetLogo symbol={symbol} size={24} />
        <span className="truncate text-[13px] font-semibold text-(--app-text)">
          {formatTicker(symbol)}
        </span>
        <div className="flex-1" />
        <DockToggle compact={false} />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="px-3 pt-2 text-[11px] leading-4 text-(--app-muted)">
          {info.name} / TetherUS PERPETUAL CONTRACT
          <span className="ml-2">BINANCE</span>
          <span className="ml-2">Swap • Crypto</span>
        </div>

        <div className="px-3 pt-3">
          <PriceFigure symbol={symbol} quote={quote} up={(quote?.changePct ?? 0) >= 0} />
        </div>

        <NewsBlock symbol={symbol} expanded={newsOpen} onToggle={() => toggleBlock("news")} />

        {/* Trade-session clock — the same card Vela's own client shows under its
            watchlist, above the symbol's own dial. */}
        <MarketSessions expanded={sessionsOpen} onToggle={() => toggleBlock("sessions")} />

        {/* Stochastic-confluence lean gauge — 5m dual-Stoch %D cross + StochRSI via useTechnicalsReadout. */}
        <TechnicalsGauge
          lean={technicalsReadout.lean}
          expanded={technicalsOpen}
          onToggle={() => toggleBlock("technicals")}
        >
          <TechnicalsRows rows={technicalsReadout.rows} />
        </TechnicalsGauge>
      </div>
    </div>
  );
}

/** Live price line shared by both layouts (28px figure under the sidebar header). */
function PriceFigure({
  symbol,
  quote,
  up,
}: {
  symbol: string;
  quote: ReturnType<typeof useQuote>;
  up: boolean;
}) {
  return (
    <div>
      <div className="text-[28px] leading-none font-semibold tracking-tight text-(--app-text)">
        {quote ? formatPrice(symbol, quote.last) : "—"}
        <span className="ml-1 text-[13px] font-normal text-(--app-muted)">
          {getSymbol(symbol).quote}
        </span>
      </div>
      <div className="mt-2 text-[13px]" style={{ color: up ? "var(--app-up)" : "var(--app-down)" }}>
        {quote
          ? `${up ? "+" : ""}${formatPrice(symbol, quote.change)}  ${up ? "+" : ""}${quote.changePct.toFixed(2)}%`
          : "—"}
      </div>
    </div>
  );
}

/** A clickable region of the dock. Each readout is its own button so a click can
 *  undock and open the block it stands for; keyboard parity with the card drawers. */
function DockButton({
  onClick,
  title,
  className = "",
  children,
}: {
  onClick: () => void;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      title={title}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={`cursor-pointer ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * The compact dock: a flat strip pinned at the bottom of the sidebar while
 * the full card is folded. Three divider-separated segments, each its own undock
 * control — ticker + live price (undock, keep block states), the technicals meter
 * (undock + open Technicals), and the cash sessions (undock + open Sessions). The
 * session segment truncates away first on narrow widths.
 */
function CompactSymbolPanel({ symbol }: { symbol: string }) {
  const quote = useQuote(symbol);
  const lean = useTechnicalsReadout(symbol).lean;
  const dayUp = (quote?.changePct ?? 0) >= 0;
  const undock = useAppStore((s) => s.undockSymbolPanel);
  const focusBlock = useAppStore((s) => s.focusSymbolPanelBlock);

  // Tick-following color: each new print recolors the price to the direction
  // of that tick (TradingView style), replacing the static day-change color as
  // soon as the first tick delta is seen. Symbol switches reset the baseline.
  const lastPriceRef = useRef<number | null>(null);
  const lastSymbolRef = useRef(symbol);
  const [tickUp, setTickUp] = useState<boolean | null>(null);
  const last = quote?.last ?? null;
  useEffect(() => {
    if (lastSymbolRef.current !== symbol) {
      lastSymbolRef.current = symbol;
      lastPriceRef.current = null;
      setTickUp(null);
    }
    const prev = lastPriceRef.current;
    lastPriceRef.current = last;
    if (prev === null || last === null || prev === last) return;
    setTickUp(last > prev);
  }, [last, symbol]);

  const up = tickUp ?? dayUp;

  return (
    <div
      data-symbol-panel-dock
      className="flex h-9 w-full shrink-0 items-stretch overflow-hidden border-t border-(--app-border) bg-(--app-panel)"
    >
      {/* Three equal flex-1 blocks, each centring its readout. justify-center makes the
          gap from the content to its outer edge (dock edge or separator) equal to the gap
          on the other side, so price, meter and sessions each sit dead-centre in their
          block at every width. */}
      <DockButton
        onClick={undock}
        title={`${formatTicker(symbol)} — open the symbol panel`}
        className="flex min-w-0 flex-1 items-center justify-center px-2"
      >
        <span
          className="shrink-0 whitespace-nowrap text-[13px] font-semibold leading-none tabular-nums"
          style={{ color: up ? "var(--app-up)" : "var(--app-down)" }}
        >
          {quote ? formatPrice(symbol, quote.last) : "—"}
        </span>
      </DockButton>

      <Divider />

      <DockButton
        onClick={() => focusBlock("technicals")}
        title="Open technicals"
        className="flex min-w-0 flex-1 items-center justify-center px-2"
      >
        <TechnicalsMeter lean={lean} />
      </DockButton>

      <Divider />

      <DockButton
        onClick={() => focusBlock("sessions")}
        title="Open sessions"
        className="flex min-w-0 flex-1 items-center justify-center px-2"
      >
        <MarketStateLine />
      </DockButton>
    </div>
  );
}

/** A short hairline tick separating two dock segments, vertically centred rather than
 *  full-height so it reads as a light divider, not a rule. A translucent neutral grey
 *  (not `--app-border`, which is near-invisible against the elevated card in the muted
 *  theme) so it reads on both dark and light themes. 2px wide, not 1px: the meter is
 *  centred, so this line lands on a fractional x that sweeps through .5 as the rail
 *  resizes — a 1px box there splits across two device pixels at ~50% and blurs to
 *  nothing on the muted theme. 2px always covers ≥1 full device pixel, so the separator
 *  can never vanish mid-resize. */
function Divider() {
  return <span className="h-4 w-[2px] shrink-0 self-center rounded-full bg-(--app-border)" />;
}

/** The cash-session readout for the docked card: each trading venue as its own colour
 *  pip + name, or — when the clock is quiet — the next venue's pip and a countdown. One
 *  30s tick serves names and count; the render reads the tick, never the wall clock. */
function MarketStateLine() {
  const [at, setAt] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setAt(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const state = sessionState(at);
  const open = openSessions(at);
  const next = state.next;
  return (
    <span className="flex min-w-0 shrink items-center gap-2">
      {open.length > 0
        ? open.map((s) => (
            <SessionPip key={s.name} color={s.color} label={s.name} />
          ))
        : next
          ? <SessionPip color={next.session.color} label={`${next.session.name} opens in ${countdownLabel(state.nextInMinutes)}`} muted />
          : null}
    </span>
  );
}

/** One venue in the dock: a colour pip matching its timeline bar, then its name. */
function SessionPip({
  color,
  label,
  muted = false,
}: {
  color: string;
  label: string;
  muted?: boolean;
}) {
  return (
    <span className="flex min-w-0 shrink items-center gap-2">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span
        className={`truncate text-[12px] leading-none ${muted ? "text-(--app-muted)" : "text-(--app-text)"}`}
      >
        {label}
      </span>
    </span>
  );
}

/** Single-unit countdown — "45m" / "2h" / "1d", never a mixed "2h 10m". */
function countdownLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (24 * 60))}d`;
}

/** Collapsed drawer window: two full headline lines; the rest folds out. */
const NEWS_COLLAPSED_HEIGHT = 36;

/** Newest-headline card — clicking the card slides it open like a drawer to
    the full headline (click again to slide it back); the top-right icon opens
    the source article in a browser tab. Disappears when the latest-news
    toggle is off. */
function NewsBlock({
  symbol,
  expanded,
  onToggle,
}: {
  symbol: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const latestNews = useAppStore((s) => s.chartSettings.latestNews);
  const [headline, setHeadline] = useState<NewsItem | null>(null);

  useEffect(() => {
    if (!latestNews) {
      setHeadline(null);
      return;
    }
    let cancelled = false;
    void fetchNews({ symbol }).then((result) => {
      if (cancelled) return;
      setHeadline(result.items[0] ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [symbol, latestNews]);

  /* Full height of the headline text, so the drawer knows where to slide to.
     The paragraph lives inside a height-clipped window, so its own box is the
     *window* height; the wrapper's scrollHeight is the real text height. A
     MutationObserver catches headline swaps (a shorter text in an open drawer
     does not resize the wrapper, so ResizeObserver alone would miss it). */
  const headlineRef = useRef<HTMLParagraphElement | null>(null);
  const [fullHeight, setFullHeight] = useState(NEWS_COLLAPSED_HEIGHT);
  useEffect(() => {
    const el = headlineRef.current;
    const wrap = el?.parentElement;
    if (!el || !wrap) return;
    const measure = () => setFullHeight(Math.max(NEWS_COLLAPSED_HEIGHT, wrap.scrollHeight));
    measure();
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(wrap);
    const mutations =
      typeof MutationObserver !== "undefined" ? new MutationObserver(measure) : null;
    mutations?.observe(el, { childList: true, characterData: true, subtree: true });
    return () => {
      observer?.disconnect();
      mutations?.disconnect();
    };
  }, [headline?.headline]);

  if (!latestNews) return null;

  /* Drawer slide: the headline keeps its full layout and the visible window
     animates between one-and-a-half lines and the whole text, so the card
     grows and shrinks smoothly instead of snapping. */
  return (
    <div className="px-3 py-3">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        title={expanded ? "Collapse the headline" : "Show the full headline"}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className="w-full cursor-pointer rounded-[8px] border border-(--app-border) bg-(--app-elevated) px-3 py-2 text-left"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-(--app-text)">
            <span className="min-w-0 truncate">News</span>
            {headline?.url ? (
              <a
                href={headline.url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open the news source in the browser"
                onClick={(e) => e.stopPropagation()}
                className="shrink-0 rounded p-1 text-(--app-muted) transition-colors hover:bg-(--app-hover) hover:text-(--app-text)"
              >
                <ExternalLink size={13} />
              </a>
            ) : null}
          </span>
          {headline ? (
            <span className="shrink-0 text-[13px] font-semibold text-(--app-text)">
              {formatNewsAge(headline.at)}
            </span>
          ) : null}
        </div>
        <div
          className="mt-3 overflow-hidden transition-[height] duration-200 ease-out"
          style={{ height: expanded ? fullHeight : NEWS_COLLAPSED_HEIGHT }}
        >
          <p
            ref={headlineRef}
            className="text-[13px] leading-[18px] text-(--app-text)"
          >
            {headline?.headline ?? "No Finnhub headlines yet — open News for the full feed."}
          </p>
        </div>
      </div>
    </div>
  );
}
