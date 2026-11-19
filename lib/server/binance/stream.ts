import "server-only";

import { HOST_MAP } from "../env/config";
import { log } from "../log/logger";
import { getTimestamp } from "./clock";
import type { StreamOwnerLease } from "./lease";
import { BinanceApiError, ERR_LISTEN_KEY, type BinanceRestClient } from "./rest";
import { brokerClients, type WsLike } from "./transport";
import type { UserStreamEvent } from "./types";
import type { FreezeCode } from "./freeze";
import { getBinanceStreamBreaker } from "../resilience/breakers";
import { trackWsError, trackWsLag, trackWsMessage, trackWsReconnect } from "../metrics/instrument";

export interface StreamStatus {
  connected: boolean;
  leaseOwned?: boolean;
  phase: string;
  reconnects: number;
  buffering?: boolean;
  lastEventAt?: number | null;
  generation?: number;
  bufferOverflow?: boolean;
  lastApplicationEventAt?: number | null;
  startedAt?: number | null;
  circuitState?: string;
}

export interface StreamDeps {
  cfgEnv: "testnet" | "production";
  rest: BinanceRestClient;
  lease: StreamOwnerLease;
  /** REST snapshot: applies account/positions/openOrders truth to state. */
  takeSnapshot(): Promise<void>;
  /** Applies a verified event to state, persists it, emits SSE. */
  processEvent(ev: UserStreamEvent): unknown;
  /** Optional escalation after a buffer overflow has proven data loss. */
  reconcile?(): Promise<unknown>;
  freeze(reason: string, code?: FreezeCode): void;
  /** Operator-facing alert for stream recovery failures. */
  alert?(key: string, data: Record<string, unknown>): void;
  onStatus(status: StreamStatus): void;
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (h: unknown) => void;
  };
  /** Wall clock seam (protocol liveness only); defaults to Date.now. */
  now?: () => number;
  /** How long startup may wait for another process's lease to expire. */
  leaseWaitTimeoutMs?: number;
}

export class StreamLeaseUnavailableError extends Error {
  constructor() {
    super("User-data stream lease is owned by another server process");
    this.name = "StreamLeaseUnavailableError";
  }
}

const KEEPALIVE_MS = 25 * 60 * 1000;
const ROTATE_MS = 23 * 60 * 60 * 1000;
const LEASE_RETRY_MS = 1000;
const DEFAULT_LEASE_WAIT_TIMEOUT_MS = 65_000;
const MAX_BUFFER = 5000;

/**
 * Binance sends a WebSocket ping frame every 3 minutes and closes a
 * connection that has not answered a ping within 10 minutes. This client
 * assumes that documented cadence: a socket is treated as dead only when no
 * ping frame or message arrived for SERVER_PING_INTERVAL_MS * 4 (12 min,
 * above the exchange's own 10-minute cutoff). A quiet account still receives
 * pings, so idleness alone is never treated as a dead socket.
 */
export const SERVER_PING_INTERVAL_MS = 3 * 60 * 1000;
export const PING_TIMEOUT_MS = SERVER_PING_INTERVAL_MS * 4;

/** First keepalive retry delay; doubles per consecutive failure. */
const KEEPALIVE_RETRY_BASE_MS = 1_000;
/** Consecutive keepalive failures before the key is rotated. */
const MAX_KEEPALIVE_FAILURES = 3;
/** Reconnects on one listen key before it is rotated. */
const MAX_RECONNECTS_PER_KEY = 3;

/**
 * Server-owned user-data stream. Recovery is snapshot-plus-buffer. Socket
 * callbacks carry the generation that created them, so an old socket cannot
 * clear or mutate the current connection during rotation/reconnect.
 */
export class UserDataStream {
  private ws: WsLike | null = null;
  private listenKey: string | null = null;
  private listenKeyCreatedAt = 0;
  private buffering = false;
  private buffer: UserStreamEvent[] = [];
  private stopped = true;
  private reconnectAttempt = 0;
  private reconnectTimer: unknown = null;
  private keepaliveTimer: unknown = null;
  private keepaliveRetryTimer: unknown = null;
  private pingTimer: unknown = null;
  private leaseTimer: unknown = null;
  private keepaliveFailures = 0;
  private reconnectsOnCurrentKey = 0;
  private lastSocketActivityAt = 0;
  private leaseWaitResolve: (() => void) | null = null;
  private phase = "closed";
  private reconnects = 0;
  private generation = 0;
  private startedAt: number | null = null;
  private lastEventAt: number | null = null;
  private lastApplicationEventAt: number | null = null;
  private bufferOverflow = false;
  private timers: NonNullable<StreamDeps["timers"]>;

  constructor(private readonly deps: StreamDeps) {
    this.timers = deps.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private alert(key: string, data: Record<string, unknown>): void {
    if (this.deps.alert) this.deps.alert(key, data);
  }

  status(): StreamStatus & { listenKeyAgeMs: number; buffering: boolean; lastEventAt: number | null } {
    return {
      connected: this.ws != null && !this.buffering && !this.stopped,
      leaseOwned: this.deps.lease.isOwner(),
      phase: this.phase,
      buffering: this.buffering,
      reconnects: this.reconnects,
      listenKeyAgeMs: this.listenKeyCreatedAt === 0 ? 0 : Date.now() - this.listenKeyCreatedAt,
      generation: this.generation,
      bufferOverflow: this.bufferOverflow,
      lastApplicationEventAt: this.lastApplicationEventAt,
      lastEventAt: this.lastEventAt,
      startedAt: this.startedAt,
      circuitState: this.streamCircuitState(),
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.phase = "starting";
    this.startedAt = Date.now();
    const startGeneration = this.generation;
    if (!await this.acquireLease(startGeneration)) return;
    if (this.stopped || this.generation !== startGeneration) return;
    this.startLeaseRenewal();
    await this.openWithNewListenKey();
    if (this.stopped || this.generation !== startGeneration + 1) return;
    this.startKeepalive();
    this.startLivenessMonitor();
  }

  private async acquireLease(startGeneration: number): Promise<boolean> {
    const deadline = Date.now() + (this.deps.leaseWaitTimeoutMs ?? DEFAULT_LEASE_WAIT_TIMEOUT_MS);
    for (;;) {
      if (this.stopped || this.generation !== startGeneration) return false;
      if (this.deps.lease.tryAcquire()) return true;
      if (Date.now() >= deadline) {
        this.phase = "standby";
        this.notify({ connected: false, leaseOwned: false, phase: "standby" });
        throw new StreamLeaseUnavailableError();
      }
      this.phase = "standby";
      log.warn("another server instance owns the user-data stream; retrying lease acquisition");
      this.notify({ connected: false, leaseOwned: false, phase: "standby" });
      await new Promise<void>((resolve) => {
        this.leaseWaitResolve = resolve;
        this.leaseTimer = this.timers.setTimeout(() => {
          this.leaseTimer = null;
          if (this.leaseWaitResolve === resolve) this.leaseWaitResolve = null;
          resolve();
        }, LEASE_RETRY_MS);
      });
    }
  }

  stop(): void {
    void this.stopAndWait().catch(() => undefined);
  }

  /** Stops all stream resources and reports listen-key cleanup failures. */
  async stopAndWait(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    for (const h of [this.reconnectTimer, this.keepaliveTimer, this.keepaliveRetryTimer, this.leaseTimer, this.pingTimer]) {
      if (h != null) this.timers.clearTimeout(h);
    }
    this.reconnectTimer = this.keepaliveTimer = this.keepaliveRetryTimer = this.leaseTimer = this.pingTimer = null;
    const resolveLeaseWait = this.leaseWaitResolve;
    this.leaseWaitResolve = null;
    resolveLeaseWait?.();
    this.phase = "closed";
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Already closed.
      }
      this.ws = null;
    }
    const listenKey = this.listenKey;
    this.listenKey = null;
    this.deps.lease.release();
    // Lease loss must invalidate the health signal immediately; otherwise a
    // stale "connected/owned" signal could keep normal submissions open.
    this.notify({ connected: false, phase: "closed" });
    let cleanupError: unknown = null;
    if (listenKey) {
      try {
        await this.deps.rest.closeListenKey(listenKey);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) throw cleanupError;
  }

  private streamCircuitState(): string {
    try {
      return getBinanceStreamBreaker().getState();
    } catch {
      return "unknown";
    }
  }

  private notify(status: Partial<StreamStatus>): void {
    this.phase = status.phase ?? this.phase;
    this.deps.onStatus({
      connected: this.ws != null && !this.buffering && !this.stopped,
      leaseOwned: this.deps.lease.isOwner(),
      phase: this.phase,
      reconnects: this.reconnects,
      generation: this.generation,
      bufferOverflow: this.bufferOverflow,
      lastApplicationEventAt: this.lastApplicationEventAt,
      startedAt: this.startedAt,
      circuitState: this.streamCircuitState(),
      ...status,
    });
  }

  private startLeaseRenewal(): void {
    const ttl = 30_000;
    const renew = () => {
      if (this.stopped) return;
      if (!this.deps.lease.renew()) {
        log.warn("lost stream lease; stopping stream");
        this.stop();
        return;
      }
      this.leaseTimer = this.timers.setTimeout(renew, ttl);
    };
    this.leaseTimer = this.timers.setTimeout(renew, ttl);
  }

  private startKeepalive(): void {
    const tick = () => {
      if (this.stopped || !this.listenKey) return;
      const age = Date.now() - this.listenKeyCreatedAt;
      if (age > ROTATE_MS) {
        void this.openWithNewListenKey().catch((err) => {
          log.warn("listen key rotation failed", { error: String(err) });
          this.handleRotationFailure("scheduled listenKey rotation failed", err);
        });
      } else {
        void this.keepaliveOnce();
      }
      this.keepaliveTimer = this.timers.setTimeout(tick, KEEPALIVE_MS);
    };
    this.keepaliveTimer = this.timers.setTimeout(tick, KEEPALIVE_MS);
  }

  /**
   * One keepalive PUT with a short backoff retry. Three consecutive failures
   * (or -1125, the exchange saying the key is invalid) rotate the key and
   * reconnect; a failure is never just a log line.
   */
  private async keepaliveOnce(attempt = 0): Promise<void> {
    const key = this.listenKey;
    if (this.stopped || !key) return;
    try {
      await this.deps.rest.keepaliveListenKey(key);
      this.keepaliveFailures = 0;
      return;
    } catch (err) {
      this.keepaliveFailures += 1;
      const invalidKey = err instanceof BinanceApiError && err.code === ERR_LISTEN_KEY;
      log.warn("listenKey keepalive failed", { error: String(err), attempt, failures: this.keepaliveFailures });
      if (invalidKey || this.keepaliveFailures >= MAX_KEEPALIVE_FAILURES) {
        this.rotateForKeyFailure(
          invalidKey
            ? "listenKey rejected by Binance (-1125); rotating the key"
            : `${this.keepaliveFailures} consecutive listenKey keepalive failures; rotating the key`,
        );
        return;
      }
      await new Promise<void>((resolve) => {
        this.keepaliveRetryTimer = this.timers.setTimeout(() => {
          this.keepaliveRetryTimer = null;
          resolve();
        }, KEEPALIVE_RETRY_BASE_MS * 2 ** attempt);
      });
      if (this.stopped || this.listenKey !== key) return;
      return this.keepaliveOnce(attempt + 1);
    }
  }

  /** Rotates the listen key and reconnects; alerts when that cannot recover. */
  private rotateForKeyFailure(reason: string): void {
    if (this.stopped) return;
    this.keepaliveFailures = 0;
    this.deps.freeze(reason, "STREAM_DOWN");
    this.alert("listen_key_rotation", { reason, generation: this.generation });
    void this.openWithNewListenKey({ bypassBreaker: true }).catch((err) => this.handleRotationFailure(reason, err));
  }

  private handleRotationFailure(reason: string, err: unknown): void {
    log.error("listenKey rotation failed; stream cannot recover", { reason, error: String(err) });
    this.deps.freeze("listenKey rotation failed; stream cannot recover", "STREAM_DOWN");
    this.alert("listen_key_rotation_failed", { reason, error: String(err), generation: this.generation });
    this.scheduleReconnect();
  }

  /**
   * Protocol liveness: Binance pings every 3 minutes. No ping/message within
   * PING_TIMEOUT_MS means the socket is dead even though TCP looks open, so
   * reconnect. Quiet accounts still receive pings and are never flagged.
   */
  private startLivenessMonitor(): void {
    const check = () => {
      if (this.stopped) return;
      const silentFor = this.now() - this.lastSocketActivityAt;
      if (this.ws && silentFor > PING_TIMEOUT_MS) {
        log.warn("no server ping or message within the liveness limit; reconnecting", { silentFor });
        this.deps.freeze("user-data stream went silent (no server ping); reconnecting", "STREAM_DOWN");
        this.alert("stream_ping_timeout", { silentFor, generation: this.generation });
        this.reconnectsOnCurrentKey += 1;
        if (this.reconnectsOnCurrentKey > MAX_RECONNECTS_PER_KEY) {
          this.rotateForKeyFailure("stream went silent repeatedly on one listen key");
          this.pingTimer = this.timers.setTimeout(check, SERVER_PING_INTERVAL_MS);
          return;
        }
        this.dropSocketAndReconnect();
      }
      this.pingTimer = this.timers.setTimeout(check, SERVER_PING_INTERVAL_MS);
    };
    this.pingTimer = this.timers.setTimeout(check, SERVER_PING_INTERVAL_MS);
  }

  /** Abandons the current socket and reconnects with the same listen key. */
  private dropSocketAndReconnect(): void {
    const ws = this.ws;
    this.ws = null;
    // Invalidate this socket's callbacks before closing it so the close handler
    // cannot schedule a second reconnect.
    this.generation += 1;
    if (ws) {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    }
    this.phase = "reconnecting";
    this.buffering = false;
    this.buffer = [];
    this.notify({ connected: false, phase: "reconnecting" });
    this.scheduleReconnect();
  }

  /**
   * Creates a listen key and connects. `bypassBreaker` is used by recovery
   * paths (expiry, keepalive failure, rotation): the stream breaker counts
   * socket drops as failures, so routing recovery through it would block the
   * very key creation that can recover the stream.
   */
  private async openWithNewListenKey(options: { bypassBreaker?: boolean } = {}): Promise<void> {
    const operationGeneration = this.generation;
    const create = async () => {
      await this.createAndConnect(operationGeneration);
    };
    if (options.bypassBreaker) {
      await create();
      return;
    }
    await getBinanceStreamBreaker().execute(create);
  }

  private async createAndConnect(operationGeneration: number): Promise<void> {
    {
      const { listenKey } = await this.deps.rest.createListenKey();
      if (this.stopped || this.generation !== operationGeneration) {
        this.deps.rest.closeListenKey(listenKey).catch(() => undefined);
        return;
      }
      const old = this.listenKey;
      this.listenKey = listenKey;
      this.listenKeyCreatedAt = Date.now();
      this.reconnectsOnCurrentKey = 0;
      this.lastSocketActivityAt = this.now();
      this.connectWs();
      if (old && old !== listenKey) this.deps.rest.closeListenKey(old).catch(() => undefined);
    }
  }

  private connectWs(): void {
    const generation = ++this.generation;
    this.phase = "connecting";
    this.notify({ connected: false, phase: "connecting" });
    const host = HOST_MAP[this.deps.cfgEnv].uds;
    const ws = brokerClients().ws.connect(`${host}/ws/${this.listenKey}`);
    this.ws = ws;
    ws.on("open", () => this.onOpen(generation));
    ws.on("message", (data: unknown) => this.onMessage(generation, typeof data === "string" ? data : String(data)));
    ws.on("close", () => this.onDrop(generation));
    ws.on("ping", () => this.onServerActivity(generation));
    ws.on("pong", () => this.onServerActivity(generation));
    ws.on("error", (err: unknown) => {
      if (generation !== this.generation) return;
      trackWsError(String(err));
      log.warn("user-data stream error", { generation, error: String(err) });
    });
  }

  private onServerActivity(generation: number): void {
    if (generation !== this.generation || this.stopped) return;
    this.lastSocketActivityAt = this.now();
  }

  private onOpen(generation: number): void {
    if (generation !== this.generation || this.stopped) return;
    this.lastSocketActivityAt = this.now();
    this.buffering = true;
    this.phase = "snapshot";
    this.buffer = [];
    this.notify({ connected: false, phase: "snapshot" });
    void this.recover(generation);
  }

  private async recover(generation: number): Promise<void> {
    const cutoff = getTimestamp();
    try {
      await this.deps.takeSnapshot();
      if (generation !== this.generation || this.stopped) return;
      const buffered = this.buffer;
      const overflowed = this.bufferOverflow;
      this.buffer = [];
      this.buffering = false;

      if (overflowed) {
        this.deps.freeze("user-data stream buffer overflow; account data was lost", "STREAM_OVERFLOW");
        if (this.deps.reconcile) {
          try {
            const result = await this.deps.reconcile();
            if (result && typeof result === "object" && "result" in result && (result as { result?: string }).result === "ok") {
              this.bufferOverflow = false;
            }
          } catch (err) {
            log.error("buffer overflow reconciliation failed", { error: String(err) });
          }
        }
      } else {
        let applied = 0;
        for (const ev of buffered) {
          if (generation !== this.generation || this.stopped) return;
          if (typeof ev.E === "number" && ev.E > cutoff) {
            await this.deps.processEvent(ev);
            applied += 1;
          }
        }
        log.info("user-data stream recovered", { buffered: buffered.length, applied, generation });
      }
      this.reconnectAttempt = 0;
      this.reconnectsOnCurrentKey = 0;
      this.keepaliveFailures = 0;
      this.notify({ connected: true, phase: overflowed ? "reconciled" : "live" });
    } catch (err) {
      log.error("snapshot recovery failed; scheduling reconnect", { generation, error: String(err) });
      this.deps.freeze("stream snapshot recovery failed", "SNAPSHOT_FAILED");
      this.notify({ connected: false, phase: "reconnecting" });
      this.scheduleReconnect();
    }
  }

  private onMessage(generation: number, raw: string): void {
    if (generation !== this.generation || this.stopped) return;
    let parsed: UserStreamEvent;
    try {
      parsed = JSON.parse(raw) as UserStreamEvent;
    } catch {
      return;
    }
    this.lastEventAt = Date.now();
    this.lastSocketActivityAt = this.now();
    if (parsed.e === "listenKeyExpired") {
      this.handleListenKeyExpired();
      return;
    }
    trackWsMessage();
    if (typeof parsed.E === "number") trackWsLag(Math.max(0, this.lastEventAt - parsed.E));
    if (parsed.e === "ORDER_TRADE_UPDATE" || parsed.e === "ACCOUNT_UPDATE") this.lastApplicationEventAt = this.lastEventAt;
    if (this.buffering) {
      if (this.buffer.length < MAX_BUFFER) {
        this.buffer.push(parsed);
      } else if (!this.bufferOverflow) {
        this.bufferOverflow = true;
        this.deps.freeze("user-data stream buffer overflow; account data was lost", "STREAM_OVERFLOW");
        this.notify({ connected: false, phase: "buffer-overflow" });
      }
      return;
    }
    void Promise.resolve(this.deps.processEvent(parsed)).catch((err) => {
      log.error("user-data stream event processing failed", { generation, error: String(err) });
      this.deps.freeze("user-data event processing failed", "EVENT_PROCESSING_FAILED");
    });
  }

  /**
   * The exchange expired our listen key: create a new one, reconnect and
   * resnapshot, and stay frozen (LISTEN_KEY_EXPIRED) until recovery finishes.
   */
  private handleListenKeyExpired(): void {
    if (this.stopped) return;
    log.warn("listenKeyExpired event received; rotating the listen key", { generation: this.generation });
    this.deps.freeze("listenKeyExpired: rotating the user-data stream key", "LISTEN_KEY_EXPIRED");
    this.alert("listen_key_expired", { generation: this.generation });
    this.buffering = false;
    this.buffer = [];
    this.keepaliveFailures = 0;
    void this.openWithNewListenKey({ bypassBreaker: true }).catch((err) =>
      this.handleRotationFailure("listenKeyExpired rotation failed", err),
    );
  }

  private onDrop(generation: number): void {
    if (generation !== this.generation || this.stopped) return;
    this.ws = null;
    this.phase = "reconnecting";
    this.buffering = false;
    this.buffer = [];
    this.notify({ connected: false, phase: "reconnecting" });
    this.deps.freeze("user-data stream disconnected; recovering", "STREAM_DOWN");
    trackWsError("user-data socket disconnected");
    void getBinanceStreamBreaker().execute(async () => {
      throw new Error("user-data socket disconnected");
    }).catch(() => undefined);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 5));
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.timers.setTimeout(() => void this.reconnect(), delay);
  }

  private async reconnect(): Promise<void> {
    if (this.stopped || !this.deps.lease.isOwner()) return;
    if (this.reconnectsOnCurrentKey >= MAX_RECONNECTS_PER_KEY) {
      // Three failed reconnects on one key: the key itself may be dead.
      this.rotateForKeyFailure(`${this.reconnectsOnCurrentKey} failed reconnects on one listen key; rotating`);
      return;
    }
    this.reconnectsOnCurrentKey += 1;
    this.reconnects += 1;
    trackWsReconnect("socket disconnected");
    try {
      await getBinanceStreamBreaker().execute(async () => {
        this.connectWs();
      });
    } catch (err) {
      log.warn("reconnect failed", { error: String(err), circuitState: this.streamCircuitState() });
      this.notify({ connected: false, phase: "circuit-open" });
      this.scheduleReconnect();
    }
  }
}
