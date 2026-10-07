/**
 * The evidence invalidation outbox and its per-consumer cursor: the durable,
 * content-free stream a consumer drains (ADR 0097 §2.1/§4.1; the register at
 * `plans/structured-corpus-p3-prerequisites.md` §1.1 and §1b.1).
 *
 * Sibling of schema-bootstrap.ts rather than a fifth table inside it: this is a
 * per-consumer event contract with its own allocation semantics, and the four
 * ledger tables `upSchemaBootstrap` owns are the graph system of record. The
 * bootstrap still calls it in sequence so one bootstrap creates both tables and
 * a fresh database needs no separate step.
 *
 * **The content prohibition is the schema, not a convention.** ADR 0097 §2.5
 * requires the table to carry no payload column at all — only the six scalars of
 * §2.1 — so "content-free" is a property a later writer cannot violate by
 * forgetting a rule. A `value`, a context, or a digest has nowhere to go.
 *
 * **No foreign key to `evidence_grants`, on purpose.** `evidence_ref` is an
 * opaque handle, and retention is governed by the spec's own clause that the
 * backend keeps unacknowledged events while their grants remain unexpired
 * (evidence spec:253-254). An FK with `ON DELETE CASCADE` would delete an
 * unacknowledged event the moment its grant row was collected — the exact
 * opposite of that clause, and unrecoverable, because the event is the only
 * record that the reference ever existed.
 *
 * The two facts this split between are the two halves of ADR 0097 §4.1:
 * `acked_seq` is what a consumer acknowledged, `last_allocated_seq` is what the
 * store handed out. `acked_seq` is deliberately not named `last_seq`, because
 * fin's column of that name means *applied* — one name for two quantities across
 * two systems is a silent-error generator.
 *
 * **What the `uuid` type does and does not pin about `event_id`.** ADR 0097
 * §2.1 specifies "string, UUID v4", and the column enforces the string half in
 * full: `uuid` rejects any other spelling, and `UNIQUE (event_id)` makes one
 * identity one event across every consumer. The VERSION half is deliberately not
 * a CHECK: §1.2 owns the producer that mints these ids, and it is not written
 * yet, so a version constraint here would decide a producer's output format
 * before there is a producer to read — while adding nothing a reader needs
 * (drain matches on equality). Recording the owner here is what keeps the ADR's
 * wording honest: the schema pins format and global identity, and v4 is §1.2's
 * obligation.
 */
import { sqlTextList, type SchemaBootstrapClient } from "./schema-sql.js";
import { INVALIDATION_REASON_VALUES } from "./invalidation-outbox.js";

export async function upSchemaInvalidation(
  client: SchemaBootstrapClient
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS evidence_invalidation_outbox (
      consumer_id   text NOT NULL,
      seq           bigint NOT NULL,
      event_id      uuid NOT NULL,
      evidence_ref  text NOT NULL,
      reason        text NOT NULL,
      occurred_at   timestamptz NOT NULL,
      CONSTRAINT evidence_invalidation_outbox_reason_check
        CHECK (reason IN (${sqlTextList(INVALIDATION_REASON_VALUES)})),
      CONSTRAINT evidence_invalidation_outbox_seq_check
        CHECK (seq >= 1),
      -- ADR 0097 §2.1's bound is a schema property, not a request-parser one:
      -- a ref longer than the contract allows is refused by the table itself.
      CONSTRAINT evidence_invalidation_outbox_ref_check
        CHECK (char_length(evidence_ref) BETWEEN 1 AND 128),
      CONSTRAINT evidence_invalidation_outbox_event_key
        UNIQUE (event_id),
      -- The per-consumer stream's own key. This is what makes the gapless
      -- ordering addressable, and it is the index the drain read scans.
      CONSTRAINT evidence_invalidation_outbox_consumer_seq_key
        UNIQUE (consumer_id, seq)
    )`);
  // The retention scan and the purge path both key on the reference, never on
  // the consumer: an event outlives the acknowledgement its consumer never sent.
  await client.query(`
    CREATE INDEX IF NOT EXISTS evidence_invalidation_outbox_evidence_ref_idx
      ON evidence_invalidation_outbox (evidence_ref)`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS evidence_invalidation_cursors (
      consumer_id        text PRIMARY KEY
        -- The stream identity, not a free-text field: a blank one would be a
        -- cursor row nobody drains. allocateInvalidationSeq refuses it before
        -- writing; this CHECK is the backstop for any other writer, so the
        -- property the code claims is the table's own rather than a convention
        -- every future writer has to remember.
        CHECK (char_length(btrim(consumer_id)) > 0),
      acked_checkpoint   text NOT NULL DEFAULT '',
      acked_seq          bigint NOT NULL DEFAULT 0,
      acked_at           timestamptz NOT NULL DEFAULT now(),
      last_allocated_seq bigint NOT NULL DEFAULT 0,
      CONSTRAINT evidence_invalidation_cursors_acked_seq_check
        CHECK (acked_seq >= 0),
      CONSTRAINT evidence_invalidation_cursors_allocated_seq_check
        CHECK (last_allocated_seq >= 0)
    )`);
}
