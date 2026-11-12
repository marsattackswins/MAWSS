import { tmpdir } from "node:os";
import { join } from "node:path";
import { installNetworkGuard } from "./network-guard";

/**
 * Runs before any test module is imported. Tests that call `freshEnv` install
 * their own isolated temp DB, but anything that reaches the database without
 * that harness (e.g. the CircuitBreaker audit logging) would otherwise fall
 * through to `.maws/maws.db` — the dev server's live database. Redirect it.
 */
process.env.MAWS_DB_PATH ??= join(tmpdir(), `maws-jest-${process.pid}-${Date.now()}.db`);

/**
 * Network guard: the unit suites must never reach a real exchange, so fetch and
 * WebSocket calls to Binance hosts throw a clear error. The integration runner
 * (`npm run test:integration`) needs the Demo Trading hosts, so it exports
 * MAWS_ALLOW_REAL_NETWORK=1; the guard honours that only for a testnet config
 * with no production credentials pointing exclusively at demo hosts (see
 * tests/network-guard.ts). Injected/mocked transports are untouched.
 */
installNetworkGuard();
