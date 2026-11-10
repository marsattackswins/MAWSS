# MAWS Verification Status

What has been executed against a real exchange versus what has only been
exercised with fakes. Last updated 2026-11-10 at merge commit `8b17313`.

## Verified

| Check | Result | Notes |
| --- | --- | --- |
| Unit tests | Pass (fakes only) | 112 suites / 1811 tests green on `8b17313`. No exchange socket or credential is used. |
| Type check | Pass | `npx tsc --noEmit` clean on `8b17313`. |
| Secret scan | Pass | Gitleaks scan reported no findings. |
| Public demo-host calls | Pass (unsigned) | `GET /fapi/v1/time` and `/fapi/v1/exchangeInfo` returned data from Binance demo hosts. The Algo order endpoint returned `401` without a key, which confirms only the unauthenticated path. |

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

## Release rule

Do not attach the Production profile or trade live size with this code until
`npm run verify:testnet` passes and its report is reviewed.
