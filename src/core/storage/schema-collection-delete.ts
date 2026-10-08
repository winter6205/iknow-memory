/**
 * Collection-delete schema bootstrap: `structured_collection_deletions`, the
 * per-phase progress ledger MP15's resumable deletion records as it commits
 * (plan `structured-corpus-mp15-delete-p3-i4.md`, "Added" list).
 *
 * Sibling of schema-collection-mark.ts rather than more tables inside
 * schema-bootstrap.ts, for the same reason the mark table is: the delete is
 * the retention contract's own vocabulary, and the table exists so a crashed
 * attempt can be rejoined — a crash mid-phases must not re-run a committed
 * phase's DELETE (each row set deleted exactly once) and must not report
 * success before the terminal stamp.
 *
 * The key is `(source_version_id, purge_revision)`: resume is per payload per
 * tombstone revision, never per content hash (plan §Shared-object key). The
 * table is deliberately NOT keyed by payload class/ref — by the time a delete
 * runs, the mark is about to be withdrawn and the version row is the identity
 * that survives as spec :314's minimal non-content record.
 *
 * `committed_phases` carries the phases whose DELETEs this attempt observed
 * committed, in `COLLECTION_DELETE_PHASES` order. `collected_at` doubles as
 * the monotonic guard: an attempt re-runs only while it is NULL, mirroring the
 * version row's own `payload_collected_at` stamp, which is the column a rescan
 * actually reads.
 *
 * Every CHECK list is rendered from the exported vocabulary rather than
 * retyped, so the schema and the TypeScript unions cannot disagree.
 */
import { COLLECTION_DELETE_PHASES } from "../maintenance/collection-delete.js";
import type { SchemaClient } from "./schema-projection.js";

const sqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(",");

export async function upSchemaCollectionDelete(
  client: SchemaClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS structured_collection_deletions (
      source_version_id     uuid NOT NULL,
      purge_revision        text NOT NULL CHECK (length(purge_revision) > 0),
      committed_phases      text ARRAY NOT NULL
                             CHECK (committed_phases <@ ARRAY[${sqlList(COLLECTION_DELETE_PHASES)}]::text[]),
      collected_at          timestamptz,
      PRIMARY KEY (source_version_id, purge_revision)
    )`);
}
