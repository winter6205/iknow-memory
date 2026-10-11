/**
 * Runtime config for iknow-memory MCP server.
 *
 * Loads from process.env, then `setting.json`, then `.env.local` under
 * the memory home. `cwd/.env.local` is not applied.
 *
 * LLM authentication uses ANTHROPIC_AUTH_TOKEN. Vector/embedding
 * authentication uses the dedicated embedding key or vector aliases below;
 * those credentials are never interchangeable and are never logged.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseEnvFile } from "./config/env-file.js";
import {
  memoryHomeDirectory,
  MemoryHomeMissingError,
} from "./config/memory-home.js";
import {
  resolveLayeredValue,
  resolveRawLayeredValue,
} from "./config/layered-value.js";
import {
  describeEffectiveConfig,
  type EffectiveConfigReport,
} from "./config/effective-config.js";
import {
  DEFAULT_RETRIEVE_PRESET,
  RETRIEVE_PRESET_BUNDLES,
  isRetrievePreset,
  type RetrieveConfig,
  type RetrievePreset,
} from "./core/retrieval/types.js";
import { RRF_K } from "./core/retrieval/rrf.js";
import {
  createSettingStore,
  type SettingStore,
} from "./config/setting-store.js";
import { ConfigError, projectSettingText } from "./config/operator-setting.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Storage backend selector.
 *
 * "memory"   — in-process MemoryBackend (dev/test; no persistence).
 * "pgvector" — Postgres + pgvector (T8); requires GRAPHRAG_MEMORY_DB_URL.
 */
export type StorageMode = "memory" | "pgvector";

const STORAGE_MODES: readonly StorageMode[] = ["memory", "pgvector"];

function isStorageMode(value: string): value is StorageMode {
  return (STORAGE_MODES as readonly string[]).includes(value);
}

/**
 * Embedding API key resolution — host-agnostic, no provider knowledge.
 *
 * config.ts is a pure consumer: it decides NOTHING about which key to use.
 * Settings SSOT is GraphragEnv (`loadEnv` / real `process.env` / `.env.local`).
 * Tracked `.mcp.json` is launch-only (`command` / `args` / `cwd`), not a
 * second RetrieveConfig. Untracked host JSON may optionally inject `env`
 * for secrets (never empty-string pins). Knobs, first non-blank wins:
 *   1. GRAPHRAG_MEMORY_EMBED_API_KEY     — the secret VALUE itself. Only
 *      ever set in process env or a host-local, untracked injection (e.g.
 *      Claude Code `~/.claude.json` local scope). NEVER in tracked `.mcp.json`.
 *   2. GRAPHRAG_MEMORY_VECTOR_API_KEY — the preferred vector/embedding alias.
 *   3. GRAPHRAG_MEMORY_ANTHROPIC_API_KEY — the legacy vector/embedding alias
 *      (not the LLM token).
 *   4. GRAPHRAG_MEMORY_EMBED_API_KEY_ENV — the NAME of an env var holding
 *      the secret (e.g. "NINE_ROUTER_KEY" for the iknow 9router convention,
 *      or any other var a generic host uses). config.ts just reads whatever
 *      name it is handed.
 *
 * Neither set → undefined. Production wiring turns that into an unavailable
 * embedder; the offline evaluation CLI may explicitly choose FakeEmbedder.
 * There is deliberately NO default var name here — a default would
 * re-hardcode a provider choice into config, which is exactly what this
 * indirection removes. The secret VALUE never lives in source; the var NAME
 * is supplied by the operator.
 */
const EMBED_API_KEY_VALUE_VAR = "GRAPHRAG_MEMORY_EMBED_API_KEY";
const EMBED_API_KEY_NAME_VAR = "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV";
/** Preferred vector/embedding secret — not the LLM token. */
const VECTOR_API_KEY_VAR = "GRAPHRAG_MEMORY_VECTOR_API_KEY";
/** Legacy vector alias — not the LLM token (`ANTHROPIC_AUTH_TOKEN`). */
const LEGACY_VECTOR_API_KEY_VAR = "GRAPHRAG_MEMORY_ANTHROPIC_API_KEY";

/** Env-var name for the required embedding dimension integer. */
const EMBED_DIMENSIONS_VAR = "GRAPHRAG_MEMORY_EMBED_DIMENSIONS";
/** Env-var name for the pgvector ANN dimension ceiling. */
export const PGVECTOR_ANN_MAX_DIMENSIONS_VAR =
  "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS";
/** Environment variable for the maximum number of items in one ingest call. */
export const INGEST_BATCH_LIMIT_VAR = "GRAPHRAG_MEMORY_INGEST_BATCH_LIMIT";
/**
 * Environment variable that gates write-time contradiction resolution
 * (extract pipeline T4). When ON, a triple whose (head, relation_norm)
 * matches an existing row with a DIFFERENT tail and an overlapping valid
 * window supersedes the older row in the same transaction (pointer +
 * closed validity upper bound) instead of coexisting until an operator
 * runs the offline consolidate CLI. Default ON per ADR-0009: resolving
 * contradictions at write time is ledger infrastructure, not an optional
 * retrieval feature. Explicit off is the test/escape hatch only, the same
 * shape as `graphEnabled=false`; the offline CLI stays the backfill path.
 */
export const EXTRACT_WRITE_TIME_SUPERSEDE_VAR =
  "GRAPHRAG_MEMORY_EXTRACT_WRITE_TIME_SUPERSEDE";
/** A bounded default keeps embedding requests and writes reasonably sized. */
export const DEFAULT_INGEST_BATCH_LIMIT = 100;
/** Environment variable for the PostgreSQL pool connection cap. */
export const PGVECTOR_POOL_MAX_VAR = "GRAPHRAG_MEMORY_PGVECTOR_POOL_MAX";
/** A conservative default avoids exhausting a local PostgreSQL instance. */
export const DEFAULT_PGVECTOR_POOL_MAX = 10;
/**
 * Maximum time a pool acquisition may wait before the request fails.
 * `pg` receives this value as its connectionTimeoutMillis setting too.
 */
export const PGVECTOR_CONNECTION_WAIT_TIMEOUT_MS_VAR =
  "GRAPHRAG_MEMORY_PGVECTOR_CONNECTION_WAIT_TIMEOUT_MS";
export const DEFAULT_PGVECTOR_CONNECTION_WAIT_TIMEOUT_MS = 5_000;

/** Elasticsearch precision-layer connection settings. */
export const ELASTICSEARCH_URL_VAR = "GRAPHRAG_MEMORY_ES_URL";
export const ELASTICSEARCH_NODE_VAR = "GRAPHRAG_MEMORY_ES_NODE";
export const ELASTICSEARCH_USERNAME_VAR = "GRAPHRAG_MEMORY_ES_USERNAME";
export const ELASTICSEARCH_PASSWORD_VAR = "GRAPHRAG_MEMORY_ES_PASSWORD";
export const ELASTICSEARCH_API_KEY_VAR = "GRAPHRAG_MEMORY_ES_API_KEY";
export const ELASTICSEARCH_CHUNK_INDEX_VAR = "GRAPHRAG_MEMORY_ES_CHUNK_INDEX";
export const ELASTICSEARCH_ENTITY_INDEX_VAR = "GRAPHRAG_MEMORY_ES_ENTITY_INDEX";
export const ELASTICSEARCH_SUMMARY_INDEX_VAR =
  "GRAPHRAG_MEMORY_ES_SUMMARY_INDEX";
export const ELASTICSEARCH_REQUEST_TIMEOUT_MS_VAR =
  "GRAPHRAG_MEMORY_ES_REQUEST_TIMEOUT_MS";
export const DEFAULT_ELASTICSEARCH_CHUNK_INDEX = "iknow-memory-chunks";
export const DEFAULT_ELASTICSEARCH_ENTITY_INDEX = "iknow-memory-entities";
export const DEFAULT_ELASTICSEARCH_SUMMARY_INDEX = "iknow-memory-summaries";
export const DEFAULT_ELASTICSEARCH_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Business ledger DSN (plans/post322-a2-sql-slice.md T7). The name is the
 * one specs/search-mode-business-sql-contract.md §9 uses; it reaches the
 * server only through the environment or the operator setting, and the
 * read-only credential inside it is never logged, echoed, or repeated in
 * an error message. Absent is legal and means NOT provisioned: the `sql`
 * 档 then exits the structured `real_db_not_wired` — deliberately not a
 * fail-start dependency, because a server without a ledger still answers
 * every document tier.
 */
export const BUSINESS_LEDGER_URL_VAR = "FIN_BUSINESS_LEDGER_URL";

/**
 * Startup configuration failure. Distinct from GraphragError (core/errors.ts),
 * which covers per-request tool failures: a ConfigError is unrecoverable and
 * aborts the process with EXIT_CODES.BAD_CONFIG before any transport opens.
 */
export { ConfigError };

/**
 * Neo4j sidecar connection settings (#70).
 *
 * Present only when a URI is configured. Since ADR-0006, absence with the
 * graph switch on (the default) refuses process start; only an explicit
 * `GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED=false` boots without the sidecar.
 * Credentials are optional because a local Neo4j may run with auth disabled,
 * but a half-declared pair is rejected at startup.
 */
export interface Neo4jConfig {
  /** Driver URI; scheme restricted to the bolt / neo4j family. */
  uri: string;
  /** Basic-auth user; undefined together with `password` = anonymous. */
  user: string | undefined;
  /** Basic-auth password. Never logged, never echoed into an error. */
  password: string | undefined;
}

/** One purpose LLM: protocol, model, base URL, and the resolved API key. */
export interface LlmPurpose {
  protocol: "anthropic";
  model: string;
  baseUrl: string;
  apiKey: string | undefined;
}

export interface GraphragEnv {
  logLevel: LogLevel;
  /** Which StorageBackend to construct. */
  storage: StorageMode;
  /** Postgres connection string; required iff storage === "pgvector". */
  dbUrl: string | undefined;
  /**
   * Business ledger DSN for the `sql` 档, or undefined when this instance
   * is not provisioned with a ledger. Never logged; never echoed into an
   * error. See `BUSINESS_LEDGER_URL_VAR`.
   */
  businessLedgerUrl: string | undefined;
  /**
   * Embedding endpoint base URL (trailing slash stripped). Convention
   * includes /v1 — only /embeddings is appended at call time. Undefined
   * when no embedding API key is configured.
   */
  embedBaseUrl: string | undefined;
  /**
   * Embedding model id (provider-specific, e.g. "embedding-3").
   * Undefined when no embedding API key is configured.
   */
  embedModel: string | undefined;
  /** Vector dimension. Always set — storage and embedder paths need it. */
  embedDimensions: number;
  /** Maximum vector width accepted by the configured ANN index. */
  pgvectorAnnMaxDimensions: number;
  /** Maximum number of items accepted by one ingest call. */
  ingestBatchLimit: number;
  /** Maximum number of concurrent PostgreSQL pool clients. */
  pgvectorPoolMax: number;
  /** Maximum pool-acquisition wait before a typed failure. */
  pgvectorConnectionWaitTimeoutMs: number;
  /**
   * Resolved embedding API key value; undefined means production embedding is
   * unavailable. The offline evaluation CLI may opt into FakeEmbedder.
   */
  embedApiKey: string | undefined;
  /**
   * Retrieval pipeline knobs (spec-3 p0-integration T5). Loaded from the
   * GRAPHRAG_MEMORY_RETRIEVAL_* family; validated at startup. This is the
   * config source of truth for the RRF fusion + graph-arm floor behavior.
   */
  retrieval: RetrieveConfig;
  /**
   * Neo4j sidecar connection block, or undefined when no URI is configured.
   * With the graph switch on (the default) undefined never reaches here —
   * loadEnv refuses to start (ADR-0006); it only occurs when the switch is
   * explicitly off.
   */
  neo4j: Neo4jConfig | undefined;
  /**
   * Elasticsearch precision layer, or undefined when no ES node is
   * configured. Since ADR-0007 the parse function itself stays silent about
   * that case, but loadEnv refuses to start when the lexical switch is on
   * (the default); an undefined block therefore only ever coexists with an
   * explicit off switch.
   */
  elasticsearch: ElasticsearchConfig | undefined;
  /**
   * LLM credentials for temporary retrieve rerank, or undefined when
   * `ANTHROPIC_AUTH_TOKEN` is absent. Model / base URL default to China
   * MiniMax-M3 when those env vars are unset.
   */
  rerank: RerankConfig | undefined;
  /** Dedicated HTTP rerank endpoint; undefined means the adapter is skipped. */
  rerankUrl: string | undefined;
  /**
   * TypeSafe Jev (System One) credentials for extract/merge/retrieve judges,
   * or undefined when no key is configured. Missing key does not fail-start
   * until the judge adapters are the production default.
   */
  jev: JevConfig | undefined;
  /**
   * Write-time contradiction resolution switch (extract pipeline T4).
   *
   * ON (default, ADR-0009): a triple whose (head, relation_norm) matches an
   * existing row with a DIFFERENT tail and an overlapping valid window
   * supersedes the older row in the same per-chunk transaction —
   * `superseded_by` is set, `valid_window` is closed at the new row's
   * `created_at`, the new row is inserted. The shape is byte-identical to
   * the offline CLI's `--apply` (same deterministic newest-wins rule, same
   * predicates); nothing is deleted.
   *
   * OFF: write-time behaviour is exactly the pre-T4 behaviour
   * (merge-on-overlap, otherwise insert); contradictions accumulate until
   * an operator runs `consolidate --apply`. Explicit off is the
   * test/escape hatch only, so it lives in global settings the same way
   * `graphEnabled=false` does. The consolidate CLI remains the offline
   * backfill / dry-run path, not the daily master switch.
   */
  extractWriteTimeSupersede: boolean;
  /**
   * Purpose LLM blocks. A purpose's own model, base URL, or API-key pointer
   * wins when set. Extract otherwise uses the Anthropic block, then JEV.
   * Summary otherwise copies extract. Rerank otherwise uses the Anthropic
   * rerank block; the HTTP rerank URL stays on `rerankUrl`.
   */
  llm: {
    extract: LlmPurpose;
    summary: LlmPurpose;
    rerank: LlmPurpose;
  };
}

/**
 * Credentials for the temporary retrieve rerank adapter.
 * Secret: `ANTHROPIC_AUTH_TOKEN`. Model / base URL default to MiniMax-M3
 * on `https://api.minimaxi.com/anthropic`.
 */
export interface RerankConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

/**
 * Credentials for TypeSafe Jev (`POST {baseUrl}/v1/systemone`).
 * Secret: `GRAPHRAG_MEMORY_JEV_API_KEY`, then vendor `TYPESAFE_API_KEY`.
 * Model / base URL default to `jev-latest` / `https://api.typesafe.ai`.
 */
export interface JevConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

/** Credentials and index names for the optional ES precision layer. */
export interface ElasticsearchConfig {
  /** One Elasticsearch 8.x node URL. */
  node: string;
  /** Basic-auth user, paired with `password`, or undefined. */
  username: string | undefined;
  /** Basic-auth password, never logged. */
  password: string | undefined;
  /** API key, mutually exclusive with basic auth. */
  apiKey: string | undefined;
  /** Derived chunk index containing authoritative chunk projections. */
  chunkIndex: string;
  /** Derived entity + alias index used during graph seed finding. */
  entityIndex: string;
  /**
   * ALIAS for the derived community-REPORT index (lexical arm of a
   * report-first retrieve). The precision layer publishes a generation by
   * repointing this alias at one of two physical slots it derives from the
   * configured name, `<name>-gen-0` and `<name>-gen-1`, so an operator's ILM
   * policy, index template, or privileges must target the `<name>-gen-*`
   * pattern — pinning them to this single literal name silently misses every
   * index that actually holds documents. The community-summary CLI is its
   * only writer.
   */
  summaryIndex: string;
  /** Per-request client timeout. */
  requestTimeoutMs: number;
}

/**
 * Lazily-built, mutable home override for the operator-setting store.
 *
 * The setting resolver (`config/setting-resolver.ts`) reads from a
 * `SettingStore` rooted at `$HOME/.iknow-memory/setting.json`. Production
 * callers leave this unset; tests in
 * `tests/config/setting/config-setting-integration.test.ts` inject a tmp
 * tree via `setSettingHomeForTests` so the real `~/.iknow-memory/` is
 * never read or written by a test.
 */
let settingHomeOverride: string | null = null;
let cachedSettingStore: SettingStore | null = null;
let cachedSettingMap: Record<string, string> | undefined | null = undefined;

function getSettingStore(): SettingStore {
  if (cachedSettingStore === null) {
    cachedSettingStore = createSettingStore(
      settingHomeOverride === null ? {} : { home: settingHomeOverride }
    );
  }
  return cachedSettingStore;
}

/**
 * Tests-only injection point: route the operator-setting store at a tmp
 * `home` (typically a `mkdtemp` tree) and reset every cache so the
 * next `loadEnv` reads from the injected location. `null` clears the
 * override and the caches, restoring production behavior.
 *
 * Exported because the integration test owns the tmp directory and is
 * the only legitimate caller; production code never touches this.
 */
export function setSettingHomeForTests(home: string | null): void {
  settingHomeOverride = home;
  cachedSettingStore = null;
  cachedSettingMap = undefined;
}

function rethrowMissingHome(err: unknown): never {
  if (err instanceof MemoryHomeMissingError) {
    throw new ConfigError(err.message);
  }
  throw err;
}

function settingMap(): Record<string, string> {
  try {
    if (cachedSettingMap === null || cachedSettingMap === undefined) {
      readEnvFromSettingSync("GRAPHRAG_MEMORY_LOG_LEVEL");
    }
  } catch (err) {
    rethrowMissingHome(err);
  }
  if (cachedSettingMap === null || cachedSettingMap === undefined) return {};
  return cachedSettingMap;
}

function configMemoryHome(): string {
  try {
    return memoryHomeDirectory(settingHomeOverride);
  } catch (err) {
    rethrowMissingHome(err);
  }
}

function layerSources() {
  return {
    env: process.env,
    setting: settingMap(),
    homeEnv: parseEnvFile(join(configMemoryHome(), ".env.local")),
  };
}

function readEnv(key: string): string | undefined {
  return resolveLayeredValue(key, layerSources()).value;
}

export function readLayeredEnv(key: string): string | undefined {
  return readEnv(key);
}

export function describeRuntimeEffectiveConfig(
  cwd = process.cwd()
): EffectiveConfigReport {
  return describeEffectiveConfig({
    ...layerSources(),
    cwdEnvLocalPresent: existsSync(join(cwd, ".env.local")),
  });
}

/**
 * Synchronous reader for the operator setting — used by `readEnv` /
 * `readRawEnv` to keep the existing sync contract. Loads the setting
 * file at most once per process; subsequent calls reuse the cache.
 *
 * Hidden behind a small indirection so tests can call
 * `setSettingHomeForTests` to swap the file. A malformed file surfaces
 * as ConfigError (lazy-loaded below) — same shape as the rest of the
 * config validation, never a silent empty string at the use site.
 */
function readEnvFromSettingSync(key: string): string | undefined {
  // `undefined` is the sentinel for "needs first read"; `null` is the
  // legacy sentinel from before `setSettingHomeForTests` reset to
  // `undefined`. Treat both as needing a (re)load.
  if (cachedSettingMap === null || cachedSettingMap === undefined) {
    cachedSettingMap = loadRuntimeSettingMap();
  }
  return cachedSettingMap[key];
}

function loadRuntimeSettingMap(): Record<string, string> {
  try {
    const store = getSettingStore();
    if (!existsSync(store.path)) return {};
    return projectSettingText(readFileSync(store.path, "utf8"), store.path).runtime;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    if (isSettingEnoent(err)) return {};
    throw err;
  }
}

function isSettingEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Read an environment value without collapsing an explicit blank to absent.
 * Numeric configuration needs this distinction so `KEY=` cannot silently
 * select a fallback while an actually absent key still gets its documented
 * default.
 */
function readRawEnv(key: string): string | undefined {
  return resolveRawLayeredValue(key, layerSources());
}

/**
 * Read an env var and normalize: trim whitespace, treat empty/whitespace-only
 * as absent (undefined). Keeps config.ts and index.ts in agreement without
 * relying on JS truthiness semantics at the consumption site.
 */
function readTrimmed(key: string): string | undefined {
  const raw = readEnv(key);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Parse and validate GRAPHRAG_MEMORY_EMBED_DIMENSIONS.
 *
 * Always required — every storage and embedding code path needs the
 * dimension as a positive integer. We
 * reject empty strings, 0, negatives, non-integers, and decimal values
 * at startup rather than letting a surprising 0-length vector hit the
 * DDL or the embedding provider downstream.
 */
function parseEmbedDimensions(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    throw new ConfigError(
      `${EMBED_DIMENSIONS_VAR} is required (positive integer)`
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new ConfigError(
      `${EMBED_DIMENSIONS_VAR} must be a positive integer, got "${raw}"`
    );
  }
  return n;
}

/**
 * Load the pgvector ANN width ceiling from configuration. The extension's
 * current ceiling must be declared explicitly; a missing, blank, or malformed
 * value is rejected before schema bootstrap can silently skip an index.
 */
export function readPgvectorAnnMaxDimensions(): number {
  const raw = readRawEnv(PGVECTOR_ANN_MAX_DIMENSIONS_VAR);
  if (raw === undefined || raw.trim() === "") {
    throw new ConfigError(
      `${PGVECTOR_ANN_MAX_DIMENSIONS_VAR} is required (finite positive integer)`
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new ConfigError(
      `${PGVECTOR_ANN_MAX_DIMENSIONS_VAR} must be a finite positive integer, got "${raw}"`
    );
  }
  return n;
}

/**
 * Parse a positive integer with an explicit default for an absent env var.
 * A present blank value is rejected as a missing configuration value rather
 * than silently selecting the default.
 */
function parseConfiguredPositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number
): number {
  if (raw === undefined) return fallback;
  if (raw.trim() === "") {
    throw new ConfigError(`${name} is required and must be a positive integer`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new ConfigError(
      `${name} must be a finite positive integer, got "${raw}"`
    );
  }
  return n;
}

/** Read the batch limit used by the ingest surface. */
export function readIngestBatchLimit(): number {
  return parseConfiguredPositiveInt(
    INGEST_BATCH_LIMIT_VAR,
    readRawEnv(INGEST_BATCH_LIMIT_VAR),
    DEFAULT_INGEST_BATCH_LIMIT
  );
}

export interface PgvectorPoolConfig {
  max: number;
  connectionWaitTimeoutMs: number;
}

/** Read the PostgreSQL pool cap and acquisition timeout. */
export function readPgvectorPoolConfig(): PgvectorPoolConfig {
  return {
    max: parseConfiguredPositiveInt(
      PGVECTOR_POOL_MAX_VAR,
      readRawEnv(PGVECTOR_POOL_MAX_VAR),
      DEFAULT_PGVECTOR_POOL_MAX
    ),
    connectionWaitTimeoutMs: parseConfiguredPositiveInt(
      PGVECTOR_CONNECTION_WAIT_TIMEOUT_MS_VAR,
      readRawEnv(PGVECTOR_CONNECTION_WAIT_TIMEOUT_MS_VAR),
      DEFAULT_PGVECTOR_CONNECTION_WAIT_TIMEOUT_MS
    ),
  };
}

// --- Retrieval config (spec-3 p0-integration T5) ---

const RETRIEVAL_W_VEC_VAR = "GRAPHRAG_MEMORY_RETRIEVAL_W_VEC";
const RETRIEVAL_W_BM25_VAR = "GRAPHRAG_MEMORY_RETRIEVAL_W_BM25";
const RETRIEVAL_W_GRAPH_VAR = "GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH";
const RETRIEVAL_RRF_K_VAR = "GRAPHRAG_MEMORY_RETRIEVAL_RRF_K";
const RETRIEVAL_BM25_ENABLED_VAR = "GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED";
const RETRIEVAL_GRAPH_ENABLED_VAR = "GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED";
const RETRIEVAL_NODE_EMBEDDING_ENABLED_VAR =
  "GRAPHRAG_MEMORY_RETRIEVAL_NODE_EMBEDDING_ENABLED";
const RETRIEVAL_RERANK_ENABLED_VAR = "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED";
const RETRIEVAL_WAIT_FOR_DRAIN_ENABLED_VAR =
  "GRAPHRAG_MEMORY_RETRIEVAL_WAIT_FOR_DRAIN_ENABLED";
const RETRIEVAL_WAIT_FOR_DRAIN_TIMEOUT_MS_VAR =
  "GRAPHRAG_MEMORY_RETRIEVAL_WAIT_FOR_DRAIN_TIMEOUT_MS";
const RETRIEVAL_RERANK_URL_VAR = "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL";
const RETRIEVAL_PRESET_VAR = "GRAPHRAG_MEMORY_RETRIEVAL_PRESET";
export const RETRIEVAL_K1_VAR = "GRAPHRAG_MEMORY_RETRIEVAL_K1";
export const RETRIEVAL_B_VAR = "GRAPHRAG_MEMORY_RETRIEVAL_B";
export const RETRIEVAL_CJK_SEGMENTATION_ENABLED_VAR =
  "GRAPHRAG_MEMORY_RETRIEVAL_CJK_SEGMENTATION_ENABLED";
export const RETRIEVAL_PHRASE_ENABLED_VAR =
  "GRAPHRAG_MEMORY_RETRIEVAL_PHRASE_ENABLED";
export const RETRIEVAL_FIELD_BOOST_ENABLED_VAR =
  "GRAPHRAG_MEMORY_RETRIEVAL_FIELD_BOOST_ENABLED";
export const RETRIEVAL_FIELD_BOOSTS_VAR =
  "GRAPHRAG_MEMORY_RETRIEVAL_FIELD_BOOSTS";
export const RETRIEVAL_RRF_ENABLED_VAR =
  "GRAPHRAG_MEMORY_RETRIEVAL_RRF_ENABLED";
export const RETRIEVAL_VECTOR_ENABLED_VAR =
  "GRAPHRAG_MEMORY_RETRIEVAL_VECTOR_ENABLED";
const LLM_AUTH_TOKEN_VAR = "ANTHROPIC_AUTH_TOKEN";
const RERANK_API_KEY_NAME_VAR = "GRAPHRAG_MEMORY_RERANK_API_KEY_ENV";
/** Operator-setting / env name for the TypeSafe Jev secret. */
export const JEV_API_KEY_VAR = "GRAPHRAG_MEMORY_JEV_API_KEY";
/** Official SDK env name; used when the namespaced key is absent. */
const TYPESAFE_API_KEY_VAR = "TYPESAFE_API_KEY";
export const JEV_MODEL_VAR = "GRAPHRAG_MEMORY_JEV_MODEL";
const TYPESAFE_DEFAULT_MODEL_VAR = "TYPESAFE_DEFAULT_MODEL";
export const JEV_BASE_URL_VAR = "GRAPHRAG_MEMORY_JEV_BASE_URL";
const TYPESAFE_BASE_URL_VAR = "TYPESAFE_BASE_URL";
const DEFAULT_JEV_MODEL = "jev-latest";
const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";
const ANTHROPIC_MODEL_VAR = "GRAPHRAG_MEMORY_ANTHROPIC_MODEL";
const ANTHROPIC_BASE_URL_VAR = "GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL";
const llmProtocolSchema = z.enum(["anthropic"]);

interface LlmPurposeVars {
  protocol: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
}

const EXTRACT_LLM: LlmPurposeVars = {
  protocol: "GRAPHRAG_MEMORY_LLM_EXTRACT_PROTOCOL",
  model: "GRAPHRAG_MEMORY_LLM_EXTRACT_MODEL",
  baseUrl: "GRAPHRAG_MEMORY_LLM_EXTRACT_BASE_URL",
  apiKeyEnv: "GRAPHRAG_MEMORY_LLM_EXTRACT_API_KEY_ENV",
};
const SUMMARY_LLM: LlmPurposeVars = {
  protocol: "GRAPHRAG_MEMORY_LLM_SUMMARY_PROTOCOL",
  model: "GRAPHRAG_MEMORY_LLM_SUMMARY_MODEL",
  baseUrl: "GRAPHRAG_MEMORY_LLM_SUMMARY_BASE_URL",
  apiKeyEnv: "GRAPHRAG_MEMORY_LLM_SUMMARY_API_KEY_ENV",
};
const RERANK_LLM: LlmPurposeVars = {
  protocol: "GRAPHRAG_MEMORY_LLM_RERANK_PROTOCOL",
  model: "GRAPHRAG_MEMORY_LLM_RERANK_MODEL",
  baseUrl: "GRAPHRAG_MEMORY_LLM_RERANK_BASE_URL",
  apiKeyEnv: "GRAPHRAG_MEMORY_LLM_RERANK_API_KEY_ENV",
};
/** China MiniMax Anthropic-compatible SDK base (not api.minimax.io). */
export const DEFAULT_LLM_BASE_URL = "https://api.minimaxi.com/anthropic";
/** China MiniMax M3 model id. */
export const DEFAULT_LLM_MODEL = "MiniMax-M3";
const RETRIEVAL_ENTITY_LINK_TOP_K_VAR =
  "GRAPHRAG_MEMORY_RETRIEVAL_ENTITY_LINK_TOP_K";
const RETRIEVAL_CANDIDATE_CAP_VAR = "GRAPHRAG_MEMORY_RETRIEVAL_CANDIDATE_CAP";
const RETRIEVAL_GRAPH_ARM_FLOOR_VAR =
  "GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ARM_FLOOR";

/**
 * Parse a positive integer env var with an optional lower bound. `fallback`
 * is used when the var is unset (or blank). Rejects non-numeric, non-integer,
 * and out-of-range values with ConfigError naming the offending var.
 */
function parsePositiveInt(
  name: string,
  raw: string | undefined,
  opts: { min: number; fallback: number }
): number {
  const value =
    raw !== undefined && raw.trim() !== "" ? raw : String(opts.fallback);
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < opts.min) {
    throw new ConfigError(
      `${name} must be a positive integer >= ${opts.min}, got "${raw}"`
    );
  }
  return n;
}

/**
 * Parse a finite strictly-positive number (RRF weights). `fallback` is used
 * when the var is unset (or blank). Rejects non-finite (NaN/Infinity), zero,
 * and negative values.
 */
function parseFinitePositive(
  name: string,
  raw: string | undefined,
  fallback: number
): number {
  if (raw !== undefined && raw.trim() === "") {
    throw new ConfigError(
      `${name} must be a finite positive number, got "${raw}"`
    );
  }
  const value = raw !== undefined ? raw : String(fallback);
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(
      `${name} must be a finite positive number, got "${raw}"`
    );
  }
  return n;
}

const DEFAULT_RETRIEVAL_FIELD_BOOSTS: Readonly<Record<string, number>> = {
  content: 1,
  source_ref: 1,
  "metadata.*": 1,
};

function parseFieldBoosts(raw: string | undefined): Record<string, number> {
  if (raw === undefined || raw.trim() === "") {
    return { ...DEFAULT_RETRIEVAL_FIELD_BOOSTS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(
      `${RETRIEVAL_FIELD_BOOSTS_VAR} must be a JSON object of non-negative finite weights`
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length === 0
  ) {
    throw new ConfigError(
      `${RETRIEVAL_FIELD_BOOSTS_VAR} must be a non-empty JSON object of non-negative finite weights`
    );
  }
  const result: Record<string, number> = {};
  for (const [field, value] of Object.entries(parsed)) {
    const n = typeof value === "number" ? value : Number(value);
    if (field.trim() === "" || !Number.isFinite(n) || n < 0) {
      throw new ConfigError(
        `${RETRIEVAL_FIELD_BOOSTS_VAR} field "${field}" must have a finite non-negative weight`
      );
    }
    result[field] = n;
  }
  return result;
}

/**
 * Parse a boolean env var. `fallback` is used when the var is unset or
 * blank. Accepts only true/false/1/0 (trimmed, case-insensitive) — no
 * truthiness coercion, because a mistyped "on" or "yes" silently reading
 * as `false` would leave an operator running a retrieval mode they did
 * not choose. Anything else is a ConfigError naming the var.
 */
function parseBoolean(
  name: string,
  raw: string | undefined,
  fallback: boolean
): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new ConfigError(
    `${name} must be one of true | false | 1 | 0, got "${raw}"`
  );
}

/**
 * Load + validate the GRAPHRAG_MEMORY_RETRIEVAL_* family into a RetrieveConfig.
 *
 * The mode bundle defaults to balanced. Its values are the baseline for
 * weights, seed width, candidate window, and neighbor evidence; explicit
 * environment knobs still override the bundle's numeric values. `w_graph`
 * still weights the Neo4j graph arm, not the archived SQL one-hop arm.
 *
 * Enforces the spec §Boundaries: finite positive weights; entityLinkTopK > 0;
 * candidateCap >= entityLinkTopK; graphArmFloor > 0.
 */
function parseRetrievePreset(raw: string | undefined): RetrievePreset {
  const value = raw?.trim() || DEFAULT_RETRIEVE_PRESET;
  if (!isRetrievePreset(value)) {
    throw new ConfigError(
      `${RETRIEVAL_PRESET_VAR} must be one of ${Object.keys(RETRIEVE_PRESET_BUNDLES).join(" | ")}, got "${raw}"`
    );
  }
  return value;
}

function parseRetrievalConfig(): RetrieveConfig {
  const preset = parseRetrievePreset(readEnv(RETRIEVAL_PRESET_VAR));
  const bundle = RETRIEVE_PRESET_BUNDLES[preset];
  const entityLinkTopK = parsePositiveInt(
    RETRIEVAL_ENTITY_LINK_TOP_K_VAR,
    readEnv(RETRIEVAL_ENTITY_LINK_TOP_K_VAR),
    { min: 1, fallback: bundle.entityLinkTopK }
  );
  const candidateCap = parsePositiveInt(
    RETRIEVAL_CANDIDATE_CAP_VAR,
    readEnv(RETRIEVAL_CANDIDATE_CAP_VAR),
    { min: 1, fallback: bundle.candidateCap }
  );
  if (candidateCap < entityLinkTopK) {
    throw new ConfigError(
      `${RETRIEVAL_CANDIDATE_CAP_VAR} (${candidateCap}) must be >= ${RETRIEVAL_ENTITY_LINK_TOP_K_VAR} (${entityLinkTopK})`
    );
  }
  return {
    preset,
    rrfK: parseFinitePositive(
      RETRIEVAL_RRF_K_VAR,
      readRawEnv(RETRIEVAL_RRF_K_VAR),
      RRF_K
    ),
    w_vec: parseFinitePositive(
      RETRIEVAL_W_VEC_VAR,
      readRawEnv(RETRIEVAL_W_VEC_VAR),
      bundle.w_vec
    ),
    w_bm25: parseFinitePositive(
      RETRIEVAL_W_BM25_VAR,
      readRawEnv(RETRIEVAL_W_BM25_VAR),
      bundle.w_bm25
    ),
    w_graph: parseFinitePositive(
      RETRIEVAL_W_GRAPH_VAR,
      readRawEnv(RETRIEVAL_W_GRAPH_VAR),
      0.15
    ),
    k1: parseFinitePositive(
      RETRIEVAL_K1_VAR,
      readRawEnv(RETRIEVAL_K1_VAR),
      1.2
    ),
    b: parseFinitePositive(RETRIEVAL_B_VAR, readRawEnv(RETRIEVAL_B_VAR), 0.75),
    bm25Enabled: parseBoolean(
      RETRIEVAL_BM25_ENABLED_VAR,
      readEnv(RETRIEVAL_BM25_ENABLED_VAR),
      true
    ),
    cjkSegmentationEnabled: parseBoolean(
      RETRIEVAL_CJK_SEGMENTATION_ENABLED_VAR,
      readEnv(RETRIEVAL_CJK_SEGMENTATION_ENABLED_VAR),
      true
    ),
    phraseEnabled: parseBoolean(
      RETRIEVAL_PHRASE_ENABLED_VAR,
      readEnv(RETRIEVAL_PHRASE_ENABLED_VAR),
      true
    ),
    fieldBoostEnabled: parseBoolean(
      RETRIEVAL_FIELD_BOOST_ENABLED_VAR,
      readEnv(RETRIEVAL_FIELD_BOOST_ENABLED_VAR),
      true
    ),
    fieldBoosts: parseFieldBoosts(readRawEnv(RETRIEVAL_FIELD_BOOSTS_VAR)),
    rrfEnabled: parseBoolean(
      RETRIEVAL_RRF_ENABLED_VAR,
      readEnv(RETRIEVAL_RRF_ENABLED_VAR),
      true
    ),
    vectorEnabled: parseBoolean(
      RETRIEVAL_VECTOR_ENABLED_VAR,
      readEnv(RETRIEVAL_VECTOR_ENABLED_VAR),
      true
    ),
    graphEnabled: parseBoolean(
      RETRIEVAL_GRAPH_ENABLED_VAR,
      readEnv(RETRIEVAL_GRAPH_ENABLED_VAR),
      true
    ),
    nodeEmbeddingEnabled: parseBoolean(
      RETRIEVAL_NODE_EMBEDDING_ENABLED_VAR,
      readEnv(RETRIEVAL_NODE_EMBEDDING_ENABLED_VAR),
      false
    ),
    rerankEnabled: parseBoolean(
      RETRIEVAL_RERANK_ENABLED_VAR,
      readEnv(RETRIEVAL_RERANK_ENABLED_VAR),
      true
    ),
    waitForDrainEnabled: parseBoolean(
      RETRIEVAL_WAIT_FOR_DRAIN_ENABLED_VAR,
      readEnv(RETRIEVAL_WAIT_FOR_DRAIN_ENABLED_VAR),
      false
    ),
    waitForDrainTimeoutMs: parsePositiveInt(
      RETRIEVAL_WAIT_FOR_DRAIN_TIMEOUT_MS_VAR,
      readEnv(RETRIEVAL_WAIT_FOR_DRAIN_TIMEOUT_MS_VAR),
      { min: 1, fallback: 5_000 }
    ),
    entityLinkTopK,
    candidateCap,
    neighborWidth: bundle.neighborWidth,
    graphArmFloor: parsePositiveInt(
      RETRIEVAL_GRAPH_ARM_FLOOR_VAR,
      readEnv(RETRIEVAL_GRAPH_ARM_FLOOR_VAR),
      { min: 1, fallback: 3 }
    ),
  };
}

// --- Neo4j sidecar config (#70) ---

/**
 * Exported because the projection CLI names it in its own "you asked me to
 * project but gave me no target" ConfigError. The var is spelled once, here.
 */
export const NEO4J_URI_VAR = "GRAPHRAG_MEMORY_NEO4J_URI";
const NEO4J_USER_VAR = "GRAPHRAG_MEMORY_NEO4J_USER";
const NEO4J_PASSWORD_VAR = "GRAPHRAG_MEMORY_NEO4J_PASSWORD";

/** URI schemes the Neo4j driver can dial. */
const NEO4J_URI_SCHEMES: readonly string[] = [
  "bolt:",
  "bolt+s:",
  "bolt+ssc:",
  "neo4j:",
  "neo4j+s:",
  "neo4j+ssc:",
];

/**
 * Load + validate the GRAPHRAG_MEMORY_NEO4J_* family.
 *
 * No URI → undefined. Since ADR-0006 the parse function itself stays silent
 * about that case, but loadEnv refuses to start when the graph switch is on
 * (the default); an undefined block therefore only ever coexists with an
 * explicit off switch. Anything the operator DID declare must be usable:
 * a URI the driver cannot dial, credentials with nothing to connect to,
 * or half a credential pair all abort at startup. Silently ignoring them
 * would hand an operator a server they believe is graph-backed while it
 * quietly answers from two arms.
 */
function parseNeo4jConfig(): Neo4jConfig | undefined {
  const uri = readTrimmed(NEO4J_URI_VAR);
  const user = readTrimmed(NEO4J_USER_VAR);
  const password = readTrimmed(NEO4J_PASSWORD_VAR);

  if (uri === undefined) {
    if (user === undefined && password === undefined) return undefined;
    throw new ConfigError(
      `${NEO4J_URI_VAR} is required when ${NEO4J_USER_VAR} or ${NEO4J_PASSWORD_VAR} is set`
    );
  }
  if (!NEO4J_URI_SCHEMES.includes(uriScheme(uri) ?? "")) {
    throw new ConfigError(
      `${NEO4J_URI_VAR} must use one of ${NEO4J_URI_SCHEMES.map((s) => `${s}//`).join(" | ")}, got "${uri}"`
    );
  }
  if (user !== undefined && password === undefined) {
    throw new ConfigError(
      `${NEO4J_PASSWORD_VAR} is required when ${NEO4J_USER_VAR} is set`
    );
  }
  if (password !== undefined && user === undefined) {
    throw new ConfigError(
      `${NEO4J_USER_VAR} is required when ${NEO4J_PASSWORD_VAR} is set`
    );
  }
  return { uri, user, password };
}

/**
 * ADR-0006 / ADR-0007 fail-start: a process whose graph, rerank, or lexical
 * switch is on (the default) must not boot without the dependency the
 * production retrieve path would need. Graph requires a usable Neo4j
 * config; rerank requires the HTTP endpoint (`env.rerankUrl`) or the
 * MiniMax/Anthropic LLM secret (`env.rerank`); the precision layer requires
 * an Elasticsearch address (`env.elasticsearch`). An explicit off switch
 * keeps missing deps legal — that is a choice, not a degradation, so no
 * degraded implication is recorded here. Vector keeps ADR-0005 rule 1
 * (start + skip / degraded) and is deliberately not consulted.
 */
function assertFailStart(
  retrieval: RetrieveConfig,
  neo4j: Neo4jConfig | undefined,
  rerankUrl: string | undefined,
  rerank: RerankConfig | undefined,
  elasticsearch: ElasticsearchConfig | undefined
): void {
  if (retrieval.graphEnabled && neo4j === undefined) {
    throw new ConfigError(
      `${RETRIEVAL_GRAPH_ENABLED_VAR} is on (default) but ${NEO4J_URI_VAR} is not configured: a default-on graph capability cannot start without its Neo4j sidecar (ADR-0006 fail-start). Set ${NEO4J_URI_VAR}, or explicitly set ${RETRIEVAL_GRAPH_ENABLED_VAR}=false to run without the graph arm.`
    );
  }
  if (
    retrieval.rerankEnabled &&
    rerankUrl === undefined &&
    rerank === undefined
  ) {
    throw new ConfigError(
      `${RETRIEVAL_RERANK_ENABLED_VAR} is on (default) but neither ${RETRIEVAL_RERANK_URL_VAR} nor ${LLM_AUTH_TOKEN_VAR} is configured: a default-on rerank capability cannot start without its HTTP endpoint or LLM secret (ADR-0006 fail-start). Set ${RETRIEVAL_RERANK_URL_VAR} or ${LLM_AUTH_TOKEN_VAR} (or ${RERANK_API_KEY_NAME_VAR}), or explicitly set ${RETRIEVAL_RERANK_ENABLED_VAR}=false to run without reranking.`
    );
  }
  if (retrieval.bm25Enabled && elasticsearch === undefined) {
    throw new ConfigError(
      `${RETRIEVAL_BM25_ENABLED_VAR} is on (default) but neither ${ELASTICSEARCH_URL_VAR} nor ${ELASTICSEARCH_NODE_VAR} is configured: a default-on precision layer cannot start without its Elasticsearch address (ADR-0007 fail-start). Set ${ELASTICSEARCH_URL_VAR}, or explicitly set ${RETRIEVAL_BM25_ENABLED_VAR}=false to run vector-only.`
    );
  }
}

/**
 * Load retrieve-rerank credentials.
 *
 * Key is `ANTHROPIC_AUTH_TOKEN`, or the var named by
 * `GRAPHRAG_MEMORY_RERANK_API_KEY_ENV` (operator MiniMax pointer). Model /
 * base URL default to China MiniMax M3 when unset. No key → undefined.
 * Explicit MODEL / BASE_URL still override when a key exists.
 */
function resolveRerankApiKey(): string | undefined {
  const keyEnvName = readTrimmed(RERANK_API_KEY_NAME_VAR);
  if (keyEnvName !== undefined) {
    const pointed = readTrimmed(keyEnvName);
    if (pointed !== undefined) return pointed;
  }
  return readTrimmed(LLM_AUTH_TOKEN_VAR);
}

function stripBaseUrl(url: string): string {
  return url.replace(/\/$/, "");
}

function anthropicPurpose(): LlmPurpose {
  return {
    protocol: "anthropic",
    model: readTrimmed(ANTHROPIC_MODEL_VAR) ?? DEFAULT_LLM_MODEL,
    baseUrl: stripBaseUrl(
      readTrimmed(ANTHROPIC_BASE_URL_VAR) ?? DEFAULT_LLM_BASE_URL
    ),
    apiKey: readTrimmed(LLM_AUTH_TOKEN_VAR),
  };
}

function fallbackExtract(jev: JevConfig | undefined): LlmPurpose {
  const anthropic = anthropicPurpose();
  const anthropicSet =
    anthropic.apiKey !== undefined ||
    readTrimmed(ANTHROPIC_MODEL_VAR) !== undefined ||
    readTrimmed(ANTHROPIC_BASE_URL_VAR) !== undefined;
  if (anthropicSet || jev === undefined) return anthropic;
  return {
    protocol: "anthropic",
    model: jev.model,
    baseUrl: jev.baseUrl,
    apiKey: jev.apiKey,
  };
}

function fallbackRerank(): LlmPurpose {
  return { ...anthropicPurpose(), apiKey: resolveRerankApiKey() };
}

function readLlmProtocol(varName: string): "anthropic" {
  const raw = readTrimmed(varName);
  if (raw === undefined) return "anthropic";
  const parsed = llmProtocolSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`${varName} must be anthropic, got "${raw}"`);
  }
  return parsed.data;
}

function purposeKeySet(vars: LlmPurposeVars): boolean {
  return (
    readTrimmed(vars.model) !== undefined ||
    readTrimmed(vars.baseUrl) !== undefined ||
    readTrimmed(vars.apiKeyEnv) !== undefined
  );
}

function resolvePurpose(
  vars: LlmPurposeVars,
  fallback: LlmPurpose
): LlmPurpose {
  const protocol = readLlmProtocol(vars.protocol);
  if (!purposeKeySet(vars)) return { ...fallback, protocol };
  const pointer = readTrimmed(vars.apiKeyEnv);
  const baseRaw = readTrimmed(vars.baseUrl);
  return {
    protocol,
    model: readTrimmed(vars.model) ?? fallback.model,
    baseUrl: stripBaseUrl(baseRaw ?? fallback.baseUrl),
    apiKey: pointer === undefined ? fallback.apiKey : readTrimmed(pointer),
  };
}

function resolveLlmPurposes(jev: JevConfig | undefined): GraphragEnv["llm"] {
  const extract = resolvePurpose(EXTRACT_LLM, fallbackExtract(jev));
  return {
    extract,
    summary: resolvePurpose(SUMMARY_LLM, extract),
    rerank: resolvePurpose(RERANK_LLM, fallbackRerank()),
  };
}

function rerankConfigFromPurpose(
  purpose: LlmPurpose
): RerankConfig | undefined {
  if (purpose.apiKey === undefined) return undefined;
  return {
    apiKey: purpose.apiKey,
    model: purpose.model,
    baseUrl: purpose.baseUrl,
  };
}

function resolveJevApiKey(): string | undefined {
  return readTrimmed(JEV_API_KEY_VAR) ?? readTrimmed(TYPESAFE_API_KEY_VAR);
}

function parseJevConfig(): JevConfig | undefined {
  const apiKey = resolveJevApiKey();
  if (apiKey === undefined) return undefined;
  const model =
    readTrimmed(JEV_MODEL_VAR) ??
    readTrimmed(TYPESAFE_DEFAULT_MODEL_VAR) ??
    DEFAULT_JEV_MODEL;
  const baseUrl = (
    readTrimmed(JEV_BASE_URL_VAR) ??
    readTrimmed(TYPESAFE_BASE_URL_VAR) ??
    DEFAULT_JEV_BASE_URL
  ).replace(/\/$/, "");
  return { apiKey, model, baseUrl };
}

function isElasticsearchIndexName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    /^[a-z0-9][a-z0-9_-]*$/.test(value)
  );
}

/**
 * Load the optional Elasticsearch precision-layer connection block.
 *
 * No address → undefined. Since ADR-0007 `assertFailStart` refuses to
 * start when the precision layer is default-on, so an undefined block only
 * ever coexists with an explicit off switch. Values that look like an
 * attempted configuration are rejected early so a typo cannot silently
 * select a different deployment.
 */
/** Resolve one derived ES index name from its env var, else the default, then validate. */
function resolveElasticsearchIndex(name: string, fallback: string): string {
  const index = readTrimmed(name) ?? fallback;
  if (!isElasticsearchIndexName(index)) {
    throw new ConfigError(
      `${name} must be a lowercase Elasticsearch index name`
    );
  }
  return index;
}

function parseElasticsearchConfig(): ElasticsearchConfig | undefined {
  const node =
    readTrimmed(ELASTICSEARCH_URL_VAR) ?? readTrimmed(ELASTICSEARCH_NODE_VAR);
  const username = readTrimmed(ELASTICSEARCH_USERNAME_VAR);
  const password = readTrimmed(ELASTICSEARCH_PASSWORD_VAR);
  const apiKey = readTrimmed(ELASTICSEARCH_API_KEY_VAR);

  if (node === undefined) {
    if (
      username !== undefined ||
      password !== undefined ||
      apiKey !== undefined
    ) {
      throw new ConfigError(
        `${ELASTICSEARCH_URL_VAR} is required when Elasticsearch credentials are set`
      );
    }
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(node);
  } catch {
    throw new ConfigError(
      `${ELASTICSEARCH_URL_VAR} must be an http:// or https:// URL`
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(
      `${ELASTICSEARCH_URL_VAR} must be an http:// or https:// URL`
    );
  }
  if (username !== undefined && password === undefined) {
    throw new ConfigError(
      `${ELASTICSEARCH_PASSWORD_VAR} is required when ${ELASTICSEARCH_USERNAME_VAR} is set`
    );
  }
  if (password !== undefined && username === undefined) {
    throw new ConfigError(
      `${ELASTICSEARCH_USERNAME_VAR} is required when ${ELASTICSEARCH_PASSWORD_VAR} is set`
    );
  }
  if (
    apiKey !== undefined &&
    (username !== undefined || password !== undefined)
  ) {
    throw new ConfigError(
      `${ELASTICSEARCH_API_KEY_VAR} cannot be combined with Elasticsearch username/password`
    );
  }

  const indexNames = {
    chunkIndex: resolveElasticsearchIndex(
      ELASTICSEARCH_CHUNK_INDEX_VAR,
      DEFAULT_ELASTICSEARCH_CHUNK_INDEX
    ),
    entityIndex: resolveElasticsearchIndex(
      ELASTICSEARCH_ENTITY_INDEX_VAR,
      DEFAULT_ELASTICSEARCH_ENTITY_INDEX
    ),
    summaryIndex: resolveElasticsearchIndex(
      ELASTICSEARCH_SUMMARY_INDEX_VAR,
      DEFAULT_ELASTICSEARCH_SUMMARY_INDEX
    ),
  };

  return {
    node: node.replace(/\/$/, ""),
    username,
    password,
    apiKey,
    ...indexNames,
    requestTimeoutMs: parseConfiguredPositiveInt(
      ELASTICSEARCH_REQUEST_TIMEOUT_MS_VAR,
      readRawEnv(ELASTICSEARCH_REQUEST_TIMEOUT_MS_VAR),
      DEFAULT_ELASTICSEARCH_REQUEST_TIMEOUT_MS
    ),
  };
}

/**
 * Load the business ledger DSN. Absent → undefined (the `sql` 档 exits
 * not-provisioned). A declared value must be usable: only PostgreSQL URI
 * schemes are accepted (spec §5.1 fixes the engine assumption for this
 * path), and the error names the var without echoing the value — it can
 * carry a password.
 */
function parseBusinessLedgerUrl(): string | undefined {
  const url = readTrimmed(BUSINESS_LEDGER_URL_VAR);
  if (url === undefined) return undefined;
  const scheme = uriScheme(url);
  if (scheme !== "postgresql:" && scheme !== "postgres:") {
    throw new ConfigError(
      `${BUSINESS_LEDGER_URL_VAR} must be a postgresql:// or postgres:// connection string (the value is not echoed)`
    );
  }
  return url;
}

/** Scheme of `uri` including the colon, or undefined if it is not a URI. */
function uriScheme(uri: string): string | undefined {
  try {
    return new URL(uri).protocol;
  } catch {
    // EXIT: undefined 上行给 parseNeo4jConfig，由它抛出点名该 env var 的 ConfigError
    return undefined;
  }
}

/**
 * Read + validate the runtime environment.
 *
 * Throws ConfigError on any unusable combination. Failing loudly at startup
 * is deliberate: silently coercing an unknown storage mode to "memory" would
 * hand an operator a server that answers queries from an empty in-process
 * store while they believe it is talking to Postgres. Same logic applies to
 * missing embedding credentials: the server starts, but production retrieval
 * must expose the unavailable vector capability instead of fabricating one.
 */
export function loadEnv(): GraphragEnv {
  // Stage 0 is stdio-only (map #33 defers HTTP to T-005/#36). Transport is
  // hard-coded to stdio at the call site in src/index.ts; it is NOT a config
  // knob here. The previous `transport` field + no-op ternary was dead code
  // that silently coerced every value to "stdio" while pretending otherwise.
  const rawLog = readEnv("GRAPHRAG_MEMORY_LOG_LEVEL") ?? "info";
  const logLevel: LogLevel = isLogLevel(rawLog) ? rawLog : "info";

  const rawStorage = readEnv("GRAPHRAG_MEMORY_STORAGE") ?? "memory";
  if (!isStorageMode(rawStorage)) {
    throw new ConfigError(
      `GRAPHRAG_MEMORY_STORAGE must be one of ${STORAGE_MODES.join(" | ")}, got "${rawStorage}"`
    );
  }

  const dbUrl = readEnv("GRAPHRAG_MEMORY_DB_URL");
  if (rawStorage === "pgvector" && dbUrl === undefined) {
    throw new ConfigError(
      "GRAPHRAG_MEMORY_DB_URL is required when GRAPHRAG_MEMORY_STORAGE=pgvector"
    );
  }

  // Embedding config: dimensions is ALWAYS required (every backend needs it);
  // baseUrl and model are only required when a key resolves. All string
  // fields are normalized through readTrimmed so empty / whitespace-only
  // values collapse to undefined — a blank key does not silently drag an
  // operator into the real-embedder path.
  const embedDimensions = parseEmbedDimensions(readEnv(EMBED_DIMENSIONS_VAR));
  const pgvectorAnnMaxDimensions = readPgvectorAnnMaxDimensions();
  if (embedDimensions > pgvectorAnnMaxDimensions) {
    throw new ConfigError(
      `${EMBED_DIMENSIONS_VAR} (${embedDimensions}) exceeds configured pgvector ANN limit (${pgvectorAnnMaxDimensions})`
    );
  }
  const ingestBatchLimit = readIngestBatchLimit();
  const pgvectorPool = readPgvectorPoolConfig();
  const embedApiKey = resolveEmbedApiKey();

  const embedBaseUrl = readTrimmed("GRAPHRAG_MEMORY_EMBED_BASE_URL");
  if (embedApiKey !== undefined && embedBaseUrl === undefined) {
    throw new ConfigError(
      "GRAPHRAG_MEMORY_EMBED_BASE_URL is required when an embedding API key is configured (GRAPHRAG_MEMORY_EMBED_API_KEY, GRAPHRAG_MEMORY_VECTOR_API_KEY, GRAPHRAG_MEMORY_ANTHROPIC_API_KEY, or the var named by GRAPHRAG_MEMORY_EMBED_API_KEY_ENV)"
    );
  }
  const embedModel = readTrimmed("GRAPHRAG_MEMORY_EMBED_MODEL");
  if (embedApiKey !== undefined && embedModel === undefined) {
    throw new ConfigError(
      "GRAPHRAG_MEMORY_EMBED_MODEL is required when an embedding API key is configured (GRAPHRAG_MEMORY_EMBED_API_KEY, GRAPHRAG_MEMORY_VECTOR_API_KEY, GRAPHRAG_MEMORY_ANTHROPIC_API_KEY, or the var named by GRAPHRAG_MEMORY_EMBED_API_KEY_ENV)"
    );
  }

  const retrieval = parseRetrievalConfig();
  const businessLedgerUrl = parseBusinessLedgerUrl();
  const neo4j = parseNeo4jConfig();
  const elasticsearch = parseElasticsearchConfig();
  const jev = parseJevConfig();
  const llm = resolveLlmPurposes(jev);
  const rerank = rerankConfigFromPurpose(llm.rerank);
  const rerankUrl = readTrimmed(RETRIEVAL_RERANK_URL_VAR);
  // Extract write-time supersede switch (T4). ADR-0009: defaults to ON —
  // resolving contradictions at write time is ledger infrastructure, and
  // the explicit off is the test/escape hatch (graphEnabled-shaped).
  const extractWriteTimeSupersede = parseBoolean(
    EXTRACT_WRITE_TIME_SUPERSEDE_VAR,
    readEnv(EXTRACT_WRITE_TIME_SUPERSEDE_VAR),
    true
  );
  // ADR-0006 / ADR-0007: after every block parses, refuse a default-on
  // graph/rerank/precision-layer boot whose dependency is missing. Runs
  // after (not inside) the parsers so the per-family parse errors keep
  // naming their own vars first.
  assertFailStart(retrieval, neo4j, rerankUrl, rerank, elasticsearch);

  return {
    logLevel,
    storage: rawStorage,
    dbUrl,
    businessLedgerUrl,
    embedDimensions,
    pgvectorAnnMaxDimensions,
    ingestBatchLimit,
    pgvectorPoolMax: pgvectorPool.max,
    pgvectorConnectionWaitTimeoutMs: pgvectorPool.connectionWaitTimeoutMs,
    embedBaseUrl: embedBaseUrl?.replace(/\/$/, ""),
    embedModel,
    // Looked up by NAME — the secret value only ever exists in the process
    // environment, never in this file or in any log line.
    embedApiKey,
    retrieval,
    neo4j,
    elasticsearch,
    rerank,
    rerankUrl,
    jev,
    extractWriteTimeSupersede,
    llm,
  };
}

/**
 * Resolve the embedding API key value.
 *
 * Order (first non-blank wins):
 *   1. GRAPHRAG_MEMORY_EMBED_API_KEY      — dedicated embed secret
 *   2. GRAPHRAG_MEMORY_VECTOR_API_KEY   — preferred vector alias
 *   3. GRAPHRAG_MEMORY_ANTHROPIC_API_KEY — legacy vector alias (not LLM)
 *   4. process.env[GRAPHRAG_MEMORY_EMBED_API_KEY_ENV] — indirect by name
 *   5. undefined → production embedding is unavailable
 *
 * `ANTHROPIC_AUTH_TOKEN` is the LLM key and is never consulted here.
 */
function resolveEmbedApiKey(): string | undefined {
  const direct = readTrimmed(EMBED_API_KEY_VALUE_VAR);
  if (direct !== undefined) return direct;
  const vector = readTrimmed(VECTOR_API_KEY_VAR);
  if (vector !== undefined) return vector;
  const legacyVector = readTrimmed(LEGACY_VECTOR_API_KEY_VAR);
  if (legacyVector !== undefined) return legacyVector;
  const keyEnvName = readTrimmed(EMBED_API_KEY_NAME_VAR);
  if (keyEnvName === undefined) return undefined;
  return readTrimmed(keyEnvName);
}
