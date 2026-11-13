/**
 * Disconnected network policy — the contract this app promises while no profile
 * is attached: only unsigned, unauthenticated GETs to public market endpoints,
 * plus the logo lookups the UI already makes. Nothing order-, account- or
 * listenKey-shaped, no Demo Trading host, no WebSocket.
 *
 * e2e/server-network-guard.cjs blocks every real Binance host in the server
 * process and appends one line per attempt, so the policy is checked against
 * what the app actually tried to send rather than against source inspection.
 * e2e/disconnected-network-policy.spec.ts drives a Disconnected session (after
 * logging in through the real operator route) and asserts this list is empty.
 */
export interface GuardEntry {
  /** ISO timestamp written by the guard. */
  at: string;
  /** fetch | http | https | websocket … */
  kind: string;
  url: string;
  method: string;
  /** X-MBX-APIKEY was present on the blocked request. */
  hasApiKey: boolean;
  /** X-MBX-SIGNATURE or a `signature=` query parameter was present. */
  hasSignature: boolean;
}

interface AllowedRequest {
  name: string;
  kind: RegExp;
  method: RegExp;
  url: RegExp;
}

/**
 * The only outbound traffic a Disconnected app may originate. Every entry is a
 * public, unsigned read: the 24h ticker and klines the chart needs, the symbol
 * catalogue and clock, and the three public `bapi` logo lookups.
 */
export const ALLOWED_REQUESTS: readonly AllowedRequest[] = [
  {
    name: "exchangeInfo",
    kind: /^(fetch|https)$/,
    method: /^GET$/,
    url: /^https:\/\/fapi\.binance\.com\/fapi\/v1\/exchangeInfo(\?|$)/,
  },
  {
    name: "ticker24hr",
    kind: /^(fetch|https)$/,
    method: /^GET$/,
    url: /^https:\/\/fapi\.binance\.com\/fapi\/v1\/ticker\/24hr(\?|$)/,
  },
  {
    name: "klines",
    kind: /^(fetch|https)$/,
    method: /^GET$/,
    url: /^https:\/\/fapi\.binance\.com\/fapi\/v1\/klines(\?|$)/,
  },
  {
    name: "time",
    kind: /^(fetch|https)$/,
    method: /^GET$/,
    url: /^https:\/\/fapi\.binance\.com\/fapi\/v1\/time(\?|$)/,
  },
  {
    name: "premiumIndex",
    kind: /^(fetch|https)$/,
    method: /^GET$/,
    url: /^https:\/\/fapi\.binance\.com\/fapi\/v1\/premiumIndex(\?|$)/,
  },
  {
    // The logo route POSTs to this one endpoint (a read, despite the verb).
    name: "symbol-logo",
    kind: /^(fetch|https)$/,
    method: /^POST$/,
    url: /^https:\/\/www\.binance\.com\/bapi\/[a-z]+\/v[0-9]+\/public\/[A-Za-z0-9/_-]+(\?|$)/,
  },
  {
    name: "public-bapi",
    kind: /^(fetch|https)$/,
    method: /^GET$/,
    url: /^https:\/\/www\.binance\.com\/bapi\/[a-z]+\/v[0-9]+\/public\/[A-Za-z0-9/_-]+(\?|$)/,
  },
];

/** Paths that may never be touched while disconnected, even unsigned. */
const FORBIDDEN_PATH =
  /\/listenKey|\/userData|userDataStream|\/fapi\/v[0-9]+\/order|\/fapi\/v[0-9]+\/account|\/fapi\/v[0-9]+\/allOrders|\/fapi\/v[0-9]+\/positionRisk/i;

/** Demo Trading hosts belong to an attached Testnet profile only. */
const DEMO_HOST = /\/\/demo-(fapi|fstream)\.binance\.com/i;

export function parseGuardLog(text: string): GuardEntry[] {
  const entries: GuardEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("blocked ")) continue;
    const tokens = line.split(/\s+/);
    // blocked <iso> <kind> <url> [method=… auth=… sig=…]
    if (tokens.length < 4) continue;
    const fields: Record<string, string> = {};
    for (const token of tokens.slice(4)) {
      const eq = token.indexOf("=");
      if (eq > 0) fields[token.slice(0, eq)] = token.slice(eq + 1);
    }
    entries.push({
      at: tokens[1] ?? "",
      kind: tokens[2] ?? "",
      url: tokens[3] ?? "",
      method: (fields.method ?? (tokens[2] === "websocket" ? "-" : "GET")).toUpperCase(),
      hasApiKey: fields.auth === "1",
      hasSignature: fields.sig === "1",
    });
  }
  return entries;
}

/** Describe every attempt that breaks the disconnected contract. */
export function violations(entries: readonly GuardEntry[]): string[] {
  const found: string[] = [];
  for (const entry of entries) {
    const what = `${entry.kind.toUpperCase()} ${entry.method} ${entry.url}`;
    if (entry.kind === "websocket") {
      found.push(`socket opened while disconnected: ${what}`);
      continue;
    }
    if (entry.hasApiKey) found.push(`API key sent while disconnected: ${what}`);
    if (entry.hasSignature) found.push(`signed request while disconnected: ${what}`);
    if (DEMO_HOST.test(entry.url)) found.push(`Demo Trading host used while disconnected: ${what}`);
    if (FORBIDDEN_PATH.test(entry.url)) {
      found.push(`private/account endpoint used while disconnected: ${what}`);
      continue;
    }
    const allowed = ALLOWED_REQUESTS.some(
      (rule) =>
        rule.kind.test(entry.kind) && rule.method.test(entry.method) && rule.url.test(entry.url),
    );
    if (!allowed) found.push(`undeclared request while disconnected: ${what}`);
  }
  return found;
}
