/**
 * Retrieve tool — semantic search over the knowledge memory store.
 *
 * Pipeline: embed query → vector search with valid_window filter → return
 * ranked chunks. Stage 3 (spec-3 p0-integration T5): when a graph-arm seam
 * (`graphArmSeed`) AND a `graphConfig` are both present, the results are
 * fused with the graph arm via RRF. The wire envelope contains `chunks` plus
 * only the optional `degraded` and `degraded_reasons` fields; internal debug
 * diagnostics are not serialized.
 *
 * `filters.search_mode` (检索档 lexical|graph|global|sql,
 * specs/search-mode-graph-global.md) is resolved and dispatched in this
 * handler before the arms run: missing → `graph`, outside the closed set →
 * typed INVALID_INPUT, `lexical` → the lexical child-hit/parent-body arm
 * (plans T2), `global` → the report-first community-summary arm (plans T3),
 * `sql` → the business-SQL arm (plans/post322-a2 T7): with a ledger
 * provisioned it answers `{ chunks: [], database_rows }` from one named
 * parameterized template, and without one it exits the tokened
 * `real_db_not_wired` (specs/search-mode-business-sql-contract.md §7).
 *
 * `filters.sql_window_start` / `filters.sql_window_end` (inclusive ISO
 * `YYYY-MM-DD`) are the `sql` 档's expiry-window routing controls: the
 * dispatcher resolves and strips them like every other control key, and
 * the executor validates them (a malformed or absent window is refused
 * `invalid_business_query` before a connection exists — there is no
 * defaulted window).
 *
 * `filters.entity_type` (plans/entity-type-and-filter.md T3) is resolved
 * and stripped the same way: missing → all types, one of the closed set →
 * typed seed restriction for the graph/entity-embedding arms, anything
 * else → typed INVALID_INPUT. It is a routing control, never a chunk
 * exact-match key; `tools/list` still exposes the single `retrieve`.
 *
 * `filters.community_level` (specs/community-level.md) is a routing control
 * too: missing → cap 2, positive integer string → that cap on every
 * community-summary read, anything else → typed INVALID_INPUT.
 *
 * `filters.structured_query` (specs/structured-corpus-query) is the bounded
 * structured request, and the one filter key whose value is an object. It is
 * resolved, validated against the closed request vocabulary, and stripped here
 * before any arm runs; a structured request never runs the legacy business
 * ledger, and every refusal leaves as a typed `iknow.structured_error`.
 */
import { z } from "zod";
import {
  textResult,
  type ToolRegistration,
  type ToolResult,
} from "./registry.js";
import type { EmbeddingClient } from "../core/embedder.js";
import type { SlotEmbeddingSource } from "../core/embed-slots.js";
import type { SearchOptions, StorageBackend } from "../core/types.js";
import type { LexicalStorageBackend } from "../core/storage/backend.js";
import type {
  CapabilityObservation,
  ChunkReranker,
  EntityLexicalStorage,
  RetrievePreset,
  GraphRanker,
  ProjectionDrainWaiter,
  RetrieveConfig,
} from "../core/retrieval/types.js";
import {
  DEFAULT_RETRIEVE_CONFIG,
  RETRIEVE_PRESETS,
  RETRIEVE_PRESET_BUNDLES,
  RetrieveConfigError,
  isRetrievePreset,
  retrieveConfigForPreset,
} from "../core/retrieval/types.js";
import {
  SEARCH_MODE_ARMS,
  SEARCH_MODE_WIRE_COPY,
  cDropWindowsEnabled,
  invalidSearchModeMessage,
  parseSearchMode,
  stripCDropWindowsFilter,
  stripSearchModeFilter,
  type SearchModeControl,
} from "../core/retrieval/search-mode.js";
import {
  ENTITY_TYPE_FILTER_VALUES,
  STRUCTURED_QUERY_FILTER_KEY,
  invalidCommunityLevelMessage,
  invalidEntityTypeMessage,
  parseCommunityLevelFilter,
  parseEntityTypeFilter,
  stripCommunityLevelFilter,
  stripEntityTypeFilter,
} from "../core/retrieval/wire-filters.js";
import { GraphragError } from "../core/errors.js";
import { StructuredQueryError } from "../core/structured/errors.js";
import { validateStructuredQueryRequest } from "../core/structured/request.js";
import type { BusinessQueryExecutor } from "../core/business-query/sql-query-executor.js";
import {
  readSqlWindowFilter,
  readStructuredQueryFilter,
  stripSqlWindowFilter,
  stripStructuredQueryFilter,
} from "../core/retrieval/wire-filters.js";

const DEFAULT_LIMIT = 10;

export class InputValidationFailureCounter {
  count = 0;

  increment(): void {
    this.count += 1;
  }

  reset(): void {
    this.count = 0;
  }
}

export function createRetrieveInputSchema(
  counter?: InputValidationFailureCounter
) {
  // Plan D0 I-T1: must be z.strictObject, NOT z.object. The legacy
  // shape silently stripped unannounced keys (top_k, filter, document_id
  // ...) at the SDK boundary, so fin's adapter appeared to work while
  // the server quietly ignored the unrecognized fields. strictObject
  // rejects any unknown key with a parse error, surfacing contract
  // drift as an explicit failure instead of a quiet mismatch.
  return z.strictObject({
    query: z
      .string()
      .min(1, "query must be a non-empty string")
      .refine((query) => {
        const valid = query.trim().length > 0;
        if (!valid) counter?.increment();
        return valid;
      }, "query must contain at least one non-whitespace character"),
    valid_at: z.string().datetime().optional(),
    // `structured_query` is the one filter key whose value is an object (the
    // bounded structured request). A Zod record cannot type one member
    // differently from the rest, so the value union admits an object and the
    // refine holds the other keys to the string-only exact-match contract.
    filters: z
      .record(z.string(), z.unknown())
      .refine(
        (filters) =>
          Object.entries(filters).every(
            ([key, value]) =>
              key === STRUCTURED_QUERY_FILTER_KEY || typeof value === "string"
          ),
        `only filters.${STRUCTURED_QUERY_FILTER_KEY} may be an object; every other filter value must be a string`
      )
      .optional(),
    limit: z.number().int().min(1).max(100).optional(),
    preset: z.enum(RETRIEVE_PRESETS).optional(),
    wait_for_drain: z.boolean().optional(),
    wait_for_drain_timeout_ms: z.number().int().min(1).max(600_000).optional(),
  });
}

export const RetrieveInputSchema = createRetrieveInputSchema();

export type RetrieveInput = z.infer<typeof RetrieveInputSchema>;

/** Dependencies injected at wiring time. */
export interface RetrieveDeps {
  embedder: EmbeddingClient;
  storage: StorageBackend;
  /** Optional Elasticsearch precision-layer chunk search. */
  lexical?: LexicalStorageBackend;
  /** Optional Elasticsearch precision-layer entity search. */
  entityLexical?: EntityLexicalStorage;
  /**
   * Hybrid retrieval config — BM25 weight and enable switch. Wired from
   * `loadEnv().retrieval` at the server assembly layer. When undefined the
   * tool returns vector-only results, which keeps the pre-hybrid shape for
   * hosts that wire embedder/storage only.
   */
  retrieveConfig?: RetrieveConfig;
  /**
   * Opt-in config for the ARCHIVED SQL one-hop graph arm. The default
   * server path never supplies it (#58); only tests that want the arm do.
   */
  graphConfig?: RetrieveConfig;
  /**
   * Neo4j PPR ranker for the production graph arm (#70). Wired from
   * `loadEnv().neo4j` at the server assembly layer, and absent when no
   * sidecar URI is configured — which skips the arm without degrading the
   * envelope (spec SC7).
   */
  graphRanker?: GraphRanker;
  /**
   * Temporary LLM reranker. Absent when rerank is off or credentials are
   * incomplete — skip, not degraded.
   */
  reranker?: ChunkReranker;
  /** Debug gate; wired to `DEBUG=1` by the caller. */
  debug?: boolean;
  /** Internal seam for injected capability observations. */
  capabilityObservations?: readonly CapabilityObservation[];
  /** Injectable counter for rejected empty or whitespace-only queries. */
  inputValidationFailureCounter?: InputValidationFailureCounter;
  /** Optional read-only projection outbox wait seam. */
  projectionDrain?: ProjectionDrainWaiter;
  /**
   * Embedding rotate T3: per-slot embedder source so the query embed runs
   * against the ACTIVE generation while an open rotate points env at the
   * incoming pair. Absent → the env embedder is used as-is.
   */
  slotEmbedding?: SlotEmbeddingSource;
  /**
   * Business-ledger executor for the `sql` 档, present only when this
   * instance is provisioned with a ledger DSN (spec §5.2: the reader role
   * comes from instance configuration, never from the request). Absent is
   * the structured `real_db_not_wired` (not provisioned) exit.
   */
  businessQuery?: BusinessQueryExecutor;
}

export function createRetrieveHandler(deps: RetrieveDeps) {
  return async function retrieveHandler(
    input: RetrieveInput
  ): Promise<ToolResult> {
    validateRetrieveQuery(input, deps.inputValidationFailureCounter);
    // `filters.structured_query` is a typed request, not a matching filter, and
    // the one filter key whose value is an object. Read and strip it FIRST, so
    // every control reader below sees the string-only exact-match map it has
    // always seen; the request itself is validated once the bound 档 is known.
    const structured = readStructuredQueryFilter(input.filters);
    const stringFilters = stripStructuredQueryFilter(input.filters);
    // Resolve the 档 before anything else so an invalid value is a typed
    // refusal, never a degraded or empty answer (plans/search-mode-retrieve
    // .md T1 acceptance). `search_mode` is routing, not matching: strip it
    // from the exact-match filters so arms and backends never see it.
    const searchMode = parseSearchMode(stringFilters);
    if (searchMode.kind === "invalid") {
      throw new GraphragError(
        invalidSearchModeMessage(searchMode.value),
        "INVALID_INPUT"
      );
    }
    // A structured request may not select or override the host-bound 档, so it
    // is validated against the tier resolved above. A structurally valid
    // request has no execution path yet, and the SPEC's answer for that is the
    // typed `structured_search_unavailable` — never the legacy business
    // ledger, which would answer a different question than the one asked.
    if (structured.kind === "present") {
      validateStructuredQueryRequest(structured.request, searchMode.mode);
      throw new StructuredQueryError(
        "structured query execution is not available on this backend",
        "structured_search_unavailable"
      );
    }
    // Same contract for `filters.entity_type` (plans/entity-type-and-filter
    // .md T3): resolve before any arm runs; missing = all types, outside
    // the closed set = typed refusal, never a silent ignore. The arms see
    // only the value below — the key is stripped from the exact-match map.
    const entityTypeFilter = parseEntityTypeFilter(stringFilters);
    if (entityTypeFilter.kind === "invalid") {
      throw new GraphragError(
        invalidEntityTypeMessage(entityTypeFilter.value),
        "INVALID_INPUT"
      );
    }
    // Same contract for `filters.community_level` (specs/community-level
    // .md): resolve once per request, refuse typed otherwise — never a
    // silent all-level mix — and hand the arms only the number below.
    const communityLevel = resolveCommunityLevel(stringFilters);
    // Routing keys are resolved and stripped HERE, once, for every 档
    // (review I2): each backend applies `filters` as exact-match term
    // clauses, so a left-over control key silently zeros the arm that
    // consumes it — `c_drop_windows` included. The report-first 档
    // (`global`) still sees its switch:
    // as the typed control value below, never as a filter key.
    const control: SearchModeControl = {
      cDropWindows: cDropWindowsEnabled(stringFilters),
    };
    // The `sql` 档's expiry window is a routing control like every key
    // above: resolved here, stripped here, and validated only by the
    // executor — so the refusal of a malformed window happens before a
    // connection exists (spec §5c).
    const sqlWindow = readSqlWindowFilter(stringFilters);
    const matchFilters = stripSqlWindowFilter(
      stripCommunityLevelFilter(
        stripEntityTypeFilter(
          stripCDropWindowsFilter(stripSearchModeFilter(stringFilters))
        )
      )
    );
    const retrieveConfig = applyPreset(
      deps.retrieveConfig,
      input.preset,
      input.wait_for_drain,
      input.wait_for_drain_timeout_ms
    );
    // Default valid_at to "now" so time-bounded filtering always has a
    // concrete reference point. Pass through exact-match filters.
    const opts: SearchOptions = {
      limit: input.limit ?? DEFAULT_LIMIT,
      validAt: input.valid_at ?? new Date().toISOString(),
      ...(matchFilters !== undefined ? { filters: matchFilters } : {}),
    };

    const envelope = await SEARCH_MODE_ARMS[searchMode.mode](
      {
        query: input.query,
        validAt: opts.validAt,
        limit: opts.limit,
        filters: opts.filters,
        ...(entityTypeFilter.entityType !== undefined
          ? { entityType: entityTypeFilter.entityType }
          : {}),
        communityLevel,
        ...(searchMode.mode === "sql" ? { sqlWindow } : {}),
      },
      {
        embedder: deps.embedder,
        storage: deps.storage,
        ...(deps.lexical !== undefined ? { lexical: deps.lexical } : {}),
        ...(deps.entityLexical !== undefined
          ? { entityLexical: deps.entityLexical }
          : {}),
        retrieveConfig,
        graphConfig: deps.graphConfig,
        graphRanker: deps.graphRanker,
        reranker: deps.reranker,
        debug: deps.debug,
        capabilityObservations: deps.capabilityObservations,
        projectionDrain: deps.projectionDrain,
        ...(deps.slotEmbedding !== undefined
          ? { slotEmbedding: deps.slotEmbedding }
          : {}),
        ...(deps.businessQuery !== undefined
          ? { businessQuery: deps.businessQuery }
          : {}),
      },
      control
    );

    return textResult(JSON.stringify(envelope));
  };
}

function validateRetrieveQuery(
  input: RetrieveInput,
  counter: InputValidationFailureCounter | undefined
): void {
  if (typeof input?.query === "string" && input.query.trim().length > 0) {
    return;
  }
  counter?.increment();
  throw new GraphragError(
    "retrieve query must contain at least one non-whitespace character",
    "INVALID_INPUT"
  );
}

/** Resolve the summary fineness bound; invalid input is a typed refusal. */
function resolveCommunityLevel(
  filters: Record<string, string> | undefined
): number {
  const resolution = parseCommunityLevelFilter(filters);
  if (resolution.kind === "invalid") {
    throw new GraphragError(
      invalidCommunityLevelMessage(resolution.value),
      "INVALID_INPUT"
    );
  }
  return resolution.level;
}

/**
 * Apply an input preset without mutating the startup config. Input selection
 * wins over startup selection for bundle-owned levers; arm switches, rerank
 * enablement, and graph floor remain operator configuration.
 */
function applyPreset(
  configured: RetrieveConfig | undefined,
  requested: RetrievePreset | undefined,
  waitForDrain: boolean | undefined,
  waitForDrainTimeoutMs: number | undefined
): RetrieveConfig | undefined {
  if (
    requested === undefined &&
    waitForDrain === undefined &&
    waitForDrainTimeoutMs === undefined
  ) {
    return configured;
  }
  if (requested === undefined) {
    return applyWaitOverrides(configured, waitForDrain, waitForDrainTimeoutMs);
  }
  if (!isRetrievePreset(requested)) {
    throw new RetrieveConfigError(
      `retrieve preset must be one of ${RETRIEVE_PRESETS.join(" | ")}, got "${requested}"`
    );
  }

  const bundle = RETRIEVE_PRESET_BUNDLES[requested];
  const base: RetrieveConfig = configured ?? retrieveConfigForPreset(requested);
  return applyWaitOverrides(
    {
      ...base,
      ...bundle,
      preset: requested,
    },
    waitForDrain,
    waitForDrainTimeoutMs
  );
}

function applyWaitOverrides(
  configured: RetrieveConfig | undefined,
  waitForDrain: boolean | undefined,
  waitForDrainTimeoutMs: number | undefined
): RetrieveConfig | undefined {
  if (waitForDrain === undefined && waitForDrainTimeoutMs === undefined) {
    return configured;
  }
  const base: RetrieveConfig = configured ?? DEFAULT_RETRIEVE_CONFIG;
  return {
    ...base,
    ...(waitForDrain !== undefined
      ? { waitForDrainEnabled: waitForDrain }
      : {}),
    ...(waitForDrainTimeoutMs !== undefined ? { waitForDrainTimeoutMs } : {}),
  };
}

export const retrieveTool = (deps: RetrieveDeps): ToolRegistration => ({
  name: "retrieve",
  description:
    "Ranked chunk search over the knowledge memory store, filtered by " +
    "temporal validity. filters.search_mode selects the retrieval tier from " +
    "the closed set " +
    SEARCH_MODE_WIRE_COPY +
    "; missing defaults to graph. filters.entity_type (" +
    ENTITY_TYPE_FILTER_VALUES +
    ") optionally restricts graph/entity " +
    "seeding; missing recalls all types. filters.community_level (positive " +
    "integer string) bounds community-summary reads to level <= N; missing " +
    "defaults to 2. The sql tier reads its expiry window from " +
    "filters.sql_window_start and filters.sql_window_end (inclusive " +
    "YYYY-MM-DD dates, both required) and returns business-ledger rows as " +
    "database_rows beside the chunks.",
  inputSchema:
    deps.inputValidationFailureCounter === undefined
      ? RetrieveInputSchema
      : createRetrieveInputSchema(deps.inputValidationFailureCounter),
  // The registry's erased `ToolRegistrationAny` takes `input: unknown`;
  // the schema validates upstream, so this cast is sound (mirrors the
  // other tool files).
  handler: createRetrieveHandler(
    deps
  ) as unknown as ToolRegistration["handler"],
});
