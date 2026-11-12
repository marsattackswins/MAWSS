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
  // Includes legacy "mock" and "binance" claims. Preferences never authorize
  // an attachment; only the coordinator can confirm an existing runtime.
  state.connectedBroker = null;
}
