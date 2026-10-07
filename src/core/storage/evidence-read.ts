/**
 * The private Evidence read (specs/structured-corpus-evidence.md "Internal
 * evidence capability"), reached only over the host-internal
 * `corpus_evidence` JSON-RPC method.
 *
 * Three properties decide this module, and each one is a boundary rather than a
 * feature:
 *
 *  1. **It returns the stored value.** `read` hands back the exact `value`
 *    column and the exact `context` column of one retained grant. It runs no
 *     query: the only statements on the path are the fixed evidence/scope
 *     statements in `evidence-pg.ts`, and no query-executor module is imported
 *     here or by anything this module calls. A row that has since changed in the
 *     current corpus therefore cannot leak into a historical read, and a read
 *     cannot be made to observe a value the grant never froze.
 *
 *  2. **Nothing is disclosed until every check has passed.** Permission and
 *     scope are decided first, then the shared `decideGrantRead` order (lifetime,
 *     authorization revision, purge revision, obligations, divisibility). A
 *     denied grant is a typed refusal carrying a code and a reason and no field
 *     of the row — the failure arm never reaches the renderer at all, so there is
 *     no path on which a partial row is emitted.
 *
 *  3. **A whole obligation or nothing.** `decideGrantRead` withholds a row grant
 *     whose dependency set is shorter than the one it pinned, and refuses any
 *     grant touching a source version whose obligations stopped. Both refusals
 *     are total: the rows they would have covered are not partially disclosed.
 *
 * The read runs inside `withAuthorizedScope`, which is the seam the B1 decision
 * names. That gives the read one client, one transaction, one lock order, the
 * live deadline, and — through `assertCurrentAuthorization` — a fence against a
 * concurrent revocation, in the same unit of work that reads the grant. The
 * scope's authorization revision and the grant's authorization revision are read
 * from the same `evidence_scope_revisions` row, so one seeded value closes both.
 *
 * The `supports` action reaches the same seam rather than a second one. It hands
 * `decideSupportContinuation` the scope's own `work.client`, exactly as `read`
 * hands it to `readGrantFacts`, because the scope unit of work already issued the
 * BEGIN and owns the COMMIT and the release. `readGrantSupportContinuation` would
 * open a nested BEGIN, commit the scope's unit of work before its deferred
 * revision advance, and release the connection from inside the scope — collapsing
 * the authorization fence above. The transaction bracket is the scope's, so a
 * selector decision and the grant facts it is decided against are one statement
 * set under one fence.
 *
 * **`invalidations` is answered by a sibling module, and this one still refuses
 * it.** The drain reads a per-consumer stream rather than a grant, so it needs
 * the checkpoint key and a cursor position this reader does not hold;
 * `evidence-invalidation-read.ts` owns both. What stays HERE is the envelope, the
 * request parse and the refusal, because the contract is one: a request that
 * names the action reaches this parser whether or not this function is the seam
 * that answers it, and an action routed here must be a typed refusal rather than
 * a crash or a grant read keyed on nothing.
 *
 * **`ack` is the same arrangement, one seam further out.** It is answered by
 * `evidence-invalidation-ack.ts`, which is a WRITE in its own transaction because
 * register §1.5 makes it re-verify what it advances through; the envelope, the
 * request parse and the mis-route refusal are still here, for the same reason.
 * The fence below is therefore closed: the spec's action union at
 * `specs/structured-corpus-evidence.md:220-227` is fully named and every member
 * has a seam that can honour it.
 */
import {
  EVIDENCE_DENIAL_REASON,
  EVIDENCE_FAILURE,
  EVIDENCE_GRANT_KIND,
  type EvidenceDenialReason,
  type EvidenceGrantRead,
  type EvidenceSupportRef,
} from "../types.js";
import type { InvalidationReason } from "./invalidation-outbox.js";
import {
  CONTRACT_VIOLATION,
  decideSupportContinuation,
  type EvidenceSupportDescriptor,
  type EvidenceSupportDenied,
  type EvidenceSupportGranted,
  type SupportContractViolation,
} from "./evidence-continuation.js";
import {
  decideGrantRead,
  MAX_EVIDENCE_BYTES,
  type EvidenceClient,
  type GrantReadFacts,
} from "./evidence-store.js";
import { envelopeBytes } from "./evidence-source.js";
import {
  scopeAuthorityOf,
  type AuthorizedScopeContext,
  type AuthorizedScopeWork,
  type StructuredScopeUnitOfWork,
} from "./structured-scope-types.js";
import {
  readGrantFacts,
  readGrantPinnedExtractionsForSupports,
} from "./evidence-pg.js";

/** The request token and version the spec fixes. */
export const EVIDENCE_REQUEST_SCHEMA = "iknow.evidence_request";
export const EVIDENCE_RESULT_SCHEMA = "iknow.evidence_result";
export const EVIDENCE_ENVELOPE_VERSION = 1;

/** The single JSON-RPC method name this capability answers on. */
export const EVIDENCE_PRIVATE_METHOD = "corpus_evidence";

/**
 * The seam shape this read needs: the transactional one, because the grant facts
 * must be read on the *same* client and inside the *same* transaction that
 * checked the authorization revision. The memory seam cannot satisfy that, which
 * is the point — an Evidence read is not answerable without one transaction.
 */
export type EvidenceScope = StructuredScopeUnitOfWork<AuthorizedScopeWork>;

/** The four actions this contract accepts. */
export const EVIDENCE_ACTION = {
  READ: "read",
  SUPPORTS: "supports",
  /**
   * Added by register §1.3, which lifted the `invalidations` half of this fence.
   */
  INVALIDATIONS: "invalidations",
  /**
   * The `ack` half, added by register §1.5 — the last member of the spec's action
   * union (`specs/structured-corpus-evidence.md:227`).
   *
   * It is a WRITE, which is why its store lives in
   * `evidence-invalidation-ack.ts` rather than here or beside the drain read: it
   * re-verifies the batch it advances through, in its own transaction, and the
   * purge-owner rows that make that re-verification decidable land with ADR 0099's
   * `scrubbed` state in the same commit.
   */
  ACK: "ack",
} as const;

export type EvidenceAction = (typeof EVIDENCE_ACTION)[keyof typeof EVIDENCE_ACTION];

/** The whole request surface. Nothing else is accepted, by design. */
export interface EvidenceReadRequest {
  readonly action: typeof EVIDENCE_ACTION.READ;
  readonly evidence_ref: string;
}

export interface EvidenceSupportsRequest {
  readonly action: typeof EVIDENCE_ACTION.SUPPORTS;
  readonly evidence_ref: string;
  /** Opaque continuation position; mutually exclusive with `support_id`. */
  readonly cursor?: string | null;
  /** One named support of this grant; mutually exclusive with `cursor`. */
  readonly support_id?: string | null;
}

/**
 * The drain request, carrying no reference of its own.
 *
 * The absence of `evidence_ref` is the contract, not an omission: a drain
 * answers for the CONSUMER's whole stream, and a request that named a reference
 * would be asking this action to filter — which is the grant read's job and
 * would turn a scrub queue into a selective disclosure.
 */
export interface EvidenceInvalidationsRequest {
  readonly action: typeof EVIDENCE_ACTION.INVALIDATIONS;
  /** The consumer's last accepted checkpoint; absent or null on a first drain. */
  readonly checkpoint?: string | null;
  /**
   * Events to return, `1..20`.
   *
   * Optional on the WIRE and required here, because the parser resolves an
   * absent key to the spec's documented default: a reader handed a resolved
   * request can never reach the store without a page size, and a page size that
   * could be missing is a page size two callers would default differently.
   */
  readonly limit: number;
}

/**
 * The acknowledgement request: one position, named by nothing else.
 *
 * `checkpoint` is REQUIRED and non-null here, unlike `invalidations`'s nullable
 * one, and the asymmetry is the contract rather than an inconsistency: a drain may
 * legitimately start from nowhere, while an acknowledgement that carries no
 * position is a request with nothing to acknowledge — resolving it to `null` here
 * would let a caller reach the store asking for an action with no argument.
 *
 * The absence of `evidence_ref` and of any identity is the same rule the drain
 * follows: this action answers for the CONSUMER's stream, so it names no reference
 * and the transport supplies the consumer.
 */
export interface EvidenceAckRequest {
  readonly action: typeof EVIDENCE_ACTION.ACK;
  /** The server-minted position the consumer is acknowledging. */
  readonly checkpoint: string;
}

/**
 * The actions answered from a single retained grant.
 *
 * Narrower than `EvidenceRequest` on purpose: it is what makes
 * `readPrivateEvidence` structurally unable to be handed a drain or an
 * acknowledgement, so the wrong routing is a compile error rather than a refusal
 * somebody has to remember to write.
 */
export type EvidenceGrantRequest =
  | EvidenceReadRequest
  | EvidenceSupportsRequest;

export type EvidenceRequest =
  | EvidenceGrantRequest
  | EvidenceInvalidationsRequest
  | EvidenceAckRequest;

/** Refusal reasons this ticket adds on top of the store's denial reasons. */
export const EVIDENCE_REFUSAL_REASON = {
  /** A request key that is not part of the contract, including any identity. */
  UNKNOWN_FIELD: "unknown_field",
  /** A count grant retains no membership, so it has no supports to read. */
  COUNT_GRANT_HAS_NO_SUPPORTS: "count_grant_has_no_supports",
  /**
   * Continuation paging belongs to EP4, not to this read.
   *
   * Kept in the closed set and no longer emitted: a row grant's `supports` request
   * is decided by the continuation now, so this token can no longer reach a caller.
   * It stays because the set is a published contract rather than an implementation
   * detail, and dropping a member of it is a wire-visible change this ticket does
   * not own the other side of.
   */
  SUPPORTS_CONTINUATION_NOT_READ: "supports_continuation_not_read",
  /** The grant was issued under a scope this identity does not hold. */
  SCOPE_NOT_AUTHORIZED: "scope_not_authorized",
  /** A retained dependency names a source outside the identity's subset. */
  SOURCE_OUTSIDE_AUTHORIZED_SUBSET: "source_outside_authorized_subset",
  /** The authorized context was not minted by this composition. */
  CONTEXT_NOT_MINTED: "context_not_minted",
  /** The response would exceed the bounded envelope. */
  ENVELOPE_TOO_LARGE: "envelope_too_large",
  /** The transport injected no binding, or one this build cannot resolve. */
  TRUSTED_BINDING_UNRESOLVED: "trusted_binding_unresolved",
  /**
   * A recognised field carrying a version this build does not implement.
   *
   * Not folded onto `UNKNOWN_FIELD`, which reports that a key is not part of the
   * contract: `schema_version` IS on the contract, and telling a caller this
   * field does not exist would send an operator looking for a malformed payload
   * when the real fact is a version skew. Register §1b.5 makes the split the
   * same one fin's parser makes.
   */
  UNSUPPORTED_CONTRACT_VERSION: "unsupported_contract_version",
  /**
   * A `limit` outside the `1..20` the spec fixes for `invalidations`.
   *
   * Also not `UNKNOWN_FIELD`, for the same reason: the key is on the contract
   * and its value is not on it. Serving the nearest legal value instead would
   * make a consumer's own over-limit check unreachable, since the backend would
   * never emit the batch it exists to detect.
   */
  INVALIDATION_LIMIT_OUT_OF_RANGE: "invalidation_limit_out_of_range",
  /**
   * The `invalidations` action reached the grant read.
   *
   * Live rather than historical: `parseEvidenceRequest` accepts the action
   * because the contract does, and the drain itself is answered by
   * `evidence-invalidation-read.ts`, which holds the checkpoint key and opens its
   * own read-only unit of work. Naming the mis-route keeps a caller that composes
   * the wrong seam on the typed path instead of the exception path.
   */
  INVALIDATIONS_NOT_A_GRANT_READ: "invalidations_not_a_grant_read",
  /**
   * The `ack` action reached the grant read.
   *
   * The same mis-route as `invalidations`, and a separate token because the two are
   * composed against different seams: the acknowledgement is a WRITE in its own
   * transaction (`evidence-invalidation-ack.ts`) while the drain is a read-only one,
   * so a caller that routed either here needs to be told which one it got wrong.
   */
  ACK_NOT_A_GRANT_READ: "ack_not_a_grant_read",
} as const;

export type EvidenceRefusalReason =
  | EvidenceDenialReason
  | (typeof EVIDENCE_REFUSAL_REASON)[keyof typeof EVIDENCE_REFUSAL_REASON];

/**
 * One refusal, with both halves named.
 *
 * `code` is a token from an existing closed vocabulary — the evidence failure
 * set for a store/contract fact, the structured-scope failure set for a
 * transport or identity fact — and `reason` says which fact it was. Neither set
 * is widened here.
 *
 * The spec asks for evidence failures to travel in the existing
 * `iknow.structured_error` envelope. That envelope's `error.code` is typed by
 * `StructuredErrorCode`, a closed set that contains none of the evidence tokens,
 * so putting them there would require widening it. This build therefore carries
 * the refusal on the Evidence channel's own result token and records the
 * conflict as blocker B4 rather than silently opening the set.
 *
 * B4 is the envelope shape only. Of the eight tokens the spec names, seven were
 * already in one of the two sets above before this module and reached the wire
 * today; the eighth, `unsupported_evidence_contract`, is the one that had no
 * home. Register §1b.5a settled it — it is a contract fact, so it joins
 * `EVIDENCE_FAILURE` as a declared member beside `MALFORMED_CONTRACT` — and
 * §1.3's `invalidations` action is the case that reaches it. All eight are
 * enumerated in `EVIDENCE_FAILURE`; there is no token left unplaced. An earlier
 * version of this comment said "six of the eight ... are in neither closed set",
 * which was wrong by five and was this register's own unverified restatement
 * rather than an observation.
 */
export class EvidenceRefusalError extends Error {
  constructor(
    readonly code: string,
    readonly reason: EvidenceRefusalReason,
    message: string,
    /**
     * Which contract the request broke, when the reason token cannot name it.
     *
     * Local only: the wire mapping reads `code`, `reason` and `message`, so this
     * is carried in this build and never published. See `supportRefusal`.
     */
    readonly contract?: SupportContractViolation
  ) {
    super(message);
    this.name = "EvidenceRefusalError";
  }
}

/**
 * A refusal as plain data, so it can travel out of the transaction.
 *
 * Why it is a value and not a thrown error. `withAuthorizedScope` runs the
 * callback inside `runTransaction`, whose rollback path re-types whatever the
 * callback threw into a `StructuredScopeError` carrying a code from the closed
 * scope set. An evidence token thrown from inside would be rewritten to
 * `backend_unavailable` on its way out, losing the one distinction the caller
 * needs. Returning the refusal instead keeps `evidence_expired` distinguishable
 * from `evidence_purged`, and keeps the rollback diagnostics about the
 * transaction rather than about the refusal that already succeeded.
 */
export interface EvidenceRefusal {
  readonly code: string;
  readonly reason: EvidenceRefusalReason;
  readonly message: string;
  /**
   * Which contract this request broke, when `reason` cannot name it.
   *
   * Local only. `EvidenceErrorEnvelope` is built from `code`, `reason` and
   * `message` alone, so this field distinguishes facts the frozen wire vocabulary
   * folds together without adding a token to it.
   */
  readonly contract?: SupportContractViolation;
}

/** The failure arm of the wire envelope. It carries no row field at all. */
export interface EvidenceErrorEnvelope {
  readonly schema: typeof EVIDENCE_RESULT_SCHEMA;
  readonly schema_version: typeof EVIDENCE_ENVELOPE_VERSION;
  readonly error: {
    readonly code: string;
    readonly reason: EvidenceRefusalReason;
    /**
     * Why this refusal, in one sentence. It carries no field of the retained
     * row -- only the explanation a refusal is owed -- so it cannot disclose
     * what the refusal exists to withhold.
     */
    readonly message: string;
    readonly retryable: boolean;
  };
}

/** The success arm of the wire envelope for `read`. */
export interface EvidenceReadResult {
  readonly schema: typeof EVIDENCE_RESULT_SCHEMA;
  readonly schema_version: typeof EVIDENCE_ENVELOPE_VERSION;
  readonly evidence_ref: string;
  readonly kind: typeof EVIDENCE_GRANT_KIND.ROW | typeof EVIDENCE_GRANT_KIND.COUNT;
  /** The grant's own `context` column, returned unchanged. */
  readonly context: Record<string, unknown>;
  /** The grant's own `value` column, returned unchanged. */
  readonly value: unknown;
  /** A count grant's receipt field; `null` for a row grant, by construction. */
  readonly result_count: number | null;
  /** The grant's fixed deadline, returned unchanged so a read cannot renew it. */
  readonly expires_at: string;
}

/**
 * The success arm of the wire envelope for `supports`: one page of the grant's own
 * pinned membership, in the continuation's own field names.
 *
 * It carries the same top-level identity a `read` envelope does — `evidence_ref`
 * and the unchanged `expires_at` — so a caller never has to tell the two actions
 * apart to know which reference and lifetime a page belongs to. What it does not
 * carry is the retained `value` or `context`: a support page is descriptors of
 * citations, and returning the row beside them would turn a paging read into a
 * whole-row disclosure on a path that never asked to be one.
 */
export interface EvidenceSupportsResult {
  readonly schema: typeof EVIDENCE_RESULT_SCHEMA;
  readonly schema_version: typeof EVIDENCE_ENVELOPE_VERSION;
  readonly evidence_ref: string;
  /** The grant's fixed deadline, echoed unchanged; a page never renews it. */
  readonly expires_at: string;
  /** How many supports the grant pinned, so a caller knows when it is done. */
  readonly total_supports: number;
  readonly supports: readonly EvidenceSupportDescriptor[];
  /** `null` on the last page, and on a selected support, which opens no sequence. */
  readonly next_cursor: string | null;
  /** Whether this page is one named support rather than a sequence. */
  readonly selected: boolean;
}

/**
 * One invalidation event: ADR 0097 §2.1's five closed fields.
 *
 * Content-free by construction. `evidence_ref` is an opaque handle and
 * `occurred_at` is a time, so neither names a subject, an operation, a filename
 * or a value; `reason` is a two-member enum with no expiry member, so an event
 * can never be read as an age-based collection signal (ADR 0097 §2.6). There is
 * no optional field set and no free text: an extra key is a contract violation,
 * which is how the content prohibition is enforced on the consumer's side.
 */
export interface EvidenceInvalidationEvent {
  readonly event_id: string;
  readonly seq: number;
  readonly evidence_ref: string;
  readonly reason: InvalidationReason;
  readonly occurred_at: string;
}

/**
 * The success arm for `invalidations`: one page of a consumer's stream.
 *
 * `gap` is the BACKEND'S verdict (ADR 0097 §2.7), never something a consumer
 * infers from an empty array — a consumer that inferred it would have to treat
 * "nothing pending" and "this stream moved past something I never saw" as the
 * same batch, which is the window the spec's revalidate branch exists to close.
 * `checkpoint` echoes the cursor that was presented and is the consumer's
 * contiguity attestation; `next_checkpoint` is a NEW token and is the only value
 * §1.5's acknowledgement may advance through.
 */
export interface EvidenceInvalidationsResult {
  readonly schema: typeof EVIDENCE_RESULT_SCHEMA;
  readonly schema_version: typeof EVIDENCE_ENVELOPE_VERSION;
  readonly action: typeof EVIDENCE_ACTION.INVALIDATIONS;
  readonly checkpoint: string | null;
  readonly events: readonly EvidenceInvalidationEvent[];
  readonly next_checkpoint: string;
  readonly gap: boolean;
}

/**
 * The success arm for `ack`: the position the backend now holds as acknowledged.
 *
 * One field of contract beyond the envelope, and it is the spec's own wording —
 * `checkpoint`, meaning the ACKNOWLEDGED one (`specs/structured-corpus-evidence.md:227`).
 * It exists so fin's recovery path can read the backend's answer rather than
 * assume its own acknowledgement landed: after a crash between the scrub commit
 * and fin's own record, the resume point is the server's value, not fin's memory
 * of what it sent.
 *
 * The action is echoed because it is an ACTION of the one `iknow.evidence_result`
 * envelope (ADR 0097's amendment), so a caller reading the response cannot tell
 * which action produced it without this field — and must never have to infer it
 * from the shape.
 */
export interface EvidenceAckResult {
  readonly schema: typeof EVIDENCE_RESULT_SCHEMA;
  readonly schema_version: typeof EVIDENCE_ENVELOPE_VERSION;
  readonly action: typeof EVIDENCE_ACTION.ACK;
  readonly checkpoint: string;
}

export type EvidenceEnvelope =
  | EvidenceErrorEnvelope
  | EvidenceReadResult
  | EvidenceSupportsResult
  | EvidenceInvalidationsResult
  | EvidenceAckResult;

/** The exact request keys each action accepts. */
const REQUEST_FIELDS: Readonly<Record<EvidenceAction, readonly string[]>> = {
  [EVIDENCE_ACTION.READ]: ["schema", "schema_version", "action", "evidence_ref"],
  [EVIDENCE_ACTION.SUPPORTS]: [
    "schema",
    "schema_version",
    "action",
    "evidence_ref",
    "cursor",
    "support_id",
  ],
  // No `evidence_ref` here, and that omission is the point: this action answers
  // for the whole consumer stream, so a request naming a reference would be
  // asking it to filter. `consumer_id` is absent for the same reason the other
  // actions omit every identity — the transport supplies it, never the request.
  [EVIDENCE_ACTION.INVALIDATIONS]: [
    "schema",
    "schema_version",
    "action",
    "checkpoint",
    "limit",
  ],
  // Exactly the keys `invalidations` uses minus `limit`: one position, nothing to
  // page. `consumer_id` is absent for the same reason the other actions omit every
  // identity — the transport supplies it, never the request — so an acknowledgement
  // that named its own stream is an unlisted key and therefore a refusal rather
  // than a value somebody could assert.
  [EVIDENCE_ACTION.ACK]: ["schema", "schema_version", "action", "checkpoint"],
};

const ACTIONS: readonly string[] = Object.values(EVIDENCE_ACTION);

/**
 * Parse and reject anything that is not on the contract.
 *
 * The unknown-key check is what makes "a model-supplied identity field is
 * refused and never reaches the binding" structural rather than aspirational:
 * there is no code path that copies an unlisted key anywhere, and an attempt is
 * a typed `invalid_input` instead of a silent ignore. `trusted_consumer`,
 * `actor_id`, `scope_binding` and anything else a caller might try to assert are
 * all unlisted keys here.
 */
export function parseEvidenceRequest(input: unknown): EvidenceRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new EvidenceRefusalError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD,
      "the Evidence request must be a JSON object"
    );
  }
  const body = input as Record<string, unknown>;
  if (body["schema"] !== EVIDENCE_REQUEST_SCHEMA) {
    throw new EvidenceRefusalError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD,
      `schema must be ${EVIDENCE_REQUEST_SCHEMA}`
    );
  }
  const rawVersion = body["schema_version"];
  assertRequestedVersion(rawVersion);
  const action = body["action"];
  if (typeof action !== "string" || !ACTIONS.includes(action)) {
    throw new EvidenceRefusalError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD,
      `action must be one of ${ACTIONS.join("|")}, got ${JSON.stringify(action)}`
    );
  }
  const known = REQUEST_FIELDS[action as EvidenceAction];
  const unknown = Object.keys(body).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new EvidenceRefusalError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD,
      `the ${action} action accepts only ${known.join(", ")}; refused ` +
        `${unknown.sort().join(", ")}. An identity asserted on the request ` +
        "channel is refused, never read."
    );
  }
  // One lookup per action instead of a branch per action. `REQUEST_PARSERS` is a
  // `Record<EvidenceAction, …>`, so adding a fifth action to the union without
  // giving it a parser is a COMPILE error — which is the guarantee a chain of
  // `if (action === …)` comparisons cannot give, and the reason the four-arm
  // version of this was measured as a regression the moment `ack` arrived.
  return REQUEST_PARSERS[action as EvidenceAction](body);
}

/** The four per-action parsers, exhaustive by construction over the action union. */
const REQUEST_PARSERS: Readonly<
  Record<EvidenceAction, (body: Record<string, unknown>) => EvidenceRequest>
> = {
  [EVIDENCE_ACTION.READ]: (body) => ({
    action: EVIDENCE_ACTION.READ,
    evidence_ref: requireEvidenceRef(body["evidence_ref"]),
  }),
  [EVIDENCE_ACTION.SUPPORTS]: (body) => ({
    action: EVIDENCE_ACTION.SUPPORTS,
    evidence_ref: requireEvidenceRef(body["evidence_ref"]),
    cursor: optionalSelector(body["cursor"], "cursor"),
    support_id: optionalSelector(body["support_id"], "support_id"),
  }),
  [EVIDENCE_ACTION.INVALIDATIONS]: invalidationsRequest,
  [EVIDENCE_ACTION.ACK]: (body) => ({
    action: EVIDENCE_ACTION.ACK,
    checkpoint: requireCheckpoint(body),
  }),
};

/**
 * The spec's documented `limit` window for `invalidations` (`spec:226`).
 *
 * Declared here rather than in the reader because this is the contract, and the
 * parser is what enforces it: a bound that only the caller knew about would be a
 * bound every other caller could quietly exceed.
 */
export const MIN_INVALIDATION_LIMIT = 1;
export const MAX_INVALIDATION_LIMIT = 20;
export const DEFAULT_INVALIDATION_LIMIT = 20;

/**
 * The envelope version, refused under the class that names the fault.
 *
 * WHY two classes, which are not the same fault. A value with no integer form is
 * a malformed payload — the field is required and must be a number. A finite
 * integer this build does not implement is a contract this build does not speak,
 * and ADR 0097 §2.7 names `unsupported_evidence_contract` for exactly that.
 * Reading it as version 1 is the third option and is never taken: a v2 caller
 * told it is being served v1 acts on an answer to a question it did not ask, and
 * ADR 0097 §2.3 already requires version skew to be a refusal rather than a
 * fallback. Register §1b.5 is the decision this implements.
 */
function assertRequestedVersion(rawVersion: unknown): void {
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion)) {
    throw new EvidenceRefusalError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD,
      "schema_version must be an integer"
    );
  }
  if (rawVersion !== EVIDENCE_ENVELOPE_VERSION) {
    throw new EvidenceRefusalError(
      EVIDENCE_FAILURE.UNSUPPORTED_CONTRACT,
      EVIDENCE_REFUSAL_REASON.UNSUPPORTED_CONTRACT_VERSION,
      `schema_version ${rawVersion} is not implemented; this build speaks ` +
        `${EVIDENCE_REQUEST_SCHEMA} version ${EVIDENCE_ENVELOPE_VERSION}. ` +
        "An unrecognized version is refused, never read as the nearest older one."
    );
  }
}

/** The drain's two fields, resolved. Absent `limit` means the spec's default. */
function invalidationsRequest(
  body: Record<string, unknown>
): EvidenceInvalidationsRequest {
  return {
    action: EVIDENCE_ACTION.INVALIDATIONS,
    // Absent, null and empty all reach the reader as "no position yet": which
    // spelling means none is the checkpoint's own rule, and re-deciding it here
    // would be a second rule that could disagree with the codec's.
    checkpoint: optionalSelector(body["checkpoint"], "checkpoint") ?? null,
    limit: invalidationLimit(body["limit"]),
  };
}

/**
 * The acknowledgement's one required field.
 *
 * The absence of `optionalSelector` here is the whole difference between the two
 * checkpoint fields: `invalidations` treats "no position" as a legitimate first
 * drain, while `ack` has nothing to acknowledge without one. `undefined`, `null`,
 * a blank string and a non-string are therefore all refusals — an empty string in
 * particular, because a caller that reached the store with one would be asking to
 * acknowledge a position that cannot exist.
 *
 * Refused as `UNKNOWN_FIELD` rather than under its own token because the request
 * itself is not on the contract in that case, which is precisely what the existing
 * token says; the version skew and out-of-range tokens exist only where a key IS
 * on the contract and its VALUE is not.
 */
function requireCheckpoint(body: Record<string, unknown>): string {
  const value = body["checkpoint"];
  if (typeof value !== "string" || value.trim() === "") {
    throw new EvidenceRefusalError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD,
      "the ack action requires a non-empty checkpoint; there is no position to " +
        "acknowledge without one"
    );
  }
  return value;
}

/** The two grant actions' shared field, refused before anything is read. */
function requireEvidenceRef(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EvidenceRefusalError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD,
      "evidence_ref must be a non-empty string"
    );
  }
  return value;
}

/**
 * The drain's page size, or the spec's documented default.
 *
 * An out-of-range value is REFUSED rather than clamped, and that is the whole
 * point of the check: a consumer's own guard refuses a batch past the documented
 * `limit`, and a backend that silently served 20 to a caller who asked for 100
 * would make that guard unreachable — the batch over the contract would never
 * reach the consumer whose job is to notice it. `Number.isInteger` before the
 * range test, so a float or a numeric string cannot pass the bounds it happens
 * to satisfy.
 */
function invalidationLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_INVALIDATION_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new EvidenceRefusalError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      EVIDENCE_REFUSAL_REASON.INVALIDATION_LIMIT_OUT_OF_RANGE,
      `limit must be an integer, got ${JSON.stringify(value)}`
    );
  }
  if (value < MIN_INVALIDATION_LIMIT || value > MAX_INVALIDATION_LIMIT) {
    throw new EvidenceRefusalError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      EVIDENCE_REFUSAL_REASON.INVALIDATION_LIMIT_OUT_OF_RANGE,
      `limit must be between ${MIN_INVALIDATION_LIMIT} and ` +
        `${MAX_INVALIDATION_LIMIT}, got ${value}`
    );
  }
  return value;
}

/**
 * A selector's own shape, refused before it can name anything.
 *
 * Which spelling means "none" is frozen in the continuation, so absent, null and
 * empty pass down untouched and no second rule is written here. What is left is a
 * non-text selector: the continuation reads a selector as text, so a number or an
 * object would leave its entry point as an exception instead of a refusal.
 */
function optionalSelector(value: unknown, key: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new EvidenceRefusalError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD,
      `${key} must be a string when it is present, got ${JSON.stringify(value)}`
    );
  }
  return value;
}

/**
 * Refuse a store denial by its own naming.
 *
 * `decideGrantRead` already distinguishes expired, purged, revoked, obligations
 * stopped, unresolved dependency, unknown reference and unknown scope. This maps
 * each onto the evidence token it chose and keeps the reason, so expiry and purge
 * stay distinguishable to a caller even though the transport-level vocabulary is
 * shared.
 */
function refusalForDecision(decision: EvidenceGrantRead): EvidenceRefusal {
  const { failure, reason } = decision as Extract<
    EvidenceGrantRead,
    { state: "denied" }
  >;
  return { code: failure, reason, message: denialMessage(reason) };
}

function denialMessage(reason: EvidenceDenialReason): string {
  switch (reason) {
    case EVIDENCE_DENIAL_REASON.EXPIRED:
      return "the finite reference lifetime has ended and is not renewable";
    case EVIDENCE_DENIAL_REASON.PURGED:
      return "the scope's purge revision moved, so the grant is withheld whole";
    case EVIDENCE_DENIAL_REASON.AUTHORIZATION_REVOKED:
      return "current authorization for the grant's scope was revoked";
    case EVIDENCE_DENIAL_REASON.OBLIGATIONS_STOPPED:
      return "a retained dependency stopped accepting obligations";
    case EVIDENCE_DENIAL_REASON.DEPENDENCY_UNRESOLVED:
      return "a retained obligation is unavailable, so the whole grant is withheld";
    case EVIDENCE_DENIAL_REASON.SCOPE_UNKNOWN:
      return "the admission scope carries no authorization or purge revision";
    default:
      return "no such retained reference";
  }
}

/**
 * Caller permission, decided before anything about the grant is disclosed.
 *
 * Two facts, both from the trusted context: the grant must have been issued
 * under the identity's own owner scope, and every retained dependency must name
 * a source inside the identity's authorized subset. The first is what separates
 * two identities in one host process; the second is what stops a broader
 * identity's set from being read through a narrower caller.
 */
function callerRefusal(
  context: AuthorizedScopeContext,
  decision: Extract<EvidenceGrantRead, { state: "granted" }>
): EvidenceRefusal | null {
  const grant = decision.grant;
  if (grant.scope_binding !== context.ownerScopeBinding) {
    return {
      code: EVIDENCE_FAILURE.ACCESS_DENIED,
      reason: EVIDENCE_REFUSAL_REASON.SCOPE_NOT_AUTHORIZED,
      message: "the reference was issued under a scope this identity does not hold",
    };
  }
  const allowed = new Set(context.authorizedSourceRefs);
  const outside = decision.supports
    .map((support) => support.source_ref)
    .filter((ref) => !allowed.has(ref));
  if (outside.length > 0) {
    // EXIT: the refusal says that a source is outside the subset and never which
    // one. A source ref is a citation, so naming it would disclose exactly what
    // this arm exists to withhold — how many are outside is not disclosed either,
    // because the count is a fact about the grant this caller may not read.
    return {
      code: EVIDENCE_FAILURE.ACCESS_DENIED,
      reason: EVIDENCE_REFUSAL_REASON.SOURCE_OUTSIDE_AUTHORIZED_SUBSET,
      message:
        "the reference retains at least one source outside this identity's " +
        "authorized subset",
    };
  }
  return null;
}

/**
 * Refuse the two actions this seam does not answer, before the unit of work opens.
 *
 * The answer would be the same refusal either way and there is no grant, no client
 * and no lock to take for an action answered elsewhere —
 * `PgEvidenceInvalidationStorage` and `PgEvidenceInvalidationAckStore` are.
 *
 * Separate arms rather than one message, because the two mis-routes have different
 * right answers: the acknowledgement is a WRITE, and handing it to a grant read
 * would open a READ-ONLY unit of work around a caller who believed it was
 * recording an advance.
 *
 * An assertion rather than a bare guard, so the narrowing it performs is visible
 * to the caller: after it returns, `request` is a grant request, and every
 * `request.evidence_ref` below is a field the type has promised exists rather than
 * an `any` the caller has to trust.
 */
function assertNotAStreamAction(
  request: EvidenceRequest
): asserts request is EvidenceGrantRequest {
  if (request.action === EVIDENCE_ACTION.INVALIDATIONS) {
    throw new EvidenceRefusalError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      EVIDENCE_REFUSAL_REASON.INVALIDATIONS_NOT_A_GRANT_READ,
      "invalidations is answered by the invalidation reader, which holds the " +
        "checkpoint key; it names no evidence_ref, so this read would be " +
        "reading a grant nobody named."
    );
  }
  if (request.action === EVIDENCE_ACTION.ACK) {
    throw new EvidenceRefusalError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      EVIDENCE_REFUSAL_REASON.ACK_NOT_A_GRANT_READ,
      "ack is answered by the invalidation acknowledgement store, which writes " +
        "in its own transaction; this read names no evidence_ref and grants no " +
        "consumer position."
    );
  }
}

/** What the scope's callback hands back: one rendered envelope, or one refusal. */
type ScopeOutcome =
  | { readonly granted: EvidenceReadResult | EvidenceSupportsResult }
  | { readonly refused: EvidenceRefusal };

/**
 * Run one authorized Evidence read.
 *
 * `at` is the caller's instant, never a storage-side clock, so a fake clock
 * crosses the expiry boundary deterministically in the test lane.
 */
export async function readPrivateEvidence(
  scope: EvidenceScope,
  context: AuthorizedScopeContext,
  request: EvidenceRequest,
  at: string
): Promise<EvidenceEnvelope> {
  if (scopeAuthorityOf(context) !== scope) {
    throw new EvidenceRefusalError(
      EVIDENCE_FAILURE.ACCESS_DENIED,
      EVIDENCE_REFUSAL_REASON.CONTEXT_NOT_MINTED,
      "the authorized scope context was not minted by this composition"
    );
  }
  assertNotAStreamAction(request);
  const outcome = await scope.withAuthorizedScope(
    context,
    async (work: AuthorizedScopeWork): Promise<ScopeOutcome> => {
      const client = work.client as unknown as EvidenceClient;
      const facts = await readGrantFacts(client, request.evidence_ref);
      const decision = decideGrantRead(facts, at);
      if (decision.state === "denied") {
        return { refused: refusalForDecision(decision) };
      }
      const permission = callerRefusal(context, decision);
      if (permission !== null) return { refused: permission };
      if (request.action === EVIDENCE_ACTION.SUPPORTS) {
        return supportPageOutcome({ client, facts, decision, context, request, at });
      }
      const bytes = envelopeBytes(decision.grant.value, decision.grant.context);
      if (bytes > MAX_EVIDENCE_BYTES) {
        return {
          refused: {
            code: EVIDENCE_FAILURE.TOO_LARGE,
            reason: EVIDENCE_REFUSAL_REASON.ENVELOPE_TOO_LARGE,
            message:
              `the retained value and context are ${bytes} bytes, over the ` +
              `${MAX_EVIDENCE_BYTES} byte envelope`,
          },
        };
      }
      return { granted: renderRead(decision) };
    }
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

/** Everything the supports arm needs, so it is passed as one decision's inputs. */
interface SupportPageRead {
  readonly client: EvidenceClient;
  readonly facts: GrantReadFacts;
  readonly decision: Extract<EvidenceGrantRead, { state: "granted" }>;
  readonly context: AuthorizedScopeContext;
  readonly request: EvidenceSupportsRequest;
  readonly at: string;
}

/**
 * The supports arm, from the granted row grant to one page.
 *
 * A count grant is refused here rather than paged, because this arm is the only
 * place that knows the request asked for membership rather than for the value.
 */
async function supportPageOutcome({
  client,
  facts,
  decision,
  context,
  request,
  at,
}: SupportPageRead): Promise<ScopeOutcome> {
  if (decision.grant.kind === EVIDENCE_GRANT_KIND.COUNT) {
    return {
      refused: {
        code: EVIDENCE_FAILURE.MALFORMED_CONTRACT,
        reason: EVIDENCE_REFUSAL_REASON.COUNT_GRANT_HAS_NO_SUPPORTS,
        message: "a count grant retains no membership, so it has no supports to read",
      },
    };
  }
  // The selectors are handed over as named, never resolved here: whether two
  // of them can appear together, and which one a caller may name at all, is
  // decided before the grant is read by the continuation's own order.
  const page = await decideSupportContinuation(
    facts,
    {
      evidenceRef: request.evidence_ref,
      at,
      caller: {
        scopeBinding: context.ownerScopeBinding,
        authorizedSourceRefs: context.authorizedSourceRefs,
      },
      cursor: request.cursor,
      supportId: request.support_id,
    },
    async (evidenceRef, supportIds) =>
      readGrantPinnedExtractionsForSupports(client, evidenceRef, supportIds)
  );
  if (page.state === "denied") return { refused: supportRefusal(page) };
  const envelope = renderSupports(page);
  // EXIT: this measures the envelope that is emitted, not the page the
  // continuation measured. The continuation bounds its own granted payload,
  // which carries an internal `state` where the emitted envelope carries the
  // wire schema and version, so the emitted one is the larger of the two by a
  // constant and only this one is the bound on what the caller receives.
  const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  if (bytes > MAX_EVIDENCE_BYTES) {
    return {
      refused: {
        code: EVIDENCE_FAILURE.TOO_LARGE,
        reason: EVIDENCE_REFUSAL_REASON.ENVELOPE_TOO_LARGE,
        message:
          `the emitted support page is ${bytes} bytes, over the ` +
          `${MAX_EVIDENCE_BYTES} byte envelope`,
      },
    };
  }
  return { granted: envelope };
}

/**
 * A continuation refusal, by this module's own naming.
 *
 * The continuation answers every fault with a value and names the fact in one of
 * two ways: a denial reason, or `contract_violation` for a request that violates
 * the contract. Denial reasons are already members of the closed reason set and
 * pass through untouched.
 *
 * `contract_violation` covers a dozen facts and the frozen vocabulary has one
 * token left for all of them, so it is folded onto the member that already means
 * "this request is not on the contract" rather than opened as a new one — and the
 * fact itself is carried on `contract`, which this build keeps and the wire does
 * not publish. A non-uuid selector, two selectors at once and a selector outside
 * the grant are three different faults in this file even though a caller reads one
 * `unknown_field`. The detail says which contract was broken and still carries no
 * support, a locator or a value.
 */
function supportRefusal(denied: EvidenceSupportDenied): EvidenceRefusal {
  if (denied.reason !== CONTRACT_VIOLATION) {
    return { code: denied.failure, reason: denied.reason, message: denied.detail };
  }
  return {
    code: denied.failure,
    reason:
      denied.failure === EVIDENCE_FAILURE.TOO_LARGE
        ? EVIDENCE_REFUSAL_REASON.ENVELOPE_TOO_LARGE
        : EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD,
    contract: denied.violation,
    message: denied.detail,
  };
}

/** Assemble the success arm. The only place a retained value is emitted. */
function renderRead(
  decision: Extract<EvidenceGrantRead, { state: "granted" }>
): EvidenceReadResult {
  const grant = decision.grant;
  return {
    schema: EVIDENCE_RESULT_SCHEMA,
    schema_version: EVIDENCE_ENVELOPE_VERSION,
    evidence_ref: grant.evidence_ref,
    kind: grant.kind,
    context: grant.context,
    value: grant.value,
    result_count: grant.result_count,
    expires_at: grant.expires_at,
  };
}

/** Assemble the page arm. No retained value or context is emitted here. */
function renderSupports(page: EvidenceSupportGranted): EvidenceSupportsResult {
  return {
    schema: EVIDENCE_RESULT_SCHEMA,
    schema_version: EVIDENCE_ENVELOPE_VERSION,
    evidence_ref: page.evidence_ref,
    expires_at: page.expires_at,
    total_supports: page.total_supports,
    supports: page.supports,
    next_cursor: page.next_cursor,
    selected: page.selected,
  };
}

/** The support ids a row grant pinned, for a caller that wants them in order. */
export function pinnedSupportRefs(
  decision: Extract<EvidenceGrantRead, { state: "granted" }>
): readonly EvidenceSupportRef[] {
  return decision.supports.map((support) => ({
    support_id: support.support_id,
    role: "occurrence",
  }));
}
