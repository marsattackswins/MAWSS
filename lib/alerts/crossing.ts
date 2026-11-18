import type { PriceAlert } from "@/types";

/** A price alert whose level a fresh quote just crossed. */
export type AlertCrossing = {
  alert: PriceAlert;
  /** Quote price at the moment of the crossing. */
  last: number;
  at: number;
};

/** Quotes and the store spell the same symbol differently (`.P` suffix, case). */
export function alertSymbolKey(raw: string): string {
  return raw.replace(/\.P$/i, "").toUpperCase();
}

/** True when the price moved ACROSS the level in the alert's direction.
 *  Touching the level counts; a level the price is already past does not — that
 *  is a state, not an event. */
export function isCrossing(
  alert: Pick<PriceAlert, "price" | "side" | "enabled">,
  prev: number,
  next: number,
): boolean {
  if (alert.enabled === false) return false;
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return false;
  if (!Number.isFinite(alert.price)) return false;
  return alert.side === "above"
    ? prev < alert.price && next >= alert.price
    : prev > alert.price && next <= alert.price;
}

/** Every enabled alert crossed between two quote batches.
 *
 *  `prev` holds the last price seen per symbol. A symbol missing from it has no
 *  previous reading yet, so it can only arm its alerts this round — firing there
 *  would report a crossing that may have happened hours before you looked. */
export function findCrossings(
  alerts: readonly PriceAlert[],
  prev: ReadonlyMap<string, number>,
  next: ReadonlyMap<string, number>,
  at: number,
): AlertCrossing[] {
  const out: AlertCrossing[] = [];
  for (const alert of alerts) {
    if (!alert.enabled) continue;
    const key = alertSymbolKey(alert.symbol);
    const before = prev.get(key);
    const now = next.get(key);
    if (before == null || now == null) continue;
    if (isCrossing(alert, before, now)) out.push({ alert, last: now, at });
  }
  return out;
}
