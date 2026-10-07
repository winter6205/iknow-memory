/**
 * MP14 collection marks — the in-memory lane.
 *
 * Durability is a PostgreSQL property, so this lane answers a different question
 * from the PG twin: whether the mark and the obligations it stops are applied
 * together, or not at all, and whether a mark racing a reactivation can end with
 * both effects standing. That race is only observable on a real serialization
 * tail, so this store composes through the same authority the durable-work ledger
 * uses rather than holding a lock of its own.
 *
 * The verdicts are not re-derived here. Eligibility comes from the caller because
 * MP13 exports `decideCollectionEligibility` for exactly that, and every accept or
 * refuse below is one of `planCollectionMark`, `planCollectionReactivation` or
 * `recheckCollectionMark` — so a disagreement between the lanes can only be about
 * persistence and ordering, never about what the answer should have been.
 */
import {
  planCollectionMark,
  planCollectionReactivation,
  planStaleMarkCancellation,
  recheckCollectionMark,
} from "../maintenance/collection-mark.js";
import type {
  CollectionMark,
  CollectionMarkCancellationOutcome,
  CollectionMarkIdentity,
  CollectionMarkOutcome,
  CollectionMarkRecheckOutcome,
  CollectionMarkRequest,
  CollectionReactivateOutcome,
} from "../maintenance/collection-mark-types.js";
import type { CollectionEligibility } from "../maintenance/collector-types.js";
import type { MaintenanceWorkFailureCode } from "../maintenance/types.js";
import type {
  AuthorizedScopeContext,
  AuthorizedScopeRunOptions,
  PreparedMemoryScopeWork,
} from "./structured-scope-types.js";

/**
 * The scope authority this lane composes through, typed as the port rather than
 * the whole seam. It is the same port the screening and work stores use, so the
 * mark inherits one lock order, one routing loop and one set of typed exits
 * instead of establishing a second transaction discipline beside them.
 */
export interface MemoryCollectionMarkAuthority {
  withAuthorizedScope<R>(
    context: AuthorizedScopeContext,
    callback: (work: PreparedMemoryScopeWork) => Promise<R>,
    options?: AuthorizedScopeRunOptions
  ): Promise<R>;
}

/**
 * The one source-version column a mark writes.
 *
 * It is the column `obligations_stopped_at` and not a field of the mark, because
 * the effect it names is read from the source version by `decideGrantRead`
 * (`evidence-store.ts:449-454`) and a mark-local copy of it would be a second
 * truth that nothing enforces. A mark therefore adds no column anywhere: it
 * records what it decided, and the existing stamp carries the effect.
 */
export interface MemoryMarkedSourceVersion {
  readonly sourceVersionId: string;
  /** The existing `obligations_stopped_at` stamp, or null while obligations flow. */
  readonly obligationsStoppedAt: string | null;
  /** The existing `payload_collected_at` stamp, which no reactivation may undo. */
  readonly payloadCollectedAt: string | null;
}

/** Everything the lane holds. A test seeds it; nothing outside writes to it. */
export interface InMemoryCollectionMarkSeed {
  readonly sourceVersions?: readonly MemoryMarkedSourceVersion[];
}

export interface MemoryMarkCandidateRequest extends CollectionMarkIdentity {
  readonly context: AuthorizedScopeContext;
  /** The scope the mark belongs to; it must be the context's owner scope. */
  readonly scopeBinding: string;
  readonly sourceVersionId: string | null;
  /** MP13's verdict for this payload. Taken as decided, never recomputed. */
  readonly eligibility: CollectionEligibility;
}

export interface MemoryReactivationRequest extends CollectionMarkIdentity {
  readonly context: AuthorizedScopeContext;
  readonly scopeBinding: string;
  readonly sourceVersionId: string | null;
  /** The revision the caller read, which fences the cancellation against a
   *  scope that has moved since (spec:304 — cancel before creating dependencies). */
  readonly expectedLifecycleRevision: string;
}

export interface MemoryMarkRecheckRequest extends CollectionMarkIdentity {
  readonly context: AuthorizedScopeContext;
  readonly now: Date;
}

/**
 * A stale recheck asking for the cancellation it reported.
 *
 * Carries the revision the recheck observed, so the cancellation is fenced against
 * the same scope state the verdict was computed from — otherwise a mark could be
 * withdrawn for staleness observed against a revision that has since moved again.
 */
export interface MemoryStaleCancellationRequest extends CollectionMarkIdentity {
  readonly context: AuthorizedScopeContext;
  /** The scope the mark belongs to; it must be the context's owner scope. */
  readonly scopeBinding: string;
  readonly observedLifecycleRevision: string;
}

/** A source-version row this lane may stamp, or the refusal naming why it may not. */
type StampTarget =
  | { readonly ok: true; readonly row: MarkedSourceVersionRow }
  | {
      readonly ok: false;
      readonly refusal: CollectionMarkOutcome &
        CollectionReactivateOutcome &
        CollectionMarkRecheckOutcome;
    };

/** The mutable form of a seeded source version; the stamp columns are written. */
interface MarkedSourceVersionRow {
  sourceVersionId: string;
  obligationsStoppedAt: string | null;
  payloadCollectedAt: string | null;
}

export class InMemoryCollectionMarkStorage {
  private readonly marks = new Map<string, CollectionMark>();
  private readonly sourceVersions = new Map<string, MarkedSourceVersionRow>();

  constructor(
    private readonly scope: MemoryCollectionMarkAuthority,
    seed: InMemoryCollectionMarkSeed = {},
    private readonly now: () => Date = () => new Date()
  ) {
    for (const version of seed.sourceVersions ?? []) {
      this.sourceVersions.set(version.sourceVersionId, { ...version });
    }
  }

  /**
   * Record that an eligible candidate has been marked, together with the
   * obligations the mark stops.
   *
   * The two effects are separate `prepare` registrations rather than one closure
   * because they are separate rows: a mark row in this table, and the existing
   * stamp on a source version. Registering both means the authority runs them in
   * one commit slice after every fallible step has already happened, and a
   * refusal raised before either registration leaves neither row written — which
   * is the guarantee a memory lane can offer in place of a rollback.
   */
  async markCollectionCandidate(
    request: MemoryMarkCandidateRequest
  ): Promise<CollectionMarkOutcome> {
    return this.scope.withAuthorizedScope(request.context, async (work) => {
      const owned = this.requireOwnedScope(request.context, request.scopeBinding);
      if (!owned.ok) return owned.refusal;
      const observed = (await work.readMaintenanceInputs([])).maintenanceRevision;
      const outcome = planCollectionMark(
        this.markRequest(request, owned.scopeBinding, observed),
        this.now()
      );
      if (outcome.refused) return outcome;

      const { mark, stopsObligations } = outcome.plan;
      const target = stopsObligations
        ? this.stampTarget(mark.sourceVersionId)
        : null;
      if (target !== null && !target.ok) return target.refusal;

      const key = markKey(mark.payloadClass, mark.payloadRef);
      // Only a LIVE mark refuses. A payload that was marked and then cancelled is
      // exactly the case spec:307 sends down this path — cancel, re-evaluate, and
      // if it is still eligible mark it again — so refusing a cancelled row would
      // make the re-evaluation branch unreachable and strand the payload: never
      // markable, never collected. The earlier mark's cancellation is overwritten
      // rather than kept; MP15 deletes this row with the payload, and if the history
      // of a first cancellation is ever needed it belongs in MP15/MP16's tombstone.
      const existing = this.marks.get(key);
      if (existing !== undefined && existing.state === "marked") {
        return {
          refused: true,
          code: "input_stale",
          detail: `payload ${mark.payloadRef} already carries a live mark, so marking it again must cancel or delete that one first`,
        };
      }
      work.prepare(() => {
        this.marks.set(key, mark);
      });
      if (stopsObligations) {
        const row = (target as { ok: true; row: MarkedSourceVersionRow }).row;
        work.prepare(() => {
          row.obligationsStoppedAt = mark.markedAt;
        });
      }
      work.bumpRevisions({ read: false, maintenance: true });
      return outcome;
    });
  }

  /**
   * Cancel a mark so dependencies may be created again, and resume the
   * obligations the mark stopped.
   *
   * This returns a plan and creates nothing: the caller creates its dependencies
   * after this resolves, which is the ordering spec:304 requires of a
   * reactivation. Reading the scope's revision here — rather than trusting the
   * caller's — is what lets the decision refuse a scope that moved while the
   * cancellation was being prepared.
   */
  async reactivateCollectionCandidate(
    request: MemoryReactivationRequest
  ): Promise<CollectionReactivateOutcome> {
    return this.scope.withAuthorizedScope(request.context, async (work) => {
      const owned = this.requireOwnedScope(request.context, request.scopeBinding);
      if (!owned.ok) return owned.refusal;
      const observed = (await work.readMaintenanceInputs([])).maintenanceRevision;

      let row: MarkedSourceVersionRow | null = null;
      if (request.sourceVersionId !== null) {
        const target = this.stampTarget(request.sourceVersionId);
        if (!target.ok) return target.refusal;
        row = target.row;
      }

      const outcome = planCollectionReactivation(
        {
          payloadClass: request.payloadClass,
          payloadRef: request.payloadRef,
          scopeBinding: owned.scopeBinding,
          sourceVersionId: request.sourceVersionId,
          payloadCollected: row?.payloadCollectedAt != null,
          obligationsStopped: row?.obligationsStoppedAt != null,
          expectedLifecycleRevision: request.expectedLifecycleRevision,
          observedLifecycleRevision: String(observed),
        },
        this.now()
      );
      if (outcome.refused) return outcome;

      const { plan } = outcome;
      const key = markKey(plan.identity.payloadClass, plan.identity.payloadRef);
      // A payload that was never marked has nothing to reactivate, and writing one
      // here would store a row with no class, ref, scope or deadline — a key that
      // then refuses every future mark for that identity forever. The plan does not
      // require the mark to exist, so the store must check.
      //
      // An ALREADY-CANCELLED mark is deliberately not refused. spec:304's
      // precondition is then already satisfied, and the call's whole purpose is to
      // put the payload back in service — refusing it would leave
      // obligations_stopped_at set, and decideGrantRead denies on exactly that
      // (`evidence-store.ts:449-454`), so the payload could never be served again.
      const live = this.marks.get(key);
      if (live === undefined) {
        return {
          refused: true,
          code: "input_stale",
          detail: `payload ${plan.identity.payloadRef} has no collection mark to reactivate`,
        };
      }
      work.prepare(() => {
        this.marks.set(key, {
          ...live,
          state: "cancelled",
          cancelledAt: plan.cancelledAt,
          cancelledReason: plan.reason,
        });
      });
      if (plan.resumedObligations && row !== null) {
        work.prepare(() => {
          row.obligationsStoppedAt = null;
        });
      }
      // Resuming obligations is as maintenance-visible as stopping them, so the
      // scope moves either way and a mark prepared against the old revision is
      // stale rather than merely concurrent.
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
    request: MemoryStaleCancellationRequest
  ): Promise<CollectionMarkCancellationOutcome> {
    const outcome = planStaleMarkCancellation(
      { payloadClass: request.payloadClass, payloadRef: request.payloadRef },
      this.now()
    );
    if (outcome.refused) return outcome;
    return this.scope.withAuthorizedScope(request.context, async (work) => {
      const owned = this.requireOwnedScope(request.context, request.scopeBinding);
      if (!owned.ok) {
        return { refused: true, code: owned.refusal.code, detail: owned.refusal.detail };
      }
      // The same revision fence a reactivation uses: cancelling against a scope
      // that moved since the recheck read it would cancel a mark the recheck never
      // actually evaluated.
      const observed = (await work.readMaintenanceInputs([])).maintenanceRevision;
      if (String(observed) !== request.observedLifecycleRevision) {
        return {
          refused: true,
          code: "input_stale",
          detail: `scope revision moved from ${request.observedLifecycleRevision} to ${observed}`,
        };
      }
      const key = markKey(request.payloadClass, request.payloadRef);
      // A cancellation that would withdraw nothing must say so, rather than
      // reporting a withdrawal that never happened and leaving a caller believing
      // a stale mark is gone.
      const live = this.marks.get(key);
      if (live === undefined || live.state !== "marked") {
        return {
          refused: true,
          code: "input_stale",
          detail: `payload ${request.payloadRef} has no live mark to cancel`,
        };
      }
      work.prepare(() => {
        this.marks.set(key, {
          ...live,
          state: "cancelled",
          cancelledAt: outcome.cancellation.cancelledAt,
          cancelledReason: outcome.cancellation.reason,
        });
      });
      work.bumpRevisions({ read: false, maintenance: true });
      return outcome;
    });
  }

  /** The persisted mark for one payload, or null when it has never been marked. */
  async readCollectionMark(
    identity: CollectionMarkIdentity
  ): Promise<CollectionMark | null> {
    const mark = this.marks.get(markKey(identity.payloadClass, identity.payloadRef));
    return mark === undefined ? null : { ...mark };
  }

  /**
   * Recheck a persisted mark against the scope as it stands now.
   *
   * The revision is read inside the same authorized scope as the mark, so `stale`
   * compares a recorded revision against a live one and never against a value the
   * caller carried in from its earlier scan (spec:307).
   */
  async recheckCollectionCandidate(
    request: MemoryMarkRecheckRequest
  ): Promise<CollectionMarkRecheckOutcome> {
    return this.scope.withAuthorizedScope(request.context, async (work) => {
      const observed = (await work.readMaintenanceInputs([])).maintenanceRevision;
      const mark = this.marks.get(
        markKey(request.payloadClass, request.payloadRef)
      );
      if (mark === undefined) {
        return refused(
          "input_stale",
          `no collection mark is recorded for payload ${request.payloadRef}`
        );
      }
      return recheckCollectionMark(mark, {
        lifecycleRevision: String(observed),
        now: request.now,
      });
    });
  }

  /** The existing obligations stamp, so a caller can assert the effect landed. */
  async readObligationsStoppedAt(
    sourceVersionId: string
  ): Promise<string | null> {
    return this.sourceVersions.get(sourceVersionId)?.obligationsStoppedAt ?? null;
  }

  private markRequest(
    request: MemoryMarkCandidateRequest,
    scopeBinding: string,
    observed: number
  ): CollectionMarkRequest {
    return {
      payloadClass: request.payloadClass,
      payloadRef: request.payloadRef,
      scopeBinding,
      sourceVersionId: request.sourceVersionId,
      eligibility: request.eligibility,
      // The revision the mark holds AT ITS OWN COMMIT, not the one it observed:
      // this mark registers a maintenance bump, and the authority applies it
      // after the insert runs, so the committed value is observed + 1. Recording
      // `observed` would make every mark stale against itself on its own first
      // recheck — a livelock that reads as correctness because the recheck is
      // the only thing that ever notices.
      lifecycleRevision: String(observed + 1),
    };
  }

  /**
   * A mark on a source-bound class is only recordable if the source version it
   * stops obligations on is here. Refusing before either effect is prepared is
   * what keeps "the mark and the obligations it stops" a single outcome: there is
   * no state in which the mark row exists and the effect did not apply.
   */
  private stampTarget(sourceVersionId: string | null): StampTarget {
    if (sourceVersionId === null) {
      return {
        ok: false,
        refusal: refused(
          "invalid_input",
          "a mark that stops obligations must name the source version it stops them on"
        ),
      };
    }
    const row = this.sourceVersions.get(sourceVersionId);
    if (row === undefined) {
      return {
        ok: false,
        refusal: refused(
          "invalid_input",
          `source version ${sourceVersionId} is not held by this scope, so its obligations cannot be stopped`
        ),
      };
    }
    return { ok: true, row };
  }

  /** A context is authority over one owner scope; a request may not name another. */
  private requireOwnedScope(
    context: AuthorizedScopeContext,
    scopeBinding: string
  ):
    | { readonly ok: true; readonly scopeBinding: string }
    | {
        readonly ok: false;
        readonly refusal: {
          readonly refused: true;
          readonly code: MaintenanceWorkFailureCode;
          readonly detail: string;
        };
      } {
    if (scopeBinding !== context.ownerScopeBinding) {
      return {
        ok: false,
        refusal: {
          refused: true,
          code: "access_denied",
          detail: `the mark scope ${scopeBinding} is not the context's owner scope ${context.ownerScopeBinding}`,
        },
      };
    }
    return { ok: true, scopeBinding };
  }
}

function markKey(
  payloadClass: CollectionMarkIdentity["payloadClass"],
  payloadRef: string
): string {
  return `${payloadClass}|${payloadRef}`;
}

/**
 * The one refusal shape every exit in this lane returns.
 *
 * Typed as the intersection of the outcomes it stands in for rather than as any one
 * of them, so a caller can hand it straight back from a method whose declared
 * outcome is a different one — the alternative was five near-identical local
 * builders, and a refusal that fails to typecheck at a call site is a refusal
 * somebody will work around.
 */
function refused(
  code: MaintenanceWorkFailureCode,
  detail: string
): CollectionMarkOutcome &
  CollectionReactivateOutcome &
  CollectionMarkRecheckOutcome &
  CollectionMarkCancellationOutcome {
  return { refused: true, code, detail };
}
