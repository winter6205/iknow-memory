/**
 * The purge-outcome tables: ADR 0099 §2.1's four states, persisted as rows.
 *
 * Sibling of `schema-structured-purge.ts` for the same reason that module is a
 * sibling rather than two more tables inside `schema-bootstrap.ts`: MP16's tables
 * are the purge transaction's own primitives (the lease it waits on, the tombstone
 * that makes a retry idempotent) and these are the completion record's, with a
 * different writer set and a different lifecycle. `upSchemaBootstrap` still calls
 * this in sequence so one bootstrap covers the whole package — without which an
 * already-bootstrapped database would never receive these tables, which is why
 * `schema-lock.ts` probes for them by name.
 *
 * **Two tables, because the states are not all the same width.** ADR 0099 §2.1
 * fixes one state per owner and one per revision, and §2.4b then names the two
 * columns its guard reads: `ack_state` on the owner row and `collection_state` on
 * the revision row. Folding them into one row would make "every owner acked" a
 * single nullable column whose absence would be indistinguishable from a
 * completion.
 *
 * **The content prohibition is the schema.** Both tables are non-content: a scope,
 * a revision, a stream label, a position and a time. There is no column a payload,
 * a source ref, a query text or a digest could be written into, which is ADR 0099
 * §2.5's structural enforcement applied to the record that outlives the purge.
 *
 * **`ack_state` has two members and no third.** The set is closed at the table, so
 * "moves forward only" is partly a property of the schema rather than of a
 * discipline: a regression would have to be spelled as a value this CHECK refuses.
 * The scrub arm's CHECK additionally makes the two scrub facts inseparable — a row
 * cannot carry an acknowledged checkpoint without the instant it was taken, and a
 * `scheduled` row cannot carry either.
 *
 * **`covered_seq` is what makes `scrubbed` decidable without a forbidden column.**
 * ADR 0097 §2.1 fixes the invalidation outbox at six scalars with no
 * `purge_revision`, so an event cannot be joined back to the revision that emitted
 * it. Recording the consumer's position as of the purge commit instead turns the
 * join around: an owner has scrubbed this revision exactly when its acknowledged
 * position has reached the point through which this revision published everything
 * it will publish for it. See ADR 0099 §2.1's `scrubbed` row, and
 * `structured-purge-completion.ts` for the derivation.
 *
 * **No foreign key to the tombstone, on purpose.** The tombstone is keyed
 * `(scope_binding, source_ref, purge_revision)` — one row per purged SOURCE — and
 * this record is keyed `(scope_binding, purge_revision)`: one purge revision covers
 * several sources and they share one all-owner verdict. A key spanning both would
 * either duplicate the revision record per source or make a second source's purge a
 * separate completion, which is precisely the per-source-is-not-per-owner confusion
 * ADR 0099 §2.1 rejects.
 *
 * **`completed_at` has no writer in this file and no default.** It is set by exactly
 * one statement in the reconciler (`structured-purge-completion.ts`), which the
 * contract test proves by source shape rather than by convention.
 */
import { sqlTextList, type SchemaBootstrapClient } from "./schema-sql.js";

/**
 * ADR 0099 §2.1's revision-level collection states.
 *
 * `scheduled` is the purge transaction's; `collected` is the local delete
 * transaction's. The other two states of the four are not revision-level —
 * `scrubbed` belongs to one owner and `completed` is the reconciler's verdict — so
 * they are columns of the other table rather than members of this vocabulary. A
 * CHECK listing all four here would make the schema accept a value no writer can
 * produce.
 */
export const PURGE_COLLECTION_STATES = ["scheduled", "collected"] as const;

/**
 * ADR 0099 §2.1's owner-level acknowledgement states.
 *
 * Closed at two, in this order: `scrubbed` is reachable from `scheduled` and not
 * the reverse, which is the whole of "forward only" at the storage boundary.
 */
export const PURGE_ACK_STATES = ["scheduled", "scrubbed"] as const;

export async function upSchemaStructuredCompletion(
  client: SchemaBootstrapClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS structured_purge_outcomes (
      scope_binding     text NOT NULL CHECK (length(scope_binding) > 0),
      purge_revision    text NOT NULL CHECK (length(purge_revision) > 0),
      collection_state  text NOT NULL
        CHECK (collection_state IN (${sqlTextList(PURGE_COLLECTION_STATES)})),
      scheduled_at      timestamptz NOT NULL DEFAULT now(),
      collected_at      timestamptz NULL,
      completed_at      timestamptz NULL,
      CONSTRAINT structured_purge_outcomes_key
        PRIMARY KEY (scope_binding, purge_revision),
      -- ADR 0099 §2.4b's third guard clause, as a storage invariant: the record
      -- cannot be completed before it was collected. The reconciler's WHERE
      -- already says this; a CHECK says it to every other writer too, so a future
      -- path that tries to set completed_at without the local delete fails at the
      -- table instead of succeeding quietly.
      CONSTRAINT structured_purge_outcomes_completion_check
        CHECK (completed_at IS NULL OR collection_state = 'collected')
    )`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS structured_purge_ack_states (
      scope_binding    text NOT NULL CHECK (length(scope_binding) > 0),
      purge_revision   text NOT NULL CHECK (length(purge_revision) > 0),
      -- The stream identity, bounded the same way the outbox's cursor table bounds
      -- it: a blank label is a stream nobody drains, so a row naming one would be a
      -- pending completion for an owner that does not exist. The 512-character
      -- bound itself is TypeScript's isBoundedConsumerId, not expressible here;
      -- this CHECK is the backstop against a direct insert.
      consumer_id      text NOT NULL CHECK (char_length(btrim(consumer_id)) > 0),
      ack_state        text NOT NULL
        CHECK (ack_state IN (${sqlTextList(PURGE_ACK_STATES)})),
      covered_seq      bigint NOT NULL CHECK (covered_seq >= 0),
      acked_checkpoint text NULL,
      scrubbed_at      timestamptz NULL,
      CONSTRAINT structured_purge_ack_states_key
        PRIMARY KEY (scope_binding, purge_revision, consumer_id),
      -- The two scrub facts are one fact: a position the owner acknowledged cannot
      -- exist without the instant it was acknowledged, and a scheduled owner has
      -- acknowledged nothing. This is what makes "advance only" visible to a reader
      -- of the row rather than a promise the writer has to keep.
      CONSTRAINT structured_purge_ack_states_scrub_check
        CHECK ((ack_state = 'scheduled'
                AND acked_checkpoint IS NULL AND scrubbed_at IS NULL)
            OR (ack_state = 'scrubbed' AND scrubbed_at IS NOT NULL))
    )`);
  // The retention sweep scans events by reference and resolves each one's grant, and
  // the reconciler's all-owner guard joins owner rows by
  // (scope_binding, purge_revision) with the derived owner set — both are prefix
  // scans of the primary key, but the derived set arrives as a value list, so the
  // (scope, revision) prefix is what makes that a bounded lookup per owner.
  await client.query(`
    CREATE INDEX IF NOT EXISTS structured_purge_ack_states_scope_revision_idx
      ON structured_purge_ack_states (scope_binding, purge_revision)`);
}