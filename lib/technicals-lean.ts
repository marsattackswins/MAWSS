import type { GaugeLean } from "@/components/details/TechnicalsGauge";
import { computeRsi, computeStochastic } from "@/lib/indicators";
import { mawsFeed } from "@/lib/maws/feed";
import type { Candle, Timeframe } from "@/types";
import { useEffect, useState } from "react";

/**
 * Technicals-gauge data source — a three-indicator vote on the 5m series the
 * market feed already holds, exposed as the needle lean plus one fold-out row
 * per indicator. Each indicator votes by its oversold/overbought zone; a
 * unanimous 3–0 zone read is a Strong lean, a majority among cast votes a
 * regular lean. The planned HTF bias stays visual-only and never feeds this
 * (see TechnicalsGauge's lean rules).
 */
export const TECHNICALS_LEAN_TFS = ["5m"] as const satisfies readonly Timeframe[];

const FAST_STOCH = { length: 14, kSmoothing: 1, dSmoothing: 3 } as const;
const SLOW_STOCH = { length: 40, kSmoothing: 1, dSmoothing: 4 } as const;
const RSI_PERIOD = 14;
/** Zone thresholds: Stoch oversold/overbought, RSI oversold/overbought. */
const STOCH_OS = 20;
const STOCH_OB = 80;
const RSI_OS = 30;
const RSI_OB = 70;
/** History needed: slow raw %K seed (39) + %D smoothing (4) — round up. */
const MIN_BARS = 45;

/** Which side one fold-out row currently reads on. */
export type TechnicalsSide = "bullish" | "bearish" | "flat";

/** One fold-out row: the indicator's label, its current reading, and its side. */
export type TechnicalsRow = { label: string; value: string; side: TechnicalsSide };

/** Everything the gauge card shows: the needle lean plus the detail rows. */
export type TechnicalsReadout = { lean: GaugeLean; rows: TechnicalsRow[] };

const PLACEHOLDER_ROWS: TechnicalsRow[] = [
  { label: "Stoch 14", value: "—", side: "flat" },
  { label: "Stoch 40", value: "—", side: "flat" },
  { label: "RSI 14", value: "—", side: "flat" },
];

const fmt = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(1));

/**
 * Three-indicator readout for one 5m candle series: Stoch(14,1,3) %D,
 * Stoch(40,1,4) %D and RSI(14), each scored by its oversold/overbought zone
 * (Stoch ≤ 20 / ≥ 80, RSI ≤ 30 / ≥ 70). A unanimous 3–0 zone read is a Strong
 * lean, a majority among cast votes a regular lean; mid-range values cast no
 * vote. Insufficient history (< `MIN_BARS` bars) yields a neutral lean with
 * placeholder rows.
 */
export function stochTechnicalsReadout(candles: Candle[]): TechnicalsReadout {
  if (candles.length < MIN_BARS) return { lean: "neutral", rows: PLACEHOLDER_ROWS };
  const fastD = computeStochastic(
    candles,
    FAST_STOCH.length,
    FAST_STOCH.kSmoothing,
    FAST_STOCH.dSmoothing,
  ).d.at(-1)!;
  const slowD = computeStochastic(
    candles,
    SLOW_STOCH.length,
    SLOW_STOCH.kSmoothing,
    SLOW_STOCH.dSmoothing,
  ).d.at(-1)!;
  const rsi = computeRsi(candles, RSI_PERIOD).at(-1)!;

  let bullish = 0;
  let bearish = 0;
  const sideOf = (zone: "bullish" | "bearish" | "flat"): TechnicalsSide => {
    if (zone === "bullish") {
      bullish += 1;
      return "bullish";
    }
    if (zone === "bearish") {
      bearish += 1;
      return "bearish";
    }
    return "flat";
  };
  const stochZone = (v: number | null) =>
    v == null ? "flat" : v <= STOCH_OS ? "bullish" : v >= STOCH_OB ? "bearish" : "flat";
  const rsiZone = (v: number | null) =>
    v == null ? "flat" : v <= RSI_OS ? "bullish" : v >= RSI_OB ? "bearish" : "flat";
  const fastSide = sideOf(stochZone(fastD));
  const slowSide = sideOf(stochZone(slowD));
  const rsiSide = sideOf(rsiZone(rsi));

  const lean: GaugeLean =
    bullish === 3
      ? "strongLong"
      : bearish === 3
        ? "strongShort"
        : bullish > bearish
          ? "long"
          : bearish > bullish
            ? "short"
            : "neutral";

  return {
    lean,
    rows: [
      { label: "Stoch 14", value: fmt(fastD), side: fastSide },
      { label: "Stoch 40", value: fmt(slowD), side: slowSide },
      { label: "RSI 14", value: fmt(rsi), side: rsiSide },
    ],
  };
}

/**
 * Live technicals readout for one symbol for the symbol panel (needle lean +
 * fold-out rows). Subscribes the 5m series so fresh history and forming-bar tip
 * updates recompute it; state updates only when something shown changes.
 */
export function useTechnicalsReadout(symbol: string): TechnicalsReadout {
  const bare = symbol.replace(/\.P$/i, "").toUpperCase();
  const [readout, setReadout] = useState<TechnicalsReadout>({
    lean: "neutral",
    rows: PLACEHOLDER_ROWS,
  });

  useEffect(() => {
    if (!bare) {
      setReadout((prev) =>
        prev.lean === "neutral" && prev.rows.every((r) => r.value === "—")
          ? prev
          : { lean: "neutral", rows: PLACEHOLDER_ROWS },
      );
      return;
    }
    let raf = 0;
    const recalc = () => {
      const next = stochTechnicalsReadout(mawsFeed.getCandles(bare, "5m"));
      setReadout((prev) =>
        prev.lean === next.lean &&
        prev.rows.every((r, i) => r.value === next.rows[i].value && r.side === next.rows[i].side)
          ? prev
          : next,
      );
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        recalc();
      });
    };
    recalc();
    // Subscribing also makes the feed treat the symbol as chart-listened, so
    // `getCandles` starts the history fetch if nothing else warmed it yet.
    const unsubs = TECHNICALS_LEAN_TFS.map((tf) => mawsFeed.subscribe(bare, tf, schedule));
    return () => {
      unsubs.forEach((unsub) => unsub());
      if (raf) cancelAnimationFrame(raf);
    };
  }, [bare]);

  return readout;
}
