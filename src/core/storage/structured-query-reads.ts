/**
 * The read side of structured Query: one row per authorized subject, cursor
 * pagination, and an exact count — all from ONE consistent read.
 *
 * Four things here are load-bearing and easy to get wrong:
 *
 * 1. **One transaction per response.** Rows, count, maintenance status and the
 *    read revision are read inside a single `REPEATABLE READ READ ONLY`
 *    transaction, because list, count and receipt must share one revision. The
 *    free `withAuthorizedScope` is deliberately NOT used here: it opens a plain
 *    `BEGIN`, takes write locks, and can advance the scope's own revisions —
 *    precisely what a read must not do.
 *
 * 2. **One row per subject, never one per support.** A result supported by two
 *    sources, or by two supports of one source, is ONE row carrying a support
 *    SET. Grouping by result id is what keeps `count` equal to the distinct
 *    stored subject set instead of a support fan-out.
 *
 * 3. **The cursor is verified against the reads that received it.** Version,
 *    query digest, subject, owner binding, reader binding, read revision and the
 *    fixed expiry are all re-checked here, so editing a cursor's text achieves
 *    nothing, and a maintenance-progress revision — which does NOT move
 *    `read_revision` — leaves a live cursor live.
 *
 * 4. **No wall-clock filter and no two-hop traversal.** `valid_window` is carried
 *    out and never compared to now; the relationship predicate binds the anchor
 *    to exactly one endpoint column. Neither is expressible as anything else,
 *    which is stronger than validating them away.
 *
 * This reader does NOT issue its own evidence grants. A grant is a WRITE and this
 * transaction is `READ ONLY`, so the read returns a `StructuredQueryReadPlan`
 * carrying everything a grant needs; the caller issues it through the injected
 * `StructuredQueryGrantIssuer` and projects the outcome with
 * `buildStructuredResult`. That keeps P1-I6's grant wiring a constructor
 * injection instead of a rewrite.
 */
import {
  buildMaintenanceStatus,
  type MaintenanceStatus,
} from "../maintenance/maintenance-status.js";
import {
  StructuredQueryError,
  type StructuredErrorCode,
} from "../structured/errors.js";
import { STRUCTURED_LIST_DEFAULT_LIMIT } from "../structured/request.js";
import type { ValidatedStructuredQuery } from "../structured/request.js";
import {
  STRUCTURED_RESULT_MAX_BYTES,
  type StructuredEndpointRecord,
  STRUCTURED_RESULT_COUNT_COVERAGE,
  type StructuredMaintenanceRecord,
  type StructuredReadOutcome,
  type StructuredSupportRecord,
} from "../structured/result.js";
import { stableSourceRefs } from "./structured-scope-locks-pg.js";
import {
  buildPgMaintenanceStatus,
  readPgStatusRevisions,
} from "./structured-status-reads.js";
import { buildPgAcceptedSnapshot } from "./structured-scope-reads.js";
import {
  scopeAuthorityOf,
  StructuredScopeError,
  type AcceptedInputSnapshot,
  type AuthorizedScopeContext,
  type AuthorizedScopeUnitOfWork,
  type PreparedMemoryScopeWork,
  type ScopeTransactionClient,
  type ScopeTransactionOwner,
  type StructuredScopeFailureCode,
} from "./structured-scope-types.js";
import {
  decodeStructuredQueryCursor,
  encodeStructuredQueryCursor,
  STRUCTURED_QUERY_CURSOR_LIFETIME_MS,
  STRUCTURED_QUERY_CURSOR_VERSION,
  structuredQueryDigest,
} from "./structured-query-cursor.js";

// The envelope, inline-provenance and count-coverage bounds are already decided
// by the wire projection, so they are RE-EXPORTED rather than restated: a second
// copy of a 32 KiB or an 8 could drift from the one the consumer enforces.
export {
  STRUCTURED_RESULT_COUNT_COVERAGE,
  STRUCTURED_RESULT_MAX_BYTES,
  STRUCTURED_RESULT_MAX_INLINE_SUPPORTS,
} from "../structured/result.js";

export {
  STRUCTURED_QUERY_CURSOR_LIFETIME_MS,
  STRUCTURED_QUERY_CURSOR_VERSION,
  structuredQueryDigest,
} from "./structured-query-cursor.js";

/**
 * The reader execution lease.
 *
 * A read that has not produced a complete page or a complete count by now has
 * not answered the question, and the contract forbids answering with a partial
 * one — so this is `query_timeout`, never a shorter page.
 */
export const STRUCTURED_QUERY_READER_LEASE_MS = 60_000;

/** The exact tuple behind one assertion UUID, as the identity registry holds it. */
export interface StructuredQueryRelationTuple {
  readonly assertionId: string;
  readonly headEntityId: string;
  readonly relationNorm: string;
  readonly tailEntityId: string;
  /** Whole-second UTC bounds or null; carried out, never compared to now. */
  readonly validWindow: {
    readonly from: string | null;
    readonly until: string | null;
  };
}

/** Resolves the tuples of the assertion ids a read is deciding on. */
export interface StructuredQueryTupleReader {
  readTuples(
    assertionIds: readonly string[]
  ): Promise<ReadonlyMap<string, StructuredQueryRelationTuple>>;
}

/** One support's citable facts, joined with its extraction links. */
export interface StructuredQuerySupportFact {
  readonly supportId: string;
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly location: {
    readonly documentId: string;
    readonly version: string;
    readonly unit: number;
  };
  readonly span: { readonly start: number; readonly end: number } | null;
  readonly extractionRefs: readonly string[];
}

/** Resolves the supports a returned page cites, from the immutable support store. */
export interface StructuredQuerySupportReader {
  readSupports(
    supportIds: readonly string[]
  ): Promise<ReadonlyMap<string, StructuredQuerySupportFact>>;
}

/** Why a grant holds a support: the row's own, or a relation endpoint's display. */
export const STRUCTURED_QUERY_SUPPORT_ROLE = {
  OCCURRENCE: "occurrence",
  ENDPOINT_DISPLAY: "endpoint_display",
} as const;

export type StructuredQuerySupportRole =
  (typeof STRUCTURED_QUERY_SUPPORT_ROLE)[keyof typeof STRUCTURED_QUERY_SUPPORT_ROLE];

/**
 * Everything an evidence grant needs, minus the reference itself.
 *
 * The reader returns these rather than calling `issueGrantRows`, because issuing
 * a grant is a write and this read is `READ ONLY`. The shape is deliberately
 * field-for-field the grant request, so P1-I6 is a constructor injection.
 */
export interface StructuredQueryGrantPlan {
  readonly kind: "row" | "count";
  readonly subject: "entity" | "assertion";
  readonly operation: "list" | "count";
  readonly queryDigest: string;
  readonly scopeBinding: string;
  readonly readRevision: string;
  /** The whole-second query instant the grant's fixed lifetime is measured from. */
  readonly queriedAt: string;
  /** The envelope context the grant is replayed under. */
  readonly context: Readonly<Record<string, unknown>>;
  /** The exact row, or the bounded receipt a count grant is allowed to retain. */
  readonly value: unknown;
  readonly supports: readonly {
    readonly support_id: string;
    readonly role: StructuredQuerySupportRole;
  }[];
  readonly count: number | null;
}

/**
 * The seam that turns a plan into a citable reference.
 *
 * Its natural implementation is the evidence store's own
 * `issueGrantRows(client, { grant: plan, evidenceRef, receiptId })`. It is an
 * optional constructor dependency so this reader does not require the evidence
 * lane to be wired before it can answer a query.
 */
export type StructuredQueryGrantIssuer = (
  plan: StructuredQueryGrantPlan
) => Promise<string>;

/** One entity row before its reference exists. */
export interface StructuredQueryEntityRowPlan {
  readonly subject: "entity";
  readonly id: string;
  readonly canonicalName: string;
  readonly type: string;
  readonly displaySupportId: string;
  readonly displayDisagreement: boolean;
  readonly supports: readonly StructuredSupportRecord[];
}

/** One relation-assertion row before its reference exists. */
export interface StructuredQueryRelationRowPlan {
  readonly subject: "relation_assertion";
  readonly id: string;
  readonly head: StructuredEndpointRecord;
  readonly relationNorm: string;
  readonly tail: StructuredEndpointRecord;
  readonly validWindow: {
    readonly from: string | null;
    readonly until: string | null;
  };
  readonly supports: readonly StructuredSupportRecord[];
}

/**
 * One row before its evidence reference exists.
 *
 * The reference is the grant's to mint, so the plan carries everything else the
 * projection needs and nothing that would have to be written back afterwards.
 */
export type StructuredQueryRowPlan =
  | StructuredQueryEntityRowPlan
  | StructuredQueryRelationRowPlan;

/** What the reader proved, before any evidence reference was issued. */
export interface StructuredQueryReadPlan {
  readonly kind: "list" | "count";
  readonly subject: "entity" | "relation_assertion";
  readonly operation: "list" | "count";
  readonly queryDigest: string;
  readonly scopeBinding: string;
  readonly readerBinding: string;
  readonly authorizationRevision: string;
  readonly readRevision: string;
  readonly queriedAt: string;
  readonly maintenance: StructuredMaintenanceRecord;
  readonly rows: readonly StructuredQueryRowPlan[];
  readonly nextCursor: string | null;
  readonly count: number | null;
  /** One row grant per returned row, or exactly one count grant. */
  readonly grants: readonly StructuredQueryGrantPlan[];
}

/** The read surface both lanes implement. */
export interface StructuredQueryStorage {
  readStructuredQuery(
    context: AuthorizedScopeContext,
    request: ValidatedStructuredQuery
  ): Promise<StructuredQueryReadPlan>;
}

/**
 * Attach issued references to a plan and produce the projection's outcome.
 *
 * A count's reference belongs to the context, because the receipt cites it; each
 * row carries its own. A plan with no reference where one is required refuses
 * rather than emitting a row that claims to be citable and is not.
 */
export function structuredQueryReadOutcome(
  plan: StructuredQueryReadPlan,
  issued: readonly string[]
): StructuredReadOutcome {
  const maintenance = plan.maintenance;
  if (plan.kind === "count") {
    return {
      kind: "count",
      context: {
        queryDigest: plan.queryDigest,
        scopeBinding: plan.scopeBinding,
        readRevision: plan.readRevision,
        evidenceRef: requireIssued(issued[0], "the count receipt"),
        maintenance,
      },
      count: plan.count ?? refuseCount(),
    };
  }
  return {
    kind: "list",
    context: {
      queryDigest: plan.queryDigest,
      scopeBinding: plan.scopeBinding,
      readRevision: plan.readRevision,
      // The list envelope carries no context-level reference of its own — each
      // row cites itself — but the projection still requires this member to be
      // filled, so the first row's reference stands in for the page.
      evidenceRef: issued[0] ?? "",
      maintenance,
    },
    rows: plan.rows.map((row, index) => ({
      ...row,
      evidenceRef: requireIssued(issued[index], `row ${row.id}`),
    })),
    nextCursor: plan.nextCursor,
  };
}

function requireIssued(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new StructuredQueryError(
      `structured read carries no evidence reference for ${label}`,
      "structured_search_unavailable"
    );
  }
  return value;
}

function refuseCount(): never {
  throw new StructuredQueryError(
    "structured count read produced no count",
    "count_unavailable"
  );
}

// ---------------------------------------------------------------------------
// Entry gate and refusal translation
// ---------------------------------------------------------------------------

/**
 * Only a context THIS composition minted may be read against.
 *
 * A structurally assembled context — one built from model output rather than
 * server composition — is refused here, before any connection is leased.
 */
function requireOwnContext(
  authority: unknown,
  context: AuthorizedScopeContext
): void {
  let minted: unknown;
  try {
    minted = scopeAuthorityOf(context);
  } catch (error) {
    throw asStructuredFailure(error);
  }
  if (minted === authority) return;
  throw new StructuredQueryError(
    "the authorized scope context was not minted by this storage composition",
    "authorization_denied"
  );
}

/** Narrow a requested set to the trusted authorized subset, refusing anything wider. */
function authorizedSubset(
  context: AuthorizedScopeContext,
  requested: readonly string[]
): readonly string[] {
  const allowed = new Set(context.authorizedSourceRefs);
  const widened = requested.filter((ref) => !allowed.has(ref));
  if (widened.length > 0) {
    throw new StructuredQueryError(
      `requested sources outside the trusted context: ${widened.join(", ")}`,
      "authorization_denied"
    );
  }
  return stableSourceRefs(requested);
}

/**
 * Re-read the scope's authorization inside the read transaction.
 *
 * A context minted before a revocation still names a scope this reader would
 * happily read; only the persisted revision says whether it is still authorized.
 */
async function assertCurrentAuthorization(
  client: ScopeTransactionClient,
  context: AuthorizedScopeContext
): Promise<void> {
  const { rows } = await client.query(
    `SELECT authorization_revision
       FROM evidence_scope_revisions WHERE scope_binding = $1`,
    [context.ownerScopeBinding]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  const granted = row?.authorization_revision;
  if (granted === context.authorizationRevision) return;
  // EXIT: the scope carries no authorization row, or its authorization moved
  // after this context was minted. An old cursor must not restore revoked access.
  throw new StructuredQueryError(
    granted === undefined || granted === null
      ? "the trusted scope carries no authorization revision"
      : "the trusted scope's authorization changed after this context was minted",
    "authorization_denied"
  );
}

/**
 * The one place the two seams' vocabularies are translated.
 *
 * A scope failure that has no query equivalent becomes
 * `structured_search_unavailable`: the request was valid, so retrying it unchanged
 * cannot help beyond the code's own retryability.
 */
const SCOPE_CODE_MAP: Readonly<Partial<Record<StructuredScopeFailureCode, StructuredErrorCode>>> =
  {
    access_denied: "authorization_denied",
    maintenance_status_unavailable: "maintenance_status_unavailable",
    execution_timeout: "query_timeout",
    lease_lost: "query_timeout",
  };

function structuredRefusal(error: StructuredScopeError): StructuredQueryError {
  return new StructuredQueryError(
    error.message,
    SCOPE_CODE_MAP[error.code] ?? "structured_search_unavailable"
  );
}

function asStructuredFailure(error: unknown): StructuredQueryError {
  if (error instanceof StructuredQueryError) return error;
  if (error instanceof StructuredScopeError) return structuredRefusal(error);
  return new StructuredQueryError(
    error instanceof Error ? error.message : String(error),
    "structured_search_unavailable"
  );
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/** A verified continuation: where to resume, and the expiry it may not outlive. */
interface StructuredQueryContinuation {
  readonly after: string | null;
  readonly expiresAt: string;
}

/**
 * Decide where this request starts, and when its cursor stops being valid.
 *
 * A first page opens a FIXED window from now. A continuation inherits the expiry
 * it was issued with rather than opening a new one — which is what stops a caller
 * renewing its own ten minutes one page at a time.
 */
function resolveContinuation(
  request: ValidatedStructuredQuery,
  context: AuthorizedScopeContext,
  readRevision: string,
  queryDigest: string,
  now: Date
): StructuredQueryContinuation {
  const nowMs = now.getTime();
  if (request.cursor === undefined) {
    return {
      after: null,
      expiresAt: new Date(
        nowMs + STRUCTURED_QUERY_CURSOR_LIFETIME_MS
      ).toISOString(),
    };
  }
  const decoded = decodeStructuredQueryCursor(request.cursor);
  if (decoded === null) {
    // EXIT: the text is not a cursor this build mints. It is refused whole,
    // because a cursor whose half was understood is a position never issued.
    throw new StructuredQueryError(
      "the continuation cursor is not a cursor this build issues",
      "invalid_cursor"
    );
  }
  if (decoded.v !== STRUCTURED_QUERY_CURSOR_VERSION) {
    throw new StructuredQueryError(
      `the continuation cursor speaks version ${decoded.v}; this build implements ${STRUCTURED_QUERY_CURSOR_VERSION}`,
      "invalid_cursor"
    );
  }
  if (nowMs > Date.parse(decoded.exp)) {
    throw new StructuredQueryError(
      "the continuation cursor outlived its fixed lifetime; restart at the first page",
      "cursor_expired"
    );
  }
  // EXIT: the query, the subject, either scope binding, or the read revision
  // differs. Continuing would walk a result set the caller is no longer asking
  // about, or through rows that no longer exist under the same authorization.
  if (
    decoded.q !== queryDigest ||
    decoded.s !== request.subject ||
    decoded.o !== context.ownerScopeBinding ||
    decoded.r !== context.readerBinding ||
    decoded.rev !== readRevision
  ) {
    throw new StructuredQueryError(
      "the continuation cursor was issued for a different query, scope or read revision",
      "cursor_revision_mismatch"
    );
  }
  return { after: decoded.aft, expiresAt: decoded.exp };
}

function mintCursor(input: {
  readonly queryDigest: string;
  readonly subject: string;
  readonly context: AuthorizedScopeContext;
  readonly readRevision: string;
  readonly expiresAt: string;
  readonly after: string;
}): string {
  return encodeStructuredQueryCursor({
    v: STRUCTURED_QUERY_CURSOR_VERSION,
    q: input.queryDigest,
    s: input.subject,
    o: input.context.ownerScopeBinding,
    r: input.context.readerBinding,
    rev: input.readRevision,
    exp: input.expiresAt,
    aft: input.after,
  });
}

// ---------------------------------------------------------------------------
// Grouping, display and filtering
// ---------------------------------------------------------------------------

/** One authorized subject: its whole current support set, across every source. */
interface SubjectGroup {
  readonly resultId: string;
  readonly supportIds: Set<string>;
  readonly sourceRefs: Set<string>;
}

/** The attributed display value chosen for one subject, and how divided it is. */
interface SubjectDisplay {
  readonly canonicalName: string;
  readonly entityType: string;
  readonly supportId: string;
  readonly distinctPairs: number;
}

/** How one subject was stored, so an entity row can find an endpoint's display. */
type StorageSubject = "entity" | "assertion";

function storageSubjectOf(subject: "entity" | "relation_assertion"): StorageSubject {
  return subject === "entity" ? "entity" : "assertion";
}

/**
 * One group per result, merging every authorized source that supports it.
 *
 * This is the row-multiplicity rule: a second source behind the same result adds
 * a support, never a row and never a second contribution to `count`.
 */
function groupSubjects(
  memberships: AcceptedInputSnapshot["memberships"],
  storageSubject: StorageSubject
): Map<string, SubjectGroup> {
  const groups = new Map<string, SubjectGroup>();
  for (const membership of memberships) {
    if (membership.subject !== storageSubject) continue;
    let group = groups.get(membership.resultId);
    if (group === undefined) {
      group = {
        resultId: membership.resultId,
        supportIds: new Set(),
        sourceRefs: new Set(),
      };
      groups.set(membership.resultId, group);
    }
    group.sourceRefs.add(membership.sourceRef);
    for (const supportId of membership.supportIds) group.supportIds.add(supportId);
  }
  return groups;
}

/**
 * The attributed display value of each subject, chosen deterministically.
 *
 * Attributed values are read per (source, extraction) and filtered down to the
 * supports that actually stand behind THIS subject, so a sibling result's alias
 * inside the same extraction can never select this row's name. Among the current
 * authorized supports, the smallest distinct `(canonical_name, entity_type)` pair
 * by UTF-8 byte order wins and within that pair the smallest support UUID does;
 * more than one distinct pair is a DECLARED disagreement, not a silent pick, and
 * arrival order cannot reach any of the three comparisons.
 */
function displayIndex(
  snapshot: AcceptedInputSnapshot,
  groups: ReadonlyMap<string, SubjectGroup>
): Map<string, SubjectDisplay> {
  const extractions = new Map<string, AcceptedInputSnapshot["extractions"][number]>();
  for (const extraction of snapshot.extractions) {
    extractions.set(`${extraction.sourceRef}\u0000${extraction.extractionRef}`, extraction);
  }
  const chosen = new Map<string, MutableDisplay>();
  for (const membership of snapshot.memberships) {
    const group = groups.get(membership.resultId);
    if (group === undefined) continue;
    const supports = new Set(membership.supportIds);
    for (const extractionRef of membership.extractionRefs) {
      const extraction = extractions.get(`${membership.sourceRef}\u0000${extractionRef}`);
      if (extraction === undefined) continue;
      for (const value of extraction.attributedValues) {
        if (supports.has(value.supportId)) {
          recordDisplayCandidate(chosen, membership.resultId, value);
        }
      }
    }
  }
  const result = new Map<string, SubjectDisplay>();
  for (const [resultId, entry] of chosen) {
    result.set(resultId, {
      canonicalName: entry.canonicalName,
      entityType: entry.entityType,
      supportId: entry.supportId,
      distinctPairs: entry.pairs.size,
    });
  }
  return result;
}

interface MutableDisplay {
  canonicalName: string;
  entityType: string;
  supportId: string;
  readonly pairs: Set<string>;
}

function recordDisplayCandidate(
  chosen: Map<string, MutableDisplay>,
  resultId: string,
  value: { readonly supportId: string; readonly canonicalName: string; readonly entityType: string }
): void {
  let entry = chosen.get(resultId);
  if (entry === undefined) {
    entry = {
      canonicalName: value.canonicalName,
      entityType: value.entityType,
      supportId: value.supportId,
      pairs: new Set(),
    };
    chosen.set(resultId, entry);
  }
  entry.pairs.add(`${value.canonicalName}\u0000${value.entityType}`);
  if (
    compareUtf8(value.canonicalName, entry.canonicalName) < 0 ||
    (value.canonicalName === entry.canonicalName &&
      (compareUtf8(value.entityType, entry.entityType) < 0 ||
        (value.entityType === entry.entityType &&
          compareUuidBytes(value.supportId, entry.supportId) < 0)))
  ) {
    entry.canonicalName = value.canonicalName;
    entry.entityType = value.entityType;
    entry.supportId = value.supportId;
  }
}

/**
 * The exact `eq`/`in` conjunction a grouped subject can be tested against without
 * its tuple — identity and logical-source predicates.
 *
 * `canonical_name` and `type` match the CHOSEN display pair, not every alias:
 * matching on an alias the row does not display would answer a question the
 * response cannot show the answer to. There is no wall-clock comparison anywhere
 * in this predicate, which is why a past or future `valid_window` stays countable.
 */
function matchesOwnFields(
  request: ValidatedStructuredQuery,
  group: SubjectGroup,
  display: SubjectDisplay | null
): boolean {
  for (const filter of request.filters) {
    switch (filter.field) {
      case "id":
        if (!exactTest(filter, group.resultId)) return false;
        break;
      case "canonical_name":
        if (display === null || !exactTest(filter, display.canonicalName)) return false;
        break;
      case "type":
        if (display === null || !exactTest(filter, display.entityType)) return false;
        break;
      case "source_ref":
        if (
          filter.op === "eq"
            ? !group.sourceRefs.has(filter.value)
            : !filter.values.some((value) => group.sourceRefs.has(value))
        ) {
          return false;
        }
        break;
      default:
        // Tuple-level fields are decided against the tuple, not here.
        break;
    }
  }
  return true;
}

/**
 * The one-hop relationship predicate and the tuple-level filters.
 *
 * Outgoing binds the anchor to `head_entity_id` and incoming to `tail_entity_id`.
 * There is no traversal step and no second hop, so a two-hop-only path cannot be
 * reached from this interface at all.
 */
function matchesTuple(
  request: ValidatedStructuredQuery,
  tuple: StructuredQueryRelationTuple
): boolean {
  const relationship = request.relationship;
  if (
    relationship !== undefined &&
    (relationship.direction === "outgoing"
      ? tuple.headEntityId
      : tuple.tailEntityId) !== relationship.anchorEntityId
  ) {
    return false;
  }
  for (const filter of request.filters) {
    switch (filter.field) {
      case "id":
        if (!exactTest(filter, tuple.assertionId)) return false;
        break;
      case "head_id":
        if (!exactTest(filter, tuple.headEntityId)) return false;
        break;
      case "tail_id":
        if (!exactTest(filter, tuple.tailEntityId)) return false;
        break;
      case "relation_norm":
        if (!exactTest(filter, tuple.relationNorm)) return false;
        break;
      default:
        // `source_ref` is a logical-source predicate over the current authorized
        // support, which needs no tuple, so `matchesOwnFields` already decided it.
        // Entity-only fields cannot appear on a relation request; validation
        // refuses them before this reader sees the request.
        break;
    }
  }
  return true;
}

function exactTest(
  filter: ValidatedStructuredQuery["filters"][number],
  value: string
): boolean {
  return filter.op === "eq" ? filter.value === value : filter.values.includes(value);
}

/** Ascending UUID byte order. */
function compareUuidBytes(left: string, right: string): number {
  return compareUtf8(left, right);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** Index of the last group at or below `id`, or -1 when `id` precedes them all. */
function lowerBound(groups: readonly SubjectGroup[], id: string): number {
  let low = 0;
  let high = groups.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (compareUuidBytes(groups[middle]!.resultId, id) <= 0) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

function wholeSecondStamp(milliseconds: number): string {
  return new Date(Math.floor(milliseconds / 1000) * 1000)
    .toISOString()
    .replace(/\.000Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Assembly (shared by both lanes)
// ---------------------------------------------------------------------------

interface AssemblyInput {
  readonly request: ValidatedStructuredQuery;
  readonly context: AuthorizedScopeContext;
  readonly snapshot: AcceptedInputSnapshot;
  readonly maintenance: MaintenanceStatus;
  readonly readRevision: string;
  readonly tuples: StructuredQueryTupleReader;
  readonly supports: StructuredQuerySupportReader;
  readonly now: Date;
  readonly startedAtMs: number;
}

/**
 * Build the page, the count and the grants from one accepted snapshot.
 *
 * The SAME function serves both lanes. That is what makes the memory twin a check
 * on this contract rather than a look-alike: there is no second implementation of
 * grouping, display selection, filtering, ordering or pagination to drift.
 */
async function assembleRead(
  input: AssemblyInput
): Promise<StructuredQueryReadPlan> {
  const { request, context, snapshot } = input;
  const readRevision = input.readRevision;
  const queryDigest = structuredQueryDigest(request);
  assertRevisionBinding(request, readRevision);
  const continuation = resolveContinuation(
    request,
    context,
    readRevision,
    queryDigest,
    input.now
  );
  const queriedAt = wholeSecondStamp(input.now.getTime());
  const maintenance = maintenanceRecord(input.maintenance);
  const shared = {
    queryDigest,
    scopeBinding: context.ownerScopeBinding,
    readerBinding: context.readerBinding,
    authorizationRevision: context.authorizationRevision,
    readRevision,
    queriedAt,
    maintenance,
  };
  const subject = request.subject;
  const groups = groupSubjects(snapshot.memberships, storageSubjectOf(subject));
  const displays = displayIndex(snapshot, displayGroups(snapshot, subject, groups));
  const matched =
    subject === "entity"
      ? matchEntities(request, groups, displays)
      : await matchRelations(request, groups, displays, input.tuples);
  if (request.operation === "count") {
    assertReaderLease(input);
    const count = matched.length;
    return {
      ...shared,
      kind: "count",
      subject,
      operation: "count",
      rows: [],
      nextCursor: null,
      count,
      grants: [countGrant(shared, subject, count)],
    };
  }
  const limit = request.limit ?? STRUCTURED_LIST_DEFAULT_LIMIT;
  const start =
    continuation.after === null ? 0 : lowerBound(matched, continuation.after) + 1;
  const selected = matched.slice(start, start + limit);
  const moreRemain = matched.length > start + selected.length;
  const { rows } = await buildRows(selected, displays, input);
  const bounded = boundPageToEnvelope(rows, {
    maintenance,
    queryDigest,
    scopeBinding: context.ownerScopeBinding,
    readRevision,
    queriedAt,
  });
  const lastEmitted = bounded.rows[bounded.rows.length - 1];
  // The cursor names the last row ACTUALLY emitted. That is what makes reducing
  // the page at a row boundary lossless: the next page resumes from the row the
  // caller last saw, not from one it never received.
  const nextCursor =
    lastEmitted !== undefined && (moreRemain || bounded.rows.length < selected.length)
      ? mintCursor({
          queryDigest,
          subject,
          context,
          readRevision,
          expiresAt: continuation.expiresAt,
          after: lastEmitted.id,
        })
      : null;
  assertReaderLease(input);
  return {
    ...shared,
    kind: "list",
    subject,
    operation: "list",
    rows: bounded.rows,
    nextCursor,
    count: null,
    grants: rowGrants(shared, bounded.rows),
  };
}

/**
 * A count may pin itself to the revision a list returned; a list may not carry a
 * count-only revision, because nothing would check it and a stale one would read
 * as honoured.
 */
function assertRevisionBinding(
  request: ValidatedStructuredQuery,
  readRevision: string
): void {
  if (request.operation === "count") {
    if (request.readRevision !== undefined && request.readRevision !== readRevision) {
      // EXIT: the count asked for a revision this transaction did not read.
      // Answering with the current count would report a receipt for a revision
      // the caller never asked about.
      throw new StructuredQueryError(
        `count asked for read revision ${request.readRevision}; this transaction read ${readRevision}`,
        "read_revision_mismatch"
      );
    }
    return;
  }
  if (request.readRevision !== undefined) {
    throw new StructuredQueryError(
      "a list request cannot carry a count-only read revision",
      "cursor_revision_mismatch"
    );
  }
}

function matchEntities(
  request: ValidatedStructuredQuery,
  groups: ReadonlyMap<string, SubjectGroup>,
  displays: ReadonlyMap<string, SubjectDisplay>
): SubjectGroup[] {
  return [...groups.values()]
    .filter((group) => matchesOwnFields(request, group, displays.get(group.resultId) ?? null))
    .sort((left, right) => compareUuidBytes(left.resultId, right.resultId));
}

/**
 * The matching assertions, in ascending UUID byte order.
 *
 * Tuples are resolved for the candidates that survive the identity and
 * logical-source predicates first, so a page request does not read the tuple
 * registry for results its own filters already excluded.
 */
async function matchRelations(
  request: ValidatedStructuredQuery,
  groups: ReadonlyMap<string, SubjectGroup>,
  displays: ReadonlyMap<string, SubjectDisplay>,
  tuples: StructuredQueryTupleReader
): Promise<SubjectGroup[]> {
  const candidates = [...groups.values()]
    .filter((group) => matchesOwnFields(request, group, displays.get(group.resultId) ?? null))
    .sort((left, right) => compareUuidBytes(left.resultId, right.resultId));
  if (candidates.length === 0) return [];
  const resolved = await tuples.readTuples(candidates.map((group) => group.resultId));
  const matched: SubjectGroup[] = [];
  for (const group of candidates) {
    const tuple = resolved.get(group.resultId);
    if (tuple === undefined) {
      // EXIT: a current assertion membership whose exact-tuple identity is absent
      // cannot be reported with its head, relation, tail or validity. A partial
      // assertion would be a fabricated row, and `count` would be answering about
      // a set this reader cannot fully enumerate.
      throw new StructuredQueryError(
        `structured membership names assertion ${group.resultId}, whose tuple identity is not registered`,
        "structured_search_unavailable"
      );
    }
    if (matchesTuple(request, tuple)) matched.push(group);
  }
  return matched;
}

/**
 * The subjects whose attributed display this request must resolve.
 *
 * An entity request needs entities; a relation request needs the entities its
 * endpoints name. Both are read from the same snapshot inside the same
 * transaction, so the endpoint a row displays is the endpoint the same read saw.
 */
function displayGroups(
  snapshot: AcceptedInputSnapshot,
  subject: "entity" | "relation_assertion",
  groups: ReadonlyMap<string, SubjectGroup>
): Map<string, SubjectGroup> {
  const entities = groupSubjects(snapshot.memberships, "entity");
  if (subject === "entity") return entities;
  const combined = new Map(entities);
  for (const [resultId, group] of groups) combined.set(resultId, group);
  return combined;
}

function maintenanceRecord(status: MaintenanceStatus): StructuredMaintenanceRecord {
  return {
    maintenanceRevision: status.maintenanceRevision,
    sourcesInScope: status.sourcesInScope,
    publishedSources: status.publishedSources,
    desiredIndex: status.desiredIndex,
    conflictChecks: status.conflictChecks,
    rulesetRevision: status.rulesetRevision,
  };
}

/**
 * The reader lease, checked against the same clock the reader stamped with.
 *
 * A read that overran its lease has not produced a complete answer, so it refuses
 * rather than returning a page that is complete but late.
 */
function assertReaderLease(input: AssemblyInput): void {
  if (input.now.getTime() - input.startedAtMs <= STRUCTURED_QUERY_READER_LEASE_MS) return;
  throw new StructuredQueryError(
    `structured read exceeded its ${STRUCTURED_QUERY_READER_LEASE_MS} ms execution lease`,
    "query_timeout"
  );
}

// ---------------------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------------------

async function buildRows(
  page: readonly SubjectGroup[],
  displays: ReadonlyMap<string, SubjectDisplay>,
  input: AssemblyInput
): Promise<{ readonly rows: readonly StructuredQueryRowPlan[] }> {
  if (page.length === 0) return { rows: [] };
  const supportIds = [
    ...new Set(page.flatMap((group) => [...group.supportIds])),
  ].sort(compareUuidBytes);
  const facts = await input.supports.readSupports(supportIds);
  const recordOf = (supportId: string): StructuredSupportRecord => {
    const fact = facts.get(supportId);
    if (fact === undefined) {
      // EXIT: a membership row names a support the immutable support store cannot
      // resolve. The row is mandatory, and a row citing something no continuation
      // could read is not citable.
      throw new StructuredQueryError(
        `structured membership names support ${supportId}, which the support store cannot resolve`,
        "structured_search_unavailable"
      );
    }
    return {
      supportId: fact.supportId,
      sourceRef: fact.sourceRef,
      sourceVersion: fact.sourceVersion,
      location: { ...fact.location },
      extractionRef: fact.extractionRefs[0] ?? "",
      ...(fact.span === null ? {} : { span: fact.span }),
    };
  };
  if (input.request.subject === "entity") {
    return {
      rows: page.map((group) => {
        const display = requireDisplay(displays, group.resultId);
        return {
          subject: "entity",
          id: group.resultId,
          canonicalName: display.canonicalName,
          type: display.entityType,
          displaySupportId: display.supportId,
          displayDisagreement: display.distinctPairs > 1,
          supports: [...group.supportIds].sort(compareUuidBytes).map(recordOf),
        };
      }),
    };
  }
  const resolved = await input.tuples.readTuples(page.map((group) => group.resultId));
  const rows: StructuredQueryRelationRowPlan[] = [];
  for (const group of page) {
    const tuple = resolved.get(group.resultId);
    if (tuple === undefined) {
      throw new StructuredQueryError(
        `structured membership names assertion ${group.resultId}, whose tuple identity is not registered`,
        "structured_search_unavailable"
      );
    }
    const head = endpointRecord(displays, tuple.headEntityId);
    const tail = endpointRecord(displays, tuple.tailEntityId);
    rows.push({
      subject: "relation_assertion",
      id: group.resultId,
      head,
      relationNorm: tuple.relationNorm,
      tail,
      // Carried out verbatim. No wall-clock comparison happens anywhere in this
      // reader, so an interval entirely in the past, or entirely in the future,
      // stays visible and countable.
      validWindow: { ...tuple.validWindow },
      supports: [...group.supportIds].sort(compareUuidBytes).map(recordOf),
    });
  }
  return { rows };
}

/**
 * An endpoint's display, chosen by the same rule as a row's own.
 *
 * An endpoint with no current authorized support in this scope has no attributed
 * display value to report and the contract makes both fields mandatory, so the
 * row refuses rather than naming an entity with an empty name.
 */
function endpointRecord(
  displays: ReadonlyMap<string, SubjectDisplay>,
  entityId: string
): StructuredEndpointRecord {
  const display = requireDisplay(displays, entityId);
  return {
    id: entityId,
    canonicalName: display.canonicalName,
    type: display.entityType,
    displaySupportId: display.supportId,
    displayDisagreement: display.distinctPairs > 1,
  };
}

function requireDisplay(
  displays: ReadonlyMap<string, SubjectDisplay>,
  entityId: string
): SubjectDisplay {
  const display = displays.get(entityId);
  if (display === undefined) {
    throw new StructuredQueryError(
      `entity ${entityId} has no attributed display value among its current authorized supports`,
      "structured_search_unavailable"
    );
  }
  return display;
}

// ---------------------------------------------------------------------------
// Envelope bound
// ---------------------------------------------------------------------------

interface EnvelopeContext {
  readonly maintenance: StructuredMaintenanceRecord;
  readonly queryDigest: string;
  readonly scopeBinding: string;
  readonly readRevision: string;
  readonly queriedAt: string;
}

/**
 * Reduce a list page at ROW boundaries until the encoded response fits.
 *
 * Dropping a trailing row can never skip one, because the cursor is minted from
 * the last row actually emitted — so the caller resumes exactly where the envelope
 * stopped. A page whose FIRST mandatory row cannot fit is `result_too_large`,
 * never an empty successful result, because an empty page cannot be told apart
 * from a genuinely empty result set.
 *
 * The measure is this plan's own encoded form, which the wire projection
 * re-measures exactly on the projected envelope. Refusing slightly early is the
 * safe direction; the projection stays the final authority.
 */
function boundPageToEnvelope(
  rows: readonly StructuredQueryRowPlan[],
  context: EnvelopeContext
): { readonly rows: readonly StructuredQueryRowPlan[] } {
  let bounded = rows;
  while (bounded.length > 0 && encodedPlanBytes(bounded, context) > STRUCTURED_RESULT_MAX_BYTES) {
    bounded = bounded.slice(0, bounded.length - 1);
  }
  if (bounded.length === 0 && rows.length > 0) {
    throw new StructuredQueryError(
      `one structured row exceeds the ${STRUCTURED_RESULT_MAX_BYTES} byte response envelope; narrow the request`,
      "result_too_large"
    );
  }
  return { rows: bounded };
}

function encodedPlanBytes(
  rows: readonly StructuredQueryRowPlan[],
  context: EnvelopeContext
): number {
  return Buffer.byteLength(
    JSON.stringify({ ...context, rows, next_cursor: null }),
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// Grant plans
// ---------------------------------------------------------------------------

interface GrantContext {
  readonly queryDigest: string;
  readonly scopeBinding: string;
  readonly readRevision: string;
  readonly queriedAt: string;
}

function grantContext(context: GrantContext): Readonly<Record<string, unknown>> {
  return {
    query_digest: context.queryDigest,
    scope_binding: context.scopeBinding,
    read_revision: context.readRevision,
  };
}

function rowGrants(
  context: GrantContext,
  rows: readonly StructuredQueryRowPlan[]
): readonly StructuredQueryGrantPlan[] {
  return rows.map((row) => ({
    kind: "row",
    subject: row.subject === "entity" ? "entity" : "assertion",
    operation: "list",
    queryDigest: context.queryDigest,
    scopeBinding: context.scopeBinding,
    readRevision: context.readRevision,
    queriedAt: context.queriedAt,
    context: grantContext(context),
    // The grant retains the row as this read proved it. The reference is the
    // grant's own handle, so it is not part of the retained value.
    value: { ...row },
    supports: grantSupports(row),
    count: null,
  }));
}

/**
 * Endpoint display supports are named with their OWN role, never merged into the
 * row's occurrence set: a merge would make the inline provenance prefix claim
 * supports the result itself does not have.
 */
function grantSupports(row: StructuredQueryRowPlan): readonly {
  readonly support_id: string;
  readonly role: StructuredQuerySupportRole;
}[] {
  const refs: {
    support_id: string;
    role: StructuredQuerySupportRole;
  }[] = row.supports.map((support) => ({
    support_id: support.supportId,
    role: STRUCTURED_QUERY_SUPPORT_ROLE.OCCURRENCE,
  }));
  if (row.subject !== "relation_assertion") return refs;
  const occurrence = new Set(refs.map((ref) => ref.support_id));
  for (const endpoint of [row.head, row.tail]) {
    if (occurrence.has(endpoint.displaySupportId)) continue;
    refs.push({
      support_id: endpoint.displaySupportId,
      role: STRUCTURED_QUERY_SUPPORT_ROLE.ENDPOINT_DISPLAY,
    });
  }
  return refs;
}

function countGrant(
  context: GrantContext,
  subject: "entity" | "relation_assertion",
  count: number
): StructuredQueryGrantPlan {
  return {
    kind: "count",
    subject: subject === "entity" ? "entity" : "assertion",
    operation: "count",
    queryDigest: context.queryDigest,
    scopeBinding: context.scopeBinding,
    readRevision: context.readRevision,
    queriedAt: context.queriedAt,
    context: grantContext(context),
    // The bounded receipt, not the matching ids: a count grant is explicitly not
    // allowed to retain membership, and the backend promises no re-query of it.
    value: {
      subject,
      count,
      coverage: STRUCTURED_RESULT_COUNT_COVERAGE,
    },
    supports: [],
    count,
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL lane
// ---------------------------------------------------------------------------

/** Resolves assertion tuples from the identity registry, on the reader's own client. */
export class PgStructuredQueryTupleReader implements StructuredQueryTupleReader {
  constructor(private readonly client: ScopeTransactionClient) {}

  async readTuples(
    assertionIds: readonly string[]
  ): Promise<ReadonlyMap<string, StructuredQueryRelationTuple>> {
    if (assertionIds.length === 0) return new Map();
    const { rows } = await this.client.query(
      `SELECT assertion_id, head_entity_id, relation_norm, tail_entity_id,
              valid_from, valid_until
         FROM structured_relation_assertion_identities
        WHERE assertion_id = ANY($1::uuid[])`,
      [[...assertionIds]]
    );
    const tuples = new Map<string, StructuredQueryRelationTuple>();
    for (const row of rows as Record<string, any>[]) {
      const tuple: StructuredQueryRelationTuple = {
        assertionId: String(row.assertion_id),
        headEntityId: String(row.head_entity_id),
        relationNorm: String(row.relation_norm),
        tailEntityId: String(row.tail_entity_id),
        validWindow: {
          from: row.valid_from === null ? null : String(row.valid_from),
          until: row.valid_until === null ? null : String(row.valid_until),
        },
      };
      tuples.set(tuple.assertionId, tuple);
    }
    return tuples;
  }
}

/**
 * Resolves citable support facts, on the reader's own client.
 *
 * The extraction links are aggregated in SQL rather than fetched per support, so a
 * page of many supports stays one statement instead of one round trip each.
 */
export class PgStructuredQuerySupportReader implements StructuredQuerySupportReader {
  constructor(private readonly client: ScopeTransactionClient) {}

  async readSupports(
    supportIds: readonly string[]
  ): Promise<ReadonlyMap<string, StructuredQuerySupportFact>> {
    if (supportIds.length === 0) return new Map();
    const { rows } = await this.client.query(
      `SELECT s.support_id, s.source_ref, s.source_version,
              s.document_id, s.unit_version, s.unit, s.span_start, s.span_end,
              coalesce(
                array_agg(e.extraction_ref ORDER BY e.extraction_ref)
                  FILTER (WHERE e.extraction_ref IS NOT NULL),
                ARRAY[]::text[]
              ) AS extraction_refs
         FROM assertion_supports s
         LEFT JOIN support_extractions e ON e.support_id = s.support_id
        WHERE s.support_id = ANY($1::uuid[])
        GROUP BY s.support_id, s.source_ref, s.source_version, s.document_id,
                 s.unit_version, s.unit, s.span_start, s.span_end`,
      [[...supportIds]]
    );
    const facts = new Map<string, StructuredQuerySupportFact>();
    for (const row of rows as Record<string, any>[]) {
      const start = Number(row.span_start);
      const end = Number(row.span_end);
      const fact: StructuredQuerySupportFact = {
        supportId: String(row.support_id),
        sourceRef: String(row.source_ref),
        sourceVersion: String(row.source_version),
        location: {
          documentId: String(row.document_id),
          version: String(row.unit_version),
          unit: Number(row.unit),
        },
        // -1/-1 is the table's "this support has no span" encoding; reporting it
        // as a zero-width span would point a continuation at no characters.
        span: start < 0 ? null : { start, end },
        extractionRefs: (row.extraction_refs as string[]).map(String),
      };
      facts.set(fact.supportId, fact);
    }
    return facts;
  }
}

/**
 * The strict PostgreSQL reader.
 *
 * One pool client, one `REPEATABLE READ READ ONLY` transaction, one commit. The
 * repeatable-read snapshot is what makes the page, the count and the maintenance
 * summary agree: a publication that commits between two of them is invisible to
 * all three rather than visible to only some of them.
 */
export class PgStructuredQueryStorage implements StructuredQueryStorage {
  constructor(
    private readonly scope: AuthorizedScopeUnitOfWork & ScopeTransactionOwner,
    private readonly now: () => Date = () => new Date()
  ) {}

  async readStructuredQuery(
    context: AuthorizedScopeContext,
    request: ValidatedStructuredQuery
  ): Promise<StructuredQueryReadPlan> {
    requireOwnContext(this.scope, context);
    const refs = authorizedSubset(context, context.authorizedSourceRefs);
    const startedAt = this.now().getTime();
    try {
      return await this.scope.runTransaction(
        async (client) => {
          await assertCurrentAuthorization(client, context);
          const revisions = await readPgStatusRevisions(
            client,
            context.ownerScopeBinding
          );
          const snapshot = await buildPgAcceptedSnapshot(
            client,
            context,
            refs,
            revisions.readRevision
          );
          const maintenance = await buildPgMaintenanceStatus(client, context, refs);
          return assembleRead({
            request,
            context,
            snapshot,
            maintenance,
            readRevision: String(revisions.readRevision),
            tuples: new PgStructuredQueryTupleReader(client),
            supports: new PgStructuredQuerySupportReader(client),
            now: this.now(),
            startedAtMs: startedAt,
          });
        },
        // The transaction re-types an error it does not recognise as a scope
        // failure, which would replace this reader's typed refusal with
        // `structured_search_unavailable`. `fail` keeps the code the caller
        // actually threw, and keeps the rollback diagnostics on that same object.
        { readOnly: true, fail: asStructuredFailure }
      );
    } catch (error) {
      throw asStructuredFailure(error);
    }
  }
}

// ---------------------------------------------------------------------------
// Memory lane
// ---------------------------------------------------------------------------

/** The authorized half of the memory unit of work, and nothing more. */
export interface MemoryStructuredQueryAuthority {
  withAuthorizedScope<R>(
    context: AuthorizedScopeContext,
    callback: (work: PreparedMemoryScopeWork) => Promise<R>,
    options?: { readonly additionalSourceRefs?: readonly string[] }
  ): Promise<R>;
}

/**
 * The memory lane's persisted screening evidence, as its own stores hold it.
 *
 * A lane that holds none reports nothing rather than a fabricated record; the
 * status builder then refuses rather than inventing a status nobody observed.
 */
export interface MemoryStructuredQueryScreeningPort {
  readScreeningStatus(
    scopeBinding: string,
    sourceRefs: readonly string[]
  ): readonly {
    readonly sourceRef: string;
    readonly rulesetRevision: string;
    readonly coverage: string;
    readonly retiredSupports: number;
  }[];
}

const NO_SCREENING_EVIDENCE: MemoryStructuredQueryScreeningPort = {
  readScreeningStatus: () => [],
};

/**
 * The memory twin of the reader.
 *
 * It reads through the same authorized unit of work the publication and work
 * adapters use and assembles with the SAME `assembleRead`, so a memory answer
 * cannot come from a private copy of the state and cannot drift from the strict
 * lane's grouping, display, filtering, ordering or pagination.
 *
 * This authority's `withAuthorizedScope` is the twin of the transaction owner,
 * not the free PostgreSQL one: it serializes on the shared tail and advances no
 * revision, because this callback calls neither `prepare` nor `bumpRevisions`.
 */
export class MemoryStructuredQueryStorage implements StructuredQueryStorage {
  constructor(
    private readonly scope: MemoryStructuredQueryAuthority,
    private readonly tuples: StructuredQueryTupleReader,
    private readonly supports: StructuredQuerySupportReader,
    private readonly screening: MemoryStructuredQueryScreeningPort = NO_SCREENING_EVIDENCE,
    private readonly now: () => Date = () => new Date()
  ) {}

  async readStructuredQuery(
    context: AuthorizedScopeContext,
    request: ValidatedStructuredQuery
  ): Promise<StructuredQueryReadPlan> {
    requireOwnContext(this.scope, context);
    const refs = authorizedSubset(context, context.authorizedSourceRefs);
    const startedAt = this.now().getTime();
    try {
      return await this.scope.withAuthorizedScope(
        context,
        async (work) => {
          const [accepted, maintenanceInputs] = await Promise.all([
            work.readAcceptedInputs(refs),
            work.readMaintenanceInputs(refs),
          ]);
          assertSameActiveScope(maintenanceInputs.sources, accepted.sources);
          const maintenance = buildMaintenanceStatus({
            snapshot: {
              maintenanceRevision: maintenanceInputs.maintenanceRevision,
              readRevision: accepted.readRevision,
              sources: maintenanceInputs.sources,
              work: maintenanceInputs.work,
            },
            screening: this.screening.readScreeningStatus(
              maintenanceInputs.ownerScopeBinding,
              maintenanceInputs.sources.map((source) => source.sourceRef)
            ),
          });
          return assembleRead({
            request,
            context,
            snapshot: accepted,
            maintenance,
            readRevision: String(accepted.readRevision),
            tuples: this.tuples,
            supports: this.supports,
            now: this.now(),
            startedAtMs: startedAt,
          });
        },
        { additionalSourceRefs: [] }
      );
    } catch (error) {
      throw asStructuredFailure(error);
    }
  }
}

/**
 * The two authorized views of one unit of work must name the same active set.
 *
 * A status computed from one set beside rows read from another is exactly the
 * mixed snapshot this contract forbids, and a caller cannot detect it downstream.
 */
function assertSameActiveScope(
  maintenanceSources: readonly { readonly sourceRef: string }[],
  acceptedSources: readonly { readonly sourceRef: string }[]
): void {
  const fromMaintenance = maintenanceSources.map((source) => source.sourceRef).sort().join(",");
  const fromAccepted = acceptedSources.map((source) => source.sourceRef).sort().join(",");
  if (fromMaintenance === fromAccepted) return;
  throw new StructuredQueryError(
    "structured maintenance status is unavailable: the authorized views disagree about the active source set",
    "maintenance_status_unavailable"
  );
}