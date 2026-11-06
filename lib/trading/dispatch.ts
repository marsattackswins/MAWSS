import { liveApi, LiveApiError, LiveAuthError } from "@/lib/live/api";
import { redirectToLogin } from "@/lib/live/bridge";
import { clampCloseFraction } from "@/lib/trade-marks";
import { useLiveStore } from "@/lib/live/store";
import { mawsFeed } from "@/lib/maws/feed";
import { useAppStore } from "@/lib/store";
import { resolveSymbolTrading } from "@/lib/trading/symbol-settings";
import type { UiOrderInput } from "./ui-orders";

/**
 * Broker dispatch boundary. All trading actions require an active, verified
 * Binance connection. When the app is disconnected, every action fails closed.
 */

export function isLiveBrokerConnected(): boolean {
  return useAppStore.getState().connectedBroker === "binance";
}

function notifyError(text: string): void {
  useLiveStore.getState().notify("error", text);
}

function describe(err: unknown): string {
  if (err instanceof LiveApiError) return err.message;
  if (err instanceof LiveAuthError) return "Session expired; sign in again";
  return String(err);
}

/**
 * Dispatch-level execution gate: mirrors the server's submission gates so a
 * halted/frozen/kill-switched system never reaches the broker from the UI.
 * Returns null when trading is allowed; returns the halt reason otherwise.
 */
export function tradingHaltReason(): string | null {
  const liveState = useLiveStore.getState();
  if (!isLiveBrokerConnected()) return "not_connected";
  if (liveState.phase === "switching") return "profile_switch_in_progress";
  if (liveState.phase === "degraded" || liveState.phase === "failed" || liveState.phase === "detached") {
    return liveState.reasonCode ?? "profile_runtime_unavailable";
  }
  if (liveState.profileId !== null && (!liveState.ready || liveState.phase !== "ready")) {
    return liveState.reasonCode ?? "profile_runtime_unavailable";
  }
  const { health } = liveState;
  if (!health) return null;
  const ex = health.execution;
  if (ex.killSwitch) return "kill switch engaged";
  if (ex.frozen) return ex.frozenReason || "execution frozen";
  if (!ex.canSubmit) return ex.reasons[0] || "execution not allowed";
  if (health.submissionsFrozen) return health.frozenReasons[0] || "submissions frozen";
  return null;
}

export async function dispatchSubmitOrder(input: UiOrderInput): Promise<{ ok: boolean; error?: string }> {
  if (!isLiveBrokerConnected()) {
    notifyError("Connect to a Binance profile to submit orders");
    return { ok: false, error: "not_connected" };
  }
  const state = useAppStore.getState();
  const pane = state.panes.find((p) => p.id === state.activePaneId);
  const tf = pane?.timeframe ?? "1D";
  const feedStatus = mawsFeed.getKlineStatus(input.symbol, tf);
  if (feedStatus !== "live") {
    notifyError(`Trading halted: market data ${feedStatus}`);
    return { ok: false, error: `feed_${feedStatus}` };
  }

  const halt = tradingHaltReason();
  if (halt !== null) {
    notifyError(`Trading halted: ${halt}`);
    return { ok: false, error: "trading_halted" };
  }

  try {
    const type = input.type === "limit" ? "LIMIT" : input.type === "stop" ? "STOP_MARKET" : "MARKET";
    const res = await liveApi.submitOrder({
      symbol: input.symbol,
      side: input.side === "buy" ? "BUY" : "SELL",
      type: type as "MARKET" | "LIMIT" | "STOP_MARKET",
      qty: String(input.qty),
      price: input.type === "limit" && input.price != null ? String(input.price) : undefined,
      stopPrice: input.type === "stop" && input.price != null ? String(input.price) : undefined,
      leverage: resolveSymbolTrading(input.symbol).leverage,
      clientOrderId: input.clientOrderId,
    });
    if (!res.ok) {
      notifyError(res.error ?? "Order rejected");
      return { ok: false, error: res.error };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof LiveAuthError) {
      redirectToLogin();
      return { ok: false, error: "unauthenticated" };
    }
    notifyError(describe(err));
    return { ok: false, error: describe(err) };
  }
}

export async function dispatchCancelOrder(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!isLiveBrokerConnected()) {
    notifyError("Connect to a Binance profile to cancel orders");
    return { ok: false, error: "not_connected" };
  }
  const halt = tradingHaltReason();
  if (halt !== null) {
    notifyError(`Trading halted: ${halt}`);
    return { ok: false, error: "trading_halted" };
  }
  const order = useLiveStore.getState().orders.find((o) => o.id === id);
  if (!order) return { ok: false, error: "Order not found" };
  try {
    const res = await liveApi.cancelOrder(id, order.symbol);
    if (!res.ok) {
      notifyError(res.error ?? "Cancel rejected");
      return { ok: false, error: res.error };
    }
    return { ok: true };
  } catch (err) {
    notifyError(describe(err));
    return { ok: false, error: describe(err) };
  }
}

export async function dispatchClosePosition(idOrSymbol: string): Promise<{ ok: boolean; error?: string }> {
  if (!isLiveBrokerConnected()) {
    notifyError("Connect to a Binance profile to close positions");
    return { ok: false, error: "not_connected" };
  }
  try {
    const res = await liveApi.closePosition(idOrSymbol);
    if (!res.ok) {
      notifyError(res.error ?? "Close rejected");
      return { ok: false, error: res.error };
    }
    return { ok: true };
  } catch (err) {
    notifyError(describe(err));
    return { ok: false, error: describe(err) };
  }
}

/**
 * Partial close is not available for live accounts.
 * The parameter is preserved so callers compile without changes.
 */
export async function dispatchClosePositionFraction(
  _idOrSymbol: string,
  _fraction: number,
): Promise<{ ok: boolean; error?: string }> {
  notifyError("Partial close is not available for live accounts");
  return { ok: false, error: "partial_close_unavailable" };
}

/**
 * Reverse: flatten through the guarded close path, then open the opposite side
 * at market with the same quantity.
 */
export async function dispatchReversePosition(input: {
  idOrSymbol: string;
  symbol: string;
  side: "long" | "short";
  qty: number;
}): Promise<{ ok: boolean; error?: string }> {
  const closed = await dispatchClosePosition(input.idOrSymbol);
  if (!closed.ok) return closed;
  return dispatchSubmitOrder({
    symbol: input.symbol,
    side: input.side === "long" ? "sell" : "buy",
    type: "market",
    price: 0,
    qty: Math.abs(input.qty),
    clientOrderId: crypto.randomUUID(),
  });
}

export async function dispatchProtect(
  symbol: string,
  tpPrice?: number | null,
  slPrice?: number | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!isLiveBrokerConnected()) {
    notifyError("Connect to a Binance profile to set TP/SL");
    return { ok: false, error: "not_connected" };
  }
  const halt = tradingHaltReason();
  if (halt !== null) {
    notifyError(`Trading halted: ${halt}`);
    return { ok: false, error: "trading_halted" };
  }
  try {
    const res = await liveApi.protect({
      symbol,
      tpPrice: tpPrice != null ? String(tpPrice) : undefined,
      slPrice: slPrice != null ? String(slPrice) : undefined,
    });
    const failed = (res.tp && !res.tp.ok) || (res.sl && !res.sl.ok);
    if (failed) {
      const msg = res.tp?.error ?? res.sl?.error ?? "Protective order rejected";
      notifyError(msg);
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (err) {
    notifyError(describe(err));
    return { ok: false, error: describe(err) };
  }
}

export async function dispatchRemoveProtection(symbol: string): Promise<{ ok: boolean; error?: string }> {
  if (!isLiveBrokerConnected()) {
    notifyError("Connect to a Binance profile to remove TP/SL");
    return { ok: false, error: "not_connected" };
  }
  try {
    const res = await liveApi.removeProtection(symbol);
    if (!res.ok) {
      notifyError(res.error ?? "Could not remove protective orders");
      return { ok: false, error: res.error };
    }
    return { ok: true };
  } catch (err) {
    notifyError(describe(err));
    return { ok: false, error: describe(err) };
  }
}

// Re-export clampCloseFraction for callers that import it transitively.
export { clampCloseFraction };
