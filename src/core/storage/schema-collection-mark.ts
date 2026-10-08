/**
 * Collection-mark schema bootstrap: `structured_collection_marks`, the row MP14
 * records a candidate's mark and cancellation in (fin
 * specs/structured-corpus-maintenance.md §Physical collection, lines 302-304, 307).
 *
 * Sibling of schema-maintenance-work.ts rather than more tables inside
 * schema-bootstrap.ts: the mark is the retention contract's own vocabulary, and
 * keeping its DDL beside that contract keeps the opt-in slice separable from the
 * durable-work ledger, which never reads a mark.
 *
 * The table is keyed by `(payload_class, payload_ref)` and NOT by source version
 * because four of the six payload classes are source-bound and two are not: a
 * source-version key could not hold a job's detailed logs or a snapshot payload at
 * all. `source_version_id` is therefore a nullable column — null for exactly those
 * two classes — rather than part of the identity.
 *
 * `expected_lifecycle_revision` is `bigint`, and the store reads it back as text:
 * a JS `bigint` throws in `JSON.stringify`, so the decimal must never cross the
 * boundary as one. It records the revision as it stands at the mark's OWN commit,
 * because marking stops new obligations and so advances `maintenance_revision`
 * itself — a mark that recorded what it observed would be born stale and cancel
 * itself on its own first recheck.
 *
 * Every CHECK list is rendered from the exported vocabulary rather than retyped,
 * so the schema and the TypeScript unions cannot disagree.
 */
import {
  COLLECTION_MARK_CANCEL_REASONS,
  COLLECTION_MARK_STATES,
} from "../maintenance/collection-mark-types.js";
import { COLLECTION_PAYLOAD_CLASSES } from "../maintenance/collector-types.js";
import type { SchemaClient } from "./schema-projection.js";

const sqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(",");

export async function upSchemaCollectionMark(
  client: SchemaClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS structured_collection_marks (
      payload_class              text NOT NULL
                                  CHECK (payload_class IN (${sqlList(COLLECTION_PAYLOAD_CLASSES)})),
      payload_ref                text NOT NULL CHECK (length(payload_ref) > 0),
      scope_binding              text NOT NULL CHECK (length(scope_binding) > 0),
      source_version_id          uuid,
      expected_lifecycle_revision bigint NOT NULL
                                  CHECK (expected_lifecycle_revision >= 0),
      deadline_at                timestamptz NOT NULL,
      marked_at                  timestamptz NOT NULL,
      state                      text NOT NULL
                                  CHECK (state IN (${sqlList(COLLECTION_MARK_STATES)})),
      cancelled_at               timestamptz,
      cancelled_reason           text
                                  CHECK (cancelled_reason IS NULL OR
                                         cancelled_reason IN (${sqlList(COLLECTION_MARK_CANCEL_REASONS)})),
      PRIMARY KEY (payload_class, payload_ref)
    )`);
  // The cancellation pair arrives by ALTER rather than only from the CREATE, and
  // that is the whole point: CREATE TABLE IF NOT EXISTS is a silent no-op against a
  // table a deployed store already has, so a mark table created before MP14 could
  // reactivate would keep a row shape with nowhere to record WHY it was cancelled.
  // Both columns are nullable, so the ALTER also succeeds against a table that
  // already holds marks.
  await client.query(`ALTER TABLE structured_collection_marks
    ADD COLUMN IF NOT EXISTS cancelled_at timestamptz`);
  await client.query(`ALTER TABLE structured_collection_marks
    ADD COLUMN IF NOT EXISTS cancelled_reason text`);
}
