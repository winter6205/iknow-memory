/**
 * The `seq` allocator for the invalidation outbox, the one place the invalidation
 * vocabulary lives (ADR 0097 §2.6 and §4.2; the register), and the retention
 * sweep that discharges register §1.6.
 *
 * Sibling of the schema module rather than a second statement inside it: the
 * DDL declares what the stream IS and this module decides how a number reaches
 * it, which is a transaction concern with a client and a bound parameter, and
 * `schema-invalidation.ts` is consumed by the bootstrap through a client with no
 * values at all. Keeping the allocator here is also what lets the reason
 * vocabulary be imported by the DDL without the schema depending on a
 * transaction.
 *
 * **Why not a SEQUENCE.** `nextval` is non-transactional, so a rolled-back
 * purge permanently burns a value and fin's drain — which refuses a first `seq`
 * beyond its watermark by more than one and states it "never resets to the start
 * and never silently skips" — wedges with no in-application repair. `FOR UPDATE
 * SKIP LOCKED` is disqualified the opposite way: skipping leaves the event with no
 * `seq` to carry, forcing it out of the caller's transaction.
 *
 * **Why an upsert and not a select-then-update.** ADR 0097 §4.2 asks for a
 * per-consumer counter row under a blocking `SELECT … FOR UPDATE`. The conflict
 * path of `INSERT … ON CONFLICT DO UPDATE` takes exactly that row lock — the
 * second writer blocks until the first commits or rolls back — so the upsert IS
 * the blocking read, done in one round trip. A separate select-then-update would
 * need the two statements to be in one transaction to be correct at all, and
 * would still be two round trips for the same lock.
 *
 * This takes a client, never a pool, because the caller must already be inside
 * the purge transaction for the allocation to roll back with it. A pool here
 * would allocate outside that transaction and reintroduce the burn. The retention
 * sweep takes a client for the same discipline: it runs in the caller's
 * transaction so the rows it reports as collected and the rows it deletes cannot
 * disagree.
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

/**
 * The lowest `seq` this consumer still retains, or `null` when it retains none.
 *
 * Read, not remembered, and read from the stream itself: retention deletes rows
 * under its own authority, so a stored floor would be a value the sweep has to
 * keep in step with a statement that already decides the same thing.
 *
 * Shared by the drain and the acknowledgement because both ask the same question
 * about the same rows — where this consumer's window begins — and two copies of
 * it would be two boundaries allowed to disagree about what a consumer was
 * handed.
 */
export async function readFirstRetainedSeq(
  client: InvalidationOutboxClient,
  consumerId: string
): Promise<number | null> {
  const { rows } = await client.query(
    `SELECT min(seq) AS first_seq
       FROM evidence_invalidation_outbox
      WHERE consumer_id = $1`,
    [consumerId]
  );
  const first = rows[0] as { first_seq?: unknown } | undefined;
  if (first === undefined || first.first_seq === null) return null;
  return scopedSafeNumber(first.first_seq, "invalidation first retained seq");
}

/** One event's two retention facts, as the sweep reads them. */
export interface RetainedInvalidationEvent {
  readonly eventId: string;
  /** The event's position in its consumer's stream. */
  readonly seq: number;
  /** The consumer's stored position; `null` when the stream has no cursor row. */
  readonly ackedSeq: number | null;
  /**
   * The invalidated grant's deadline, or `null` when the grant row is gone.
   *
   * `null` means "there is no live grant behind this reference any more", which is
   * NOT the same as unexpired: the retention clause is conditioned on the grant
   * REMAINING unexpired, and a collected grant does not remain anything.
   */
  readonly grantExpiresAt: string | null;
}

/** Which events the sweep may delete, and which it must keep. */
export interface InvalidationRetentionPlan {
  readonly collectedEventIds: readonly string[];
  readonly retainedEventIds: readonly string[];
}

/**
 * Decide the sweep for one batch of events.
 *
 * **The clause being implemented, exactly.** The evidence spec (`:264`) says "the
 * backend keeps unacknowledged events while their grants remain unexpired" and
 * (`:265`) that "expiry lets both stores collect payloads without depending on
 * acknowledgements". So there are exactly two independent ways an event stops
 * being needed, and one of them is NOT one:
 *
 *  - the consumer acknowledged through it — it has served its purpose, and the
 *    stream resumes above that position rather than from it;
 *  - its grant is expired, or its grant row is gone — nothing can still be
 *    scrubbed for that reference, so retaining the event protects nobody.
 *
 * Everything else is retained. In particular an UNACKNOWLEDGED event on an
 * UNEXPIRED grant is retained even though its owner may never come back: that is
 * the case the clause exists for, and ADR 0099 §2.3 says such an owner stays
 * pending rather than being written off.
 *
 * **Why expiry cannot be inferred from `reason`.** ADR 0097 §2.6 makes the reason
 * a closed two-member enum with no expiry member, precisely so a stream event can
 * never be read as an age-based collection signal. So the deadline is read from
 * the GRANT this event names, which is the only place an age actually lives.
 *
 * Pure, because the boundary is where a wrong answer silently loses an event that
 * fin was the only one who could still have scrubbed.
 */
export function planInvalidationRetention(
  events: readonly RetainedInvalidationEvent[],
  at: string
): InvalidationRetentionPlan {
  const now = Date.parse(at);
  if (!Number.isFinite(now)) {
    throw new GraphragError(
      `invalidation retention: the sweep instant must be a readable timestamp, ` +
        `got ${JSON.stringify(at)}`,
      "STORAGE_ERROR"
    );
  }
  const collected: string[] = [];
  const retained: string[] = [];
  for (const event of events) {
    if (isAcknowledged(event) || grantIsFinished(event, now)) {
      collected.push(event.eventId);
    } else {
      retained.push(event.eventId);
    }
  }
  return { collectedEventIds: collected, retainedEventIds: retained };
}

/**
 * Whether the consumer has acknowledged through this event's position.
 *
 * A named rule rather than an inline comparison because it is the retention
 * clause's other half, and both halves have to be readable in one place: an event
 * is unacknowledged while it sits ABOVE the stored position — the same direction as
 * the drain's resume rule and the opposite of the sweep's.
 *
 * A consumer with no cursor row has acknowledged nothing, so `null` is never an
 * acknowledgement.
 */
function isAcknowledged(event: RetainedInvalidationEvent): boolean {
  return event.ackedSeq !== null && event.seq <= event.ackedSeq;
}

/**
 * Whether nothing can still be scrubbed for this reference.
 *
 * Either the grant's own deadline has passed, or the grant row is gone — which
 * reads as the same thing and is the case MP15's collection creates. An
 * unreadable deadline is treated as finished rather than as unexpired: a value
 * this build cannot read is not a live obligation, and the conservative reading
 * (retain forever) would leak an event rather than lose a scrub.
 */
function grantIsFinished(
  event: RetainedInvalidationEvent,
  now: number
): boolean {
  return event.grantExpiresAt === null || Date.parse(event.grantExpiresAt) <= now;
}

/**
 * Delete the events the plan may collect, and report what it did.
 *
 * **One statement, keyed by the event ids the plan named.** The plan is computed by
 * the caller from rows the caller read, so the delete does not re-derive a
 * deadline here: two spellings of the retention rule in one sweep is two chances
 * for them to disagree, and the SQL would be the harder one to test.
 *
 * **It touches no acknowledgement state.** This is the property ADR 0099 §2.3
 * depends on: an owner that was offline for the whole retention window must still
 * read as offline afterwards, so a purge whose events aged out settles at
 * `collected` and never at `completed`. A sweep that also marked the owners
 * acknowledged would be exactly the "assumed scrubbed" the record forbids.
 *
 * Returns the event ids actually deleted. A concurrent sweep may have taken some
 * of them first, so the count is reported rather than asserted: a sweep that lost
 * a race has still left the store correct.
 */
export async function collectRetainedInvalidations(
  client: InvalidationOutboxClient,
  plan: InvalidationRetentionPlan
): Promise<readonly string[]> {
  if (plan.collectedEventIds.length === 0) return [];
  const { rows } = await client.query(
    `DELETE FROM evidence_invalidation_outbox
      WHERE event_id = ANY($1::uuid[])
      RETURNING event_id`,
    [plan.collectedEventIds]
  );
  return rows.map((row) => String(row.event_id));
}

/** The rows one sweep pass reads, with each event's two retention facts joined in. */
export async function readRetainedInvalidations(
  client: InvalidationOutboxClient
): Promise<readonly RetainedInvalidationEvent[]> {
  const { rows } = await client.query(
    `SELECT o.seq,
            o.event_id,
            c.acked_seq,
            g.expires_at AS grant_expires_at
       FROM evidence_invalidation_outbox o
       LEFT JOIN evidence_invalidation_cursors c ON c.consumer_id = o.consumer_id
       LEFT JOIN evidence_grants g ON g.evidence_ref = o.evidence_ref
      ORDER BY o.consumer_id, o.seq`,
    []
  );
  return (rows as RetentionRow[]).map(toRetainedInvalidation);
}

interface RetentionRow {
  readonly seq?: unknown;
  readonly event_id?: unknown;
  readonly acked_seq?: unknown;
  readonly grant_expires_at?: unknown;
}

function toRetainedInvalidation(row: RetentionRow): RetainedInvalidationEvent {
  const expiresAt = row.grant_expires_at;
  const ackedSeq = row.acked_seq;
  return {
    eventId: String(row.event_id),
    seq: scopedSafeNumber(row.seq, "invalidation seq"),
    ackedSeq:
      ackedSeq === null || ackedSeq === undefined
        ? null
        : scopedSafeNumber(ackedSeq, "invalidation acked_seq"),
    grantExpiresAt:
      expiresAt === null || expiresAt === undefined
        ? null
        : new Date(String(expiresAt)).toISOString(),
  };
}
