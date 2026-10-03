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
import { ENTITY_TYPES, type EntityType } from "../extraction/entity-type.js";

/** The `filters` key carrying the 档; single source of truth. */
export const SEARCH_MODE_FILTER_KEY = "search_mode";

/**
 * The `global` 档 drop switch (specs/search-mode-retrieve.md Open Question
 * resolution): the drop after a report hit is default ON; exactly the
 * value "0" turns it off. The KEY keeps its retired-letter name — the
 * 2026-09-22 ruling was values-only, so identifiers move in their own
 * ticket (specs/search-mode-lexical-sql-tokens.md assumption 6).
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

/** Whether the `global` answer may drop to citable windows after a report hit. */
export function cDropWindowsEnabled(
  filters: Record<string, string> | undefined
): boolean {
  return filters?.[C_DROP_WINDOWS_FILTER_KEY] !== C_DROP_WINDOWS_OFF;
}

/** Strip the `global` drop switch from the exact-match filters (same contract as `stripSearchModeFilter`). */
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

/** Closed set rendered for host-facing docs (tool descriptions); SSOT stays in `ENTITY_TYPES`. */
export const ENTITY_TYPE_FILTER_VALUES = ENTITY_TYPES.join(" | ");

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

/**
 * The `filters` key bounding community-summary reads to `level <= N`
 * (specs/community-level.md). Same routing contract as `search_mode`: the
 * exact-match backends must never see it; the arms receive the resolved
 * number instead.
 */
export const COMMUNITY_LEVEL_FILTER_KEY = "community_level";

/** Reference cap on the product scale: missing filter reads as 2. */
export const DEFAULT_COMMUNITY_LEVEL_CAP = 2;

/** Stable host-mappable reason token, aligned with the other routing keys. */
export const INVALID_COMMUNITY_LEVEL_REASON = "invalid_community_level";

/**
 * Resolution of `filters.community_level`: missing key = the default cap, a
 * positive integer string = that cap, anything else (non-integer, zero,
 * negative, empty, overflow) = typed invalid — the handler turns it into an
 * INVALID_INPUT refusal, never a silent all-level mix.
 */
export type CommunityLevelResolution =
  { kind: "resolved"; level: number } | { kind: "invalid"; value: string };

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/** Resolve the requested fineness bound without mutating the caller's filters. */
export function parseCommunityLevelFilter(
  filters: Record<string, string> | undefined
): CommunityLevelResolution {
  const value = filters?.[COMMUNITY_LEVEL_FILTER_KEY];
  if (value === undefined) {
    return { kind: "resolved", level: DEFAULT_COMMUNITY_LEVEL_CAP };
  }
  // The regex bounds the shape; the safe-integer guard bounds the width,
  // so an overflow string is refused rather than silently saturating.
  if (POSITIVE_INTEGER.test(value) && Number.isSafeInteger(Number(value))) {
    return { kind: "resolved", level: Number(value) };
  }
  return { kind: "invalid", value };
}

/** Build the thrown-error message; keeps the reason token out of magic strings. */
export function invalidCommunityLevelMessage(value: string): string {
  return (
    `retrieve ${COMMUNITY_LEVEL_FILTER_KEY} must be a positive integer string, ` +
    `got "${value}" (${INVALID_COMMUNITY_LEVEL_REASON})`
  );
}

/** Strip the summary cap control from the exact-match filters (same contract as `stripSearchModeFilter`). */
export function stripCommunityLevelFilter(
  filters: Record<string, string> | undefined
): Record<string, string> | undefined {
  return stripFilterKey(filters, COMMUNITY_LEVEL_FILTER_KEY);
}

/**
 * The `filters` keys carrying the `sql` 档's expiry window
 * (specs/search-mode-business-sql-contract.md §2.3, §5c): inclusive ISO
 * `YYYY-MM-DD` bounds for the one permitted `contracts_expiring` template.
 * Same routing contract as `search_mode`: the exact-match backends must
 * never see them.
 */
export const SQL_WINDOW_START_FILTER_KEY = "sql_window_start";
export const SQL_WINDOW_END_FILTER_KEY = "sql_window_end";

/** The window handed to the business-query executor as bound parameters. */
export interface SqlWindow {
  windowStart: string;
  windowEnd: string;
}

/**
 * Read the window values without validating them. Validation is the
 * executor's single authority (`isBoundWindow`): a malformed or absent
 * window must fail there as `invalid_business_query` before a connection
 * exists, so a second validator here could only drift from the first.
 * Absent keys read as empty strings, which the executor refuses — there is
 * no defaulted window on the wire path.
 */
export function readSqlWindowFilter(
  filters: Record<string, string> | undefined
): SqlWindow {
  return {
    windowStart: filters?.[SQL_WINDOW_START_FILTER_KEY] ?? "",
    windowEnd: filters?.[SQL_WINDOW_END_FILTER_KEY] ?? "",
  };
}

/** Strip both window keys from the exact-match filters. */
export function stripSqlWindowFilter(
  filters: Record<string, string> | undefined
): Record<string, string> | undefined {
  return stripFilterKey(
    stripFilterKey(filters, SQL_WINDOW_START_FILTER_KEY),
    SQL_WINDOW_END_FILTER_KEY
  );
}

/**
 * The `filters` key carrying the bounded structured request
 * (specs/structured-corpus-query §Request). Same routing contract as
 * `search_mode`, with one difference that makes it stricter: this is the ONE
 * filter key whose value is an object rather than a string, so it is resolved
 * and stripped before any arm runs. A backend that turns every filter key into
 * an exact-match term clause has no field to match an object against, and the
 * leftover key would silently zero the arm instead of answering.
 */
export const STRUCTURED_QUERY_FILTER_KEY = "structured_query";

/**
 * The wire filter map. Every other key keeps the string-only exact-match
 * contract; the retrieve tool's input schema is what enforces that, because a
 * Zod record cannot type one member differently from the rest.
 */
export type RetrieveWireFilters = Record<string, unknown>;

/**
 * Presence of the structured request, unvalidated. Every refusal code belongs
 * to `validateStructuredQueryRequest`, so this reader cannot become a second
 * validator that drifts from the first.
 */
export type StructuredQueryFilterResolution =
  | { kind: "absent" }
  | { kind: "present"; request: unknown };

/** Read the structured request without validating it. */
export function readStructuredQueryFilter(
  filters: RetrieveWireFilters | undefined
): StructuredQueryFilterResolution {
  if (filters === undefined || !(STRUCTURED_QUERY_FILTER_KEY in filters)) {
    return { kind: "absent" };
  }
  return { kind: "present", request: filters[STRUCTURED_QUERY_FILTER_KEY] };
}

/**
 * Resolution of the `filters` map once the structured key is removed.
 *
 * A refusal, not a silent drop. `structured_query` is the ONE key whose value
 * is an object; every other key keeps the string-only exact-match contract, so
 * a non-string under one of them is a filter the arms cannot apply. Returning
 * it as `ok` would hand the arm a map missing an entry the caller sent, and the
 * arm would answer a NARROWER question than the one asked with no refusal
 * anywhere. This module owns no error vocabulary of its own (see the leaf
 * note at the top), so it names the offending key and the handler refuses.
 */
export type StructuredQueryFilterStrip =
  | { kind: "ok"; filters: Record<string, string> | undefined }
  | { kind: "invalid"; key: string; received: string };

/** Stable host-mappable reason token, aligned with the other routing keys. */
export const INVALID_FILTER_VALUE_REASON = "invalid_filter_value";

/** Build the thrown-error message; keeps the reason token out of magic strings. */
export function invalidFilterValueMessage(
  key: string,
  received: string
): string {
  return (
    `retrieve ${key} must be a string (or the object-valued ` +
    `${STRUCTURED_QUERY_FILTER_KEY}), got a ${received} ` +
    `(${INVALID_FILTER_VALUE_REASON})`
  );
}

/**
 * Strip the structured key and narrow to the exact-match map the arms consume.
 *
 * A request whose only filter was the structured key reads as no filters at
 * all, so the arm call shape never differs from a request that carried none.
 * Every other entry must be a string: one that is not is refused rather than
 * dropped, because dropping it silently narrows the query.
 */
export function stripStructuredQueryFilter(
  filters: RetrieveWireFilters | undefined
): StructuredQueryFilterStrip {
  if (filters === undefined) {
    return { kind: "ok", filters: undefined };
  }
  const rest: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (key === STRUCTURED_QUERY_FILTER_KEY) {
      continue;
    }
    if (typeof value !== "string") {
      return { kind: "invalid", key, received: typeof value };
    }
    rest[key] = value;
  }
  return {
    kind: "ok",
    filters: Object.keys(rest).length > 0 ? rest : undefined,
  };
}
