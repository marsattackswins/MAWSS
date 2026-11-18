"use client";

import { useEffect } from "react";
import { alertSymbolKey, findCrossings } from "@/lib/alerts/crossing";
import { fireAlert } from "@/lib/alerts/fire";
import { mawsFeed } from "@/lib/maws/feed";
import { useAppStore } from "@/lib/store";
import type { Quote } from "@/types";

function priceMap(quotes: Iterable<[string, Quote]>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [symbol, quote] of quotes) {
    if (Number.isFinite(quote.last)) out.set(alertSymbolKey(symbol), quote.last);
  }
  return out;
}

function seedPrices(quotes: readonly Quote[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const quote of quotes) {
    if (Number.isFinite(quote.last)) out.set(alertSymbolKey(quote.symbol), quote.last);
  }
  return out;
}

/**
 * useAlertWatcher — fires price alerts as quotes stream in, whether or not the
 * Alerts panel is open (that panel only ever *displayed* them).
 *
 * The first reading of a symbol arms its alerts rather than firing them: a level
 * the price is already past was not crossed while you were looking away.
 */
export function useAlertWatcher(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let prev = seedPrices(mawsFeed.getQuotes());
    return mawsFeed.subscribeQuotes((map) => {
      const next = priceMap(map);
      const alerts = useAppStore.getState().alerts;
      if (alerts.length > 0) {
        for (const crossing of findCrossings(alerts, prev, next, Date.now())) {
          fireAlert(crossing.alert, crossing.last, crossing.at);
        }
      }
      prev = next;
    });
  }, [enabled]);
}
