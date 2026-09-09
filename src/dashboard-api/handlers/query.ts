/**
 * GET /api/query — thin HTTP over assembleRetrievalResult.
 */
import type { RouteHandler } from "../router.js";
import { errorEnvelope } from "../responses.js";
import {
  optionalEnum,
  parsePagination,
  readQueryParams,
  requireText,
} from "../query-params.js";
import { retrievalErrorStatus } from "../query-error.js";
import {
  assembleRetrievalResult,
  type AssembleDeps,
} from "../../core/retrieval/index.js";
import type { LexicalStorageBackend } from "../../core/storage/backend.js";
import type {
  EntityLexicalStorage,
  GraphRanker,
  ChunkReranker,
  RetrieveConfig,
  RetrievePreset,
} from "../../core/retrieval/types.js";
import {
  RETRIEVE_PRESETS,
  RETRIEVE_PRESET_BUNDLES,
} from "../../core/retrieval/types.js";
import type { EmbeddingClient } from "../../core/embedder.js";
import type { StorageBackend } from "../../core/types.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

export interface QueryDeps {
  embedder: EmbeddingClient;
  storage: StorageBackend;
  lexical?: LexicalStorageBackend;
  entityLexical?: EntityLexicalStorage;
  retrieval: RetrieveConfig;
  graphRanker?: GraphRanker;
  reranker?: ChunkReranker;
}

export function queryHandler(deps: QueryDeps): RouteHandler {
  return async (req) => {
    const params = readQueryParams(req.query);
    try {
      const q = requireText(params.get("q"), "q");
      const limit = parsePagination(
        params.get("limit"),
        DEFAULT_LIMIT,
        MAX_LIMIT
      );
      const mode = optionalEnum(params.get("mode"), RETRIEVE_PRESETS, "mode");
      const envelope = await assembleRetrievalResult(
        { query: q, validAt: new Date().toISOString(), limit },
        {
          embedder: deps.embedder,
          storage: deps.storage,
          ...(deps.lexical !== undefined ? { lexical: deps.lexical } : {}),
          ...(deps.entityLexical !== undefined
            ? { entityLexical: deps.entityLexical }
            : {}),
          retrieveConfig: applyPreset(deps.retrieval, mode),
          ...(deps.graphRanker !== undefined
            ? { graphRanker: deps.graphRanker }
            : {}),
          ...(deps.reranker !== undefined ? { reranker: deps.reranker } : {}),
        } satisfies AssembleDeps
      );
      return { status: 200, body: envelope };
    } catch (err) {
      const { status, code } = retrievalErrorStatus(err);
      return { status, body: errorEnvelope(code, err) };
    }
  };
}

/**
 * Apply a bench preset without clearing operator waitForDrain* knobs.
 */
export function applyPreset(
  configured: RetrieveConfig,
  requested: RetrievePreset | undefined
): RetrieveConfig {
  if (requested === undefined) return configured;
  const bundle = RETRIEVE_PRESET_BUNDLES[requested];
  return {
    ...configured,
    ...bundle,
    preset: requested,
    waitForDrainEnabled: configured.waitForDrainEnabled,
    waitForDrainTimeoutMs: configured.waitForDrainTimeoutMs,
  };
}
