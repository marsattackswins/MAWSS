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

/**
 * The one sign rule for P&L numbers: an explicit sign always, and zero counts
 * as positive (+0.00), so a column never mixes signed and unsigned values.
 */
export function formatSignedNum(value: number, digits = 2): string {
  return `${value >= 0 ? "+" : ""}${formatNum(value, digits)}`;
}

export function formatSignedUsd(value: number, digits = 2): string {
  return `${value >= 0 ? "+" : ""}${formatUsd(value, digits)}`;
}
