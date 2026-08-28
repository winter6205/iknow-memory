/**
 * Runtime config for iknow-memory MCP server.
 *
 * Loads from process.env with `.env.local` (cwd) as fallback.
 * Precedence: process.env > `.env.local`.
 *
 * LLM authentication uses ANTHROPIC_AUTH_TOKEN. Vector/embedding
 * authentication uses the dedicated embedding key or vector aliases below;
 * those credentials are never interchangeable and are never logged.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RetrieveConfig } from "./core/retrieval/types.js";

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
 * The choice is declared entirely in the MCP registration layer (the
 * `.mcp.json` / `~/.claude.json` env block), via two knobs, resolved in
 * order (first non-blank wins):
 *   1. GRAPHRAG_MEMORY_EMBED_API_KEY     — the secret VALUE itself. Only
 *      ever set in a host-local, untracked registration (e.g. Claude Code's
 *      `~/.claude.json` local scope). NEVER in a git-tracked `.mcp.json`.
 *   2. GRAPHRAG_MEMORY_VECTOR_API_KEY — the preferred vector/embedding alias.
 *   3. GRAPHRAG_MEMORY_ANTHROPIC_API_KEY — the legacy vector/embedding alias
 *      (not the LLM token).
 *   4. GRAPHRAG_MEMORY_EMBED_API_KEY_ENV — the NAME of an env var holding
 *      the secret (e.g. "NINE_ROUTER_KEY" for the iknow 9router convention,
 *      or any other var a generic host uses). config.ts just reads whatever
 *      name it is handed.
 *
 * Neither set → undefined → FakeEmbedder path. There is deliberately NO
 * default var name here — a default would re-hardcode a provider choice
 * into config, which is exactly what this indirection removes. The secret
 * VALUE never lives in source; the var NAME is supplied by the operator.
 */
const EMBED_API_KEY_VALUE_VAR = "GRAPHRAG_MEMORY_EMBED_API_KEY";
const EMBED_API_KEY_NAME_VAR = "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV";
/** Preferred vector/embedding secret — not the LLM token. */
const VECTOR_API_KEY_VAR = "GRAPHRAG_MEMORY_VECTOR_API_KEY";
/** Legacy vector alias — not the LLM token (`ANTHROPIC_AUTH_TOKEN`). */
const LEGACY_VECTOR_API_KEY_VAR = "GRAPHRAG_MEMORY_ANTHROPIC_API_KEY";

/** Env-var name for the required embedding dimension integer. */
const EMBED_DIMENSIONS_VAR = "GRAPHRAG_MEMORY_EMBED_DIMENSIONS";

/**
 * Startup configuration failure. Distinct from GraphragError (core/errors.ts),
 * which covers per-request tool failures: a ConfigError is unrecoverable and
 * aborts the process with EXIT_CODES.BAD_CONFIG before any transport opens.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Neo4j sidecar connection settings (#70).
 *
 * Present only when a URI is configured. Absence is the operator saying
 * "no sidecar here": the graph arm is skipped rather than attempted, so
 * retrieve stays non-degraded (spec SC7 — cannot attempt ≠ failed
 * attempt). Credentials are optional because a local Neo4j may run with
 * auth disabled, but a half-declared pair is rejected at startup.
 */
export interface Neo4jConfig {
  /** Driver URI; scheme restricted to the bolt / neo4j family. */
  uri: string;
  /** Basic-auth user; undefined together with `password` = anonymous. */
  user: string | undefined;
  /** Basic-auth password. Never logged, never echoed into an error. */
  password: string | undefined;
}

export interface GraphragEnv {
  logLevel: LogLevel;
  /** Which StorageBackend to construct. */
  storage: StorageMode;
  /** Postgres connection string; required iff storage === "pgvector". */
  dbUrl: string | undefined;
  /**
   * Embedding endpoint base URL (trailing slash stripped). Convention
   * includes /v1 — only /embeddings is appended at call time. Undefined
   * when no embedding API key is configured (FakeEmbedder path).
   */
  embedBaseUrl: string | undefined;
  /**
   * Embedding model id (provider-specific, e.g. "embedding-3").
   * Undefined when no embedding API key is configured.
   */
  embedModel: string | undefined;
  /** Vector dimension. Always set — every code path (real + fake) needs it. */
  embedDimensions: number;
  /**
   * Resolved embedding API key value; undefined means "fall back to
   * FakeEmbedder". See the EMBED_API_KEY_* constants for resolution order.
   */
  embedApiKey: string | undefined;
  /**
   * Retrieval pipeline knobs (spec-3 p0-integration T5). Loaded from the
   * GRAPHRAG_MEMORY_RETRIEVAL_* family; validated at startup. This is the
   * config source of truth for the RRF fusion + graph-arm floor behavior.
   */
  retrieval: RetrieveConfig;
  /**
   * Neo4j sidecar connection block, or undefined when no URI is
   * configured. Undefined means "skip the graph arm", not "the graph arm
   * failed" — see Neo4jConfig.
   */
  neo4j: Neo4jConfig | undefined;
  /**
   * LLM credentials for temporary retrieve rerank, or undefined when
   * `ANTHROPIC_AUTH_TOKEN` is absent. Model / base URL default to China
   * MiniMax-M3 when those env vars are unset.
   */
  rerank: RerankConfig | undefined;
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

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (v.startsWith("<") && v.endsWith(">")) continue; // unfilled placeholder
    out[k] = v;
  }
  return out;
}

function readEnv(key: string): string | undefined {
  // A key *present* on process.env (even blank) is an explicit process
  // value: it must not fall through to `.env.local`. Host-smoke and
  // Cursor MCP pin secrets to "" so a developer file cannot select
  // 9router / Neo4j / pgvector. Absent keys still read the file.
  if (Object.prototype.hasOwnProperty.call(process.env, key)) {
    const fromProcess = process.env[key];
    if (fromProcess === undefined) return undefined;
    const trimmed = fromProcess.trim();
    return trimmed === "" ? undefined : fromProcess;
  }
  const file = parseEnvFile(join(process.cwd(), ".env.local"));
  return file[key];
}

/**
 * Read an env var and normalize: trim whitespace, treat empty/whitespace-only
 * as absent (undefined). Keeps config.ts and index.ts in agreement — both
 * treat a blank key as "no key" (FakeEmbedder path) without relying on JS
 * truthiness semantics at the consumption site.
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
 * Always required — every code path (real + FakeEmbedder, MemoryBackend,
 * PgvectorBackend DDL) needs the dimension as a positive integer. We
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

// --- Retrieval config (spec-3 p0-integration T5) ---

const RETRIEVAL_W_VEC_VAR = "GRAPHRAG_MEMORY_RETRIEVAL_W_VEC";
const RETRIEVAL_W_BM25_VAR = "GRAPHRAG_MEMORY_RETRIEVAL_W_BM25";
const RETRIEVAL_W_GRAPH_VAR = "GRAPHRAG_MEMORY_RETRIEVAL_W_GRAPH";
const RETRIEVAL_BM25_ENABLED_VAR = "GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED";
const RETRIEVAL_GRAPH_ENABLED_VAR = "GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED";
const RETRIEVAL_RERANK_ENABLED_VAR = "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED";
const LLM_AUTH_TOKEN_VAR = "ANTHROPIC_AUTH_TOKEN";
const ANTHROPIC_MODEL_VAR = "GRAPHRAG_MEMORY_ANTHROPIC_MODEL";
const ANTHROPIC_BASE_URL_VAR = "GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL";
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
  const value = raw !== undefined && raw.trim() !== "" ? raw : String(fallback);
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(
      `${name} must be a finite positive number, got "${raw}"`
    );
  }
  return n;
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
 * Defaults: w_vec=0.7, w_bm25=0.15, w_graph=0.15, both partner arms enabled
 * — the three-arm production hybrid locked by #69/#70. `w_graph` steers
 * production again: it now weights the Neo4j graph arm, not the archived
 * SQL one-hop arm (#58), which still only runs for a caller that injects a
 * `graphConfig` itself. entityLinkTopK, candidateCap and graphArmFloor keep
 * their P0 defaults.
 *
 * Enforces the spec §Boundaries: finite positive weights; entityLinkTopK > 0;
 * candidateCap >= entityLinkTopK; graphArmFloor > 0.
 */
function parseRetrievalConfig(): RetrieveConfig {
  const entityLinkTopK = parsePositiveInt(
    RETRIEVAL_ENTITY_LINK_TOP_K_VAR,
    readEnv(RETRIEVAL_ENTITY_LINK_TOP_K_VAR),
    { min: 1, fallback: 8 }
  );
  const candidateCap = parsePositiveInt(
    RETRIEVAL_CANDIDATE_CAP_VAR,
    readEnv(RETRIEVAL_CANDIDATE_CAP_VAR),
    { min: 1, fallback: 50 }
  );
  if (candidateCap < entityLinkTopK) {
    throw new ConfigError(
      `${RETRIEVAL_CANDIDATE_CAP_VAR} (${candidateCap}) must be >= ${RETRIEVAL_ENTITY_LINK_TOP_K_VAR} (${entityLinkTopK})`
    );
  }
  return {
    w_vec: parseFinitePositive(
      RETRIEVAL_W_VEC_VAR,
      readEnv(RETRIEVAL_W_VEC_VAR),
      0.7
    ),
    w_bm25: parseFinitePositive(
      RETRIEVAL_W_BM25_VAR,
      readEnv(RETRIEVAL_W_BM25_VAR),
      0.15
    ),
    w_graph: parseFinitePositive(
      RETRIEVAL_W_GRAPH_VAR,
      readEnv(RETRIEVAL_W_GRAPH_VAR),
      0.15
    ),
    bm25Enabled: parseBoolean(
      RETRIEVAL_BM25_ENABLED_VAR,
      readEnv(RETRIEVAL_BM25_ENABLED_VAR),
      true
    ),
    graphEnabled: parseBoolean(
      RETRIEVAL_GRAPH_ENABLED_VAR,
      readEnv(RETRIEVAL_GRAPH_ENABLED_VAR),
      true
    ),
    rerankEnabled: parseBoolean(
      RETRIEVAL_RERANK_ENABLED_VAR,
      readEnv(RETRIEVAL_RERANK_ENABLED_VAR),
      false
    ),
    entityLinkTopK,
    candidateCap,
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
 * No URI → undefined, and the graph arm is skipped without degrading the
 * envelope (spec SC7). Anything the operator DID declare must be usable:
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
 * Load retrieve-rerank credentials.
 *
 * Key is `ANTHROPIC_AUTH_TOKEN`. Model / base URL default to China MiniMax
 * M3 (`MiniMax-M3` at `https://api.minimaxi.com/anthropic`) when unset.
 * No key → undefined (skip). Explicit MODEL / BASE_URL still override.
 */
function parseRerankConfig(): RerankConfig | undefined {
  const apiKey = readTrimmed(LLM_AUTH_TOKEN_VAR);
  if (apiKey === undefined) return undefined;
  const model = readTrimmed(ANTHROPIC_MODEL_VAR) ?? DEFAULT_LLM_MODEL;
  const baseUrl = (
    readTrimmed(ANTHROPIC_BASE_URL_VAR) ?? DEFAULT_LLM_BASE_URL
  ).replace(/\/$/, "");
  return { apiKey, model, baseUrl };
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
 * missing embedding config: the operator's mental model and the running
 * server must agree or the server must refuse to start.
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
  // baseUrl and model are only required when a key resolves, because the
  // FakeEmbedder path takes the operator offline without one. All string
  // fields are normalized through readTrimmed so empty / whitespace-only
  // values collapse to undefined — a blank key does not silently drag an
  // operator into the real-embedder path.
  const embedDimensions = parseEmbedDimensions(readEnv(EMBED_DIMENSIONS_VAR));
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
  const neo4j = parseNeo4jConfig();
  const rerank = parseRerankConfig();

  return {
    logLevel,
    storage: rawStorage,
    dbUrl,
    embedDimensions,
    embedBaseUrl: embedBaseUrl?.replace(/\/$/, ""),
    embedModel,
    // Looked up by NAME — the secret value only ever exists in the process
    // environment, never in this file or in any log line.
    embedApiKey,
    retrieval,
    neo4j,
    rerank,
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
 *   5. undefined → FakeEmbedder path
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
