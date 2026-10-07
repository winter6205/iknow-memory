/**
 * MP14 collection-mark decisions (fin specs/structured-corpus-maintenance.md
 * §Physical collection, lines 302-304 and 307).
 *
 * Pure, on the same terms as `collector-eligibility.ts`: a function of its request
 * and an injected instant, with no clock read, no storage and no I/O. The lane that
 * owns the transaction composes these; they decide, the lane persists.
 *
 * Three decisions, and the order the spec fixes between them:
 *
 * 1. `planCollectionMark` — record that a candidate reached eligibility. Refuses an
 *    ineligible candidate outright, because a mark on a payload that still has a
 *    live dependency or an unreached deadline is a lie the recheck would have to
 *    disbelieve.
 * 2. `recheckCollectionMark` — after the grace, decide whether the mark still holds.
 *    Spec:307 is the whole rule: if the revision changed, cancel and re-evaluate,
 *    never delete against the earlier scan.
 * 3. `planCollectionReactivation` — cancel the mark so dependencies may be created
 *    again (spec:304). It returns a plan and does not create anything: the caller
 *    creates dependencies after this returns, which is the ordering the spec's
 *    "transactionally cancel the mark BEFORE creating dependencies" requires.
 *
 * Nothing here deletes, and nothing here marks a source version's obligations: the
 * pure layer states *that* the effect applies, via `CollectionMarkPlan.stopsObligations`,
 * and the lane applies it inside the same transaction as the mark.
 */
import { isSourceBoundCollectionClass } from "./collector-eligibility.js";
import type {
  CollectionMarkIdentity,
  CollectionMark,
  CollectionMarkCancellationOutcome,
  CollectionMarkObservation,
  CollectionMarkOutcome,
  CollectionMarkRecheckOutcome,
  CollectionMarkRequest,
  CollectionReactivateOutcome,
  CollectionReactivationRequest,
} from "./collection-mark-types.js";
import type { MaintenanceWorkFailureCode } from "./types.js";

/** Same instant spelling the evidence contract and MP13 both require. */
const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const MAX_INSTANT_MS = 8_640_000_000_000_000;

/** A decimal, unsigned, with no sign and no leading zeros beyond a bare `0`. */
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;

/**
 * Plan a mark for a candidate MP13 has already found eligible.
 *
 * The eligibility value is taken as given rather than recomputed: MP13 exports
 * `decideCollectionEligibility` precisely so a caller holding facts from its own
 * read reaches the identical verdict without a second query, and a mark decided
 * against a *different* read than the one the recheck will use is how a mark and a
 * scan come to disagree about the same payload.
 */
export function planCollectionMark(
  request: CollectionMarkRequest,
  now: Date
): CollectionMarkOutcome {
  const invalid = findInvalidMarkRequest(request);
  if (invalid) return refusal("invalid_input", invalid);

  if (!request.eligibility.eligible) {
    return refusal(
      "invalid_input",
      `payload ${request.payloadRef} is not eligible to be marked; it is held by ${request.eligibility.blockingReasons.join(", ")}`
    );
  }
  if (request.eligibility.payloadClass !== request.payloadClass) {
    return refusal(
      "invalid_input",
      `eligibility is for payload class ${request.eligibility.payloadClass}, not ${request.payloadClass}`
    );
  }

  const deadlineMs = instantMs(request.eligibility.physicalPurgeNotBefore);
  if (deadlineMs === null) {
    return refusal(
      "invalid_input",
      "eligibility.physicalPurgeNotBefore must be an ISO 8601 datetime with a timezone"
    );
  }

  const mark: CollectionMark = {
    payloadClass: request.payloadClass,
    payloadRef: request.payloadRef,
    scopeBinding: request.scopeBinding,
    sourceVersionId: request.sourceVersionId,
    expectedLifecycleRevision: request.lifecycleRevision,
    // The deadline is the purge floor, not the candidate instant: a payload
    // retired on day 0 is a candidate on day 90 and deletable on day 97, and a
    // mark that recorded day 90 would let MP15 delete seven days early.
    deadlineAt: new Date(deadlineMs).toISOString(),
    markedAt: now.toISOString(),
    state: "marked",
    cancelledAt: null,
    cancelledReason: null,
  };
  return {
    refused: false,
    plan: {
      mark,
      stopsObligations: isSourceBoundCollectionClass(request.payloadClass),
    },
  };
}

/**
 * Decide whether a persisted mark still holds.
 *
 * `stale` and `deadlineReached` are independent on purpose. A mark past its
 * deadline whose revision also moved must be cancelled and re-evaluated, not
 * deleted — that is the case a boolean "ready to delete" would get wrong, because
 * the deadline alone would say yes.
 */
export function recheckCollectionMark(
  mark: CollectionMark,
  observed: CollectionMarkObservation
): CollectionMarkRecheckOutcome {
  if (mark.state !== "marked") {
    return refusal(
      "input_stale",
      `mark for ${mark.payloadRef} is ${mark.state}, not marked`
    );
  }
  if (typeof observed.lifecycleRevision !== "string" || !DECIMAL_RE.test(observed.lifecycleRevision)) {
    return refusal(
      "invalid_input",
      "observed lifecycleRevision must be a decimal revision string"
    );
  }
  const deadlineMs = instantMs(mark.deadlineAt);
  if (deadlineMs === null) {
    return refusal("invalid_input", "mark.deadlineAt is not an unambiguous instant");
  }
  const nowMs = observed.now.getTime();
  if (Number.isNaN(nowMs)) {
    return refusal("invalid_input", "observed.now must be a valid Date");
  }

  return {
    refused: false,
    recheck: {
      identity: { payloadClass: mark.payloadClass, payloadRef: mark.payloadRef },
      scopeBinding: mark.scopeBinding,
      observedLifecycleRevision: observed.lifecycleRevision,
      deadlineReached: nowMs >= deadlineMs,
      stale: observed.lifecycleRevision !== mark.expectedLifecycleRevision,
    },
  };
}

/**
 * Plan the cancellation a reactivation requires before it creates dependencies
 * (spec:304).
 *
 * Two refusals are load-bearing:
 *
 * - A payload that is already collected cannot be reactivated. Spec:311 forbids a
 *   stale worker resurrecting a deleted identity, and "reactivating" a deleted
 *   payload is exactly that request arriving late.
 * - A revision that moved since the caller read it is refused rather than applied,
 *   so the caller cannot cancel a mark against a world it never observed.
 *
 * `resumedObligations` is false when no mark was stopping any, which is the normal
 * case for the two object-scoped classes and for a reactivation of an already
 * cancelled mark.
 */
export function planCollectionReactivation(
  request: CollectionReactivationRequest,
  now: Date
): CollectionReactivateOutcome {
  const invalid = findInvalidReactivationRequest(request);
  if (invalid) return refusal("invalid_input", invalid);

  if (request.payloadCollected) {
    return refusal(
      "input_stale",
      `payload ${request.payloadRef} is already collected and cannot be reactivated`
    );
  }
  if (request.expectedLifecycleRevision !== request.observedLifecycleRevision) {
    return refusal(
      "input_stale",
      `scope revision moved from ${request.expectedLifecycleRevision} to ${request.observedLifecycleRevision}`
    );
  }
  if (Number.isNaN(now.getTime())) {
    return refusal("invalid_input", "now must be a valid Date");
  }

  return {
    refused: false,
    plan: {
      identity: { payloadClass: request.payloadClass, payloadRef: request.payloadRef },
      scopeBinding: request.scopeBinding,
      sourceVersionId: request.sourceVersionId,
      resumedObligations: request.obligationsStopped,
      cancelledAt: now.toISOString(),
      reason: "reactivated",
    },
  };
}

/**
 * Plan the cancellation a stale recheck demands (spec:307).
 *
 * This is the other half of "cancelled or re-evaluated". `recheckCollectionMark`
 * only reports that a mark went stale; without a way to record that cancellation
 * the report has no consequence and the stale mark would still be sitting there for
 * MP15 to find. The reason is distinct from `reactivated` on purpose: a mark
 * cancelled because the world moved is evidence the recheck ran, and collapsing it
 * into the reactivation reason would make a stale mark indistinguishable from one a
 * caller deliberately undid.
 */
export function planStaleMarkCancellation(
  identity: CollectionMarkIdentity,
  now: Date
): CollectionMarkCancellationOutcome {
  if (typeof identity?.payloadRef !== "string" || identity.payloadRef.trim().length === 0) {
    return refusal("invalid_input", "payloadRef is required");
  }
  if (Number.isNaN(now.getTime())) {
    return refusal("invalid_input", "now must be a valid Date");
  }
  return {
    refused: false,
    cancellation: {
      identity,
      cancelledAt: now.toISOString(),
      reason: "lifecycle_revision_changed",
    },
  };
}

/**
 * What makes a mark unusable before any store is touched.
 *
 * A source-bound class must carry the source version it stops obligations on: a
 * source-bound mark whose `sourceVersionId` is null would set an effect on nothing
 * while still reporting itself marked. The two object-scoped classes must NOT carry
 * one, because they have no source version and a lane that wrote it would be
 * stamping a row that does not exist.
 */
function findInvalidMarkRequest(request: CollectionMarkRequest): string | null {
  const identity = findInvalidMarkIdentity(request);
  if (identity !== null) return identity;
  if (!isDecimal(request.lifecycleRevision)) {
    return "lifecycleRevision must be the decimal revision the mark commits at";
  }
  if (request.eligibility === undefined || request.eligibility === null) {
    return "eligibility is required; a mark is planned against a decided candidate";
  }
  return null;
}

/** The reactivation twin of {@link findInvalidMarkRequest}. */
function findInvalidReactivationRequest(
  request: CollectionReactivationRequest
): string | null {
  const identity = findInvalidMarkIdentity(request);
  if (identity !== null) return identity;
  if (!isDecimal(request.expectedLifecycleRevision)) {
    return "expectedLifecycleRevision must be a decimal revision string";
  }
  if (!isDecimal(request.observedLifecycleRevision)) {
    return "observedLifecycleRevision must be a decimal revision string";
  }
  return null;
}

/**
 * The checks every mark-shaped request shares, whatever it is asking for.
 *
 * A source-bound class must carry the source version it stops obligations on: a
 * source-bound mark whose `sourceVersionId` is null would set an effect on nothing
 * while still reporting itself marked. The two object-scoped classes must NOT carry
 * one, because they have no source version and a lane that wrote it would be
 * stamping a row that does not exist.
 *
 * One helper rather than one per request type, because a mark and a reactivation
 * that disagree about whether a source-bound class needs a source version would
 * each be internally consistent and jointly wrong.
 */
function findInvalidMarkIdentity(
  request: CollectionMarkIdentity & {
    readonly scopeBinding: string;
    readonly sourceVersionId: string | null;
  }
): string | null {
  if (isBlank(request?.payloadRef)) return "payloadRef is required";
  if (isBlank(request.scopeBinding)) return "scopeBinding is required";
  const sourceBound = isSourceBoundCollectionClass(request.payloadClass);
  const hasSource = !isBlank(request.sourceVersionId);
  if (sourceBound !== hasSource) {
    return sourceBound
      ? `${request.payloadClass} is source-bound and requires a sourceVersionId`
      : `${request.payloadClass} is object-scoped and has no source version`;
  }
  return null;
}

/** A decimal, unsigned, with no sign and no leading zeros beyond a bare `0`. */
function isDecimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_RE.test(value);
}

/** A string that is absent, empty, or only whitespace. */
function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function refusal(
  code: MaintenanceWorkFailureCode,
  detail: string
): CollectionMarkOutcome &
  CollectionReactivateOutcome &
  CollectionMarkRecheckOutcome &
  CollectionMarkCancellationOutcome {
  return { refused: true, code, detail };
}

/** One instant as milliseconds, or null when the spelling is not unambiguous. */
function instantMs(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_INSTANT_RE.test(value)) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || Math.abs(parsed) > MAX_INSTANT_MS) return null;
  return parsed;
}
