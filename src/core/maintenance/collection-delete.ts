/**
 * MP15 resumable deletion — the plan half (fin
 * `specs/structured-corpus-maintenance.md` §Physical collection, lines 309-314,
 * 335-336; plan §"The phase vocabulary"; ADR 0099 §2.1).
 *
 * Pure, on the same terms as MP13's `collector-eligibility.ts` and MP14's
 * `collection-mark.ts`: a function of its request, one read's facts and an
 * injected instant. No clock read, no storage, no I/O. The store that owns the
 * transaction composes this; the pure layer decides, the lane persists.
 *
 * **Keying.** Every statement this plan authorizes is keyed on
 * `source_version_id`, never on a content hash or an object ref. Spec:312
 * forbids "deletion by one logical source's hash alone", and a hash key is
 * exactly that — two logical sources may name one original object, so the only
 * column that identifies THIS payload's rows is the version id. The store still
 * counts live references to `content_digest` and `origin_object_ref` exactly,
 * because nothing in the schema prevents sharing and an exact count is the only
 * mechanism the store has for spec:312 — but the counts are REPORTED, never
 * gating, because MP15 removes no shared object.
 *
 * **The refusal vocabulary is closed and not widened.** Every refusal below is
 * one of the nine `MAINTENANCE_WORK_FAILURE_CODES`, in the MP13/MP14
 * `{refused, code, detail}` shape.
 */
import type {
  CollectionMarkIdentity,
  CollectionMark,
} from "./collection-mark-types.js";
import type { CollectionPayloadClass } from "./collector-types.js";
import type { MaintenanceWorkFailureCode } from "./types.js";

/** Same instant spelling the evidence contract, MP13 and MP14 all require. */
const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const MAX_INSTANT_MS = 8_640_000_000_000_000;
/** A decimal, unsigned, with no sign and no leading zeros beyond a bare `0`. */
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;

/**
 * The five delete phases, in the order spec:310 lists them, one phase per
 * removable row set. `collected` is deliberately absent: it is not a delete but
 * the terminal stamp (the mark row's replacement and `payload_collected_at`),
 * which the store writes after the last phase commits — never inside this
 * vocabulary, where a member would read as a removable row set.
 *
 * The order is the dependency order the schema's foreign keys fix:
 *
 * 1. `dependent_supports` — the grant pins (`evidence_grant_supports`,
 *    `evidence_grant_extractions`) that RESTRICT-delete against this payload's
 *    supports and extractions. Nothing below them can go first.
 * 2. `extraction_payloads` — `support_extractions`, once their grant pins are
 *    gone.
 * 3. `assertion_supports` — the occurrences, once the extractions that hang off
 *    them and the grant pins that name them are gone.
 * 4. `frozen_units` — `source_version_locators`, the frozen unit rows. CASCADE
 *    from the version would take them silently; listing the phase keeps the
 *    step resumable and its count observable.
 * 5. `superseded_caches` — `structured_publication_extraction_bindings`, whose
 *    `(source_ref, source_version)` FK is NO ACTION against the version, so it
 *    must be out of the way before the identity stamp ends the record.
 *
 * `snapshot_payloads` from spec:310 has no phase here: fin owns the answer
 * snapshots (spec:13, :314-315), and the backend's half of that boundary is
 * MP16's durable invalidation event plus MP17's owner acknowledgement. The
 * omission is a decision recorded in the plan, not a silence.
 */
export const COLLECTION_DELETE_PHASES = [
  "dependent_supports",
  "extraction_payloads",
  "assertion_supports",
  "frozen_units",
  "superseded_caches",
] as const;

export type CollectionDeletePhase =
  (typeof COLLECTION_DELETE_PHASES)[number];

/** Whether a value names one of the five deletion phases. */
export function isCollectionDeletePhase(value: unknown): value is CollectionDeletePhase {
  return (
    typeof value === "string" &&
    (COLLECTION_DELETE_PHASES as readonly string[]).includes(value)
  );
}

/** The one payload class MP15's local delete transaction owns. */
const DELETABLE_CLASSES: readonly CollectionPayloadClass[] = [
  "retired_unreferenced",
];

/**
 * One deletion, as the caller knows it.
 *
 * `purgeRevision` is the MP16 tombstone revision this deletion collects under,
 * and it is the idempotency key of the progress row and of the ADR 0099 §2.1
 * `collected` write — a retry presents the same revision and rejoins what
 * committed instead of starting a second deletion.
 */
export interface CollectionDeleteRequest {
  readonly identity: CollectionMarkIdentity;
  readonly scopeBinding: string;
  readonly purgeRevision: string;
}

/**
 * What one read found, taken under the transaction's locks.
 *
 * `lifecycleRevision` is the scope's live `maintenance_revision` read INSIDE
 * the same locks the deletes run under — the same re-read MP14's post-grace
 * recheck performs — so a payload protected by a dependency created after the
 * mark cannot look free here.
 */
export interface CollectionDeleteFacts {
  /** The persisted mark, or null when this payload was never marked. */
  readonly mark: CollectionMark | null;
  readonly lifecycleRevision: string;
  /** The source version exists in the store. */
  readonly bindingResolved: boolean;
  /** `payload_collected_at` is already set: this call arrived after the work. */
  readonly payloadCollected: boolean;
  /** Grants of kind `row`, unexpired, whose supports reach this payload. */
  readonly liveRowGrants: readonly string[];
  readonly now: Date;
}

/** The plan one accepted decision produces. */
export interface CollectionDeletePlan {
  readonly identity: CollectionMarkIdentity;
  readonly scopeBinding: string;
  readonly sourceVersionId: string;
  readonly purgeRevision: string;
  /** The mark's own deadline, carried through so the store can log what it
   *  honoured without re-deriving it from a scan it no longer has. */
  readonly deadlineAt: string;
  /** Every phase, in order. The store crosses this set off from the front. */
  readonly phases: readonly CollectionDeletePhase[];
}

export type CollectionDeleteOutcome =
  | {
      readonly refused: true;
      readonly code: MaintenanceWorkFailureCode;
      readonly detail: string;
    }
  | { readonly refused: false; readonly plan: CollectionDeletePlan };

/**
 * Decide whether this payload's rows may be deleted now, and by which phases.
 *
 * The checks run in the order the spec fixes them: identity, then the mark's
 * state, then the world the recheck looks at (binding, collection, live
 * references, revision), then the deadline. A refusal returned here leaves the
 * caller nothing to roll back.
 */
export function planCollectionDelete(
  request: CollectionDeleteRequest,
  facts: CollectionDeleteFacts
): CollectionDeleteOutcome {
  const invalid = findInvalidRequest(request);
  if (invalid !== null) return refusal("invalid_input", invalid);

  // The class gate before anything else, because a payload whose retention
  // clock this transaction does not own must never reach a mark check at all.
  if (!DELETABLE_CLASSES.includes(request.identity.payloadClass)) {
    return refusal(
      "invalid_input",
      `payload class ${request.identity.payloadClass} is not a local-delete class`
    );
  }

  const nowMs = facts.now.getTime();
  if (Number.isNaN(nowMs)) {
    return refusal("invalid_input", "facts.now must be a valid Date");
  }

  const markRow = facts.mark;
  if (markRow === null) {
    return refusal(
      "input_stale",
      `payload ${request.identity.payloadRef} has no collection mark to delete against`
    );
  }

  // The gates over the mark's own row, then the world the recheck looks at.
  // Splitting the chains keeps each refusal's detail beside its condition
  // without letting the plan grow past the complexity line.
  const markRefusal = refuseMarkMismatch(request, markRow);
  if (markRefusal !== null) return markRefusal;

  const worldRefusal = refuseMovedWorld(request, facts, markRow);
  if (worldRefusal !== null) return worldRefusal;

  // The helpers' null-checks above prove sourceVersionId is a keyed string from
  // here on; the non-null assertion carries that proof where the type cannot.
  const sourceVersionId = markRow.sourceVersionId as string;

  const deadlineMs = instantMs(markRow.deadlineAt);
  if (deadlineMs === null) {
    return refusal("invalid_input", "mark.deadlineAt is not an unambiguous instant");
  }
  if (nowMs < deadlineMs) {
    return refusal(
      "input_stale",
      `payload ${request.identity.payloadRef} deletion deadline is ${markRow.deadlineAt}`
    );
  }

  return {
    refused: false,
    plan: {
      identity: { ...request.identity },
      scopeBinding: request.scopeBinding,
      sourceVersionId,
      purgeRevision: request.purgeRevision,
      deadlineAt: markRow.deadlineAt,
      phases: [...COLLECTION_DELETE_PHASES],
    },
  };
}

/**
 * The mark's own consistency: right payload, live state, this scope, a keyed
 * row set. Each is a precondition the mark row states about itself, checked
 * before the world is consulted.
 */
function refuseMarkMismatch(
  request: CollectionDeleteRequest,
  markRow: CollectionMark
): CollectionDeleteOutcome | null {
  if (markRow.payloadRef !== request.identity.payloadRef) {
    return refusal(
      "input_stale",
      `the persisted mark names payload ${markRow.payloadRef}, not ${request.identity.payloadRef}`
    );
  }
  if (markRow.state !== "marked") {
    return refusal(
      "input_stale",
      `payload ${request.identity.payloadRef} is ${markRow.state}, not marked; a cancelled mark must be re-evaluated before any deletion`
    );
  }
  if (markRow.scopeBinding !== request.scopeBinding) {
    return refusal(
      "access_denied",
      `the mark for ${request.identity.payloadRef} belongs to scope ${markRow.scopeBinding}, not ${request.scopeBinding}`
    );
  }
  if (typeof markRow.sourceVersionId !== "string" || markRow.sourceVersionId.length === 0) {
    return refusal(
      "invalid_input",
      `the mark for ${request.identity.payloadRef} names no source version, so no row set can be keyed`
    );
  }
  return null;
}

/**
 * The world the recheck looks at: binding resolution, collection state, live
 * row references and the revision fence. input_stale, not invalid_input, for
 * the world-shaped ones: the facts are store-read, so nothing about the request
 * is malformed — the mark's premise no longer holds, the same "world moved"
 * shape as a revision that moved.
 */
function refuseMovedWorld(
  request: CollectionDeleteRequest,
  facts: CollectionDeleteFacts,
  markRow: CollectionMark
): CollectionDeleteOutcome | null {
  if (!facts.bindingResolved) {
    return refusal(
      "unsupported_source_binding",
      `source version ${markRow.sourceVersionId} is not held by the store`
    );
  }
  if (facts.payloadCollected) {
    return refusal(
      "input_stale",
      `payload ${request.identity.payloadRef} is already collected`
    );
  }
  if (facts.liveRowGrants.length > 0) {
    // input_stale, not invalid_input: the facts are store-read, so nothing about
    // the request is malformed — the mark's premise (no live row reference,
    // spec:278) no longer holds, which is the same "world moved" shape as a
    // revision that moved.
    return refusal(
      "input_stale",
      `payload ${request.identity.payloadRef} is still held by live row grants: ${facts.liveRowGrants.join(", ")}`
    );
  }
  if (
    typeof facts.lifecycleRevision !== "string" ||
    !DECIMAL_RE.test(facts.lifecycleRevision) ||
    facts.lifecycleRevision !== markRow.expectedLifecycleRevision
  ) {
    return refusal(
      "input_stale",
      `scope revision moved from ${markRow.expectedLifecycleRevision} to ${facts.lifecycleRevision}; never delete against an earlier scan`
    );
  }
  return null;
}

/**
 * The phases one attempt still has to run.
 *
 * `committed` carries the phases a previous attempt already recorded, and
 * `through` bounds the attempt so a crash-resume can take one phase per
 * transaction instead of re-running the whole tail. Both are filtered against
 * the closed vocabulary in order, so a caller cannot reorder the deletes by
 * passing its own list.
 */
export function remainingDeletePhases(
  committed: readonly unknown[],
  through?: CollectionDeletePhase
): readonly CollectionDeletePhase[] {
  const done = new Set(
    committed.filter((value): value is CollectionDeletePhase =>
      isCollectionDeletePhase(value)
    )
  );
  const remaining = COLLECTION_DELETE_PHASES.filter((phase) => !done.has(phase));
  if (through === undefined) return remaining;
  const bound = remaining.indexOf(through);
  return bound === -1 ? [] : remaining.slice(0, bound + 1);
}

function findInvalidRequest(request: CollectionDeleteRequest): string | null {
  if (!request || typeof request !== "object") return "request is required";
  const identity = request.identity;
  if (!identity || typeof identity !== "object") return "identity is required";
  const identityInvalid = findInvalidIdentity(identity);
  if (identityInvalid !== null) return identityInvalid;
  if (!isFilledText(request.scopeBinding)) return "scopeBinding is required";
  if (!isFilledText(request.purgeRevision)) return "purgeRevision is required";
  return null;
}

/** The identity's two fields: a class from the closed set and a non-blank ref. */
function findInvalidIdentity(
  identity: CollectionDeleteRequest["identity"]
): string | null {
  if (!isCollectionPayloadClass(identity?.payloadClass)) {
    return "payloadClass must be one of the six retention-table payload classes";
  }
  if (!isFilledText(identity?.payloadRef)) return "payloadRef is required";
  return null;
}

function isFilledText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCollectionPayloadClass(value: unknown): value is CollectionPayloadClass {
  return (
    typeof value === "string" &&
    [
      "attempt_stage",
      "derived_generation",
      "retired_unreferenced",
      "retired_evidence_protected",
      "job_detailed_logs",
      "expired_snapshot",
    ].includes(value)
  );
}

function refusal(
  code: MaintenanceWorkFailureCode,
  detail: string
): CollectionDeleteOutcome {
  return { refused: true, code, detail };
}

/** One instant as milliseconds, or null when the spelling is not unambiguous. */
function instantMs(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_INSTANT_RE.test(value)) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || Math.abs(parsed) > MAX_INSTANT_MS) return null;
  return parsed;
}
