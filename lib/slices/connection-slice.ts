import type { Store } from "@/lib/store";
import type { BrokerId } from "@/lib/brokers";

/**
 * Minimal connection slice: tracks which broker (if any) the browser has
 * an active confirmed attachment to. Paper trading has been removed; the
 * only selectable broker is "binance" (Testnet or Production).
 *
 * The connectedBroker field is NOT persisted — a live attachment must
 * always be verified server-side after a page reload, never assumed from
 * a stale browser value. The bridge (lib/live/bridge.ts) calls
 * setConnectedBroker("binance") only after a confirmed server handshake.
 */
export type ConnectionSliceState = {
  connectedBroker: BrokerId | null;
};

export type ConnectionSliceActions = {
  setConnectedBroker: (id: BrokerId | null) => void;
};

export type ConnectionSlice = ConnectionSliceState & ConnectionSliceActions;

type RootSet = (
  partial: Partial<Store> | ((state: Store) => Partial<Store>),
) => void;

export function createConnectionSlice(set: RootSet): ConnectionSlice {
  return {
    connectedBroker: null,
    setConnectedBroker: (id) => {
      if (id === "binance") {
        // Remember which environment was last used so the restore flow knows
        // to attempt re-authentication on page reload.
        const { useLiveStore } = require("@/lib/live/store") as typeof import("@/lib/live/store");
        const env = useLiveStore.getState().environment;
        if (env === "testnet" || env === "production") {
          try {
            const profileId = env === "testnet" ? "binance-testnet" : "binance-production";
            localStorage.setItem("maws.lastLiveProfile", profileId);
          } catch {
            // localStorage not available - ignore
          }
        }
      }
      set({ connectedBroker: id });
    },
  };
}

/**
 * Rehydration normalizer for the connection slice.
 * Live attachments are never trusted from persisted state; they must be
 * re-confirmed server-side. Migrates any legacy "mock" value to null.
 */
export function normalizeConnectionRehydrate(state: Store): void {
  // Paper (mock) was removed. Any saved "mock" value becomes disconnected.
  // "binance" requires server re-verification (handled by restoreLiveSessionIfAttached).
  const saved = (state as Store & { connectedBroker?: unknown }).connectedBroker;
  if (saved === "binance") {
    // Will be confirmed or cleared by the live bridge on session restore.
    state.connectedBroker = "binance";
  } else {
    // Any other value (null, undefined, legacy "mock") becomes disconnected.
    state.connectedBroker = null;
  }
}
