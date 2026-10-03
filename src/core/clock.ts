/**
 * Wall-clock seam.
 *
 * A maintenance deadline is only testable when the code that computes it
 * cannot reach for `Date.now()` itself: the retry schedule is fixed at 5 then
 * 30 seconds, the worker lease at five minutes and the absolute attempt bound
 * at thirty, and only an injected clock lets a test step across those
 * boundaries instead of sleeping through them.
 *
 * Same one-read convention as the existing `clock?: () => Date` /
 * `now?: () => string` seams elsewhere in the package; it lives at the package
 * core because the collector's day arithmetic (MP13) needs it too.
 */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

/** Whole UTC days as elapsed 24-hour periods, the retention unit in the spec. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
