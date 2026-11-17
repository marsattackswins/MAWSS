/**
 * Minimal IANA-timezone support for the time axis + stamps. The renderer works in
 * epoch-ms (UTC) everywhere; to render labels in a chosen zone we compute that zone's
 * UTC offset for a given instant and shift the ms before reading `getUTC*`. A single
 * offset (sampled at the visible range's midpoint) is reused across the range — exact
 * away from DST boundaries, with at most a one-hour seam across a transition, which is
 * an acceptable trade for cheap, dependency-free zoning.
 *
 * Both the formatter and its result are cached: this runs from the backdrop + chrome
 * painters on EVERY frame, and constructing an `Intl.DateTimeFormat` per call was
 * measurably the most expensive thing either painter did during a pan.
 */

const HOUR_MS = 3_600_000;

/** One formatter per zone — `Intl.DateTimeFormat` construction dwarfs `formatToParts`. */
const formatters = new Map<string, Intl.DateTimeFormat>();

/** The zone's offset sampled per UTC hour (offset ⇒ `${zone}\u0000${hourBucket}`). */
const offsets = new Map<string, number>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
    let dtf = formatters.get(timeZone);
    if (!dtf) {
        dtf = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
        formatters.set(timeZone, dtf);
    }
    return dtf;
}

/** The zone's offset from UTC at `ms`, in milliseconds (e.g. New York in winter ⇒ -5h).
 *  Returns 0 for UTC / empty / unknown zones so callers degrade to plain UTC. */
export function tzOffsetMs(ms: number, timeZone: string): number {
    if (!timeZone || timeZone === 'UTC') return 0;
    // DST transitions land on local-hour boundaries, so one sample per UTC hour is exact
    // for the vast majority of instants and at most an hour stale around a switch — the
    // same tolerance the single-offset-per-visible-range contract already accepts.
    const bucket = Math.floor(ms / HOUR_MS);
    const key = `${timeZone}\u0000${bucket}`;
    const cached = offsets.get(key);
    if (cached !== undefined) return cached;
    try {
        const parts = formatterFor(timeZone).formatToParts(new Date(ms));
        const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
        const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
        const offset = asUTC - ms;
        if (offsets.size > 512) offsets.clear(); // bounded: a long pan walks many buckets
        offsets.set(key, offset);
        return offset;
    } catch {
        return 0;
    }
}

/** A `Date` whose `getUTC*` accessors read the wall-clock time in `timeZone`. */
export function zonedDate(ms: number, timeZone: string): Date {
    return new Date(ms + tzOffsetMs(ms, timeZone));
}
