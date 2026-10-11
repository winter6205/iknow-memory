/**
 * Credential guards and client builders for the extraction pipeline.
 *
 * Lifted from `src/cli/extract.ts` (buildLlm / buildEmbedder) so the CLI and
 * the MCP extract tool share ONE guard implementation. The environment is a
 * parameter, not a `process.env` read: the caller passes the block `loadEnv`
 * resolved on `env.llm.extract` and states its intent, and this module refuses
 * unsafe keyless runs. The pure builders below never resolve an env block.
 *
 * The SC rule (specs/mcp-tool-surface.md SC9, inherited from the CLI's
 * CR High #1 / #3 fixes): a run whose output is PERSISTED must never fall
 * back to a fake client. `FakeLLMClient` would silently INSERT canned
 * triples into Postgres; `FakeEmbedder` would store derived-hash vectors no
 * real embedder's output can ever be compared against (permanently poisoning
 * the graph arm's seed similarity). Missing credentials on such runs are a
 * typed `ConfigError`, never a downgrade.
 *
 * `FakeLLMClient` / `FakeEmbedder` stay legal only for runs that persist
 * nothing (read-only report / simulation paths).
 */
import {
  ConfigError,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  type GraphragEnv,
} from "../../config.js";
import {
  AnthropicLLMClient,
  FakeLLMClient,
  type LLMClient,
} from "./llm-client.js";
import {
  FakeEmbedder,
  NineRouterEmbedder,
  type EmbeddingClient,
} from "../embedder.js";

/** LLM endpoint settings, resolved by the caller from its own env. */
export interface LlmClientEnv {
  /**
   * Anthropic-compatible auth token (raw env value; trimmed here).
   * Undefined / empty means keyless.
   */
  authToken: string | undefined;
  /** Base URL; defaults to DEFAULT_LLM_BASE_URL (trailing slash stripped). */
  baseUrl?: string | undefined;
  /** Model id; defaults to DEFAULT_LLM_MODEL. */
  model?: string | undefined;
}

/** What the caller plans to do with LLM output — drives the keyless guard. */
export interface LlmClientIntent {
  /**
   * True when LLM output reaches a persist path (a real extraction). Keyless
   * then refuses with ConfigError instead of writing canned triples.
   */
  extraction: boolean;
}

/**
 * Canned output for the keyless fake. Scripted `ok` so read-only invocations
 * (`--dry-run` and friends) have deterministic output; it never reaches a
 * real write path because the extraction intent gates the fallback.
 */
const CANNED_OUTPUT = {
  head: "Alice",
  headType: "person",
  relationRaw: "works at",
  relationNorm: "MEMBER_OF",
  tail: "Acme",
  tailType: "organization",
  description: "Alice works at Acme",
  evidenceSpan: "Alice works at Acme",
  confidence: 0.9,
};

/**
 * Build the LLM client for an extraction run.
 *
 * Token set → `AnthropicLLMClient`. Keyless: the fallback depends on intent —
 * a non-extraction run gets the scripted fake, a real extraction gets a
 * `ConfigError` (the refusal names the CLI's keyless flags because the CLI is
 * the operator-facing entry this guard shipped with; non-CLI callers surface
 * the same ConfigError through their own error mapping).
 */
export function buildLlmClient(
  env: LlmClientEnv,
  intent: LlmClientIntent
): LLMClient {
  const apiKey = env.authToken?.trim();
  if (!apiKey) {
    if (intent.extraction) {
      throw new ConfigError(
        "refusing to run real extraction without ANTHROPIC_AUTH_TOKEN; pass --dry-run, --list-unmapped or --list-failed for keyless operation"
      );
    }
    // No key + a non-extraction path → scripted fake; canned ok so dry-run
    // has deterministic output. The fake never reaches the real write path.
    return new FakeLLMClient({
      scripted: async () => ({ kind: "ok", outputs: [CANNED_OUTPUT] }),
    });
  }
  const baseUrl = (env.baseUrl?.trim() || DEFAULT_LLM_BASE_URL).replace(
    /\/$/,
    ""
  );
  const model = env.model?.trim() || DEFAULT_LLM_MODEL;
  return new AnthropicLLMClient({ apiKey, baseUrl, model });
}

/** Embedding endpoint settings, resolved by the caller from its own env. */
export interface EmbedderClientEnv {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string | undefined;
  /** Vector dimension; storage and the embedder share it. */
  dimensions: number;
}

/** What the caller plans to write — drives the embedder's keyless guard. */
export interface EmbedderClientIntent {
  /**
   * True when the invocation persists a vector into `entities.embedding`
   * (a real extraction, or the CLI's `--backfill-embeddings` repair mode).
   */
  persistsEmbeddings: boolean;
}

/**
 * Build the embedder for an extraction run — the LLM guard mirrored for the
 * embedding half.
 *
 * Complete credentials → `NineRouterEmbedder`. Keyless: a vector-persisting
 * run refuses with `ConfigError` (a fake vector shares no space with a real
 * embedder's, and nothing downstream can tell them apart); a run that writes
 * no vector gets `FakeEmbedder`.
 */
export function buildEmbedderClient(
  env: EmbedderClientEnv,
  intent: EmbedderClientIntent
): EmbeddingClient {
  if (env.apiKey && env.baseUrl && env.model) {
    return new NineRouterEmbedder({
      baseUrl: env.baseUrl,
      model: env.model,
      apiKey: env.apiKey,
      dimensions: env.dimensions,
    });
  }
  if (intent.persistsEmbeddings) {
    throw new ConfigError(
      "refusing to persist embeddings without embedding credentials; " +
        "GRAPHRAG_MEMORY_EMBED_API_KEY, GRAPHRAG_MEMORY_VECTOR_API_KEY, or GRAPHRAG_MEMORY_ANTHROPIC_API_KEY / GRAPHRAG_MEMORY_EMBED_API_KEY_ENV, " +
        "GRAPHRAG_MEMORY_EMBED_BASE_URL and GRAPHRAG_MEMORY_EMBED_MODEL are " +
        "required for a real extraction and for --backfill-embeddings; pass " +
        "--dry-run, --list-unmapped or --list-failed for keyless operation"
    );
  }
  return new FakeEmbedder(env.dimensions);
}

/** Both clients a run that persists its extraction output needs. */
export interface PersistingExtractionClients {
  llm: LLMClient;
  embedder: EmbeddingClient;
}

/**
 * Build the client pair for a run whose extraction output is persisted.
 *
 * WHAT this one owns: the persisting intent on both guards plus the operator's
 * environment as the single source of both credentials. A caller cannot share
 * it unless both of those hold for it — the extract CLI's intent depends on its
 * own flags (`--dry-run` and friends stay keyless-legal) and the summary
 * stage's model client is not an `LLMClient`, so those call the two builders
 * above with their own intent instead.
 *
 * WHY the order is fixed inside: the LLM guard is consulted first, so a keyless
 * run reports the refusal an extraction cannot proceed without — the order the
 * extract CLI has always reported to operators.
 */
export function buildPersistingExtractionClients(
  env: GraphragEnv
): PersistingExtractionClients {
  const extractLlm = env.llm.extract;
  const llm = buildLlmClient(
    {
      authToken: extractLlm.apiKey,
      baseUrl: extractLlm.baseUrl,
      model: extractLlm.model,
    },
    { extraction: true }
  );
  const embedder = buildEmbedderClient(
    {
      apiKey: env.embedApiKey,
      baseUrl: env.embedBaseUrl,
      model: env.embedModel,
      dimensions: env.embedDimensions,
    },
    { persistsEmbeddings: true }
  );
  return { llm, embedder };
}
