import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { ProfileRuntimeStatusDto } from "@/lib/live/types";
import { useAppStore } from "@/lib/store";
import { useLiveStore } from "@/lib/live/store";

const mockLiveApi = {
  session: jest.fn<() => Promise<unknown>>(),
  connect: jest.fn<() => Promise<unknown>>(),
  disconnect: jest.fn<() => Promise<unknown>>(),
  meta: jest.fn<() => Promise<unknown>>(),
  profiles: jest.fn<() => Promise<unknown>>(),
  profile: jest.fn<() => Promise<unknown>>(),
  switchProfile: jest.fn<(input: { profileId: string; confirmProduction: boolean; requestId: string }) => Promise<unknown>>(),
  state: jest.fn<() => Promise<unknown>>(),
  setGates: jest.fn<(input: { executionEnabled?: boolean; killSwitch?: boolean }) => Promise<unknown>>(),
};

jest.mock("@/lib/live/api", () => ({
  liveApi: mockLiveApi,
  LiveAuthError: class LiveAuthError extends Error {},
  LiveApiError: class LiveApiError extends Error {
    code: string;
    status: number;

    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  setCsrf: jest.fn(),
}));

import { connectLiveBroker, disconnectLiveBroker, restoreServerProfile, stopLiveBridgeForTests, switchLiveProfile } from "@/lib/live/bridge";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  private listeners = new Map<string, (event: MessageEvent) => void>();

  constructor() {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(name, listener);
  }

  emit(name: string, data: unknown): void {
    this.listeners.get(name)?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  close(): void {}
}

const READY_TESTNET: ProfileRuntimeStatusDto = {
  profileId: "binance-testnet",
  environment: "testnet",
  phase: "ready",
  ready: true,
  managerStatus: "ready",
  streamHealthy: true,
  executionAllowed: true,
  generation: 7,
  reasonCode: null,
};

function emptyState() {
  return { account: null, positions: [], orders: [], fills: [] };
}

describe("live broker attachment", () => {
  beforeEach(() => {
    (globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource;
    FakeEventSource.instances = [];
    stopLiveBridgeForTests();
    useAppStore.setState({ connectedBroker: null });
    useLiveStore.setState({
      attached: false,
      profileId: null,
      environment: null,
      phase: "idle",
      ready: false,
      executionAllowed: false,
      generation: 0,
      reasonCode: null,
      managerStatus: "idle",
      managerError: null,
      account: null,
      positions: [],
      orders: [],
      fills: [],
      health: null,
      notices: [],
    });
    mockLiveApi.session.mockReset();
    mockLiveApi.connect.mockReset();
    mockLiveApi.disconnect.mockReset();
    mockLiveApi.meta.mockReset();
    mockLiveApi.profiles.mockReset();
    mockLiveApi.profile.mockReset();
    mockLiveApi.switchProfile.mockReset();
    mockLiveApi.state.mockReset();
    mockLiveApi.setGates.mockReset();
  });

  test("an unauthenticated session detaches without probing live profile APIs", async () => {
    mockLiveApi.session.mockResolvedValue({ authenticated: false });

    await restoreServerProfile();

    expect(mockLiveApi.profile).not.toHaveBeenCalled();
    expect(useAppStore.getState().connectedBroker).toBeNull();
    expect(useLiveStore.getState().attached).toBe(false);
  });

  test("a failed attachment clears the app broker and live state", async () => {
    useAppStore.setState({ connectedBroker: "binance" });
    useLiveStore.setState({ attached: true, positions: [{ id: "p", symbol: "BTCUSDT" } as never] });
    mockLiveApi.session.mockResolvedValue({ authenticated: true, csrf: "csrf", env: "testnet" });
    mockLiveApi.switchProfile.mockRejectedValue(new Error("manager unavailable"));
    mockLiveApi.profile.mockResolvedValue({
      profileId: null,
      environment: null,
      phase: "idle",
      ready: false,
      managerStatus: "idle",
      streamHealthy: null,
      executionAllowed: false,
      generation: 0,
      reasonCode: null,
    });

    await expect(connectLiveBroker("binance-testnet")).resolves.toBe("error");

    expect(useAppStore.getState().connectedBroker).toBeNull();
    expect(useLiveStore.getState().attached).toBe(false);
    expect(useLiveStore.getState().positions).toEqual([]);
    expect(useLiveStore.getState().phase).toBe("idle");
  });

  test("a profile is attached only after healthy server confirmation and state load", async () => {
    mockLiveApi.session.mockResolvedValue({ authenticated: true, csrf: "csrf", env: "testnet" });
    mockLiveApi.switchProfile.mockResolvedValue(READY_TESTNET);
    mockLiveApi.profile.mockResolvedValue(READY_TESTNET);
    mockLiveApi.state.mockResolvedValue(emptyState());

    await expect(connectLiveBroker("binance-testnet")).resolves.toBe("connected");

    expect(useAppStore.getState().connectedBroker).toBe("binance");
    expect(useLiveStore.getState().attached).toBe(true);
    expect(useLiveStore.getState().profileId).toBe("binance-testnet");
    // Attachment never enables submissions on its own.
    expect(mockLiveApi.setGates).not.toHaveBeenCalled();
  });

  test("disconnect detaches live and clears the app broker", async () => {
    useAppStore.setState({ connectedBroker: "binance" });
    useLiveStore.setState({ attached: true });
    mockLiveApi.disconnect.mockResolvedValue({ ok: true });

    await disconnectLiveBroker();

    expect(useAppStore.getState().connectedBroker).toBeNull();
    expect(useLiveStore.getState().attached).toBe(false);
    expect(mockLiveApi.disconnect).toHaveBeenCalledTimes(1);
  });

  test("restores only a server-confirmed ready profile and opens its event stream", async () => {
    mockLiveApi.session.mockResolvedValue({ authenticated: true, csrf: "csrf", env: "testnet" });
    mockLiveApi.profile.mockResolvedValue(READY_TESTNET);
    mockLiveApi.state.mockResolvedValue(emptyState());

    await restoreServerProfile();

    expect(useAppStore.getState().connectedBroker).toBe("binance");
    expect(useLiveStore.getState()).toEqual(expect.objectContaining({
      attached: true,
      profileId: "binance-testnet",
      generation: 7,
      phase: "ready",
    }));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(mockLiveApi.setGates).not.toHaveBeenCalled();
  });

  test("does not restore a stale binance claim when the server has no active profile", async () => {
    useAppStore.setState({ connectedBroker: "binance" });
    mockLiveApi.session.mockResolvedValue({ authenticated: true, csrf: "csrf", env: "testnet" });
    mockLiveApi.profile.mockResolvedValue({
      profileId: null,
      environment: null,
      phase: "idle",
      ready: false,
      managerStatus: "idle",
      streamHealthy: null,
      executionAllowed: false,
      generation: 0,
      reasonCode: null,
    });

    await restoreServerProfile();

    expect(useAppStore.getState().connectedBroker).toBeNull();
    expect(useLiveStore.getState().attached).toBe(false);
  });

  test("ignores events from a fenced attachment", async () => {
    mockLiveApi.session.mockResolvedValue({ authenticated: true, csrf: "csrf", env: "testnet" });
    mockLiveApi.profile.mockResolvedValue({ ...READY_TESTNET, generation: 3 });
    mockLiveApi.state.mockResolvedValue(emptyState());

    await restoreServerProfile();
    const source = FakeEventSource.instances[0];
    source.emit("state", { account: null, positions: [{ id: "current" }], orders: [], fills: [] });
    expect(useLiveStore.getState().positions).toEqual([{ id: "current" }]);

    stopLiveBridgeForTests();
    source.emit("state", { account: null, positions: [{ id: "stale" }], orders: [], fills: [] });
    expect(useLiveStore.getState().positions).toEqual([{ id: "current" }]);
  });

  test("keeps the confirmed profile visible while switching and sends only the typed target", async () => {
    const previous: ProfileRuntimeStatusDto = { ...READY_TESTNET, generation: 3 };
    const target: ProfileRuntimeStatusDto = { ...previous, profileId: "binance-production", environment: "production", generation: 4 };
    let resolveSwitch: (value: unknown) => void = () => undefined;
    const switchPromise = new Promise<unknown>((resolve) => {
      resolveSwitch = resolve;
    });
    mockLiveApi.session.mockResolvedValue({ authenticated: true, csrf: "csrf", env: "testnet" });
    mockLiveApi.profile.mockResolvedValue(target);
    mockLiveApi.switchProfile.mockReturnValue(switchPromise);
    mockLiveApi.state.mockResolvedValue(emptyState());
    useLiveStore.getState().setProfileRuntime(previous);
    useLiveStore.getState().setAttached(true);
    useAppStore.setState({ connectedBroker: "binance" });

    const switching = switchLiveProfile("binance-production", true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useLiveStore.getState()).toEqual(expect.objectContaining({
      profileId: "binance-testnet",
      phase: "switching",
      ready: false,
    }));
    expect(useAppStore.getState().connectedBroker).toBe("binance");
    expect(mockLiveApi.switchProfile).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "binance-production",
      confirmProduction: true,
    }));

    resolveSwitch(target);
    await expect(switching).resolves.toBe("ready");
    expect(useLiveStore.getState()).toEqual(expect.objectContaining({
      profileId: "binance-production",
      generation: 4,
      phase: "ready",
      ready: true,
    }));
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
