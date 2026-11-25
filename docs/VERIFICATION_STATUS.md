# MAWS Verification Status

What has been executed against a real exchange versus what has only been
exercised with fakes. Last updated 2026-11-19 on `master` after Engine safety batch 2.

## Verified

| Check | Result | Notes |
| --- | --- | --- |
| Unit tests | Pass (fakes only) | 113 suites / 1819 tests green. No exchange socket or credential is used. |
| Type check | Pass | `npx tsc --noEmit` clean. |
| Lint | Pass | App-scoped ESLint run (app, components, lib, tests, scripts, proxy) reports 0 errors. The committed `vendor/` tree is excluded by the app's ESLint config and linted by the journal's own toolchain. |
| Production build | Pass | `npx next build` succeeds. |
| Browser e2e (fresh clone, CI shape) | Pass (fakes only) | Cloned the committed tree with no `.env*` and no installed dependencies, then `npm ci`, `npx playwright install chromium`, and `CI=true npx playwright test --project=chromium --repeat-each=3`: **45 passed, 0 failed, 0 skipped, 0 flaky**. FakeBinanceFeed plus a stubbed REST layer; no exchange is contacted. |
| Secret scan | Pass (tracked tree) | Clean in a fresh clone. A local working-tree run also flags the gitignored `.env.local` operator verifier by design; no secret is tracked or committed. |
| Public demo-host calls | Pass (unsigned) | `GET /fapi/v1/time` and `/fapi/v1/exchangeInfo` returned data from Binance demo hosts. The Algo order endpoint returned `401` without a key, which confirms only the unauthenticated path. |

## E2E coverage

The suite contains 15 unique tests, every one running behind a real
`POST /api/auth/login` session against a disposable server. The run above
repeats each test three times; there are no `test.skip` or `test.fixme`
entries.

Two dead paper cases were removed with the feature:

| Spec | Test | Kind | Reason | Replaced by |
| --- | --- | --- | --- | --- |
| `e2e/order-lifecycle.spec.ts` | order lifecycle tests pending rewrite for Testnet authenticated flow | skipped file | The bodies were tied to paper trading and had already been removed. | Login-first attachment tests in `e2e/disconnected.spec.ts`; a full Testnet order lifecycle remains unverified end to end. |
| `e2e/smoke.spec.ts` | paper order opens, TP closes it, and position/P&L/balance update — REMOVED: paper trading was removed from the product | `test.skip` | The feature is gone by design. | `tests/trading-tests/disconnected-behavior.test.ts` — every mutation returns `not_connected` and never reaches the broker. |

The two former `test.fixme` cases in `e2e/disconnected.spec.ts` are now real
login-first tests: the profile menu lists exactly Testnet and Live, and a
disconnected order submission returns `409 not_connected`.

The Testnet-to-Production switch contract is covered by
`tests/live-tests/profile-coordinator.test.ts` — "rejects a concurrent switch
and blocks exposure without cancellation or flattening" (asserts
`exposure_present`, no `allOpenOrders` and no `order` mutation calls) — plus the
e2e "switching from Testnet to Production goes through exposure and mutation
checks", which stubs the switch route and asserts the surfaced status.

## Position-tool e2e harness gap

`e2e/smoke.spec.ts` "position tool: toolbar cells present, long placed with target > entry > stop anchors"
arms the same control surface the toolbar cells call, drag-places the tool with
real mouse input, and asserts the resulting anchors. What it cannot do in this
fixture is drag an existing level: Vela's chart has no deterministic candles of
its own under the e2e stubs, so the drawing maps onto a degenerate price scale
and canvas hit-testing lands nowhere. On-canvas level dragging was verified by
hand against a fed chart (dragging inside the tool translates all three levels
and preserves the risk/reward distances), not in CI.

## Not verified

| Check | Result | Notes |
| --- | --- | --- |
| `listenKeyExpired` event handling | Not verified | The new rotate/reconnect/resnapshot path is exercised only against the fake WS (`tests/live-tests/stream-liveness.test.ts`). No real expiry event has been observed. |
| WebSocket ping interval assumption | Not verified | Liveness assumes Binance pings every 3 minutes and declares the socket dead after 12 minutes of silence (`SERVER_PING_INTERVAL_MS`, `PING_TIMEOUT_MS` in `lib/server/binance/stream.ts`). This cadence has not been measured against a live stream. |
| -2022 behavior in production | Not verified | Production now refuses any reduce-only fallback (re-read, record, alert, send nothing). The production branch has only been exercised with fakes; the demo venue's -2022 defect has not been reproduced against the real exchange. |
| Commission asset handling | Not verified | Non-USD commission (e.g. BNB) is converted with the latest `<ASSET>USDT` ticker price at daily-loss evaluation time. A non-USD fee asset with no fresh price makes the day's fee total unavailable: risk-increasing orders are rejected and a health alert is raised; closes and reduce-only orders are unaffected. No real non-USDT commission has been observed. |
| Engine safety batch (fixes A–F) | Tested against fakes only | Freeze reasons, the reduce-only fallback, stream expiry/liveness, fresh-risk reads, daily-loss fees and the emergency lane are covered exclusively by fake HTTP/WS transports. No signed request or private socket was used. |
| Signed demo calls | Not verified | No HMAC-signed request has been sent to demo hosts. |
| `totalMaintMargin` presence | Not verified | Presence in the account payload is assumed from documentation, not observed. |
| Algo place / cancel / list | Not verified | Neither demo nor live. |
| `ALGO_UPDATE` events | Not verified | No private stream has been observed emitting them. |
| Orphan-order behavior | Not verified | Auto-cancel and adoption paths are unproven. |
| UNPROTECTED flagging | Not verified | Exercised only against fakes. |
| Emergency flatten cleanup | Not verified | Not shown to leave zero conditional orders. |
| Hidden key prompt | Not verified | The interactive hidden-input path has not been exercised end to end. |
| `npm run verify:testnet` | Not verified | Has not been run to completion and no report has been reviewed. |
| Position level dragging (canvas) | Not verified in CI | Only by hand against a fed chart; see the harness gap above. |

## Release rule

Do not attach the Production profile or trade live size with this code until
`npm run verify:testnet` passes and its report is reviewed.

## Engine safety batch 2 (fakes only)

Everything below is exercised against the fake exchange transport, fake
timers and a temporary SQLite database. None of it has been run against a real
exchange account, a real alert webhook or a real external monitor.

| Area | Verified how | Real operation |
| --- | --- | --- |
| Operator unfreeze (`POST /api/live/freezes`) | Session/CSRF/Origin tests, service-token rejection, per-code clear rules, LEGACY requiring a clean recon, rate limit, and the execution/kill-switch invariant (`tests/live-tests/operator-unfreeze.test.ts`). UI banner covered by `e2e/operator-unfreeze.spec.ts` with stubbed state. | Not verified. No real freeze has been cleared end to end. |
| Request budget | Mark poll targets only stream-stale marks; exchangeInfo limits adopted with a fallback health warning (`tests/live-tests/request-budget.test.ts`). | Not verified against a live `exchangeInfo` payload or Binance's header accounting. |
| Retention and database health | Batched deletion, 24 h-guard rails for unprocessed events/intents/fills/income/protection, override windows, size warning (`tests/unit/retention.test.ts`). | Not verified on a production-sized database; no VACUUM is ever run automatically. |
| SSE hardening | Heartbeat session revalidation and slow-client close (`tests/live-tests/sse-route.test.ts`). | Not verified behind a real proxy. |
| Alert outbox | Durable rows, backoff, 24 h give-up, non-critical throttle (`tests/live-tests/alert-outbox.test.ts`). | Not verified against a real webhook endpoint. |
| Heartbeat | Optional 60 s GET, failure swallowed, stop semantics (`tests/live-tests/heartbeat.test.ts`). | Not verified against a real external monitor; the monitor must alert on silence. |
| Fail-closed fixes | MIN_NOTIONAL/MAX_NUM_ORDERS, unreadable pending exposure, mark-stream connect timeout and 30 s recycle, protection restore retries (policy), unpriced commission asset diagnosis (`tests/live-tests/fail-closed.test.ts`, `tests/live-tests/mark-price-stream.test.ts`). | Protection restore retry pacing is unit-tested at policy level only; no real restore loop has run. |
