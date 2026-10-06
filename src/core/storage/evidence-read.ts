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
 */
import {
  EVIDENCE_DENIAL_REASON,
  EVIDENCE_FAILURE,
  EVIDENCE_GRANT_KIND,
  type EvidenceDenialReason,
  type EvidenceGrantRead,
  type EvidenceSupportRef,
} from "../types.js";
import {
  CONTRACT_VIOLATION,
  decideSupportContinuation,
  type EvidenceSupportDescriptor,
  type EvidenceSupportDenied,
  type EvidenceSupportGranted,
} from "./evidence-continuation.js";
import {
  decideGrantRead,
  MAX_EVIDENCE_BYTES,
  type EvidenceClient,
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

/** The two actions T13 answers. `invalidations` and `ack` are out of scope here. */
export const EVIDENCE_ACTION = {
  READ: "read",
  SUPPORTS: "supports",
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

export type EvidenceRequest = EvidenceReadRequest | EvidenceSupportsRequest;

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
 * conflict as blocker B4 (six of the eight evidence failure codes are in neither
 * closed set) rather than silently opening the set.
 */
export class EvidenceRefusalError extends Error {
  constructor(
    readonly code: string,
    readonly reason: EvidenceRefusalReason,
    message: string
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

export type EvidenceEnvelope =
  | EvidenceErrorEnvelope
  | EvidenceReadResult
  | EvidenceSupportsResult;

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
  if (body["schema_version"] !== EVIDENCE_ENVELOPE_VERSION) {
    throw new EvidenceRefusalError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD,
      `schema_version must be ${EVIDENCE_ENVELOPE_VERSION}`
    );
  }
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
  const evidenceRef = body["evidence_ref"];
  if (typeof evidenceRef !== "string" || evidenceRef.trim() === "") {
    throw new EvidenceRefusalError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD,
      "evidence_ref must be a non-empty string"
    );
  }
  return action === EVIDENCE_ACTION.SUPPORTS
    ? {
        action: EVIDENCE_ACTION.SUPPORTS,
        evidence_ref: evidenceRef,
        cursor: optionalSelector(body["cursor"], "cursor"),
        support_id: optionalSelector(body["support_id"], "support_id"),
      }
    : { action: EVIDENCE_ACTION.READ, evidence_ref: evidenceRef };
}

/**
 * A selector's own shape, refused before it can name anything.
 *
 * An absent, null or empty selector is the absence of that selector and is passed
 * down untouched: which spelling means "none" is frozen in the continuation, and a
 * second rule here would be a second answer to the same question. Anything that is
 * neither absent, null nor a string is refused here, because the continuation reads
 * a selector as text — a number or an object would leave its entry point as an
 * exception instead of answering with a refusal. A selector that passes this check
 * reaches the action layer; there is no path on which a listed key is read here
 * and then dropped, which is why the contract's selectors are listed at all.
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
  const outcome = await scope.withAuthorizedScope(
    context,
    async (work: AuthorizedScopeWork): Promise<
      | { readonly granted: EvidenceReadResult | EvidenceSupportsResult }
      | { readonly refused: EvidenceRefusal }
    > => {
      const client = work.client as unknown as EvidenceClient;
      const facts = await readGrantFacts(client, request.evidence_ref);
      const decision = decideGrantRead(facts, at);
      if (decision.state === "denied") {
        return { refused: refusalForDecision(decision) };
      }
      const permission = callerRefusal(context, decision);
      if (permission !== null) return { refused: permission };

      if (request.action === EVIDENCE_ACTION.SUPPORTS) {
        if (decision.grant.kind === EVIDENCE_GRANT_KIND.COUNT) {
          return {
            refused: {
              code: EVIDENCE_FAILURE.MALFORMED_CONTRACT,
              reason: EVIDENCE_REFUSAL_REASON.COUNT_GRANT_HAS_NO_SUPPORTS,
              message:
                "a count grant retains no membership, so it has no supports to read",
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
        const bytes = envelopeBytes(page.supports, {
          total_supports: page.total_supports,
          next_cursor: page.next_cursor,
        });
        if (bytes > MAX_EVIDENCE_BYTES) {
          return {
            refused: {
              code: EVIDENCE_FAILURE.TOO_LARGE,
              reason: EVIDENCE_REFUSAL_REASON.ENVELOPE_TOO_LARGE,
              message:
                `the support page and its continuation fields are ${bytes} bytes, ` +
                `over the ${MAX_EVIDENCE_BYTES} byte envelope`,
            },
          };
        }
        return { granted: renderSupports(page) };
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
      outcome.refused.message
    );
  }
  return outcome.granted;
}

/**
 * A continuation refusal, by this module's own naming.
 *
 * The continuation answers every fault with a value and names the fact in one of
 * two ways: a denial reason, or `contract_violation` for a request that violates
 * the contract. Denial reasons are already members of the closed reason set and
 * pass through untouched. `contract_violation` is folded onto the member that
 * already means "this request is not on the contract" rather than opened as a new
 * one: the failure token alongside it already separates a malformed selector from
 * an oversized page, and the continuation's detail says which contract was broken
 * without carrying a support, a locator or a value.
 */
function supportRefusal(denied: EvidenceSupportDenied): EvidenceRefusal {
  const reason =
    denied.reason === CONTRACT_VIOLATION
      ? denied.failure === EVIDENCE_FAILURE.TOO_LARGE
        ? EVIDENCE_REFUSAL_REASON.ENVELOPE_TOO_LARGE
        : EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD
      : denied.reason;
  return { code: denied.failure, reason, message: denied.detail };
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
