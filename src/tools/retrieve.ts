/**
 * Retrieve tool — semantic search over the knowledge memory store.
 *
 * Pipeline: embed query → vector search with valid_window filter → return
 * ranked chunks. Stage 3 (spec-3 p0-integration T5): when a graph-arm seam
 * (`graphArmSeed`) AND a `graphConfig` are both present, the results are
 * fused with the graph arm via RRF. The wire envelope contains `chunks` plus
 * only the optional `degraded` and `degraded_reasons` fields; internal debug
 * diagnostics are not serialized.
 */
import { z } from "zod";
import {
  textResult,
  type ToolRegistration,
  type ToolResult,
} from "./registry.js";
import type { EmbeddingClient } from "../core/embedder.js";
import type { SearchOptions, StorageBackend } from "../core/types.js";
import type {
  CapabilityObservation,
  ChunkReranker,
  RetrievePreset,
  GraphRanker,
  ProjectionDrainWaiter,
  RetrieveConfig,
} from "../core/retrieval/types.js";
import {
  DEFAULT_RETRIEVE_PRESET,
  RETRIEVE_PRESETS,
  RETRIEVE_PRESET_BUNDLES,
  RetrieveConfigError,
  isRetrievePreset,
} from "../core/retrieval/types.js";
import { assembleRetrievalResult } from "../core/retrieval/index.js";

const DEFAULT_LIMIT = 10;

export const RetrieveInputSchema = z.object({
  query: z.string().min(1, "query must be a non-empty string"),
  valid_at: z.string().datetime().optional(),
  filters: z.record(z.string(), z.string()).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  preset: z.enum(RETRIEVE_PRESETS).optional(),
  wait_for_drain: z.boolean().optional(),
  wait_for_drain_timeout_ms: z.number().int().min(1).max(600_000).optional(),
});

export type RetrieveInput = z.infer<typeof RetrieveInputSchema>;

/** Dependencies injected at wiring time. */
export interface RetrieveDeps {
  embedder: EmbeddingClient;
  storage: StorageBackend;
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
  /** Optional read-only projection outbox wait seam. */
  projectionDrain?: ProjectionDrainWaiter;
}

export function createRetrieveHandler(deps: RetrieveDeps) {
  return async function retrieveHandler(
    input: RetrieveInput
  ): Promise<ToolResult> {
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
      ...(input.filters !== undefined ? { filters: input.filters } : {}),
    };

    const envelope = await assembleRetrievalResult(
      {
        query: input.query,
        validAt: opts.validAt,
        limit: opts.limit,
        filters: opts.filters,
      },
      {
        embedder: deps.embedder,
        storage: deps.storage,
        retrieveConfig,
        graphConfig: deps.graphConfig,
        graphRanker: deps.graphRanker,
        reranker: deps.reranker,
        debug: deps.debug,
        capabilityObservations: deps.capabilityObservations,
        projectionDrain: deps.projectionDrain,
      }
    );

    return textResult(JSON.stringify(envelope));
  };
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
  const base: RetrieveConfig = configured ?? {
    ...bundle,
    preset: DEFAULT_RETRIEVE_PRESET,
    w_graph: 0.15,
    bm25Enabled: true,
    graphEnabled: true,
    rerankEnabled: false,
    graphArmFloor: 3,
  };
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
  const bundle =
    RETRIEVE_PRESET_BUNDLES[configured?.preset ?? DEFAULT_RETRIEVE_PRESET];
  const base: RetrieveConfig = configured ?? {
    ...bundle,
    preset: DEFAULT_RETRIEVE_PRESET,
    w_graph: 0.15,
    bm25Enabled: true,
    graphEnabled: true,
    rerankEnabled: false,
    graphArmFloor: 3,
  };
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
    "Semantic search over the knowledge memory store. Returns ranked chunks filtered by temporal validity.",
  inputSchema: RetrieveInputSchema,
  // The registry's erased `ToolRegistrationAny` takes `input: unknown`;
  // the schema validates upstream, so this cast is sound (mirrors echo.ts).
  handler: createRetrieveHandler(
    deps
  ) as unknown as ToolRegistration["handler"],
});
