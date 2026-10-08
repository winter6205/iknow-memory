/**
 * The `invalidations` drain read: register §1.4, and the `invalidations` half of
 * §1.3. One authorized read-only unit of work per drain, returning the
 * content-free per-consumer event batch the spec fixes at
 * `specs/structured-corpus-evidence.md:226` and ADR 0097 §2.1 shapes.
 *
 * **One transaction, and why that is the whole design.** A drain answers two
 * questions that are only jointly meaningful at one instant: "which `seq` has
 * this stream reached" and "which events exist". Read the cursor in one
 * transaction and the events in another, a purge that commits between them has
 * produced an answer that was never true — a batch whose first `seq` is above a
 * watermark that had not yet moved, which is indistinguishable from the gap
 * ADR 0097 §2.7 forbids a backend from hiding. So the cursor, the retained
 * window's floor and the page are all read on one client inside one
 * `REPEATABLE READ READ ONLY` transaction, and the identity is re-checked
 * INSIDE it: an authorization validated before the transaction can be revoked
 * before the read, and a revoked identity would otherwise have its events
 * delivered. `PgMaintenanceStatusStorage` (`structured-status-reads.ts:265-288`)
 * is the shape precedent for exactly this composition.
 *
 * **No memory twin, on this module's own argument.** `evidence-read.ts:90-93`
 * gives it for the grant read — "an Evidence read is not answerable without one
 * transaction" — and the drain is weaker on both counts: it answers from a
 * durable stream whose producer (register §1.2, the purge transaction) does not
 * exist yet, and a memory lane could only fabricate events, which is the one
 * thing this capability must never do. A `-memory.ts` twin here would be a
 * second answer to a question about durable state.
 *
 * **The refusal arms stay inside the transaction.** Returning a refusal as a
 * value and re-throwing outside follows `readPrivateEvidence`: `runTransaction`'s
 * rollback path re-types whatever the callback threw into a `StructuredScopeError`
 * carrying a code from the closed scope set, so an evidence token raised inside
 * would arrive as `backend_unavailable` and lose the one distinction a consumer
 * branches on.
 *
 * **What this module deliberately does not do.** It does not acknowledge, so
 * `acked_checkpoint`/`acked_seq` are never written here (§1.5 owns that write in
 * its own transaction), and it does not retain, so nothing is deleted from the
 * outbox on a drain (§1.6). Reading the cursor row is therefore not bookkeeping:
 * `last_allocated_seq` is what makes a checkpoint claiming a position past the
 * backend's own watermark decidable as "never issued", which ADR 0097 §2.7
 * requires the backend — not the consumer — to judge.
 */
import { GraphragError } from "../errors.js";
import { EVIDENCE_FAILURE } from "../types.js";
import {
  MAX_EVIDENCE_BYTES,
  MAX_CONSUMER_ID_CHARS,
  isBoundedConsumerId,
} from "./evidence-store.js";
import {
  decodeInvalidationCheckpoint,
  mintInvalidationCheckpoint,
  type InvalidationCheckpointKey,
} from "./evidence-invalidation-checkpoint.js";
import {
  readFirstRetainedSeq,
  readInvalidationCursor,
  type EvidenceInvalidationCursor,
  type InvalidationReason,
} from "./invalidation-outbox.js";
import {
  EVIDENCE_ACTION,
  EVIDENCE_REFUSAL_REASON,
  EvidenceRefusalError,
  EVIDENCE_RESULT_SCHEMA,
  EVIDENCE_ENVELOPE_VERSION,
  type EvidenceInvalidationEvent,
  type EvidenceInvalidationsRequest,
  type EvidenceInvalidationsResult,
  type EvidenceRefusal,
} from "./evidence-read.js";
import { assertCurrentAuthorization } from "./structured-status-reads.js";
import { scopedSafeNumber } from "./structured-scope-reads.js";
import {
  scopeAuthorityOf,
  type AuthorizedScopeContext,
  type AuthorizedScopeUnitOfWork,
  type ScopeTransactionClient,
  type ScopeTransactionOwner,
} from "./structured-scope-types.js";

/**
 * The spec's documented `limit` window for `invalidations`.
 *
 * A bound rather than a default with a cap: a request for 21 is a request outside
 * the contract fin asked for, and silently serving 20 would make the consumer's
 * own "did my batch exceed the documented limit" check unreachable.
 */
export const MIN_INVALIDATION_BATCH = 1;
export const MAX_INVALIDATION_BATCH = 20;
export const DEFAULT_INVALIDATION_BATCH = 20;

/**
 * The closed event field set of ADR 0097 §2.1, declared here so a reader can
 * assert the emitted shape is the amended one.
 *
 * `schema_version` is deliberately absent: ADR 0097's amendment withdrew the
 * per-event version because `invalidations` is an ACTION of the existing
 * `iknow.evidence_result` envelope, and that envelope already carries it. The
 * spec sets its own convention three lines later — `corpus_collection_outcome`
 * gets a separate token pair because it is a separate METHOD, which an action of
 * an existing envelope is not. Six stored columns became five sent fields plus the
 * stored `consumer_id`, and this is the sent half.
 */
export const INVALIDATION_EVENT_FIELDS: readonly (keyof EvidenceInvalidationEvent)[] = [
  "event_id",
  "seq",
  "evidence_ref",
  "reason",
  "occurred_at",
];

/** What the row mapper needs; every field is read, none is defaulted. */
interface InvalidationEventRow {
  readonly seq?: unknown;
  readonly event_id?: unknown;
  readonly evidence_ref?: unknown;
  readonly reason?: unknown;
  readonly occurred_at?: unknown;
}

/** The `reason` values this build will emit, checked at the row boundary. */
const REASONS: ReadonlySet<string> = new Set([
  "access_revoked",
  "purged",
]);

/**
 * Where a drain resumes, and whether the position it was handed still exists.
 *
 * Pure on purpose: the gap verdict is the part of this capability a caller must
 * be able to reason about without a database, and it is the part where a wrong
 * answer silently loses events.
 */
export interface InvalidationDrainPlan {
  /** The first `seq` this drain will return; 1 when the stream is empty. */
  readonly startSeq: number;
  /**
   * `true` when the position is unusable and the batch restarts at the earliest
   * retained row, per ADR 0097 §2.7.
   */
  readonly gap: boolean;
}

export interface InvalidationDrainPlanInput {
  readonly consumerId: string;
  /** The checkpoint the consumer presented; `null` on a first drain. */
  readonly checkpoint: string | null;
  /** This consumer's stored cursor, or `null` before anything was allocated. */
  readonly cursor: EvidenceInvalidationCursor | null;
  /** The lowest `seq` still retained for this consumer, or `null` if none is. */
  readonly firstRetainedSeq: number | null;
  /** Decodes the presented checkpoint against the calling consumer. */
  readonly decode: (
    raw: string,
    consumerId: string
  ) => { readonly s: number } | null;
}

/**
 * Decide the resume position and the gap verdict.
 *
 * Three distinct failures fold onto one `true`, and the distinction is kept in
 * `startSeq` rather than in the boolean because the consumer's recovery differs:
 * a checkpoint this build minted for a window that is still retained resumes
 * normally, while an unauthenticable or foreign one must restart from the
 * earliest retained row and be revalidated. `gap` is never inferred from an empty
 * `events` array — that is the consumer's inference to avoid, and ADR 0097 §2.7
 * makes it the backend's verdict instead.
 */
export function planInvalidationDrain(
  input: InvalidationDrainPlanInput
): InvalidationDrainPlan {
  // An empty stream has no floor and therefore no window that could have been
  // lost: the answer is an empty batch, not a gap a consumer must revalidate for
  // events that never existed. That is why the restart position is
  // `firstRetainedSeq ?? 1` on every gap below — the earliest row there IS, or the
  // start of a stream that has none.
  if (input.checkpoint === null) {
    return { startSeq: input.firstRetainedSeq ?? 1, gap: false };
  }
  const decoded = input.decode(input.checkpoint, input.consumerId);
  if (decoded === null) {
    return { startSeq: input.firstRetainedSeq ?? 1, gap: true };
  }
  if (!continuesFrom(decoded.s, input)) {
    return { startSeq: input.firstRetainedSeq ?? 1, gap: true };
  }
  return { startSeq: decoded.s + 1, gap: false };
}

/**
 * Whether a decoded position is still a position this stream can continue from.
 *
 * Two different losses, one boolean: the watermark test catches a checkpoint the
 * backend never handed out, and the floor test catches one whose window is gone.
 * They are the same consumer action — revalidate, do not acknowledge — so they
 * are the same verdict.
 */
function continuesFrom(
  coveredSeq: number,
  input: InvalidationDrainPlanInput
): boolean {
  if (coveredSeq > (input.cursor?.last_allocated_seq ?? 0)) return false;
  // Exactly one retained row above the covered position is contiguity, not a
  // hole, which is what makes the `+ 1` load-bearing.
  return (
    input.firstRetainedSeq === null ||
    coveredSeq + 1 >= input.firstRetainedSeq
  );
}

export interface InvalidationBatch {
  readonly events: readonly EvidenceInvalidationEvent[];
  /** The checkpoint covering everything through the batch's last `seq`. */
  readonly next_checkpoint: string;
}

/**
 * Assemble the batch from rows already in ascending `seq`, unchanged.
 *
 * No renumbering, no compaction, no dropping: the gapless per-consumer `seq` is
 * the whole of what makes "I missed something" decidable (ADR 0097 §2.2), so a
 * row this build cannot type is a storage fault raised rather than a page
 * quietly rewritten into a contiguous-looking one. The covered position advances
 * to the LAST row, which on an empty batch is the position the caller already
 * had — so a poll that finds nothing mints the checkpoint it was given rather
 * than a new one that claims movement.
 */
export function renderInvalidationBatch(
  rows: readonly InvalidationEventRow[],
  input: {
    readonly consumerId: string;
    readonly coveredSeq: number;
    readonly key: InvalidationCheckpointKey;
  }
): InvalidationBatch {
  const events = rows.map(toInvalidationEvent);
  const last = events.length === 0 ? input.coveredSeq : events[events.length - 1].seq;
  return {
    events,
    next_checkpoint: mintInvalidationCheckpoint(last, input.consumerId, input.key),
  };
}

/**
 * One outbox row as one event.
 *
 * `occurred_at` is rendered in the contract's whole-second `Z` form rather than
 * `toISOString()`'s millisecond spelling: the field's declared type is whole
 * seconds, and a consumer that refuses a fractional spelling is right to — this
 * store does not normalize a value to make a check pass. Truncation rather than
 * rounding is what keeps a producer's instant from being read as the next second.
 */
function toInvalidationEvent(row: InvalidationEventRow): EvidenceInvalidationEvent {
  const reason = String(row.reason);
  if (!REASONS.has(reason)) {
    // Typed rather than passed through: the CHECK in the DDL is the primary
    // guard, and a row that reached a read anyway is a store fault. Emitting it
    // would put a token on the wire that no consumer's closed parser accepts,
    // which reads as a malformed contract rather than as the store's problem.
    throw new GraphragError(
      `invalidation drain: stored reason ${JSON.stringify(reason)} is outside ` +
        `the closed vocabulary ${[...REASONS].sort().join(", ")}`,
      "STORAGE_ERROR"
    );
  }
  const eventId = String(row.event_id);
  if (eventId.length === 0) {
    throw new GraphragError(
      "invalidation drain: an outbox row carried no event_id",
      "STORAGE_ERROR"
    );
  }
  return {
    event_id: eventId,
    seq: scopedSafeNumber(row.seq, "invalidation seq"),
    evidence_ref: String(row.evidence_ref),
    reason: reason as InvalidationReason,
    occurred_at: wholeSecondStamp(row.occurred_at),
  };
}

function wholeSecondStamp(value: unknown): string {
  const raw = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(raw.getTime())) {
    throw new GraphragError(
      `invalidation drain: an outbox row carried an unreadable occurred_at`,
      "STORAGE_ERROR"
    );
  }
  return new Date(Math.floor(raw.getTime() / 1000) * 1000)
    .toISOString()
    .replace(/\.000Z$/, "Z");
}

/** One page of this consumer's stream, ascending by `seq`. */
async function readInvalidationPage(
  client: ScopeTransactionClient,
  consumerId: string,
  startSeq: number,
  limit: number
): Promise<readonly InvalidationEventRow[]> {
  const { rows } = await client.query(
    `SELECT seq, event_id, evidence_ref, reason, occurred_at
       FROM evidence_invalidation_outbox
      WHERE consumer_id = $1
        AND seq >= $2
      ORDER BY seq
      LIMIT $3`,
    [consumerId, startSeq, limit]
  );
  return rows as InvalidationEventRow[];
}

type DrainOutcome =
  | { readonly granted: EvidenceInvalidationsResult }
  | { readonly refused: EvidenceRefusal };

/**
 * The authorized same-snapshot drain reader.
 *
 * PG-only, and structurally so: the constructor demands the transaction-owning
 * half of the seam, which the memory lane does not supply, so a caller cannot
 * compose this over a backend whose events exist only in a Map.
 */
export class PgEvidenceInvalidationStorage {
  constructor(
    private readonly scope: AuthorizedScopeUnitOfWork & ScopeTransactionOwner,
    private readonly key: InvalidationCheckpointKey
  ) {}

  /**
   * Drain one batch for one consumer.
   *
   * `consumerId` is the TRANSPORT's stream identity, never a request field: the
   * request parser refuses an unlisted key, so a caller that named its own
   * stream would be a typed `malformed_evidence_contract` rather than a silent
   * read of somebody else's pending scrubs.
   */
  async drainInvalidations(
    context: AuthorizedScopeContext,
    consumerId: string,
    request: EvidenceInvalidationsRequest
  ): Promise<EvidenceInvalidationsResult> {
    if (scopeAuthorityOf(context) !== this.scope) {
      throw new EvidenceRefusalError(
        EVIDENCE_FAILURE.ACCESS_DENIED,
        EVIDENCE_REFUSAL_REASON.CONTEXT_NOT_MINTED,
        "the authorized scope context was not minted by this composition"
      );
    }
    // `isBoundedConsumerId`, the store's own predicate: one rule, two enforcement
    // points. A default would be worse than a refusal here, because an invented
    // stream is a stream nobody drains and every invalidation on it is silent.
    if (!isBoundedConsumerId(consumerId)) {
      throw new EvidenceRefusalError(
        EVIDENCE_FAILURE.ACCESS_DENIED,
        EVIDENCE_REFUSAL_REASON.TRUSTED_BINDING_UNRESOLVED,
        `the transport's invalidation consumer must be a non-blank label of at ` +
          `most ${MAX_CONSUMER_ID_CHARS} characters, and is never defaulted`
      );
    }
    const outcome = await this.scope.runTransaction(
      async (client): Promise<DrainOutcome> => {
        // INSIDE the transaction, and before the first row of the stream is
        // read. The same reason `PgMaintenanceStatusStorage` puts it there: an
        // identity that was revoked between minting and reading must not receive
        // this consumer's pending invalidations.
        await assertCurrentAuthorization(client, context);
        const cursor = await readInvalidationCursor(client, consumerId);
        const firstRetainedSeq = await readFirstRetainedSeq(client, consumerId);
        // One resolution of "the position this caller presented", used by both
        // the plan and the echo: two spellings of the same fact would be two
        // chances for them to disagree inside one answer.
        const presented = request.checkpoint ?? null;
        const plan = planInvalidationDrain({
          consumerId,
          checkpoint: presented,
          cursor,
          firstRetainedSeq,
          decode: (raw, owner) =>
            decodeInvalidationCheckpoint(raw, owner, this.key),
        });
        const rows = await readInvalidationPage(
          client,
          consumerId,
          plan.startSeq,
          request.limit
        );
        const batch = renderInvalidationBatch(rows, {
          consumerId,
          coveredSeq: plan.startSeq - 1,
          key: this.key,
        });
        const envelope: EvidenceInvalidationsResult = {
          schema: EVIDENCE_RESULT_SCHEMA,
          schema_version: EVIDENCE_ENVELOPE_VERSION,
          action: EVIDENCE_ACTION.INVALIDATIONS,
          // The echo exists so a consumer can re-check contiguity locally rather
          // than trust the batch to describe its own origin; it is exactly the
          // cursor that was presented, so it can never disagree.
          checkpoint: presented,
          events: batch.events,
          next_checkpoint: batch.next_checkpoint,
          gap: plan.gap,
        };
        return oversized(envelope);
      },
      { readOnly: true }
    );
    if ("refused" in outcome) {
      throw new EvidenceRefusalError(
        outcome.refused.code,
        outcome.refused.reason,
        outcome.refused.message,
        outcome.refused.contract
      );
    }
    return outcome.granted;
  }
}

/**
 * The 32 KiB envelope bound, applied to the batch that is EMITTED.
 *
 * Twenty content-free events cannot reach it today, and measuring it anyway is
 * what keeps the bound a property of this path rather than an arithmetic
 * argument: a limit or a field that grows later hits a refusal here instead of a
 * consumer's parser.
 */
function oversized(envelope: EvidenceInvalidationsResult): DrainOutcome {
  const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  if (bytes <= MAX_EVIDENCE_BYTES) return { granted: envelope };
  return {
    refused: {
      code: EVIDENCE_FAILURE.TOO_LARGE,
      reason: EVIDENCE_REFUSAL_REASON.ENVELOPE_TOO_LARGE,
      message:
        `the emitted invalidation batch is ${bytes} bytes, over the ` +
        `${MAX_EVIDENCE_BYTES} byte envelope`,
    },
  };
}