/**
 * MP14 collection-mark vocabulary (fin specs/structured-corpus-maintenance.md
 * §Physical collection, lines 302-304).
 *
 * Sibling of `collector-types.ts` and not more members of it. That module answers
 * "may this payload be collected now?"; this one answers the different question
 * "has this payload been marked, is that mark still true, and does a reactivation
 * cancel it?". Keeping them apart is what lets MP15 add deletion without any
 * module both deciding and removing: a reader of `collection-mark-types.ts` can
 * see there is no way to express a deletion here at all.
 *
 * A mark records three things the specification requires together (302): the
 * lifecycle revision it was decided against, the deadline after which deletion may
 * begin, and the fact that new obligations against the candidate stop. The first
 * two live on the mark row; the third is an effect on the source version, which is
 * why `CollectionMarkPlan` carries a separate `stopsObligations` rather than
 * implying it.
 */
import type { MaintenanceWorkFailureCode } from "./types.js";
import type {
  CollectionEligibility,
  CollectionPayloadClass,
} from "./collector-types.js";

/**
 * A mark is either live or cancelled. There is no third state on purpose.
 *
 * "Deleted" is absent because MP14 removes nothing: a payload that has been
 * physically deleted carries no mark, because the row that described the candidate
 * is what MP15 drops along with the payload. "Expired" is absent because the
 * deadline is a field, not a state — a mark past its deadline is still a live mark
 * until a recheck cancels it, and collapsing those two would let a late worker
 * read an over-deadline mark as a live one and skip its recheck.
 */
export const COLLECTION_MARK_STATES = ["marked", "cancelled"] as const;

export type CollectionMarkState = (typeof COLLECTION_MARK_STATES)[number];

/** Why a mark was cancelled. Recorded so a reactivation is distinguishable from a
 *  stale-revision cancellation after the fact. */
export const COLLECTION_MARK_CANCEL_REASONS = [
  "reactivated",
  "lifecycle_revision_changed",
] as const;

export type CollectionMarkCancelReason =
  (typeof COLLECTION_MARK_CANCEL_REASONS)[number];

/**
 * A payload's collection identity — the mark's primary key.
 *
 * This is `(payloadClass, payloadRef)` and deliberately NOT a source version id:
 * four of the six classes are source-bound and two are not, so a mark keyed by
 * source version could not hold a job's detailed logs or a snapshot payload at
 * all. It is also not `(payloadClass, payloadRef, scopeBinding)`, because the scope
 * is carried as a column rather than part of the identity — one payload is marked
 * once, in the one scope that owns it, and a second mark for a different scope is
 * a caller error rather than a second mark.
 */
export interface CollectionMarkIdentity {
  readonly payloadClass: CollectionPayloadClass;
  readonly payloadRef: string;
}

/** A persisted mark. */
export interface CollectionMark extends CollectionMarkIdentity {
  readonly scopeBinding: string;
  /** The source version whose obligations a mark stops, or null for the two
   *  object-scoped classes that have no source version at all. */
  readonly sourceVersionId: string | null;
  /**
   * The scope's `maintenance_revision` **as it stands at this mark's own commit**,
   * carried as a decimal string.
   *
   * Two things make the string load-bearing. It is `bigint` in the DDL, and a JS
   * `bigint` throws in `JSON.stringify`, so a `number` would silently lose
   * precision past 2^53 and a `bigint` would throw at the first boundary. And it
   * is the post-bump value rather than the observed one: marking stops new
   * obligations, which advances `maintenance_revision` itself, so a mark recording
   * what it observed would be born stale and cancel itself on its own first
   * recheck. Recording the commit value makes "stale" mean what spec:307 means —
   * something moved after this mark, not this mark.
   */
  readonly expectedLifecycleRevision: string;
  /** The earliest instant deletion may begin: MP13's candidate time plus grace. */
  readonly deadlineAt: string;
  readonly markedAt: string;
  readonly state: CollectionMarkState;
}

/**
 * What one mark decision resolves to.
 *
 * `stopsObligations` is false for the two object-scoped classes, whose candidates
 * have no source version to stop obligations on. It is stated rather than inferred
 * from the class so a storage lane never re-derives the source-bound set and
 * therefore cannot disagree with this module about which effect to apply.
 */
export interface CollectionMarkPlan {
  readonly mark: CollectionMark;
  readonly stopsObligations: boolean;
}

export type CollectionMarkOutcome =
  | {
      readonly refused: true;
      readonly code: MaintenanceWorkFailureCode;
      readonly detail: string;
    }
  | { readonly refused: false; readonly plan: CollectionMarkPlan };

/**
 * A reactivation outcome.
 *
 * `resumedObligations` is false when the cancelled mark never stopped any — the
 * object-scoped case, and the case where the mark was already cancelled. A caller
 * that creates dependencies after this returns must not assume obligations were
 * stopped-then-resumed, because for a false value they were never stopped.
 */
export interface CollectionReactivatePlan {
  readonly identity: CollectionMarkIdentity;
  readonly scopeBinding: string;
  readonly sourceVersionId: string | null;
  readonly resumedObligations: boolean;
  readonly cancelledAt: string;
}

export type CollectionReactivateOutcome =
  | {
      readonly refused: true;
      readonly code: MaintenanceWorkFailureCode;
      readonly detail: string;
    }
  | { readonly refused: false; readonly plan: CollectionReactivatePlan };

/**
 * A recheck verdict against an already-persisted mark.
 *
 * `stale` true means the mark must be cancelled and the candidate re-evaluated
 * from a fresh read — never deleted against the earlier scan (spec:307). The
 * observed revision rides along so the caller can record *why* it cancelled rather
 * than only that it did.
 */
export interface CollectionMarkRecheck {
  readonly identity: CollectionMarkIdentity;
  readonly scopeBinding: string;
  readonly observedLifecycleRevision: string;
  readonly deadlineReached: boolean;
  readonly stale: boolean;
}

export type CollectionMarkRecheckOutcome =
  | {
      readonly refused: true;
      readonly code: MaintenanceWorkFailureCode;
      readonly detail: string;
    }
  | { readonly refused: false; readonly recheck: CollectionMarkRecheck };

/**
 * What a mark decision needs beyond the candidate.
 *
 * `lifecycleRevision` is the value the *store* will hold at commit, supplied by
 * the lane composing through the scope authority — the same authority that defers
 * its revision bump to the commit step (`structured-scope-types.ts:430`). MP14's
 * pure module therefore never reads a clock or a scope; it only places the value
 * the caller is about to commit.
 */
export interface CollectionMarkRequest extends CollectionMarkIdentity {
  readonly scopeBinding: string;
  readonly sourceVersionId: string | null;
  readonly eligibility: CollectionEligibility;
  /** The revision this mark will hold AT ITS OWN COMMIT, supplied by the lane
   *  composing through the scope authority. Never the value observed before the
   *  bump: marking advances `maintenance_revision` itself, so the observed value
   *  would make every mark stale against itself on its first recheck. */
  readonly lifecycleRevision: string;
}

/**
 * What a reactivation request needs. `now` is a parameter rather than a field, so a
 * decision and the instant it was made at cannot travel apart.
 *
 * `expectedLifecycleRevision` is the revision the caller believes it is cancelling
 * against, which is what makes a lost update visible: if the scope moved since the
 * caller read it, the reactivation is refused rather than applied to a world the
 * caller never saw.
 */
export interface CollectionReactivationRequest extends CollectionMarkIdentity {
  readonly scopeBinding: string;
  readonly sourceVersionId: string | null;
  /** The payload is physically gone. A reactivation cannot resurrect it (spec:311,
   *  "no stale worker can resurrect the deleted identity"). */
  readonly payloadCollected: boolean;
  /** Whether a mark is currently stopping obligations on the source version, so a
   *  cancellation that resumes nothing is distinguishable from one that resumes. */
  readonly obligationsStopped: boolean;
  readonly expectedLifecycleRevision: string;
  /** The revision the store actually holds inside this transaction. A mismatch
   *  with `expectedLifecycleRevision` is a lost update and is refused, so a
   *  reactivation cannot be applied to a world the caller never observed. */
  readonly observedLifecycleRevision: string;
}

/** What a recheck observed, as against a persisted mark. */
export interface CollectionMarkObservation {
  readonly lifecycleRevision: string;
  readonly now: Date;
}
