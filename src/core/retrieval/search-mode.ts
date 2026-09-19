/**
 * Search-mode (检索档) wire control for retrieve — plans/search-mode-retrieve.md T1.
 *
 * The host (fin) assigns the 档 and passes it as `filters.search_mode`
 * ∈ A|B|C|D (specs/search-mode-retrieve.md confirmed assumption 6). It rides
 * the `filters` map because the input schema stays a `z.strictObject` with
 * `filters: z.record(z.string(), z.string())` and no fourth MCP tool is
 * allowed. Consequences owned by this file:
 *
 *   - `search_mode` is a ROUTING control, not an exact-match chunk filter:
 *     every backend applies `filters` (the ES precision layer turns each key
 *     into a term clause), so the key must be stripped before the map
 *     reaches the arms or it silently zeros every arm.
 *   - Missing key → B, the existing graph-priority contract
 *     (specs/retrieve-graph-priority.md), byte-for-byte unchanged.
 *   - A value outside the closed set → `kind: "invalid"`. The handler maps
 *     it to a typed `GraphragError("INVALID_INPUT")` whose message carries
 *     the stable `invalid_search_mode` token, because the MCP adapter
 *     serializes only thrown Error messages into the `isError` result.
 *     A healthy `{ chunks: [] }` with no reason is the failure mode this
 *     branch exists to prevent.
 *   - Envelope `degraded_reasons` was rejected for the invalid case: that
 *     mechanism reports capabilities that ran and partially failed, while
 *     the caller still gets an answer — an unknown 档 yields no answer.
 */
import {
  assembleRetrievalResult,
  type AssembleArgs,
  type AssembleDeps,
} from "./index.js";
import { modeAParentWindowArm } from "./mode-a-arm.js";
import type { RetrieveOutputEnvelope } from "./types.js";

/** The closed set from specs/search-mode-retrieve.md; never widen it silently. */
export const SEARCH_MODES = ["A", "B", "C", "D"] as const;

export type SearchMode = (typeof SEARCH_MODES)[number];

/** Missing key defaults to B (confirmed assumption 6). */
export const DEFAULT_SEARCH_MODE: SearchMode = "B";

/** Stable host-mappable reason token, aligned with fin `named_failures` style. */
export const INVALID_SEARCH_MODE_REASON = "invalid_search_mode";

/** The `filters` key carrying the 档; single source of truth. */
export const SEARCH_MODE_FILTER_KEY = "search_mode";

export type SearchModeResolution =
  | { kind: "resolved"; mode: SearchMode }
  | { kind: "invalid"; value: string };

/** Resolve the requested 档 without mutating the caller's filters. */
export function parseSearchMode(
  filters: Record<string, string> | undefined
): SearchModeResolution {
  const value = filters?.[SEARCH_MODE_FILTER_KEY];
  if (value === undefined) return { kind: "resolved", mode: DEFAULT_SEARCH_MODE };
  if ((SEARCH_MODES as readonly string[]).includes(value)) {
    return { kind: "resolved", mode: value as SearchMode };
  }
  return { kind: "invalid", value };
}

/**
 * Remove the 档 routing key from the exact-match filters handed to the
 * arms. Returns `undefined` when nothing else remains, so the call shape
 * stays identical to a request that never carried filters at all.
 */
export function stripSearchModeFilter(
  filters: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (filters === undefined || !(SEARCH_MODE_FILTER_KEY in filters)) {
    return filters;
  }
  const rest: Record<string, string> = { ...filters };
  delete rest[SEARCH_MODE_FILTER_KEY];
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** Build the thrown-error message; keeps the reason token out of magic strings. */
export function invalidSearchModeMessage(value: string): string {
  return (
    `retrieve ${SEARCH_MODE_FILTER_KEY} must be one of ` +
    `${SEARCH_MODES.join(" | ")}, got "${value}" ` +
    `(${INVALID_SEARCH_MODE_REASON})`
  );
}

/**
 * One assembled answer per retrieve call — the same (args, deps) contract
 * the B pipeline already honors.
 */
export type SearchModeArm = (
  args: AssembleArgs,
  deps: AssembleDeps
) => Promise<RetrieveOutputEnvelope>;

/**
 * T1 stand-in until the remaining per-档 arms land: plans T3 opens C and
 * T4 replaces D with its typed refusal. Each ticket swaps exactly ONE row
 * of the table below — the handler parsing, stripping and envelope stay as
 * they are. T2 opened A's row on the parent-window arm (below); the
 * remaining provisional rows answer through the existing graph-priority
 * assembler, byte-for-byte the current B behavior.
 */
const provisionalGraphPriorityArm: SearchModeArm = assembleRetrievalResult;

export const SEARCH_MODE_ARMS: Readonly<Record<SearchMode, SearchModeArm>> = {
  // T2: child lexical hits cite the parent 抽图窗 body (ADR-0060).
  A: modeAParentWindowArm,
  B: assembleRetrievalResult,
  // Still provisional until plans T3 opens the report-first arm.
  C: provisionalGraphPriorityArm,
  // Still provisional until plans T4 lands the typed refusal.
  D: provisionalGraphPriorityArm,
};
