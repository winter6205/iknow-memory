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
import {
  ENTITY_TYPES,
  type EntityType,
} from "../extraction/entity-type.js";

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

/**
 * The `filters` key restricting which entity types may seed the graph and
 * entity-embedding arms (plans/entity-type-and-filter.md T3). Same routing
 * contract as `search_mode`: exact-match backends must never see it.
 */
export const ENTITY_TYPE_FILTER_KEY = "entity_type";

/** Stable host-mappable reason token, aligned with `invalid_search_mode`. */
export const INVALID_ENTITY_TYPE_REASON = "invalid_entity_type";

/**
 * Resolution of `filters.entity_type`: missing key = all types (today's
 * behavior), a closed-set value = that type only, anything else = typed
 * invalid — the handler turns it into an INVALID_INPUT refusal, never a
 * silent ignore. The closed set is the extraction `ENTITY_TYPES` SSOT; an
 * empty string matches none of them and is therefore invalid.
 */
export type EntityTypeFilterResolution =
  | { kind: "resolved"; entityType: EntityType | undefined }
  | { kind: "invalid"; value: string };

/** Resolve the requested seed type without mutating the caller's filters. */
export function parseEntityTypeFilter(
  filters: Record<string, string> | undefined
): EntityTypeFilterResolution {
  const value = filters?.[ENTITY_TYPE_FILTER_KEY];
  if (value === undefined) {
    return { kind: "resolved", entityType: undefined };
  }
  if ((ENTITY_TYPES as readonly string[]).includes(value)) {
    return { kind: "resolved", entityType: value as EntityType };
  }
  return { kind: "invalid", value };
}

/** Build the thrown-error message; keeps the reason token out of magic strings. */
export function invalidEntityTypeMessage(value: string): string {
  return (
    `retrieve ${ENTITY_TYPE_FILTER_KEY} must be one of ` +
    `${ENTITY_TYPES.join(" | ")}, got "${value}" ` +
    `(${INVALID_ENTITY_TYPE_REASON})`
  );
}

/** Strip the entity seed-type control from the exact-match filters (same contract as `stripSearchModeFilter`). */
export function stripEntityTypeFilter(
  filters: Record<string, string> | undefined
): Record<string, string> | undefined {
  return stripFilterKey(filters, ENTITY_TYPE_FILTER_KEY);
}
