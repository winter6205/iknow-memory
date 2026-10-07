/**
 * MP14's PostgreSQL mark store: the three storage operations behind the pure
 * decisions in `maintenance/collection-mark.ts`, each composed through the shared
 * authorized-scope authority so a mark, its obligations stamp and the scope's own
 * maintenance revision move at a single commit.
 *
 * The asymmetry this store exists to close: `pgvector-backend.ts` stops
 * obligations through a pool-scoped `wrapPgRead`, which commits on its own. A mark
 * that wrote its row and then called that would leave obligations running against a
 * payload already promised to be deleted — and a reactivation that resumed them
 * would fail the same way, in the other direction. Composing through
 * `withAuthorizedScope` is what makes the mark and the stamp one transaction, which
 * is also why every refusal below returns a typed value from inside the callback
 * rather than throwing: a throw would roll back a transaction the caller may have
 * already been told succeeded.
 *
 * Store-derived facts are read here and never accepted from the caller. A caller
 * that says "obligations are not stopped" or "the revision is still N" would
 * otherwise be able to talk the store into a reactivation the database already
 * forbids; `expectedLifecycleRevision` is the one revision the caller owns, because
 * a lost update is only visible against what the caller believed.
 */
import { MaintenanceStoreError } from "../maintenance/store-error.js";
import {
  planCollectionMark,
  planCollectionReactivation,
  planStaleMarkCancellation,
  recheckCollectionMark,
} from "../maintenance/collection-mark.js";
import type {
  CollectionMark,
  CollectionMarkCancelReason,
  CollectionMarkCancellationOutcome,
  CollectionMarkIdentity,
  CollectionMarkOutcome,
  CollectionMarkRecheck,
  CollectionReactivateOutcome,
} from "../maintenance/collection-mark-types.js";
import type {
  CollectionEligibility,
  CollectionPayloadClass,
} from "../maintenance/collector-types.js";
import type { MaintenanceWorkFailureCode } from "../maintenance/types.js";
import { stampSourceVersionRow } from "./evidence-pg.js";
import type { EvidenceClient } from "./evidence-store.js";
import type {
  AuthorizedScopeContext,
  AuthorizedScopeRunOptions,
  AuthorizedScopeWork,
} from "./structured-scope-types.js";

/** The scope authority this store composes through; the UOW satisfies it as-is. */
export interface CollectionMarkAuthority {
  withAuthorizedScope<R>(
    context: AuthorizedScopeContext,
    callback: (work: AuthorizedScopeWork) => Promise<R>,
    options?: AuthorizedScopeRunOptions
  ): Promise<R>;
}

/** One mark, as the caller knows it. Everything else is read under the transaction. */
export interface CollectionMarkCandidateInput {
  readonly context: AuthorizedScopeContext;
  readonly identity: CollectionMarkIdentity;
  readonly scopeBinding: string;
  /** Required for the four source-bound classes and refused for the other two. */
  readonly sourceVersionId: string | null;
  /** MP13's decided candidate; its `physicalPurgeNotBefore` becomes the deadline. */
  readonly eligibility: CollectionEligibility;
}

/** One reactivation, as the caller knows it. */
export interface CollectionReactivateCandidateInput {
  readonly context: AuthorizedScopeContext;
  readonly identity: CollectionMarkIdentity;
  readonly scopeBinding: string;
  readonly sourceVersionId: string | null;
  /** The revision the caller believes it is cancelling against. */
  readonly expectedLifecycleRevision: string;
}

/**
 * A stale recheck asking for the cancellation it reported.
 *
 * Carries the revision the recheck observed, so the cancellation is fenced against
 * the same scope state the verdict was computed from — otherwise a mark could be
 * withdrawn for staleness observed against a revision that has since moved again.
 */
export interface CollectionStaleCancellationInput extends CollectionMarkIdentity {
  readonly context: AuthorizedScopeContext;
  readonly scopeBinding: string;
  readonly observedLifecycleRevision: string;
}

/** One read, as the caller knows it. */
export interface CollectionMarkReadInput {
  readonly context: AuthorizedScopeContext;
  readonly identity: CollectionMarkIdentity;
  readonly scopeBinding: string;
}

/**
 * A read is a value, not a throw: a payload that was never marked is an ordinary
 * answer here, and MP14's reactivation reads the same row and treats its absence as
 * a refusal instead. `recheck` is present exactly when the mark is in the `marked`
 * state — a cancelled mark has no live recheck, which is the decision's own answer
 * rather than this store's.
 */
export type CollectionMarkReadOutcome =
  | { readonly found: false }
  | {
      readonly refused: true;
      readonly code: MaintenanceWorkFailureCode;
      readonly detail: string;
    }
  | ({ readonly found: true; readonly mark: CollectionMark } &
      (
        | { readonly recheck: CollectionMarkRecheck }
        | {
            readonly recheckRefusal: {
              readonly code: MaintenanceWorkFailureCode;
              readonly detail: string;
            };
          }
      ));

interface MarkRow {
  readonly payload_class: string;
  readonly payload_ref: string;
  readonly scope_binding: string;
  readonly source_version_id: string | null;
  readonly expected_lifecycle_revision: string;
  readonly deadline_at: Date | string;
  readonly marked_at: Date | string;
  readonly state: string;
  readonly cancelled_at: Date | string | null;
  readonly cancelled_reason: string | null;
}

interface SourceVersionFacts {
  readonly exists: boolean;
  readonly payloadCollected: boolean;
  readonly obligationsStopped: boolean;
}

export class PgCollectionMarkStore {
  constructor(private readonly authority: CollectionMarkAuthority) {}

  /**
   * Persist one mark. The row, the obligations stamp and the maintenance revision
   * bump are one transaction, so a mark is never visible without the obligations it
   * stopped being stopped.
   */
  async markCollectionCandidate(
    input: CollectionMarkCandidateInput
  ): Promise<CollectionMarkOutcome> {
    return this.authority.withAuthorizedScope(input.context, async (work) => {
      const owned = requireOwnedScope(input.context, input.scopeBinding);
      if (owned !== null) return owned;
      const now = await databaseNow(work.client);
      const lifecycleRevision = await commitRevision(work.client, input.scopeBinding);
      const outcome = planCollectionMark(
        {
          ...input.identity,
          scopeBinding: input.scopeBinding,
          sourceVersionId: input.sourceVersionId,
          eligibility: input.eligibility,
          lifecycleRevision,
        },
        now
      );
      if (outcome.refused) return outcome;

      if (outcome.plan.stopsObligations) {
        // Refuse before the first write, never after: a refusal returned once the
        // row is in would commit that row, and a stamp that cannot land has to
        // leave no mark behind.
        const facts = await readSourceVersionFacts(
          work.client,
          input.sourceVersionId
        );
        const unbound = refuseIfUnstammable(facts, input.sourceVersionId);
        if (unbound !== null) return unbound;
      }

      // A payload that already carries a mark row is refused, not overwritten and
      // not left to collide on the primary key. Which of those two it is used to do
      // is the caller's decision, and both lanes must give the same answer: a bare
      // INSERT raised an untyped unique_violation here while the memory lane
      // silently replaced the row.
      const clash = await refuseIfAlreadyMarked(work.client, outcome.plan.mark);
      if (clash !== null) return clash;

      await work.client.query(
        `INSERT INTO structured_collection_marks
           (payload_class, payload_ref, scope_binding, source_version_id,
            expected_lifecycle_revision, deadline_at, marked_at, state)
         VALUES ($1, $2, $3, $4, $5::bigint, $6::timestamptz, $7::timestamptz, $8)`,
        [
          outcome.plan.mark.payloadClass,
          outcome.plan.mark.payloadRef,
          outcome.plan.mark.scopeBinding,
          outcome.plan.mark.sourceVersionId,
          outcome.plan.mark.expectedLifecycleRevision,
          outcome.plan.mark.deadlineAt,
          outcome.plan.mark.markedAt,
          outcome.plan.mark.state,
        ]
      );

      if (outcome.plan.stopsObligations) {
        // STAMP_SQL's closed map, reused through its client-scoped executor: the
        // pool-scoped mutator cannot join this transaction, and the plan states
        // which effect to apply so this lane never re-derives the source-bound set.
        await stampSourceVersionRow(
          work.client,
          "obligations_stopped_at",
          String(input.sourceVersionId),
          now.toISOString()
        );
      }

      work.bumpRevisions({ read: false, maintenance: true });
      return outcome;
    });
  }

  /**
   * Cancel one mark and resume whatever it had stopped. Returns the decision
   * unchanged on refusal, having written nothing.
   */
  async reactivateCollectionCandidate(
    input: CollectionReactivateCandidateInput
  ): Promise<CollectionReactivateOutcome> {
    return this.authority.withAuthorizedScope(input.context, async (work) => {
      const owned = requireOwnedScope(input.context, input.scopeBinding);
      if (owned !== null) return owned;
      const now = await databaseNow(work.client);
      const observedLifecycleRevision = await observedRevision(
        work.client,
        input.scopeBinding
      );
      const existing = await readMarkRow(
        work.client,
        input.identity,
        /* forUpdate */ true
      );
      if (existing === null) {
        return refusal(
          "input_stale",
          `payload ${input.identity.payloadRef} has no collection mark to reactivate`
        );
      }

      const facts = await readMarkSourceFacts(work.client, input.sourceVersionId);
      const unbound = refuseIfUnstammable(facts, input.sourceVersionId);
      if (unbound !== null) return unbound;

      const outcome = planCollectionReactivation(
        {
          ...input.identity,
          scopeBinding: input.scopeBinding,
          sourceVersionId: input.sourceVersionId,
          payloadCollected: facts.payloadCollected,
          obligationsStopped: facts.obligationsStopped,
          expectedLifecycleRevision: input.expectedLifecycleRevision,
          observedLifecycleRevision,
        },
        now
      );
      if (outcome.refused) return outcome;

      const withdrew = await cancelMarkRow(
        work.client,
        input.identity,
        outcome.plan.cancelledAt,
        outcome.plan.reason
      );
      const empty = refuseIfNotWithdrawn(withdrew, input.identity.payloadRef);
      if (empty !== null) return empty;

      if (outcome.plan.resumedObligations && input.sourceVersionId !== null) {
        // The one effect with no STAMP_SQL entry: that map is closed over SET stamps
        // only, and resuming has to move the stamp back to NULL or the next grant
        // read would keep refusing a payload that is back in service.
        await work.client.query(
          `UPDATE source_versions SET obligations_stopped_at = NULL WHERE source_version_id = $1`,
          [input.sourceVersionId]
        );
      }

      work.bumpRevisions({ read: false, maintenance: true });
      return outcome;
    });
  }

  /**
   * Record the cancellation a stale recheck demands (spec:307).
   *
   * Separate from `reactivateCollectionCandidate` on purpose: a reactivation is a
   * caller asking to use the payload again, while this is the authority withdrawing
   * its own mark because the scope moved. They record different reasons, so MP15 can
   * tell a deliberate undo from a recheck having run — and a stale mark that was
   * reported but never cancelled would still be sitting here for the next scan to
   * find.
   */
  async cancelStaleCollectionMark(
    input: CollectionStaleCancellationInput
  ): Promise<CollectionMarkCancellationOutcome> {
    return this.authority.withAuthorizedScope(input.context, async (work) => {
      const owned = requireOwnedScope(input.context, input.scopeBinding);
      if (owned !== null) return owned;
      const now = await databaseNow(work.client);
      const planned = planStaleMarkCancellation(input, now);
      if (planned.refused) return planned;
      const observed = await observedRevision(work.client, input.scopeBinding);
      if (observed !== input.observedLifecycleRevision) {
        return {
          refused: true,
          code: "input_stale",
          detail: `scope revision moved from ${input.observedLifecycleRevision} to ${observed}`,
        };
      }
      const withdrew = await cancelMarkRow(
        work.client,
        input,
        planned.cancellation.cancelledAt,
        planned.cancellation.reason
      );
      const empty = refuseIfNotWithdrawn(withdrew, input.payloadRef);
      if (empty !== null) return empty;
      work.bumpRevisions({ read: false, maintenance: true });
      return planned;
    });
  }

  /**
   * Read one mark with its recheck verdict. The revision is read under the same
   * authority as the row, so a verdict can never be computed against a revision
   * that moved between the two reads.
   */
  async readCollectionMark(
    input: CollectionMarkReadInput
  ): Promise<CollectionMarkReadOutcome> {
    return this.authority.withAuthorizedScope(input.context, async (work) => {
      const owned = requireOwnedScope(input.context, input.scopeBinding);
      if (owned !== null) return owned;
      const now = await databaseNow(work.client);
      const row = await readMarkRow(
        work.client,
        input.identity,
        /* forUpdate */ false
      );
      if (row === null) return { found: false };

      const mark = rowToMark(row);
      const lifecycleRevision = await observedRevision(
        work.client,
        mark.scopeBinding
      );
      const recheck = recheckCollectionMark(mark, { lifecycleRevision, now });
      if (recheck.refused) return { found: true, mark, recheckRefusal: recheck };
      return { found: true, mark, recheck: recheck.recheck };
    });
  }
}

/**
 * The source-version facts a mark decision reads, with the object-scoped shape
 * folded in.
 *
 * A mark on one of the two object-scoped classes has no source version at all, and
 * that is not the same fact as one whose source version is missing from the store —
 * the first is a valid mark, the second is a binding the store cannot honour.
 */
async function readMarkSourceFacts(
  client: EvidenceClient,
  sourceVersionId: string | null
): Promise<SourceVersionFacts> {
  if (sourceVersionId === null) {
    return { exists: true, payloadCollected: false, obligationsStopped: false };
  }
  return readSourceVersionFacts(client, sourceVersionId);
}

/** Refuse a source version the store does not hold, so no stamp can land on it. */
function refuseIfUnstammable(
  facts: SourceVersionFacts,
  sourceVersionId: string | null
): { readonly refused: true; readonly code: "unsupported_source_binding"; readonly detail: string } | null {
  if (facts.exists) return null;
  return {
    refused: true,
    code: "unsupported_source_binding",
    detail: `source version ${String(sourceVersionId)} is not held by the store, so no mark can stop its obligations`,
  };
}

/**
 * Refuse a payload that already carries a mark row.
 *
 * Whether a payload that was marked and then cancelled may be marked again is a
 * retention policy question MP15 has not answered yet, so the safe answer stands:
 * it may not, and the caller is told so rather than finding out from a primary-key
 * collision. PostgreSQL and the memory lane both refuse, deliberately.
 */
async function refuseIfAlreadyMarked(
  client: EvidenceClient,
  identity: CollectionMarkIdentity
): Promise<{ readonly refused: true; readonly code: "input_stale"; readonly detail: string } | null> {
  const existing = await readMarkRow(client, identity, /* forUpdate */ true);
  if (existing === null) return null;
  return {
    refused: true,
    code: "input_stale",
    detail: `payload ${identity.payloadRef} already carries a ${existing.state} mark, so marking it again must cancel or delete that one first`,
  };
}

/** Refuse a cancellation that withdrew no live mark, naming the payload. */
function refuseIfNotWithdrawn(
  withdrew: boolean,
  payloadRef: string
): { readonly refused: true; readonly code: "input_stale"; readonly detail: string } | null {
  if (withdrew) return null;
  return {
    refused: true,
    code: "input_stale",
    detail: `payload ${payloadRef} has no live mark to cancel`,
  };
}

/**
 * Refuse a mark whose scope is not the one this transaction was authorized for.
 *
 * Not belt-and-braces. `withAuthorizedScope` locks and advances
 * `context.ownerScopeBinding`, so a caller passing a different `scopeBinding` would
 * have this store read and write the revision of a scope the transaction never
 * routed to — recording a `expected_lifecycle_revision` that corresponds to nothing
 * that committed, and stamping a source version the transaction was never
 * authorized to touch. The memory lane already refuses this; the two must agree.
 */
function requireOwnedScope(
  context: AuthorizedScopeContext,
  scopeBinding: string
): { readonly refused: true; readonly code: "access_denied"; readonly detail: string } | null {
  if (scopeBinding === context.ownerScopeBinding) return null;
  return {
    refused: true,
    code: "access_denied",
    detail: `the mark scope ${scopeBinding} is not the context's owner scope ${context.ownerScopeBinding}`,
  };
}

/**
 * Record a mark's cancellation and why, reporting whether it withdrew anything.
 *
 * The boolean is load-bearing: a cancellation aimed at a payload that was never
 * marked, or at one already cancelled, updates nothing — and a caller told "cancelled"
 * for a write that matched no row would believe a stale mark had been withdrawn when
 * it is still sitting in the table for the next scan to find.
 *
 * One statement for both callers — a reactivation and a stale recheck — because the
 * two differ only in the reason they pass, and a cancellation whose reason is chosen
 * at a call site is a cancellation whose reason can drift from the vocabulary.
 */
async function cancelMarkRow(
  client: EvidenceClient,
  identity: CollectionMarkIdentity,
  cancelledAt: string,
  reason: CollectionMarkCancelReason
): Promise<boolean> {
  // RETURNING rather than rowCount: the client surface here reports rows only, and
  // the returned row IS the proof that a live mark was withdrawn.
  const { rows } = await client.query(
    `UPDATE structured_collection_marks
        SET state = 'cancelled', cancelled_at = $3::timestamptz, cancelled_reason = $4
      WHERE payload_class = $1 AND payload_ref = $2 AND state = 'marked'
      RETURNING payload_ref`,
    [identity.payloadClass, identity.payloadRef, cancelledAt, reason]
  );
  return rows.length > 0;
}

/**
 * The revision this mark will hold once its own bump commits.
 *
 * Read with FOR UPDATE so the value cannot move under the transaction, then stepped
 * by one: the authority defers the bump to the commit step, so the value observed
 * here is always one behind what the mark records. The step is done in BigInt and
 * narrowed back to decimal text immediately, because a bigint crossing into the
 * decision would throw at the first JSON boundary.
 */
async function commitRevision(
  client: EvidenceClient,
  scopeBinding: string
): Promise<string> {
  const observed = await observedRevision(client, scopeBinding);
  return (BigInt(observed) + 1n).toString();
}

/** The scope's live `maintenance_revision`, as the decimal text it is stored in. */
async function observedRevision(
  client: EvidenceClient,
  scopeBinding: string
): Promise<string> {
  const { rows } = await client.query(
    `SELECT maintenance_revision::text AS revision
       FROM structured_publication_scopes
      WHERE scope_binding = $1
      FOR UPDATE`,
    [scopeBinding]
  );
  if (rows.length === 0) {
    throw new MaintenanceStoreError(
      `scope ${scopeBinding} is not registered, so no collection mark can name a revision in it`,
      "unsupported_source_binding"
    );
  }
  if (rows.length > 1) {
    throw new MaintenanceStoreError(
      `scope ${scopeBinding} resolved to ${rows.length} rows under a primary key`,
      "backend_unavailable"
    );
  }
  // No `?? 0` fallback: an absent row is not the same fact as revision zero, and a
  // default here would hand the mark a revision no scope ever held.
  return String(rows[0].revision);
}

/**
 * The database's own clock. A mark's deadline is a retention promise, so both the
 * instant it is recorded and the instant it is rechecked come from the same clock
 * that wrote the row, not from a process whose clock may differ from the server's.
 */
/**
 * The database's own clock.
 *
 * The mark's deadline and instant are both decided from this, never from the
 * process clock, so a skewed application host cannot move a grace window. It
 * refuses rather than defaulting: an absent row would otherwise become
 * `new Date("undefined")`, an Invalid Date, and the planner would reject it as a
 * bad input — a fault in this store's read reported as the caller's mistake.
 */
async function databaseNow(client: EvidenceClient): Promise<Date> {
  const { rows } = await client.query(`SELECT clock_timestamp()::text AS now`);
  const raw = rows[0]?.now;
  const instant = new Date(String(raw));
  if (raw === null || raw === undefined || Number.isNaN(instant.getTime())) {
    throw new MaintenanceStoreError(
      "the database returned no usable clock_timestamp, so a mark cannot be dated",
      "backend_unavailable"
    );
  }
  return instant;
}

async function readSourceVersionFacts(
  client: EvidenceClient,
  sourceVersionId: string | null
): Promise<SourceVersionFacts> {
  if (sourceVersionId === null) {
    return { exists: true, payloadCollected: false, obligationsStopped: false };
  }
  const { rows } = await client.query(
    `SELECT payload_collected_at IS NOT NULL AS payload_collected,
            obligations_stopped_at IS NOT NULL AS obligations_stopped
       FROM source_versions
      WHERE source_version_id = $1`,
    [sourceVersionId]
  );
  if (rows.length === 0) {
    return { exists: false, payloadCollected: false, obligationsStopped: false };
  }
  if (rows.length > 1) {
    throw new MaintenanceStoreError(
      `source version ${String(sourceVersionId)} resolved to ${rows.length} rows under a primary key`,
      "backend_unavailable"
    );
  }
  const row = rows[0] as
    | { payload_collected: boolean; obligations_stopped: boolean }
    | undefined;
  return {
    exists: true,
    payloadCollected: row?.payload_collected === true,
    obligationsStopped: row?.obligations_stopped === true,
  };
}

async function readMarkRow(
  client: EvidenceClient,
  identity: CollectionMarkIdentity,
  forUpdate: boolean
): Promise<MarkRow | null> {
  const { rows } = await client.query(
    `SELECT payload_class, payload_ref, scope_binding, source_version_id,
            expected_lifecycle_revision::text AS expected_lifecycle_revision,
            deadline_at, marked_at, state, cancelled_at, cancelled_reason
       FROM structured_collection_marks
      WHERE payload_class = $1 AND payload_ref = $2${forUpdate ? " FOR UPDATE" : ""}`,
    [identity.payloadClass, identity.payloadRef]
  );
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new MaintenanceStoreError(
      `collection mark ${identity.payloadRef} resolved to ${rows.length} rows under a primary key`,
      "backend_unavailable"
    );
  }
  return rows[0] as MarkRow;
}

function rowToMark(row: MarkRow): CollectionMark {
  return {
    payloadClass: row.payload_class as CollectionPayloadClass,
    payloadRef: row.payload_ref,
    scopeBinding: row.scope_binding,
    sourceVersionId: row.source_version_id,
    expectedLifecycleRevision: String(row.expected_lifecycle_revision),
    deadlineAt: new Date(row.deadline_at).toISOString(),
    markedAt: new Date(row.marked_at).toISOString(),
    state: row.state as CollectionMark["state"],
    cancelledAt: instantOrNull(row.cancelled_at),
    cancelledReason: (row.cancelled_reason ?? null) as CollectionMark["cancelledReason"],
  };
}

function instantOrNull(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function refusal(
  code: MaintenanceWorkFailureCode,
  detail: string
): { readonly refused: true; readonly code: MaintenanceWorkFailureCode; readonly detail: string } {
  return { refused: true, code, detail };
}
