import "server-only";

import { audit } from "../audit/log";
import { redactJson } from "../audit/redact";
import { alert } from "../alerts/dispatch";
import { serverConfig, type EnvConfig } from "../env/config";
import {
  assertPersistenceProfile,
  persistenceProfileFromConfig,
  type PersistenceProfile,
} from "../profile/context";
import { healthSignals, setHealthSignal } from "../health/state";
import { log } from "../log/logger";
import { syncClock, type ClockState } from "./clock";
import { MetadataCache } from "./metadata";
import { StreamOwnerLease } from "./lease";
import { findActiveIntents, findByClientOrderId, intentsInUncertainStates, updateIntent } from "./intents";
import { OrderService, newServerClientOrderId, type ReferencePrice } from "./orders";
import { RateLimiter } from "./ratelimit";
import { BinanceRestClient, BinanceApiError } from "./rest";
import { TransportTimeoutError } from "./transport";
import { CircuitBreakerOpenError } from "../resilience/circuit-breaker";
import {
  commissionAssetsSinceUtcMidnight,
  dailyPnlSinceUtcMidnight,
  recordCommissionPrice,
  type RiskSnapshot,
} from "./risk";
import { Reconciler, checkPositionProtection, type ReconResult } from "./recon";
import { incomeLedgerIncludes, syncIncomeHistory, type IncomeSyncResult } from "./income";
import { markIncomeSyncFailed, markIncomeSyncSucceeded } from "./metrics-freshness";
import { withRiskMutationSync } from "./mutation-queue";
import { cancelAllAndFlatten, type EmergencyFlattenSummary } from "./emergency";
import { cancelOrphanedClosePositionAlgos, openClosePositionAlgoIds } from "./algo-orphans";
import { publishLive } from "./sse";
import {
  applyAccountEvent,
  applyAccountSnapshot,
  applyAlgoOrderEvent,
  applyMarkPrice,
  applyOpenOrdersSnapshot,
  applySymbolOpenOrdersSnapshot,
  applyOrderEvent,
  fillExecutionKey,
  fillExists,
  persistFill,
  rememberFill,
  hydrateFillsFromLog,
  rememberHistoricalOrder,
  applyPositionSnapshot,
  applySymbolLeverage,
  balanceUsd,
  grossExposureUsd,
  liveState,
  markAlgoStateFresh,
  markAlgoStateStale,
  openPositionCount,
  refreshPositionMarkAfterAccountUpdate, isAlgoStateStale } from "./state";
import { backfillHistoricalOrders, historySymbols, hydrateHistoricalOrders } from "./order-history";
import { getProtectionIntent, isProtectionIntentLocked, listProtectionIntents, setProtectionStatus } from "./protection";
import { StreamLeaseUnavailableError, UserDataStream } from "./stream";
import { MARK_STALE_AFTER_MS, MarkPriceStream } from "./mark-price-stream";
import type { AccountUpdateEvent, AlgoUpdateEvent, BinanceAlgoOrder, BinanceOrder, OrderTradeUpdateEvent, UserStreamEvent } from "./types";
import { getDb } from "../db/connection";
import {
  activeFreezes,
  describeActiveFreezes,
  evaluateFreezes,
  lastCleanReconAt,
  registerFreeze,
  type FreezeClearContext,
  type FreezeCode,
} from "./freeze";
import { trackFillReceived, trackFreezeTriggered, trackOrderFilled, trackSystemStart, trackSystemStop, trackUnfreezeCleared, updateTradingGauges } from "../metrics/instrument";

export type ManagerStatus = "idle" | "starting" | "ready" | "error";

const PRICE_CACHE_MS = 10_000;

/** Mark-price poll cadence for open positions; bounded REST budget. */
const MARK_PRICE_REFRESH_MS_FALLBACK = 15_000;

/**
 * Clock resync cadence: half of the 5-minute staleness threshold used by
 * clockIsHealthy / buildHealthStatus, so the signal stays fresh with margin.
 */
const CLOCK_REFRESH_MS = 2.5 * 60 * 1000;
const ACCOUNT_UPDATE_SNAPSHOT_DEBOUNCE_MS = 50;
const ACCOUNT_UPDATE_SNAPSHOT_RETRY_MS = 2_000;

/** Single retry for a failed post-ALGO_UPDATE conditional-order refresh. */
const ALGO_ORDER_REFRESH_RETRY_MS = 2_000;

export class BinanceLiveManager {
  status: ManagerStatus = "idle";
  error: string | null = null;

  readonly cfg: EnvConfig;
  readonly persistenceProfile: PersistenceProfile;
  readonly limiter: RateLimiter;
  readonly rest: BinanceRestClient;
  readonly metadata: MetadataCache;
  readonly orders: OrderService;
  private lease: StreamOwnerLease;
  private stream: UserDataStream | null = null;
  private recon: Reconciler;
  private reconTimer: ReturnType<typeof setInterval> | null = null;
  private accountUpdateSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private accountUpdateSnapshotRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private accountUpdateSnapshotPromise: Promise<void> | null = null;
  private accountUpdateSnapshotPending = false;
  private accountUpdateSnapshotRevision = 0;
  private algoOrderRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Delay before the single refresh retry; tests shorten it. */
  algoOrderRefreshRetryMs = ALGO_ORDER_REFRESH_RETRY_MS;
  private lifecycleGeneration = 0;
  /**
   * Periodic proactive clock resync. Without it the clock signal goes stale
   * after CLOCK_STALE_MS (5 min) whenever a session never trips a -1021 skew
   * error — a one-shot startup sync left any session longer than five minutes
   * showing "clock degraded" on /status.
   */
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Periodic mark-price refresh for open positions. Primary freshness now
   * comes from the public mark-price stream; this poll is the fallback for
   * stream outages, symbol-set changes, and missed events.
   */
  private markPriceTimer: ReturnType<typeof setTimeout> | null = null;
  private _markPriceStream: MarkPriceStream | null = null;
  /** Public mark-price stream (no credentials); drives per-second PnL updates. */
  get markPriceStream(): MarkPriceStream {
    if (!this._markPriceStream) {
      this._markPriceStream = new MarkPriceStream(this.cfg.env, () => this.publishMarkPriceIfChanged());
    }
    return this._markPriceStream;
  }
  private startPromise: Promise<void> | null = null;
  /** Generation the in-flight startPromise belongs to. */
  private startPromiseGeneration = 0;
  private priceCache = new Map<string, { price: string; ts: number }>();

  constructor(cfg?: EnvConfig) {
    this.cfg = cfg ?? serverConfig();
    this.persistenceProfile = persistenceProfileFromConfig(this.cfg);
    this.limiter = new RateLimiter(this.cfg.rateInternalPerMin);
    this.rest = new BinanceRestClient(this.cfg, this.limiter, async () => {
      const generation = this.lifecycleGeneration;
      await syncClock(
        async () => (await this.rest.getTime()).serverTime,
        3,
        () => this.isGenerationCurrent(generation),
        this.persistenceProfile,
      );
    });
    this.metadata = new MetadataCache(this.rest, this.persistenceProfile);
    this.lease = new StreamOwnerLease("uds", this.cfg.leaseTtlMs, this.persistenceProfile);
    this.orders = new OrderService({
      cfg: this.cfg,
      persistenceProfile: this.persistenceProfile,
      rest: this.rest,
      getConstraints: (symbol) => this.metadata.getConstraints(symbol),
      getReferencePrice: (symbol) => this.getReferencePrice(symbol),
      getMarkPrice: async (symbol) => {
        const mark = await this.rest.getMarkPrice(symbol);
        return { price: mark.markPrice, at: mark.time ?? Date.now() };
      },
      getRiskSnapshot: () => this.getRiskSnapshot(),
      fetchFreshRisk: async () => {
        const [account, positions] = await Promise.all([
          this.rest.getAccount(),
          this.rest.getPositionRisk(),
        ]);
        // The daily-loss figure needs the current USD value of any non-USD
        // commission asset, so prices are refreshed at evaluation time.
        await this.refreshCommissionPrices();
        return { account, positions };
      },
      freeze: (reason, code) => this.freeze(reason, code),
      unfreeze: () => this.unfreezeIfClear(),
      emit: (event, data) => publishLive(event, data),
    });
    this.recon = this.createReconciler(0);
  }

  private isGenerationCurrent(generation: number): boolean {
    return this.lifecycleGeneration === generation && this.status !== "idle";
  }

  private assertGeneration(generation: number): void {
    if (!this.isGenerationCurrent(generation)) throw new Error("manager startup cancelled");
  }

  private createReconciler(generation: number): Reconciler {
    return new Reconciler({
      persistenceProfile: this.persistenceProfile,
      rest: this.rest,
      snapshot: () => this.snapshot(generation),
      freeze: (reason) => {
        if (this.isGenerationCurrent(generation)) this.freeze(reason);
      },
      unfreeze: () => {
        if (this.isGenerationCurrent(generation)) this.unfreezeIfClear();
      },
      isCurrent: () => this.isGenerationCurrent(generation),
      restoreProtection: (intent) => this.orders.restoreProtection(intent),
    });
  }

  private clearTimers(): void {
    if (this.reconTimer) {
      clearInterval(this.reconTimer);
      this.reconTimer = null;
    }
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
    if (this.markPriceTimer) {
      clearTimeout(this.markPriceTimer);
      this.markPriceTimer = null;
    }
    if (this.accountUpdateSnapshotTimer) {
      clearTimeout(this.accountUpdateSnapshotTimer);
      this.accountUpdateSnapshotTimer = null;
    }
    if (this.accountUpdateSnapshotRetryTimer) {
      clearTimeout(this.accountUpdateSnapshotRetryTimer);
      this.accountUpdateSnapshotRetryTimer = null;
    }
    for (const timer of this.algoOrderRefreshTimers.values()) clearTimeout(timer);
    this.algoOrderRefreshTimers.clear();
    this.markPriceStream.stop();
  }

  private cleanupRuntime(): void {
    this.clearTimers();
    this.stream?.stop();
    this.stream = null;
  }

  private async cleanupRuntimeAndWait(): Promise<void> {
    this.clearTimers();
    const stream = this.stream;
    this.stream = null;
    if (stream) await stream.stopAndWait();
  }

  private syncClockForGeneration(generation: number): Promise<ClockState> {
    return syncClock(
      async () => (await this.rest.getTime()).serverTime,
      3,
      () => this.isGenerationCurrent(generation),
      this.persistenceProfile,
    );
  }

  /**
   * Idempotent startup with one shared in-flight promise per generation.
   * A call racing an in-flight start must NOT return that older promise:
   * it would complete with timers bound to a superseded generation, which
   * then no-ops forever (silent recon/PnL stall). Racing calls chain after
   * the older start settles (it self-cancels via its generation assert)
   * and then start fresh; the no-race path still begins synchronously.
   */
  ensureStarted(): Promise<void> {
    if (this.status === "ready") return Promise.resolve();
    if (this.startPromise && this.startPromiseGeneration === this.lifecycleGeneration) {
      return this.startPromise;
    }
    const generation = ++this.lifecycleGeneration;
    let tracked: Promise<void>;
    if (this.startPromise) {
      const prior = this.startPromise;
      tracked = prior
        .catch(() => undefined)
        .then(() => this.start(generation))
        .finally(() => {
          if (this.startPromise === tracked) this.startPromise = null;
        });
    } else {
      const startup = this.start(generation);
      tracked = startup.finally(() => {
        if (this.startPromise === tracked) this.startPromise = null;
      });
    }
    this.startPromise = tracked;
    this.startPromiseGeneration = generation;
    return tracked;
  }

  private async start(generation: number): Promise<void> {
    if (this.status === "ready") return;
    this.status = "starting";
    // A superseded in-flight start may have armed timers for a dead
    // generation; drop them before arming this generation's set.
    this.clearTimers();
    this.error = null;
    this.recon = this.createReconciler(generation);
    setHealthSignal({ managerRunning: true, brokerStatus: "starting", brokerError: null });
    let startupStream: UserDataStream | null = null;
    try {
      await this.syncClockForGeneration(generation);
      this.assertGeneration(generation);
      await this.metadata.ensureLoaded(true);
      this.assertGeneration(generation);

      // The manager is constructed only with an attached profile config, so
      // startup always runs the full authenticated path. Position mode is an
      // account invariant: keep monitoring if the check fails, but leave the
      // mode unverified so the execution gate remains closed.
      try {
        const mode = await this.rest.getPositionMode();
        this.assertGeneration(generation);
        const hedge = mode.dualSidePosition === true;
        setHealthSignal({
          positionMode: {
            mode: hedge ? "hedge" : "one-way",
            checkedAt: Date.now(),
            error: hedge ? "Hedge position mode is enabled; expected one-way mode" : null,
          },
        });
        if (hedge) {
          log.error("unexpected Binance position mode; live submissions disabled", { expected: "one-way", actual: "hedge" });
        }
      } catch (err) {
        this.assertGeneration(generation);
        setHealthSignal({ positionMode: { mode: "unknown", checkedAt: Date.now(), error: String(err) } });
        log.error("could not verify Binance position mode; live submissions disabled", { error: String(err) });
      }

      this.metadata.refreshLeverageBrackets().catch((err) => {
        if (this.isGenerationCurrent(generation)) log.warn("leverage brackets unavailable", { error: String(err) });
      });
      await this.snapshot(generation);
      this.assertGeneration(generation);
      startupStream = new UserDataStream({
        cfgEnv: this.cfg.env,
        rest: this.rest,
        lease: this.lease,
        takeSnapshot: () => this.snapshot(generation),
        processEvent: (ev) => this.processEvent(ev, generation),
        reconcile: () => this.reconcileRun("stream-buffer-overflow", generation),
        freeze: (reason, code) => {
          if (this.isGenerationCurrent(generation)) this.freeze(reason, code);
        },
        alert: (key, data) => alert(key, data),
        leaseWaitTimeoutMs: Math.max(5_000, this.cfg.leaseTtlMs + 5_000),
        onStatus: (s) => {
          if (!this.isGenerationCurrent(generation)) return;
          const stream = this.stream?.status();
          setHealthSignal({ stream: {
            connected: s.connected,
            leaseOwned: s.leaseOwned === true,
            phase: s.phase,
            startedAt: s.startedAt ?? stream?.startedAt ?? null,
            lastEventAt: s.lastEventAt ?? stream?.lastEventAt ?? null,
            lastApplicationEventAt: s.lastApplicationEventAt ?? stream?.lastApplicationEventAt ?? null,
            reconnects: s.reconnects,
            listenKeyRenewedAt: null,
            generation: s.generation ?? stream?.generation ?? 0,
            bufferOverflow: s.bufferOverflow ?? stream?.bufferOverflow ?? false,
            circuitState: s.circuitState ?? stream?.circuitState ?? "unknown",
          } });
          publishLive("stream-status", { connected: s.connected, phase: s.phase, reconnects: s.reconnects, generation: s.generation, bufferOverflow: s.bufferOverflow });
          if (!s.connected) alert("stream_down", { reconnects: s.reconnects });
        },
      });
      this.stream = startupStream;
      await startupStream.start();
      this.assertGeneration(generation);
      await this.recon.run("startup");
      this.assertGeneration(generation);
      // History hydration runs after reconciliation (whose backfill just
      // persisted fresh rows) and before the first state publish, so a
      // restart immediately exposes persisted fills and orders to
      // /api/live/state and the SSE initial snapshot. Failures are
      // non-fatal: the next recon pass persists the same rows again.
      try {
        hydrateFillsFromLog(this.persistenceProfile);
        const symbols = historySymbols(this.persistenceProfile, liveState().positions.keys());
        await backfillHistoricalOrders(this.rest, symbols, this.persistenceProfile);
        this.assertGeneration(generation);
        hydrateHistoricalOrders(this.persistenceProfile);
      } catch (err) {
        log.warn("history hydration failed", { error: String(err) });
      }
      this.reconTimer = setInterval(() => {
        if (!this.isGenerationCurrent(generation)) return;
        void this.recon.run("interval").catch((err) => {
          if (this.isGenerationCurrent(generation)) log.error("reconciliation crash", { error: String(err) });
        });
      }, this.cfg.reconIntervalMs);
      // Income ledger backfill: startup + per-recon cadence keeps lifetime
      // realized PnL, commissions, and funding fees current without touching
      // the reconciliation safety path itself. Awaited so its account-update
      // publish settles before start() returns (bounded: ≤5 pages).
      await this.syncIncome("startup", generation);
      this.assertGeneration(generation);
      publishLive("account-update", { at: Date.now() });
      // Primary: public mark-price stream for every open position.
      this.markPriceStream.syncSymbols([...liveState().positions.keys()]);
      setHealthSignal({ markPrice: this.markPriceSignal() });
      // Fallback: periodic REST poll (slower cadence than before — the
      // stream is primary now; the poll only heals gaps).
      this.markPriceTimer = setTimeout(
        () => this.markPriceLoop(),
        this.cfg.markPriceIntervalMs ?? MARK_PRICE_REFRESH_MS_FALLBACK,
      );
      this.status = "ready";
      this.startClockRefresh(generation);
      updateTradingGauges();
      trackSystemStart(this.cfg.env);
      setHealthSignal({ brokerStatus: "ready", brokerError: null });
      audit("system", "live.manager.started", { env: this.cfg.env }, undefined, this.persistenceProfile);
      log.info("live manager ready", { env: this.cfg.env });
    } catch (err) {
      if (this.isGenerationCurrent(generation)) {
        await this.cleanupRuntimeAndWait();
      } else {
        await startupStream?.stopAndWait();
      }
      if (!this.isGenerationCurrent(generation)) {
        return;
      }
      this.status = "error";
      this.error = err instanceof BinanceApiError
        ? err.exchangeMsg
        : err instanceof TransportTimeoutError
          ? "Binance request timed out"
          : err instanceof StreamLeaseUnavailableError
            ? err.message
            : err instanceof CircuitBreakerOpenError
              ? `Circuit ${err.circuitName} is open; wait for it to reset and retry`
              : err instanceof Error && err.message
                ? err.message
                : "Binance connection failed";
      setHealthSignal({ managerRunning: false, brokerStatus: "error", brokerError: this.error });
      audit("system", "live.manager.error", { error: this.error }, undefined, this.persistenceProfile);
      alert("manager_error", { error: this.error });
      log.error("live manager failed to start", { error: this.error, raw: String(err) });
      throw err;
    }
  }

  /**
   * Periodic clock resync.
   *
   * Runs at half the staleness threshold so the signal can never go stale
   * between runs. Failures are swallowed (the stale signal itself is the
   * operator-visible symptom; -1021 skew errors still trigger on-demand
   * resyncs in the REST layer).
   */
  private startClockRefresh(generation: number): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = setInterval(() => {
      if (!this.isGenerationCurrent(generation)) return;
      void (async () => {
        try {
          await this.syncClockForGeneration(generation);
        } catch (err) {
          if (this.isGenerationCurrent(generation)) {
            log.warn("periodic clock resync failed", { error: String(err) });
          }
        }
      })();
    }, CLOCK_REFRESH_MS);
  }

  stop(): void {
    void this.stopAndWait().catch(() => undefined);
  }

  /** Awaitable shutdown used by the profile coordinator. */
  async stopAndWait(): Promise<void> {
    const wasActive = this.status !== "idle" || this.startPromise !== null || this.stream !== null || this.reconTimer !== null || this.clockTimer !== null;
    if (!wasActive) return;

    this.lifecycleGeneration += 1;
    this.startPromise = null;
    this.clearTimers();
    const stream = this.stream;
    this.stream = null;
    trackSystemStop();
    this.status = "idle";
    this.error = null;
    const previousStream = healthSignals().stream;
    setHealthSignal({
      managerRunning: false,
      brokerStatus: "idle",
      brokerError: null,
      stream: previousStream
        ? { ...previousStream, connected: false, leaseOwned: false, phase: "closed" }
        : null,
    });
    if (stream) await stream.stopAndWait();
  }

  /**
   * Refreshes mark price / unrealized PnL for every open position via a
   * public premium-index REST call and republishes state. Best-effort:
   * failures are logged and left to the next tick or a reconciliation.
   */
  private async refreshPositionMarkPrices(generation: number): Promise<void> {
    const positions = [...liveState().positions.values()].filter((p) => Number(p.qty) !== 0);
    if (positions.length === 0) return;
    let changed = false;
    for (const pos of positions) {
      try {
        const t = await this.rest.getMarkPrice(pos.symbol);
        if (!this.isGenerationCurrent(generation)) return;
        applyMarkPrice(pos.symbol, t.markPrice, t.time ?? Date.now());
        changed = true;
      } catch (err) {
        if (err instanceof CircuitBreakerOpenError) throw err;
        if (err instanceof BinanceApiError) throw err;
        // Transport-level hiccup: skip this symbol, retry next tick.
        log.debug("mark-price fetch failed", { symbol: pos.symbol, error: String(err) });
      }
    }
    if (changed) {
      updateTradingGauges();
      publishLive("account-update", { at: Date.now() });
    }
    // Keep the stream subscription aligned with the current position set.
    this.markPriceStream.syncSymbols([...liveState().positions.keys()]);
    setHealthSignal({ markPrice: this.markPriceSignal() });
    publishLive("mark-price", this.markPriceSignal());
  }

  /**
   * Mark-price poller loop. Self-scheduling (setTimeout chain) instead of a
   * captured-generation setInterval: each tick re-reads the live generation,
   * so the loop survives internal generation churn while stopping cleanly
   * when the manager goes idle and on every shutdown.
   */
  private markPriceLoop(): void {
    if (this.status === "idle") return;
    const generation = this.lifecycleGeneration;
    void this.refreshPositionMarkPrices(generation)
      .catch((err) => {
        if (this.isGenerationCurrent(generation)) log.debug("mark-price refresh failed", { error: String(err) });
      })
      .finally(() => {
        if (this.status === "idle" || !this.isGenerationCurrent(generation)) return;
        this.publishMarkPriceIfChanged();
        this.markPriceTimer = setTimeout(
          () => this.markPriceLoop(),
          this.cfg.markPriceIntervalMs ?? MARK_PRICE_REFRESH_MS_FALLBACK,
        );
      });
  }

  /** Exchange truth into memory; the authoritative snapshot path. */
  async snapshot(generation = this.lifecycleGeneration): Promise<void> {
    const [account, positions, openOrders] = await Promise.all([
      this.rest.getAccount(),
      this.rest.getPositionRisk(),
      this.rest.getOpenOrders(),
    ]);
    const symbols = new Set(openOrders.map((order) => order.symbol));
    for (const position of positions) {
      if (Number(position.positionAmt) !== 0) symbols.add(position.symbol);
    }
    for (const intent of findActiveIntents(this.persistenceProfile)) {
      if (intent.kind === "algo") symbols.add(intent.symbol);
    }
    for (const intent of listProtectionIntents(this.persistenceProfile)) symbols.add(intent.symbol);
    const algoOrders: BinanceAlgoOrder[] = [];
    for (const symbol of symbols) {
      algoOrders.push(...(await this.rest.getOpenAlgoOrders(symbol)));
      markAlgoStateFresh(symbol);
    }
    if (!this.isGenerationCurrent(generation)) return;
    applyAccountSnapshot(account);
    applyPositionSnapshot(positions);
    applyOpenOrdersSnapshot(openOrders, algoOrders);
    updateTradingGauges();
    setHealthSignal({ snapshot: { fetchedAt: Date.now() } });
    publishLive("snapshot", { at: Date.now() });
  }

  private scheduleAlgoOrderRefresh(symbol: string): void {
    if (!symbol) return;
    const existing = this.algoOrderRefreshTimers.get(symbol);
    if (existing) clearTimeout(existing);
    const generation = this.lifecycleGeneration;
    const timer = setTimeout(() => {
      this.algoOrderRefreshTimers.delete(symbol);
      void this.refreshAlgoOrdersForSymbol(symbol, generation).catch((err: unknown) => {
        if (this.isGenerationCurrent(generation)) {
          log.warn("post-ALGO_UPDATE order refresh failed", { symbol, error: String(err) });
        }
      });
    }, ACCOUNT_UPDATE_SNAPSHOT_DEBOUNCE_MS);
    this.algoOrderRefreshTimers.set(symbol, timer);
  }

  /**
   * Orphaned closePosition legs: a flat symbol keeps its untriggered exit
   * order because Binance only removes the leg that fired. Only the ids the
   * live view already knew are cancelled, so a fresh position's new orders
   * (new client ids) are never touched.
   */
  private cleanupOrphanedConditionalOrders(symbols: string[], generation: number): void {
    for (const symbol of new Set(symbols)) {
      const candidateIds = openClosePositionAlgoIds(symbol);
      if (candidateIds.length === 0) continue;
      void cancelOrphanedClosePositionAlgos(symbol, candidateIds, {
        getOpenAlgoOrders: (candidate) => this.rest.getOpenAlgoOrders(candidate),
        cancelAlgoOrder: (clientAlgoId) => this.rest.cancelAlgoOrder({ clientAlgoId }),
        isSymbolFlat: () => !liveState().positions.has(symbol),
        isCurrent: () => this.isGenerationCurrent(generation),
      }, this.persistenceProfile, "account-update").catch((err: unknown) => {
        if (this.isGenerationCurrent(generation)) {
          log.warn("orphaned conditional order cleanup failed", { symbol, error: String(err) });
        }
      });
    }
  }

  /**
   * Conditional orders are only visible per symbol, so a failed read leaves
   * that symbol's protection state unknown: mark it stale (no PROTECTED claim,
   * no intent deletion) and retry once before giving up.
   */
  private async refreshAlgoOrdersForSymbol(symbol: string, generation: number, attempt = 0): Promise<void> {
    try {
      await this.refreshAlgoOrdersOnce(symbol, generation);
    } catch (err) {
      if (!this.isGenerationCurrent(generation)) return;
      markAlgoStateStale(symbol);
      if (attempt > 0) throw err;
      log.warn("post-ALGO_UPDATE order refresh failed; retrying once", { symbol, error: String(err) });
      await new Promise((resolve) => setTimeout(resolve, this.algoOrderRefreshRetryMs));
      if (!this.isGenerationCurrent(generation)) return;
      return this.refreshAlgoOrdersForSymbol(symbol, generation, attempt + 1);
    }
  }

  private async refreshAlgoOrdersOnce(symbol: string, generation: number): Promise<void> {
    const [openOrders, algoOrders] = await Promise.all([
      this.rest.getOpenOrders(symbol),
      this.rest.getOpenAlgoOrders(symbol),
    ]);
    if (!this.isGenerationCurrent(generation)) return;
    applySymbolOpenOrdersSnapshot(symbol, openOrders, algoOrders);
    markAlgoStateFresh(symbol);
    updateTradingGauges();
    publishLive("snapshot", { at: Date.now(), symbol });
    await this.checkProtectionAfterAlgoRefresh(symbol, generation);
  }

  /**
   * A conditional-order refresh makes the exchange truth for this symbol
   * current, so re-check its protection now: a TP/SL cancelled without a
   * removal reason would otherwise read as protected until the next
   * reconciliation pass.
   */
  private async checkProtectionAfterAlgoRefresh(symbol: string, generation: number): Promise<void> {
    if (!this.isGenerationCurrent(generation)) return;
    if (isProtectionIntentLocked(symbol, this.persistenceProfile)) return;
    if (isAlgoStateStale(symbol)) return;
    await checkPositionProtection(symbol, {
      persistenceProfile: this.persistenceProfile,
      isCurrent: () => this.isGenerationCurrent(generation),
    });
  }

  private scheduleAccountUpdateSnapshot(): void {
    this.accountUpdateSnapshotRevision += 1;
    if (this.accountUpdateSnapshotPromise) {
      this.accountUpdateSnapshotPending = true;
      return;
    }
    if (this.accountUpdateSnapshotRetryTimer) return;
    if (this.accountUpdateSnapshotTimer) clearTimeout(this.accountUpdateSnapshotTimer);
    const generation = this.lifecycleGeneration;
    this.accountUpdateSnapshotTimer = setTimeout(() => {
      this.accountUpdateSnapshotTimer = null;
      void this.refreshAfterAccountUpdate(generation).catch((err: unknown) => {
        if (!this.isGenerationCurrent(generation)) return;
        log.warn("post-ACCOUNT_UPDATE risk snapshot refresh failed; scheduling one retry", {
          error: String(err),
        });
        this.accountUpdateSnapshotRetryTimer = setTimeout(() => {
          this.accountUpdateSnapshotRetryTimer = null;
          void this.refreshAfterAccountUpdate(generation).catch((retryErr: unknown) => {
            if (this.isGenerationCurrent(generation)) {
              log.warn("post-ACCOUNT_UPDATE risk snapshot retry failed; risk data remains stale", {
                error: String(retryErr),
              });
            }
          });
        }, ACCOUNT_UPDATE_SNAPSHOT_RETRY_MS);
      });
    }, ACCOUNT_UPDATE_SNAPSHOT_DEBOUNCE_MS);
  }

  private async refreshAfterAccountUpdate(generation: number): Promise<void> {
    if (this.accountUpdateSnapshotPromise) {
      this.accountUpdateSnapshotPending = true;
      return this.accountUpdateSnapshotPromise;
    }

    const refresh = async (): Promise<void> => {
      do {
        this.accountUpdateSnapshotPending = false;
        const revision = this.accountUpdateSnapshotRevision;
        const [account, positions] = await Promise.all([
          this.rest.getAccount(),
          this.rest.getPositionRisk(),
        ]);
        if (!this.isGenerationCurrent(generation)) return;
        if (revision !== this.accountUpdateSnapshotRevision) {
          this.accountUpdateSnapshotPending = true;
          continue;
        }
        applyAccountSnapshot(account);
        applyPositionSnapshot(positions);
        updateTradingGauges();
        publishLive("snapshot", { at: Date.now() });
        publishLive("account-update", { at: Date.now() });
      } while (this.accountUpdateSnapshotPending && this.isGenerationCurrent(generation));
    };

    const promise = refresh();
    this.accountUpdateSnapshotPromise = promise;
    try {
      await promise;
    } finally {
      if (this.accountUpdateSnapshotPromise === promise) {
        this.accountUpdateSnapshotPromise = null;
      }
    }
  }

  private processEvent(ev: UserStreamEvent, generation = this.lifecycleGeneration): void | Promise<void> {
    if (!this.isGenerationCurrent(generation)) return;
    return withRiskMutationSync(() => {
      if (!this.isGenerationCurrent(generation)) return;
      return this.processEventUnlocked(ev);
    });
  }

  private processEventUnlocked(ev: UserStreamEvent): void {
    assertPersistenceProfile(this.persistenceProfile);
    const db = getDb();
    const eventRow = db
      .prepare(
        `INSERT INTO order_events (profile_id, ts, event_time, source, event_type, exchange_order_id, client_order_id, symbol, payload, processed)
         VALUES (?, ?, ?, 'stream', ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        this.persistenceProfile.id,
        Date.now(),
        typeof ev.E === "number" ? ev.E : null,
        ev.e,
        ev.e === "ORDER_TRADE_UPDATE"
          ? (ev as OrderTradeUpdateEvent).o.i
          : ev.e === "ALGO_UPDATE" &&
              (ev as AlgoUpdateEvent).o.ai != null &&
              (ev as AlgoUpdateEvent).o.ai !== "" &&
              Number.isFinite(Number((ev as AlgoUpdateEvent).o.ai))
            ? Number((ev as AlgoUpdateEvent).o.ai)
            : null,
        ev.e === "ORDER_TRADE_UPDATE"
          ? (ev as OrderTradeUpdateEvent).o.c
          : ev.e === "ALGO_UPDATE"
            ? (ev as AlgoUpdateEvent).o.caid ?? null
            : null,
        ev.e === "ORDER_TRADE_UPDATE"
          ? (ev as OrderTradeUpdateEvent).o.s
          : ev.e === "ALGO_UPDATE"
            ? (ev as AlgoUpdateEvent).o.s ?? null
            : null,
        redactJson(ev),
      );
    const eventId = eventRow.lastInsertRowid;

    try {
      if (ev.e === "ORDER_TRADE_UPDATE") {
        const orderEv = ev as OrderTradeUpdateEvent;
        const o = orderEv.o;
        const skipTradeIds = new Set<string>();
        if (o.l && Number(o.l) > 0) {
          const tradeId = fillExecutionKey({ symbol: o.s, tradeId: o.t, exchangeOrderId: o.i, ts: o.T, qty: o.l, price: o.L });
          if (fillExists(tradeId, this.persistenceProfile)) skipTradeIds.add(tradeId);
        }
        const fills = applyOrderEvent(orderEv, skipTradeIds);
        const persistedFills: typeof fills = [];
        db.transaction(() => {
          for (const fill of fills) {
            if (persistFill(fill, this.persistenceProfile)) persistedFills.push(fill);
          }
          this.syncIntentFromEvent(orderEv);
          db.prepare(`UPDATE order_events SET processed = 1 WHERE id = ? AND profile_id = ?`).run(eventId, this.persistenceProfile.id);
        })();
        const closedWithPnl =
          o.X === "FILLED" &&
          persistedFills.some((f) => f.realizedPnl !== "" && Number(f.realizedPnl) !== 0);
        // The realized PnL of the closing fill(s): ORDER_TRADE_UPDATE `rp`,
        // positive or negative. Used only to verify the ledger caught up.
        const closedPnlValue = persistedFills
          .map((f) => Number(f.realizedPnl))
          .find((n) => Number.isFinite(n) && n !== 0);
        for (const fill of persistedFills) {
          rememberFill(fill);
          trackFillReceived(fill.clientOrderId, fill.symbol, fill.side, fill.qty, fill.price);
          alert("fill", { symbol: fill.symbol, side: fill.side, qty: fill.qty, price: fill.price, realizedPnl: fill.realizedPnl });
        }
        // Realized PnL freshness: a persisted closing fill moves account
        // metrics only when the income ledger catches up. Nudge the sync
        // without blocking the fill transaction or the event loop; the
        // periodic sync remains the fallback and the sync itself is
        // idempotent (dedup by tranId), so a nudge racing a recon pass is
        // harmless.
        if (closedWithPnl) {
          // Carry the fill's realized PnL (ORDER_TRADE_UPDATE `rp`) into the
          // sync: positive or negative, it is the exchange's own closing-trade
          // figure and it must reach the bottom-panel Realized total without
          // waiting for the next periodic sync pass. The ledger stays the
          // source of truth; `rp` only guarantees a timely first sync.
          void this.syncIncome("closing-fill", this.lifecycleGeneration, closedPnlValue).catch(() => undefined);
        }
        if (o.X === "FILLED") {
          trackOrderFilled(o.c, o.s, o.z, o.L);
        }
        updateTradingGauges();
        publishLive("order-update", {
          clientOrderId: orderEv.o.c,
          status: orderEv.o.X,
          symbol: orderEv.o.s,
          fills: persistedFills,
        });
        if (persistedFills.length > 0) publishLive("fills", persistedFills);
      } else if (ev.e === "ALGO_UPDATE") {
        this.processAlgoUpdate(ev as AlgoUpdateEvent);
        db.prepare(`UPDATE order_events SET processed = 1 WHERE id = ? AND profile_id = ?`).run(eventId, this.persistenceProfile.id);
      } else {
        if (ev.e === "ACCOUNT_UPDATE") {
          const accountEv = ev as AccountUpdateEvent;
          const positionAmountChanged = applyAccountEvent(accountEv);
          updateTradingGauges();
          publishLive("account-update", { at: Date.now() });
          if (positionAmountChanged) this.scheduleAccountUpdateSnapshot();
          // Going flat abandons the untriggered closePosition leg: clean it up
          // now instead of waiting for the next reconciliation pass.
          const flatSymbols = accountEv.a.P.filter((p) => Number(p.pa) === 0).map((p) => p.s);
          if (flatSymbols.length > 0) this.cleanupOrphanedConditionalOrders(flatSymbols, this.lifecycleGeneration);
          // ACCOUNT_UPDATE `up` values are fill-time snapshots, not current
          // quotes. Immediately refresh the mark for every touched symbol so
          // the position's PnL becomes mark-derived again (applyMarkPrice).
          // Best-effort and async: a failed refresh leaves the safe
          // fill-fallback snapshot in place and the next mark event, premium
          // poll, or reconciliation advances it.
          const touched = accountEv.a.P.map((p) => p.s);
          void refreshPositionMarkAfterAccountUpdate(touched, async (symbol) => {
            const t = await this.rest.getMarkPrice(symbol);
            return t.markPrice;
          }).then((refreshed) => {
            if (refreshed > 0) {
              updateTradingGauges();
              publishLive("account-update", { at: Date.now() });
            }
          }).catch((err: unknown) => {
            // Fire-and-forget safety: the refresh helper already swallows
            // per-symbol fetch errors; this guards the publish step so a
            // failure here can never crash the live event loop.
            log.warn("post-ACCOUNT_UPDATE mark refresh publish failed", { error: String(err) });
          });
        } else if (ev.e === "ACCOUNT_CONFIG_UPDATE") {
          // Fires after POST /fapi/v1/leverage: record the exchange-side
          // per-symbol leverage so fill events can seed correct position rows
          // until the next authoritative position-risk snapshot.
          const ac = (ev as { ac?: { s?: string; l?: number } }).ac;
          if (ac?.s && typeof ac.l === "number") {
            applySymbolLeverage(ac.s, String(ac.l));
            publishLive("account-update", { at: Date.now() });
          }
        }
        db.prepare(`UPDATE order_events SET processed = 1 WHERE id = ? AND profile_id = ?`).run(eventId, this.persistenceProfile.id);
      }

      setHealthSignal({
        stream: {
          connected: true,
          leaseOwned: this.stream?.status().leaseOwned === true,
          phase: "live",
          startedAt: null,
          lastEventAt: Date.now(),
          lastApplicationEventAt: this.stream?.status().lastApplicationEventAt ?? null,
          reconnects: this.stream?.status().reconnects ?? 0,
          listenKeyRenewedAt: null,
          generation: this.stream?.status().generation ?? 0,
          bufferOverflow: this.stream?.status().bufferOverflow ?? false,
          circuitState: this.stream?.status().circuitState ?? "unknown",
        },
      });
    } catch (err) {
      this.freeze("user-data event processing failed; event remains unprocessed", "EVENT_PROCESSING_FAILED");
      log.error("user-data event processing failed", { error: String(err), eventId });
      throw err;
    }
  }

  private syncIntentFromEvent(ev: OrderTradeUpdateEvent): void {
    const status = ev.o.X;
    const mapped =
      status === "FILLED"
        ? "FILLED"
        : status === "CANCELED"
          ? "CANCELED"
          : status === "EXPIRED"
            ? "EXPIRED"
            : status === "REJECTED"
              ? "REJECTED"
              : status === "PARTIALLY_FILLED"
                ? "PARTIALLY_FILLED"
                : "SUBMITTED";
    const intent = findByClientOrderId(ev.o.c, this.persistenceProfile);
    if (!intent) return;
    updateIntent(ev.o.c, {
      status: mapped,
      exchangeOrderId: ev.o.i,
      lastState: JSON.stringify({ status, executedQty: ev.o.z, avgPrice: ev.o.L, source: "stream" }),
    }, Date.now(), this.persistenceProfile);
    if (mapped === "FILLED" || mapped === "CANCELED" || mapped === "EXPIRED" || mapped === "REJECTED") {
      this.unfreezeIfClear();
    }
  }

  private processAlgoUpdate(ev: AlgoUpdateEvent): void {
      const order = applyAlgoOrderEvent(ev);
      const payload = ev.o;
      const clientAlgoId = payload.caid;
      const symbol = payload.s;
      const status = payload.X ?? "UNKNOWN";
      if (clientAlgoId) {
        // FINISHED/TRIGGERED only say the conditional order fired; the actual
        // order's own status is read by reconciliation. Never infer FILLED.
        const intentStatus =
          status === "CANCELED"
            ? "CANCELED"
            : status === "REJECTED" || status === "REJECT"
              ? "REJECTED"
              : status === "EXPIRED"
                ? "EXPIRED"
                : "SUBMITTED";
        const actualOrderId =
          payload.ai != null && payload.ai !== "" && Number.isFinite(Number(payload.ai))
            ? Number(payload.ai)
            : undefined;
        if (findByClientOrderId(clientAlgoId, this.persistenceProfile)) {
          updateIntent(clientAlgoId, {
            status: intentStatus,
            ...(actualOrderId != null ? { exchangeOrderId: actualOrderId } : {}),
            lastState: JSON.stringify({
              status,
              algoId: payload.aid ?? null,
              actualOrderId: payload.ai ?? null,
              reason: payload.rm ?? null,
              source: "ALGO_UPDATE",
            }),
          }, Date.now(), this.persistenceProfile);
        }
      }

      if (
        symbol &&
        payload.rm &&
        (status === "CANCELED" || status === "REJECTED" || status === "REJECT" ||
        status === "EXPIRED") &&
        Number(liveState().positions.get(symbol)?.qty ?? "0") !== 0 &&
        getProtectionIntent(symbol, this.persistenceProfile)
      ) {
        const reason = `Binance removed protective algo order: ${payload.rm}`;
        setProtectionStatus(symbol, "UNPROTECTED", reason, this.persistenceProfile);
        audit("operator", "position.protection.algo_rejected", {
          symbol,
          clientAlgoId: clientAlgoId ?? null,
          status,
          reason: payload.rm,
          severity: "high",
        }, undefined, this.persistenceProfile);
        alert(`position_protection_algo_rejected:${symbol}`, {
          symbol,
          clientAlgoId: clientAlgoId ?? null,
          status,
          reason: payload.rm,
          severity: "high",
        });
        publishLive("account-update", { at: Date.now(), protection: symbol, status: "UNPROTECTED" });
      }

      if (order) {
        publishLive("order-update", {
          clientOrderId: order.clientOrderId,
          status: order.status,
          symbol: order.symbol,
          kind: "algo",
          algoId: order.algoId,
          exchangeOrderId: order.exchangeOrderId,
        });
      }
    if (symbol) this.scheduleAlgoOrderRefresh(symbol);
  }

  /**
   * Marks submissions frozen for one typed reason. Freezes stack: a second
   * code never overwrites an active one, and clearing one leaves the others.
   * `code` defaults to UNCERTAIN_INTENT only for legacy call sites.
   */
  freeze(reason: string, code: FreezeCode = "UNCERTAIN_INTENT", detail?: Record<string, unknown>): void {
    const inserted = registerFreeze(code, reason, { detail, profile: this.persistenceProfile });
    if (!inserted) return;
    trackFreezeTriggered(reason);
    audit("system", "live.freeze", { reason, code, detail: detail ?? null }, undefined, this.persistenceProfile);
    alert("freeze", { reason, code });
    publishLive("health", { frozen: true, reason, code });
    log.warn("submissions frozen", { reason, code });
  }

  /**
   * Re-evaluates every active freeze against its own clear rule. An order
   * event can only settle the intent reasons; recon/stream/ban reasons need
   * their own evidence (see lib/server/binance/freeze.ts).
   */
  unfreezeIfClear(): void {
    if (activeFreezes(this.persistenceProfile).length === 0) return;
    void this.evaluateFreezesNow(false).catch((err: unknown) => {
      log.warn("freeze evaluation failed", { error: String(err) });
    });
  }

  /**
   * Explicit operator unfreeze: clears OPERATOR and KEY_REJECTED outright, and
   * a migrated LEGACY row once a clean reconciliation has run since the freeze.
   */
  operatorUnfreeze(): void {
    void this.evaluateFreezesNow(true).catch((err: unknown) => {
      log.warn("operator unfreeze failed", { error: String(err) });
    });
  }

  private async evaluateFreezesNow(operatorAction: boolean): Promise<void> {
    const active = activeFreezes(this.persistenceProfile);
    if (active.length === 0) return;
    const stream = this.stream?.status();
    const ctx: FreezeClearContext = {
      now: Date.now(),
      hasUncertainIntents: intentsInUncertainStates(this.persistenceProfile).length > 0,
      lastCleanReconAt: lastCleanReconAt(this.persistenceProfile),
      // recover() only reports live/reconciled after the snapshot was applied.
      streamRecovered: stream != null && stream.connected && (stream.phase === "live" || stream.phase === "reconciled"),
      operatorAction,
    };
    // The ban window is read from REST only when an IP_BAN row exists, so the
    // normal path pays no extra request.
    if (active.some((row) => row.code === "IP_BAN")) {
      try {
        await this.rest.getTime();
        ctx.restProbeOk = true;
      } catch {
        ctx.restProbeOk = false;
      }
    }
    const result = evaluateFreezes(ctx, this.persistenceProfile);
    if (result.cleared.length === 0) return;
    const remaining = activeFreezes(this.persistenceProfile);
    if (remaining.length === 0) {
      trackUnfreezeCleared();
      audit("system", "live.unfreeze", { cleared: result.cleared, by: operatorAction ? "operator" : "automatic" }, undefined, this.persistenceProfile);
      alert("unfreeze", { cleared: result.cleared });
      publishLive("health", { frozen: false });
      log.info("submissions unfrozen", { cleared: result.cleared });
      return;
    }
    audit("system", "live.freeze.partial_unfreeze", {
      cleared: result.cleared,
      remaining: remaining.map((row) => row.code),
    }, undefined, this.persistenceProfile);
    publishLive("health", { frozen: true, reason: describeActiveFreezes(this.persistenceProfile), cleared: result.cleared });
    log.info("submissions remain frozen after partial unfreeze", { cleared: result.cleared, remaining: remaining.map((row) => row.code) });
  }

  /**
   * Refreshes the USD price of every non-USD asset that paid commission today,
   * through the same cache/ticker path as getReferencePrice. A failed lookup
   * records nothing: the day's fee total stays unavailable and risk-increasing
   * orders are rejected with EXECUTION_UNHEALTHY until a price can be read.
   */
  private async refreshCommissionPrices(): Promise<void> {
    const assets = commissionAssetsSinceUtcMidnight(Date.now(), this.persistenceProfile);
    await Promise.all(
      assets.map(async (asset) => {
        try {
          const reference = await this.getReferencePrice(`${asset}USDT`);
          if (reference) recordCommissionPrice(asset, Number(reference.price), reference.at);
        } catch {
          // Leave the asset unpriced; the risk check fails closed.
        }
      }),
    );
  }

  /** Mark/last price for collars and market-order notional, tagged with observation time. */
  async getReferencePrice(symbol: string): Promise<ReferencePrice | null> {
    const pos = liveState().positions.get(symbol);
    if (pos && pos.markPrice && Number(pos.markPrice) > 0) return { price: pos.markPrice, at: pos.updatedAt };
    const cached = this.priceCache.get(symbol);
    if (cached && Date.now() - cached.ts < PRICE_CACHE_MS) return { price: cached.price, at: cached.ts };
    try {
      const t = await this.rest.getTickerPrice(symbol);
      const now = Date.now();
      this.priceCache.set(symbol, { price: t.price, ts: now });
      return { price: t.price, at: now };
    } catch (err) {
      // Circuit-open is infrastructure, not missing data: let it propagate so
      // mutations surface 503 circuit_open instead of a business-shaped reject.
      if (err instanceof CircuitBreakerOpenError) throw err;
      return cached ? { price: cached.price, at: cached.ts } : null;
    }
  }

  getRiskSnapshot(): RiskSnapshot {
    const state = liveState();
    const now = Date.now();
    const daily = dailyPnlSinceUtcMidnight(now, this.persistenceProfile);
    const accountFresh =
      state.account !== null &&
      Number.isFinite(state.account.fetchedAt) &&
      now - state.account.fetchedAt <= this.cfg.snapshotMaxAgeMs;
    const positions = [...state.positions.values()];
    const unrealizedPnlFresh =
      accountFresh &&
      positions.every((position) =>
        position.markPriceSource === "exchange" &&
        Number.isFinite(position.updatedAt) &&
        now - position.updatedAt <= MARK_STALE_AFTER_MS &&
        Number.isFinite(Number(position.unrealizedProfit)),
      );
    const unrealizedPnlUsd = unrealizedPnlFresh
      ? positions.reduce((total, position) => total + Number(position.unrealizedProfit), 0)
      : null;
    const marginDataFresh =
      positions.length === 0 ||
      (state.account !== null &&
        Number.isFinite(state.account.marginHealthFetchedAt) &&
        now - state.account.marginHealthFetchedAt <= this.cfg.snapshotMaxAgeMs &&
        Number.isFinite(Number(state.account.marginHealthBalance)) &&
        Number(state.account.marginHealthBalance) > 0 &&
        state.account.maintenanceMargin !== "" &&
        Number.isFinite(Number(state.account.maintenanceMargin)) &&
        Number(state.account.maintenanceMargin) >= 0 &&
        positions.every(
          (position) => {
            const liquidationPrice = position.liquidationPrice.trim();
            const parsedLiquidationPrice = Number(liquidationPrice);
            return (
              position.markPriceSource === "exchange" &&
              Number.isFinite(position.updatedAt) &&
              now - position.updatedAt <= MARK_STALE_AFTER_MS &&
              typeof position.riskSnapshotFetchedAt === "number" &&
              Number.isFinite(position.riskSnapshotFetchedAt) &&
              now - position.riskSnapshotFetchedAt <= this.cfg.snapshotMaxAgeMs &&
              Number.isFinite(Number(position.markPrice)) &&
              Number(position.markPrice) > 0 &&
              (liquidationPrice === "" ||
                (Number.isFinite(parsedLiquidationPrice) && parsedLiquidationPrice >= 0))
            );
          },
        ));
    const marginRatio =
      marginDataFresh && positions.length > 0
        ? Number(state.account!.maintenanceMargin) / Number(state.account!.marginHealthBalance)
        : null;
    const liquidationDistancesPct =
      marginDataFresh
        ? positions.flatMap((position) => {
            const liquidationPrice = Number(position.liquidationPrice);
            if (!Number.isFinite(liquidationPrice) || liquidationPrice <= 0) return [];
            const markPrice = Number(position.markPrice);
            return [
              position.side === "long"
                ? ((markPrice - liquidationPrice) / markPrice) * 100
                : ((liquidationPrice - markPrice) / markPrice) * 100,
            ];
          })
        : null;
    const workingOrders = [...state.openOrders.values()]
      .map((order) => ({
        qty: order.origQty,
        effectivePrice:
          order.price !== "0"
            ? order.price
            : order.stopPrice !== "0"
              ? order.stopPrice
              : state.positions.get(order.symbol)?.markPrice ?? "0",
      }))
      .filter((item) => item.effectivePrice !== "0");
    const uncertainIntents = intentsInUncertainStates(this.persistenceProfile)
      .map((intent) => ({
        qty: intent.qty,
        effectivePrice:
          intent.price ??
          intent.stopPrice ??
          (() => {
            try {
              return (JSON.parse(intent.lastState ?? "{}") as { effectivePrice?: string }).effectivePrice ?? state.positions.get(intent.symbol)?.markPrice ?? "0";
            } catch {
              return state.positions.get(intent.symbol)?.markPrice ?? "0";
            }
          })(),
      }))
      .filter((item) => item.effectivePrice !== "0");
    return {
      balanceUsd: balanceUsd(),
      grossExposureUsd: grossExposureUsd(),
      openOrderCount: state.openOrders.size,
      openPositionCount: openPositionCount(),
      realizedTodayUsd: daily.netUsd,
      dailyRealizedPnlUsd: daily.realizedPnlUsd,
      dailyCommissionUsd: daily.commissionUsd,
      dailyFundingUsd: daily.fundingUsd,
      unrealizedPnlUsd,
      unrealizedPnlFresh,
      marginRatio,
      marginDataFresh,
      liquidationDistancesPct,
      workingOrders,
      uncertainIntents,
      commissionAssetsUnpriced: daily.commissionPricesMissing,
    };
  }

  async emergencyFlatten(triggeredBy: string): Promise<EmergencyFlattenSummary> {
    return cancelAllAndFlatten(
      this.cfg.env,
      {
        getOpenOrders: async (): Promise<BinanceOrder[]> => {
          const regular = await this.rest.getOpenOrdersEmergency();
          const algos = [...liveState().openOrders.values()]
            .filter((order) => order.kind === "algo")
            .map((order): BinanceOrder => ({
              orderId: order.exchangeOrderId ?? order.algoId ?? 0,
              clientOrderId: order.clientOrderId,
              clientAlgoId: order.clientOrderId,
              algoId: order.algoId ?? undefined,
              kind: "algo",
              symbol: order.symbol,
              side: order.side,
              type: order.type,
              status: order.status,
              price: order.price,
              stopPrice: order.stopPrice,
              origQty: order.origQty,
              executedQty: order.executedQty,
              cumQuote: "0",
              avgPrice: order.avgPrice,
              reduceOnly: order.reduceOnly,
              closePosition: order.closePosition,
              time: order.time,
              updateTime: order.updateTime,
            }));
          return [...regular, ...algos];
        },
        getOpenAlgoOrders: (symbol) => this.rest.getOpenAlgoOrdersEmergency(symbol),
        getOpenPositions: async () => (await this.rest.getPositionRiskEmergency()).filter((row) => Number(row.positionAmt) !== 0).map((row) => ({ symbol: row.symbol, positionAmt: row.positionAmt })),
        cancelAllOpenOrders: (symbol) => this.rest.cancelAllOpenOrdersEmergency(symbol),
        cancelAllAlgoOrders: (symbol) => this.rest.cancelAllAlgoOrdersEmergency(symbol),
        closePosition: (symbol, positionAmt) => this.orders.emergencyClosePosition(symbol, positionAmt),
        emit: (event, data) => publishLive(event, data),
      },
      triggeredBy,
      this.persistenceProfile,
    );
  }

  /** Manual/triggered reconciliation pass. */
  reconcileRun(trigger: string, generation = this.lifecycleGeneration): Promise<ReconResult> {
    if (!this.isGenerationCurrent(generation)) {
      const now = Date.now();
      return Promise.resolve({ result: "error", diffs: [], startedAt: now, finishedAt: now });
    }
    return this.recon.run(trigger).then(async (result) => {
      // Piggy-back the income ledger on the recon cadence (60s default) but
      // never alter the recon result or its freeze behavior.
      await this.syncIncome(trigger, generation);
      return result;
    });
  }

  private lastMarkPriceSignal: string | null = null;

  private markPriceSignal() {
    const s = this.markPriceStream.status();
    return { connected: s.connected, stale: s.stale, symbols: s.symbols.length, lastEventAt: s.lastEventAt, reconnects: s.reconnects } as const;
  }

  /** Publishes the freshness signal when the stream state changed. */
  private publishMarkPriceIfChanged(): void {
    const next = JSON.stringify(this.markPriceSignal());
    if (next === this.lastMarkPriceSignal) return;
    this.lastMarkPriceSignal = next;
    setHealthSignal({ markPrice: this.markPriceSignal() });
    publishLive("mark-price", this.markPriceSignal());
  }

  /**
   * Income-ledger sync (REALIZED_PNL / COMMISSION / FUNDING_FEE).
   * Best-effort: a failure never blocks trading, and raw exchange error text
   * is never surfaced — it stays in server logs only.
   */
  async syncIncome(
    trigger: string,
    generation = this.lifecycleGeneration,
    /** Optional realized PnL (stream `rp`) that must land in this pass. */
    mustIncludePnl?: number,
  ): Promise<IncomeSyncResult | null> {
    if (!this.isGenerationCurrent(generation)) return null;
    try {
      const result = await syncIncomeHistory(this.rest, this.persistenceProfile);
      // New ledger rows change accountMetrics (Realized/Commission/Funding).
      // Republish so connected browsers refetch state and the bottom-panel
      // totals update without waiting for an unrelated event.
      let inserted = result.inserted;
      if (inserted > 0) publishLive("account-update", { at: Date.now() });
      // Timeliness guarantee for closing fills: when the exchange ledger has
      // not yet caught up with the stream's realized PnL (e.g. a write-lagging
      // testnet REST ledger), re-query until the closing figure is present or
      // the short retry budget is spent. The ledger remains authoritative —
      // this never fabricates or overrides persisted rows.
      if (mustIncludePnl != null && Number.isFinite(mustIncludePnl) && mustIncludePnl !== 0) {
        for (let attempt = 0; attempt < 3 && !incomeLedgerIncludes(mustIncludePnl); attempt += 1) {
          const retry = await syncIncomeHistory(this.rest, this.persistenceProfile);
          inserted += retry.inserted;
        }
        if (inserted > 0) publishLive("account-update", { at: Date.now() });
      }
      // Success (even with zero new rows) clears the stale flag: retained
      // historical totals are current again.
      markIncomeSyncSucceeded();
      return result;
    } catch (err) {
      // A failed sync must never erase the durable ledger; it only marks the
      // retained totals stale so the UI does not imply freshness it lacks.
      markIncomeSyncFailed();
      log.warn("income history sync failed", { trigger, error: String(err) });
      return null;
    }
  }

  newClientOrderId(prefix: string): string {
    return newServerClientOrderId(prefix);
  }
}

let instance: BinanceLiveManager | null = null;

export function liveManager(cfg?: EnvConfig): BinanceLiveManager {
  if (!instance) instance = new BinanceLiveManager(cfg);
  return instance;
}

export function hasLiveManager(): boolean {
  return instance != null;
}

/** Installs the coordinator-owned manager after the prior manager is stopped. */
export function replaceLiveManagerForCoordinator(next: BinanceLiveManager): void {
  // The coordinator calls this only after fencing and stopping the previous
  // runtime. Keeping replacement here prevents any other module from creating
  // a second authoritative slot.
  instance = next;
}

export function clearLiveManagerForCoordinator(): void {
  instance = null;
}

/** Test seam. */
export function resetLiveManagerForTests(next?: BinanceLiveManager): void {
  instance?.stop();
  instance = next ?? null;
}
