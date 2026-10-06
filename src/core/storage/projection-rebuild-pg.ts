/**
 * MP11 — the derived-projection rebuild, on the shared authorized scope seam.
 *
 * A rebuild is a separate work kind from extraction and a separate surface from
 * publication. That separation is the mechanism behind the inherited spec's
 * "projection rebuild cannot silently run a new extraction model": this module
 * has no statement that writes `structured_publication_sources`, membership,
 * display, extraction bindings, `source_versions`, `assertion_supports` or the
 * identity registry, and no payload to stage. It reads the accepted membership,
 * records one derived generation carrying its COMPLETE dependency vector and the
 * publication revision it was built at, and enqueues projection intents.
 *
 * Every fence is T09's: `lockAndVerifyJob` (ownership, lease, absolute limit,
 * presented-guard match), `assertLiveDependencies` (the complete dependency
 * vector against live publication state) and `canonicalDependencyRevision`. This
 * module writes no second fence mechanism.
 *
 * Missing and stale are different conditions with different typed outcomes:
 *   - a dependency whose accepted state is gone is `maintenance_status_unavailable`
 *     (the spec's "if complete dependencies are missing, that generation is not
 *     eligible to serve"), and
 *   - a dependency that moved after the attempt was scheduled is `input_stale`.
 */
import { emitProjectionIntents } from "./projection-outbox.js";
import type { ProjectionSubject } from "./projection-outbox.js";
import {
  StructuredPublicationError,
  publicationError,
} from "../maintenance/publication-service.js";
import type {
  ProjectionGenerationSnapshot,
  ProjectionRebuildResult,
  ProjectionRebuildStorage,
  RebuildProjectionInput,
} from "../maintenance/publication-types.js";
import { canonicalDependencyRevision } from "../maintenance/durable-work.js";
import type { MaintenanceDependency } from "../maintenance/types.js";
import type { PgStructuredScopeUnitOfWork } from "./structured-scope-uow.js";
import type { ScopeTransactionClient } from "./structured-scope-types.js";
import type { AuthorizedScopeContext } from "./structured-scope-types.js";

/** PostgreSQL derived-projection rebuild, bound to the shared scope unit of work. */
export class PgProjectionRebuildStorage implements ProjectionRebuildStorage {
  constructor(private readonly scope: PgStructuredScopeUnitOfWork) {}

  async rebuildProjections(
    input: RebuildProjectionInput
  ): Promise<ProjectionRebuildResult> {
    try {
      return await this.scope.withAuthorizedScope(
        input.context,
        async (work) => {
          const client = work.client;
          const scopeBinding = input.context.ownerScopeBinding;
          const job = await lockAndVerifyJob(client, input.guard);
          await assertLiveDependencies(
            client,
            scopeBinding,
            job.input_dependencies,
            input.guard
          );
          const dependencies = parseDependencyVector(job.input_dependencies);
          const dependencyRevision = canonicalDependencyRevision(dependencies);
          const subjects = await readAcceptedSubjects(
            client,
            scopeBinding,
            dependencies
          );
          const publicationRevision = await readPublicationRevision(
            client,
            scopeBinding
          );
          const inserted = await client.query(
            `INSERT INTO structured_projection_generations
               (scope_binding, dependency_revision, publication_revision,
                dependencies, subjects)
             VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
             ON CONFLICT (scope_binding, dependency_revision) DO NOTHING
             RETURNING dependency_revision`,
            [
              scopeBinding,
              dependencyRevision,
              publicationRevision,
              JSON.stringify(dependencies),
              JSON.stringify(subjects),
            ]
          );
          // The generation key is the complete dependency revision, so a repeat
          // rebuild of unchanged state finds its own row. Enqueuing again would
          // duplicate intents for subjects the previous rebuild already covers.
          const reusedGeneration = inserted.rows.length === 0;
          const queuedIntents =
            reusedGeneration === true
              ? 0
              : await emitProjectionIntents(client, subjects);
          return {
            subjects,
            dependencyRevision,
            publicationRevision,
            reusedGeneration,
            queuedIntents,
          };
        },
        { additionalSourceRefs: [] }
      );
    } catch (error) {
      throw publicationError(error);
    }
  }

  async readProjectionGeneration(
    context: AuthorizedScopeContext,
    sourceRefs: readonly string[]
  ): Promise<ProjectionGenerationSnapshot> {
    return this.scope.withAuthorizedScope(
      context,
      async (work) => {
        const result = await work.client.query(
          `SELECT dependency_revision, publication_revision, dependencies, subjects
             FROM structured_projection_generations
            WHERE scope_binding = $1
            ORDER BY rebuilt_at DESC, dependency_revision
            LIMIT 1`,
          [context.ownerScopeBinding]
        );
        const row = result.rows[0] as Record<string, any> | undefined;
        if (row === undefined) {
          // EXIT: this scope has never had a derived generation. The read throws
          // `maintenance_status_unavailable` — the missing-required-record
          // refusal — rather than reporting an empty generation, which a caller
          // would misread as "there is nothing to rebuild".
          throw new StructuredPublicationError(
            "maintenance_status_unavailable",
            "no derived generation has been recorded for this scope"
          );
        }
        return {
          subjects: parseJsonArray(row.subjects) as ProjectionSubject[],
          dependencies: parseDependencyVector(row.dependencies),
          dependencyRevision: row.dependency_revision as string,
          publicationRevision: String(row.publication_revision),
        };
      },
      { additionalSourceRefs: sourceRefs }
    );
  }
}

interface JobIdentity {
  readonly input_dependencies: unknown;
}

/**
 * T09's ownership/lease/absolute-limit fence, unchanged: the job row must still
 * be running under the token and attempt number this guard names, the attempt
 * must still be open, and the presented guard must match the row it names.
 */
async function lockAndVerifyJob(
  client: ScopeTransactionClient,
  guard: RebuildProjectionInput["guard"]
): Promise<JobIdentity> {
  const { rows } = await client.query(
    `SELECT job_key, status, fencing_token, attempt_count, input_dependencies
       FROM maintenance_jobs WHERE job_key = $1 FOR UPDATE`,
    [guard.jobKey]
  );
  const row = rows[0] as
    | (JobIdentity & {
        status?: string;
        fencing_token?: string | null;
        attempt_count?: string | number;
      })
    | undefined;
  if (
    row === undefined ||
    row.status !== "running" ||
    row.fencing_token !== guard.fencingToken ||
    Number(row.attempt_count) !== guard.attemptNumber
  ) {
    // EXIT: the ledger row this guard names is missing, no longer running, or
    // carries a different token or attempt number. It throws `lease_lost` so a
    // settled, reclaimed or superseded attempt cannot rebuild.
    throw new StructuredPublicationError(
      "lease_lost",
      "maintenance attempt no longer owns its job"
    );
  }
  const attempt = await client.query(
    `SELECT finished_at FROM maintenance_job_attempts
      WHERE job_key = $1 AND attempt_number = $2 AND fencing_token = $3
      FOR UPDATE`,
    [guard.jobKey, guard.attemptNumber, guard.fencingToken]
  );
  if (attempt.rows.length === 0) {
    // EXIT: the attempt history row is gone. It throws `backend_unavailable`
    // rather than treating a missing history row as an open attempt.
    throw new StructuredPublicationError(
      "backend_unavailable",
      "maintenance attempt history row is missing"
    );
  }
  const finishedAt = (attempt.rows[0] as { finished_at?: Date | string | null })
    .finished_at;
  if (finishedAt !== null && finishedAt !== undefined) {
    // EXIT: the attempt's history row is already settled while its job row
    // still reads running. The rebuild throws `lease_lost`, so a settled attempt
    // cannot rebuild against a job row alone.
    throw new StructuredPublicationError(
      "lease_lost",
      "maintenance attempt has already settled"
    );
  }
  return { input_dependencies: row.input_dependencies };
}

/**
 * T09's dependency-vector fence, unchanged: the scheduled vector must match this
 * guard's input revision, and every dependency must still resolve to the same
 * live source generation and published extraction revision.
 *
 * A dependency whose source row is gone or inactive is the spec's "complete
 * dependencies are missing" case and reports `maintenance_status_unavailable`;
 * a dependency that moved reports `input_stale`.
 */
async function assertLiveDependencies(
  client: ScopeTransactionClient,
  scopeBinding: string,
  scheduledValue: unknown,
  guard: RebuildProjectionInput["guard"]
): Promise<void> {
  const scheduled = parseDependencyVector(scheduledValue);
  if (canonicalDependencyRevision(scheduled) !== guard.inputRevision) {
    // EXIT: the scheduled snapshot does not hash to the revision this guard
    // names. It throws `backend_unavailable` rather than rebuilding against a
    // vector the attempt was not scheduled for.
    throw new StructuredPublicationError(
      "backend_unavailable",
      "maintenance dependency snapshot does not match its input revision"
    );
  }
  for (const dependency of scheduled) {
    if (dependency.relationBuckets.length > 0) {
      // EXIT: a rebuild consumes accepted publication state, which carries no
      // relation bucket. It throws `maintenance_status_unavailable` rather than
      // re-screening, because screening is a different work kind.
      throw new StructuredPublicationError(
        "maintenance_status_unavailable",
        "a projection rebuild consumes accepted publication state, not relation buckets"
      );
    }
    const { rows } = await client.query(
      `SELECT active, generation, published_extraction_revision
         FROM structured_publication_sources
        WHERE scope_binding = $1 AND source_ref = $2
        FOR SHARE`,
      [scopeBinding, dependency.sourceRef]
    );
    const row = rows[0] as
      | {
          active?: boolean;
          generation?: string | number;
          published_extraction_revision?: string | number | null;
        }
      | undefined;
    if (row === undefined || row.active !== true) {
      // EXIT: a dependency's source row is gone or inactive, so its accepted
      // extraction no longer exists and the generation is not eligible to
      // serve. This is the missing case, and it is typed differently from a
      // stale one precisely so a caller can tell them apart.
      throw new StructuredPublicationError(
        "maintenance_status_unavailable",
        "a rebuild dependency has no accepted publication state"
      );
    }
    if (Number(row.generation) !== dependency.generation) {
      throw new StructuredPublicationError(
        "input_stale",
        "a rebuild dependency changed after this attempt was scheduled"
      );
    }
    const liveRevision =
      row.published_extraction_revision === null ||
      row.published_extraction_revision === undefined
        ? null
        : Number(row.published_extraction_revision);
    if (liveRevision !== dependency.extractionRevision) {
      throw new StructuredPublicationError(
        "input_stale",
        "a rebuild dependency's accepted extraction changed after this attempt was scheduled"
      );
    }
    if (liveRevision === null) {
      // EXIT: the dependency is active and its revision matches what the attempt
      // was scheduled against, but nothing was ever PUBLISHED under it, so there
      // is no accepted extraction to rebuild from. The spec requires a typed
      // unavailable verdict here rather than a derived artifact of nothing.
      throw new StructuredPublicationError(
        "maintenance_status_unavailable",
        "a rebuild dependency has no accepted publication to rebuild from"
      );
    }
  }
}

/**
 * The accepted subjects the rebuild derives: exactly the current membership of
 * the dependency set, read inside this rebuild's own unit of work. There is no
 * other source of truth here, which is why no extraction can enter the result.
 */
async function readAcceptedSubjects(
  client: ScopeTransactionClient,
  scopeBinding: string,
  dependencies: readonly MaintenanceDependency[]
): Promise<ProjectionSubject[]> {
  const { rows } = await client.query(
    `SELECT DISTINCT subject, result_id
       FROM structured_publication_membership
      WHERE scope_binding = $1 AND source_ref = ANY($2::text[])
      ORDER BY subject, result_id`,
    [scopeBinding, dependencies.map((entry) => entry.sourceRef)]
  );
  const subjects: ProjectionSubject[] = [];
  const seen = new Set<string>();
  for (const row of rows as Array<{ subject?: string; result_id?: string }>) {
    const kind = row.subject === "entity" ? "entity" : "triple";
    const key = `${kind}:${row.result_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    subjects.push({ kind, id: String(row.result_id) });
  }
  return subjects;
}

async function readPublicationRevision(
  client: ScopeTransactionClient,
  scopeBinding: string
): Promise<string> {
  const { rows } = await client.query(
    `SELECT read_revision FROM structured_publication_scopes
      WHERE scope_binding = $1 FOR SHARE`,
    [scopeBinding]
  );
  const row = rows[0] as { read_revision?: string | number } | undefined;
  if (row?.read_revision === undefined) {
    // EXIT: the scope row is gone inside a rebuild's own unit of work, which the
    // scope lock already excluded. It throws `access_denied` rather than
    // recording a generation against no scope.
    throw new StructuredPublicationError(
      "access_denied",
      "trusted publication scope is not registered"
    );
  }
  return String(row.read_revision);
}

function parseDependencyVector(value: unknown): readonly MaintenanceDependency[] {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!Array.isArray(parsed)) {
    // EXIT: the stored dependency snapshot is not an array. It throws
    // `backend_unavailable` rather than treating it as empty, because an empty
    // vector would make a rebuild appear to have no dependencies at all.
    throw new StructuredPublicationError(
      "backend_unavailable",
      "maintenance dependency snapshot is missing or malformed"
    );
  }
  return parsed.map(parseDependencyEntry);
}

function parseDependencyEntry(value: unknown): MaintenanceDependency {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StructuredPublicationError(
      "backend_unavailable",
      "maintenance dependency snapshot is malformed"
    );
  }
  const item = value as Record<string, unknown>;
  if (typeof item.sourceRef !== "string" || item.sourceRef.trim() === "") {
    throw new StructuredPublicationError(
      "backend_unavailable",
      "maintenance dependency snapshot has no source reference"
    );
  }
  if (!Number.isSafeInteger(item.generation)) {
    throw new StructuredPublicationError(
      "backend_unavailable",
      "maintenance dependency snapshot has no source generation"
    );
  }
  return {
    sourceRef: item.sourceRef,
    generation: item.generation as number,
    extractionRevision: Number.isSafeInteger(item.extractionRevision)
      ? (item.extractionRevision as number)
      : null,
    relationBuckets: Array.isArray(item.relationBuckets)
      ? item.relationBuckets.filter(
          (bucket): bucket is string => typeof bucket === "string"
        )
      : [],
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // EXIT: the stored snapshot is not valid JSON. It throws
    // `backend_unavailable` rather than being read as empty.
    throw new StructuredPublicationError(
      "backend_unavailable",
      "persisted snapshot is invalid JSON"
    );
  }
}

function parseJsonArray(value: unknown): unknown[] {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!Array.isArray(parsed)) {
    // EXIT: a stored array column is not an array. It throws
    // `backend_unavailable` rather than coercing it, so a corrupt generation row
    // cannot be read as an empty one.
    throw new StructuredPublicationError(
      "backend_unavailable",
      "persisted derived-generation column is not a JSON array"
    );
  }
  return parsed;
}