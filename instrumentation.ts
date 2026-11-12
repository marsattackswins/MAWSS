/**
 * Server startup hook (Next 16 instrumentation). Runs once per server
 * process; heavy modules are dynamically imported so Edge/other runtimes and
 * the local/mock environment never pay for them.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { log } = await import("@/lib/server/log/logger");

  // Mirror stdout/stderr into an in-memory ring buffer for the /admin
  // "Terminal logs" panel. Must run before the first log line is emitted.
  const { installTerminalCapture } = await import("@/lib/server/log/terminal-capture");
  installTerminalCapture();

  // An explicitly started server always means "run": clear a stale
  // desired=off so the supervisor will (re)start it next time.
  const { markRunning } = await import("@/lib/server/app-power");
  try {
    markRunning();
  } catch {
    // State file is best-effort; never block startup on it.
  }

  log.info("server startup routines initializing...");

  const { serverConfig } = await import("@/lib/server/env/config");
  let cfg;
  try {
    cfg = serverConfig();
    log.info("server config loaded", { env: cfg.env });
  } catch (err) {
    log.error(`invalid server configuration: ${String(err)}`);
    return;
  }

  // Live monitoring runs only while a profile is attached. Startup itself
  // touches no exchange: circuit breakers start closed and idle, and the
  // Binance manager is constructed exclusively by the profile coordinator
  // when the operator explicitly attaches Testnet/Live.
  log.info("circuit breakers initializing...");
  const { initializeCircuitBreakers } = await import("@/lib/server/resilience/breakers");
  initializeCircuitBreakers();

  // Signal handlers release the user-data stream lease and checkpoint the DB
  // on Ctrl+C / SIGTERM so the next server instance can attach immediately.
  const { installGracefulShutdown } = await import("@/lib/server/shutdown");
  installGracefulShutdown();

  // Startup never attaches a Binance profile: every process begins
  // Disconnected and the operator attaches Testnet/Live explicitly (the
  // coordinator is the only path that starts a manager).

  // Nightly encrypted online backup with restore verification.
  if (cfg.backupKey) {
    const { createEncryptedBackup } = await import("@/lib/server/db/backup");
    const DAY_MS = 24 * 60 * 60 * 1000;
    const timer = setInterval(() => {
      createEncryptedBackup().catch((err) => {
        log.error(`backup failed: ${String(err)}`);
      });
    }, DAY_MS);
    timer.unref?.();
  }

  log.info("server startup sequence completed (Disconnected — no profile attached)");
}
