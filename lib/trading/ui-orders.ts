import { dispatchSubmitOrder } from "@/lib/trading/dispatch";

/**
 * UI-originated order submission (live Testnet or Production, depending on
 * the connected broker).
 *
 * clientOrderId is MANDATORY for every UI submission: generate ONE UUID per
 * user submit action (newClientOrderId) and reuse that same id if the action
 * is retried, so replay protection can deduplicate it on the exchange side.
 */
export type UiOrderInput = {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop";
  price: number;
  qty: number;
  /** Mandatory idempotency key. */
  clientOrderId: string;
};

export function newClientOrderId(): string {
  return crypto.randomUUID();
}

export function submitOrderFromUi(input: UiOrderInput) {
  void dispatchSubmitOrder(input);
}
