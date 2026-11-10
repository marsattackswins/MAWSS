import os from "node:os";
import path from "node:path";

import { loadEnvConfig, type EnvConfig } from "@/lib/server/env/config";
import { assertTestnetSafety } from "../integration/helpers";

const OPERATOR_AUTH = "0123456789abcdef:fedcba9876543210";
const SCRATCH_DB = path.join(os.tmpdir(), `maws-guard-${process.pid}.db`);

function source(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    MAWS_ENV: "testnet",
    MAWS_OPERATOR_AUTH: OPERATOR_AUTH,
    MAWS_BINANCE_TESTNET_API_KEY: "testnet-key",
    MAWS_BINANCE_TESTNET_API_SECRET: "testnet-secret",
    MAWS_DB_PATH: SCRATCH_DB,
    ...overrides,
  };
  return env;
}

function testnetConfig(overrides: Record<string, string | undefined> = {}): EnvConfig {
  return loadEnvConfig(source(overrides));
}

describe("integration testnet safety guard", () => {
  test("accepts the testnet profile with a scratch database", () => {
    expect(() => assertTestnetSafety(testnetConfig(), source(), process.cwd())).not.toThrow();
  });

  test("refuses to run unless MAWS_ENV resolves to testnet", () => {
    for (const rawEnv of [undefined, "", "local", "production", "shadow"]) {
      expect(() =>
        assertTestnetSafety(testnetConfig(), source({ MAWS_ENV: rawEnv }), process.cwd()),
      ).toThrow(/MAWS_ENV=testnet/);
    }
  });

  test("refuses production credentials in the environment", () => {
    const cfg = testnetConfig();
    expect(() =>
      assertTestnetSafety(cfg, source({ MAWS_BINANCE_PRODUCTION_API_KEY: "pk" }), process.cwd()),
    ).toThrow(/MAWS_BINANCE_PRODUCTION_API_KEY/);
    expect(() =>
      assertTestnetSafety(cfg, source({ MAWS_BINANCE_PRODUCTION_API_SECRET: "ps" }), process.cwd()),
    ).toThrow(/MAWS_BINANCE_PRODUCTION_API_SECRET/);
  });

  test("refuses non-testnet REST or WebSocket endpoints", () => {
    const cfg = testnetConfig();
    const profile = cfg.profiles["binance-testnet"];
    const rest = profile.restEndpoint;
    const webSocket = profile.webSocketEndpoint;

    profile.restEndpoint = "https://fapi.binance.com";
    expect(() => assertTestnetSafety(cfg, source(), process.cwd())).toThrow(/non-Testnet endpoints/);

    profile.restEndpoint = rest;
    profile.webSocketEndpoint = "wss://fstream.binance.com";
    expect(() => assertTestnetSafety(cfg, source(), process.cwd())).toThrow(/non-Testnet endpoints/);

    // Legacy testnet hosts must also be rejected
    profile.webSocketEndpoint = webSocket;
    profile.restEndpoint = "https://testnet.binancefuture.com";
    expect(() => assertTestnetSafety(cfg, source(), process.cwd())).toThrow(/non-Testnet endpoints/);

    profile.restEndpoint = rest;
    profile.webSocketEndpoint = "wss://fstream.binancefuture.com";
    expect(() => assertTestnetSafety(cfg, source(), process.cwd())).toThrow(/non-Testnet endpoints/);

    profile.webSocketEndpoint = webSocket;
    expect(() => assertTestnetSafety(cfg, source(), process.cwd())).not.toThrow();
  });

  test("refuses the real databases", () => {
    for (const dbPath of [".maws/maws.db", ".maws/maws-prod.db"]) {
      const cfg = testnetConfig({ MAWS_DB_PATH: dbPath });
      expect(() => assertTestnetSafety(cfg, source({ MAWS_DB_PATH: dbPath }), process.cwd())).toThrow(
        /MAWS_DB_PATH/,
      );
    }
  });
});
