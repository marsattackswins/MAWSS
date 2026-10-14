/**
 * vela-marks.ts — Vela timeline marks bridge.
 *
 * MAWS alerts/orders/positions are data, not user state — they flow through the
 * store, so they map to Vela's `chart.marks` timeline-lane model via `set()`.
 * Signals (order fills, TP/SL hits) ride the same lane as grouped marks.
 */
import type { MarksControl, TimelineMark, MarkGroup } from "@/lib/charting";
import type { ChartPaneState } from "@/types";

export type VelaMarksInput = {
  pane: ChartPaneState;
  alerts: Array<{ id: string; symbol: string; price: number; side: "above" | "below"; enabled: boolean }>;
  orders: Array<{ id: string; symbol: string; price: number; side: "buy" | "sell"; type: string; qty: number }>;
  positions: Array<{
    id: string;
    symbol: string;
    entry: number;
    side: "long" | "short";
    qty: number;
    tp?: number | null;
    sl?: number | null;
  }>;
  fills: Array<{ id: string; symbol: string; time: number; price: number; side: "buy" | "sell" }>;
};

export const MARK_GROUPS: MarkGroup[] = [
  { id: "alerts", label: "Alerts" },
  { id: "orders", label: "Orders" },
  { id: "positions", label: "Positions" },
  { id: "fills", label: "Fills" },
];

/** Define the visibility groups once per chart. */
export function defineVelaMarkGroups(ctrl: MarksControl): void {
  for (const g of MARK_GROUPS) ctrl.defineGroup(g);
}

/** Push MAWS trade state into the Vela marks lane. */
export function syncVelaMarks(ctrl: MarksControl, input: VelaMarksInput): void {
  const symbol = input.pane.symbol;
  const items: TimelineMark[] = [];

  for (const a of input.alerts) {
    if (a.symbol !== symbol || !a.enabled) continue;
    items.push({
      id: `alert-${a.id}`,
      time: Date.now(),
      group: "alerts",
      glyph: { shape: "diamond", color: "#f59e0b", letter: a.side === "above" ? "↑" : "↓" },
      title: "Alert",
      tooltip: `${a.side === "above" ? "≥" : "≤"} ${a.price}`,
      content: { panel: { items: [{ type: "field", label: "Alert", value: `${a.side === "above" ? "≥" : "≤"} ${a.price}` }] } },
    });
  }

  for (const o of input.orders) {
    if (o.symbol !== symbol) continue;
    const buy = o.side === "buy";
    items.push({
      id: `order-${o.id}`,
      time: Date.now(),
      group: "orders",
      glyph: { shape: "circle", color: buy ? "#089981" : "#f23645", letter: buy ? "B" : "S" },
      title: o.type,
      tooltip: `${buy ? "Buy" : "Sell"} ${o.qty} @ ${o.price}`,
      content: { panel: { items: [{ type: "field", label: o.type, value: `${buy ? "Buy" : "Sell"} ${o.qty} @ ${o.price}` }] } },
    });
  }

  for (const p of input.positions) {
    if (p.symbol !== symbol) continue;
    const long = p.side === "long";
    const fields: Array<{ type: "field"; label: string; value: string }> = [
      { type: "field", label: long ? "Long" : "Short", value: `${p.qty} @ ${p.entry}` },
    ];
    if (p.tp != null) fields.push({ type: "field", label: "TP", value: String(p.tp) });
    if (p.sl != null) fields.push({ type: "field", label: "SL", value: String(p.sl) });
    items.push({
      id: `pos-${p.id}`,
      time: Date.now(),
      group: "positions",
      glyph: { shape: "pin", color: long ? "#089981" : "#f23645", letter: long ? "L" : "S" },
      title: "Position",
      tooltip: `${long ? "Long" : "Short"} ${p.qty} @ ${p.entry}`,
      content: { panel: { items: fields } },
    });
  }

  for (const f of input.fills) {
    if (f.symbol !== symbol) continue;
    const buy = f.side === "buy";
    items.push({
      id: `fill-${f.id}`,
      time: f.time * 1000,
      group: "fills",
      glyph: { shape: "circle", color: buy ? "#089981" : "#f23645", letter: buy ? "B" : "S" },
      title: "Fill",
      tooltip: `${buy ? "Bought" : "Sold"} @ ${f.price}`,
      content: { panel: { items: [{ type: "field", label: "Fill", value: `${buy ? "Bought" : "Sold"} @ ${f.price}` }] } },
    });
  }

  ctrl.set(items);
}
