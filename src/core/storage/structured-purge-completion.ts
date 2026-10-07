/**
 * The all-owner purge completion record: ADR 0099 §2.1's four states, persisted
 * as rows and advanced by exactly one writer each.
 *
 * **The split that makes premature completion impossible.** ADR 0099 §2.4b names
 * the three clauses of the reconciler's guard, and each one is a fact about a
 * DIFFERENT writer's commit: the local delete's own `collected`, this owner's ack,
 * and the absence of an owner who has not acked. Put them in one row and a
 * transaction could set the single value that satisfies all three. Kept apart, a
 * purge transaction can only say "scheduled", an ack can only say "this owner
 * scrubbed", and only the reconciler may write `completed_at`.
 *
 * **Writer separation, and why it is a test rather than a review note.** ADR 0099
 * §2.4a requires `completed_at` to be set by exactly one statement so that "if a
 * new write path appears, there is no field for it to fill". A column on a shared
 * table IS a field a new path could fill, so the claim is enforced structurally
 * instead: `tests/storage/structured-purge-completion-contract.unit.test.ts` reads
 * this module's source and every sibling and fails if `completed_at` appears
 * anywhere else, or here twice as an update target. A second writer is a red test
 * before it is a bug.
 *
 * **The completion predicate is a predicate, not a flag.** Nothing computes a
 * boolean and stores it; the guarded `UPDATE` counts owner rows and either matches
 * exactly one row or none. A zero-row update is reported as `completed: false`, so
 * "nothing happened" and "it is done" cannot be confused by a caller — which is
 * also why ADR 0099 §2.4b can say that re-running the reconciler is the only way
 * forward from a partial state.
 *
 * **The configured-owner set is derived, not configured.** See
 * `readConfiguredOwners` for why `evidence_grants.consumer_id` is the whole
 * derivation and why no new configuration surface appears for it.
 *
 * **Two of the four states are written as client-level functions, not as methods.**
 * `schedulePurgeCompletion` is called from MP16's existing purge transaction and
 * `recordPayloadCollection` from MP15's delete transaction — each MUST commit in
 * the same transaction as the write it belongs with (ADR 0099 §2.1), so taking a
 * pool or opening a transaction here would break the atomicity the contract is
 * built on. `PgPurgeCompletionReconciler` is the one function that owns its
 * transaction, because a sweep has nothing to be atomic with.
 *
 * **PG-only, with no in-memory twin.** Every property here is a property of the
 * database: the guard is a join, the monotonicity is an `UPDATE … WHERE`, and a
 * `Map` twin could be made to agree with itself while proving nothing about either.
 * `structured-purge-pg.ts:38-41` and `evidence-read.ts:90-93` are the precedent.
 */
import { isBoundedConsumerId } from "./evidence-store.js";
import { scopedSafeNumber } from "./structured-scope-reads.js";
import {
  StructuredScopeError,
  structuredScopeError,
  type ScopeTransactionOwner,
} from "./structured-scope-types.js";

/**
 * The minimal client surface, satisfied by a transaction client and by a test
 * fake. Every statement here is a value-parameterised query, so nothing in this
 * module builds SQL from a caller-supplied string.
 */
export interface PurgeCompletionClient {
  query(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/** One scope's purge completion record, as stored. */
export interface PurgeCompletionRow {
  readonly scopeBinding: string;
  readonly purgeRevision: string;
  readonly collectionState: "scheduled" | "collected";
  readonly completed: boolean;
  readonly completedAt: string | null;
}

/**
 * The one scope purge revision this call reconciles.
 *
 * Exported so the refusal is provable without a database: a blank scope or
 * revision names no record, and every statement below is keyed on exactly these
 * two values.
 */
export interface PurgeCompletionKey {
  readonly scopeBinding: string;
  readonly purgeRevision: string;
}

/** What one reconciler pass decided. */
export interface PurgeCompletionVerdict extends PurgeCompletionRow {
  /**
   * Whether THIS pass performed the write.
   *
   * False for both "the guard found the record not ready" and "it was already
   * completed" — the two are reported by `completed` plus `completedAt`. They are
   * different facts and a caller that wants to distinguish them reads the row.
   */
  readonly applied: boolean;
  /** The owner ids the guard evaluated, in sorted order. */
  readonly evaluatedOwners: readonly string[];
}

/**
 * Read this scope's configured owners.
 *
 * **Why `evidence_grants.consumer_id` and not a configuration list.** ADR 0099
 * requires completion for "every configured owner of that revision", and the
 * evidence spec (`:254`, register §1b.3) already makes the backend record the
 * trusted consumer against each grant. The owners a scope has are therefore
 * already a fact in the store, so deriving the set adds no configuration surface
 * — and it keeps the N-owner case general BY CONSTRUCTION rather than by
 * convention: a hardcoded single owner would satisfy a one-consumer deployment
 * and silently satisfy nothing in a two-consumer one, which is the ADR 0099 §2.4b
 * all-owner join quietly reduced to a first-owner join. Register §1b.1a records
 * that cross-consumer refusal is only observable with N ≥ 2, so N is the case
 * that has to be the default shape.
 *
 * **Filtered through `isBoundedConsumerId`, the store's one predicate** (the same
 * one the grant store, `allocateInvalidationSeq` and the drain enforce). A blank
 * or over-long `consumer_id` is a row that predates the column or was written
 * around it; naming it here would create a pending completion for a stream nobody
 * can drain, so it is excluded from the owner set — which is what makes
 * `unpublishedRefs` in MP16's outcome a fact about an owner and not a contradiction
 * of it.
 *
 * **Re-read at every call rather than frozen once.** The purge transaction freezes
 * one owner row per owner; this reads the live set, so a consumer that gains a
 * grant in the scope afterwards is an owner of every open revision with no owner
 * row — and a missing owner row is not a completion. That is the conservative
 * direction on purpose; `plans/structured-corpus-mp17-completion-p3-i6.md` §6
 * records what it costs.
 */
export async function readConfiguredOwners(
  client: PurgeCompletionClient,
  scopeBinding: string
): Promise<readonly string[]> {
  const { rows } = await client.query(
    `SELECT DISTINCT consumer_id
       FROM evidence_grants
      WHERE scope_binding = $1`,
    [scopeBinding]
  );
  return rows
    .map((row) => String(row.consumer_id ?? ""))
    .filter(isBoundedConsumerId)
    .sort();
}

/**
 * Seed the revision's completion record and one owner row per configured owner.
 *
 * **Called inside MP16's purge transaction, and it must stay there.** ADR 0099
 * §2.1 makes `scheduled` true only when the invalidation events are durably
 * queued, in the same commit as the tombstone. A separate transaction here would
 * let a tombstone commit with no completion record, and the record would then
 * describe a purge that never announced anything.
 *
 * `coveredSeq` is the owner's own allocation watermark as of this transaction,
 * taken AFTER the events are emitted — the position through which this revision
 * has published everything it will publish for that owner, and therefore the
 * position an acknowledgement has to reach for `scrubbed` to be true. Reading it
 * before the emission would understate it and let an ack one event short mark the
 * revision scrubbed.
 *
 * An owner row is written for every configured owner, including one this purge
 * emitted nothing for: its `covered_seq` is then the position it had, so it is
 * scrubbed by any acknowledgement that reaches it and by no earlier one.
 *
 * **Idempotent, and the tombstone is the anchor that decides why.** Both inserts
 * are `DO NOTHING`, so a second call for the same revision changes nothing —
 * including `covered_seq`, which must NOT be re-frozen: re-running the purge
 * against a stream that has since advanced would otherwise widen every owner's
 * covered position and let an acknowledgement that never reached this revision's
 * events mark it scrubbed.
 *
 * So "was this purge already applied?" is answered in exactly one place — the
 * tombstone, which the purge transaction writes before this call and which makes
 * a retry return already-applied. Duplicating that judgement here would be a
 * second retry policy, and two policies disagree the first time a tombstone is
 * removed for retention while a completion record survives it. This function is
 * the narrower claim: the revision's record and its owner rows exist.
 */
export async function schedulePurgeCompletion(
  client: PurgeCompletionClient,
  input: {
    readonly scopeBinding: string;
    readonly purgeRevision: string;
    readonly consumerIds: readonly string[];
  }
): Promise<void> {
  await client.query(
    `INSERT INTO structured_purge_outcomes
       (scope_binding, purge_revision, collection_state)
     VALUES ($1, $2, 'scheduled')
     ON CONFLICT (scope_binding, purge_revision) DO NOTHING`,
    [input.scopeBinding, input.purgeRevision]
  );
  const owners = [...new Set(input.consumerIds)].filter(isBoundedConsumerId).sort();
  if (owners.length === 0) return;
  const { rows: watermarks } = await client.query(
    `SELECT consumer_id, last_allocated_seq
       FROM evidence_invalidation_cursors
      WHERE consumer_id = ANY($1::text[])`,
    [owners]
  );
  const allocated = new Map<string, number>();
  for (const row of watermarks) {
    allocated.set(
      String(row.consumer_id),
      scopedSafeNumber(row.last_allocated_seq, "invalidation last_allocated_seq")
    );
  }
  await client.query(
    `INSERT INTO structured_purge_ack_states
       (scope_binding, purge_revision, consumer_id, ack_state, covered_seq)
     SELECT $1, $2, owner.consumer_id, 'scheduled', owner.covered_seq
       FROM unnest($3::text[], $4::bigint[]) AS owner(consumer_id, covered_seq)
     ON CONFLICT (scope_binding, purge_revision, consumer_id) DO NOTHING`,
    [
      input.scopeBinding,
      input.purgeRevision,
      owners,
      // An owner with no cursor row cannot have been emitted for by this purge, so
      // its covered position is 0 and it is scrubbed by any acknowledgement at all.
      owners.map((consumerId) => allocated.get(consumerId) ?? 0),
    ]
  );
}

/**
 * Record that the backend's own payload is gone, for the revision MP15 is
 * collecting.
 *
 * **A client-level write on purpose.** ADR 0099 §2.1 makes `collected` true only
 * in the same commit as the payload removal, so this cannot own a transaction: it
 * has to be called from inside the delete transaction that removed the rows, or
 * the two facts could diverge in exactly the direction that matters — a record
 * claiming collection while the payload is still there.
 *
 * The guard is monotonic (`collected_at IS NULL`) so a second collector pass
 * cannot move the instant, and it deliberately does NOT touch `completed_at`:
 * ADR 0099 §2.4a's writer separation means this statement has no completion to
 * write even when every owner has already scrubbed.
 */
export async function recordPayloadCollection(
  client: PurgeCompletionClient,
  key: PurgeCompletionKey
): Promise<boolean> {
  const { rows } = await client.query(
    `UPDATE structured_purge_outcomes
        SET collection_state = 'collected', collected_at = now()
      WHERE scope_binding = $1 AND purge_revision = $2
        AND collected_at IS NULL
      RETURNING collected_at`,
    [key.scopeBinding, key.purgeRevision]
  );
  return rows.length === 1;
}

/**
 * Read one completion record as the reconciler reports it.
 *
 * A revision with no record is reported as a refusal rather than as a
 * `scheduled` record: "no record" means no purge transaction ever scheduled this
 * revision, and answering it with a default would make a caller that mints a
 * revision string able to ask about a purge that did not happen.
 */
export async function readPurgeCompletion(
  client: PurgeCompletionClient,
  key: PurgeCompletionKey
): Promise<PurgeCompletionRow | null> {
  const { rows } = await client.query(
    `SELECT collection_state, completed_at
       FROM structured_purge_outcomes
      WHERE scope_binding = $1 AND purge_revision = $2`,
    [key.scopeBinding, key.purgeRevision]
  );
  const row = rows[0];
  if (row === undefined) return null;
  const completedAt = row.completed_at;
  return {
    scopeBinding: key.scopeBinding,
    purgeRevision: key.purgeRevision,
    collectionState: String(row.collection_state) as "scheduled" | "collected",
    completed: completedAt !== null && completedAt !== undefined,
    completedAt:
      completedAt === null || completedAt === undefined
        ? null
        : new Date(String(completedAt)).toISOString(),
  };
}

/**
 * Record that this owner's scrub has covered everything a revision published for
 * it, for every revision of the scope that was still waiting on this owner.
 *
 * **The two guards are the whole of "ack_state moves forward only" at the
 * statement.** `ack_state = 'scheduled'` refuses a row that is already scrubbed,
 * so a repeat acknowledgement cannot rewrite its position or its instant; and
 * `$coveredSeq >= covered_seq` refuses a position that has not reached the point
 * through which that revision published for this consumer, which is ADR 0099
 * §2.1's "the acknowledged checkpoint covers a contiguous batch whose local scrub
 * committed on the consumer" as a comparison rather than as an intention.
 *
 * **Nothing else writes this column.** There is no timeout arm, no retry-count
 * arm, no heartbeat and no "no complaint has arrived" arm, which ADR 0099 §2.3
 * forbids in terms; the absence of those four is what makes an offline owner
 * readable as offline instead of as scrubbed.
 *
 * **Zero rows is not a failure.** It means this revision has no owner row for this
 * consumer — it was purged before this table existed, or the consumer was not one
 * of its owners — and the acknowledgement is still true about the STREAM, which is
 * what the action promises. The reverse question is the reconciler's, and its
 * guard treats the missing row as blocking rather than as satisfied.
 *
 * A client-level write: it runs inside the acknowledgement's transaction, so a
 * scrub fact and the position it rests on commit or fail together.
 */
export async function recordOwnerScrub(
  client: PurgeCompletionClient,
  input: {
    readonly scopeBinding: string;
    readonly consumerId: string;
    /** The position this acknowledgement covers. */
    readonly coveredSeq: number;
    /** The acknowledged checkpoint, retained as non-content audit. */
    readonly checkpoint: string;
  }
): Promise<number> {
  const { rows } = await client.query(
    `UPDATE structured_purge_ack_states
        SET ack_state = 'scrubbed', acked_checkpoint = $4, scrubbed_at = now()
      WHERE scope_binding = $1
        AND consumer_id = $2
        AND ack_state = 'scheduled'
        AND $3::bigint >= covered_seq
      RETURNING purge_revision`,
    [
      input.scopeBinding,
      input.consumerId,
      input.coveredSeq,
      input.checkpoint,
    ]
  );
  return rows.length;
}

/**
 * The guarded completion UPDATE — the ONLY statement in this repository that
 * sets `completed_at`.
 *
 * Each conjunct is one of ADR 0099 §2.4b's three clauses, plus the two absences
 * that make the join honest:
 *
 *  - `completed_at IS NULL` — re-running the reconciler changes nothing, so a
 *    second pass cannot restamp the instant.
 *  - `collection_state = 'collected'` — the local delete transaction's own fact.
 *  - `NOT EXISTS (configured owner without a scrubbed row)` — the all-owner join,
 *    written as the NEGATIVE so that a scope with no configured owner completes
 *    vacuously, which is correct: with no owners there are no copied live
 *    snapshot payloads left unacknowledged.
 *  - `ack_state = 'scrubbed'` inside the inner join, never a bare row presence: a
 *    MISSING owner row and an owner row still `scheduled` are the same failure
 *    here, which is the property ADR 0099 §2.4b asks for and the one a bare
 *    `EXISTS` would lose.
 *
 * A zero-row result is not a completion and is not an error either; the
 * reconciler reports it as `completed: false` with the record it actually holds.
 */
const COMPLETE_PURGE_SQL = `
  UPDATE structured_purge_outcomes o
     SET completed_at = now()
   WHERE o.scope_binding = $1
     AND o.purge_revision = $2
     AND o.completed_at IS NULL
     AND o.collection_state = 'collected'
     AND NOT EXISTS (
       SELECT 1
         FROM unnest($3::text[]) AS configured(consumer_id)
        WHERE NOT EXISTS (
          SELECT 1
            FROM structured_purge_ack_states a
           WHERE a.scope_binding = o.scope_binding
             AND a.purge_revision = o.purge_revision
             AND a.consumer_id = configured.consumer_id
             AND a.ack_state = 'scrubbed'
        )
     )
  RETURNING o.completed_at`;

/**
 * Reconcile one purge revision, in one transaction.
 *
 * PG-only and structurally so: it REQUIRES a `ScopeTransactionOwner`, which the
 * memory lane does not supply, so it cannot be composed over a backend whose
 * completion record is a `Map`. The reconciler reads the owner set, attempts the
 * one guarded write and reads the record back inside ONE transaction, because a
 * verdict assembled from two snapshots could describe a state that never held.
 *
 * It takes no consumer identity, because it makes no claim on behalf of one: it
 * joins whatever the store says about each owner. `PgStructuredPurgeStore` is the
 * construction precedent — same transaction vocabulary, no second one here.
 */
export class PgPurgeCompletionReconciler {
  constructor(private readonly scope: ScopeTransactionOwner) {}

  async reconcile(key: PurgeCompletionKey): Promise<PurgeCompletionVerdict> {
    const scopeBinding = requireKeyToken(key?.scopeBinding, "scopeBinding");
    const purgeRevision = requireKeyToken(key?.purgeRevision, "purgeRevision");
    return this.scope.runTransaction(
      async (client) => {
        const owners = await readConfiguredOwners(client, scopeBinding);
        const written = await client.query(COMPLETE_PURGE_SQL, [
          scopeBinding,
          purgeRevision,
          owners,
        ]);
        const row = await readPurgeCompletion(client, {
          scopeBinding,
          purgeRevision,
        });
        if (row === null) {
          // EXIT: no record means no purge transaction scheduled this revision, so
          // there is nothing to complete and nothing to report as pending. Answering
          // with a synthetic `scheduled` would let a caller invent a revision and
          // read back a state no transaction ever wrote.
          throw new StructuredScopeError(
            "maintenance_status_unavailable",
            `no purge completion record exists for ${purgeRevision}`
          );
        }
        return {
          ...row,
          applied: written.rows.length === 1,
          evaluatedOwners: owners,
        };
      },
      { fail: structuredScopeError }
    );
  }
}

/**
 * One refusal rule for the revision key.
 *
 * Reused rather than restated, for the same reason `structured-purge-pg.ts:154-161`
 * reuses `requirePublicationString`: two copies of "a key must be a non-blank
 * string" is two rules one of them will forget, and this is the key every
 * statement below is filtered on.
 */
function requireKeyToken(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new StructuredScopeError(
      "invalid_input",
      `${field} must be a non-blank string`
    );
  }
  return value;
}