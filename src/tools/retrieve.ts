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
 * `filters.search_mode` (检索档 A|B|C|D, specs/search-mode-retrieve.md) is
 * resolved and dispatched in this handler before the arms run: missing →
 * B, invalid → typed INVALID_INPUT, A → the lexical child-hit/parent-body
 * arm (plans T2), C → the report-first community-summary arm (plans T3),
 * D → the typed `real_db_not_wired` refusal (plans T4; see
 * src/core/retrieval/search-mode.ts).
 *
 * `filters.entity_type` (plans/entity-type-and-filter.md T3) is resolved
 * and stripped the same way: missing → all types, one of the closed set →
 * typed seed restriction for the graph/entity-embedding arms, anything
 * else → typed INVALID_INPUT. It is a routing control, never a chunk
 * exact-match key; `tools/list` still exposes the single `retrieve`.
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
  cDropWindowsEnabled,
  invalidSearchModeMessage,
  parseSearchMode,
  stripCDropWindowsFilter,
  stripSearchModeFilter,
  type SearchModeControl,
} from "../core/retrieval/search-mode.js";
import {
  invalidEntityTypeMessage,
  parseEntityTypeFilter,
  stripEntityTypeFilter,
} from "../core/retrieval/wire-filters.js";
import { GraphragError } from "../core/errors.js";

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
    filters: z.record(z.string(), z.string()).optional(),
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
}

export function createRetrieveHandler(deps: RetrieveDeps) {
  return async function retrieveHandler(
    input: RetrieveInput
  ): Promise<ToolResult> {
    validateRetrieveQuery(input, deps.inputValidationFailureCounter);
    // Resolve the 档 before anything else so an invalid value is a typed
    // refusal, never a degraded or empty answer (plans/search-mode-retrieve
    // .md T1 acceptance). `search_mode` is routing, not matching: strip it
    // from the exact-match filters so arms and backends never see it.
    const searchMode = parseSearchMode(input.filters);
    if (searchMode.kind === "invalid") {
      throw new GraphragError(
        invalidSearchModeMessage(searchMode.value),
        "INVALID_INPUT"
      );
    }
    // Same contract for `filters.entity_type` (plans/entity-type-and-filter
    // .md T3): resolve before any arm runs; missing = all types, outside
    // the closed set = typed refusal, never a silent ignore. The arms see
    // only the value below — the key is stripped from the exact-match map.
    const entityTypeFilter = parseEntityTypeFilter(input.filters);
    if (entityTypeFilter.kind === "invalid") {
      throw new GraphragError(
        invalidEntityTypeMessage(entityTypeFilter.value),
        "INVALID_INPUT"
      );
    }
    // Routing keys are resolved and stripped HERE, once, for every 档
    // (review I2): each backend applies `filters` as exact-match term
    // clauses, so a left-over control key silently zeros the arm that
    // consumes it — `c_drop_windows` included. 档 C still sees its switch:
    // as the typed control value below, never as a filter key.
    const control: SearchModeControl = {
      cDropWindows: cDropWindowsEnabled(input.filters),
    };
    const matchFilters = stripEntityTypeFilter(
      stripCDropWindowsFilter(stripSearchModeFilter(input.filters))
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
    "temporal validity. filters.search_mode (A | B | C | D) selects the " +
    "retrieval tier; missing defaults to B. filters.entity_type (person | " +
    "organization | place | event) optionally restricts graph/entity " +
    "seeding; missing recalls all types.",
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
