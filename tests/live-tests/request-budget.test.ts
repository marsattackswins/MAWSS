/**
 * Request budget (C): stream-first mark polling and exchangeInfo rate limits.
 *
 * The REST mark poll used to fetch every open position on every tick even
 * though the public mark-price stream already updates each one per second.
 */

import { describe, expect, test } from "@jest/globals";

import { positionsNeedingMarkRefresh } from "@/lib/server/binance/manager";
import { MetadataCache } from "@/lib/server/binance/metadata";
import {
  FALLBACK_ORDER_LIMIT_1M,
  FALLBACK_WEIGHT_LIMIT_1M,
  RateLimiter,
  readExchangeRateLimits,
} from "@/lib/server/binance/ratelimit";
import { BinanceRestClient } from "@/lib/server/binance/rest";
import type { LivePosition } from "@/lib/server/binance/state";
import { persistenceProfileFromConfig } from "@/lib/server/profile/context";
import { BTCUSDT_INFO, FakeHttp, freshEnv, installFakes, jsonRes, makeCfg } from "./helpers";

function position(overrides: Partial<LivePosition> = {}): LivePosition {
  return {
    symbol: "BTCUSDT",
    side: "long",
    qty: "0.01",
    entryPrice: "50000",
    markPrice: "50100",
    unrealizedProfit: "1",
    markPriceSource: "exchange",
    leverage: "5",
    liquidationPrice: "0",
    notional: "501",
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("mark-price REST poll targets", () => {
  const now = 1_700_000_020_000;

  test("a fresh stream mark is not polled", () => {
    expect(positionsNeedingMarkRefresh([position({ updatedAt: now - 1_000 })], now)).toEqual([]);
  });

  test("a mark older than the stream staleness bound is polled", () => {
    const stale = position({ symbol: "ETHUSDT", updatedAt: now - 11_000 });
    expect(positionsNeedingMarkRefresh([position({ updatedAt: now - 1_000 }), stale], now)).toEqual([stale]);
  });

  test("positions without a stream mark are polled even when recent", () => {
    const noStream = position({ markPriceSource: undefined, updatedAt: now });
    const fillOnly = position({ symbol: "SOLUSDT", markPriceSource: "fill-fallback", updatedAt: now });
    expect(positionsNeedingMarkRefresh([noStream, fillOnly], now)).toEqual([noStream, fillOnly]);
  });

  test("flat positions are never polled", () => {
    expect(positionsNeedingMarkRefresh([position({ qty: "0", updatedAt: 0 })], now)).toEqual([]);
  });
});

describe("exchangeInfo rate limits", () => {
  test("reads per-minute weight and order caps", () => {
    expect(
      readExchangeRateLimits([
        { rateLimitType: "REQUEST_WEIGHT", interval: "MINUTE", intervalNum: 1, limit: 1200 },
        { rateLimitType: "ORDERS", interval: "MINUTE", intervalNum: 1, limit: 300 },
        { rateLimitType: "ORDERS", interval: "SECOND", intervalNum: 10, limit: 100 },
      ]),
    ).toEqual({ weightLimit1m: 1200, orderLimit1m: 300 });
  });

  test("missing limits keep the fallbacks and report the fallback source", () => {
    const limiter = new RateLimiter(60);
    expect(limiter.limits()).toEqual({
      weightLimit1m: FALLBACK_WEIGHT_LIMIT_1M,
      orderCountLimit1m: FALLBACK_ORDER_LIMIT_1M,
      source: "fallback",
    });

    expect(limiter.applyExchangeLimits(undefined)).toBe(false);
    expect(limiter.applyExchangeLimits([{ rateLimitType: "ORDERS", interval: "SECOND", limit: 10 }])).toBe(false);
    expect(limiter.limits().source).toBe("fallback");
  });

  test("adopting exchange limits changes pressure math", () => {
    const limiter = new RateLimiter(60);
    limiter.observe({ "x-mbx-used-weight-1m": "600" });
    // 600 / 2400 fallback = 0.25
    expect(limiter.pressure()).toBeCloseTo(0.25, 5);

    expect(
      limiter.applyExchangeLimits([
        { rateLimitType: "REQUEST_WEIGHT", interval: "MINUTE", limit: 1200 },
      ]),
    ).toBe(true);
    // 600 / 1200 exchange limit = 0.5
    expect(limiter.pressure()).toBeCloseTo(0.5, 5);
    expect(limiter.limits()).toMatchObject({ weightLimit1m: 1200, source: "exchange" });
  });

  test("metadata cache exposes exchangeInfo rateLimits and null when absent", async () => {
    const cfg = freshEnv(makeCfg());
    const http = new FakeHttp();
    installFakes(http);
    http.route("/fapi/v1/exchangeInfo", () =>
      jsonRes({
        symbols: [BTCUSDT_INFO],
        rateLimits: [{ rateLimitType: "REQUEST_WEIGHT", interval: "MINUTE", intervalNum: 1, limit: 1800 }],
      }),
    );
    const rest = new BinanceRestClient(cfg, new RateLimiter(cfg.rateInternalPerMin), async () => undefined);
    const cache = new MetadataCache(rest, persistenceProfileFromConfig(cfg));
    await cache.ensureLoaded(true);
    expect(cache.exchangeRateLimits()).toEqual([
      { rateLimitType: "REQUEST_WEIGHT", interval: "MINUTE", intervalNum: 1, limit: 1800 },
    ]);

    const cfgWithout = freshEnv(makeCfg());
    const httpWithout = new FakeHttp();
    installFakes(httpWithout);
    httpWithout.route("/fapi/v1/exchangeInfo", () => jsonRes({ symbols: [BTCUSDT_INFO] }));
    const restWithout = new BinanceRestClient(cfgWithout, new RateLimiter(cfgWithout.rateInternalPerMin), async () => undefined);
    const cacheWithout = new MetadataCache(restWithout, persistenceProfileFromConfig(cfgWithout));
    await cacheWithout.ensureLoaded(true);
    expect(cacheWithout.exchangeRateLimits()).toBeNull();
  });
});
