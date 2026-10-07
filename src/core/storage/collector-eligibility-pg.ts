/**
 * Postgres collector eligibility read (fin specs/structured-corpus-maintenance.md
 * §Physical collection, lines 276-305).
 *
 * One statement returns every fact the decision needs. That is the point of the
 * shape: a decision made from two reads can be made from facts that were never
 * simultaneously true — a reference created between them would be invisible to the
 * first read and the payload would look free. MP14's post-grace recheck re-reads
 * this same statement under a lock, so the pre-mark scan and the post-grace recheck
 * cannot differ in what they look at.
 *
 * The statement does NOT filter leases or grants by expiry. The comparison at the
 * boundary lives in `collector-eligibility.ts`, so the SQL twin and the in-memory
 * twin cannot disagree about whether the instant a lease expires is inside it.
 *
 * A failed read raises; it never returns an empty fact set. "Found nothing" and
 * "could not look" are different, and only the second one may stop a collection.
 */
import { MaintenanceStoreError } from "../maintenance/store-error.js";
import type {
  CollectionCandidate,
  CollectionCountGrant,
  CollectionCurrentDependency,
  CollectionDependencyKind,
  CollectionEligibilityReader,
  CollectionLease,
  CollectionLeaseKind,
  CollectionReadFacts,
  CollectionRowReference,
} from "../maintenance/collector-types.js";
import { COLLECTION_DEPENDENCY_KINDS, COLLECTION_LEASE_KINDS } from "../maintenance/collector-types.js";
import { EVIDENCE_GRANT_KIND } from "../types.js";

/** A leased connection. Satisfied by `pg.PoolClient` and by the test fakes. */
export interface CollectionEligibilityPool {
  connect(): Promise<{
    query(
      text: string,
      values?: unknown[]
    ): Promise<{ rows: Record<string, unknown>[] }>;
    release(): void;
  }>;
}

/**
 * The single read.
 *
 * `$1` is the payload ref — the source ref for a source payload, the owning
 * object's ref otherwise — and `$2` is the source version for the four
 * source-bound classes and NULL for the other two, which is why every
 * source-version-scoped branch narrows on `target` rather than on `$2` directly.
 */
const FACTS_SQL = `
WITH target AS (
  SELECT source_version_id, payload_collected_at
    FROM source_versions
   WHERE source_ref = $1 AND source_version = $2
),
payload_supports AS (
  SELECT s.support_id
    FROM assertion_supports s
    JOIN target t ON t.source_version_id = s.source_version_id
)
SELECT
  EXISTS (SELECT 1 FROM target) AS binding_resolved,
  COALESCE(
    (SELECT t.payload_collected_at IS NOT NULL FROM target t),
    false) AS payload_collected,
  COALESCE((
    SELECT jsonb_agg(
             jsonb_build_object('kind', dep.kind, 'holder', dep.holder)
             ORDER BY dep.kind, dep.holder)
      FROM (
        SELECT 'current_source_version' AS kind, sv.source_version AS holder
          FROM source_versions sv
         WHERE sv.source_ref = $1
           AND sv.retired_at IS NULL
           AND sv.source_version_id IS DISTINCT FROM
               (SELECT t.source_version_id FROM target t)
        UNION ALL
        SELECT 'published_or_desired_scope', p.scope_binding
          FROM structured_publication_sources p
         WHERE p.source_ref = $1
           AND (p.published_source_version = $2 OR p.desired_source_version = $2)
        UNION ALL
        SELECT 'staged_publication', ps.scope_binding
          FROM structured_publication_stages ps
         WHERE ps.source_ref = $1
        UNION ALL
        SELECT 'live_maintenance_job', j.job_key
          FROM maintenance_jobs j
         WHERE j.source_ref = $1
           AND j.status IN ('pending', 'running')
      ) dep
  ), '[]'::jsonb) AS current_dependencies,
  COALESCE((
    SELECT jsonb_agg(
             jsonb_build_object(
               'kind', 'job',
               'holder', j.job_key,
               'expiresAt', j.lease_expires_at)
             ORDER BY j.lease_expires_at)
      FROM maintenance_jobs j
     WHERE j.source_ref = $1
       AND j.status = 'running'
       AND j.lease_expires_at IS NOT NULL
  ), '[]'::jsonb) AS valid_leases,
  COALESCE((
    SELECT jsonb_agg(
             jsonb_build_object(
               'evidenceRef', g.evidence_ref,
               'expiresAt', g.expires_at)
             ORDER BY g.expires_at)
      FROM evidence_grants g
     WHERE g.grant_kind = '${EVIDENCE_GRANT_KIND.ROW}'
       AND (
         EXISTS (
           SELECT 1
             FROM evidence_grant_supports gs
             JOIN payload_supports s ON s.support_id = gs.support_id
            WHERE gs.evidence_ref = g.evidence_ref
         )
         OR EXISTS (
           SELECT 1
             FROM evidence_grant_extractions ge
             JOIN payload_supports s ON s.support_id = ge.support_id
            WHERE ge.evidence_ref = g.evidence_ref
         )
       )
  ), '[]'::jsonb) AS row_references,
  COALESCE((
    SELECT jsonb_agg(
             jsonb_build_object(
               'evidenceRef', g.evidence_ref,
               'receiptId', g.authorization_receipt_id,
               'expiresAt', g.expires_at)
             ORDER BY g.expires_at)
      FROM evidence_grants g
     WHERE g.grant_kind = '${EVIDENCE_GRANT_KIND.COUNT}'
       AND (
         EXISTS (
           SELECT 1
             FROM evidence_grant_supports gs
             JOIN payload_supports s ON s.support_id = gs.support_id
            WHERE gs.evidence_ref = g.evidence_ref
         )
         OR EXISTS (
           SELECT 1
             FROM evidence_grant_extractions ge
             JOIN payload_supports s ON s.support_id = ge.support_id
            WHERE ge.evidence_ref = g.evidence_ref
         )
       )
  ), '[]'::jsonb) AS count_only_grants`;

export class PgCollectionEligibilityReader implements CollectionEligibilityReader {
  constructor(private readonly pool: CollectionEligibilityPool) {}

  /**
   * Reader leases have no row to join: one lives with the read it protects, and
   * that read is in flight outside the database. The host passes the ones it holds
   * so the lease check and the decision share one instant.
   */
  async readCollectionFacts(
    candidate: CollectionCandidate,
    _now: Date,
    activeReaders: readonly CollectionLease[] = []
  ): Promise<CollectionReadFacts> {
    const lease = await this.pool.connect();
    try {
      const result = await lease.query(FACTS_SQL, [
        candidate.payloadRef,
        candidate.source?.sourceVersion ?? null,
      ]);
      return factsOf(result.rows[0] ?? {}, activeReaders);
    } catch (error) {
      throw storeError(error);
    } finally {
      lease.release();
    }
  }
}

function storeError(error: unknown): MaintenanceStoreError {
  if (error instanceof MaintenanceStoreError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new MaintenanceStoreError(
    `collector eligibility read failed: ${message}`,
    "backend_unavailable"
  );
}

/**
 * Map the row onto the fact vocabulary.
 *
 * An unreadable column is not silently dropped: a dependency or lease whose
 * identifying value cannot be read becomes an entry the decision still counts,
 * and a malformed expiry is left for the decision to treat as never expiring. The
 * alternative — dropping what cannot be parsed — is exactly how a protected
 * payload ends up looking free.
 */
function factsOf(
  row: Record<string, unknown>,
  activeReaders: readonly CollectionLease[]
): CollectionReadFacts {
  return {
    bindingResolved: row.binding_resolved === true,
    payloadCollected: row.payload_collected === true,
    currentDependencies: dependenciesOf(row.current_dependencies),
    validLeases: [
      ...leasesOf(row.valid_leases, "job"),
      ...activeReaders.map((reader) => ({ ...reader, kind: readerKind(reader) })),
    ],
    rowReferences: rowsOf<CollectionRowReference>(row.row_references),
    countOnlyGrants: rowsOf<CollectionCountGrant>(row.count_only_grants),
  };
}

/**
 * A dependency kind the vocabulary does not name is a drift between this SQL and
 * `collector-types.ts`, and it is reported as a storage fault rather than coerced
 * into one of the four known kinds: every kind blocks, so coercing would hide the
 * drift behind a reason that names the wrong clause.
 */
function dependenciesOf(value: unknown): readonly CollectionCurrentDependency[] {
  const kinds: readonly string[] = COLLECTION_DEPENDENCY_KINDS;
  return rowsOf<{ readonly kind?: unknown; readonly holder?: unknown }>(value).map(
    (dep) => {
      const kind = typeof dep.kind === "string" ? dep.kind : "";
      if (!kinds.includes(kind)) throw unknownVocabulary("dependency kind", kind);
      return {
        kind: kind as CollectionDependencyKind,
        holder: typeof dep.holder === "string" && dep.holder.length > 0
          ? dep.holder
          : "unknown",
      };
    }
  );
}

function leasesOf(
  value: unknown,
  kind: CollectionLeaseKind
): readonly CollectionLease[] {
  return rowsOf<{ readonly holder?: unknown; readonly expiresAt?: unknown }>(value)
    .filter((lease) => typeof lease.expiresAt === "string")
    .map((lease) => ({
      kind,
      holder: typeof lease.holder === "string" && lease.holder.length > 0
        ? lease.holder
        : "unknown",
      expiresAt: lease.expiresAt as string,
    }));
}

function readerKind(reader: CollectionLease): CollectionLeaseKind {
  const kinds: readonly string[] = COLLECTION_LEASE_KINDS;
  if (!kinds.includes(reader.kind)) {
    throw unknownVocabulary("lease kind", reader.kind);
  }
  return reader.kind;
}

function unknownVocabulary(what: string, value: string): MaintenanceStoreError {
  return new MaintenanceStoreError(
    `collector eligibility read returned an unknown ${what} "${value}"`,
    "backend_unavailable"
  );
}

function rowsOf<T>(value: unknown): readonly T[] {
  const parsed = typeof value === "string" ? safeParse(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed as readonly T[];
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return [];
  }
}

