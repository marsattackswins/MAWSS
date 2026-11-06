/**
 * Shared number/currency formatters for trading panels.
 * These are pure locale utilities with no dependency on the trading engine.
 */

export function formatNum(value: number, digits = 2): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatUsd(value: number, digits = 2): string {
  const abs = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return value < 0 ? `-$${abs}` : `$${abs}`;
}
