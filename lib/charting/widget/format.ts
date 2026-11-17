// Number formatting shared by the widget chrome (statusline, data readouts) — pure.

/** Sensible decimal count for a price magnitude (crypto-friendly). */
export function decimalsFor(ref: number): number {
    const a = Math.abs(ref);
    return a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
}

/** One `Intl.NumberFormat` per decimal count — axis labels and readouts format every
 *  frame, and `toLocaleString` with options builds a formatter per call. */
const priceFormatters = new Map<number, Intl.NumberFormat>();

function priceFormatter(d: number): Intl.NumberFormat {
    let nf = priceFormatters.get(d);
    if (!nf) {
        nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
        priceFormatters.set(d, nf);
    }
    return nf;
}

/** Locale-formatted price; `'—'` for null/non-finite. */
export function fmtPrice(n: number | null | undefined, dp?: number): string {
    if (n == null || !Number.isFinite(n)) return '—';
    const d = dp ?? decimalsFor(n);
    return priceFormatter(d).format(n);
}

/** Signed change + percent ("+123.45 (+1.23%)") from open→close; `''` when unavailable. */
export function fmtChange(open: number | null | undefined, close: number | null | undefined): string {
    if (open == null || close == null || !Number.isFinite(open) || !Number.isFinite(close) || open === 0) return '';
    const diff = close - open;
    const pct = (diff / open) * 100;
    const sign = diff >= 0 ? '+' : '';
    return `${sign}${fmtPrice(diff, decimalsFor(close))} (${sign}${pct.toFixed(2)}%)`;
}

/** Signed percent change alone ("+1.23%") from open→close; `''` when unavailable. */
export function fmtChangePct(open: number | null | undefined, close: number | null | undefined): string {
    if (open == null || close == null || !Number.isFinite(open) || !Number.isFinite(close) || open === 0) return '';
    const pct = ((close - open) / open) * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}
