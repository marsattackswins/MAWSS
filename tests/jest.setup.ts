import { tmpdir } from "node:os";
import { join } from "node:path";
import { installNetworkGuard } from "./network-guard";

/**
 * Hermetic unit environment. The app is two-mode (testnet|production) and
 * always requires operator auth, so every jest process gets a valid testnet
 * configuration no matter what the invoking shell carries. Assignments are
 * forced, not `??=`: an ambient MAWS_DB_PATH must never point the suite at the
 * dev server's live database, and an ambient verifier must not leak into
 * assertions. Tests that need isolation install their own env afterwards.
 */
process.env.MAWS_ENV = "testnet";
process.env.MAWS_OPERATOR_AUTH = `${"ab".repeat(16)}:${"cd".repeat(64)}`;
process.env.MAWS_DB_PATH = join(tmpdir(), `maws-jest-${process.pid}-${Date.now()}.db`);

/** No ambient exchange credentials: tests construct their own env bags. */
for (const name of [
  "MAWS_BINANCE_API_KEY",
  "MAWS_BINANCE_API_SECRET",
  "MAWS_BINANCE_TESTNET_API_KEY",
  "MAWS_BINANCE_TESTNET_API_SECRET",
  "MAWS_BINANCE_PRODUCTION_API_KEY",
  "MAWS_BINANCE_PRODUCTION_API_SECRET",
]) {
  delete process.env[name];
}

/**
 * Network guard: the unit suites must never reach a real exchange, so fetch and
 * WebSocket calls to Binance hosts throw a clear error. The integration runner
 * (`npm run test:integration`) needs the Demo Trading hosts, so it exports
 * MAWS_ALLOW_REAL_NETWORK=1; the guard honours that only for a testnet config
 * with no production credentials pointing exclusively at demo hosts (see
 * tests/network-guard.ts). Injected/mocked transports are untouched.
 */
installNetworkGuard();
