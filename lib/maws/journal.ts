/**
 * Where the vendored LuxAlgo Trade Journal is served under the MAWS origin
 * (same-origin rewrite in next.config.ts → upstream on port 3400). Override the
 * upstream with MAWS_JOURNAL_UPSTREAM if the journal runs elsewhere.
 */
export const MAWS_JOURNAL_URL = "/journal" as const;
