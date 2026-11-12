# MAWS Documentation

**Market Analysis & Workflow System**

MAWS is a local multi-chart terminal for market analysis and trading workflows with live trading capabilities through broker integration.

## Overview

MAWS provides a secure, browser-based interface for cryptocurrency futures trading with real-time market data, order management, position tracking, and risk controls. It supports multiple deployment modes from local chart-only mode to production execution.

### Key Features

- **Multi-Chart Terminal**: Simultaneous chart analysis with custom indicators and drawings (powered by LuxAlgo's Vela charting engine)
- **Live Trading**: Direct integration with Binance USD-M Futures (testnet and production)
- **Broker Abstraction**: Extensible interface for multi-broker support (currently Binance)
- **Risk Management**: Configurable risk limits, price collars, and execution gates
- **Circuit Breakers**: Automatic failure isolation and recovery for external dependencies
- **Real-time Events**: Server-sent events for live order/position/account updates
- **Metrics & Observability**: In-memory metrics collection with P&L tracking
- **Secure Authentication**: Operator credential system with session management

## Architecture

```mermaid
graph TB
    subgraph "Client Layer"
        UI[Next.js Frontend]
        Charts[Vela Charting Engine]
    end

    subgraph "API Layer"
        Auth[Auth API]
        Live[Live Trading API]
        Admin[Admin API]
        Health[Health API]
        Market[Market Data API]
    end

    subgraph "Server Layer"
        Broker[Broker Abstraction]
        Binance[Binance Adapter]
        AuthSvc[Auth Service]
        Risk[Risk Engine]
        Recon[Reconciliation]
        Circuit[Circuit Breakers]
        Metrics[Metrics Collector]
        DB[SQLite DB]
    end

    subgraph "External"
        BinanceAPI[Binance REST API]
        BinanceWS[Binance WebSocket]
    end

    UI --> Auth
    UI --> Live
    UI --> Admin
    UI --> Health
    UI --> Market

    Auth --> AuthSvc
    Live --> Broker
    Admin --> Metrics
    Admin --> Circuit
    Health --> Broker

    Broker --> Binance
    Binance --> BinanceAPI
    Binance --> BinanceWS

    Broker --> Risk
    Broker --> Recon
    Broker --> Circuit
    Broker --> Metrics
    Broker --> DB

    Risk --> DB
    Recon --> DB
    Metrics --> DB
```

## Key Concepts

### Deployment Modes

MAWS supports exactly two trading modes:

- **Testnet**: Binance USD-M Futures Demo. Requires `MAWS_OPERATOR_AUTH` and Testnet profile credentials to attach.
- **Production**: Binance Live. Requires all risk limits, execution gates, and explicit confirmation to attach.

`MAWS_ENV` selects which credentials are read and which environment is displayed; it never attaches anything. Both modes start **Disconnected** (no profile, no server-side trading manager). The operator attaches a profile explicitly from the Trade screen after signing in, and detaches explicitly or by disconnecting. `local`, `shadow`, and `paper` are retired and rejected with an actionable startup error rather than converted silently. Binance credentials remain server-side.

### Broker Abstraction

The system uses a broker-agnostic interface (`IBroker`) that normalizes operations across exchanges:

- Normalized types: `"buy"/"sell"` instead of `"BUY"/"SELL"`
- Event-driven updates via SSE instead of polling
- Async initialization with connection lifecycle management
- Stateless operations with external state authority

### Charting Engine

MAWS uses LuxAlgo's Vela charting library (Apache-2.0) as its primary charting engine. The vendored source lives in `lib/charting/` and is consumed directly by the app:

- **Multi-cell workspace**: Grid layout with synchronized crosshair, viewport, symbol, and timeframe
- **Native indicators**: Bollinger Bands, MACD, RSI, order blocks, PMO, volume profiles, and more
- **Drawing tools**: Trend lines, horizontal lines, rectangles, fib retracements, and custom drawings
- **Event marks**: Economic calendar releases and news headlines on the timeline
- **Replay mode**: Historical playback with seek controls and bar-by-bar stepping
- **Layout persistence**: Save and restore workspace layouts with drawings and settings
- **Pine Script support**: Execute TradingView-style Pine indicators via @luxalgo/vela-pinets

The Vela integration is documented in `docs/vela-integration-audit.md` and `lib/charting/README.md`. The engine's own test suite runs via `npm run test:charting` (vitest), while the app's jest suite mocks the engine via `__mocks__/vela.js`.

### Circuit Breakers

Three independent circuit breakers protect against cascading failures:

- **REST API Breaker**: Opens after 5 failures in 60s, retries after 30s
- **WebSocket Stream Breaker**: Opens after 3 failures in 5min, retries after 60s
- **Reconciliation Breaker**: Opens after 3 failures in 10min, retries after 120s

### Risk Controls

Multiple layers of risk protection:

- **Static Limits**: Configurable max order notional, gross exposure, open orders/positions
- **Price Collars**: Rejects orders with prices outside acceptable percentage
- **Execution Gates**: Runtime flag required for production submissions
- **Daily Loss Limits**: Percentage-based daily loss protection

## Data Flow

### Order Submission Flow

```mermaid
sequenceDiagram
    participant UI as Browser UI
    participant API as Live API
    participant Broker as Broker Service
    participant Risk as Risk Engine
    participant Exchange as Binance API
    participant Stream as WebSocket Stream
    participant SSE as SSE Bus

    UI->>API: POST /api/live/orders
    API->>API: Authenticate session
    API->>API: Validate request schema
    API->>Broker: submitOrder()
    Broker->>Risk: Check risk limits
    Risk-->>Broker: Approved/Rejected
    Broker->>Exchange: REST API call
    Exchange-->>Broker: Order accepted
    Broker->>DB: Persist order state
    Broker->>SSE: Emit order-update event
    SSE-->>UI: SSE event
    Stream->>Broker: WebSocket fill update
    Broker->>SSE: Emit fill event
    SSE-->>UI: SSE event
```

### Authentication Flow

```mermaid
sequenceDiagram
    participant UI as Browser UI
    participant API as Auth API
    participant Auth as Auth Service
    participant DB as SQLite DB

    UI->>API: POST /api/auth/login
    API->>API: Check origin/host
    API->>API: Rate limit by IP
    API->>Auth: verifyOperatorPassword()
    Auth-->>API: Valid/Invalid
    API->>Auth: createSession()
    Auth->>DB: Store session
    Auth-->>API: sessionId + csrfToken
    API-->>UI: Set session cookie
    UI->>API: Subsequent requests
    API->>Auth: validateSession()
    Auth-->>API: Session valid
```

## Deployment Model

### Local Development

```bash
npm run dev
```

- Runs on http://localhost:3000
- Starts Disconnected; startup, login, and hydration never attach a profile
- Testnet or Live can be attached from the Trade screen after operator login
- `npm run dev` requires configured operator authentication (`MAWS_OPERATOR_AUTH`); `npm run dev -- --throwaway` uses a scratch database and prints a random password once
- SQLite database in `.maws/maws.db`

### Production Deployment

MAWS is designed for deployment behind a reverse proxy (nginx):

1. **Environment Configuration**: Set `MAWS_ENV=testnet` or `MAWS_ENV=production` for credentials and risk defaults. The server still starts Disconnected; attach the configured profile from the UI after signing in. There is no `local` deployment mode.
2. **Reverse Proxy**: nginx handles TLS, static files, and proxying to Next.js
3. **Service Management**: systemd service for process management
4. **Database**: SQLite with WAL mode for performance
5. **Backups**: Encrypted backups with AES-256 key

### Docker Deployment

A Dockerfile is provided for containerized deployment:

```bash
docker build -f deploy/Dockerfile -t maws .
docker run -p 3000:3000 --env-file .env maws
```

## Security Model

### Authentication

- **Operator Credentials**: Scrypt-hashed password with salt stored in environment
- **Session Management**: Secure HTTP-only cookies with CSRF tokens
- **Origin Validation**: Strict origin/host checking to prevent CSRF
- **Rate Limiting**: Per-IP rate limiting on login attempts

### Data Protection

- **Secrets Management**: All secrets in environment variables, never in code
- **Database Permissions**: SQLite file with mode 0600 (owner read/write only)
- **Backup Encryption**: AES-256 encryption for database backups
- **Credential Isolation**: Broker credentials never exposed to client

### Network Security

- **Allowed Origins**: Single trusted origin configurable via environment
- **Proxy Trust**: Optional proxy mode for reverse proxy deployments
- **Health Token**: Shared token for external monitoring without session
- **TLS**: Recommended for all non-local deployments

### Risk Controls

- **Attachment Enforcement**: Every mode starts Disconnected; order, cancel, close, and emergency-flatten paths reject with `409 not_connected` until an operator attaches a profile and passes exposure checks
- **Production Requirements**: All risk limits must be positive finite numbers
- **Execution Gates**: Dual requirement (static env var + runtime flag); attaching a profile never enables submissions by itself
- **Mutual Exclusion**: Exactly one profile can be attached at a time; switching is serialized by the coordinator

## Runbook

### Starting the System

#### Local Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

The development server starts Disconnected and serves the MAWS dashboard at `http://localhost:3000`.

For a local production-like run, build and start the standalone server:

```bash
npm run build
npm start
```

The standalone launcher loads `.env.local` and `.env`, copies the required static assets, and resolves the default database to `.maws/maws.db`. Stop `npm start` before rebuilding on Windows to avoid file locks.

#### Production

```bash
# Selects credentials and risk defaults; the server still starts Disconnected
export MAWS_ENV=testnet   # or production
export MAWS_OPERATOR_AUTH=<salt:hash>
export MAWS_BINANCE_TESTNET_API_KEY=<testnet-key>
export MAWS_BINANCE_TESTNET_API_SECRET=<testnet-secret>
export MAWS_BINANCE_PRODUCTION_API_KEY=<production-key>
export MAWS_BINANCE_PRODUCTION_API_SECRET=<production-secret>
# ... other required variables

# Attach Testnet or Live from the UI after signing in.
# production additionally requires explicit risk limits and execution gates.

# Build and start
npm run build
npm start
```

Or using systemd:

```bash
sudo systemctl start maws
sudo systemctl enable maws
```

### Stopping the System

#### Development

Ctrl+C in the terminal running `npm run dev`

#### Production

```bash
sudo systemctl stop maws
```

### Environment Variables

Critical environment variables (see `.env.example` for complete list):

- `MAWS_ENV`: Deployment mode (local|testnet|shadow|production)
- `MAWS_DEFAULT_PROFILE`: Safe profile metadata default (binance-testnet unless explicitly set)
- `MAWS_OPERATOR_AUTH`: Operator credential hash
- `MAWS_BINANCE_TESTNET_API_KEY/SECRET`: Separate testnet credentials

- `MAWS_BINANCE_PRODUCTION_API_KEY/SECRET`: Separate production credentials

- `MAWS_RISK_*`: Risk limit configurations
- `MAWS_CB_*`: Circuit breaker configurations

### Health Checks

#### Liveness Check (anonymous)

```bash
curl http://localhost:3000/api/liveness
# {"status":"ok"} — no configuration or broker details
```

#### Authenticated Health Check

```bash
curl -H "Cookie: maws_session=<session>" http://localhost:3000/api/health
```

Response includes:
- Environment mode
- Server trading-manager and broker state
- Clock, private stream, and reconciliation health
- Execution gate state
- Circuit breaker states

For public Binance reachability, use `GET /api/health/broker`; it performs a lightweight Binance public API ping. While Disconnected, the public API can be reachable while the server trading manager is idle. The Operations Console (`/admin`) presents those as separate blocks so an idle server trading manager is not mistaken for a disconnected chart feed.

#### Health Check with Token

```bash
curl -H "x-maws-health-token: <token>" http://localhost:3000/api/health
```

#### Admin Metrics

```bash
curl http://localhost:3000/api/admin/metrics
```

### Troubleshooting

#### Broker Connection Issues

**Symptom**: "Could not reach the exchange" error

**Causes**:
- Invalid API credentials
- Network connectivity issues
- Binance API rate limiting
- Circuit breaker open

**Resolution**:
1. Check broker health: `GET /api/health/broker`
2. Verify credentials in environment
3. Check circuit breaker status: `GET /api/admin/circuits`
4. Review server logs for specific errors

#### Authentication Failures

**Symptom**: 401/403 errors on login or API calls

**Causes**:
- Invalid operator password
- Session expired
- Origin/host mismatch
- Rate limiting

**Resolution**:
1. Verify `MAWS_OPERATOR_AUTH` format
2. Check browser console for origin errors
3. Clear cookies and retry
4. Check server logs for audit trail

#### Order Rejections

**Symptom**: Orders rejected with 422 status

**Causes**:
- Risk limit breach
- Price collar violation
- Execution gate closed
- Invalid order parameters
- Circuit breaker open

**Resolution**:
1. Check risk limits in configuration
2. Verify order parameters match symbol constraints
3. Ensure execution gate is enabled: `POST /api/live/gates`
4. Check circuit breaker status
5. Review specific error message in response

#### Stream Disconnections

**Symptom**: SSE events stop arriving

**Causes**:
- WebSocket connection failure
- Network issues
- Binance listen key expiration
- Circuit breaker open

**Resolution**:
1. Check stream status: `GET /api/live/stream-status`
2. Verify broker is connected: `GET /api/health`
3. Check circuit breaker status
4. Manual reconnect: `POST /api/live/connect`

#### Database Issues

**Symptom**: Errors related to database operations

**Causes**:
- File permissions
- Disk space
- Corruption

**Resolution**:
1. Check `.maws/maws.db` file permissions (should be 0600)
2. Verify disk space available
3. Restore from backup if needed: `node scripts/restore-backup.mjs`

#### Circuit Breaker Issues

**Symptom**: Operations rejected with "circuit open" errors

**Causes**:
- Too many failures in time window
- External service degradation
- Network issues

**Resolution**:
1. Check circuit status: `GET /api/admin/circuits`
2. Wait for automatic recovery timeout
3. Manual reset (cautious): `POST /api/admin/circuits/reset`
4. Address root cause of failures

### Backup and Restore

#### Create Backup

Backups are created automatically via scheduled jobs or manually:

```bash
# Manual backup (requires MAWS_BACKUP_KEY set)
node scripts/backup.mjs
```

Backups are stored in `.maws/backups/` with `.db.enc` extension.

#### Restore from Backup

```bash
# Dry run to verify
node scripts/restore-backup.mjs .maws/backups/<file>.db.enc --dry-run

# Actual restore
node scripts/restore-backup.mjs .maws/backups/<file>.db.enc
```

### Incident Response

#### Critical: Orders Not Executing

1. Immediately check execution gate: `GET /api/health`
2. Verify circuit breakers: `GET /api/admin/circuits`
3. Check broker connection: `GET /api/health/broker`
4. Review recent fills and order status
5. If urgent, manually close positions via exchange UI

#### Critical: Unexpected Position State

1. Trigger manual reconciliation: `POST /api/live/reconcile`
2. Compare broker state with local state
3. Check for fills missed by stream
4. Review audit logs for discrepancies

#### High: Stream Degradation

1. Check stream status: `GET /api/live/stream-status`
2. Monitor reconnection attempts
3. Check WebSocket circuit breaker
4. Consider manual reconnect if needed

#### Medium: Performance Issues

1. Check metrics: `GET /api/admin/metrics`
2. Review API latency histograms
3. Check database query performance
4. Monitor memory usage

## Additional Documentation

- [Architecture Details](ARCHITECTURE.md) - Module design, dependencies, and sequence diagrams
- [API Reference](API.md) - Complete API endpoint documentation
- [Operations Guide](OPERATIONS.md) - Environment variables, configuration, and operational procedures
- [Developer Guide](DEVELOPER.md) - Local setup, testing, and development workflow
- [Security Model](SECURITY.md) - Authentication, secrets, and security practices
- [Architecture Decisions](DECISIONS/) - ADRs for major technical choices
- [Runbooks](runbooks/) - Operational runbooks for common procedures
- [Vela Integration Audit](vela-integration-audit.md) - Detailed audit of the Vela charting engine integration

## See Also

- [Obsidian Vault](../obsidian-vault/Home.md) - Interactive documentation with linked notes and diagrams
