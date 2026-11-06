# MAWS Technical Project Review

**Review snapshot:** 2026-11-06  
**Scope:** Current files in the working tree; this is a code-and-documentation review, not a penetration test, exchange certification, or test run.

> **Snapshot caveat:** The working tree contained extensive modified, deleted, and untracked files during this review. This report describes that on-disk snapshot, including those edits; it may not describe the committed branch. No environment-value files or runtime database contents were inspected. No credentials, account identifiers, or secret values are included here.

## 1. Overview

### What the app does

MAWS (Market Analysis & Workflow System) is a self-hostable browser terminal for cryptocurrency and other Binance Futures symbols. It combines live charts and quotes, technical studies, watchlists, drawing tools, candle replay, news, an economic calendar, and a trade journal. It also provides operator-controlled Binance USDⓈ-M Futures Testnet and Production account management and manual order entry.

The application is **not an autonomous trading bot** in the reviewed tree. Chart indicators, Pine scripts, and technical readouts help an operator analyze markets; the order path is invoked by UI actions. The chart-only mode still uses public Binance market-data endpoints and WebSockets; “chart only” means no attached authenticated trading account, not no Binance network traffic.

### Technology

| Area | Technology |
|---|---|
| Application | TypeScript, Next.js 16 App Router, React 19 |
| UI and state | Tailwind CSS 4, Zustand 5, Lucide icons, custom React components |
| Charting | Vendored LuxAlgo Vela source under `lib/charting/`; `@luxalgo/vela-pinets` for Pine indicator support |
| Server/runtime | Node.js; Next.js route handlers and standalone output |
| Persistence | SQLite via `better-sqlite3`; no external database server is configured |
| Network | Node `fetch`, `ws` WebSockets, server-sent events (SSE) |
| Tests | Jest / ts-jest, Vitest for Vela, Playwright |
| Deployment examples | Docker, Linux systemd, nginx reverse proxy |

### Brokers, exchanges, and data providers

- **Trading broker/exchange:** Binance USDⓈ-M Futures. The broker interface is abstracted, but the factory and environment configuration currently support Binance only.
- **Market feed:** Binance Futures public klines, ticker/quotes, and WebSockets. Vela is wired to the app through a Binance provider adapter.
- **News:** Finnhub REST news endpoints; an API key is read from the server environment.
- **Economic calendar:** Xoomar public calendar endpoint; no key is used by the route.
- **Asset logos:** Binance public logo/catalog endpoints and Binance-hosted image URLs.
- **Journal:** A separate vendored LuxAlgo Trade Journal web app is proxied at `/journal`, typically through a same-origin local sidecar. It is not the broker or execution engine.

The vendored charting tree contains provider-specific code and tests beyond Binance. That should not be read as evidence that MAWS’s order system supports those providers; the app-level feed and server broker paths reviewed here are Binance-specific.

## 2. Architecture

### Major folders and modules

| Path | Responsibility |
|---|---|
| [`app/`](../app/) | Next.js page shell and route handlers for auth, public market data, live trading, admin, health, news, calendar, and logo proxying. |
| [`components/`](../components/) | React workspace UI: charts, shell/navigation, settings, watchlist and market context, indicators/Pine, replay, drawings, and trading panels. |
| [`lib/server/`](../lib/server/) | Server-only trading runtime: auth, profile coordination, Binance API, execution gates/risk, SQLite, reconciliation, health, audit, logs, metrics, and resilience. |
| [`lib/server/broker/`](../lib/server/broker/) | Broker interface, factory, and Binance adapter; only Binance is currently selectable. |
| [`lib/server/binance/`](../lib/server/binance/) | Binance signing, REST/WebSocket clients, order lifecycle, state, stream leasing, reconciliation, filters, risk, and metadata. |
| [`lib/market/`](../lib/market/) | Public Binance market-data feed and candle normalization/reconciliation; Finnhub server helper and provider resolution. |
| [`lib/live/`](../lib/live/) | Browser-side live API client, event bridge, DTO types, and non-persisted live exchange-state store. |
| [`lib/trading/`](../lib/trading/) | Client-side order dispatch and trading UI helpers, symbol-level sizing/preferences, and derived performance statistics. |
| [`lib/slices/`, `lib/store.ts`](../lib/slices/) | Zustand app state for charts, market data, watchlists, drawings, symbol settings, and UI. |
| [`lib/charting/`](../lib/charting/) | Vendored Vela chart engine, renderer, indicators, drawings, replay, providers, and its own Vitest suite. |
| [`lib/`](../lib/) | Shared app helpers for calendars, news, symbols, indicators, layouts, themes, timezone, and Vela integration wiring. |
| [`tests/`](../tests/) | Jest unit, feed/candle, trading, live-runtime, admin, and Testnet integration tests. |
| [`e2e/`](../e2e/) | Playwright browser workflows. |
| [`deploy/`](../deploy/) | Docker image, systemd unit, and nginx reverse-proxy example. |
| [`scripts/`](../scripts/) | Development/standalone launchers, journal sidecar, auth generation, backup restore, integration setup, live smoke checks, and diagnostics. |
| [`vendor/`](../vendor/) | Vendored trade journal application. |
| [`public/`](../public/) | Static brand assets and other public files. |
| [`__mocks__/`](../__mocks__/) | Jest stubs, including Vela provider/charting mocks. |
| [`docs/`](./) | API, architecture, development, operations, security, decisions, and runbook documentation. |

### Data flow

1. **Market data in:** The browser feed uses Binance Futures WebSockets for streaming klines and quotes, and same-origin `/api/binance/klines` and `/api/binance/ticker` routes for REST history/refresh. Candle normalization and reconciliation handle partial, duplicate, stale, and out-of-order updates. The chart host supplies these data to Vela.
2. **Analysis:** The operator chooses symbols/timeframes and applies chart indicators, Pine indicators, drawings, or the technical-lean readout. Replay is a chart/history workflow, not an order simulator.
3. **Order decision:** UI actions call `lib/trading/dispatch.ts`, which checks broker connection, current chart feed status, and browser-visible execution health before sending a request. Server route validation and server-side gates/risk checks are authoritative.
4. **Order execution:** `/api/live/*` routes authenticate and validate requests, then call the broker interface. The Binance adapter delegates to the server `OrderService`, which validates exchange constraints, reference-price freshness, risk, and execution readiness before placing signed REST requests.
5. **State and UI:** Binance private user-data events update server memory and durable event/fill/intent records. Periodic exchange snapshots and reconciliation repair/check state. SSE and REST state endpoints deliver current account, positions, orders, fills, and health to the browser’s non-persisted live store. Browser workspace preferences are held separately in origin-scoped storage.

### Main external endpoints/services

- Binance USDⓈ-M Futures public REST and WebSocket services for data; signed account, position, order, leverage, income, and history endpoints for attached profiles. Environment-to-host mapping is fixed in source rather than accepting arbitrary API hosts.
- Finnhub `/news` and `/company-news`.
- Xoomar market calendar.
- Binance public symbol/asset logo catalog and image hosts.
- Optional operator-configured alert webhook.
- Optional journal upstream, normally the local Next.js sidecar.

## 3. Trading Logic

### Strategies and signal generation

No automatic entry/exit strategy loop or strategy-to-order pipeline was found. There are chart studies, user-authored Pine indicators, a technical-lean gauge (the symbol card comments describe a five-minute dual-Stochastic %D cross and StochRSI readout), and watchlist/screener UI. These are analytical/display features; the live dispatch module does not consume their signals to submit orders.

Accordingly, there are no implemented executable strategy rules to enumerate as “strategy A/B,” and no server-side strategy loop excerpt to provide. The recurring manager loop is for exchange reconciliation, not trading signals.

### Manual orders and protection

- UI order types include market, limit, and stop-market. The server supports Binance market, limit, stop-market, and take-profit-market operations, including native exchange conditional TP/SL orders.
- Closing a position uses exchange position state and a reduce-only market order. The emergency close path has a guarded fallback for a specific reduce-only rejection case after rechecking position and open-order state.
- The “reverse” UI action sends a close and then an opposite-side market order; the two requests are sequential API calls, not one atomic exchange operation.
- TP and SL protection are native conditional orders with `closePosition=true`, not simulated browser triggers. Replacing a protection order cancels the existing order before submitting its replacement.

### Position sizing and risk checks

Per-symbol UI settings provide quantity sizing and leverage choices; quantities are aligned down to the exchange quantity step. The server uses decimal helpers and current exchange metadata. The order cap is applied to order notional (`effective price × quantity`), not to a risk-per-stop sizing formula. There is no general position-sizing algorithm that sizes every trade to a fixed percent of account risk.

The environment defaults in source are:

| Guard | Default |
|---|---:|
| Maximum order notional | USD 50 |
| Maximum gross exposure | USD 100 |
| Maximum open orders | 10 |
| Maximum open positions | 3 |
| Daily realized-loss percentage | 50% |
| Limit/stop price collar from reference | 5% |

Production config validates these values as positive finite numbers, but the code supplies defaults when values are absent. It does not enforce that an operator explicitly set every production value.

The server-side risk check uses the following logic:

```ts
const notional = abs(mul(parseDec(order.effectivePrice), parseDec(order.qty)));
const notionalUsd = decToNumber(notional);
const proposedGrossExposureUsd =
  snap.grossExposureUsd + pendingExposureUsd + notionalUsd;
if (proposedGrossExposureUsd > risk.maxGrossExposureUsd) {
  errors.push("RISK_MAX_GROSS_EXPOSURE");
}
if (snap.balanceUsd > 0 && snap.realizedTodayUsd < 0) {
  const limit = (snap.balanceUsd * risk.dailyLossPct) / 100;
  if (-snap.realizedTodayUsd >= limit) {
    errors.push("EXECUTION_UNHEALTHY");
  }
}
```

The implementation also compares `notionalUsd` with the maximum order notional, checks open-order/position counts, and applies the price collar. Daily loss is based on realized P&L logged since UTC midnight, and only runs when the risk snapshot balance is positive. It is not a comprehensive unrealized-loss, drawdown, liquidation-distance, or leverage-budget guard.

Normal submission is fail-closed unless all required runtime, profile, stream, lease, snapshot, position-mode, freeze, and kill-switch conditions pass. In abbreviated form:

```ts
if (input.emergencyClose) requireEmergencyActionAllowed(cfg);
else requireSubmissionAllowed(cfg);

if (!input.closePosition && !input.emergencyClose && !input.reduceOnly && !input.isClose) {
  const riskErrors = checkRisk(
    cfg,
    this.deps.getRiskSnapshot(),
    { type: input.type, qty: input.qty ?? "0", effectivePrice, reduceOnly: !!input.reduceOnly },
    reference!.price,
  );
  if (riskErrors.length > 0) {
    return { ok: false, clientOrderId, error: riskErrors.join("; ") };
  }
}
const { intent, duplicate } = createIntentRecord({
  clientOrderId,
  clientAlgoId: input.kind === "algo" ? clientOrderId : undefined,
  kind: input.kind ?? "order",
  symbol: input.symbol,
  side: input.side,
  type: input.type,
  qty: input.closePosition ? "" : input.qty ?? "",
  price: input.price ?? null,
  stopPrice: input.stopPrice ?? null,
  reduceOnly: !!input.reduceOnly,
}, Date.now(), this.persistenceProfile);
if (duplicate) {
  return {
    ok: false,
    clientOrderId,
    duplicate: true,
    error: `Duplicate clientOrderId ${clientOrderId} (intent already ${intent.status})`,
  };
}
this.updateIntent(clientOrderId, { status: "SUBMITTING", lastState: JSON.stringify({ effectivePrice }) });
const params = buildOrderParams(input, clientOrderId);
const order = input.emergencyClose
  ? await this.deps.rest.placeOrderEmergency(params)
  : await this.deps.rest.placeOrder(params);
```

There is no main strategy loop to excerpt: order dispatch starts from operator actions. The manager’s recurring timer is reconciliation-only:

```ts
this.reconTimer = setInterval(() => {
  if (!this.isGenerationCurrent(generation)) return;
  void this.recon.run("interval").catch((err) => {
    if (this.isGenerationCurrent(generation)) log.error("reconciliation crash", { error: String(err) });
  });
}, this.cfg.reconIntervalMs);
```

### Order state

An intent is written to SQLite before exchange submission and keyed by client order ID. The exchange private stream updates order status/fills; statuses include `SUBMITTING`, `SUBMITTED`, `PARTIALLY_FILLED`, `FILLED`, cancellation/rejection/expiry, and uncertainty states. Duplicate client IDs are rejected. Unknown outcomes from timeouts or exchange HTTP 5xx are not blindly retried: the intent is marked uncertain, normal submissions freeze, and the system queries/reconciles exchange truth. Cancel outcomes have similar uncertainty handling.

## 4. Risk and Safety Controls

- **Execution gates:** Only Testnet/Production profiles can submit; `local` and `shadow` are read-only for normal submissions. Execution requires an attached configured profile, enabled runtime flag, no kill switch/freeze, a ready manager, owned stream lease, healthy private stream, sufficiently fresh snapshot, and verified one-way position mode.
- **Health freshness:** Client order dispatch checks the active chart’s kline status. Server submission requires a recent reference price (30-second maximum age). Readiness also tracks stream/event freshness and snapshot age (default five minutes).
- **Risk caps:** Per-order notional, gross exposure (including working orders and uncertain intents where their values are usable), open order/position counts, daily realized-loss threshold, and a price collar for priced/conditional orders.
- **Exchange validation:** Binance filters and quantity steps, symbol metadata, mark/reference-price checks, position-mode validation, clock synchronization, and leverage synchronization are used.
- **Kill switch/freeze:** Persistent per-profile runtime flags can disable execution, freeze submissions, or engage a kill switch. Reconciliation drift, unknown order/cancel outcomes, stale/failed health, and key errors can freeze normal submissions.
- **Emergency flatten:** An explicit endpoint cancels open orders and attempts reduce-only closes. It is permitted in live/Testnet environments even when normal submission is frozen; a configured health token can authorize this endpoint as an alternative to an operator session. It reports per-operation failures and is not proof that the account is flat.
- **Disconnects/restarts:** A SQLite lease arbitrates ownership of the private stream. Startup retrieves authoritative account/position/order snapshots, starts the user-data stream, reconciles, and hydrates persisted fills/order history. Reconciliation runs periodically (default 60 seconds). Stream overflow triggers snapshot/reconciliation. Positions/balances are refreshed from exchange truth rather than trusted from browser state.
- **Retries and rate limits:** REST uses a 10-second transport timeout, exchange-header-aware/internal rate limiter, and circuit breakers. A Binance clock-skew `-1021` gets one clock resync and retry. There is no general automatic retry of order submissions; uncertain mutations are reconciled instead. Default circuit thresholds are configurable (REST 5 failures/60 seconds, stream 3/5 minutes, reconciliation 3/10 minutes).
- **Operator/API rate limits:** Live mutations are limited per symbol and operation in an in-process rolling window; login limiting is also in memory. These counters reset on restart and are not shared across multiple app instances.

## 5. Data and State

### Persistence and reconciliation

SQLite is the server’s durable operational store (`.maws/maws.db` by default). Migrations define sessions, audit log, per-profile runtime config, order intents, exchange metadata/clock, raw order events, reconciliation runs, stream-owner leases, fills, account income (realized P&L/commission/funding), imported order history, and shadow-mode events. Database connections use WAL, foreign keys, a busy timeout, and best-effort restrictive file permissions.

The exchange remains authoritative for **current balances, positions, and open orders**. Those are loaded into server memory from snapshots and user-data events; the schema does not define a durable positions/balances snapshot table. The browser live store is explicitly non-persisted. Historical fills and order records are persisted and can be reloaded.

Historical recovery backfills fills from Binance user-trade history in windows no wider than seven days, with a default three-day lookback and a configured maximum of 26 chunks. Historical orders use Binance all-orders history. Income history is synchronized into a separate ledger. These Binance history endpoints impose retention/window limitations, so the local ledger may not reconstruct arbitrary older account activity.

The browser stores workspace/layout/chart preferences in origin-scoped local storage. This is separate from the server-side SQLite trading state.

### Backtesting and P&L assumptions

No backtesting engine was found in the app trading path. Chart replay is visual historical-bar playback. Performance statistics are derived from filled order history through a FIFO statistics helper; they are not results of simulated strategy execution. The code review did not find a backtest model for commissions, slippage, latency, market impact, or lookahead bias. Exchange income and fills track realized P&L/commission/funding for live history, but that is distinct from a backtest.

## 6. Security

- **Credential handling:** Binance keys/secrets are loaded from server environment variables in profile-specific pairs (legacy variable names are also supported during migration). REST signing occurs server-side; the host mapping is fixed in code. The API exposes safe profile metadata rather than credential values. Finnhub’s key is also read server-side.
- **Operator authentication:** Operator password material is a salted scrypt hash in environment configuration. Sessions use random opaque IDs; only the session-ID hash is stored in SQLite. The session cookie is HTTP-only and `SameSite=Strict`; the secure cookie form is used when the configured origin is HTTPS. Sessions have a sliding 12-hour lifetime. The CSRF token is stored in the session row and checked on mutations.
- **Request protection:** Mutating routes check origin/host and CSRF, then session authentication; live routes also use a profile/generation assertion to reject stale operations during profile switching. Login attempts are rate-limited per apparent client IP. Proxy IP headers are trusted only when explicitly configured.
- **Authorization model:** This is a single-operator password/session design, not multi-user RBAC. Admin/health endpoints use an operator session or configured health token in non-local modes. Local mode intentionally makes certain health/metrics endpoints public for development. The health token is especially sensitive because it can authorize emergency flatten.
- **Network exposure:** Examples place the Node server behind nginx TLS and bind the app to loopback; Docker run guidance similarly binds the published port locally. Public market-data, logo, news/calendar, journal, and health surfaces should be reviewed against the intended deployment perimeter. The optional alert webhook is an outbound server request to an operator-configured URL.
- **Backups:** SQLite backups are encrypted using AES-256-GCM and verified by decrypting and running SQLite integrity checks. The backup key is separate environment configuration.

### Configuration/documentation discrepancy

The README describes `MAWS_ENV=local` as unable to attach a Binance profile. In the reviewed code, local login is allowed when operator authentication is configured, profile-specific credentials can be loaded, and the authenticated `/api/live/profile/switch` route calls the profile coordinator without an explicit local-environment prohibition. This appears to permit switching from local to a configured Testnet or Production profile. The intended contract should be confirmed and the docs or guard aligned before relying on “local means no trading.”

## 7. Testing and Operations

### Tests present

- Jest tests cover chart/app state, candle normalization and recovery, feed visibility/reliability, trading math/settings, disconnected behavior, execution gating, live order lifecycle, risk caps, auth, persistence, profile coordination, broker health, and reconciliation-related behavior.
- `tests/integration/` has exchange/Testnet workflows for order lifecycle, position sync, and stream recovery. The repository documentation warns that these can create/modify Testnet orders and positions.
- Playwright tests cover browser smoke/disconnected and order workflow paths. The current Playwright configuration uses a fake Binance WebSocket server and scrubs ambient `MAWS_*` variables from its web-server environment.
- `lib/charting/test/` is a separate Vitest suite for vendored Vela.

Test files and commands exist, but this review did not execute them and does not assert that they pass. `docs/DEVELOPER.md` contains coverage statements that do not exactly match the checked-in Jest configuration (which has focused file thresholds rather than the documented global thresholds); treat the test configuration as the executable source of truth.

### Logging, monitoring, and alerting

The server has structured application/request/market logging, audit events in SQLite, in-process counters/gauges/histograms, P&L metrics, health/readiness endpoints, admin metrics/logs/risk views, circuit-breaker status, and optional webhook alerts for events such as fills and stream failures. Metrics are process-local rather than a durable time-series monitoring backend. The alert dispatcher rate-limits each event type in memory.

### Running and deployment

- Local development: `npm run dev` on port 3000; `npm test`, `npm run test:charting`, `npx tsc --noEmit`, `npm run build`, and `npx playwright test` are documented checks.
- Standalone production: `npm run build` prepares Next standalone output; `npm start` uses the supervisor, while `npm run start:bare` runs the bare standalone server.
- Deployment examples: `deploy/Dockerfile`, `deploy/maws.service`, and `deploy/nginx.conf`. The deployment docs recommend TLS termination, a protected environment file, persistent `.maws` data, and a fixed egress IP for Binance IP allowlisting.
- The trade journal is a separate sidecar (normally port 3400) started/managed by the launcher and proxied under `/journal`.
- The app is designed to use port 3000 for its normal origin/workspace. Playwright deliberately isolates its test server on 3001.

## 8. Self-Assessment

### Fragile or financially sensitive paths

1. **Profile switching contract:** The local-mode documentation and code behavior appear inconsistent (see above). This is the first operational contract to resolve.
2. **Protective-order replacement gap:** TP/SL replacement cancels an existing protective order before placing its replacement. A subsequent rejected, timed-out, or uncertain submission can leave the position without that protection. The cancellation is checked, but the sequence cannot be atomic at Binance.
3. **Reverse-position sequencing:** Close then open-opposite is not atomic and does not wait in the UI dispatch helper for confirmed full close fills. A partial/failed close can make the final position differ from the operator’s intention.
4. **Risk guard scope:** The daily-loss check is based on realized P&L and does not bound unrealized losses or total drawdown; the default percentage is high. The caps are not a guarantee against liquidation, gaps, slippage, or exchange-side state changes.
5. **Emergency flatten limitations:** It intentionally bypasses ordinary freezes/circuit gates and can partially fail due to exchange/network errors. Operators must verify resulting positions and open orders in Binance after using it.
6. **Pending-exposure input integrity:** The risk helper skips a pending-exposure row it cannot parse, relying on the authoritative snapshot/reconciliation path to freeze unsafe state. Confirm that malformed persisted intent data always causes that independent freeze before treating the gross-exposure cap as fail-closed in every corruption case.
7. **Process-local controls:** API rate-limit windows, alert throttles, metrics, and much runtime state are process-local. Multiple server replicas would need careful single-owner/coordination configuration and externalized/shared controls; the SQLite stream lease alone does not make every in-memory control distributed.
8. **Current-state reliance on exchange:** Current balances, positions, and open orders are rehydrated from Binance rather than stored as durable local truth. A successful and fresh exchange snapshot/reconciliation is therefore essential after restarts and outages.
9. **Documentation drift:** Several docs describe older paper-trading/test layouts or coverage thresholds that do not match the current code/config. Review docs alongside the working tree before following runbooks.

### Main order path and loop distinction

The actual order path is operator initiated: browser dispatch → authenticated `/api/live/orders` → `IBroker`/Binance adapter → server `OrderService` → signed Binance REST API. The manager’s recurring loop reconciles broker state; it is not a strategy loop. No automated order-generating strategy was found in this snapshot.

### Overall assessment

The code has substantial safety scaffolding for a manual trading terminal: server-side order checks, durable client-order intents, explicit uncertainty states, stream/snapshot health gates, profile isolation, and exchange reconciliation. Those controls reduce some classes of operational error but should not be interpreted as a complete portfolio risk system or guarantee of safe execution. The most important follow-ups are to resolve the local-profile contract, define and test the intended production risk policy, exercise the protective-order/reverse/flatten failure cases against Testnet, and keep operational documentation synchronized with the current tree.
