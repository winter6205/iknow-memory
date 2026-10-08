/**
 * MP15's PostgreSQL delete store: one payload's dependency-ordered deletion,
 * resumable from per-phase progress, inside ONE transaction of the shared
 * scope seam (plan `structured-corpus-mp15-delete-p3-i4.md`).
 *
 * **It does NOT compose through `withAuthorizedScope`, and that is the plan's
 * recorded decision, not an omission.** `withAuthorizedScope` always locks the
 * context's authorized sources and then calls `assertAuthorizedSourcesActive`,
 * which refuses an inactive row (`structured-scope-uow.ts:359-370`) — and MP15
 * deletes retired AND withdrawn payloads, so an inactive row is this
 * capability's normal case, not an edge. Bypassing the read-admission
 * assertion is not a new hole: it is MP16's route
 * (`PgStructuredPurgeStore.applyPurge`), chosen for the same reason — a purge
 * must run against the row whose `active` flag it is about to change. The
 * authority it drops is only the read-admission assertion: the reservation,
 * the scope lock and the source locks below all still run, and eligibility is
 * re-read INSIDE those locks by DELETE_FACTS (the same facts MP14's post-grace
 * recheck reads), so a payload protected between the mark and the delete is
 * still refused before any row moves.
 *
 * **One transaction IS the resume story's other half.** The progress row in
 * `structured_collection_deletions` exists for the crash BETWEEN attempts; the
 * transaction covers the crash WITHIN one attempt. A phase's DELETE either
 * commits with its progress row or rolls back with it, so a retry can never
 * re-run a phase whose rows are already gone — each row set is deleted exactly
 * once, and no partial phase is ever reported as committed.
 *
 * **The terminal order is ADR 0099 §2.1's, verbatim.** After the last phase:
 * the mark row is withdrawn (the mark is the retention contract's own row),
 * then `recordPayloadCollection` flips the purge outcome to `collected`, and
 * `payload_collected_at` is stamped on the version row — the removal, the mark
 * withdrawal and the stamp land in one commit, never the stamp first. The
 * version identity row itself SURVIVES as spec :314's minimal non-content
 * record; the stamp is what stops a rescan.
 *
 * **Vector tier is explicitly out of scope** (plan §Vector-side payload):
 * `chunks` carries no `source_version_id`, so version-scoped deletion is not
 * expressible there today; deleting by `source_ref` would take the live
 * version's chunks — the exact hash-only deletion spec :312 forbids.
 */
import {
  planCollectionDelete,
  remainingDeletePhases,
  COLLECTION_DELETE_PHASES,
  type CollectionDeleteOutcome,
  type CollectionDeletePhase,
  type CollectionDeletePlan,
} from "../maintenance/collection-delete.js";
import type { CollectionMark } from "../maintenance/collection-mark-types.js";
import type {
  CollectionPayloadClass,
} from "../maintenance/collector-types.js";
import type { MaintenanceWorkFailureCode } from "../maintenance/types.js";
import { recordPayloadCollection } from "./structured-purge-completion.js";
import { lockScopeRevisions, stampSourceVersionRow } from "./evidence-pg.js";
import {
  advanceRevision,
  lockAffectedSources,
  lockOwnerScope,
  reserveSources,
} from "./structured-scope-locks-pg.js";
import { PgScopeTransactionRunner } from "./structured-scope-uow.js";
import {
  StructuredScopeError,
  structuredScopeError,
  type ScopeTransactionClient,
  type ScopeTransactionOwner,
} from "./structured-scope-types.js";

/** Anything that can lease a connection: `pg.Pool` satisfies this. */
export interface CollectionDeletePool {
  connect(): Promise<ScopeTransactionClient>;
}

/** One deletion, as the caller knows it. */
export interface PgCollectionDeleteRequest {
  /** Trusted context; its owner scope must be the scope the mark belongs to. */
  readonly context: {
    readonly ownerScopeBinding: string;
  };
  /** The scope the mark belongs to; it must be the context's owner scope. */
  readonly scopeBinding: string;
  readonly identity: {
    readonly payloadClass: CollectionPayloadClass;
    readonly payloadRef: string;
  };
  /** The MP16 tombstone revision this deletion collects under. */
  readonly purgeRevision: string;
}

/** One phase's row-count, as the outcome reports it. */
export type PgDeleteRowCounts = Record<CollectionDeletePhase, number>;

/** What one accepted deletion committed, or that it was already collected. */
export interface PgCollectionDeleteResult {
  readonly deleted: boolean;
  readonly sourceVersionId: string;
  readonly sourceRef: string;
  readonly purgeRevision: string;
  /** The phases THIS call ran, in order. A resumed call runs the tail only. */
  readonly phasesRun: readonly CollectionDeletePhase[];
  /** Rows removed per phase, so a resumed step's work is observable. */
  readonly phaseCounts: PgDeleteRowCounts;
  /**
   * The spec:312 live-reference counts on the "original content" columns,
   * excluding this version. REPORTED, never gating (plan §Shared-object key).
   */
  readonly sharedReferences: {
    readonly contentDigestReferences: number;
    readonly originObjectReferences: number;
  };
  readonly deadlineAt: string;
  /** The stamp instant, present exactly when this call took the payload terminal. */
  readonly collectedAt: string | null;
}

/**
 * The one shape every exit in this lane returns — the MP13/MP14 refusal
 * vocabulary on one arm, the committed result on the other. Scope-seam
 * failures (`StructuredScopeError`) throw rather than convert: they are the
 * transaction infrastructure's own voice, and folding them into a refusal
 * value would blur a rollback the caller must not retry blindly.
 */
export type PgCollectionDeleteOutcome =
  | {
      readonly refused: true;
      readonly code: MaintenanceWorkFailureCode;
      readonly detail: string;
    }
  | {
      readonly refused: false;
      readonly outcome: PgCollectionDeleteResult;
    };

export class PgCollectionDeleteStore {
  private readonly scope: ScopeTransactionOwner;

  constructor(
    private readonly pool: CollectionDeletePool,
    scope?: ScopeTransactionOwner
  ) {
    // Direct runner, not the context-minting UOW: the seam's transaction and
    // lock order without the read-admission assertion MP15's normal case
    // violates (see module header).
    this.scope = scope ?? new PgScopeTransactionRunner(() => this.lease());
  }

  /**
   * Delete one marked payload in dependency order, resuming from any progress a
   * previous attempt recorded.
   */
  async deleteCollectionPayload(
    request: PgCollectionDeleteRequest
  ): Promise<PgCollectionDeleteOutcome> {
    return this.transact((client) => this.applyDelete(client, request));
  }

  /**
   * The phases a (version, revision) pair has already committed, read outside
   * any transaction — an operator's resume view, not a decision input.
   */
  async readCommittedPhases(
    sourceVersionId: string,
    purgeRevision: string
  ): Promise<readonly CollectionDeletePhase[]> {
    const lease = await this.lease();
    try {
      const { rows } = await lease.query(
        `SELECT committed_phases FROM structured_collection_deletions
          WHERE source_version_id = $1::uuid AND purge_revision = $2`,
        [sourceVersionId, purgeRevision]
      );
      const raw = rows[0]?.committed_phases;
      return Array.isArray(raw)
        ? raw.filter((phase): phase is CollectionDeletePhase =>
            (COLLECTION_DELETE_PHASES as readonly string[]).includes(
              String(phase)
            )
          )
        : [];
    } finally {
      lease.release();
    }
  }

  private transact<T>(
    body: (client: ScopeTransactionClient) => Promise<T>
  ): Promise<T> {
    return this.scope.runTransaction(body, { fail: structuredScopeError });
  }

  private async lease(): Promise<ScopeTransactionClient> {
    return this.pool.connect();
  }

  private async applyDelete(
    client: ScopeTransactionClient,
    request: PgCollectionDeleteRequest
  ): Promise<PgCollectionDeleteOutcome> {
    const owned = requireOwnedScope(request.context, request.scopeBinding);
    if (owned !== null) return owned;

    // The shared lock order (plan §UoW refusal): source reservations, then the
    // owner scope, then the affected source rows. Reserving first is what makes
    // the scope row's owner stable while this transaction holds it.
    const sourceRef = await requireMarkSourceRef(client, request.identity);
    if (sourceRef.refused) return sourceRef.refusal;
    await reserveSources(client, [sourceRef.sourceRef]);
    await lockOwnerScope(client, request.scopeBinding);
    await lockAffectedSources(client, request.scopeBinding, [
      sourceRef.sourceRef,
    ]);
    // The admission row the read side's fence compares against, after the
    // publication locks and never before — MP16's order exactly.
    const admission = await lockScopeRevisions(client, request.scopeBinding);
    if (admission === null) {
      throw new StructuredScopeError(
        "access_denied",
        `scope "${request.scopeBinding}" has no recorded revisions, so no collection delete can name one`
      );
    }

    // The eligibility re-read, INSIDE the locks: mark, version facts, live
    // grants and revision are one read of the world the decision consumes.
    const facts = await readDeleteFacts(client, request.identity);
    const revision = await observedRevision(client, request.scopeBinding);
    const outcome: CollectionDeleteOutcome = planCollectionDelete(
      {
        identity: request.identity,
        scopeBinding: request.scopeBinding,
        purgeRevision: request.purgeRevision,
      },
      {
        mark: facts.mark,
        lifecycleRevision: revision,
        bindingResolved: facts.bindingResolved,
        payloadCollected: facts.payloadCollected,
        liveRowGrants: facts.liveRowGrants,
        now: await databaseNow(client),
      }
    );
    if (outcome.refused) return outcome;
    const plan: CollectionDeletePlan = outcome.plan;

    // Resume: read the progress row FOR UPDATE so two concurrent attempts of
    // the same (version, revision) serialize here, and the loser re-reads the
    // state the winner committed.
    const progress = await readProgressForUpdate(
      client,
      plan.sourceVersionId,
      plan.purgeRevision
    );
    if (progress?.collected) {
      // ADR 0099 §2.1: collected is monotonic. A retry after completion is
      // refused as stale rather than re-stamped or re-deleted.
      return {
        refused: true,
        code: "input_stale",
        detail: `payload ${request.identity.payloadRef} was already collected for purge revision ${plan.purgeRevision}`,
      };
    }
    const phases = remainingDeletePhases(progress?.committedPhases ?? []);

    const counts: PgDeleteRowCounts = zeroCounts();
    for (const phase of phases) {
      counts[phase] = await deletePhase(client, phase, plan.sourceVersionId);
    }

    // The terminal step, only after every phase ran — in one commit with the
    // removals, in ADR 0099 §2.1's order: mark withdrawn, purge outcome
    // collected, version stamped. Never the stamp first.
    const collectedAt = await this.collectTerminal(
      client,
      request,
      plan.sourceVersionId
    );

    await upsertProgress(client, {
      sourceVersionId: plan.sourceVersionId,
      purgeRevision: plan.purgeRevision,
      committedPhases: [...COLLECTION_DELETE_PHASES],
      collectedAt,
    });

    const sharedReferences = await countSharedVersionReferences(
      client,
      plan.sourceVersionId
    );
    // The deletion is as maintenance-visible as the mark that stopped the
    // obligations: the scope moves once, after every fallible step.
    await advanceRevision(client, request.scopeBinding, {
      read: false,
      maintenance: true,
    });

    return {
      refused: false,
      outcome: {
        deleted: true,
        sourceVersionId: plan.sourceVersionId,
        sourceRef: sourceRef.sourceRef,
        purgeRevision: plan.purgeRevision,
        phasesRun: phases,
        phaseCounts: counts,
        sharedReferences,
        deadlineAt: plan.deadlineAt,
        collectedAt,
      },
    };
  }

  /**
   * ADR 0099 §2.1's terminal sequence, one transaction: mark withdrawn, purge
   * outcome collected, version stamped, the stamp read back so the outcome can
   * name the exact instant. Never the stamp first.
   */
  private async collectTerminal(
    client: ScopeTransactionClient,
    request: PgCollectionDeleteRequest,
    sourceVersionId: string
  ): Promise<string> {
    await client.query(
      `DELETE FROM structured_collection_marks
        WHERE payload_class = $1 AND payload_ref = $2`,
      [request.identity.payloadClass, request.identity.payloadRef]
    );
    const collected = await recordPayloadCollection(client, {
      scopeBinding: request.scopeBinding,
      purgeRevision: request.purgeRevision,
    });
    if (!collected) {
      // The tombstone's completion row is missing or already collected. The
      // first cannot be rolled past (MP16 commits it before MP15 runs); the
      // second is the plan's own already-collected answer arrived at late.
      throw new StructuredScopeError(
        "input_stale",
        `no uncollected purge outcome for scope ${request.scopeBinding} revision ${request.purgeRevision}, so the collection stamp cannot land`
      );
    }
    await stampSourceVersionRow(
      client,
      "payload_collected_at",
      sourceVersionId,
      (await databaseNow(client)).toISOString()
    );
    const collectedAt = await readPayloadCollectedAt(client, sourceVersionId);
    if (collectedAt === null) {
      throw new StructuredScopeError(
        "backend_unavailable",
        `payload stamp for ${sourceVersionId} did not persist`
      );
    }
    return collectedAt;
  }
}

/**
 * The facts read, as ONE statement against the locked rows — the delete-side
 * twin of MP14's post-grace recheck facts. Every arm is keyed on
 * `source_version_id` joined from the mark row, never on a content hash.
 */
interface DeleteFacts {
  readonly mark: CollectionMark | null;
  readonly bindingResolved: boolean;
  readonly payloadCollected: boolean;
  readonly liveRowGrants: readonly string[];
}

interface MarkRowShape {
  readonly payload_class: string;
  readonly payload_ref: string;
  readonly scope_binding: string;
  readonly source_version_id: string | null;
  readonly expected_lifecycle_revision: string;
  readonly deadline_at: Date | string;
  readonly marked_at: Date | string;
  readonly state: string;
}

/** The version-side facts, joined from the mark's `source_version_id`. */
const DELETE_FACTS_SQL = `
WITH marked AS (
  SELECT source_version_id
    FROM structured_collection_marks
   WHERE payload_class = $1 AND payload_ref = $2
),
payload_supports AS (
  SELECT s.support_id
    FROM assertion_supports s
    JOIN source_versions v ON v.source_version_id = s.source_version_id
   WHERE v.source_version_id IN (SELECT source_version_id FROM marked)
)
SELECT
  (SELECT source_version_id FROM marked) AS source_version_id,
  EXISTS (
    SELECT 1 FROM source_versions v
     WHERE v.source_version_id IN (SELECT source_version_id FROM marked)
  ) AS binding_resolved,
  COALESCE((
    SELECT v.payload_collected_at IS NOT NULL
      FROM source_versions v
     WHERE v.source_version_id IN (SELECT source_version_id FROM marked)
  ), false) AS payload_collected,
  COALESCE((
    SELECT jsonb_agg(g.evidence_ref ORDER BY g.evidence_ref)
      FROM evidence_grants g
     WHERE g.grant_kind = 'row'
       AND g.expires_at > clock_timestamp()
       AND (
         EXISTS (
           SELECT 1 FROM evidence_grant_supports gs
            JOIN payload_supports s ON s.support_id = gs.support_id
            WHERE gs.evidence_ref = g.evidence_ref
         )
         OR EXISTS (
           SELECT 1 FROM evidence_grant_extractions ge
            JOIN payload_supports s ON s.support_id = ge.support_id
            WHERE ge.evidence_ref = g.evidence_ref
         )
       )
  ), '[]'::jsonb) AS live_row_grants
`;

async function readDeleteFacts(
  client: ScopeTransactionClient,
  identity: PgCollectionDeleteRequest["identity"]
): Promise<DeleteFacts> {
  const mark = await readMarkRow(client, identity);
  const { rows } = await client.query(DELETE_FACTS_SQL, [
    identity.payloadClass,
    identity.payloadRef,
  ]);
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new StructuredScopeError(
      "backend_unavailable",
      `collection delete facts read returned no row for payload ${identity.payloadRef}`
    );
  }
  return {
    mark,
    bindingResolved: row.binding_resolved === true,
    payloadCollected: row.payload_collected === true,
    liveRowGrants: Array.isArray(row.live_row_grants)
      ? row.live_row_grants.map(String)
      : [],
  };
}

async function readMarkRow(
  client: ScopeTransactionClient,
  identity: PgCollectionDeleteRequest["identity"]
): Promise<CollectionMark | null> {
  const { rows } = await client.query(
    `SELECT payload_class, payload_ref, scope_binding, source_version_id,
            expected_lifecycle_revision, deadline_at, marked_at, state
       FROM structured_collection_marks
      WHERE payload_class = $1 AND payload_ref = $2`,
    [identity.payloadClass, identity.payloadRef]
  );
  const row = rows[0] as MarkRowShape | undefined;
  if (row === undefined) return null;
  return {
    payloadClass: row.payload_class as CollectionMark["payloadClass"],
    payloadRef: row.payload_ref,
    scopeBinding: row.scope_binding,
    sourceVersionId: row.source_version_id,
    expectedLifecycleRevision: String(row.expected_lifecycle_revision),
    deadlineAt: new Date(String(row.deadline_at)).toISOString(),
    markedAt: new Date(String(row.marked_at)).toISOString(),
    state: row.state as CollectionMark["state"],
    cancelledAt: null,
    cancelledReason: null,
  };
}

/**
 * The mark's source ref, read before the lock order runs so `reserveSources`
 * has a source to reserve. A mark that names no source (the two non-source
 * classes) cannot be deleted here: the phase vocabulary below it is the
 * source-version row set, and the plan refuses such a mark on
 * `missing sourceVersionId` before any lock is taken.
 */
async function requireMarkSourceRef(
  client: ScopeTransactionClient,
  identity: PgCollectionDeleteRequest["identity"]
): Promise<
  | { readonly refused: false; readonly sourceRef: string }
  | {
      readonly refused: true;
      readonly refusal: {
        readonly refused: true;
        readonly code: MaintenanceWorkFailureCode;
        readonly detail: string;
      };
    }
> {
  const mark = await readMarkRow(client, identity);
  if (mark === null) {
    return {
      refused: true,
      refusal: {
        refused: true,
        code: "input_stale",
        detail: `no collection mark is recorded for payload ${identity.payloadRef}`,
      },
    };
  }
  if (typeof mark.sourceVersionId !== "string" || mark.sourceVersionId === "") {
    return {
      refused: true,
      refusal: {
        refused: true,
        code: "invalid_input",
        detail: `payload ${identity.payloadRef} carries no source version, so there is no payload to delete`,
      },
    };
  }
  const { rows } = await client.query(
    `SELECT source_ref FROM source_versions WHERE source_version_id = $1::uuid`,
    [mark.sourceVersionId]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    return {
      refused: true,
      refusal: {
        refused: true,
        code: "unsupported_source_binding",
        detail: `mark names source version ${mark.sourceVersionId}, which does not resolve to a row`,
      },
    };
  }
  return { refused: false, sourceRef: String(row.source_ref) };
}

async function observedRevision(
  client: ScopeTransactionClient,
  scopeBinding: string
): Promise<string> {
  const { rows } = await client.query(
    `SELECT maintenance_revision::text AS revision
       FROM structured_publication_scopes
      WHERE scope_binding = $1
      FOR UPDATE`,
    [scopeBinding]
  );
  if (rows.length === 0) {
    throw new StructuredScopeError(
      "unsupported_source_binding",
      `scope ${scopeBinding} is not registered, so no collection delete can name a revision in it`
    );
  }
  return String((rows[0] as Record<string, unknown>).revision);
}

interface ProgressRow {
  readonly committedPhases: CollectionDeletePhase[];
  readonly collected: boolean;
  readonly collectedAt: string | null;
}

async function readProgressForUpdate(
  client: ScopeTransactionClient,
  sourceVersionId: string,
  purgeRevision: string
): Promise<ProgressRow | null> {
  const { rows } = await client.query(
    `SELECT committed_phases, collected_at
       FROM structured_collection_deletions
      WHERE source_version_id = $1::uuid AND purge_revision = $2
      FOR UPDATE`,
    [sourceVersionId, purgeRevision]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    committedPhases: Array.isArray(row.committed_phases)
      ? row.committed_phases.filter(
          (phase): phase is CollectionDeletePhase =>
            (COLLECTION_DELETE_PHASES as readonly string[]).includes(
              String(phase)
            )
        )
      : [],
    collected: row.collected_at != null,
    collectedAt:
      row.collected_at == null
        ? null
        : new Date(String(row.collected_at)).toISOString(),
  };
}

async function upsertProgress(
  client: ScopeTransactionClient,
  row: {
    readonly sourceVersionId: string;
    readonly purgeRevision: string;
    readonly committedPhases: readonly CollectionDeletePhase[];
    readonly collectedAt: string;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO structured_collection_deletions
       (source_version_id, purge_revision, committed_phases, collected_at)
     VALUES ($1::uuid, $2, $3, $4::timestamptz)
     ON CONFLICT (source_version_id, purge_revision) DO UPDATE
        SET committed_phases = EXCLUDED.committed_phases,
            collected_at = EXCLUDED.collected_at`,
    [row.sourceVersionId, row.purgeRevision, row.committedPhases, row.collectedAt]
  );
}

/**
 * One phase's DELETE, in the plan's own order. Each statement is keyed on the
 * version id and returns its row count; the phase vocabulary's FK rationale is
 * why each sits where it does (plan §The phase vocabulary).
 */
async function deletePhase(
  client: ScopeTransactionClient,
  phase: CollectionDeletePhase,
  sourceVersionId: string
): Promise<number> {
  switch (phase) {
    case "dependent_supports": {
      // evidence_grant_extractions + evidence_grant_supports, the two rows that
      // RESTRICT against the payload below them. The grant rows themselves are
      // NOT deleted: a grant outliving its payload's pins is the revocation
      // story's row, and MP16's invalidation already announced it.
      const extractions = await client.query(
        `DELETE FROM evidence_grant_extractions ge
          USING assertion_supports s
         WHERE s.support_id = ge.support_id
           AND s.source_version_id = $1::uuid`,
        [sourceVersionId]
      );
      const supports = await client.query(
        `DELETE FROM evidence_grant_supports gs
          USING assertion_supports s
         WHERE s.support_id = gs.support_id
           AND s.source_version_id = $1::uuid`,
        [sourceVersionId]
      );
      return rowCount(extractions) + rowCount(supports);
    }
    case "extraction_payloads": {
      const result = await client.query(
        `DELETE FROM support_extractions se
          USING assertion_supports s
         WHERE s.support_id = se.support_id
           AND s.source_version_id = $1::uuid`,
        [sourceVersionId]
      );
      return rowCount(result);
    }
    case "assertion_supports": {
      const result = await client.query(
        `DELETE FROM assertion_supports WHERE source_version_id = $1::uuid`,
        [sourceVersionId]
      );
      return rowCount(result);
    }
    case "frozen_units": {
      const result = await client.query(
        `DELETE FROM source_version_locators WHERE source_version_id = $1::uuid`,
        [sourceVersionId]
      );
      return rowCount(result);
    }
    case "superseded_caches": {
      // The binding's (source_ref, source_version) FK to source_versions is NO
      // ACTION, so these rows must be out of the way before the identity stamp.
      // The join resolves the version STRING the FK actually names.
      const result = await client.query(
        `DELETE FROM structured_publication_extraction_bindings b
          USING source_versions v
         WHERE v.source_version_id = $1::uuid
           AND b.source_ref = v.source_ref
           AND b.source_version = v.source_version`,
        [sourceVersionId]
      );
      return rowCount(result);
    }
    default: {
      throw new StructuredScopeError(
        "invalid_input",
        `collection delete: unknown phase ${String(phase)}`
      );
    }
  }
}

/**
 * The two spec:312 live-reference counts, excluding this version itself. Each
 * is the exact query its new index (`source_versions_content_digest_idx`,
 * `source_versions_origin_object_ref_idx`) was added for.
 */
async function countSharedVersionReferences(
  client: ScopeTransactionClient,
  sourceVersionId: string
): Promise<PgCollectionDeleteResult["sharedReferences"]> {
  const { rows } = await client.query(
    `SELECT
       (SELECT count(*) FROM source_versions
         WHERE content_digest = (SELECT content_digest FROM source_versions
                                  WHERE source_version_id = $1::uuid)
           AND source_version_id IS DISTINCT FROM $1::uuid) AS digest_refs,
       (SELECT count(*) FROM source_versions
         WHERE origin_object_ref = (SELECT origin_object_ref FROM source_versions
                                     WHERE source_version_id = $1::uuid)
           AND source_version_id IS DISTINCT FROM $1::uuid) AS origin_refs`,
    [sourceVersionId]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  return {
    contentDigestReferences: Number(row?.digest_refs ?? 0),
    originObjectReferences: Number(row?.origin_refs ?? 0),
  };
}

async function readPayloadCollectedAt(
  client: ScopeTransactionClient,
  sourceVersionId: string
): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT payload_collected_at FROM source_versions
      WHERE source_version_id = $1::uuid`,
    [sourceVersionId]
  );
  const raw = (rows[0] as Record<string, unknown> | undefined)
    ?.payload_collected_at;
  return raw == null ? null : new Date(String(raw)).toISOString();
}

/** The database's own clock, refusing rather than defaulting — MP14's rule. */
async function databaseNow(client: ScopeTransactionClient): Promise<Date> {
  const { rows } = await client.query(`SELECT clock_timestamp()::text AS now`);
  const raw = (rows[0] as Record<string, unknown> | undefined)?.now;
  const instant = new Date(String(raw));
  if (raw === null || raw === undefined || Number.isNaN(instant.getTime())) {
    throw new StructuredScopeError(
      "backend_unavailable",
      "the database returned no usable clock_timestamp, so a delete cannot be dated"
    );
  }
  return instant;
}

/** The client's query return does not type `rowCount`; the field is there. */
function rowCount(result: unknown): number {
  const count = (result as { readonly rowCount?: number | null }).rowCount;
  return count ?? 0;
}

function zeroCounts(): PgDeleteRowCounts {
  return {
    dependent_supports: 0,
    extraction_payloads: 0,
    assertion_supports: 0,
    frozen_units: 0,
    superseded_caches: 0,
  };
}

/** A context is authority over one owner scope; a request may not name another. */
function requireOwnedScope(
  context: PgCollectionDeleteRequest["context"],
  scopeBinding: string
): PgCollectionDeleteOutcome | null {
  if (scopeBinding === context.ownerScopeBinding) return null;
  return {
    refused: true,
    code: "access_denied",
    detail: `the delete scope ${scopeBinding} is not the context's owner scope ${context.ownerScopeBinding}`,
  };
}
