/**
 * Explicit-purge schema: the active-read lease table and the purge tombstone
 * (fin `specs/structured-corpus-maintenance.md` §Physical collection steps 3–4).
 *
 * Sibling of `schema-maintenance-work.ts` for the same reason that module is a
 * sibling rather than more tables inside `schema-bootstrap.ts`: these two tables
 * belong to the explicit-purge capability, and `upSchemaBootstrap` still calls
 * this so one bootstrap covers the whole package.
 *
 * **`structured_read_leases` is a concurrency primitive, so it has no
 * `-memory.ts` twin.** Every property the lease exists for is a property of the
 * DATABASE — a row written in a reader's own transaction is invisible to the
 * purge under MVCC, and that invisibility is exactly the failure this design
 * exists to avoid. A JS `Map` twin would pass every unit test while proving
 * nothing about either. `invalidation-outbox.ts` / `schema-invalidation.ts` are
 * the existing precedent for a deliberate no-twin module.
 *
 * **No heartbeat column, and therefore `expires_at` is mandatory.** The lease row
 * must COMMIT in its own short transaction before the read begins, which means it
 * survives a reader that crashes. The only way a crashed reader's row stops
 * holding up a purge is that it expires on its own. `expires_at > acquired_at` is
 * a CHECK rather than a convention because a lease that expires at or before it
 * was taken is a lease the purge would treat as already absent.
 *
 * **The key is `(lease_id, source_ref)`, not `lease_id` alone.** One query read
 * covers the whole authorized source set, so it registers ONE lease id against
 * EVERY source it may read — a single reader is many rows, and `lease_id` alone
 * collides across them. The lease id still identifies the reader (the release
 * deletes every row carrying it), while the pair keeps each row distinct.
 *
 * **The expiry is a query-time filter, never an index predicate.** A partial index
 * whose predicate is `expires_at > now()` is rejected by PostgreSQL — `now()` is
 * not IMMUTABLE — so the scan filters `expires_at > now()` in the WHERE clause and
 * the index carries `expires_at` as an ordinary column. That is also the correct
 * shape: the predicate a purge needs is `(scope_binding, source_ref)` plus a live
 * bound, and the third column makes the scan stop at the first expired row.
 *
 * **The tombstone is content-free and minimal** (spec step 4: "Preserve only
 * minimal non-content tombstone/outcome data"): it names the scope, the source and
 * the purge revision, and carries no payload, no digest and no actor. Its key
 * includes `purge_revision` because that is the whole idempotency mechanism — a
 * retry presents the same revision and joins the committed tombstone instead of
 * allocating a second `seq`, which is what keeps the per-consumer invalidation
 * stream gapless across a crash.
 */
import { sqlTextList, type SchemaBootstrapClient } from "./schema-sql.js";

/**
 * The reader classes a lease may name.
 *
 * `query` is the structured Query read path, whose own execution bound is
 * `STRUCTURED_QUERY_READER_LEASE_MS`. `evidence` exists so the vocabulary is a
 * schema property rather than a convention a later reader-widening has to
 * remember, but no evidence read registers one yet: widening to that path would
 * touch the whole write path, which is a larger decision than this slice owns.
 */
export const STRUCTURED_READER_KINDS = ["query", "evidence"] as const;

export type StructuredReaderKind = (typeof STRUCTURED_READER_KINDS)[number];

export async function upSchemaStructuredPurge(
  client: SchemaBootstrapClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS structured_read_leases (
      lease_id       uuid NOT NULL,
      scope_binding  text NOT NULL CHECK (length(scope_binding) > 0),
      source_ref     text NOT NULL CHECK (length(source_ref) > 0),
      reader_kind    text NOT NULL
                      CHECK (reader_kind IN (${sqlTextList(STRUCTURED_READER_KINDS)})),
      purge_revision text NOT NULL CHECK (length(purge_revision) > 0),
      acquired_at    timestamptz NOT NULL DEFAULT now(),
      expires_at     timestamptz NOT NULL,
      CONSTRAINT structured_read_leases_key
        PRIMARY KEY (lease_id, source_ref),
      CONSTRAINT structured_read_leases_expiry_check
        CHECK (expires_at > acquired_at)
    )`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS structured_read_leases_active_idx
      ON structured_read_leases (scope_binding, source_ref, expires_at)`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS structured_purge_tombstones (
      scope_binding  text NOT NULL CHECK (length(scope_binding) > 0),
      source_ref     text NOT NULL CHECK (length(source_ref) > 0),
      purge_revision text NOT NULL CHECK (length(purge_revision) > 0),
      purged_at      timestamptz NOT NULL,
      CONSTRAINT structured_purge_tombstones_key
        PRIMARY KEY (scope_binding, source_ref, purge_revision)
    )`);
}