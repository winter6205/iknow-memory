/**
 * Maintenance-lane HTTP handlers.
 *
 * The failed list, promote and discard are facades over the SAME core
 * runners the extract CLI uses — `listFailed()` from
 * `src/core/extraction/records.ts` and `promoteRecord` / `discardRecord`
 * from `src/core/extraction/actions.ts`. No write SQL lives here, and
 * re-extract needs no new route at all: the failed list carries the chunk
 * id, and the SPA sends it through the existing extract thin write, which
 * is judge-before-persist by construction.
 *
 * Error posture: the core refusals (`PromotionRefusedError` /
 * `DiscardRefusedError`, both `INVALID_INPUT`) ride the shared
 * `mapRunnerError` status map from `writes.ts` — the same envelope every
 * other write route answers with.
 */
import { z } from "zod";

import type { EmbeddingClient } from "../../core/embedder.js";
import type { SlotEmbeddingSource } from "../../core/embed-slots.js";
import {
  discardRecord,
  promoteRecord,
} from "../../core/extraction/actions.js";
import type { ExtractPersistDeps } from "../../core/extraction/persist.js";
import {
  listChunkSourceLinks,
  listFailed,
} from "../../core/extraction/records.js";
import type { ExtractClient, ExtractPool } from "../../tools/extract.js";
import type { Logger } from "../../logging.js";

import type { RouteHandler } from "../router.js";
import { mapRunnerError, parseBodyOrFail } from "./writes.js";

/** Deps the server wires for the maintenance lane. */
export interface MaintenanceDeps {
  /** Postgres pool shared with the other write runners. */
  pool: ExtractPool;
  /** Promote replays the held proposal through `persistOutputs`, which
   *  embeds every resolved entity — same requirement the CLI's promote
   *  has on its embedder. */
  embedder: EmbeddingClient;
  slotEmbedding?: SlotEmbeddingSource;
  logger?: Logger;
}

/** Shared body schema of the two record-targeted actions. */
export const MaintenanceRecordActionSchema = z.strictObject({
  record_id: z.string().uuid(),
});

/** No-op logger for dep constructions that did not thread one in. */
const NOOP_LOGGER: Logger = {
  level: "error",
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function persistDeps(deps: MaintenanceDeps): ExtractPersistDeps {
  return {
    embedder: deps.embedder,
    logger: deps.logger ?? NOOP_LOGGER,
    ...(deps.slotEmbedding !== undefined
      ? { slotEmbedding: deps.slotEmbedding }
      : {}),
  };
}

/** One row of the failed list — review fields, never the held payload.
 *  Timestamps ride through as pg returns them (Date) or as tests seed them
 *  (ISO string); JSON serializes both to the same ISO form. */
interface FailedRecordView {
  id: string;
  batch_id: string;
  chunk_id: string | null;
  error_code: string | null;
  error_msg: string | null;
  has_proposal: boolean;
  created_at: string | Date | null;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  source_ref: string | null;
  source_doc_id: string | null;
}

/** Chunk → 资料 back-pointer pair as the ledger stores it. */
interface ChunkSourceLinks {
  source_ref: string | null;
  source_doc_id: string | null;
}

/**
 * Map the batched core read (`listChunkSourceLinks` — one parameterised
 * IN-list, no per-row round-trips; `StorageReadPort` has no batched
 * chunk-read) onto the failed rows' chunk ids. A chunk absent from the map
 * is a true not-found and links nowhere.
 */
function linkIndex(rows: Awaited<ReturnType<typeof listChunkSourceLinks>>): Map<
  string,
  ChunkSourceLinks
> {
  const links = new Map<string, ChunkSourceLinks>();
  for (const row of rows) {
    links.set(row.chunk_id, {
      source_ref: row.source_ref,
      source_doc_id: row.source_doc_id,
    });
  }
  return links;
}

export function failedListHandler(deps: MaintenanceDeps): RouteHandler {
  return async () => {
    let client: ExtractClient | undefined;
    try {
      client = await deps.pool.connect();
      const rows = await listFailed(client);
      const chunkIds = rows
        .map((r) => r.chunk_id)
        .filter((v): v is string => typeof v === "string");
      let links = new Map<string, ChunkSourceLinks>();
      try {
        links = linkIndex(await listChunkSourceLinks(client, chunkIds));
      } catch (err) {
        // A read outage must not masquerade as "the chunks were deleted":
        // the rows still list unlinked, but the real cause is logged.
        (deps.logger ?? NOOP_LOGGER).debug("maintenance-links-read-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const items: FailedRecordView[] = rows.map((row) => ({
        id: row.id as string,
        batch_id: row.batch_id as string,
        chunk_id: (row.chunk_id as string | null) ?? null,
        error_code: (row.error_code as string | null) ?? null,
        error_msg: (row.error_msg as string | null) ?? null,
        has_proposal:
          row.proposed_payload !== null &&
          row.proposed_payload !== undefined,
        created_at: (row.created_at as string | Date | null) ?? null,
        started_at: (row.started_at as string | Date | null) ?? null,
        finished_at: (row.finished_at as string | Date | null) ?? null,
        // Absent from the map = the chunk row is gone (a true not-found);
        // the failed row still lists, so the row set stays `listFailed()`'s.
        ...(links.get(row.chunk_id as string) ?? {
          source_ref: null,
          source_doc_id: null,
        }),
      }));
      return { status: 200, body: { items } };
    } catch (err) {
      return mapRunnerError(err);
    } finally {
      client?.release();
    }
  };
}

function recordActionHandler(
  deps: MaintenanceDeps,
  run: (client: ExtractClient, recordId: string) => Promise<void>,
  done: (recordId: string) => unknown
): RouteHandler {
  return async (req) => {
    const bodyResult = parseBodyOrFail(req.body);
    if (!bodyResult.ok) return bodyResult.response;
    const parsed = MaintenanceRecordActionSchema.safeParse(bodyResult.value);
    if (!parsed.success) {
      return mapRunnerError(parsed.error);
    }
    let client: ExtractClient | undefined;
    try {
      client = await deps.pool.connect();
      await run(client, parsed.data.record_id);
      return { status: 200, body: done(parsed.data.record_id) };
    } catch (err) {
      return mapRunnerError(err);
    } finally {
      client?.release();
    }
  };
}

export function promoteWriteHandler(deps: MaintenanceDeps): RouteHandler {
  const persist = persistDeps(deps);
  return recordActionHandler(
    deps,
    (client, recordId) => promoteRecord(persist, client, recordId),
    (recordId) => ({ promoted: true, record_id: recordId })
  );
}

export function discardWriteHandler(deps: MaintenanceDeps): RouteHandler {
  return recordActionHandler(
    deps,
    (client, recordId) => discardRecord(client, recordId),
    (recordId) => ({ discarded: true, record_id: recordId })
  );
}
