/**
 * The `seq` allocator for the invalidation outbox, and the one place the
 * invalidation vocabulary lives (ADR 0097 §2.6 and §4.2; the register at
 * `plans/structured-corpus-p3-prerequisites.md` §1b.4).
 *
 * Sibling of the schema module rather than a second statement inside it: the
 * DDL declares what the stream IS and this module decides how a number reaches
 * it, which is a transaction concern with a client and a bound parameter, and
 * `schema-invalidation.ts` is consumed by the bootstrap through a client with no
 * values at all. Keeping the allocator here is also what lets the reason
 * vocabulary be imported by the DDL without the schema depending on a
 * transaction.
 *
 * **Why an upsert and not a select-then-update.** ADR 0097 §4.2 asks for a
 * per-consumer counter row under a blocking `SELECT … FOR UPDATE`. The conflict
 * path of `INSERT … ON CONFLICT DO UPDATE` takes exactly that row lock — the
 * second writer blocks until the first commits or rolls back — so the upsert IS
 * the blocking read, done in one round trip. A separate select-then-update would
 * need the two statements to be in one transaction to be correct at all, and
 * would still be two round trips for the same lock.
 *
 * **Why not a SEQUENCE.** `nextval` is non-transactional, so a rolled-back
 * purge permanently burns a value and fin's drain — which refuses a first `seq`
 * beyond its watermark by more than one and states it "never resets to the start
 * and never silently skips" — wedges with no in-application repair. `FOR UPDATE
 * SKIP LOCKED` is disqualified the other way: skipping leaves the event with no
 * `seq` to carry, forcing it out of the caller's transaction.
 *
 * This takes a client, never a pool, because the caller must already be inside
 * the purge transaction for the allocation to roll back with it. A pool here
 * would allocate outside that transaction and reintroduce the burn.
 */
import { GraphragError } from "../errors.js";
import {
  MAX_CONSUMER_ID_CHARS,
  isBoundedConsumerId,
} from "./evidence-store.js";
import { scopedSafeNumber } from "./structured-scope-reads.js";

/** The closed `reason` vocabulary. No expiry member: see ADR 0097 §2.6. */
export const INVALIDATION_REASON = {
  /** Current authorization for the grant's scope was revoked. */
  ACCESS_REVOKED: "access_revoked",
  /** The grant's sources were explicitly purged. */
  PURGED: "purged",
} as const;

export type InvalidationReason =
  (typeof INVALIDATION_REASON)[keyof typeof INVALIDATION_REASON];

/** The same vocabulary as a list, for the DDL's CHECK and for a caller. */
export const INVALIDATION_REASON_VALUES: readonly InvalidationReason[] =
  Object.values(INVALIDATION_REASON);

/**
 * Minimal query surface. A `pg` pool client, a transaction client and a test
 * fake all satisfy it structurally; this module owns no lifecycle.
 */
export interface InvalidationOutboxClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/** One consumer's row in `evidence_invalidation_cursors`. */
export interface EvidenceInvalidationCursor {
  readonly consumer_id: string;
  readonly acked_checkpoint: string;
  readonly acked_seq: number;
  readonly acked_at: string;
  readonly last_allocated_seq: number;
}

/** A row of the cursor table as `pg` returns it, with the bigints as text. */
interface InvalidationCursorRow {
  consumer_id?: unknown;
  acked_checkpoint?: unknown;
  acked_seq?: unknown;
  acked_at?: unknown;
  last_allocated_seq?: unknown;
}

function toInvalidationCursor(
  row: InvalidationCursorRow
): EvidenceInvalidationCursor {
  return {
    consumer_id: String(row.consumer_id),
    acked_checkpoint: String(row.acked_checkpoint),
    // `scopedSafeNumber`, not a bare `Number`: these are int8 columns `pg`
    // hands back as text, and `Number()` turns an unreadable value into a silent
    // `NaN` that a caller would compare against as if it were a position. The
    // shared helper raises the same typed refusal every other bigint read in the
    // storage layer raises, so an unreadable cursor is a classifiable failure
    // rather than a gap the drain mistakes for "nothing acknowledged".
    acked_seq: scopedSafeNumber(row.acked_seq, "invalidation acked_seq"),
    acked_at: new Date(String(row.acked_at)).toISOString(),
    last_allocated_seq: scopedSafeNumber(
      row.last_allocated_seq,
      "invalidation last_allocated_seq"
    ),
  };
}

/**
 * Allocate the next `seq` for one consumer, in the caller's transaction.
 *
 * The bound parameter is why this is a function rather than a rendered
 * statement: a consumer id is transport-supplied, and interpolating one into SQL
 * would make a value the host controls into a statement fragment.
 *
 * The first allocation for a consumer creates its counter row; every later one
 * takes the row lock through the conflict path. Either way the returned value is
 * this transaction's own number, so a rollback returns it — that is the whole
 * property the SEQUENCE rejection above exists to protect.
 */
export async function allocateInvalidationSeq(
  client: InvalidationOutboxClient,
  consumerId: string
): Promise<number> {
  // Refused BEFORE the write, because a blank id is not a stream: `""` and
  // `"   "` would each mint their own cursor row and each be drained by nobody,
  // which is the cross-consumer confusion the stored `consumer_id` exists to
  // prevent. The rule is `isBoundedConsumerId`, the same predicate the grant
  // store applies — one rule, two enforcement points — and `evidence_invalidation_cursors`
  // carries the matching CHECK so the table refuses a direct insert too.
  if (!isBoundedConsumerId(consumerId)) {
    throw new GraphragError(
      `invalidation outbox: consumer id must be a non-blank label of at most ` +
        `${MAX_CONSUMER_ID_CHARS} characters, got ${JSON.stringify(consumerId)}`,
      "STORAGE_ERROR"
    );
  }
  const { rows } = await client.query(
    `INSERT INTO evidence_invalidation_cursors
       (consumer_id, last_allocated_seq)
     VALUES ($1, 1)
     ON CONFLICT (consumer_id) DO UPDATE
       SET last_allocated_seq =
             evidence_invalidation_cursors.last_allocated_seq + 1
     RETURNING last_allocated_seq`,
    [consumerId]
  );
  const first = (rows as InvalidationCursorRow[])[0];
  if (first === undefined) {
    // Typed, like `requireRow` in evidence-pg.ts: a RETURNING that hands back
    // no row is a lost write, and a caller branching on the failure has to be
    // able to name it. A bare Error would arrive as prose and classify as some
    // unrelated unavailability.
    throw new GraphragError(
      `invalidation outbox: allocating a seq for "${consumerId}" returned no row`,
      "STORAGE_ERROR"
    );
  }
  return scopedSafeNumber(
    first.last_allocated_seq,
    "invalidation last_allocated_seq"
  );
}

/**
 * Read one consumer's cursor as data, for a caller that needs both halves of its
 * position at once.
 *
 * Not asked for by this slice — §1.1 fixes the cursor TABLE's columns and D5
 * authorizes the allocator, and no register item asks for a read. It is kept,
 * rather than deferred to the slice that does, because §1.5 (acknowledgement
 * re-verification) cannot be built without it: "did my last ack land" is
 * precisely the question this answers, and a re-verifying drain that had to
 * re-derive the row shape here would be reading a second, hand-written copy of
 * the same conversion. It has no production caller yet, and keeping it changes
 * no behaviour.
 */
export async function readInvalidationCursor(
  client: InvalidationOutboxClient,
  consumerId: string
): Promise<EvidenceInvalidationCursor | null> {
  const { rows } = await client.query(
    `SELECT consumer_id, acked_checkpoint, acked_seq, acked_at,
            last_allocated_seq
       FROM evidence_invalidation_cursors
      WHERE consumer_id = $1`,
    [consumerId]
  );
  const first = (rows as InvalidationCursorRow[])[0];
  return first === undefined ? null : toInvalidationCursor(first);
}
