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
import { modeCReportFirstArm } from "./mode-c-arm.js";
import { SEARCH_MODE_FILTER_KEY } from "./wire-filters.js";
import type { RetrieveOutputEnvelope } from "./types.js";

// Re-exported so wire-side callers (src/tools/retrieve.ts, tests) keep one
// import point; the constants live in the leaf module for the cyclic-TDZ
// reason documented there.
export {
  SEARCH_MODE_FILTER_KEY,
  C_DROP_WINDOWS_FILTER_KEY,
  C_DROP_WINDOWS_OFF,
  cDropWindowsEnabled,
  stripSearchModeFilter,
  stripCDropWindowsFilter,
} from "./wire-filters.js";

/** The closed set from specs/search-mode-retrieve.md; never widen it silently. */
export const SEARCH_MODES = ["A", "B", "C", "D"] as const;

export type SearchMode = (typeof SEARCH_MODES)[number];

/** Missing key defaults to B (confirmed assumption 6). */
export const DEFAULT_SEARCH_MODE: SearchMode = "B";

/** Stable host-mappable reason token, aligned with fin `named_failures` style. */
export const INVALID_SEARCH_MODE_REASON = "invalid_search_mode";

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

/** Build the thrown-error message; keeps the reason token out of magic strings. */
export function invalidSearchModeMessage(value: string): string {
  return (
    `retrieve ${SEARCH_MODE_FILTER_KEY} must be one of ` +
    `${SEARCH_MODES.join(" | ")}, got "${value}" ` +
    `(${INVALID_SEARCH_MODE_REASON})`
  );
}

/**
 * Routing controls the dispatcher resolves from `filters` before any arm
 * runs, so an arm never re-reads a control key out of the exact-match map
 * it hands to backends (review I2: the dispatcher is the single strip
 * point for EVERY 档, C included).
 */
export interface SearchModeControl {
  /**
   * Resolved `filters.c_drop_windows` switch for 档 C: default on, off
   * only on the exact "0" (see wire-filters.ts).
   */
  cDropWindows: boolean;
}

/**
 * One assembled answer per retrieve call — the same (args, deps) contract
 * the B pipeline already honors. `control` is supplied by the dispatcher;
 * direct arm callers (tests, internal reuse) may omit it, in which case an
 * arm that owns a routing key falls back to parsing it from `args.filters`
 * itself — the key is a control only on the wire path, where the
 * dispatcher strips it.
 */
export type SearchModeArm = (
  args: AssembleArgs,
  deps: AssembleDeps,
  control?: SearchModeControl
) => Promise<RetrieveOutputEnvelope>;

/**
 * T1 stand-in until the last 档 row opens: plans T4 replaces D with its
 * typed refusal. Each ticket swaps exactly ONE row of the dispatch table —
 * the handler parsing, stripping and envelope stay as they are. Until then
 * D answers through the existing graph-priority assembler, byte-for-byte
 * the current B behavior.
 */
const provisionalGraphPriorityArm: SearchModeArm = assembleRetrievalResult;

/**
 * specs/search-mode-retrieve.md confirms each 档 gets its own arm: T2 opened
 * A (mode-a-arm.ts, ADR-0060), T3 opened C (mode-c-arm.ts, ADR-0070), each
 * replacing exactly ONE row of this table. T4 replaces D's provisional row
 * with the typed unwired refusal.
 */
export const SEARCH_MODE_ARMS: Readonly<Record<SearchMode, SearchModeArm>> = {
  // T2: child lexical hits cite the parent 抽图窗 body (ADR-0060).
  A: modeAParentWindowArm,
  B: assembleRetrievalResult,
  // T3: report-first community summaries, ES ∥ report vectors (ADR-0070).
  C: modeCReportFirstArm,
  // Provisional until plans T4 lands the typed `real_db_not_wired` refusal.
  D: provisionalGraphPriorityArm,
};
