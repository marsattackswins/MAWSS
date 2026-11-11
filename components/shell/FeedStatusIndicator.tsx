"use client";

/**
 * FeedStatusIndicator.tsx — market-feed health dot.
 *
 * A small dot, coloured by the SAME `mawsFeed.getKlineStatus` value that
 * `lib/trading/dispatch.ts` gates order submission on, so what the user sees and
 * what blocks the order can never disagree. It leads the ticker in the top-left
 * symbol block, beside the series it describes.
 *
 * Colours come from the app theme's own tokens (`--app-up` / `--app-down` /
 * `--app-muted`), which `applyAppTheme` rewrites whenever the theme changes, so
 * the dot follows Vela Muted / Classic / Light / Gruvbox instead of hardcoding
 * the muted palette. `--app-warn` is not a universal token; it falls back to the
 * TradingView warning orange so the default theme is unchanged.
 *
 * The markup (span[role="status"] + "Market feed status: <state>" aria-label +
 * background color) is the one the e2e suite has asserted since the ChartCanvas
 * legend days.
 */

import { useEffect, useState } from "react";
import { mawsFeed } from "@/lib/maws/feed";
import { useActivePane } from "@/lib/store";
import type { Timeframe } from "@/types";

const COLORS = {
  connecting: "var(--app-muted, #787b86)",
  live: "var(--app-up, #089981)",
  delayed: "var(--app-down, #f23645)",
  reconnecting: "var(--app-warn, #ff9800)",
} as const;

type FeedHealth = { label: string; color: string };

function readFeedHealth(symbol: string, timeframe: Timeframe): FeedHealth {
  // Recovery outranks the stale snapshot: the socket is already being replaced.
  if (mawsFeed.isKlineRecovering(symbol, timeframe)) {
    return { label: "Reconnecting", color: COLORS.reconnecting };
  }
  const status = mawsFeed.getKlineStatus(symbol, timeframe);
  if (status === "live") return { label: "Live", color: COLORS.live };
  if (status === "delayed") return { label: "Data delayed", color: COLORS.delayed };
  // "idle" and "connecting" both read as Connecting: the dot is shown before
  // the first frame, and color is never the only signal.
  return { label: "Connecting", color: COLORS.connecting };
}

export function FeedStatusIndicator() {
  const pane = useActivePane();
  const [health, setHealth] = useState<FeedHealth>(() =>
    readFeedHealth(pane.symbol, pane.timeframe),
  );

  useEffect(() => {
    const read = () => setHealth(readFeedHealth(pane.symbol, pane.timeframe));
    read();
    // Feed freshness is polled internally (no event), so sample it once a second
    // like the topbar's own live/disabled state does.
    const id = window.setInterval(read, 1_000);
    return () => window.clearInterval(id);
  }, [pane.symbol, pane.timeframe]);

  return (
    <span
      role="status"
      aria-label={`Market feed status: ${health.label}`}
      title={`Market feed status: ${health.label}`}
      data-testid="feed-status"
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: health.color,
        flexShrink: 0,
        boxShadow: "0 0 0 1px rgba(0,0,0,0.2)",
      }}
    />
  );
}
