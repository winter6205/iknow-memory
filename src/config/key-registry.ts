import { z } from "zod";

export const effectClassSchema = z.enum([
  "restart",
  "rotate",
  "next-extraction",
]);

export type EffectClass = z.infer<typeof effectClassSchema>;

const keySpecSchema = z.object({
  env: z.string().min(1),
  secret: z.boolean(),
  effect: effectClassSchema,
  defaultValue: z.string().optional(),
});

export type KeySpec = z.infer<typeof keySpecSchema>;

function key(
  env: string,
  effect: EffectClass,
  options: { secret?: boolean; defaultValue?: string } = {}
): KeySpec {
  return {
    env,
    secret: options.secret === true,
    effect,
    ...(options.defaultValue === undefined
      ? {}
      : { defaultValue: options.defaultValue }),
  };
}

const RAW_KEYS: readonly KeySpec[] = [
  key("GRAPHRAG_MEMORY_LOG_LEVEL", "restart", { defaultValue: "info" }),
  key("GRAPHRAG_MEMORY_STORAGE", "restart", { defaultValue: "memory" }),
  key("GRAPHRAG_MEMORY_DB_URL", "restart"),
  key("GRAPHRAG_MEMORY_EMBED_DIMENSIONS", "rotate"),
  key("GRAPHRAG_MEMORY_EMBED_BASE_URL", "rotate"),
  key("GRAPHRAG_MEMORY_EMBED_MODEL", "rotate"),
  key("GRAPHRAG_MEMORY_EMBED_API_KEY", "restart", { secret: true }),
  key("GRAPHRAG_MEMORY_EMBED_API_KEY_ENV", "restart"),
  key("GRAPHRAG_MEMORY_VECTOR_API_KEY", "restart", { secret: true }),
  key("GRAPHRAG_MEMORY_ANTHROPIC_API_KEY", "restart", { secret: true }),
  key("GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS", "restart"),
  key("GRAPHRAG_MEMORY_INGEST_BATCH_LIMIT", "restart", { defaultValue: "100" }),
  key("GRAPHRAG_MEMORY_PGVECTOR_POOL_MAX", "restart", { defaultValue: "10" }),
  key("GRAPHRAG_MEMORY_PGVECTOR_CONNECTION_WAIT_TIMEOUT_MS", "restart", {
    defaultValue: "5000",
  }),
  key("GRAPHRAG_MEMORY_EXTRACT_WRITE_TIME_SUPERSEDE", "restart", {
    defaultValue: "true",
  }),
  key("FIN_BUSINESS_LEDGER_URL", "restart", { secret: true }),
  key("GRAPHRAG_MEMORY_ES_URL", "restart"),
  key("GRAPHRAG_MEMORY_ES_NODE", "restart"),
  key("GRAPHRAG_MEMORY_ES_USERNAME", "restart"),
  key("GRAPHRAG_MEMORY_ES_PASSWORD", "restart", { secret: true }),
  key("GRAPHRAG_MEMORY_ES_API_KEY", "restart", { secret: true }),
  key("GRAPHRAG_MEMORY_ES_CHUNK_INDEX", "restart", {
    defaultValue: "iknow-memory-chunks",
  }),
  key("GRAPHRAG_MEMORY_ES_ENTITY_INDEX", "restart", {
    defaultValue: "iknow-memory-entities",
  }),
  key("GRAPHRAG_MEMORY_ES_SUMMARY_INDEX", "restart", {
    defaultValue: "iknow-memory-summaries",
  }),
  key("GRAPHRAG_MEMORY_ES_REQUEST_TIMEOUT_MS", "restart", {
    defaultValue: "5000",
  }),
  key("GRAPHRAG_MEMORY_NEO4J_URI", "restart"),
  key("GRAPHRAG_MEMORY_NEO4J_USER", "restart"),
  key("GRAPHRAG_MEMORY_NEO4J_PASSWORD", "restart", { secret: true }),
  key("ANTHROPIC_AUTH_TOKEN", "restart", { secret: true }),
  key("GRAPHRAG_MEMORY_RERANK_API_KEY_ENV", "restart"),
  key("GRAPHRAG_MEMORY_ANTHROPIC_MODEL", "restart", {
    defaultValue: "MiniMax-M3",
  }),
  key("GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL", "restart", {
    defaultValue: "https://api.minimaxi.com/anthropic",
  }),
  key("GRAPHRAG_MEMORY_LLM_EXTRACT_PROTOCOL", "restart", {
    defaultValue: "anthropic",
  }),
  key("GRAPHRAG_MEMORY_LLM_EXTRACT_MODEL", "next-extraction"),
  key("GRAPHRAG_MEMORY_LLM_EXTRACT_BASE_URL", "restart"),
  key("GRAPHRAG_MEMORY_LLM_EXTRACT_API_KEY_ENV", "restart"),
  key("GRAPHRAG_MEMORY_LLM_SUMMARY_PROTOCOL", "restart", {
    defaultValue: "anthropic",
  }),
  key("GRAPHRAG_MEMORY_LLM_SUMMARY_MODEL", "next-extraction"),
  key("GRAPHRAG_MEMORY_LLM_SUMMARY_BASE_URL", "restart"),
  key("GRAPHRAG_MEMORY_LLM_SUMMARY_API_KEY_ENV", "restart"),
  key("GRAPHRAG_MEMORY_LLM_RERANK_PROTOCOL", "restart", {
    defaultValue: "anthropic",
  }),
  key("GRAPHRAG_MEMORY_LLM_RERANK_MODEL", "restart"),
  key("GRAPHRAG_MEMORY_LLM_RERANK_BASE_URL", "restart"),
  key("GRAPHRAG_MEMORY_LLM_RERANK_API_KEY_ENV", "restart"),
  key("GRAPHRAG_MEMORY_JEV_API_KEY", "restart", { secret: true }),
  key("TYPESAFE_API_KEY", "restart", { secret: true }),
  key("GRAPHRAG_MEMORY_JEV_MODEL", "restart", { defaultValue: "jev-latest" }),
  key("TYPESAFE_DEFAULT_MODEL", "restart"),
  key("GRAPHRAG_MEMORY_JEV_BASE_URL", "restart", {
    defaultValue: "https://api.typesafe.ai",
  }),
  key("TYPESAFE_BASE_URL", "restart"),
  key("GRAPHRAG_MEMORY_RETRIEVAL_PRESET", "restart", {
    defaultValue: "balanced",
  }),
  key("GRAPHRAG_MEMORY_RETRIEVAL_RRF_K", "restart", { defaultValue: "60" }),
  key("GRAPHRAG_MEMORY_RETRIEVAL_W_VEC", "restart", { defaultValue: "0.7" }),
  key("GRAPHRAG_MEMORY_RETRIEVAL_W_BM25", "restart", { defaultValue: "0.15" }),
  key("GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH", "restart", { defaultValue: "0.15" }),
  key("GRAPHRAG_MEMORY_RETRIEVAL_K1", "restart", { defaultValue: "1.2" }),
  key("GRAPHRAG_MEMORY_RETRIEVAL_B", "restart", { defaultValue: "0.75" }),
  key("GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED", "restart", {
    defaultValue: "true",
  }),
  key("GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED", "restart", {
    defaultValue: "true",
  }),
  key("GRAPHRAG_MEMORY_RETRIEVAL_NODE_EMBEDDING_ENABLED", "restart", {
    defaultValue: "false",
  }),
  key("GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED", "restart", {
    defaultValue: "true",
  }),
  key("GRAPHRAG_MEMORY_RETRIEVAL_WAIT_FOR_DRAIN_ENABLED", "restart", {
    defaultValue: "false",
  }),
  key("GRAPHRAG_MEMORY_RETRIEVAL_WAIT_FOR_DRAIN_TIMEOUT_MS", "restart", {
    defaultValue: "5000",
  }),
  key("GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL", "restart"),
  key("GRAPHRAG_MEMORY_RETRIEVAL_ENTITY_LINK_TOP_K", "restart"),
  key("GRAPHRAG_MEMORY_RETRIEVAL_CANDIDATE_CAP", "restart"),
  key("GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ARM_FLOOR", "restart", {
    defaultValue: "3",
  }),
  key("GRAPHRAG_MEMORY_RETRIEVAL_CJK_SEGMENTATION_ENABLED", "restart", {
    defaultValue: "true",
  }),
  key("GRAPHRAG_MEMORY_RETRIEVAL_PHRASE_ENABLED", "restart", {
    defaultValue: "true",
  }),
  key("GRAPHRAG_MEMORY_RETRIEVAL_FIELD_BOOST_ENABLED", "restart", {
    defaultValue: "true",
  }),
  key("GRAPHRAG_MEMORY_RETRIEVAL_FIELD_BOOSTS", "restart"),
  key("GRAPHRAG_MEMORY_RETRIEVAL_RRF_ENABLED", "restart", {
    defaultValue: "true",
  }),
  key("GRAPHRAG_MEMORY_RETRIEVAL_VECTOR_ENABLED", "restart", {
    defaultValue: "true",
  }),
  key("GRAPHRAG_MEMORY_DASHBOARD_HOST", "restart", {
    defaultValue: "127.0.0.1",
  }),
  key("GRAPHRAG_MEMORY_DASHBOARD_PORT", "restart", { defaultValue: "4174" }),
];

function assertUnique(specs: readonly KeySpec[]): readonly KeySpec[] {
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.env)) {
      throw new Error(`duplicate config key ${spec.env}`);
    }
    seen.add(spec.env);
  }
  return specs;
}

export const KEY_REGISTRY: readonly KeySpec[] = assertUnique(
  z.array(keySpecSchema).parse(RAW_KEYS)
);

const KNOWN = new Set(KEY_REGISTRY.map((spec) => spec.env));

export function isSecretKey(name: string): boolean {
  return KEY_REGISTRY.some((spec) => spec.env === name && spec.secret);
}

export function isKnownKey(name: string): boolean {
  return KNOWN.has(name);
}
