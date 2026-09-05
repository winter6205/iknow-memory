/**
 * Shared batch-cap resolution for the ingest and extract tools.
 *
 * Both tools cap caller-supplied batches at the same env-configured limit
 * (`readIngestBatchLimit` — the GRAPHRAG_MEMORY_INGEST_BATCH_LIMIT name is
 * frozen; extract reuses it as the shared cap). One copy of the resolution
 * contract lives here: an explicit `batchLimit` dep (test/wiring override)
 * wins and is validated, absence reads the env default. `toolName` keeps
 * each tool's ConfigError message verbatim.
 */
import { ConfigError, readIngestBatchLimit } from "../config.js";

/** The batch-cap slice of a tool's deps (`IngestDeps` / `ExtractDeps`). */
interface BatchLimitDeps {
  batchLimit?: number;
}

/**
 * Resolve a tool's batch cap. `Object.hasOwn` distinguishes an explicitly
 * injected `undefined` (broken wiring → ConfigError) from an absent key (no
 * override → env default), exactly as both tools always did.
 */
export function resolveToolBatchLimit(
  deps: BatchLimitDeps,
  toolName: string
): number {
  if (Object.hasOwn(deps, "batchLimit")) {
    const value = deps.batchLimit;
    if (
      value === undefined ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value <= 0
    ) {
      throw new ConfigError(
        `${toolName} batch limit must be a finite positive integer, got "${String(value)}"`
      );
    }
    return value;
  }
  return readIngestBatchLimit();
}
