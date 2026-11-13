# MAWS

**Market Analysis & Workflow System**

MAWS is a browser-based market-analysis and trading-workflow terminal. It brings Binance Futures market data, multi-chart analysis, technical indicators, drawings, replay, news, and an economic calendar into one workspace. Exactly two trading modes are available: **Testnet** (Binance Futures Demo) and **Live** (Binance production), subject to explicit attachment, authentication, and safety checks.

> **Disclaimer:** MAWS is personal-use trading software. It is unaudited, is not financial advice, and comes with no warranty of any kind. Trading futures can lose money, including more than you deposit. See [docs/VERIFICATION_STATUS.md](docs/VERIFICATION_STATUS.md) for what has and has not been verified against a real exchange.

> **Trading risk:** Every process starts **Disconnected**. Test exchange workflows on Testnet before considering Live. Binance API keys must not have withdrawal permission. MAWS is software, not financial advice.

## What is in the workspace

- **Market analysis:** Binance USDT-M Futures candles and quotes, a watchlist, multiple chart layouts, indicators, drawing tools, and saved templates.
- **Chart tools:** The app integrates LuxAlgo's Vela charting engine from vendored source in `lib/charting/`. It includes replay, Pine indicators through `@luxalgo/vela-pinets`, timeline marks, and chart settings.
- **Market context:** News is available through the Finnhub integration when configured; economic-calendar data is supplied by Xoomar. The Sessions card shows Tokyo, London, and New York cash-market hours (08:00–17:00 local venue time, weekdays).
- **Trading workflows:** Server-managed Testnet and Live profiles, attached only by explicit operator request. Exchange orders and positions are not browser-owned state.

The Vela workspace host is feature-flagged with `NEXT_PUBLIC_MAWS_VELA_WORKSPACE`; see `.env.example` and `components/charts/VelaWorkspaceHost.tsx` for the current integration boundary. When a saved chart template named `maws` is available, the host applies it to the initial chart cells. The vendored charting source retains its upstream Apache-2.0 `LICENSE` and `NOTICE`.

## Trading modes and attachment

| Mode | Profile ID | Trading endpoints |
|---|---|---|
| **Testnet** — Binance Futures Demo | `binance-testnet` | `demo-fapi.binance.com`, `demo-fstream.binance.com` |
| **Live** — Binance production | `binance-production` | `fapi.binance.com`, `fstream.binance.com` |

**Disconnected is not a mode.** It means no profile is attached. Every process starts Disconnected, even if one or both profiles have credentials or a previous session used Live. Login, browser restoration, and health polling never attach a profile or enable execution. Authenticated charts continue using public market data; disconnected does not mean offline.

An operator must explicitly select and attach a configured profile. Live additionally requires confirmation and the existing risk/readiness checks. Switching or detaching is refused when source exposure or uncertain state makes it unsafe. Execution must be enabled explicitly. Disconnected order submission and emergency flatten return `409 not_connected`.

**After restart, reattach before using MAWS to manage exchange exposure, or use Binance directly. Exchange-side stops stay in place; restarting MAWS does not cancel them.**

## Run locally

Requirements: Node.js 20+, npm, Git, and a modern browser.

```bash
git clone https://github.com/marsattackswins/maws.git
cd maws
npm install
```

Copy the example environment file:

```powershell
Copy-Item .env.example .env.local
```

On macOS or Linux:

```bash
cp .env.example .env.local
```

Binance credentials are optional. `MAWS_ENV` accepts only `testnet` or `production` and defaults to Testnet configuration, not an attachment. `npm run dev` binds the server to `127.0.0.1:3000` and starts it in **local dev convenience mode**: charts and public market data open without a login, while Testnet/Live connection, orders, and the admin surface still require the operator session.

```bash
npm run dev
```

### Local dev convenience mode (localhost only)

`scripts/dev.mjs` sets `MAWS_LOCAL_DEV=1` and `MAWS_LOCAL_DEV_BIND=127.0.0.1` and binds Next to loopback. In that mode, and only when the request's `Host` header is exactly `localhost:3000` or `127.0.0.1:3000`, the chart shell and the public-data proxies (`/api/binance/ticker`, `/api/binance/klines`, `/api/binance/symbols`, `/api/logo`, news, calendar) answer without a session. The exact-Host rule blocks DNS rebinding, and the outbound Binance budget plus the 429/418 cooldown still apply.

Everything account-related always requires a valid session, CSRF token, and Origin/Host checks: `/api/live/*` except an unauthenticated `GET /api/live/state` that returns only `{ attached: false, loginRequired: true }`, all `/api/admin/*`, `/admin`, protect, orders, cancel, flatten, profile switch and disconnect. Without `MAWS_LOCAL_DEV=1` — Docker, systemd, production, and e2e — every surface requires a session exactly as before. A marker on a non-loopback bind is refused at startup; it is never honored silently. Sign in at `/login?next=/` to connect Testnet or Live, and the app never attaches a profile automatically.

For an explicitly disposable session, use `npm run dev -- --throwaway`. It generates a random password, prints it once to the terminal, uses a scratch database under the OS temporary directory, and still requires real login for any account surface. It refuses Live credential components found through effective configuration, including normal environment-file loading. It never writes a temporary credential file or silently replaces normal operator authentication.

Open [http://localhost:3000](http://localhost:3000). The developer application stays on **3000** and refuses an occupied port. E2E deliberately uses **3001**, a matching allowed origin, fresh browser contexts, and isolated server state so it cannot collide with the developer workspace.

For retired configuration, follow the explicit [migration steps](docs/OPERATIONS.md#migrating-an-existing-envlocal); the launcher never rewrites configuration files or silently converts retired modes.

The browser stores workspace preferences in origin-scoped local storage. Server-side trading and audit data uses SQLite at `.maws/maws.db` by default. Keep both local working data and `.env.local` out of source control.

## Configure a server-managed Binance runtime

For an exchange-connected environment, set `MAWS_ENV=testnet` or `MAWS_ENV=production` and configure the matching profile's API key and secret in the server environment. Set `MAWS_OPERATOR_AUTH` to the generated scrypt credential; the plain password is entered at login and is not stored in the environment file.

```bash
npm run gen-operator-auth -- "choose-a-strong-password"
```

Use separate Testnet and Production keys, disable withdrawal permission, and keep all credentials server-side. Production also requires explicit confirmation. Leave execution switches disabled until the environment is intentionally configured. Never expose credentials through `NEXT_PUBLIC_*` variables or commit value-bearing environment files. Check [.env.example](.env.example) and [Security](docs/SECURITY.md) before deploying.

## Main pages

- `/` — charting and trading workspace
- `/login` — operator login for protected non-local environments
- `/admin` — operations console
- `/journal` — trade journal
- `/status` — trading-health status page

## Development checks

```bash
npm test                 # Jest application/unit suite
npm run test:charting     # Vitest suite for vendored Vela charting source
npx tsc --noEmit          # TypeScript check
npm run build             # Production build and standalone preparation
npx playwright test       # Browser workflows
npm run secret-scan       # Scan tracked/project files for likely secrets
```

Integration tests in `tests/integration/` can create and modify **Binance Testnet** orders and positions. Configure a separate `.env.integration`, check the test setup, and clean up Testnet exposure after running them. Never use Production credentials for tests.

## Project map

| Path | Responsibility |
|---|---|
| `app/` | Next.js pages and API route handlers |
| `components/` | Workspace, chart overlays, settings, trading, news, and calendar UI |
| `lib/market/` | Binance market-data feed and candle normalization |
| `lib/trading/` | Client-facing trading helpers |
| `lib/server/` | Server-only authentication, profiles, broker runtime, risk, persistence, health, and audit |
| `lib/charting/` | Vendored Vela charting engine |
| `tests/`, `lib/tests/` | Jest tests |
| `lib/charting/test/` | Vela Vitest tests |
| `tests/integration/` | Testnet integration tests |
| `e2e/` | Playwright browser tests |

For API and operations references, see [docs/](docs/). For Vela-specific details, see [lib/charting/README.md](lib/charting/README.md). The Obsidian notes in `obsidian-vault/` are local and intentionally ignored by Git; they are not included in repository clones.
