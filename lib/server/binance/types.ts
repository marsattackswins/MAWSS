import "server-only";

/** Raw Binance USD-M Futures payload types (subset MAWS relies on). */

export interface ExchangeFilter {
  filterType: string;
  tickSize?: string;
  minPrice?: string;
  maxPrice?: string;
  stepSize?: string;
  minQty?: string;
  maxQty?: string;
  notional?: string;
  minNotional?: string;
  limit?: number;
  maxNumOrders?: number;
  maxNumAlgoOrders?: number;
}

export interface ExchangeSymbolInfo {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  filters: ExchangeFilter[];
}

export interface ExchangeInfo {
  symbols: ExchangeSymbolInfo[];
}

export interface ServerTime {
  serverTime: number;
}

export interface PositionModeResponse {
  dualSidePosition: boolean;
}

export interface TickerPrice {
  symbol: string;
  price: string;
}

/** Premium-index row: mark price + time (used for live PnL refreshes). */
export interface MarkPriceResponse {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  time: number;
}

export interface AccountAsset {
  asset: string;
  walletBalance: string;
  unrealizedProfit: string;
  availableBalance: string;
  marginBalance: string;
}

export interface AccountResponse {
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  totalMaintMargin?: string;
  availableBalance: string;
  maxWithdrawAmount: string;
  assets: AccountAsset[];
}

export interface PositionRiskRow {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  positionSide: string;
  notional?: string;
  marginType?: string;
  isolatedMargin?: string;
  isolatedWallet?: string;
}

export interface BinanceOrder {
  orderId: number;
  clientOrderId: string;
  clientAlgoId?: string;
  algoId?: number;
  kind?: "order" | "algo";
  symbol: string;
  side: "BUY" | "SELL";
  type: string;
  status: string;
  price: string;
  stopPrice?: string;
  origQty: string;
  executedQty: string;
  cumQuote?: string;
  avgPrice?: string;
  reduceOnly?: boolean;
  closePosition?: boolean;
  updateTime: number;
  time: number;
}

export type BinanceAlgoOrderType = "STOP_MARKET" | "TAKE_PROFIT_MARKET";

export interface BinanceAlgoOrder {
  algoId: number;
  clientAlgoId: string;
  algoType: string;
  orderType: BinanceAlgoOrderType;
  symbol: string;
  side: "BUY" | "SELL";
  positionSide?: string;
  timeInForce?: string;
  quantity?: string;
  algoStatus: string;
  triggerPrice: string;
  price?: string;
  workingType?: string;
  closePosition?: boolean;
  priceProtect?: boolean;
  reduceOnly?: boolean;
  createTime: number;
  updateTime: number;
  triggerTime?: number;
  actualOrderId?: number | string | null;
  actualPrice?: string;
  actualType?: string;
  actualQty?: string;
}

export interface AlgoUpdateEvent {
  e: "ALGO_UPDATE";
  E?: number;
  T?: number;
  o: {
    caid?: string;
    aid?: number;
    at?: string;
    o?: string;
    s?: string;
    S?: "BUY" | "SELL";
    ps?: string;
    f?: string;
    q?: string;
    X?: string;
    ai?: number | string;
    rm?: string;
    tp?: string;
    cp?: boolean;
    [key: string]: unknown;
  };
}

type AlgoOrderBase = {
  algoType: "CONDITIONAL";
  symbol: string;
  side: "BUY" | "SELL";
  type: BinanceAlgoOrderType;
  triggerPrice: string;
  positionSide?: string;
  workingType?: "MARK_PRICE" | "CONTRACT_PRICE";
  priceProtect?: boolean;
  clientAlgoId?: string;
  newOrderRespType?: "ACK" | "RESULT";
};

export type PlaceAlgoOrderParams = AlgoOrderBase &
  (
    | { closePosition: true; quantity?: never; reduceOnly?: never }
    | { closePosition?: false; quantity: string; reduceOnly?: boolean }
  );

export interface AlgoOrderLookup {
  algoId?: number;
  clientAlgoId?: string;
}

/**
 * Cancellation acknowledgement from DELETE /fapi/v1/algoOrder (and
 * /algoOpenOrders). Unlike the query responses this carries no order state,
 * so callers must not treat it as an updated BinanceAlgoOrder.
 */
export interface AlgoCancelAck {
  algoId: number;
  clientAlgoId: string;
  code?: string | number;
  msg?: string;
}

export interface ListenKeyResponse {
  listenKey: string;
}

export interface LeverageBracketRow {
  symbol: string;
  brackets: Array<{
    bracket: number;
    initialLeverage: number;
    notionalCap: string;
    notionalFloor: string;
    maintMarginRatio: string;
  }>;
}

/** ORDER_TRADE_UPDATE event (redaction-safe subset). */
export interface OrderTradeUpdateEvent {
  e: "ORDER_TRADE_UPDATE";
  E: number;
  T: number;
  o: {
    s: string;
    c: string;
    S: "BUY" | "SELL";
    o: string;
    f: string;
    q: string;
    p: string;
    sp?: string;
    i: number;
    /** Binance execution/trade id. Older test fixtures may omit it. */
    t?: number;
    X: string;
    l: string;
    z: string;
    L: string;
    rp: string;
    /** Commission charged for this execution (positive magnitude). */
    n?: string;
    /** Asset the commission was charged in (e.g. USDT, BNB). */
    N?: string;
    T: number;
  };
}

/** ACCOUNT_UPDATE event (redaction-safe subset). */
export interface AccountUpdateEvent {
  e: "ACCOUNT_UPDATE";
  E: number;
  T: number;
  a: {
    B: Array<{ a: string; wb: string; cw: string; bc: string }>;
    P: Array<{
      s: string;
      pa: string;
      ep: string;
      cr: string;
      up: string;
      mt: string;
      iw: string;
      ps: string;
    }>;
  };
}

export type UserStreamEvent = OrderTradeUpdateEvent | AccountUpdateEvent | AlgoUpdateEvent | { e: string; E?: number };

export const TERMINAL_ORDER_STATUSES = new Set([
  "FILLED",
  "CANCELED",
  "EXPIRED",
  "REJECTED",
]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_ORDER_STATUSES.has(status);
}
