/**
 * The finite grant contract: what a row or count grant may retain, how long it
 * lives, and why a replay is refused.
 *
 * Shared by both backends so a refusal is refused for the same reason in
 * whichever store holds the grant, and so the lifetime is one calculation
 * rather than two. `decideGrantRead` holds the whole replay order; a backend
 * only gathers facts and hands them over.
 */
import {
  EVIDENCE_DENIAL_REASON,
  EVIDENCE_FAILURE,
  EVIDENCE_GRANT_KIND,
  EVIDENCE_SUBJECT_KIND,
  EVIDENCE_SUPPORT_ROLE,
  type AuthorizationReceipt,
  type EvidenceDenialReason,
  type EvidenceFailureToken,
  type EvidenceGrantRead,
  type EvidenceGrantRecord,
  type EvidenceSupportRef,
  type EvidenceSubjectKind,
  type EvidenceSupportRole,
  type GrantDependencyFact,
  type GrantRequest,
  type ScopeRevisionRecord,
  type SupportRecord,
} from "../types.js";
import {
  assertFilled,
  assertInstant,
  assertUuid,
  envelopeBytes,
  evidenceError,
  instantText,
  isPlainRecord,
} from "./evidence-source.js";

/**
 * Bounded serialized size of one retained value plus its context. The wire
 * envelope is the host's to apply; refusing an oversized value here is what
 * keeps an unshrinkable value out of a store that would otherwise have to
 * truncate it, because a citation that silently lost a field is worse than a
 * refusal.
 */
export const MAX_EVIDENCE_BYTES = 32 * 1024;

/** The finite reference lifetime, measured from `queried_at` and never renewed. */
export const GRANT_LIFETIME_DAYS = 365;

const MS_PER_DAY = 86_400_000;
const GRANT_LIFETIME_MS = GRANT_LIFETIME_DAYS * MS_PER_DAY;

/** ECMAScript's representable instant range, one millisecond either side. */
const MAX_INSTANT_MS = 8_640_000_000_000_000;

const SUBJECT_KINDS: readonly string[] = Object.values(EVIDENCE_SUBJECT_KIND);
const SUPPORT_ROLES: readonly string[] = Object.values(EVIDENCE_SUPPORT_ROLE);
const GRANT_KINDS: readonly string[] = Object.values(EVIDENCE_GRANT_KIND);

/** Minimal query surface; a `pg` pool, a leased client and a fake all fit. */
export interface EvidenceClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/** A leased client also releases; the transaction below owns the pairing. */
export interface EvidenceLeasedClient extends EvidenceClient {
  release(): void;
}

/** A validated grant request, with the lifetime already decided. */
export interface NormalizedGrant {
  readonly kind: (typeof EVIDENCE_GRANT_KIND)[keyof typeof EVIDENCE_GRANT_KIND];
  readonly subject: EvidenceSubjectKind;
  readonly operation: string;
  readonly query_digest: string;
  readonly scope_binding: string;
  readonly read_revision: string;
  readonly queried_at: string;
  readonly expires_at: string;
  readonly context: Record<string, unknown>;
  readonly value: unknown;
  /** Empty for a count grant: it retains no membership at all. */
  readonly supports: readonly EvidenceSupportRef[];
  /** The count itself is a receipt field; the matching ids are not retained. */
  readonly count: number | null;
}

/** Everything a replay decision is made from. */
export interface GrantReadFacts {
  readonly grant: EvidenceGrantRecord | null;
  readonly scope: ScopeRevisionRecord | null;
  readonly receipt: AuthorizationReceipt | null;
  readonly dependencies: readonly GrantDependencyFact[];
  /** How many dependencies the grant pinned when it was issued. */
  readonly pinned: number;
}

/**
 * The typed failure a denial reason means. Permission, purge and expiry are
 * three different facts to a reader — one is "you may not see this", the
 * others are "this is gone" — so each has its own token.
 */
function failureForReason(reason: EvidenceDenialReason): EvidenceFailureToken {
  switch (reason) {
    case EVIDENCE_DENIAL_REASON.EXPIRED:
      return EVIDENCE_FAILURE.EXPIRED;
    case EVIDENCE_DENIAL_REASON.AUTHORIZATION_REVOKED:
      return EVIDENCE_FAILURE.ACCESS_DENIED;
    case EVIDENCE_DENIAL_REASON.DEPENDENCY_UNRESOLVED:
      return EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING;
    default:
      return EVIDENCE_FAILURE.UNAVAILABLE;
  }
}

/** The denial half of a read; a grant is never a granted empty value. */
function deniedForReason(
  reason: EvidenceDenialReason
): EvidenceGrantRead {
  return { state: "denied", failure: failureForReason(reason), reason };
}

/**
 * The finite lifetime, fixed at write time. Overflow is refused rather than
 * wrapped: a grant whose deadline cannot be represented has no deadline, and
 * an unbounded reference is exactly what this contract exists to prevent.
 */
function grantExpiryFrom(queriedAt: string): string {
  const expiryMs = assertInstant(queriedAt, "queried_at") + GRANT_LIFETIME_MS;
  if (Math.abs(expiryMs) > MAX_INSTANT_MS) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "queried_at plus the 365 day reference lifetime leaves the representable instant range"
    );
  }
  return new Date(expiryMs).toISOString();
}

function normalizeSubject(value: unknown, field: string): EvidenceSubjectKind {
  if (typeof value !== "string" || !SUBJECT_KINDS.includes(value)) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      `${field} must be one of ${SUBJECT_KINDS.join("|")}, got ${JSON.stringify(value)}`
    );
  }
  return value as EvidenceSubjectKind;
}

function normalizeRowSupports(value: unknown): readonly EvidenceSupportRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "a row grant must name the support set it protects; every result has at least one"
    );
  }
  const seen = new Set<string>();
  const supports: EvidenceSupportRef[] = [];
  for (const entry of value) {
    if (!isPlainRecord(entry)) {
      throw evidenceError(
        EVIDENCE_FAILURE.MALFORMED_CONTRACT,
        "row grant support entries must be records"
      );
    }
    const supportId = assertUuid(entry["support_id"], "support_id");
    const role = normalizeRole(entry["role"] ?? EVIDENCE_SUPPORT_ROLE.OCCURRENCE);
    // A repeated id is one dependency however many times it was named.
    if (seen.has(supportId)) continue;
    seen.add(supportId);
    supports.push({ support_id: supportId, role });
  }
  return supports;
}

function normalizeRole(value: unknown): EvidenceSupportRole {
  if (typeof value !== "string" || !SUPPORT_ROLES.includes(value)) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      `support role must be one of ${SUPPORT_ROLES.join("|")}, got ${JSON.stringify(value)}`
    );
  }
  return value as EvidenceSupportRole;
}

function normalizeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      `count grant count must be an integer >= 0 (zero included), got ${JSON.stringify(value)}`
    );
  }
  return value;
}

/** Validate the fields both grant kinds carry, and the bounded envelope. */
function normalizeGrantBase(input: GrantRequest): Omit<NormalizedGrant, "kind" | "supports" | "count" | "expires_at"> {
  if (!isPlainRecord(input)) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "grant request must be a record"
    );
  }
  if (!isPlainRecord(input.context)) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "grant context must be a record"
    );
  }
  if (input.value === undefined) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "grant value must be the exact row or count receipt, not absent"
    );
  }
  const bytes = envelopeBytes(input.value, input.context);
  if (bytes > MAX_EVIDENCE_BYTES) {
    throw evidenceError(
      EVIDENCE_FAILURE.TOO_LARGE,
      `grant value and context are ${bytes} bytes, over the ${MAX_EVIDENCE_BYTES} byte envelope`
    );
  }
  const queried_at = instantText(input.queriedAt, "queried_at");
  return {
    subject: normalizeSubject(input.subject, "grant subject"),
    operation: assertFilled(input.operation, "grant operation"),
    query_digest: assertFilled(input.queryDigest, "grant query_digest"),
    scope_binding: assertFilled(input.scopeBinding, "grant scope_binding"),
    read_revision: assertFilled(input.readRevision, "grant read_revision"),
    queried_at,
    context: input.context,
    value: input.value,
  };
}

/**
 * Validate one grant request and decide its fixed lifetime. The two arms are
 * mutually exclusive on the wire: a count grant naming supports would be
 * asking to retain membership it is not allowed to keep, and a row grant
 * carrying a count would carry a value no row reader could interpret.
 */
export function normalizeGrantRequest(input: GrantRequest): NormalizedGrant {
  const kind = isPlainRecord(input) ? (input as { kind?: unknown }).kind : undefined;
  if (typeof kind !== "string" || !GRANT_KINDS.includes(kind)) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      `grant kind must be one of ${GRANT_KINDS.join("|")}, got ${JSON.stringify(kind)}`
    );
  }
  const base = normalizeGrantBase(input);
  const expires_at = grantExpiryFrom(base.queried_at);
  if (kind === EVIDENCE_GRANT_KIND.ROW) {
    if ("count" in input) {
      throw evidenceError(
        EVIDENCE_FAILURE.MALFORMED_CONTRACT,
        "a row grant has no count field"
      );
    }
    return {
      ...base,
      kind: EVIDENCE_GRANT_KIND.ROW,
      expires_at,
      supports: normalizeRowSupports((input as { supports?: unknown }).supports),
      count: null,
    };
  }
  if ("supports" in input) {
    throw evidenceError(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "a count grant retains no membership, so it names no supports"
    );
  }
  return {
    ...base,
    kind: EVIDENCE_GRANT_KIND.COUNT,
    expires_at,
    supports: [],
    count: normalizeCount((input as { count?: unknown }).count),
  };
}

/** The two arms a read returns, so a caller cannot invent a third. */
function granted(
  grant: EvidenceGrantRecord,
  supports: readonly SupportRecord[],
  authorization: AuthorizationReceipt | null
): EvidenceGrantRead {
  return { state: "granted", grant, supports, authorization };
}

/**
 * Decide one replay. Shared by both backends so the order below is a single
 * documented contract: identity, then lifetime, then authorization, then
 * purge, then obligations, then divisibility.
 *
 * `at` is the caller's instant, never a storage-side clock, so a fake clock
 * crosses the boundary deterministically.
 */
export function decideGrantRead(
  facts: GrantReadFacts,
  at: string
): EvidenceGrantRead {
  const atMs = assertInstant(at, "at");
  if (facts.grant === null) {
    return deniedForReason(EVIDENCE_DENIAL_REASON.UNKNOWN_REFERENCE);
  }
  const grant = facts.grant;
  if (atMs >= Date.parse(grant.expires_at)) {
    return deniedForReason(EVIDENCE_DENIAL_REASON.EXPIRED);
  }
  if (facts.scope === null) {
    return deniedForReason(EVIDENCE_DENIAL_REASON.SCOPE_UNKNOWN);
  }
  if (facts.scope.authorization_revision !== grant.authorization_revision) {
    return deniedForReason(EVIDENCE_DENIAL_REASON.AUTHORIZATION_REVOKED);
  }
  if (facts.scope.purge_revision !== grant.purge_revision) {
    return deniedForReason(EVIDENCE_DENIAL_REASON.PURGED);
  }
  const stopped = facts.dependencies.some(
    (dependency) => dependency.obligations_stopped_at !== null
  );
  if (stopped) {
    return deniedForReason(EVIDENCE_DENIAL_REASON.OBLIGATIONS_STOPPED);
  }
  if (
    grant.kind === EVIDENCE_GRANT_KIND.ROW &&
    facts.dependencies.length !== facts.pinned
  ) {
    // A row snapshot is indivisible: a dependency set shorter than the one the
    // grant pinned is withheld whole, never rendered with a field missing.
    return deniedForReason(EVIDENCE_DENIAL_REASON.DEPENDENCY_UNRESOLVED);
  }
  return granted(
    grant,
    facts.dependencies.map((dependency) => dependency.support),
    facts.receipt
  );
}
