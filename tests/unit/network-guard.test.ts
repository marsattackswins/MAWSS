import { describe, expect, it } from "@jest/globals";
import {
  ALLOW_REAL_NETWORK_VAR,
  guardMessage,
  isBlockedExchangeHost,
  networkGuardState,
  realNetworkAllowed,
} from "../network-guard";

/**
 * The guard has two jobs: block real exchange traffic for `npm test`, and stay
 * out of the way of `npm run test:integration` — but only under the testnet
 * safety conditions. These tests pin both halves.
 */
describe("network guard — blocking", () => {
  it("blocks every live and demo Binance host", () => {
    for (const url of [
      "https://fapi.binance.com/fapi/v1/ping",
      "https://api.binance.com/api/v3/exchangeInfo",
      "https://api.binance.us/api/v3/ping",
      "https://demo-fapi.binance.com/fapi/v1/listenKey",
      "https://testnet.binancefuture.com/fapi/v1/ping",
      "wss://fstream.binance.com/ws",
      "wss://demo-fstream.binance.com/ws",
    ]) {
      expect(isBlockedExchangeHost(url)).toBe(true);
    }
  });

  it("does not block local fixtures or non-exchange hosts", () => {
    for (const url of [
      "http://127.0.0.1:8787/btcusdt@kline_1d",
      "ws://127.0.0.1:8787/ws",
      "https://example.com/binance.com",
      "https://finnhub.io/api/v1/news",
    ]) {
      expect(isBlockedExchangeHost(url)).toBe(false);
    }
  });

  it("is enforced for the unit run and throws on a real fetch", () => {
    expect(networkGuardState()).toBe("enforced");
    expect(() => fetch("https://fapi.binance.com/fapi/v1/ping")).toThrow(/network guard: blocked real fetch/);
  });

  it("names the blocked target in the message", () => {
    const message = guardMessage("WebSocket", "wss://fstream.binance.com/ws");
    expect(message).toContain("network guard: blocked real WebSocket to wss://fstream.binance.com/ws");
    expect(message).toContain("Inject a fake transport");
  });
});

describe("network guard — integration-runner opt-out", () => {
  const testnetEnv: Record<string, string> = {
    [ALLOW_REAL_NETWORK_VAR]: "1",
    MAWS_ENV: "testnet",
  };

  it("allows real traffic for the demo-hosted testnet runner", () => {
    expect(realNetworkAllowed(testnetEnv)).toBe(true);
  });

  it("allows demo endpoints when an explicit demo URL is present", () => {
    expect(
      realNetworkAllowed({
        ...testnetEnv,
        MAWS_DEMO_REST: "https://demo-fapi.binance.com/fapi/v1",
        MAWS_DEMO_WS: "wss://demo-fstream.binance.com/ws",
      }),
    ).toBe(true);
  });

  it("stays enforced without the runner flag", () => {
    expect(realNetworkAllowed({ MAWS_ENV: "testnet" })).toBe(false);
    expect(realNetworkAllowed({ [ALLOW_REAL_NETWORK_VAR]: "0", MAWS_ENV: "testnet" })).toBe(false);
  });

  it("stays enforced unless the environment resolves to testnet", () => {
    expect(realNetworkAllowed({ ...testnetEnv, MAWS_ENV: "production" })).toBe(false);
    expect(realNetworkAllowed({ ...testnetEnv, MAWS_ENV: "shadow" })).toBe(false);
    expect(realNetworkAllowed({ ...testnetEnv, MAWS_ENV: "local" })).toBe(false);
    expect(realNetworkAllowed({ [ALLOW_REAL_NETWORK_VAR]: "1" })).toBe(false);
  });

  it("stays enforced when production credentials are present", () => {
    expect(
      realNetworkAllowed({
        ...testnetEnv,
        MAWS_BINANCE_PRODUCTION_API_KEY: "present-but-never-read-mock",
      }),
    ).toBe(false);
  });

  it("stays enforced when any Binance endpoint is not a demo host", () => {
    expect(
      realNetworkAllowed({
        ...testnetEnv,
        MAWS_SOME_REST: "https://fapi.binance.com/fapi/v1",
      }),
    ).toBe(false);
  });
});
