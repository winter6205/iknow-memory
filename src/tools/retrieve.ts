/**
 * Retrieve tool — semantic search over the knowledge memory store.
 *
 * Pipeline: embed query → vector search with valid_window filter → return
 * ranked chunks. Stage 3 (spec-3 p0-integration T5): when a graph-arm seam
 * (`graphArmSeed`) AND a `graphConfig` are both present, the results are
 * fused with the graph arm via RRF and the envelope gains an optional
 * `degraded` flag. When either is absent, the tool degrades to vector-only
 * and the envelope is EXACTLY `{ chunks: [...] }` (no `degraded` / `debug`
 * keys — Success Criterion #4). Input shape and `chunks[]` shape are
 * unchanged.
 */
import { z } from "zod";
import {
  textResult,
  type ToolRegistration,
  type ToolResult,
} from "./registry.js";
import type { EmbeddingClient } from "../core/embedder.js";
import type { SearchOptions, StorageBackend } from "../core/types.js";
import type { RetrieveConfig } from "../core/retrieval/types.js";
import { assembleRetrievalResult } from "../core/retrieval/index.js";

const DEFAULT_LIMIT = 10;

export const RetrieveInputSchema = z.object({
  query: z.string().min(1, "query must be a non-empty string"),
  valid_at: z.string().datetime().optional(),
  filters: z.record(z.string(), z.string()).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export type RetrieveInput = z.infer<typeof RetrieveInputSchema>;

/** Dependencies injected at wiring time (T7). */
export interface RetrieveDeps {
  embedder: EmbeddingClient;
  storage: StorageBackend;
  /**
   * Optional retrieval config. When undefined, the graph arm is skipped and
   * the tool returns vector-only results (keeps the pre-T5 shape for hosts
   * that wire embedder/storage only). Wired from `loadEnv().retrieval` at
   * the server assembly layer (T6/T7).
   */
  graphConfig?: RetrieveConfig;
  /** Debug gate; wired to `DEBUG=1` by the caller. */
  debug?: boolean;
}

export function createRetrieveHandler(deps: RetrieveDeps) {
  return async function retrieveHandler(
    input: RetrieveInput
  ): Promise<ToolResult> {
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
        graphConfig: deps.graphConfig,
        debug: deps.debug,
      }
    );

    return textResult(JSON.stringify(envelope));
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
