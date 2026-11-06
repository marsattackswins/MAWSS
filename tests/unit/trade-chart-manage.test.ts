/**
 * On-chart trade management (TradeManager + trade-marks guards).
 *
 * Covers the parts that can be asserted without a browser:
 *   - TP/SL drag validation (a bracket may never cross its entry),
 *   - close-fraction clamping,
 *   - partial close being refused for live accounts,
 *   - reverse = guarded close, then market order on the opposite side.
 *
 * The confirm dialog and the DOM overlay are exercised in the browser check;
 * the actions below are the exact functions those buttons call.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  CLOSE_FRACTIONS,
  clampCloseFraction,
  validExitPrice,
} from "@/lib/trade-marks";
import {
  dispatchClosePositionFraction,
  dispatchReversePosition,
} from "@/lib/trading/dispatch";
import { useAppStore } from "@/lib/store";
import { liveApi } from "@/lib/live/api";
import { DEFAULT_CHART_SETTINGS } from "@/types";

jest.mock("@/lib/trading/sounds", () => ({ playExecutionSound: jest.fn() }));
jest.mock("@/lib/maws/feed", () => ({
  mawsFeed: {
    getQuote: () => ({ symbol: "BTCUSDT", last: 100, bid: 100, ask: 100, time: 0 }),
    getKlineStatus: () => "live",
  },
}));

beforeEach(() => {
  useAppStore.setState({
    connectedBroker: null,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("validExitPrice", () => {
  test("a long's take profit is above the entry and its stop below", () => {
    expect(validExitPrice("long", 100, "tp", 101)).toBe(true);
    expect(validExitPrice("long", 100, "tp", 99)).toBe(false);
    expect(validExitPrice("long", 100, "sl", 99)).toBe(true);
    expect(validExitPrice("long", 100, "sl", 101)).toBe(false);
  });

  test("a short mirrors the rule", () => {
    expect(validExitPrice("short", 100, "tp", 99)).toBe(true);
    expect(validExitPrice("short", 100, "tp", 101)).toBe(false);
    expect(validExitPrice("short", 100, "sl", 101)).toBe(true);
    expect(validExitPrice("short", 100, "sl", 99)).toBe(false);
  });

  test("an exit exactly on the entry, or a non-price, is refused", () => {
    expect(validExitPrice("long", 100, "tp", 100)).toBe(false);
    expect(validExitPrice("short", 100, "sl", 100)).toBe(false);
    expect(validExitPrice("long", 100, "tp", Number.NaN)).toBe(false);
    expect(validExitPrice("long", 100, "sl", 0)).toBe(false);
  });
});

describe("trade pill side setting", () => {
  test("defaults to the left and is persisted by a patch", () => {
    expect(DEFAULT_CHART_SETTINGS.tradePillSide).toBe("left");
    useAppStore.getState().patchChartSettings({ tradePillSide: "right" });
    expect(useAppStore.getState().chartSettings.tradePillSide).toBe("right");
  });
});

describe("clampCloseFraction", () => {
  test("keeps in-range fractions and clamps the rest", () => {
    expect(CLOSE_FRACTIONS).toEqual([0.25, 0.5, 0.75]);
    expect(clampCloseFraction(0.25)).toBe(0.25);
    expect(clampCloseFraction(2)).toBe(1);
    expect(clampCloseFraction(-1)).toBe(0);
    expect(clampCloseFraction(Number.NaN)).toBe(0);
  });
});

describe("dispatchClosePositionFraction", () => {
  test("partial close is not available for live accounts", async () => {
    const result = await dispatchClosePositionFraction("BTCUSDT", 0.25);
    expect(result).toEqual({ ok: false, error: "partial_close_unavailable" });
  });

  test("a zero fraction is also rejected as unavailable", async () => {
    const result = await dispatchClosePositionFraction("BTCUSDT", 0);
    expect(result).toEqual({ ok: false, error: "partial_close_unavailable" });
  });
});

describe("dispatchReversePosition", () => {
  test("never sends a close-then-open sequence when disconnected", async () => {
    const close = jest.spyOn(liveApi, "closePosition");
    const submit = jest.spyOn(liveApi, "submitOrder");
    const reverse = jest.spyOn(liveApi, "reversePosition");
    const result = await dispatchReversePosition({
      idOrSymbol: "BTCUSDT",
      symbol: "BTCUSDT",
      side: "long",
      qty: 2,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Reverse is disabled. Close the position, then open the opposite side.");
    expect(close).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(reverse).not.toHaveBeenCalled();
  });

  test("a connected reverse uses only the dedicated reverse endpoint", async () => {
    useAppStore.setState({ connectedBroker: "binance" });
    const close = jest.spyOn(liveApi, "closePosition");
    const submit = jest.spyOn(liveApi, "submitOrder");
    const reverse = jest.spyOn(liveApi, "reversePosition").mockResolvedValue({
      ok: false,
      clientOrderId: "reverse-test",
      error: "Reverse is disabled. Close the position, then open the opposite side.",
    });

    await dispatchReversePosition({
      idOrSymbol: "BTCUSDT",
      symbol: "BTCUSDT",
      side: "long",
      qty: 2,
    });

    expect(reverse).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});
