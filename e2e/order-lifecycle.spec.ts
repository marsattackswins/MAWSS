/**
 * ORDER LIFECYCLE E2E TESTS — ALL SKIPPED
 *
 * All tests in this file previously exercised the paper trading engine (browser-local
 * simulated fills, tick-driven TP/SL/liquidation exits, mockBalance patching).
 * Paper trading was removed from the product in favour of Testnet and Production
 * as the only trading environments.
 *
 * The paper test bodies have been removed. New E2E coverage for disconnected
 * startup, rejected trading, and controlled Testnet fixtures lives in
 * e2e/disconnected.spec.ts and e2e/smoke.spec.ts.
 */

import { test } from "./fixtures";

test.skip("order lifecycle tests pending rewrite for Testnet authenticated flow", () => {
  // Paper trading was removed. Pending: Testnet order lifecycle E2E using
  // a pre-authenticated fixture and a controlled fake WebSocket feed.
});
