/**
 * FIFO round-trip trade statistics — vendored from LuxAlgo/broker-sdk
 * (https://github.com/LuxAlgo/broker-sdk, src/stats.ts), MIT licensed.
 *
 * Adapted locally: only `matchRoundTrips` and `computeTradeStats` are kept
 * (the performance-statistics core); the multi-broker `computeStats` wrapper
 * and `positionsFromTrades` are out of scope for MAWS. The upstream `Trade`
 * input type is re-declared here as `PerfTrade` instead of importing the SDK
 * schema; only the fields the engine actually reads survive. The matching
 * logic itself is upstream-verbatim.
 *
 * MIT License © LuxAlgo Global, LLC — the above copyright notice and this
 * permission notice shall be included in all copies or substantial portions
 * of the Software (see https://github.com/LuxAlgo/broker-sdk/blob/main/LICENSE).
 *
 * Everything here is pure and recomputable from a trade-history list — stats
 * are derived data, never a source of truth. Realized PnL matches sells
 * against buys FIFO per symbol; open remainders contribute position size
 * but no PnL.
 */

/** One executed trade (a fill), always from the account holder's side. */
export type PerfTrade = {
  symbol: string;
  side: "buy" | "sell";
  /** Always positive — `side` carries the direction. */
  quantity: number;
  /** Price per unit in the account's currency. */
  price: number;
  /** Commission/fee paid, when the source reports one (not part of the PnL math). */
  fee?: number;
  /** ISO 8601 timestamp used for FIFO ordering; unverifiable fills sort last. */
  executedAt?: string;
  /**
   * Which of two positions held at once on one symbol the fill belongs to
   * (hedge mode, e.g. Binance). Fills without it net per symbol, which
   * matches one-way mode.
   */
  positionSide?: "long" | "short";
};

export type PerfSymbolStats = {
  trades: number;
  /** Total traded notional (quantity × price across both sides). */
  notional: number;
  realizedPnl: number;
};

export type PerfTradeStats = {
  count: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  avgPositionSize: number | null;
  realizedPnl: number;
  bySymbol: Record<string, PerfSymbolStats>;
};

/** FIFO-match sells against prior buys; returns per-round-trip results. */
export const matchRoundTrips = (trades: PerfTrade[]): { pnl: number }[] => {
  const sorted = [...trades].sort((a, b) => (a.executedAt ?? "").localeCompare(b.executedAt ?? ""));
  const openLots = new Map<string, { quantity: number; price: number }[]>();
  const roundTrips: { pnl: number }[] = [];
  for (const trade of sorted) {
    // A hedge-mode side is its own position, so its lots never meet the other
    // side's; the short side opens on sells and closes on buys.
    // NUL-separated map key (see upstream): no symbol name can collide with symbol+side.
    const key = trade.positionSide ? `${trade.symbol}\u0000${trade.positionSide}` : trade.symbol;
    const short = trade.positionSide === "short";
    if ((trade.side === "buy") !== short) {
      const lots = openLots.get(key) ?? [];
      lots.push({ quantity: trade.quantity, price: trade.price });
      openLots.set(key, lots);
      continue;
    }
    let remaining = trade.quantity;
    const lots = openLots.get(key) ?? [];
    while (remaining > 1e-9 && lots.length > 0) {
      const lot = lots[0];
      if (!lot) break;
      const matched = Math.min(remaining, lot.quantity);
      roundTrips.push({ pnl: (short ? lot.price - trade.price : trade.price - lot.price) * matched });
      lot.quantity -= matched;
      remaining -= matched;
      if (lot.quantity <= 1e-9) lots.shift();
    }
    // A sell with no matching buy (history starts mid-position) is ignored
    // for PnL rather than guessed at.
  }
  return roundTrips;
};

export const computeTradeStats = (trades: PerfTrade[]): PerfTradeStats | null => {
  if (trades.length === 0) return null;
  const bySymbol: Record<string, PerfSymbolStats> = {};
  let totalNotional = 0;
  for (const trade of trades) {
    const notional = trade.quantity * trade.price;
    totalNotional += notional;
    const entry = (bySymbol[trade.symbol] ??= { trades: 0, notional: 0, realizedPnl: 0 });
    entry.trades += 1;
    entry.notional += notional;
  }
  // Per-symbol realized PnL, then roll the round-trips up for win/loss stats.
  const allRoundTrips: { pnl: number }[] = [];
  for (const symbol of Object.keys(bySymbol)) {
    const symbolTrips = matchRoundTrips(trades.filter((trade) => trade.symbol === symbol));
    const stats = bySymbol[symbol];
    if (stats) stats.realizedPnl = symbolTrips.reduce((sum, trip) => sum + trip.pnl, 0);
    allRoundTrips.push(...symbolTrips);
  }
  const wins = allRoundTrips.filter((trip) => trip.pnl > 0);
  const losses = allRoundTrips.filter((trip) => trip.pnl < 0);
  const closedTrades = allRoundTrips.length;
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  return {
    count: trades.length,
    closedTrades,
    wins: wins.length,
    losses: losses.length,
    winRate: closedTrades > 0 ? wins.length / closedTrades : null,
    avgWin: wins.length > 0 ? sum(wins.map((trip) => trip.pnl)) / wins.length : null,
    avgLoss: losses.length > 0 ? sum(losses.map((trip) => trip.pnl)) / losses.length : null,
    avgPositionSize: trades.length > 0 ? totalNotional / trades.length : null,
    realizedPnl: sum(allRoundTrips.map((trip) => trip.pnl)),
    bySymbol,
  };
};
