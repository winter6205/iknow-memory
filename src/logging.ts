/**
 * Minimal structured logger for iknow-memory.
 *
 * Why: this package is decoupled from iknow and must not import its
 * runtime utilities. A leveled wrapper around `console.*` is the
 * smallest honest thing — no external logger dep, no async writes,
 * no JSON line protocol until we need one.
 *
 * Logs go to stderr to keep stdout reserved for the MCP stdio transport.
 * Diagnostics are redacted here so callers cannot accidentally log secrets.
 *
 * Process-log field whitelist (SC10, specs/graph-rerank-boot-and-evidence.md):
 * the extract/embed operational events carry only
 *   { time, chunkId, modelId, latencyMs, outcome, counts }
 * plus the already-shipped extraction reject fields (chunkId, ids, codes).
 * Chunk body text, evidence-span text, entity descriptions, prompts,
 * embeddings and API keys must never be passed as log fields.
 * `redactDiagnostic` below is URL/credential redaction for error diagnostics
 * — it is NOT an ingest-body secret scanner, so it cannot rescue a body
 * string that a caller passes as a field value.
 */
import type { LogLevel } from "./config.js";
import { redactPgDiagnostic } from "./core/storage/pg-diagnostics.js";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  level: LogLevel;
  debug: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
}

function emit(
  level: LogLevel,
  threshold: LogLevel,
  msg: string,
  fields?: Record<string, unknown>
): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = fields
    ? `${level.toUpperCase()} ${msg} ${JSON.stringify(fields)}`
    : `${level.toUpperCase()} ${msg}`;
  writeStderr(line + "\n");
}

const NEO4J_URL_PATTERN =
  /\b(?:bolt|neo4j)(?:\+(?:s|ssc))?:\/\/[^\s"'`<>]*(?:(?<=[/:@?&=%.])\r?\n[ \t]*[^\s"'`<>]+)*/gi;
const NEO4J_URL_SCHEME_PATTERN = /^(?:bolt|neo4j)(?:\+(?:s|ssc))?:$/i;

function redactNeo4jUrls(diagnostic: string): string {
  return diagnostic.replace(NEO4J_URL_PATTERN, (candidate) => {
    const trailing = candidate.match(/[.,;:!?)}\]]+$/)?.[0] ?? "";
    const connectionString = trailing
      ? candidate.slice(0, -trailing.length)
      : candidate;
    const normalized = connectionString.replace(/\r?\n[ \t]*/g, "");

    try {
      const url = new URL(normalized);
      if (!NEO4J_URL_SCHEME_PATTERN.test(url.protocol)) {
        return `${url.protocol}//[redacted]${trailing}`;
      }
      const port = url.port === "" ? "" : `:${url.port}`;
      return `${url.protocol}//${url.hostname || "[redacted]"}${port}${trailing}`;
    } catch {
      return `${normalized.slice(0, normalized.indexOf("://") + 3)}[redacted]${trailing}`;
    }
  });
}

/**
 * Redact diagnostics from every production output boundary.
 *
 * PostgreSQL redaction remains the single source of truth for PostgreSQL
 * URLs and key/value credentials. Neo4j accepts a different URI family, so
 * its authority and query are reduced to scheme + host + port here.
 */
export function redactDiagnostic(value: unknown): string {
  return redactNeo4jUrls(redactPgDiagnostic(value));
}

/** Write a diagnostic to stderr without exposing connection credentials. */
export function writeStderr(message: string): void {
  // stderr keeps stdout clean for the MCP stdio transport.
  process.stderr.write(redactDiagnostic(message));
}

export function createLogger(level: LogLevel): Logger {
  return {
    level,
    debug: (msg, fields) => emit("debug", level, msg, fields),
    info: (msg, fields) => emit("info", level, msg, fields),
    warn: (msg, fields) => emit("warn", level, msg, fields),
    error: (msg, fields) => emit("error", level, msg, fields),
  };
}
