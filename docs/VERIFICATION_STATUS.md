# MAWS Verification Status

What has been executed against a real exchange versus what has only been
exercised with fakes. Last updated 2026-11-12 on `master`.

## Verified

| Check | Result | Notes |
| --- | --- | --- |
| Unit tests | Pass (fakes only) | 112 suites / 1819 tests green. No exchange socket or credential is used. |
| Type check | Pass | `npx tsc --noEmit` clean. |
| Browser e2e (CI shape) | Pass (fakes only) | `npx playwright test --project=chromium`: 12 passed, 4 skipped. FakeBinanceFeed plus a stubbed REST layer; no exchange is contacted. |
| Secret scan | Pass | Gitleaks scan reported no findings. |
| Public demo-host calls | Pass (unsigned) | `GET /fapi/v1/time` and `/fapi/v1/exchangeInfo` returned data from Binance demo hosts. The Algo order endpoint returned `401` without a key, which confirms only the unauthenticated path. |

## Skipped e2e tests

The run reports 4 skips. Each one, its written reason, and the coverage that
replaces it:

| Spec | Test | Kind | Added by | Covered instead by |
| --- | --- | --- | --- | --- |
| `e2e/disconnected.spec.ts:168` | disconnected startup: broker dialog shows two profiles, no Paper Trading option | `test.fixme` | `3f3c6e5` Align the e2e suite with the Vela workspace | `tests/live-tests/profile-api.test.ts` — "local Chart Only exposes safe metadata" (profiles length is exactly 2) and "rejects invalid profiles and requires production confirmation" (`profileId: "paper"` → 400 `invalid_profile`). The e2e reason is environmental: `/api/live/profiles` authenticates in every non-local runtime and returns 401 under the blank-credential e2e policy. |
| `e2e/disconnected.spec.ts:216` | dispatch rejects order when disconnected (server returns not_connected) | `test.fixme` | `3f3c6e5` Align the e2e suite with the Vela workspace | `tests/trading-tests/disconnected-behavior.test.ts` — "dispatchSubmitOrder returns not_connected and never hits the API" (also cancel, close, protect). The e2e reason is structural: `page.evaluate` cannot resolve the `@/lib/trading/dispatch` alias, and the UI renders no order control while disconnected. |
| `e2e/order-lifecycle.spec.ts:16` | order lifecycle tests pending rewrite for Testnet authenticated flow | `test.skip` | `da44cda` baseline snapshot | Nothing: the bodies were removed with paper trading. Testnet order lifecycle is unverified end to end. |
| `e2e/smoke.spec.ts:160` | paper order opens, TP closes it, and position/P&L/balance update — REMOVED: paper trading was removed from the product | `test.skip` | `da44cda` baseline snapshot | Nothing: the feature is gone by design. Legacy paper state migration is covered in `tests/trading-tests/disconnected-behavior.test.ts`. |

Earlier runs showed 2 skips because the two `test.fixme` entries in
`e2e/disconnected.spec.ts` were introduced later, when the suite was aligned
with the Vela workspace (`3f3c6e5`). Both `test.skip` entries predate that.

The Testnet-to-Production contract is covered by passing tests:
`tests/live-tests/profile-coordinator.test.ts` — "rejects a concurrent switch
and blocks exposure without cancellation or flattening" (asserts
`exposure_present`, no `allOpenOrders` and no `order` mutation calls) — plus the
passing e2e "switching from Testnet to Production goes through exposure and
mutation checks" in `e2e/disconnected.spec.ts`. Note that the e2e stubs
`/api/live/profile/switch` and asserts the surfaced status; the blocking logic
itself is the unit test's.

## Position-tool e2e harness gap

`e2e/smoke.spec.ts` "position tool places a long with entry/TP/SL geometry"
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
