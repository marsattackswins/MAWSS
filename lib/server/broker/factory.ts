/**
 * Broker factory: selects and instantiates the appropriate broker based on config.
 */

import "server-only";

import type { IBroker } from "./interface";
import { BinanceAdapter } from "./binance/adapter";
import { BrokerConfigError } from "./errors";
import { serverConfig, type EnvConfig } from "../env/config";
import { resetLiveManagerForTests } from "../binance/manager";
import { initializeCircuitBreakers } from "../resilience/breakers";
import { ProfileCoordinatorError } from "../profile/admission";

type BrokerType = "binance";

let brokerInstance: IBroker | null = null;
let circuitBreakersInitialized = false;

/**
 * The coordinator-owned broker. Only a profile explicitly attached through the
 * coordinator installs one; there is no config-derived fallback. Callers that
 * can run while detached must assert attachment first (not_connected).
 */
export function getBroker(): IBroker {
  // Initialize circuit breakers on first access
  if (!circuitBreakersInitialized) {
    initializeCircuitBreakers();
    circuitBreakersInitialized = true;
  }

  if (!brokerInstance) {
    throw new ProfileCoordinatorError("not_connected");
  }
  return brokerInstance;
}

/**
 * Check if a broker instance exists.
 */
export function hasBroker(): boolean {
  return brokerInstance != null;
}

/** Installs the coordinator-owned broker after the previous runtime is stopped. */
export function replaceBrokerForCoordinator(next: IBroker): void {
  brokerInstance = next;
}

export function clearBrokerForCoordinator(): void {
  brokerInstance = null;
}

/**
 * Reset broker instance (for testing).
 */
export function resetBrokerForTests(next?: IBroker): void {
  if (brokerInstance && "disconnect" in brokerInstance) {
    brokerInstance.disconnect();
  }
  resetLiveManagerForTests();
  brokerInstance = next ?? null;
}

/**
 * Create a broker instance directly (for testing or advanced usage).
 */
export function createBrokerInstance(brokerType: BrokerType, cfg?: EnvConfig): IBroker {
  const config = cfg ?? serverConfig();

  switch (brokerType) {
    case "binance":
      return new BinanceAdapter(config);
    default:
      throw new BrokerConfigError(brokerType, `Unsupported broker type: ${brokerType}`);
  }
}
