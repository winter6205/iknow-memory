/**
 * Thin write HTTP handlers (operator-console T8).
 *
 * Each handler MUST call the SAME underlying runner the MCP tool or CLI
 * invokes for the matching named action. The dashboard is an HTTP facade,
 * not a host: the spec promises a single code path per action so the
 * dashboard never re-implements write logic and a host cannot end up
 * talking to a different one than the operator chrome does.
 *
 *  ingest         — `createIngestHandler` from src/tools/ingest.ts
 *                   (MCP `ingest` tool's handler factory).
 *  extract        — `createExtractHandler` from src/tools/extract.ts
 *                   (MCP `extract` tool's handler factory).
 *  invalidate     — `createInvalidationHandler` from src/tools/invalidation.ts
 *                   (MCP `invalidate` tool's handler factory).
 *  graph:backfill — `runCli` from src/cli/graph-backfill.ts
 *                   (the operator-console CLI entry).
 *  graph:drain    — `runCli` from src/cli/graph-drain.ts
 *                   (the operator-console CLI entry).
 *
 * Pinning "same runner" in tests: spy on the imported factory / runner
 * module (see tests/dashboard/writes.test.ts). If the spy is invoked,
 * the handler dispatched through the shared MCP/CLI path; if a
 * re-implementation appeared under a different symbol the spy would
 * never fire.
 */
import { ConfigError } from "../../config.js";
import { GraphragError } from "../../core/errors.js";
import type { EmbeddingClient } from "../../core/embedder.js";
import type { StorageBackend } from "../../core/types.js";
import type {
  EmbedderClientEnv,
  LlmClientEnv,
} from "../../core/extraction/clients.js";
import type { ExtractClient, ExtractPool } from "../../tools/extract.js";
import type { PrecisionIndexer } from "../../core/storage/elasticsearch-precision.js";
import type { Logger } from "../../logging.js";

import { errorEnvelope } from "../responses.js";
import type { RouteHandler } from "../router.js";

import {
  createIngestHandler,
  IngestInputSchema,
  type IngestDeps,
} from "../../tools/ingest.js";
import {
  createExtractHandler,
  ExtractInputSchema,
  type ExtractDeps,
} from "../../tools/extract.js";
import {
  createInvalidationHandler,
  InvalidationInputSchema,
  type InvalidationDeps,
} from "../../tools/invalidation.js";

import { runCli as runGraphBackfillCli } from "../../cli/graph-backfill.js";
import type { BackfillDeps } from "../../cli/graph-backfill.js";
import { runCli as runGraphDrainCli } from "../../cli/graph-drain.js";
import type { DrainDeps } from "../../cli/graph-drain.js";

/** Result returned by MCP tool handlers — the SDK-shaped payload. */
interface ToolResultContent {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Parse the request body slot the server attaches. Empty body is a typed
 * 400 — every thin write is POST and must carry a JSON payload (the
 * schema's strict object guarantees it; a missing body is always a bug
 * or a curl typo, never a normal path).
 */
function parseBodyOrFail(
  raw: unknown
):
  | { ok: true; value: unknown }
  | { ok: false; response: { status: number; body: unknown } } {
  if (raw === undefined || raw === null) {
    return {
      ok: false,
      response: {
        status: 400,
        body: errorEnvelope(
          "INVALID_INPUT",
          new Error("request body is required")
        ),
      },
    };
  }
  if (typeof raw !== "object") {
    return {
      ok: false,
      response: {
        status: 400,
        body: errorEnvelope(
          "INVALID_INPUT",
          new Error("request body must be a JSON object")
        ),
      },
    };
  }
  return { ok: true, value: raw };
}

/**
 * Map a thrown runner error to the dashboard-api response envelope.
 *
 * Order matters:
 *  1. `ZodError` from `safeParse` — 400 INVALID_INPUT with the joined issues.
 *  2. `GraphragError` — `INVALID_INPUT` → 400, anything else → 503
 *     STORAGE_ERROR. CONTENT_TOO_LARGE is a caller mistake but travels
 *     through the same code path; 503 keeps the "system refused" /
 *     "system unavailable" naming consistent with the existing dashboard
 *     envelope rather than inventing a new status.
 *  3. `ConfigError` (extract is the only runner that raises one today) →
 *     503 — the operator's env is missing the credentials the runner
 *     needs. Keeps the existing envelope shape.
 *  4. Anything else → 500 INTERNAL.
 */
function mapRunnerError(err: unknown): { status: number; body: unknown } {
  if (
    err !== null &&
    typeof err === "object" &&
    "issues" in err &&
    Array.isArray((err as { issues?: unknown }).issues)
  ) {
    const message = (err as { issues: Array<{ message?: string }> }).issues
      .map((i) => i.message ?? "")
      .filter(Boolean)
      .join("; ");
    return {
      status: 400,
      body: errorEnvelope(
        "INVALID_INPUT",
        new Error(message || "invalid input")
      ),
    };
  }
  if (err instanceof GraphragError) {
    if (err.code === "INVALID_INPUT") {
      return {
        status: 400,
        body: errorEnvelope("INVALID_INPUT", err),
      };
    }
    return {
      status: 503,
      body: errorEnvelope("STORAGE_ERROR", err),
    };
  }
  if (err instanceof ConfigError) {
    return {
      status: 503,
      body: errorEnvelope("STORAGE_ERROR", err),
    };
  }
  return {
    status: 500,
    body: errorEnvelope("INTERNAL", err),
  };
}

/**
 * Extract the first text content block from a ToolResultContent and parse
 * its JSON payload. The MCP runners always emit a single text block whose
 * string is the JSON envelope; the dashboard side surfaces that verbatim
 * so an HTTP caller sees the same body an MCP host would.
 */
function toolResultToBody(result: ToolResultContent): {
  status: number;
  body: unknown;
} {
  const text = result.content[0]?.text ?? "";
  try {
    return { status: 200, body: JSON.parse(text) };
  } catch {
    return { status: 200, body: text };
  }
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * Deps for the ingest thin write. Mirrors `IngestDeps` from
 * `src/tools/ingest.ts`; each field is forwarded as-is to
 * `createIngestHandler(deps)` — same factory, same closed-over deps as
 * the MCP `ingest` tool.
 */
export interface IngestWriteDeps {
  embedder: EmbeddingClient;
  storage: StorageBackend;
  precision?: PrecisionIndexer;
  logger?: Logger;
}

/**
 * Build the POST /api/writes/ingest handler.
 *
 * The handler constructs the ingest runner via `createIngestHandler` from
 * `src/tools/ingest.ts` — the SAME factory the MCP `ingest` tool uses.
 * Tests pin this by spying on the imported `createIngestHandler` and
 * asserting it was called once with the request's deps.
 */
export function ingestWriteHandler(deps: IngestWriteDeps): RouteHandler {
  const runner = createIngestHandler(deps as IngestDeps);
  return async (req) => {
    const bodyResult = parseBodyOrFail(req.body);
    if (!bodyResult.ok) return bodyResult.response;
    const parsed = IngestInputSchema.safeParse(bodyResult.value);
    if (!parsed.success) {
      return mapRunnerError(parsed.error);
    }
    try {
      const result = (await runner(parsed.data)) as ToolResultContent;
      return toolResultToBody(result);
    } catch (err) {
      return mapRunnerError(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

/**
 * Deps for the extract thin write. Mirrors `ExtractDeps` from
 * `src/tools/extract.ts`. The dashboard wires `extract` only when the
 * operator's env provides the LLM / embedding credentials + a Postgres
 * pool; the memory-mode default is 503 on the extract endpoint (the MCP
 * extract tool does the same — it answers with `ExtractNotConfiguredError`
 * when `pool === undefined`).
 *
 * Note: the underlying `ExtractDeps` factory type still carries optional
 * `llm` / `embedder` test-seam overrides (used by the MCP wiring and
 * tests). The dashboard does not pass them — the production wiring has
 * no way to honor a pre-built client override here — so they are not
 * exposed on this public dashboard deps surface. The factory accepts
 * them via the structural cast in `extractWriteHandler` below.
 */
export interface ExtractWriteDeps {
  llmEnv: LlmClientEnv;
  embedderEnv: EmbedderClientEnv;
  pool?: ExtractPool;
  precision?: PrecisionIndexer;
  logger?: Logger;
  batchLimit?: number;
  now?: () => string;
}

export function extractWriteHandler(deps: ExtractWriteDeps): RouteHandler {
  const runner = createExtractHandler(deps as ExtractDeps);
  return async (req) => {
    const bodyResult = parseBodyOrFail(req.body);
    if (!bodyResult.ok) return bodyResult.response;
    const parsed = ExtractInputSchema.safeParse(bodyResult.value);
    if (!parsed.success) {
      return mapRunnerError(parsed.error);
    }
    try {
      const result = (await runner(parsed.data)) as ToolResultContent;
      return toolResultToBody(result);
    } catch (err) {
      return mapRunnerError(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Invalidate
// ---------------------------------------------------------------------------

export interface InvalidateWriteDeps {
  embedder: EmbeddingClient;
  storage: StorageBackend;
  precision?: PrecisionIndexer;
}

export function invalidateWriteHandler(
  deps: InvalidateWriteDeps
): RouteHandler {
  const runner = createInvalidationHandler(deps as InvalidationDeps);
  return async (req) => {
    const bodyResult = parseBodyOrFail(req.body);
    if (!bodyResult.ok) return bodyResult.response;
    const parsed = InvalidationInputSchema.safeParse(bodyResult.value);
    if (!parsed.success) {
      return mapRunnerError(parsed.error);
    }
    try {
      const result = (await runner(parsed.data)) as ToolResultContent;
      return toolResultToBody(result);
    } catch (err) {
      return mapRunnerError(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Graph backfill / drain (CLI runners)
// ---------------------------------------------------------------------------

/**
 * Deps for the graph:backfill thin write. Same deps the CLI passes into
 * `runCli` from `src/cli/graph-backfill.ts`. The handler calls
 * `runCli([], deps)` — same runner as `npm run graph:backfill`. The
 * handler returns the exit code in the response envelope so the operator
 * can see whether the run was a success, a loud skip (Neo4j unreachable),
 * or a usage error.
 */
export interface GraphBackfillWriteDeps {
  pool: BackfillDeps["pool"];
  logger: Logger;
  connectGraph: BackfillDeps["connectGraph"];
}

export function graphBackfillWriteHandler(
  deps: GraphBackfillWriteDeps
): RouteHandler {
  return async () => {
    try {
      const exitCode = await runGraphBackfillCli([], deps);
      return { status: 200, body: { exit_code: exitCode } };
    } catch (err) {
      return mapRunnerError(err);
    }
  };
}

export interface GraphDrainWriteDeps {
  pool: DrainDeps["pool"];
  logger: Logger;
  connectGraph: DrainDeps["connectGraph"];
}

export function graphDrainWriteHandler(
  deps: GraphDrainWriteDeps
): RouteHandler {
  return async () => {
    try {
      const exitCode = await runGraphDrainCli([], deps);
      return { status: 200, body: { exit_code: exitCode } };
    } catch (err) {
      return mapRunnerError(err);
    }
  };
}

// Re-export ExtractClient so server.ts can name the dependency type in its
// public surface without importing the deep MCP module path itself.
export type { ExtractClient };
// Re-export ExtractPool — main.ts needs to share a single `pg.Pool`
// across the three runners, and the nominal interfaces live in
// separate modules.
export type { ExtractPool } from "../../tools/extract.js";
// Re-export the CLI pool type aliases — same reason. main.ts wires
// real `pg.Pool` instances; the three runners declare three nominal
// pool interfaces in three modules; one re-export point keeps main.ts
// honest.
export type { BackfillPool } from "../../cli/graph-backfill.js";
export type { DrainPool } from "../../cli/graph-drain.js";
