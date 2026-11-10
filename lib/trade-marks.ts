import type { ChartPosition } from "@/types";

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export function liquidationPrice(pos: Pick<ChartPosition, "side" | "entry" | "leverage">) {
  const lev = Math.max(1, pos.leverage);
  const buffer = 0.9 / lev;
  return pos.side === "long" ? pos.entry * (1 - buffer) : pos.entry * (1 + buffer);
}

export function defaultProtect(entry: number, side: "long" | "short") {
  if (side === "long") {
    return { tp: entry * 1.012, sl: entry * 0.994 };
  }
  return { tp: entry * 0.988, sl: entry * 1.006 };
}

/**
 * Finds the open protective order (closePosition bracket) for one TP/SL leg.
 * The live order DTO collapses both bracket types to type "stop", so the leg
 * is matched by its stop price equaling the position's TP (or SL) value —
 * both figures come from the same server snapshot.
 */
/**
 * True when a TP/SL price sits on the correct side of the entry: a take profit
 * must be in profit (above a long / below a short), a stop loss in loss. A drag
 * that crosses the entry would silently invert the bracket, so callers reject it
 * instead of sending it to the broker.
 */
export function validExitPrice(
  side: "long" | "short",
  entry: number,
  leg: "tp" | "sl",
  price: number,
): boolean {
  if (!Number.isFinite(entry) || !Number.isFinite(price) || price <= 0) return false;
  const profit = side === "long" ? price > entry : price < entry;
  const loss = side === "long" ? price < entry : price > entry;
  return leg === "tp" ? profit : loss;
}

/** Fractions offered by the chart's close menu, in the order they are shown. */
export const CLOSE_FRACTIONS = [0.25, 0.5, 0.75] as const;

/** Fraction of a position a close action removes (clamped to (0, 1]). */
export function clampCloseFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(1, Math.max(0, fraction));
}

export function findProtectiveOrderId(
  orders: Array<{ id: string; symbol: string; closePosition: boolean; price: number }>,
  symbol: string,
  leg: "tp" | "sl",
  tp: number | null,
  sl: number | null,
): string | null {
  const target = leg === "tp" ? tp : sl;
  if (target == null || !Number.isFinite(target)) return null;
  const match = orders.find(
    (o) => o.symbol === symbol && o.closePosition && Number(o.price) === target,
  );
  return match?.id ?? null;
}
