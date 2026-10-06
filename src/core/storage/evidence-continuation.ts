import {
  EVIDENCE_DENIAL_REASON,
  EVIDENCE_FAILURE,
  EVIDENCE_GRANT_KIND,
  type CompanySourceLocator,
  type EvidenceDenialReason,
  type EvidenceFailureToken,
  type EvidenceGrantRecord,
  type EvidenceSpan,
  type EvidenceSubjectKind,
  type EvidenceSupportRole,
  type GrantDependencyFact,
} from "../types.js";
import {
  canonicalJson,
  instantText,
  isInstantText,
  isPlainRecord,
  isUuid,
} from "./evidence-source.js";
import {
  inEvidenceTransaction,
  readGrantFacts,
  readGrantPinnedExtractionsForSupports,
} from "./evidence-pg.js";
import {
  MAX_EVIDENCE_BYTES,
  decideGrantRead,
  type EvidenceLeasedClient,
  type GrantReadFacts,
} from "./evidence-store.js";

// EXIT: one page carries at most this many descriptors. The bound is the spec's
// 8, and it is applied by slicing the grant's own pinned membership, so a
// continuation that would need a ninth descriptor emits a cursor instead of
// widening the page.
export const MAX_EVIDENCE_SUPPORTS_PER_PAGE = 8;

// EXIT: the cursor version this build mints and accepts. A cursor minted under
// any other version is refused as a contract violation rather than decoded on a
// best-effort basis.
export const EVIDENCE_CONTINUATION_CURSOR_VERSION = "1";

/**
 * The trusted caller half of a continuation, supplied by the transport binding
 * and never by the request payload (the B1 decision recorded in the Fin
 * worktree at
 * `docs/validation/2026-10-06-b1-trusted-identity-binding-decision.md`).
 */
export interface SupportContinuationCaller {
  readonly scopeBinding: string;
  readonly authorizedSourceRefs: readonly string[];
}

export interface SupportContinuationRequest {
  readonly evidenceRef: string;
  readonly caller: SupportContinuationCaller;
  readonly at: string;
  /** Opaque continuation position; mutually exclusive with `supportId`. */
  readonly cursor?: string | null;
  /** One named support of this grant; mutually exclusive with `cursor`. */
  readonly supportId?: string | null;
}

/** One retained support as a continuation returns it: identity and locator. */
export interface EvidenceSupportDescriptor {
  readonly support_id: string;
  readonly role: EvidenceSupportRole;
  readonly subject: EvidenceSubjectKind;
  readonly result_id: string;
  readonly source_ref: string;
  readonly source_version: string;
  readonly source_version_id: string;
  readonly location: CompanySourceLocator;
  readonly span: EvidenceSpan | null;
  /** The extraction links the grant pinned at issue time, not the current set. */
  readonly extraction_refs: readonly string[];
}

/**
 * A refusal that is not a fact about the grant itself names `contract_violation`
 * rather than a new member of the closed `EVIDENCE_DENIAL_REASON` union. Frozen
 * as a constant so the added vocabulary has exactly one spelling in this build.
 */
export const CONTRACT_VIOLATION = "contract_violation";

export type SupportDenialReason = EvidenceDenialReason | typeof CONTRACT_VIOLATION;

export interface EvidenceSupportGranted {
  readonly state: "granted";
  readonly evidence_ref: string;
  /** The grant's own fixed expiry, echoed unchanged; a read never moves it. */
  readonly expires_at: string;
  /** How many supports the grant pinned, so a caller knows when it is done. */
  readonly total_supports: number;
  readonly supports: readonly EvidenceSupportDescriptor[];
  readonly next_cursor: string | null;
  readonly selected: boolean;
}

export interface EvidenceSupportDenied {
  readonly state: "denied";
  readonly failure: EvidenceFailureToken;
  readonly reason: SupportDenialReason;
  /** Names the violated contract. It never carries a support, a locator or a value. */
  readonly detail: string;
}

export type EvidenceSupportRead = EvidenceSupportGranted | EvidenceSupportDenied;

/** The pinned extraction links of the page's supports, keyed by support id. */
export type PinnedExtractionReader = (
  evidenceRef: string,
  supportIds: readonly string[]
) => Promise<ReadonlyMap<string, readonly string[]>>;

interface ContinuationCursorPayload {
  readonly v: string;
  readonly ref: string;
  readonly scope: string;
  readonly exp: string;
  readonly after: string;
}

function refused(
  failure: EvidenceFailureToken,
  reason: SupportDenialReason,
  detail: string
): EvidenceSupportDenied {
  return { state: "denied", failure, reason, detail };
}

// EXIT: the cursor is base64url over the canonical payload, so a caller cannot
// read a position out of it or construct one by hand. Every field is
// re-verified against the grant read in the same transaction before it is
// believed, so editing the text of a cursor gains nothing.
function encodeCursor(payload: ContinuationCursorPayload): string {
  return Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
}

// EXIT: a cursor that is not base64url text, not canonical JSON, or not an
// object with exactly the cursor's five fields is refused as a contract
// violation. It is never partially decoded.
function decodeCursor(raw: string): ContinuationCursorPayload | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const text = Buffer.from(raw, "base64url").toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed)) return null;
  const keys = Object.keys(parsed).sort();
  const expected = ["after", "exp", "ref", "scope", "v"];
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    return null;
  }
  const values = [parsed["v"], parsed["ref"], parsed["scope"], parsed["exp"], parsed["after"]];
  if (values.some((value) => typeof value !== "string" || value === "")) return null;
  return {
    v: parsed["v"] as string,
    ref: parsed["ref"] as string,
    scope: parsed["scope"] as string,
    exp: parsed["exp"] as string,
    after: parsed["after"] as string,
  };
}

interface ResolvedSelectors {
  readonly after: string | null;
  readonly supportId: string | null;
}

// EXIT: an absent, empty or null selector is the absence of that selector, not
// a third option; a present one is the selector the request named.
function presentSelector(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  return value;
}

// EXIT: a request carrying both a cursor and a selected support id is refused
// as `malformed_evidence_contract` before the grant is read at all, so an
// illegal selector combination can never be answered with a page.
function resolveSelectors(
  request: SupportContinuationRequest
): ResolvedSelectors | EvidenceSupportDenied {
  const cursor = presentSelector(request.cursor);
  const supportId = presentSelector(request.supportId);
  if (cursor !== null && supportId !== null) {
    return refused(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      CONTRACT_VIOLATION,
      "a continuation cursor and a selected support_id are mutually exclusive; a request may name one or the other, never both"
    );
  }
  if (cursor !== null) return resolveCursorSelector(cursor);
  if (supportId === null) return { after: null, supportId: null };
  // EXIT: a selector the caller controls is answered with a refusal, never with
  // an exception. A value that is not a uuid cannot name a member of any grant,
  // so it is refused on its own shape and before the grant is read.
  if (!isUuid(supportId)) {
    return refused(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      CONTRACT_VIOLATION,
      "the selected support_id is not the uuid spelling this build issues, so it cannot name a member of any grant"
    );
  }
  return { after: null, supportId };
}

// EXIT: a cursor over the finite request envelope is refused as
// `evidence_too_large` before it is decoded.
function resolveCursorSelector(cursor: string): ResolvedSelectors | EvidenceSupportDenied {
  const bytes = Buffer.byteLength(cursor, "utf8");
  if (bytes > MAX_EVIDENCE_BYTES) {
    return refused(
      EVIDENCE_FAILURE.TOO_LARGE,
      CONTRACT_VIOLATION,
      `the continuation cursor is ${bytes} bytes, over the ${MAX_EVIDENCE_BYTES} byte request envelope`
    );
  }
  return { after: cursor, supportId: null };
}

function cursorFor(
  grant: { readonly evidence_ref: string; readonly scope_binding: string; readonly expires_at: string },
  after: string
): string {
  return encodeCursor({
    v: EVIDENCE_CONTINUATION_CURSOR_VERSION,
    ref: grant.evidence_ref,
    scope: grant.scope_binding,
    exp: grant.expires_at,
    after,
  });
}

// EXIT: every field of a decoded cursor is checked against the grant this
// transaction actually read. A cursor minted for another reference, another
// expiry, an unknown version, or a position outside the grant's pinned
// membership is refused; the position is only ever a support the grant itself
// pinned, never an offset a caller can name. The cursor's scope field is bound
// to the grant's own scope, and the caller's scope was already required to be
// that same scope above, so a cursor cannot cross callers either.
function verifyCursor(
  raw: string,
  facts: GrantReadFacts,
  pinned: readonly GrantDependencyFact[]
): string | EvidenceSupportDenied {
  const grant = facts.grant!;
  const decoded = decodeCursor(raw);
  if (decoded === null) {
    return refused(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      CONTRACT_VIOLATION,
      "the continuation cursor is not a cursor this build mints; it is refused rather than decoded on a best-effort basis"
    );
  }
  if (decoded.v !== EVIDENCE_CONTINUATION_CURSOR_VERSION) {
    return refused(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      CONTRACT_VIOLATION,
      `the continuation cursor speaks version ${decoded.v}; this build implements ${EVIDENCE_CONTINUATION_CURSOR_VERSION}`
    );
  }
  if (decoded.ref !== grant.evidence_ref) {
    return refused(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      CONTRACT_VIOLATION,
      "a continuation cursor is bound to one evidence reference and cannot be presented with another"
    );
  }
  if (decoded.scope !== grant.scope_binding) {
    return refused(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      CONTRACT_VIOLATION,
      "the continuation cursor's scope is not the scope this grant was admitted under"
    );
  }
  if (decoded.exp !== grant.expires_at) {
    return refused(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      CONTRACT_VIOLATION,
      "the continuation cursor's expiry does not match the grant's fixed expiry, so it cannot be a cursor of this grant"
    );
  }
  if (!pinned.some((entry) => entry.support.support_id === decoded.after)) {
    return refused(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      CONTRACT_VIOLATION,
      "the continuation cursor's position is not a support this grant pinned"
    );
  }
  return decoded.after;
}

// EXIT: the trusted caller half is rechecked here, not inferred from the
// request. An absent scope binding, a scope that is not the grant's own scope,
// or a pinned support whose source is outside the caller's authorized subset
// withholds the whole grant; no page and no single descriptor is emitted.
function requireCaller(
  request: SupportContinuationRequest,
  facts: GrantReadFacts
): string | EvidenceSupportDenied {
  const grant = facts.grant!;
  if (request.caller === undefined || request.caller === null) {
    return refused(
      EVIDENCE_FAILURE.ACCESS_DENIED,
      EVIDENCE_DENIAL_REASON.AUTHORIZATION_REVOKED,
      "the continuation carries no trusted caller binding; an unbound read is refused rather than defaulted to a scope"
    );
  }
  // EXIT: a blank binding is an identity fault, not a malformed grant, so it
  // answers with the same access token as an absent one rather than throwing.
  const scopeBinding = request.caller.scopeBinding;
  if (typeof scopeBinding !== "string" || scopeBinding.trim() === "") {
    return refused(
      EVIDENCE_FAILURE.ACCESS_DENIED,
      EVIDENCE_DENIAL_REASON.AUTHORIZATION_REVOKED,
      "the trusted caller carries no scope binding; an unbound read is refused rather than defaulted to a scope"
    );
  }
  if (scopeBinding !== grant.scope_binding) {
    return refused(
      EVIDENCE_FAILURE.ACCESS_DENIED,
      EVIDENCE_DENIAL_REASON.AUTHORIZATION_REVOKED,
      "the trusted caller's scope is not the scope this grant was admitted under"
    );
  }
  const authorized = new Set(request.caller.authorizedSourceRefs ?? []);
  for (const dependency of facts.dependencies) {
    if (!authorized.has(dependency.support.source_ref)) {
      return refused(
        EVIDENCE_FAILURE.ACCESS_DENIED,
        EVIDENCE_DENIAL_REASON.AUTHORIZATION_REVOKED,
        "one support this grant pinned names a source outside the trusted caller's authorized subset, so the whole grant is withheld"
      );
    }
  }
  return scopeBinding;
}

function sortedPinned(facts: GrantReadFacts): GrantDependencyFact[] {
  return [...facts.dependencies].sort((left, right) => {
    const a = left.support.support_id;
    const b = right.support.support_id;
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
}

function descriptorOf(
  dependency: GrantDependencyFact,
  extractionRefs: ReadonlyMap<string, readonly string[]>
): EvidenceSupportDescriptor {
  const support = dependency.support;
  return {
    support_id: support.support_id,
    role: dependency.role,
    subject: support.subject,
    result_id: support.result_id,
    source_ref: support.source_ref,
    source_version: support.source_version,
    source_version_id: support.source_version_id,
    location: support.location,
    span: support.span,
    extraction_refs: [...(extractionRefs.get(support.support_id) ?? [])],
  };
}

function grantedOutcome(
  evidenceRef: string,
  expiresAt: string,
  total: number,
  supports: readonly EvidenceSupportDescriptor[],
  nextCursor: string | null,
  selected: boolean
): EvidenceSupportGranted | EvidenceSupportDenied {
  const payload: EvidenceSupportGranted = {
    state: "granted",
    evidence_ref: evidenceRef,
    expires_at: expiresAt,
    total_supports: total,
    supports,
    next_cursor: nextCursor,
    selected,
  };
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (bytes > MAX_EVIDENCE_BYTES) {
    // EXIT: a page that cannot fit the bounded envelope withholds the whole
    // page. Dropping a descriptor to make it fit would hand back a sequence the
    // caller cannot tell is short, so the page is refused instead.
    return refused(
      EVIDENCE_FAILURE.TOO_LARGE,
      CONTRACT_VIOLATION,
      `the continuation page serializes to ${bytes} bytes, over the ${MAX_EVIDENCE_BYTES} byte envelope`
    );
  }
  return payload;
}

function requireRowGrant(
  facts: GrantReadFacts,
  at: string
): { readonly grant: EvidenceGrantRecord } | EvidenceSupportDenied {
  const replay = decideGrantRead(facts, at);
  if (replay.state === "denied") {
    return refused(
      replay.failure,
      replay.reason,
      "the grant itself is withheld, so no support of it is paged"
    );
  }
  if (replay.grant.kind === EVIDENCE_GRANT_KIND.COUNT) {
    // EXIT: a count grant retains a receipt and no membership, so any supports
    // read of it is refused. It is not answered with an empty page, which a
    // caller could not distinguish from a row grant with no supports.
    return refused(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      CONTRACT_VIOLATION,
      "a count grant retains no support membership, so it cannot serve a supports read"
    );
  }
  return { grant: replay.grant };
}

/**
 * Decide one support continuation. The order below is the whole contract:
 * selectors, then the EP3 replay decision, then the grant kind, then the trusted
 * caller, then the cursor, then the page, then the envelope. Every step before
 * the last two returns a refusal instead of a partial answer, so a denied
 * obligation withholds the entire grant rather than a page of it.
 */
export async function decideSupportContinuation(
  facts: GrantReadFacts,
  request: SupportContinuationRequest,
  readPinnedExtractions: PinnedExtractionReader
): Promise<EvidenceSupportRead> {
  const selectors = resolveSelectors(request);
  if ("state" in selectors) return selectors;

  // EXIT: the two envelope fields are caller-supplied too, so they are refused
  // on their own shape rather than throwing out of a function whose every other
  // branch answers with a value. A missing reference and an unreadable instant
  // are both the request's fault and neither reveals anything about the grant.
  if (typeof request.evidenceRef !== "string" || request.evidenceRef.trim() === "") {
    return refused(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      CONTRACT_VIOLATION,
      "the continuation names no evidence reference, so it cannot be resolved to a grant"
    );
  }
  if (!isInstantText(request.at)) {
    return refused(
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      CONTRACT_VIOLATION,
      "the continuation's at is not an RFC 3339 instant this build can read"
    );
  }
  const evidenceRef = request.evidenceRef;
  const at = instantText(request.at, "at");
  const admitted = requireRowGrant(facts, at);
  if ("state" in admitted) return admitted;
  const grant = admitted.grant;
  const callerScopeBinding = requireCaller(request, facts);
  if (typeof callerScopeBinding !== "string") return callerScopeBinding;

  const pinned = sortedPinned(facts);
  const after = resolvePosition(selectors, facts, pinned);
  if (typeof after !== "string" && after !== null) return after;
  const page = selectPage({ after, supportId: selectors.supportId }, pinned);
  if ("failure" in page) return page.failure;

  const extractionRefs = await readPinnedExtractions(
    evidenceRef,
    page.members.map((entry) => entry.support.support_id)
  );
  const supports = page.members.map((entry) => descriptorOf(entry, extractionRefs));
  return grantedOutcome(
    evidenceRef,
    grant.expires_at,
    pinned.length,
    supports,
    nextCursorFor(grant, pinned, page, supports),
    page.selected
  );
}

// EXIT: a verified cursor position, or the absence of one. A position this
// transaction cannot verify against the grant it just read is a refusal, not a
// starting offset.
function resolvePosition(
  selectors: ResolvedSelectors,
  facts: GrantReadFacts,
  pinned: readonly GrantDependencyFact[]
): string | null | EvidenceSupportDenied {
  if (selectors.after === null) return null;
  return verifyCursor(selectors.after, facts, pinned);
}

// EXIT: the last page of the grant's membership carries no cursor, because a
// cursor past the end is a position that resolves to nothing. A selected
// support is answered on its own and never opens a sequence.
function nextCursorFor(
  grant: { readonly evidence_ref: string; readonly scope_binding: string; readonly expires_at: string },
  pinned: readonly GrantDependencyFact[],
  page: SelectedPage,
  supports: readonly EvidenceSupportDescriptor[]
): string | null {
  if (page.selected) return null;
  const last = supports[supports.length - 1]!;
  return last.support_id === pinned[pinned.length - 1]!.support.support_id
    ? null
    : cursorFor(grant, last.support_id);
}

interface SelectedPage {
  readonly members: readonly GrantDependencyFact[];
  readonly selected: boolean;
}

/**
 * Resolve the selectors against the grant's own pinned membership: a verified
 * cursor position, one selected member, or the next page of at most eight. The
 * whole-grant recheck has already passed by the time this runs, so a refusal
 * here is about the selector alone.
 */
function selectPage(
  selectors: ResolvedSelectors,
  pinned: readonly GrantDependencyFact[]
): SelectedPage | { readonly failure: EvidenceSupportDenied } {
  if (selectors.supportId !== null) {
    // EXIT: a selected support must be one the grant itself pinned. A support
    // that exists but belongs to another grant is refused rather than resolved,
    // so selection can never reach past the grant's own membership.
    const member = pinned.find((entry) => entry.support.support_id === selectors.supportId);
    if (member === undefined) {
      return {
        failure: refused(
          EVIDENCE_FAILURE.MALFORMED_CONTRACT,
          CONTRACT_VIOLATION,
          "the selected support_id is not a member of this grant, so the grant cannot resolve it"
        ),
      };
    }
    return { members: [member], selected: true };
  }
  if (selectors.after === null) {
    return boundedSlice(pinned, 0);
  }
  const start =
    pinned.findIndex((entry) => entry.support.support_id === selectors.after) + 1;
  return boundedSlice(pinned, start);
}

// EXIT: a position past the end of the pinned membership is refused rather than
// answered with an empty page, which a caller could not tell from a grant that
// retained no support at all. It is reachable only from a cursor this build did
// not mint, because the last page of a sequence carries no cursor.
function boundedSlice(
  pinned: readonly GrantDependencyFact[],
  start: number
): SelectedPage | { readonly failure: EvidenceSupportDenied } {
  const members = pinned.slice(start, start + MAX_EVIDENCE_SUPPORTS_PER_PAGE);
  if (members.length === 0) {
    return {
      failure: refused(
        EVIDENCE_FAILURE.MALFORMED_CONTRACT,
        CONTRACT_VIOLATION,
        "this continuation position is past the end of the grant's pinned membership; there is no page to return"
      ),
    };
  }
  return { members, selected: false };
}

/**
 * Read one continuation page against real storage. The grant, the scope
 * revisions, the pinned membership with each support's obligation stamp, the
 * pinned extraction links and the emitted descriptors are all decided between
 * one BEGIN and one COMMIT, so a revocation or a purge committed while the
 * decision is being made cannot be observed by any statement inside it.
 *
 * The fence is one transaction, not one snapshot: `inEvidenceTransaction`
 * issues a plain `BEGIN`, so each statement takes its own READ COMMITTED view.
 * That is sound here because nothing a concurrent writer can do widens this
 * page — `evidence_grant_extractions` is written once, when the grant is
 * issued, and a support's obligation stamp is read in the same statement that
 * carries its membership. Widening either table would be a different design.
 */
export async function readGrantSupportContinuation(
  lease: () => Promise<EvidenceLeasedClient>,
  request: SupportContinuationRequest
): Promise<EvidenceSupportRead> {
  return inEvidenceTransaction(lease, async (client) =>
    decideSupportContinuation(
      await readGrantFacts(client, request.evidenceRef),
      request,
      async (evidenceRef, supportIds) =>
        readGrantPinnedExtractionsForSupports(client, evidenceRef, supportIds)
    )
  );
}
