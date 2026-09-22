/**
 * Search-mode (检索档) wire control for retrieve — plans/search-mode-retrieve.md T1.
 *
 * The host (fin) assigns the 档 and passes it as `filters.search_mode`
 * ∈ lexical|graph|global|sql (specs/search-mode-graph-global.md confirmed
 * assumption 2). It rides the `filters` map because the input schema stays a
 * `z.strictObject` with
 * `filters: z.record(z.string(), z.string())` and no fourth MCP tool is
 * allowed. Consequences owned by this file:
 *
 *   - `search_mode` is a ROUTING control, not an exact-match chunk filter:
 *     every backend applies `filters` (the ES precision layer turns each key
 *     into a term clause), so the key must be stripped before the map
 *     reaches the arms or it silently zeros every arm.
 *   - Missing key → `graph`, the existing graph-priority contract
 *     (specs/retrieve-graph-priority.md), byte-for-byte unchanged.
 *   - The wire carries word-form tokens only, matched verbatim (casing is
 *     part of the token). Nothing but the four `SEARCH_MODES` entries
 *     resolves, so every arm, table row, and downstream reader sees exactly
 *     one of them.
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
import { GraphragError } from "../errors.js";

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

/** The closed set from specs/search-mode-graph-global.md; never widen it silently. */
export const SEARCH_MODES = ["lexical", "graph", "global", "sql"] as const;

export type SearchMode = (typeof SEARCH_MODES)[number];

/** Missing key defaults to `graph` (confirmed assumption 2). */
export const DEFAULT_SEARCH_MODE: SearchMode = "graph";

/** Stable host-mappable reason token, aligned with fin `named_failures` style. */
export const INVALID_SEARCH_MODE_REASON = "invalid_search_mode";

/**
 * Stable host-mappable token for the `sql` 档, aligned with fin
 * `named_failures.REAL_DB_NOT_WIRED` (specs/search-mode-retrieve.md Open
 * Question: codes shared with fin `named_failures`). It lives HERE, beside
 * the other wire-side reason token, not beside `COMMUNITY_SUMMARY_INDEX_
 * FAILURE` in core types: that constant is a persisted `failure_code`
 * column value written by the community-summary job, while this one is a
 * routing-time refusal that never touches storage.
 */
export const REAL_DB_NOT_WIRED_REASON = "real_db_not_wired";

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
 * The single operator-visible sentence for `filters.search_mode`: the closed
 * set of word-form tokens, quoted verbatim by BOTH the MCP tool description
 * and `invalidSearchModeMessage` below, so a widen or contract step moves
 * the host-facing prose and the refusal together instead of leaving a
 * hardcoded description silently wrong — the rule this repo already recorded
 * for `entity_type` (tests/retrieve.test.ts, "review M2").
 */
export const SEARCH_MODE_WIRE_COPY = SEARCH_MODES.join(" | ");

/** Build the thrown-error message; keeps the reason token out of magic strings. */
export function invalidSearchModeMessage(value: string): string {
  return (
    `retrieve ${SEARCH_MODE_FILTER_KEY} must be one of ` +
    `${SEARCH_MODE_WIRE_COPY}, got "${value}" ` +
    `(${INVALID_SEARCH_MODE_REASON})`
  );
}

/** Same constant pattern as `invalidSearchModeMessage`, for the `sql` 档's refusal. */
export function realDbNotWiredMessage(): string {
  return (
    `retrieve ${SEARCH_MODE_FILTER_KEY}=sql is not wired: ` +
    `${REAL_DB_NOT_WIRED_REASON} (document tables stay on 档 graph until a ` +
    `business SQL path exists)`
  );
}

/**
 * Routing controls the dispatcher resolves from `filters` before any arm
 * runs, so an arm never re-reads a control key out of the exact-match map
 * it hands to backends (review I2: the dispatcher is the single strip
 * point for EVERY 档, `global` included).
 */
export interface SearchModeControl {
  /**
   * Resolved `filters.c_drop_windows` switch for the report-first 档
   * (`global`): default on, off only on the exact "0" (see wire-filters.ts).
   */
  cDropWindows: boolean;
}

/**
 * One assembled answer per retrieve call — the same (args, deps) contract
 * the graph pipeline already honors. `control` is supplied by the dispatcher;
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
 * The `sql` 档 (plans/search-mode-retrieve.md T4, spec assumption 5 + SC5):
 * the business-SQL path is a plan slot, not implemented, so the honest
 * answer is a typed refusal — reading `args`/`deps` at all would mean
 * running SQL (fake or real) over chunks, exactly what the spec forbids;
 * document tables stay on `graph`. Same exit chain as T1's invalid mode and
 * T3's not-ready
 * gate: throw a `GraphragError` whose message carries the stable fin-pinned
 * token, because the MCP adapter serializes only thrown Error messages
 * into the `isError` result. Code `INVALID_INPUT` mirrors fin's
 * routing-time 400 for `real_db_not_wired` (the run never starts — no
 * storage was touched, so it is not a `STORAGE_ERROR`).
 */
async function modeDNotWiredArm(): Promise<RetrieveOutputEnvelope> {
  throw new GraphragError(realDbNotWiredMessage(), "INVALID_INPUT");
}

/**
 * specs/search-mode-retrieve.md confirms each 档 gets its own arm: T2 opened
 * the lexical child→parent arm (mode-a-arm.ts, ADR-0060), T3 opened the
 * report-first arm (mode-c-arm.ts, ADR-0070), each replacing exactly ONE row
 * of this table — the handler parsing, stripping and envelope stay as they
 * are. T4 opened the `sql` row below. Arm identifiers keep their plan-side
 * names; renaming them is a separate step from the wire contract.
 *
 * The keys are the wire tokens of specs/search-mode-graph-global.md — the
 * same `SEARCH_MODES` values `parseSearchMode` resolves, so a value can
 * never route to an arm its token does not name.
 */
export const SEARCH_MODE_ARMS: Readonly<Record<SearchMode, SearchModeArm>> = {
  // T2: child lexical hits cite the parent 抽图窗 body (ADR-0060).
  lexical: modeAParentWindowArm,
  // The knowledge-QA arm: graph-priority prefix, vector ∥ BM25 remainder.
  graph: assembleRetrievalResult,
  // T3: report-first community summaries, ES ∥ report vectors (ADR-0070).
  global: modeCReportFirstArm,
  // T4: typed 真库未接 refusal, never a provisional graph answer over chunks.
  sql: modeDNotWiredArm,
};
