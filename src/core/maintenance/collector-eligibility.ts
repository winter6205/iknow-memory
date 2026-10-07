/**
 * Collector eligibility decision (fin specs/structured-corpus-maintenance.md
 * §Physical collection, lines 276-305).
 *
 * Pure: a function of the candidate, one read's facts, and an injected instant.
 * No `Date.now()`, no storage, no I/O — the same rule `durable-work.ts` follows,
 * and the reason the 7/90/365-day boundaries are provable at the boundary instead
 * of one sleep away from it.
 *
 * Two invariants this module exists to hold:
 *
 * 1. **A count-only grant never blocks.** It protects its receipt and the shared
 *    authorization metadata, not a source payload (spec 280-282), so the reason
 *    set has no member for it and a count grant can only appear in
 *    `ignoredCountGrants`.
 * 2. **Candidate time is not purge time.** Collection is mark, wait 7 days,
 *    recheck, delete (spec 296-300), so the two are separate fields: a source
 *    retired on day 0 is a candidate on day 90 and may be physically deleted on
 *    day 97.
 *
 * Nothing here marks or deletes. Marking is MP14 and the deletion phases are
 * MP15; a module that removed the payload it just cleared would make the
 * mark/recheck recheck impossible to express.
 */
import {
  COLLECTION_PAYLOAD_CLASSES,
  COLLECTION_SOURCE_BOUND_CLASSES,
  type CollectionBlockingReason,
  type CollectionCandidate,
  type CollectionEligibility,
  type CollectionEligibilityDeps,
  type CollectionEligibilityOutcome,
  type CollectionLease,
  type CollectionPayloadClass,
  type CollectionReadFacts,
} from "./collector-types.js";
import type { MaintenanceWorkFailureCode } from "./types.js";

/**
 * One day is one elapsed UTC 24-hour period (spec 299-300). Arithmetic is done in
 * milliseconds from an absolute instant, so a deadline is never a "midnight on
 * day N", and no read can slide it.
 */
export const COLLECTION_DAY_MS = 86_400_000;

/** Failed/stale attempt stage: terminal state + 7 days (spec 289). */
export const ATTEMPT_STAGE_GRACE_DAYS = 7;
/** Replaced derived generation/cache: stable replacement + 7 days (spec 290). */
export const DERIVED_REPLACEMENT_GRACE_DAYS = 7;
/** Retired unreferenced source/extraction/support: retirement + 90 days (spec 291). */
export const RETIRED_PAYLOAD_DEADLINE_DAYS = 90;
/** Completed job detailed logs: terminal state + 90 days (spec 293). */
export const JOB_LOG_DEADLINE_DAYS = 90;
/**
 * The ceiling on how long a finite row reference may delay a retired payload
 * (spec 292). A reference that outlives it releases the payload at the ceiling
 * rather than pinning it forever.
 */
export const ROW_REFERENCE_CAP_DAYS = 365;
/**
 * Mark, wait 7 days, recheck, delete (spec 296). It is added to candidate time
 * and never subtracted from it: the two are separate facts.
 */
export const COLLECTION_MARK_GRACE_DAYS = 7;

/** Same spelling the evidence contract requires of an instant. */
const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
/** ECMAScript's representable instant range, one millisecond either side. */
const MAX_INSTANT_MS = 8_640_000_000_000_000;

/** Whether a value names one of the six retention-table payload classes. */
export function isCollectionPayloadClass(
  value: unknown
): value is CollectionPayloadClass {
  return (
    typeof value === "string" &&
    (COLLECTION_PAYLOAD_CLASSES as readonly string[]).includes(value)
  );
}

/** Whether this class's retention clock runs from a source version's lifecycle. */
export function isSourceBoundCollectionClass(
  value: CollectionPayloadClass
): boolean {
  return (COLLECTION_SOURCE_BOUND_CLASSES as readonly string[]).includes(value);
}

/**
 * One read, one decision.
 *
 * The read happens first and the refusal checks follow, in that order, because a
 * candidate whose source binding the store cannot resolve is not "blocked" — it
 * was never identified, and reporting it as blocked would let a caller retry it
 * forever instead of reporting the binding as unsupported.
 */
export async function readCollectionEligibility(
  deps: CollectionEligibilityDeps,
  candidate: CollectionCandidate,
  activeReaders?: readonly CollectionLease[]
): Promise<CollectionEligibilityOutcome> {
  const now = deps.clock();
  const invalid = findInvalidCandidate(candidate);
  if (invalid) return refusal("invalid_input", invalid);
  const facts = await deps.reader.readCollectionFacts(candidate, now, activeReaders);
  return decideCollectionEligibility(candidate, facts, now);
}

/**
 * Decide eligibility from facts already read. Exposed separately so a caller that
 * legitimately holds the facts from its own read — MP14's atomic mark recheck, for
 * instance — reaches the identical verdict without a second query.
 */
export function decideCollectionEligibility(
  candidate: CollectionCandidate,
  facts: CollectionReadFacts,
  now: Date
): CollectionEligibilityOutcome {
  const invalid = findInvalidCandidate(candidate);
  if (invalid) return refusal("invalid_input", invalid);
  if (isSourceBoundCollectionClass(candidate.payloadClass) && !facts.bindingResolved) {
    return refusal(
      "unsupported_source_binding",
      `source binding ${candidate.source?.sourceRef}/${candidate.source?.sourceVersion} is not in the store`
    );
  }

  const anchorMs = instantMs(candidate.anchorAt);
  if (anchorMs === null) {
    // Unreachable: `findInvalidCandidate` refused the same value above. Kept
    // because this entry is exported and must not trust its caller.
    return refusal("invalid_input", "anchorAt must be an ISO 8601 datetime with a timezone");
  }

  const rowUntil = rowProtectedUntilMs(candidate, facts, anchorMs);
  const earliestCandidateAt = earliestCandidateMs(candidate, facts, anchorMs, rowUntil);
  const blockingReasons = collectBlockingReasons(facts, now, earliestCandidateAt, rowUntil);

  return {
    refused: false,
    eligibility: {
      payloadClass: candidate.payloadClass,
      eligible: blockingReasons.length === 0,
      earliestCandidateAt: new Date(earliestCandidateAt).toISOString(),
      physicalPurgeNotBefore: new Date(
        earliestCandidateAt + COLLECTION_MARK_GRACE_DAYS * COLLECTION_DAY_MS
      ).toISOString(),
      blockingReasons,
      nextEvaluationAt: nextEvaluationText(
        blockingReasons,
        facts,
        now,
        earliestCandidateAt,
        rowUntil
      ),
      ignoredCountGrants: facts.countOnlyGrants.map((grant) => grant.evidenceRef),
    },
  };
}

/**
 * The class deadline, before row-reference protection.
 *
 * `expired_snapshot` is the one class with no offset: the retention table puts
 * its deadline at reference expiry itself. Its second arm — authorized purge —
 * belongs to MP16 and arrives as an authorized request, not as a deadline this
 * function could compute.
 */
function classDeadlineMs(
  candidate: CollectionCandidate,
  anchorMs: number
): number {
  switch (candidate.payloadClass) {
    case "attempt_stage":
      return anchorMs + ATTEMPT_STAGE_GRACE_DAYS * COLLECTION_DAY_MS;
    case "derived_generation":
      return anchorMs + DERIVED_REPLACEMENT_GRACE_DAYS * COLLECTION_DAY_MS;
    case "retired_unreferenced":
      return anchorMs + RETIRED_PAYLOAD_DEADLINE_DAYS * COLLECTION_DAY_MS;
    case "retired_evidence_protected":
      return anchorMs + RETIRED_PAYLOAD_DEADLINE_DAYS * COLLECTION_DAY_MS;
    case "job_detailed_logs":
      return anchorMs + JOB_LOG_DEADLINE_DAYS * COLLECTION_DAY_MS;
    case "expired_snapshot":
      return anchorMs;
  }
}

/**
 * When an unexpired row grant stops protecting this payload's content.
 *
 * Spec 278-280 applies this to EVERY class: eligibility additionally requires no
 * unexpired row-evidence content dependency, so a live row reference holds the
 * payload until it expires and an expired one releases it at that instant — the
 * grant is finite and never renewed by a read.
 *
 * For the protected-evidence class the window is also closed at retirement + 365
 * days. The cap has to bound the PROTECTION, not only the reported deadline: a
 * reference issued after the retirement could otherwise outlive the cap and hold
 * a payload past the year the evidence contract fixes for any one reference, which
 * would make the cap a field nobody could act on. A current dependency is exempt,
 * which is the spec's own condition on the cap.
 *
 * A count grant is absent here by construction. `rowReferences` carries row
 * grants only, and a count grant has no row in the set to extend the deadline.
 */
function rowProtectedUntilMs(
  candidate: CollectionCandidate,
  facts: CollectionReadFacts,
  anchorMs: number
): number | null {
  if (facts.rowReferences.length === 0) return null;
  const lastExpiry = Math.max(
    ...facts.rowReferences.map((ref) => expiryMs(ref.expiresAt))
  );
  if (candidate.payloadClass !== "retired_evidence_protected") return lastExpiry;
  if (facts.currentDependencies.length > 0) return lastExpiry;
  // The cap cannot shorten a protection whose expiry cannot be read: not knowing
  // when a reference ends is not evidence that it ends inside the year.
  if (!Number.isFinite(lastExpiry)) return lastExpiry;
  return Math.min(lastExpiry, anchorMs + ROW_REFERENCE_CAP_DAYS * COLLECTION_DAY_MS);
}

/**
 * The earliest instant the candidate may become eligible on its own.
 *
 * For `retired_evidence_protected` this is the later of retirement + 90 days and
 * the protected window, which `rowProtectedUntilMs` has already closed at the
 * + 365-day cap. For every other class it is the class deadline: the
 * row-reference block still applies there, but it does not move the deadline,
 * because a payload that is not the protected-evidence class was never granted
 * the extension.
 */
function earliestCandidateMs(
  candidate: CollectionCandidate,
  facts: CollectionReadFacts,
  anchorMs: number,
  rowUntilMs: number | null
): number {
  const classDeadline = classDeadlineMs(candidate, anchorMs);
  if (candidate.payloadClass !== "retired_evidence_protected" || rowUntilMs === null) {
    return classDeadline;
  }
  const extended = Math.max(classDeadline, rowUntilMs);
  // An unreadable expiry leaves a finite, honest deadline to report: the class
  // deadline, under a protection that `row_content_reference` holds open.
  const deadline = Number.isFinite(extended) ? extended : classDeadline;
  if (facts.currentDependencies.length > 0) return deadline;
  return Math.min(deadline, anchorMs + ROW_REFERENCE_CAP_DAYS * COLLECTION_DAY_MS);
}

/** Unexpired row references, as absolute instants. */
/**
 * An expiry that cannot be read is treated as never expiring.
 *
 * A protection whose deadline cannot be established must not be dropped: the read
 * succeeded, so the collector cannot claim the payload is free, and quietly
 * ignoring one reference is how a protected payload gets deleted early.
 */
function expiryMs(value: unknown): number {
  return instantMs(value) ?? Number.POSITIVE_INFINITY;
}

function collectBlockingReasons(
  facts: CollectionReadFacts,
  now: Date,
  earliestCandidateAt: number,
  rowUntilMs: number | null
): CollectionEligibility["blockingReasons"] {
  const nowMs = now.getTime();
  const reasons: CollectionBlockingReason[] = [];
  if (facts.payloadCollected) reasons.push("already_collected");
  if (facts.currentDependencies.length > 0) reasons.push("current_dependency");
  if (hasValidLease(facts.validLeases, nowMs)) reasons.push("valid_lease");
  if (rowUntilMs !== null && nowMs < rowUntilMs) reasons.push("row_content_reference");
  if (nowMs < earliestCandidateAt) reasons.push("deadline_not_reached");
  return reasons;
}

/**
 * Whether any lease is still valid. The comparison is `>=`, matching the durable
 * work fence: the instant a lease expires is already outside it, so the collector
 * and the ledger cannot disagree about whether a worker still holds it.
 */
function hasValidLease(leases: readonly CollectionLease[], nowMs: number): boolean {
  return leases.some((lease) => nowMs < expiryMs(lease.expiresAt));
}

/**
 * The earliest instant a blocker can clear without a lifecycle event.
 *
 * Null means either "eligible now" or "held by something no clock reading
 * releases". Those are different answers and a scheduler must not read the second
 * as the first, which is why a current dependency returns null rather than the
 * nearest deadline.
 */
function nextEvaluationText(
  reasons: readonly CollectionBlockingReason[],
  facts: CollectionReadFacts,
  now: Date,
  earliestCandidateAt: number,
  rowUntilMs: number | null
): string | null {
  if (reasons.length === 0) return null;
  if (reasons.includes("current_dependency")) return null;

  const nowMs = now.getTime();
  const candidates: number[] = [];
  if (nowMs < earliestCandidateAt) candidates.push(earliestCandidateAt);
  if (rowUntilMs !== null && nowMs < rowUntilMs) candidates.push(rowUntilMs);
  for (const lease of facts.validLeases) {
    const expiresAtMs = expiryMs(lease.expiresAt);
    if (nowMs < expiresAtMs) candidates.push(expiresAtMs);
  }
  if (candidates.length === 0) return null;
  const soonest = Math.min(...candidates);
  // An unreadable expiry has no instant to schedule against; only a re-read or a
  // lifecycle event can clear it.
  return Number.isFinite(soonest) ? new Date(soonest).toISOString() : null;
}

/**
 * What makes a candidate unusable before any read.
 *
 * The anchor is checked here, not only in the decision, so a malformed candidate
 * never reaches the store at all.
 *
 * A source-bound class without its binding is refused here rather than treated as
 * an unblocked payload: the retention table's deadlines run from a lifecycle
 * instant that a class without a lifecycle does not have.
 */
function findInvalidCandidate(candidate: CollectionCandidate): string | null {
  if (!isCollectionPayloadClass(candidate?.payloadClass)) {
    return "payloadClass must be one of the six retention-table payload classes";
  }
  if (typeof candidate.payloadRef !== "string" || candidate.payloadRef.trim().length === 0) {
    return "payloadRef is required";
  }
  if (instantMs(candidate.anchorAt) === null) {
    return "anchorAt must be an ISO 8601 datetime with a timezone";
  }
  if (!isSourceBoundCollectionClass(candidate.payloadClass)) return null;
  return isFilledBinding(candidate.source)
    ? null
    : `${candidate.payloadClass} requires a sourceRef, sourceVersion and non-negative sourceGeneration`;
}

/** Whether a source binding names a version with a non-negative generation. */
function isFilledBinding(source: CollectionCandidate["source"]): boolean {
  if (source === null) return false;
  return (
    typeof source.sourceRef === "string" &&
    source.sourceRef.trim().length > 0 &&
    typeof source.sourceVersion === "string" &&
    source.sourceVersion.trim().length > 0 &&
    Number.isInteger(source.sourceGeneration) &&
    source.sourceGeneration >= 0
  );
}

function refusal(
  code: MaintenanceWorkFailureCode,
  detail: string
): CollectionEligibilityOutcome {
  return { refused: true, code, detail };
}

/**
 * One instant as milliseconds, or null when the spelling is not an unambiguous
 * instant. A date-only or offset-less value is ambiguous, and a retention
 * deadline computed from one would not be a promise about a single moment.
 */
function instantMs(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_INSTANT_RE.test(value)) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || Math.abs(parsed) > MAX_INSTANT_MS) return null;
  return parsed;
}