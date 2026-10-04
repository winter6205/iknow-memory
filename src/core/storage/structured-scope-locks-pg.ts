/**
 * The one reservation and lock policy every structured-corpus writer follows.
 *
 * Why these are functions over a leased client rather than methods on each
 * adapter: the deadlock this repairs came from two writers taking the same two
 * resources in opposite orders — publication locked the job before the scope,
 * while the scope-first path needs the reverse. Reservations, owner-scope locks,
 * affected-source locks, and the revision hook live here so there is one order
 * to follow instead of one per adapter.
 *
 * That order is, in every path: source-ownership reservations in stable
 * source-reference order, then the owner scope, then the affected source rows in
 * stable order, then work/attempt and membership rows. Nothing here takes an
 * earlier-order lock after a later-order one.
 */
import { advisoryLockKey } from "./schema-lock.js";
import { recordSuppressedFailure } from "../errors.js";
import { StructuredScopeError } from "./structured-scope-types.js";
import type {
  ScopeRevisionChange,
  ScopeRevisionState,
  ScopeTransactionClient,
  ScopedSourceInput,
  SourceOwnership,
} from "./structured-scope-types.js";
import { scopedSafeNumber, toScopedSourceRow } from "./structured-scope-reads.js";

/** Scope revisions read under, or without, a scope lock. */
export type ScopeRevisions = ScopeRevisionState;

/** The canonical order every locking path uses. */
export function stableSourceRefs(
  sourceRefs: readonly string[]
): readonly string[] {
  return [...sourceRefs].sort((left, right) => left.localeCompare(right));
}

/**
 * One advisory lock per source reference, shared by every writer that assigns or
 * mutates ownership. One derivation is the point: two names for the same source
 * would simply stop contending and let two owner scopes win at once.
 */
export function reservationLockParameter(sourceRef: string): string {
  return advisoryLockKey(
    `structured-publication-source:${sourceRef}`
  ).toString();
}

/** Lock-free ownership resolution: which scope, if any, owns each source. */
export async function resolveOwnership(
  client: ScopeTransactionClient,
  sourceRefs: readonly string[]
): Promise<readonly SourceOwnership[]> {
  if (sourceRefs.length === 0) return [];
  const { rows } = await client.query(
    `SELECT r.source_ref, s.scope_binding
       FROM unnest($1::text[]) AS r(source_ref)
       LEFT JOIN structured_publication_sources s
         ON s.source_ref = r.source_ref
      ORDER BY r.source_ref`,
    [[...sourceRefs]]
  );
  return rows.map((row) => ({
    sourceRef: String(row.source_ref ?? ""),
    ownerScopeBinding:
      row.scope_binding === null || row.scope_binding === undefined
        ? null
        : String(row.scope_binding),
  }));
}

/**
 * Take the reservations in stable order.
 *
 * `nonblocking` is what a global claim needs: a claim must not queue behind a
 * write it cannot predict, so it gives up the candidate instead of waiting. A
 * false return here means "restart this attempt", never "hold a partial set".
 */
export async function reserveSources(
  client: ScopeTransactionClient,
  sourceRefs: readonly string[],
  nonblocking = false
): Promise<boolean> {
  for (const sourceRef of stableSourceRefs(sourceRefs)) {
    const sql = nonblocking
      ? "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired"
      : "SELECT pg_advisory_xact_lock($1::bigint) AS acquired";
    const { rows } = await client.query(sql, [reservationLockParameter(sourceRef)]);
    if (!nonblocking || rows.length === 0) continue;
    if ((rows[0] as { acquired?: boolean }).acquired === false) return false;
  }
  return true;
}

/**
 * Lock the owner scope row.
 *
 * Registration is part of declaration, so only a declaring run may ask for the
 * row to be created; every other run refuses an unregistered scope rather than
 * minting ownership implicitly.
 */
export async function lockOwnerScope(
  client: ScopeTransactionClient,
  scopeBinding: string,
  register = false
): Promise<ScopeRevisions> {
  if (register) {
    await client.query(
      "INSERT INTO structured_publication_scopes (scope_binding) VALUES ($1) ON CONFLICT DO NOTHING",
      [scopeBinding]
    );
  }
  return readLockedScopeRevisions(client, scopeBinding);
}

async function readLockedScopeRevisions(
  client: ScopeTransactionClient,
  scopeBinding: string
): Promise<ScopeRevisions> {
  const { rows } = await client.query(
    `SELECT read_revision, maintenance_revision
       FROM structured_publication_scopes WHERE scope_binding = $1 FOR UPDATE`,
    [scopeBinding]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new StructuredScopeError(
      "access_denied",
      "trusted publication scope is not registered"
    );
  }
  return toScopeRevisions(row);
}

/** Read the scope revisions without any lock, for discovery and view binding. */
export async function currentScopeRevisions(
  client: ScopeTransactionClient,
  scopeBinding: string
): Promise<ScopeRevisions | null> {
  const { rows } = await client.query(
    `SELECT read_revision, maintenance_revision
       FROM structured_publication_scopes WHERE scope_binding = $1`,
    [scopeBinding]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  return row === undefined ? null : toScopeRevisions(row);
}

function toScopeRevisions(row: Record<string, unknown>): ScopeRevisions {
  return {
    readRevision: scopedSafeNumber(row.read_revision, "scope read revision"),
    maintenanceRevision: scopedSafeNumber(
      row.maintenance_revision,
      "scope maintenance revision"
    ),
  };
}

/**
 * The scope's current authorization revision as the evidence authority records
 * it. Read inside the transaction, before any owner or source lock, so a grant
 * that moved while this run was being scheduled refuses rather than serving a
 * corpus the tenant no longer authorizes.
 */
export async function readScopeAuthorization(
  client: ScopeTransactionClient,
  scopeBinding: string
): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT authorization_revision
       FROM evidence_scope_revisions WHERE scope_binding = $1`,
    [scopeBinding]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const revision = row.authorization_revision;
  if (typeof revision !== "string" || revision.trim() === "") {
    throw new StructuredScopeError(
      "maintenance_status_unavailable",
      "the scope's authorization revision is unreadable"
    );
  }
  return revision;
}

/** Lock the affected source rows one at a time, in the same stable order. */
export async function lockAffectedSources(
  client: ScopeTransactionClient,
  scopeBinding: string,
  sourceRefs: readonly string[]
): Promise<readonly ScopedSourceInput[]> {
  const locked: ScopedSourceInput[] = [];
  for (const sourceRef of stableSourceRefs(sourceRefs)) {
    const { rows } = await client.query(
      `SELECT source_ref, active, generation, desired_source_version,
              desired_extraction_revision, desired_config_revision,
              published_source_version, published_extraction_revision,
              published_generation
         FROM structured_publication_sources
        WHERE scope_binding = $1 AND source_ref = $2 FOR UPDATE`,
      [scopeBinding, sourceRef]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) {
      throw new StructuredScopeError(
        "access_denied",
        `source ${sourceRef} is not authorized in this trusted scope`
      );
    }
    locked.push(toScopedSourceRow(row));
  }
  return locked;
}

/**
 * Advance the scope revisions in the client that already holds its lock.
 *
 * The seam defers every bump to just before COMMIT and applies it on the very
 * client that already holds the scope, so a seam write moves the counters
 * exactly once and in the unified order. A hook running here cannot invert
 * job-then-scope because its caller already owns the scope.
 */
export async function advanceRevision(
  client: ScopeTransactionClient,
  scopeBinding: string,
  change: ScopeRevisionChange
): Promise<void> {
  if (!change.read && !change.maintenance) return;
  const { rows } = await client.query(
    `UPDATE structured_publication_scopes
        SET read_revision = read_revision + CASE WHEN $2::boolean THEN 1 ELSE 0 END,
            maintenance_revision = maintenance_revision +
              CASE WHEN $3::boolean THEN 1 ELSE 0 END
      WHERE scope_binding = $1
      RETURNING scope_binding`,
    [scopeBinding, change.read, change.maintenance]
  );
  if (rows.length !== 1) {
    throw new StructuredScopeError(
      "maintenance_status_unavailable",
      "publication scope revision was not advanced"
    );
  }
}

/** Roll the transaction back once, keeping the primary failure and safe metadata. */
export async function rollbackRetaining(
  client: ScopeTransactionClient,
  primary: unknown,
  started: boolean
): Promise<void> {
  if (!started) return;
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    recordSuppressedFailure(primary, rollbackError);
  }
}
