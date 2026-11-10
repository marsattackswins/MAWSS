/**
 * Shared Binance USDⓈ-M Demo Trading order sizing.
 *
 * Used by scripts/testnet-smoke.ts (exchange probe) and by the Testnet
 * integration suites, so both size orders from the live exchangeInfo filters
 * at 1.5x MIN_NOTIONAL and never from a hardcoded quantity.
 *
 * Quantities and prices are built with BigInt decimal math and returned as
 * exact decimal strings formatted to the LOT_SIZE / PRICE_FILTER step, so no
 * value ever passes through a float on its way to an order.
 */

export const TESTNET_REST = "https://demo-fapi.binance.com";

export interface Dec {
  units: bigint;
  scale: number;
}

export interface MarketFilters {
  symbol: string;
  minNotional: Dec;
  lotMin: Dec;
  lotStep: Dec;
  mktMin: Dec;
  mktStep: Dec;
  tick: Dec;
}

export interface OrderPlan {
  symbol: string;
  /** Step-aligned quantity at 1.5x MIN_NOTIONAL. */
  qty: string;
  notionalUsd: number;
  targetUsd: number;
  mark: string;
  tick: Dec;
  filters: MarketFilters;
}

export interface RiskCaps {
  maxOrderNotionalUsd: number;
  maxGrossExposureUsd: number;
  maxLeverage: number;
}

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

export function parseDecimal(raw: string): Dec {
  const value = raw.trim();
  if (!DECIMAL_PATTERN.test(value)) throw new Error(`Invalid decimal value: ${raw}`);
  const negative = value.startsWith("-");
  const body = negative ? value.slice(1) : value;
  const [intPart, fracPart = ""] = body.split(".");
  const units = BigInt(`${intPart}${fracPart}`) * (negative ? -1n : 1n);
  return { units, scale: fracPart.length };
}

export function decimalToString(d: Dec): string {
  const negative = d.units < 0n;
  let digits = (negative ? -d.units : d.units).toString();
  if (d.scale === 0) return `${negative ? "-" : ""}${digits}`;
  digits = digits.padStart(d.scale + 1, "0");
  const intPart = digits.slice(0, digits.length - d.scale);
  const fracPart = digits.slice(digits.length - d.scale).replace(/0+$/, "");
  return `${negative ? "-" : ""}${intPart}${fracPart ? `.${fracPart}` : ""}`;
}

export function decimalToFixed(d: Dec, scale: number): string {
  const negative = d.units < 0n;
  let digits = (negative ? -d.units : d.units).toString();
  if (d.scale < scale) {
    digits += "0".repeat(scale - d.scale);
  } else if (d.scale > scale) {
    digits = digits.slice(0, digits.length - (d.scale - scale)) || "0";
  }
  if (scale === 0) return `${negative ? "-" : ""}${digits || "0"}`;
  digits = digits.padStart(scale + 1, "0");
  return `${negative ? "-" : ""}${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
}

/** Exact absolute value of an exchange decimal string; never goes through a float. */
export function absoluteDecimalString(raw: string): string {
  const value = raw.trim();
  if (!DECIMAL_PATTERN.test(value)) throw new Error(`Invalid decimal value: ${raw}`);
  return value.replace(/^[-+]/, "");
}

export function isZeroDecimal(raw: string): boolean {
  return parseDecimal(raw).units === 0n;
}

function scaleUnits(d: Dec, scale: number): bigint {
  if (d.scale === scale) return d.units;
  if (d.scale < scale) return d.units * 10n ** BigInt(scale - d.scale);
  return d.units / 10n ** BigInt(d.scale - scale);
}

function divCeil(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("Division by zero");
  return numerator <= 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function divRoundNearest(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("Division by zero");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const quotient = (absolute + denominator / 2n) / denominator;
  return negative ? -quotient : quotient;
}

function coarserStep(a: Dec, b: Dec): Dec {
  const scale = Math.max(a.scale, b.scale);
  const aUnits = scaleUnits(a, scale);
  const bUnits = scaleUnits(b, scale);
  return { units: aUnits > bUnits ? aUnits : bUnits, scale };
}

async function publicGet(pathname: string): Promise<unknown> {
  const res = await fetch(`${TESTNET_REST}${pathname}`);
  if (!res.ok) throw new Error(`GET ${pathname} → ${res.status}`);
  return res.json();
}

export async function readFilters(symbol: string): Promise<MarketFilters> {
  const body = (await publicGet(`/fapi/v1/exchangeInfo?symbol=${symbol}`)) as {
    symbols?: Array<Record<string, unknown>>;
  };
  const sym = body.symbols?.[0];
  if (!sym) throw new Error(`${symbol} not found in exchangeInfo`);
  const filters: Record<string, Record<string, string>> = {};
  for (const filter of (sym.filters as Array<Record<string, string>>) ?? []) filters[filter.filterType] = filter;
  return {
    symbol,
    minNotional: parseDecimal(filters.MIN_NOTIONAL?.notional ?? filters.MIN_NOTIONAL?.minNotional ?? "5"),
    lotMin: parseDecimal(filters.LOT_SIZE?.minQty ?? "0.001"),
    lotStep: parseDecimal(filters.LOT_SIZE?.stepSize ?? "0.001"),
    mktMin: parseDecimal(filters.MARKET_LOT_SIZE?.minQty ?? "0.001"),
    mktStep: parseDecimal(filters.MARKET_LOT_SIZE?.stepSize ?? "0.001"),
    tick: parseDecimal(filters.PRICE_FILTER?.tickSize ?? "0.10"),
  };
}

export async function readMark(symbol: string): Promise<string> {
  const body = (await publicGet(`/fapi/v1/premiumIndex?symbol=${symbol}`)) as Record<string, string>;
  return String(body.markPrice);
}

function notionalCovers(qtyUnits: bigint, qtyScale: number, mark: Dec, target: Dec): boolean {
  return qtyUnits * mark.units * 10n ** BigInt(target.scale)
    >= target.units * 10n ** BigInt(qtyScale + mark.scale);
}

/**
 * Sizes to 1.5x MIN_NOTIONAL using BigInt step math. The returned quantity is
 * an exact, step-aligned decimal string formatted with the LOT_SIZE step's
 * decimal places (never a float artifact such as 0.0010000000000000002).
 */
export function calcQty(
  f: MarketFilters,
  markRaw: string,
): { qty: string; notionalUsd: number; targetUsd: number } {
  const mark = parseDecimal(markRaw);
  if (mark.units <= 0n) throw new Error(`Invalid mark price for ${f.symbol}: ${markRaw}`);
  const target: Dec = { units: f.minNotional.units * 3n, scale: f.minNotional.scale + 1 };
  const step = coarserStep(f.lotStep, f.mktStep);
  const qtyScale = step.scale;
  const rawUnits = divCeil(
    target.units * 10n ** BigInt(mark.scale + qtyScale),
    mark.units * 10n ** BigInt(target.scale),
  );
  let qtyUnits = divCeil(rawUnits, step.units) * step.units;
  const lotMinUnits = scaleUnits(f.lotMin, qtyScale);
  const marketMinUnits = scaleUnits(f.mktMin, qtyScale);
  const minUnits = lotMinUnits > marketMinUnits ? lotMinUnits : marketMinUnits;
  if (qtyUnits < minUnits) qtyUnits = divCeil(minUnits, step.units) * step.units;
  for (let i = 0; i < 10 && !notionalCovers(qtyUnits, qtyScale, mark, target); i++) qtyUnits += step.units;
  const outScale = Math.max(f.lotStep.scale, qtyScale);
  const qty = decimalToFixed({ units: qtyUnits, scale: qtyScale }, outScale);
  return {
    qty,
    notionalUsd: (Number(qtyUnits) / 10 ** qtyScale) * (Number(mark.units) / 10 ** mark.scale),
    targetUsd: Number(target.units) / 10 ** target.scale,
  };
}

/** Trigger price at `pct`% of the mark, rounded to the nearest tick. */
export function priceFromPct(markRaw: string, pct: number, tick: Dec): string {
  const mark = parseDecimal(markRaw);
  const numerator = mark.units * BigInt(pct) * 10n ** BigInt(tick.scale);
  const denominator = 100n * 10n ** BigInt(mark.scale) * tick.units;
  const ticks = divRoundNearest(numerator, denominator);
  return decimalToFixed({ units: ticks * tick.units, scale: tick.scale }, tick.scale);
}

/** One live exchangeInfo + mark read, sized once per symbol per run. */
export async function planTestnetOrder(symbol: string): Promise<OrderPlan> {
  const filters = await readFilters(symbol);
  const mark = await readMark(symbol);
  const size = calcQty(filters, mark);
  return {
    symbol,
    qty: size.qty,
    notionalUsd: size.notionalUsd,
    targetUsd: size.targetUsd,
    mark,
    tick: filters.tick,
    filters,
  };
}

/**
 * Fails before an order is submitted when the manager's configured risk caps
 * cannot accommodate the sizes the suite is about to trade, naming the cap
 * that blocks instead of letting a risk rejection surface mid-test.
 *
 * `leverage` is the exchange's current per-symbol leverage when known; null
 * skips the check rather than inventing a failure from missing data.
 */
export function assertSizesWithinRiskCaps(
  caps: RiskCaps,
  orders: Array<{ symbol: string; notionalUsd: number }>,
  leverage: number | null = null,
): void {
  const usd = (value: number) => `$${value.toFixed(2)}`;
  for (const order of orders) {
    if (!Number.isFinite(order.notionalUsd) || order.notionalUsd <= 0) {
      throw new Error(`RISK_SIZING_UNKNOWN: ${order.symbol} notional could not be valued`);
    }
    if (order.notionalUsd > caps.maxOrderNotionalUsd) {
      throw new Error(
        `RISK_MAX_ORDER_NOTIONAL: ${order.symbol} order notional ${usd(order.notionalUsd)} exceeds the configured cap of ${usd(caps.maxOrderNotionalUsd)}; the exchange minimum size cannot be traded under this cap`,
      );
    }
  }
  const grossUsd = orders.reduce((total, order) => total + order.notionalUsd, 0);
  if (grossUsd > caps.maxGrossExposureUsd) {
    throw new Error(
      `RISK_MAX_GROSS_EXPOSURE: sized gross exposure ${usd(grossUsd)} exceeds the configured cap of ${usd(caps.maxGrossExposureUsd)}`,
    );
  }
  if (leverage !== null && (!Number.isFinite(leverage) || leverage < 1 || leverage > caps.maxLeverage)) {
    throw new Error(
      `RISK_MAX_LEVERAGE: current leverage ${leverage}x is outside the configured 1..${caps.maxLeverage}x cap`,
    );
  }
}
