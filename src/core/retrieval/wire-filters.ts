/**
 * Routing keys that ride the retrieve `filters` map.
 *
 * `filters` is an exact-match contract every backend applies (the ES
 * precision layer turns each key into a term clause), so a control key
 * left in the map would silently zero the arms that consume it. The
 * search-mode dispatcher resolves and strips EVERY routing key here before
 * the arms run (review I2: one strip point, all 档); a direct arm caller
 * that bypasses the dispatcher uses these same functions to keep its own
 * handoff clean.
 *
 * A leaf module ON PURPOSE: `search-mode.ts` imports the per-档 arms to
 * build the dispatch table, and an arm needs these key constants. If the
 * constants lived in `search-mode.ts`, loading an arm first would
 * evaluate `SEARCH_MODE_ARMS` against a still-initializing arm binding
 * (ESM cyclic TDZ crash). The arms import this leaf instead, and
 * `search-mode.ts` re-exports it for wire-side callers.
 */

/** The `filters` key carrying the 档; single source of truth. */
export const SEARCH_MODE_FILTER_KEY = "search_mode";

/**
 * The 档 C drop switch (specs/search-mode-retrieve.md Open Question
 * resolution): the drop after a report hit is default ON; exactly the
 * value "0" turns it off.
 */
export const C_DROP_WINDOWS_FILTER_KEY = "c_drop_windows";

/** The single off-value of the drop switch; anything else stays on. */
export const C_DROP_WINDOWS_OFF = "0";

/**
 * Remove one control key from the exact-match filters handed to the arms.
 * Returns `undefined` when nothing else remains, so the call shape stays
 * identical to a request that never carried filters at all. The public
 * wrappers below pin WHICH keys are routing; this is the shared how.
 */
function stripFilterKey(
  filters: Record<string, string> | undefined,
  key: string
): Record<string, string> | undefined {
  if (filters === undefined || !(key in filters)) {
    return filters;
  }
  const rest: Record<string, string> = { ...filters };
  delete rest[key];
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** Remove the 档 routing key from the exact-match filters. */
export function stripSearchModeFilter(
  filters: Record<string, string> | undefined
): Record<string, string> | undefined {
  return stripFilterKey(filters, SEARCH_MODE_FILTER_KEY);
}

/** Whether the C answer may drop to citable windows after a report hit. */
export function cDropWindowsEnabled(
  filters: Record<string, string> | undefined
): boolean {
  return filters?.[C_DROP_WINDOWS_FILTER_KEY] !== C_DROP_WINDOWS_OFF;
}

/** Strip the C drop switch from the exact-match filters (same contract as `stripSearchModeFilter`). */
export function stripCDropWindowsFilter(
  filters: Record<string, string> | undefined
): Record<string, string> | undefined {
  return stripFilterKey(filters, C_DROP_WINDOWS_FILTER_KEY);
}
