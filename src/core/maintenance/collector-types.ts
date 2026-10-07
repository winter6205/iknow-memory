/**
 * Collector eligibility vocabulary (fin specs/structured-corpus-maintenance.md
 * §Physical collection, lines 276-305).
 *
 * Sibling of `types.ts` rather than more members of it: `types.ts` is the
 * durable-work ledger's contract, and this is the retention contract. They share
 * only the typed work-failure code, because a collector refusal is a ledger
 * failure like any other.
 *
 * This module answers ONE question from ONE read — "may this payload be collected
 * now, and if not, what blocks it and when does it next become eligible?" — and
 * it deliberately exposes no way to mark, delete, or purge anything. Marking is
 * MP14, deletion is MP15, purge is MP16; a module that decided eligibility and
 * also removed the payload could not prove that candidate time and physical
 * purge time stay separate facts, because the moment it deletes they stop being
 * two.
 */
import type { Clock } from "../clock.js";
import type { MaintenanceWorkFailureCode } from "./types.js";

/**
 * The six payload classes the retention table names, in the table's order.
 *
 * These are the whole classification: a payload's class plus its lifecycle
 * anchors decide its earliest candidate time, and a class is not something a
 * caller may extend with a new value.
 */
export const COLLECTION_PAYLOAD_CLASSES = [
  /** Failed/stale attempt stage: terminal state + 7 days. */
  "attempt_stage",
  /** Replaced derived generation/cache: stable replacement + 7 days. */
  "derived_generation",
  /** Retired unreferenced source/extraction/support: retirement + 90 days. */
  "retired_unreferenced",
  /** Retired evidence protected by row grants: the later of retirement + 90 days
   *  and the last finite row-reference expiry, capped at retirement + 365 days. */
  "retired_evidence_protected",
  /** Completed job detailed logs: terminal state + 90 days. */
  "job_detailed_logs",
  /** Expired backend/fin snapshot payloads: reference expiry. */
  "expired_snapshot",
] as const;

export type CollectionPayloadClass = (typeof COLLECTION_PAYLOAD_CLASSES)[number];

/**
 * The four classes whose retention clock runs from a source version's own
 * lifecycle. The other two are object-scoped (a job's detailed logs, a snapshot
 * payload) and carry no source binding, which is why a candidate may be refused
 * for naming one of those classes without a binding.
 */
export const COLLECTION_SOURCE_BOUND_CLASSES = [
  "attempt_stage",
  "derived_generation",
  "retired_unreferenced",
  "retired_evidence_protected",
] as const;

/** The source-version binding a source-bound candidate must carry. */
export interface CollectionSourceBinding {
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly sourceGeneration: number;
}

/**
 * One payload the collector was asked about.
 *
 * `anchorAt` is the instant the class deadline counts from — terminal state,
 * stable replacement, retirement, or reference expiry depending on the class.
 * It is nullable rather than defaulted so a caller cannot express "already
 * eligible" by omitting it: a missing anchor is `invalid_input`, never a
 * deadline of zero. There is deliberately no field for a caller-supplied
 * deadline; retention is fixed by the specification, not by configuration.
 */
export interface CollectionCandidate {
  readonly payloadClass: CollectionPayloadClass;
  /** Physical payload identity: the source ref for a source payload, the owning
   *  object's ref for a job log or snapshot payload. */
  readonly payloadRef: string;
  readonly source: CollectionSourceBinding | null;
  readonly anchorAt: string | null;
}

/**
 * What one read found about a candidate.
 *
 * A read reports what is TRUE, never what is missing: an absent dependency is an
 * empty array rather than a null, so "the read found nothing" and "the read could
 * not look" cannot be confused. A reader that cannot establish a fact raises a
 * typed failure instead of returning a partial set.
 */
export interface CollectionReadFacts {
  /** False when a source-bound candidate names a source version the store does
   *  not hold; that is `unsupported_source_binding`, not ineligibility. */
  readonly bindingResolved: boolean;
  /** `payload_collected_at` is already set: the payload is gone already and
   *  this decision is a no-op, not an eligibility verdict. */
  readonly payloadCollected: boolean;
  /** `retired_at` is set on the TARGET source version. The `retired_*` classes
   *  count their deadline from retirement (spec 291-292), so this is the fact
   *  that makes the class the caller named the class the payload is in: it is a
   *  store fact, never a caller assertion, and without it a payload that is
   *  still current looks old enough to collect. Always false for the two
   *  object-scoped classes, which have no source version at all. */
  readonly targetRetired: boolean;
  readonly currentDependencies: readonly CollectionCurrentDependency[];
  readonly validLeases: readonly CollectionLease[];
  readonly rowReferences: readonly CollectionRowReference[];
  /** Count-only grants. Recorded so the decision can show it saw them, never as
   *  a block: a count grant protects its receipt and shared authorization
   *  metadata, not a source payload (spec 280-282). */
  readonly countOnlyGrants: readonly CollectionCountGrant[];
}

/**
 * A current dependency on the payload. The four kinds are the spec's four
 * clauses — a current source/current-knowledge dependency (283-285), a decision
 * or current compiled object, a live retry/input dependency (289), and a reader
 * or in-flight job (290).
 */
export const COLLECTION_DEPENDENCY_KINDS = [
  "current_source_version",
  "published_or_desired_scope",
  "staged_publication",
  "live_maintenance_job",
] as const;

export type CollectionDependencyKind =
  (typeof COLLECTION_DEPENDENCY_KINDS)[number];

export interface CollectionCurrentDependency {
  readonly kind: CollectionDependencyKind;
  /** The row that holds the dependency, for the recheck to name. */
  readonly holder: string;
}

/** A job lease or a reader lease. Both are time-bounded; neither slides. */
export const COLLECTION_LEASE_KINDS = ["job", "reader"] as const;

export type CollectionLeaseKind = (typeof COLLECTION_LEASE_KINDS)[number];

export interface CollectionLease {
  readonly kind: CollectionLeaseKind;
  readonly holder: string;
  readonly expiresAt: string;
}

/** One finite row grant that holds this payload's content. */
export interface CollectionRowReference {
  readonly evidenceRef: string;
  readonly expiresAt: string;
}

/** One count-only grant. Its receipt survives payload collection. */
export interface CollectionCountGrant {
  readonly evidenceRef: string;
  readonly receiptId: string;
  readonly expiresAt: string;
}

/**
 * Why a payload may not be collected yet.
 *
 * `row_content_reference` is the only reason a grant produces, and
 * `count_only_grant` is absent by construction: there is no way to report a
 * count grant as blocking, so the negative case is unrepresentable rather than
 * merely untested.
 */
export const COLLECTION_BLOCKING_REASONS = [
  "already_collected",
  "current_dependency",
  "valid_lease",
  "row_content_reference",
  "deadline_not_reached",
] as const;

export type CollectionBlockingReason =
  (typeof COLLECTION_BLOCKING_REASONS)[number];

/**
 * The eligibility decision for one candidate.
 *
 * `earliestCandidateAt` and `physicalPurgeNotBefore` are separate fields because
 * they are separate facts: an unreferenced source retired on day 0 is a candidate
 * on day 90 and may be physically deleted on day 97. A single "when" field would
 * let one of the two be reported as the other.
 *
 * `nextEvaluationAt` is the earliest instant a blocker can clear on its own. It
 * is null when the payload is eligible now, and also when a current dependency
 * holds it: no clock reading releases a dependency, so a scheduler that treated
 * a null here as "soon" would poll a payload that only a lifecycle event frees.
 */
export interface CollectionEligibility {
  readonly payloadClass: CollectionPayloadClass;
  readonly eligible: boolean;
  readonly earliestCandidateAt: string;
  /** Candidate time plus the mark-and-wait grace; the earliest instant the
   *  deletion phases of MP15 may begin after a mark. */
  readonly physicalPurgeNotBefore: string;
  readonly blockingReasons: readonly CollectionBlockingReason[];
  readonly nextEvaluationAt: string | null;
  /** Count grants that were present and deliberately did not block. */
  readonly ignoredCountGrants: readonly string[];
}

/**
 * A decision, or a typed refusal. Refusal is a value because a malformed or
 * unresolved candidate is an expected outcome at a public entry, and because a
 * caller must be able to tell `invalid_input` from `unsupported_source_binding`
 * without parsing a message.
 */
export type CollectionEligibilityOutcome =
  | {
      readonly refused: true;
      readonly code: MaintenanceWorkFailureCode;
      readonly detail: string;
    }
  | { readonly refused: false; readonly eligibility: CollectionEligibility };

/**
 * The one read a decision is made from.
 *
 * `activeReaders` is passed in rather than read: a reader lease lives with the
 * read it protects and has no row in this schema to join, so the host supplies
 * the ones it is holding. Passing it per call keeps the value and the decision
 * on one instant.
 */
export interface CollectionEligibilityReader {
  readCollectionFacts(
    candidate: CollectionCandidate,
    now: Date,
    activeReaders?: readonly CollectionLease[]
  ): Promise<CollectionReadFacts>;
}

export interface CollectionEligibilityDeps {
  readonly reader: CollectionEligibilityReader;
  readonly clock: Clock;
}