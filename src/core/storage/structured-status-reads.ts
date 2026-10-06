/**
 * The read surface behind `M-STATUS`.
 *
 * Every read here runs on the caller's already-locked client inside the same
 * unit of work that carries the rows, count and summary — never a fresh
 * connection and never a second transaction. The PostgreSQL reader opens one
 * `REPEATABLE READ READ ONLY` transaction for the whole status, which is what
 * makes a concurrent publication invisible to every component rather than to
 * only some of them.
 *
 * The memory reader runs the same assembly inside the shared serialization tail,
 * from the same authorized maintenance view the publication and work adapters
 * read, so the twin cannot answer from a private copy of the state.
 */
import {
  buildMaintenanceStatus,
  type MaintenanceScreeningRecord,
  type MaintenanceStatus,
  type MaintenanceStatusSnapshot,
} from "../maintenance/maintenance-status.js";
import {
  currentScopeRevisions,
  readScopeAuthorization,
  stableSourceRefs,
} from "./structured-scope-locks-pg.js";
import {
  readPgScopedSourceRows,
  readPgScopedWork,
} from "./structured-scope-reads.js";
import type {
  ScopedSourceInput,
  ScopedWorkInput,
} from "./structured-scope-types.js";
import {
  scopeAuthorityOf,
  StructuredScopeError,
  type AuthorizedScopeContext,
  type AuthorizedScopeUnitOfWork,
  type PreparedMemoryScopeWork,
  type ScopeTransactionClient,
  type ScopeTransactionOwner,
} from "./structured-scope-types.js";

/** The scope's own counters, as the status reports them. */
export interface PgMaintenanceRevisions {
  readonly readRevision: number;
  readonly maintenanceRevision: number;
}

/** The components of one status, read in this order on one client. */
export interface PgMaintenanceComponents {
  readonly revisions: PgMaintenanceRevisions;
  readonly sources: readonly ScopedSourceInput[];
  readonly work: readonly ScopedWorkInput[];
  readonly screening: readonly MaintenanceScreeningRecord[];
}

/** The scope's own revision counters, read inside the status transaction. */
export async function readPgStatusRevisions(
  client: ScopeTransactionClient,
  scopeBinding: string
): Promise<{ readonly readRevision: number; readonly maintenanceRevision: number }> {
  const revisions = await currentScopeRevisions(client, scopeBinding);
  if (revisions === null) {
    // EXIT: the trusted scope's counters are not readable on this transaction.
    // The status refuses rather than reporting zero, because a zero revision
    // would make every cursor look valid against an unread counter.
    throw new StructuredScopeError(
      "maintenance_status_unavailable",
      "maintenance status is unavailable: the trusted scope's revisions are not readable"
    );
  }
  return {
    readRevision: revisions.readRevision,
    maintenanceRevision: revisions.maintenanceRevision,
  };
}

/** The source rows of the authorized set. Required rows must be present. */
export async function readPgMaintenanceComponents(
  client: ScopeTransactionClient,
  scopeBinding: string,
  sourceRefs: readonly string[]
): Promise<readonly ScopedSourceInput[]> {
  return readPgScopedSourceRows(client, scopeBinding, sourceRefs);
}

/** The ledger rows behind the authorized set. */
export async function readPgStatusWork(
  client: ScopeTransactionClient,
  sourceRefs: readonly string[]
): Promise<readonly ScopedWorkInput[]> {
  return readPgScopedWork(client, sourceRefs);
}

/**
 * The persisted structural check records of the authorized set, and how much of
 * their evidence an explicit decision has made non-current.
 *
 * The retirement count comes from `structured_screening_conflict_visibility`,
 * which is the table T16's decisions own. Membership rows are private to the
 * publication lane and are not deleted by a retirement, so reading that table is
 * the only way a status can see the effect without reaching into another lane's
 * rows.
 */
export async function readPgScopedScreeningStatus(
  client: ScopeTransactionClient,
  scopeBinding: string,
  sourceRefs: readonly string[]
): Promise<readonly MaintenanceScreeningRecord[]> {
  if (sourceRefs.length === 0) return [];
  const { rows } = await client.query(
    `SELECT k.source_ref, k.ruleset_revision, k.coverage,
            (SELECT count(*)::bigint
               FROM structured_screening_conflict_visibility v
               JOIN structured_screening_candidates vc
                 ON vc.candidate_id = v.candidate_id
                AND vc.scope_binding = v.scope_binding
              WHERE v.scope_binding = k.scope_binding
                AND v.current = false
                AND vc.check_id = k.check_id) AS retired_supports
       FROM structured_screening_checks k
      WHERE k.scope_binding = $1 AND k.source_ref = ANY($2::text[])
      ORDER BY k.source_ref, k.ruleset_revision, k.coverage`,
    [scopeBinding, [...sourceRefs]]
  );
  return rows.map(toScreeningRecord);
}

function toScreeningRecord(row: Record<string, unknown>): MaintenanceScreeningRecord {
  return {
    sourceRef: requireScreeningText(row.source_ref, "source_ref"),
    rulesetRevision: requireScreeningText(row.ruleset_revision, "ruleset_revision"),
    coverage: requireScreeningText(row.coverage, "coverage"),
    retiredSupports: requireScreeningCount(row.retired_supports),
  };
}

function requireScreeningText(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    // EXIT: a persisted check record is missing a text column the status must
    // report. The status refuses rather than reporting a status it cannot read.
    throw new StructuredScopeError(
      "maintenance_status_unavailable",
      `maintenance status is unavailable: persisted check ${field} is missing`
    );
  }
  return value;
}

function requireScreeningCount(value: unknown): number {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    // EXIT: the retirement count a check record carries is not a non-negative
    // integer. The status refuses instead of scoring a check against an
    // unreadable visibility count.
    throw new StructuredScopeError(
      "maintenance_status_unavailable",
      "maintenance status is unavailable: retired support count is outside the safe integer range"
    );
  }
  return count;
}

/** Compose the snapshot the pure builder reads, from already-read components. */
export function composeMaintenanceSnapshot(
  components: PgMaintenanceComponents,
  sourceRefs: readonly string[]
): MaintenanceStatusSnapshot {
  const active = components.sources.filter((source) => source.active);
  const visible = new Set(active.map((source) => source.sourceRef));
  const wanted = new Set(sourceRefs);
  return {
    maintenanceRevision: components.revisions.maintenanceRevision,
    readRevision: components.revisions.readRevision,
    sources: active.filter((source) => wanted.has(source.sourceRef)),
    work: components.work.filter((record) => visible.has(record.sourceRef)),
  };
}

/**
 * The whole status, assembled from one client's reads in one order.
 *
 * The caller must already hold the read transaction this status belongs to; this
 * function opens none of its own, because a status that opened its own
 * transaction would no longer share the rows' snapshot.
 */
export async function buildPgMaintenanceStatus(
  client: ScopeTransactionClient,
  context: AuthorizedScopeContext,
  sourceRefs: readonly string[]
): Promise<MaintenanceStatus> {
  const scopeBinding = context.ownerScopeBinding;
  const revisions = await readPgStatusRevisions(client, scopeBinding);
  const sources = await readPgMaintenanceComponents(
    client,
    scopeBinding,
    sourceRefs
  );
  const work = await readPgStatusWork(client, sourceRefs);
  const screening = await readPgScopedScreeningStatus(
    client,
    scopeBinding,
    sourceRefs
  );
  return buildMaintenanceStatus({
    snapshot: composeMaintenanceSnapshot(
      { revisions, sources, work, screening },
      sourceRefs
    ),
    screening: screening.filter((record) =>
      sourceRefs.includes(record.sourceRef)
    ),
  });
}

/** Narrow a requested set to the trusted authorized subset, refusing anything wider. */
function authorizedSubset(
  context: AuthorizedScopeContext,
  requested: readonly string[]
): readonly string[] {
  if (!Array.isArray(requested)) {
    throw new StructuredScopeError(
      "invalid_input",
      "a maintenance status read requires an explicit source array"
    );
  }
  const allowed = new Set(context.authorizedSourceRefs);
  const widened = requested.filter((ref) => !allowed.has(ref));
  if (widened.length > 0) {
    throw new StructuredScopeError(
      "access_denied",
      `requested sources outside the trusted context: ${widened.join(", ")}`
    );
  }
  return stableSourceRefs(requested);
}

/** The authorization grant a read must still carry to describe this scope. */
async function assertCurrentAuthorization(
  client: ScopeTransactionClient,
  context: AuthorizedScopeContext
): Promise<void> {
  const granted = await readScopeAuthorization(
    client,
    context.ownerScopeBinding
  );
  if (granted === context.authorizationRevision) return;
  throw new StructuredScopeError(
    "access_denied",
    granted === null
      ? "the trusted scope carries no authorization revision"
      : "the trusted scope's authorization changed after this context was minted"
  );
}

/**
 * The authorized same-snapshot status reader.
 *
 * One pool client, one `REPEATABLE READ READ ONLY` transaction, one commit. The
 * repeatable-read snapshot is what makes rows, count and summary agree: a
 * publication that commits between two components of the status is invisible to
 * both, instead of being visible to the count and not to the rows.
 */
export class PgMaintenanceStatusStorage {
  constructor(
    private readonly scope: AuthorizedScopeUnitOfWork & ScopeTransactionOwner
  ) {}

  async readMaintenanceStatus(
    context: AuthorizedScopeContext,
    sourceRefs: readonly string[] = context.authorizedSourceRefs
  ): Promise<MaintenanceStatus> {
    if (scopeAuthorityOf(context) !== this.scope) {
      throw new StructuredScopeError(
        "access_denied",
        "the authorized scope context was not minted by this storage composition"
      );
    }
    const refs = authorizedSubset(context, sourceRefs);
    return this.scope.runTransaction(
      async (client) => {
        await assertCurrentAuthorization(client, context);
        return buildPgMaintenanceStatus(client, context, refs);
      },
      { readOnly: true }
    );
  }
}

/**
 * The memory lane's persisted screening evidence.
 *
 * A lane supplies what its own screening and decision stores actually hold; it
 * is never handed a fixture copy. A lane that holds no such read reports nothing
 * rather than a fabricated record.
 */
export interface MemoryScreeningStatusPort {
  readScreeningStatus(
    scopeBinding: string,
    sourceRefs: readonly string[]
  ): readonly MaintenanceScreeningRecord[];
}

const NO_SCREENING_EVIDENCE: MemoryScreeningStatusPort = {
  readScreeningStatus: () => [],
};

export interface MemoryMaintenanceStatusAuthority {
  withAuthorizedScope<R>(
    context: AuthorizedScopeContext,
    callback: (work: PreparedMemoryScopeWork) => Promise<R>,
    options?: { readonly additionalSourceRefs?: readonly string[] }
  ): Promise<R>;
}

/**
 * The memory twin of the status reader.
 *
 * It reads through the shared maintenance view inside the same authorized unit
 * of work the publication and work adapters use, so a status cannot be assembled
 * from a private copy of the state or from a second, separately transacted read.
 */
export class MemoryMaintenanceStatusStorage {
  private readonly screening: MemoryScreeningStatusPort;

  constructor(
    private readonly scope: MemoryMaintenanceStatusAuthority,
    screening: MemoryScreeningStatusPort = NO_SCREENING_EVIDENCE
  ) {
    this.screening = screening;
  }

  async readMaintenanceStatus(
    context: AuthorizedScopeContext,
    sourceRefs: readonly string[] = context.authorizedSourceRefs
  ): Promise<MaintenanceStatus> {
    return this.scope.withAuthorizedScope(
      context,
      async (work) => {
        // The shared view owns the authorized-subset refusal, so this reader
        // does not carry a second copy of that rule. The maintenance view does
        // not carry a read revision, so the accepted view supplies that counter;
        // the two must agree on the active source set or the status refuses,
        // because a status whose two halves saw different sources is exactly the
        // mixed snapshot this contract forbids.
        const [maintenance, accepted] = await Promise.all([
          work.readMaintenanceInputs(sourceRefs),
          work.readAcceptedInputs(sourceRefs),
        ]);
        assertSameActiveScope(maintenance, accepted);
        return buildMaintenanceStatus({
          snapshot: {
            maintenanceRevision: maintenance.maintenanceRevision,
            readRevision: accepted.readRevision,
            sources: maintenance.sources,
            work: maintenance.work,
          },
          screening: this.screening.readScreeningStatus(
            maintenance.ownerScopeBinding,
            maintenance.sources.map((source) => source.sourceRef)
          ),
        });
      },
      { additionalSourceRefs: [] }
    );
  }
}

/** Both views of one unit of work must describe the same active source set. */
function assertSameActiveScope(
  maintenance: { readonly sources: readonly { readonly sourceRef: string }[] },
  accepted: { readonly sources: readonly { readonly sourceRef: string }[] }
): void {
  const fromMaintenance = maintenance.sources
    .map((source) => source.sourceRef)
    .sort()
    .join(",");
  const fromAccepted = accepted.sources
    .map((source) => source.sourceRef)
    .sort()
    .join(",");
  if (fromMaintenance === fromAccepted) return;
  // EXIT: the two authorized views of one unit of work disagree about which
  // sources are active. The status refuses rather than reporting a total from
  // one set beside rows read from another.
  throw new StructuredScopeError(
    "maintenance_status_unavailable",
    "maintenance status is unavailable: the authorized views disagree about the active source set"
  );
}