/**
 * The `ack` action: register §1.5's acknowledgement, in its own write
 * transaction, against ADR 0099 §2.1's `scrubbed` and ADR 0097 §4.5's
 * re-verification.
 *
 * **Why this is a sibling of the drain and not a method on it.**
 * `evidence-invalidation-read.ts` states its own boundary — it does not
 * acknowledge, and the write belongs in its own transaction — and a
 * `REPEATABLE READ READ ONLY` transaction cannot hold a write lock at all. Folding
 * this in would mean either two transactions behind one method name or a read-only
 * unit of work that writes, and both are the failure the split exists to prevent.
 *
 * **§1.5 is a re-verification, and re-verification means four checks in one
 * transaction.** ADR 0097 §4.5 asks for three: the checkpoint was server-minted
 * for this consumer, every event it covers was in fact returned to this consumer,
 * and the advance is contiguous. The fourth is the identity, re-checked INSIDE the
 * transaction — the same placement `PgMaintenanceStatusStorage` uses, because an
 * authorization revoked between minting and writing must not have its advance
 * recorded. All four run before any write, so a refusal leaves the cursor exactly
 * as it was; a partial ack is a refusal, not a partial write.
 *
 * **"Every event it covers was in fact returned" is checked against the stream,
 * not remembered.** A checkpoint is minted only by the drain, over the last `seq`
 * of a page it actually handed over, so the fact that an event was delivered is
 * established by where that consumer's retained window begins: if the earliest
 * row still held sits at or below the stored position, then every event above it
 * that survives was on the page, and the ones that do not survive were collected
 * under the retention clause rather than skipped. A window that begins ABOVE the
 * stored position has lost its own beginning, which no later acknowledgement can
 * repair — so it is refused. See `planAckAdvance` for why a row count cannot
 * stand in for that test.
 *
 * **Monotonicity is enforced twice, deliberately.** `planAckAdvance` decides it and
 * the guarded `UPDATE` re-states it as `acked_seq < $`, so a plan that were ever
 * wrong could not move the stored position backwards; and the owner-row update is
 * guarded on `ack_state = 'scheduled'`, which is the schema's closed vocabulary
 * turned into a WHERE clause. Nothing here writes `ack_state` from a timeout, a
 * retry count, a heartbeat or the absence of a complaint — ADR 0099 §2.3 forbids
 * all four, and the only statement that sets it is the one below.
 *
 * **A position already acknowledged is idempotent, not refused.** fin's two-phase
 * split (ADR 0097 §2.4) means a crash between its scrub commit and recording its
 * own acknowledgement re-presents a token the backend already accepted. Refusing
 * that would make recovery impossible and accepting anything higher would skip
 * events, so the equal case is the only idempotent one and everything strictly
 * lower is a refusal.
 */
import {
  MAX_CONSUMER_ID_CHARS,
  isBoundedConsumerId,
} from "./evidence-store.js";
import { GraphragError } from "../errors.js";
import { decodeInvalidationCheckpoint, type InvalidationCheckpointKey } from "./evidence-invalidation-checkpoint.js";
import {
  EVIDENCE_ACTION,
  EVIDENCE_REFUSAL_REASON,
  EvidenceRefusalError,
  EVIDENCE_ENVELOPE_VERSION,
  EVIDENCE_RESULT_SCHEMA,
  type EvidenceAckResult,
  type EvidenceAckRequest,
  type EvidenceRefusal,
} from "./evidence-read.js";
import {
  readFirstRetainedSeq,
  readInvalidationCursor,
  type EvidenceInvalidationCursor,
} from "./invalidation-outbox.js";
import { recordOwnerScrub } from "./structured-purge-completion.js";
import { assertCurrentAuthorization } from "./structured-status-reads.js";
import {
  scopeAuthorityOf,
  type AuthorizedScopeContext,
  type AuthorizedScopeUnitOfWork,
  type ScopeTransactionClient,
  type ScopeTransactionOwner,
} from "./structured-scope-types.js";

/**
 * Why an acknowledgement was refused.
 *
 * A closed set, because a caller branches on it: fin must be able to tell "you
 * presented a position that was never yours" from "you presented a position this
 * stream already passed", and both from a genuine transport failure. The tokens
 * live in `EVIDENCE_REFUSAL_REASON` rather than beside this module, because a
 * reason a caller switches on and cannot name is not a closed set — it is a cast.
 */
export type AckRefusalReason =
  | typeof EVIDENCE_REFUSAL_REASON.ACK_CHECKPOINT_NOT_MINTED_HERE
  | typeof EVIDENCE_REFUSAL_REASON.ACK_CHECKPOINT_NEVER_ISSUED
  | typeof EVIDENCE_REFUSAL_REASON.ACK_WOULD_MOVE_BACKWARDS
  | typeof EVIDENCE_REFUSAL_REASON.ACK_RANGE_NOT_CONTIGUOUS;

/** The stored facts one acknowledgement is decided from. */
export interface AckPlanInput {
  /** The position the presented checkpoint covers. */
  readonly coveredSeq: number;
  /** This consumer's stored cursor, or `null` before anything was allocated. */
  readonly cursor: EvidenceInvalidationCursor | null;
  /**
   * The lowest `seq` this consumer still retains, or `null` when it retains none.
   *
   * The delivery fact, read from the outbox rather than remembered.
   */
  readonly firstRetainedSeq: number | null;
}

/**
 * The three outcomes of one acknowledgement.
 *
 * `applied` is false for the idempotent arm and true for the advance; the two are
 * different facts and the caller reports them differently — fin's recovery path
 * needs to know whether its own acknowledgement landed, not just that the
 * position is where it asked to be.
 */
export type AckPlan =
  | { readonly state: "advance"; readonly coveredSeq: number }
  | { readonly state: "already_acknowledged"; readonly coveredSeq: number }
  | { readonly state: "refused"; readonly reason: AckRefusalReason; readonly detail: string };

/**
 * Decide whether an acknowledgement may move this consumer's stored position.
 *
 * The order of the four checks is the order of how wrong each fact would be, and
 * each refusal names one thing rather than a conjunction:
 *
 *  1. **Never issued.** A position above `last_allocated_seq` was never minted,
 *     whatever its signature says — the signature proves this deployment wrote it,
 *     not that it wrote it for a position that exists.
 *  2. **Backwards.** Strictly below the stored position. Checked before the
 *     idempotent arm so that "equal" is the only position that is not a refusal.
 *  3. **Already acknowledged.** Equal. The recovery path of ADR 0097 §2.4.
 *  4. **Contiguity.** The range must still contain its own beginning.
 *
 * **Why contiguity is the floor and not a row count.** Comparing the number of
 * retained rows against the length of the range looks equivalent while nothing
 * deletes rows, and stops being equivalent the moment the retention sweep does its
 * job: `grantIsFinished` collects an event the consumer may never have seen, and
 * one deletion inside an un-acked range makes the equality false for every later
 * acknowledgement of that consumer — the offline-owner case, the one the retention
 * clause exists for. What the count cannot distinguish is a position lost to a
 * collection from one lost to anything else, and after a sweep there is no row left
 * that could. The floor does distinguish them, by asking only whether the range
 * still begins where the consumer left off: when it does, every surviving event in
 * the range was on the page this checkpoint was minted over, and every position
 * that is not there was judged collectable by the sweep that removed it, so
 * advancing loses no event. When the floor sits above the stored position, the
 * beginning of the range is gone and the backend cannot say by what, so the
 * acknowledgement is refused rather than assumed — which is the same verdict
 * `planInvalidationDrain` reaches for the same rows, and the loss is permanent
 * either way.
 *
 * A consumer with no cursor row is treated as position 0 with a watermark of 0:
 * there is nothing stored to contradict, and a checkpoint covering position 0 is
 * the one a drain of an empty stream mints.
 */
export function planAckAdvance(input: AckPlanInput): AckPlan {
  const ackedSeq = input.cursor?.acked_seq ?? 0;
  const lastAllocatedSeq = input.cursor?.last_allocated_seq ?? 0;
  if (input.coveredSeq > lastAllocatedSeq) {
    return {
      state: "refused",
      reason: EVIDENCE_REFUSAL_REASON.ACK_CHECKPOINT_NEVER_ISSUED,
      detail:
        `checkpoint covers ${input.coveredSeq}, above the highest position this ` +
        `stream ever handed out (${lastAllocatedSeq})`,
    };
  }
  if (input.coveredSeq < ackedSeq) {
    return {
      state: "refused",
      reason: EVIDENCE_REFUSAL_REASON.ACK_WOULD_MOVE_BACKWARDS,
      detail:
        `checkpoint covers ${input.coveredSeq}, below the acknowledged ` +
        `${ackedSeq}; an acknowledgement moves forward only`,
    };
  }
  if (input.coveredSeq === ackedSeq) {
    return { state: "already_acknowledged", coveredSeq: input.coveredSeq };
  }
  if (input.firstRetainedSeq !== null && input.firstRetainedSeq > ackedSeq + 1) {
    return {
      state: "refused",
      reason: EVIDENCE_REFUSAL_REASON.ACK_RANGE_NOT_CONTIGUOUS,
      detail:
        `the covered range ${ackedSeq + 1}..${input.coveredSeq} no longer begins ` +
        `where this consumer left off — its earliest retained event is ` +
        `${input.firstRetainedSeq} — so the batch cannot be shown to have been ` +
        "one contiguous handover",
    };
  }
  return { state: "advance", coveredSeq: input.coveredSeq };
}

/**
 * Advance the stored position, guarded so it can only ever increase.
 *
 * The two conditions are the statement-level half of monotonicity: the row must
 * exist for this stream AND its stored position must be strictly below the one
 * being written. `acked_at` moves with it, because a cursor whose position is
 * current but whose timestamp is stale would misreport when the acknowledgement
 * happened, and the reconciler's audit depends on that being the same instant.
 *
 * A zero-row result here is a store fault rather than a caller mistake: the plan
 * was decided from rows read in this same transaction, so the row cannot have
 * moved underneath it, and reporting success would leave the caller believing an
 * acknowledgement was recorded when it was not.
 */
async function writeAcknowledgedPosition(
  client: ScopeTransactionClient,
  consumerId: string,
  checkpoint: string,
  coveredSeq: number
): Promise<void> {
  const { rows } = await client.query(
    `UPDATE evidence_invalidation_cursors
        SET acked_checkpoint = $2, acked_seq = $3, acked_at = now()
      WHERE consumer_id = $1 AND acked_seq < $3
      RETURNING acked_seq`,
    [consumerId, checkpoint, coveredSeq]
  );
  if (rows.length !== 1) {
    throw new GraphragError(
      `invalidation ack: the cursor for "${consumerId}" did not advance to ` +
        `${coveredSeq}`,
      "STORAGE_ERROR"
    );
  }
}

type AckOutcome =
  | { readonly granted: EvidenceAckResult }
  | { readonly refused: EvidenceRefusal };

/**
 * The authorized `ack` writer.
 *
 * PG-only and structurally so, for the same reason the drain reader is: the
 * constructor demands the transaction-owning half of the seam, which the memory
 * lane does not supply. An acknowledgement that cannot be atomic with its own
 * re-verification is the one failure mode this contract cannot tolerate, so there
 * is nothing here worth faking.
 */
export class PgEvidenceInvalidationAckStore {
  constructor(
    private readonly scope: AuthorizedScopeUnitOfWork & ScopeTransactionOwner,
    private readonly key: InvalidationCheckpointKey
  ) {}

  /**
   * Acknowledge one checkpoint for one consumer.
   *
   * `consumerId` is the TRANSPORT's stream identity, never a request field — the
   * same rule the drain follows and for the same reason: a caller that named its
   * own stream would be asserting an identity on a channel where an identity is a
   * refusal.
   */
  async acknowledgeInvalidations(
    context: AuthorizedScopeContext,
    consumerId: string,
    request: EvidenceAckRequest
  ): Promise<EvidenceAckResult> {
    if (scopeAuthorityOf(context) !== this.scope) {
      throw new EvidenceRefusalError(
        "access_denied",
        EVIDENCE_REFUSAL_REASON.CONTEXT_NOT_MINTED,
        "the authorized scope context was not minted by this composition"
      );
    }
    if (!isBoundedConsumerId(consumerId)) {
      throw new EvidenceRefusalError(
        "access_denied",
        EVIDENCE_REFUSAL_REASON.TRUSTED_BINDING_UNRESOLVED,
        `the transport's invalidation consumer must be a non-blank label of at ` +
          `most ${MAX_CONSUMER_ID_CHARS} characters, and is never defaulted`
      );
    }
    const outcome = await this.scope.runTransaction(
      (client) =>
        writeAcknowledgement(client, {
          key: this.key,
          context,
          consumerId,
          checkpoint: request.checkpoint,
        }),
      // The default fail mapping on purpose, same as the drain reader: it passes a
      // `StructuredScopeError` through unchanged (so `access_denied` from the
      // identity re-check survives) and re-types anything else as
      // `backend_unavailable` with its message retained, which is what a store
      // fault is. Refusals never travel as thrown errors — see `refused`.
    );
    if ("refused" in outcome) {
      throw new EvidenceRefusalError(
        outcome.refused.code,
        outcome.refused.reason,
        outcome.refused.message
      );
    }
    return outcome.granted;
  }
}

/**
 * §1.5's re-verification and its two writes, inside one transaction.
 *
 * Split out of the method above so the two halves of the contract are separately
 * readable: everything that can REFUSE a caller is here, in the order the checks
 * are wrong, and the method above is only the transport-identity gate and the
 * refusal-to-exception conversion.
 *
 * Every statement runs before any write, so a refusal leaves the cursor exactly as
 * it was — a partial acknowledgement is a refusal, never a partial write.
 */
async function writeAcknowledgement(
  client: ScopeTransactionClient,
  input: {
    readonly key: InvalidationCheckpointKey;
    readonly context: AuthorizedScopeContext;
    readonly consumerId: string;
    readonly checkpoint: string;
  }
): Promise<AckOutcome> {
  const { key, context, consumerId, checkpoint } = input;
  // INSIDE the transaction, before any row of the stream is read: an identity
  // revoked between minting and acknowledging must not be able to move this
  // consumer's stored position.
  await assertCurrentAuthorization(client, context);
  // Decoding WITH this consumer's id is what makes "server-minted for this
  // consumer" one decision in the codec rather than a comparison a call site could
  // skip.
  const decoded = decodeInvalidationCheckpoint(checkpoint, consumerId, key);
  if (decoded === null) {
    return refused(
      EVIDENCE_REFUSAL_REASON.ACK_CHECKPOINT_NOT_MINTED_HERE,
      "the presented checkpoint did not authenticate for this consumer, " +
        "so it was either forged, damaged, or minted for another stream"
    );
  }
  const cursor = await readInvalidationCursor(client, consumerId);
  const ackedSeq = cursor?.acked_seq ?? 0;
  const plan = planAckAdvance({
    coveredSeq: decoded.s,
    cursor,
    firstRetainedSeq:
      decoded.s > ackedSeq ? await readFirstRetainedSeq(client, consumerId) : null,
  });
  if (plan.state === "refused") {
    return refused(plan.reason, plan.detail);
  }
  if (plan.state === "advance") {
    await writeAcknowledgedPosition(client, consumerId, checkpoint, plan.coveredSeq);
  }
  // ADR 0099 §2.1's `scrubbed`, on BOTH non-refused arms and for every revision of
  // this scope still waiting on this owner, and only for those: an
  // acknowledgement cannot claim a revision whose events it had not reached,
  // because each owner row carries the position through which that revision
  // published for this consumer. Running it on the idempotent arm is what closes a
  // first acknowledgement of position 0 — the one a drain of an empty stream mints
  // — which must still scrub a revision whose covered position for this owner is
  // 0. The statement is guarded, so re-running it costs a scan and changes
  // nothing.
  await recordOwnerScrub(client, {
    scopeBinding: context.ownerScopeBinding,
    consumerId,
    coveredSeq: plan.coveredSeq,
    checkpoint,
  });
  return {
    granted: {
      schema: EVIDENCE_RESULT_SCHEMA,
      schema_version: EVIDENCE_ENVELOPE_VERSION,
      action: EVIDENCE_ACTION.ACK,
      // The STORE's acknowledged position, not the presented one echoed back.
      // They are the same token whenever they agree — same key, same consumer, same
      // position — but when the store has a recorded checkpoint this reports what
      // the backend holds, which is the fact fin's recovery path needs. The store's
      // value is empty only for a cursor that has never acknowledged anything,
      // where the presented token is itself server-minted and already the honest
      // answer.
      checkpoint:
        cursor === null || cursor.acked_checkpoint === ""
          ? checkpoint
          : cursor.acked_checkpoint,
    },
  };
}

/**
 * One refusal, in the Evidence channel's vocabulary.
 *
 * `malformed_evidence_contract` rather than a scope failure code because every one
 * of these is a CONTRACT fact about the request — a position this store never
 * issued, or never issued to this consumer — and `EVIDENCE_FAILURE` is the set for
 * contract facts (`evidence-read.ts:156-158`). Putting it in the scope set would
 * make fin's typed evidence failure arrive as a transport one.
 */
function refused(reason: AckRefusalReason, message: string): AckOutcome {
  return {
    refused: {
      code: "malformed_evidence_contract",
      reason,
      message,
    },
  };
}