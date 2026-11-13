import { ALLOWED_REQUESTS, parseGuardLog, violations, type GuardEntry } from "../../e2e/disconnected-policy";

/**
 * Unit coverage for the disconnected network policy: the guard-log format the
 * e2e server writes, and the allowlist rules that decide what a Disconnected
 * app may send. Runs in Jest because it needs no browser or server.
 */

const FAPI = "https://fapi.binance.com";

function entry(over: Partial<GuardEntry> = {}): GuardEntry {
  return {
    at: "2026-01-01T00:00:00.000Z",
    kind: "fetch",
    url: `${FAPI}/fapi/v1/ticker/24hr?symbol=BTCUSDT`,
    method: "GET",
    hasApiKey: false,
    hasSignature: false,
    ...over,
  };
}

describe("parseGuardLog", () => {
  it("parses the structured line the server guard writes", () => {
    const entries = parseGuardLog(
      [
        "blocked 2026-01-01T00:00:00.000Z fetch https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT method=GET auth=0 sig=0",
        "blocked 2026-01-01T00:00:01.000Z https https://fapi.binance.com/fapi/v1/exchangeInfo method=GET auth=1 sig=0",
        "blocked 2026-01-01T00:00:02.000Z websocket wss://fstream.binance.com/ws method=- auth=0 sig=0",
      ].join("\r\n"),
    );

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      kind: "fetch",
      method: "GET",
      url: `${FAPI}/fapi/v1/klines?symbol=BTCUSDT`,
      hasApiKey: false,
      hasSignature: false,
    });
    expect(entries[1]).toMatchObject({ kind: "https", hasApiKey: true });
    expect(entries[2]).toMatchObject({ kind: "websocket", method: "-" });
  });

  it("tolerates an older line without the trailing fields", () => {
    const [entry] = parseGuardLog(
      "blocked 2026-01-01T00:00:00.000Z fetch https://fapi.binance.com/fapi/v1/time",
    );
    expect(entry).toMatchObject({ method: "GET", hasApiKey: false, hasSignature: false });
  });

  it("ignores anything that is not a guard record", () => {
    expect(parseGuardLog("[server-network-guard] active — hosts blocked\n\n")).toEqual([]);
  });
});

describe("violations", () => {
  it("accepts the public market reads a Disconnected app needs", () => {
    const entries: GuardEntry[] = [
      entry(),
      entry({ url: `${FAPI}/fapi/v1/klines?symbol=BTCUSDT&interval=1d&limit=500` }),
      entry({ url: `${FAPI}/fapi/v1/exchangeInfo` }),
      entry({ url: `${FAPI}/fapi/v1/time` }),
      entry({ url: `${FAPI}/fapi/v1/premiumIndex?symbol=BTCUSDT` }),
      entry({
        kind: "https",
        method: "POST",
        url: "https://www.binance.com/bapi/futures/v1/public/future/common/get-symbol-logo",
      }),
      entry({
        url: "https://www.binance.com/bapi/composite/v1/public/marketing/symbol/list?x=1",
      }),
    ];
    expect(violations(entries)).toEqual([]);
  });

  it("rejects any WebSocket while disconnected", () => {
    expect(violations([entry({ kind: "websocket", method: "-", url: "wss://fstream.binance.com/ws" })])).toEqual([
      "socket opened while disconnected: WEBSOCKET - wss://fstream.binance.com/ws",
    ]);
  });

  it("rejects an authenticated or signed request", () => {
    expect(violations([entry({ hasApiKey: true })])).toContain(
      `API key sent while disconnected: FETCH GET ${FAPI}/fapi/v1/ticker/24hr?symbol=BTCUSDT`,
    );
    expect(violations([entry({ hasSignature: true })])).toContain(
      `signed request while disconnected: FETCH GET ${FAPI}/fapi/v1/ticker/24hr?symbol=BTCUSDT`,
    );
  });

  it("rejects Demo Trading hosts and listenKey/account endpoints", () => {
    expect(
      violations([entry({ url: "https://demo-fapi.binance.com/fapi/v1/time" })]).join("\n"),
    ).toMatch(/Demo Trading host/);
    expect(
      violations([entry({ url: `${FAPI}/fapi/v1/listenKey` })]).join("\n"),
    ).toMatch(/private\/account endpoint/);
    expect(
      violations([entry({ url: `${FAPI}/fapi/v1/positionRisk` })]).join("\n"),
    ).toMatch(/private\/account endpoint/);
  });

  it("rejects a public path used with the wrong verb or outside the allowlist", () => {
    expect(violations([entry({ method: "POST" })]).join("\n")).toMatch(/undeclared request/);
    expect(
      violations([entry({ url: `${FAPI}/fapi/v1/depth?symbol=BTCUSDT` })]).join("\n"),
    ).toMatch(/undeclared request/);
    expect(
      violations([entry({ url: "https://api.binance.com/api/v3/ticker/24hr" })]).join("\n"),
    ).toMatch(/undeclared request/);
  });

  it("declares only the endpoints the disconnected app actually needs", () => {
    expect(ALLOWED_REQUESTS.map((rule) => rule.name)).toEqual([
      "exchangeInfo",
      "ticker24hr",
      "klines",
      "time",
      "premiumIndex",
      "symbol-logo",
      "public-bapi",
    ]);
  });
});
