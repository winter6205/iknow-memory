import { randomUUID } from "node:crypto";

import {
  StructuredPublicationError,
  normalizePublicationFacts,
  publicationError,
  publicationPayloadDigest,
  requirePublicationInstant,
  requirePublicationRevision,
  requirePublicationString,
  validatePublicationDeclaration,
} from "../maintenance/publication-service.js";
import type {
  DeclarePublicationDesiredInput,
  PublicationDisplayValue,
  PublicationMaintenanceSummary,
  PublicationSnapshot,
  PublicationSourceSnapshot,
  PublicationSubjectSnapshot,
  PublishStructuredInput,
  StagePublicationAttemptInput,
  StructuredPublicationStorage,
  WithdrawStructuredSourceInput,
} from "../maintenance/publication-types.js";
import {
  type MaintenanceAttemptGuard,
  type MaintenanceWorkStatus,
} from "../maintenance/types.js";
import {
  canonicalDependencyRevision,
  verifyAttemptOwnership,
} from "../maintenance/durable-work.js";
import {
  WORK_ABSOLUTE_LIMIT_MS,
  type MaintenanceDependency,
} from "../maintenance/types.js";
import { PgStructuredIdentityStore } from "../structured/identity-store.js";
import type { RelationAssertionInput } from "../structured/identity.js";
import type { EntityIdentityInput } from "../structured/identity-store.js";
import type { ProjectionSubject } from "./projection-outbox.js";
import { emitProjectionIntents } from "./projection-outbox.js";
import {
  bindSourceLocatorRow,
  recordSupportRow,
  registerSourceVersionRow,
} from "./evidence-pg.js";
import type { EvidenceClient } from "./evidence-store.js";
import {
  normalizeLocatorBinding,
  normalizeOccurrence,
  normalizeSourceVersion,
} from "./evidence-source.js";
import type { NewSourceVersion, SupportRecord } from "../types.js";
import type { PgStructuredScopeUnitOfWork } from "./structured-scope-uow.js";
import { reservationLockParameter } from "./structured-scope-locks-pg.js";
import type { ScopeTransactionClient } from "./structured-scope-types.js";

/**
 * The leased client a structured write runs on. `release` is the pool's, but the
 * shared seam owns when it is called, so publication no longer leases its own
 * connection or decides its own rollback.
 */
interface PublicationClient extends EvidenceClient {
  release(): void;
}

/**
 * A seam client and a publication client are the same pooled connection seen
 * through two query surfaces, so one unit of work never holds two connections
 * while waiting on a lock another of its own transactions owns.
 */
function asPublicationClient(client: ScopeTransactionClient): PublicationClient {
  return client as PublicationClient;
}

/**
 * The maintenance job row as PostgreSQL returns it. Publication reads the whole
 * row to re-verify a running attempt against the database clock, so the columns
 * it converts by hand stay loosely typed here.
 */
interface JobRow extends Record<string, any> {
  job_key: string;
  work_kind: string;
  source_ref: string;
  source_version: string;
  source_generation: string | number;
  input_revision: string;
  config_revision: string;
  status: MaintenanceWorkStatus;
  attempt_count: number;
  fencing_token: string | null;
  lease_expires_at: Date | string | null;
  attempt_started_at: Date | string | null;
  attempt_finished_at?: Date | string | null;
}

interface PublicationSourceRow {
  scope_binding: string;
  source_ref: string;
  active: boolean;
  generation: string | number;
  desired_source_version: string | null;
  desired_extraction_revision: string | number | null;
  desired_config_revision: string | null;
  published_source_version: string | null;
  published_extraction_revision: string | number | null;
  published_generation: string | number | null;
}

/** PostgreSQL implementation using the shared authorized scope unit of work. */
export class PgStructuredPublicationStorage implements StructuredPublicationStorage {
  constructor(private readonly scope: PgStructuredScopeUnitOfWork) {}

  async declareDesired(
    input: DeclarePublicationDesiredInput
  ): Promise<{ readonly generation: number }> {
    try {
      const request = validatePublicationDeclaration(input);
      return await this.transaction((client) =>
        declareDesiredTransaction(client, request)
      );
    } catch (error) {
      throw publicationError(error);
    }
  }

  async stageAttempt(
    input: StagePublicationAttemptInput
  ): Promise<{ readonly staged: true }> {
    try {
      const request = validateStage(input);
      await this.transaction(async (client) => {
        const { source } = await this.lockDesiredSourceAndGuard(
          client,
          request.scopeBinding,
          request.sourceRef,
          request.guard
        );
        const facts = normalizePublicationFacts(
          request.accepted,
          request.sourceRef,
          source.desired_source_version!,
          request.extractionRef
        );
        await assertFactLocatorsBound(client, facts);
        await lockAndVerifyJob(client, request.guard);
        await client.query(
          `INSERT INTO structured_publication_stages
             (scope_binding, source_ref, generation, job_key, attempt_number,
              fencing_token, extraction_ref, accepted_facts, staged_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,now())
           ON CONFLICT (scope_binding, source_ref) DO UPDATE SET
             generation = EXCLUDED.generation,
             job_key = EXCLUDED.job_key,
             attempt_number = EXCLUDED.attempt_number,
             fencing_token = EXCLUDED.fencing_token,
             extraction_ref = EXCLUDED.extraction_ref,
             accepted_facts = EXCLUDED.accepted_facts,
             staged_at = EXCLUDED.staged_at`,
          [
            request.scopeBinding,
            request.sourceRef,
            safeNumber(source.generation, "source generation"),
            request.guard.jobKey,
            request.guard.attemptNumber,
            request.guard.fencingToken,
            request.extractionRef,
            JSON.stringify(request.accepted),
          ]
        );
        const progressUpdate = await client.query(
          `UPDATE structured_publication_scopes
              SET maintenance_revision = maintenance_revision + 1
            WHERE scope_binding = $1
              AND EXISTS (
                SELECT 1 FROM maintenance_jobs j
                 WHERE j.job_key = $2 AND j.status = 'running'
                   AND j.fencing_token = $3 AND j.attempt_count = $4
                   AND j.lease_expires_at > clock_timestamp()
                   AND j.attempt_started_at + ($5::double precision * interval '1 millisecond') > clock_timestamp()
              )
            RETURNING scope_binding`,
          [
            request.scopeBinding,
            request.guard.jobKey,
            request.guard.fencingToken,
            request.guard.attemptNumber,
            WORK_ABSOLUTE_LIMIT_MS,
          ]
        );
        if (progressUpdate.rows.length !== 1) {
          await lockAndVerifyJob(client, request.guard);
          throw new StructuredPublicationError(
            "maintenance_status_unavailable",
            "publication progress scope is missing"
          );
        }
      });
      return { staged: true };
    } catch (error) {
      throw publicationError(error);
    }
  }

  async publish(
    input: PublishStructuredInput
  ): Promise<{ readonly published: true }> {
    try {
      const request = validatePublish(input);
      await this.transaction(async (client) => {
        const { source } = await this.lockDesiredSourceAndGuard(
          client,
          request.scopeBinding,
          request.sourceRef,
          request.guard
        );
        const stagedResult = await client.query(
          `SELECT generation, job_key, attempt_number, fencing_token, extraction_ref, accepted_facts
             FROM structured_publication_stages
            WHERE scope_binding = $1 AND source_ref = $2
            FOR UPDATE`,
          [request.scopeBinding, request.sourceRef]
        );
        const staged = stagedResult.rows[0] as Record<string, any> | undefined;
        if (!staged || !stageMatchesGuard(staged, request.guard, source)) {
          throw new StructuredPublicationError(
            "input_stale",
            "no staged payload belongs to this current attempt"
          );
        }
        const facts = normalizePublicationFacts(
          parseFacts(staged.accepted_facts),
          request.sourceRef,
          source.desired_source_version!,
          String(staged.extraction_ref)
        );
        const payloadDigest = publicationPayloadDigest(facts);
        const oldSubjects = await readSourceProjectionSubjects(
          client,
          request.scopeBinding,
          [request.sourceRef]
        );
        await assertFactLocatorsBound(client, facts);
        await registerFactIdentities(client, facts, request.guard);
        const supports = await persistFactEvidence(
          client,
          facts,
          request.guard
        );
        await assertOrRecordExtractionBinding(
          client,
          request.scopeBinding,
          source,
          String(staged.extraction_ref),
          payloadDigest,
          facts,
          supports,
          request.guard
        );
        await replaceSourceMembership(
          client,
          request.scopeBinding,
          request.sourceRef,
          source,
          facts,
          supports,
          request.guard
        );
        await lockAndVerifyJob(client, request.guard);
        await client.query(
          "DELETE FROM structured_publication_stages WHERE scope_binding = $1 AND source_ref = $2",
          [request.scopeBinding, request.sourceRef]
        );
        const newSubjects = facts.map((fact) =>
          projectionSubject(fact.subject, fact.resultId)
        );
        await emitPublicationProjectionIntents(
          client,
          uniqueSubjects([...oldSubjects, ...newSubjects]),
          request.guard
        );
        await finishPublicationAttempt(
          client,
          request.scopeBinding,
          request.guard,
          request.at
        );
      });
      return { published: true };
    } catch (error) {
      throw publicationError(error);
    }
  }

  async withdraw(
    input: WithdrawStructuredSourceInput
  ): Promise<{ readonly generation: number }> {
    try {
      const request = validateWithdrawal(input);
      return await this.transaction(async (client) => {
        const scope = await lockScope(client, request.scopeBinding);
        const source = await lockSource(
          client,
          request.scopeBinding,
          request.sourceRef
        );
        if (!source.active) {
          throw new StructuredPublicationError(
            "input_stale",
            "source has already been withdrawn"
          );
        }
        if (
          safeNumber(source.generation, "source generation") !==
          request.expectedGeneration
        ) {
          throw new StructuredPublicationError(
            "input_stale",
            "source generation changed before withdrawal"
          );
        }
        const subjects = await readSourceProjectionSubjects(
          client,
          request.scopeBinding,
          [request.sourceRef]
        );
        await emitProjectionIntents(client, subjects);
        await clearSourcePublication(
          client,
          request.scopeBinding,
          request.sourceRef
        );
        const update = await client.query(
          `UPDATE structured_publication_sources
              SET active = false, generation = generation + 1,
                  desired_source_version = NULL, desired_extraction_revision = NULL,
                  desired_config_revision = NULL, published_source_version = NULL,
                  published_extraction_revision = NULL, published_generation = NULL
            WHERE scope_binding = $1 AND source_ref = $2
            RETURNING generation`,
          [request.scopeBinding, request.sourceRef]
        );
        await client.query(
          `UPDATE structured_publication_scopes
              SET read_revision = read_revision + 1,
                  maintenance_revision = maintenance_revision + 1
            WHERE scope_binding = $1`,
          [scope.scope_binding]
        );
        const row = update.rows[0] as
          { generation?: string | number } | undefined;
        if (row?.generation === undefined) {
          throw new StructuredPublicationError(
            "maintenance_status_unavailable",
            "source tombstone was not persisted"
          );
        }
        return { generation: safeNumber(row.generation, "source generation") };
      });
    } catch (error) {
      throw publicationError(error);
    }
  }

  async readSnapshot(input: {
    readonly scopeBinding: string;
  }): Promise<PublicationSnapshot> {
    try {
      const scopeBinding = requirePublicationString(
        input?.scopeBinding,
        "scopeBinding"
      );
      return await this.transaction(async (client) => {
        const scopes = await client.query(
          `SELECT scope_binding, read_revision, maintenance_revision
             FROM structured_publication_scopes WHERE scope_binding = $1`,
          [scopeBinding]
        );
        const scope = scopes.rows[0] as Record<string, any> | undefined;
        if (!scope) return emptySnapshot(scopeBinding);
        const sourceResult = await client.query(
          `SELECT s.source_ref, s.active, s.generation,
                  s.desired_source_version, s.desired_extraction_revision,
                  s.desired_config_revision, s.published_source_version,
                  s.published_extraction_revision,
                  CASE WHEN NOT s.active THEN 'stale'
                       ELSE COALESCE((
                         SELECT j.status FROM maintenance_jobs j
                          WHERE j.work_kind = 'extract_publish'
                            AND j.source_ref = s.source_ref
                            AND j.source_generation = s.generation
                            AND j.source_version = s.desired_source_version
                            AND j.config_revision = s.desired_config_revision
                          ORDER BY j.updated_at DESC, j.job_key DESC LIMIT 1
                       ), 'pending') END AS status
             FROM structured_publication_sources s
            WHERE s.scope_binding = $1
            ORDER BY s.source_ref`,
          [scopeBinding]
        );
        const sources: PublicationSourceSnapshot[] = sourceResult.rows.map(
          (row: Record<string, any>) => ({
            sourceRef: String(row.source_ref),
            active: row.active === true,
            generation: safeNumber(row.generation, "source generation"),
            desired:
              row.desired_source_version === null
                ? null
                : {
                    sourceVersion: String(row.desired_source_version),
                    extractionRevision: safeNumber(
                      row.desired_extraction_revision,
                      "desired extraction revision"
                    ),
                    configRevision: String(row.desired_config_revision),
                  },
            published:
              row.published_source_version === null
                ? null
                : {
                    sourceVersion: String(row.published_source_version),
                    extractionRevision: safeNumber(
                      row.published_extraction_revision,
                      "published extraction revision"
                    ),
                  },
            status: String(row.status) as MaintenanceWorkStatus,
          })
        );
        const currentResult = await client.query(
          `SELECT m.subject, m.result_id, m.support_id,
                  d.extraction_revision, d.canonical_name, d.entity_type
             FROM structured_publication_membership m
             JOIN structured_publication_sources s
               ON s.scope_binding = m.scope_binding AND s.source_ref = m.source_ref
              AND s.active AND s.published_generation = m.generation
             LEFT JOIN structured_publication_display d
             ON d.scope_binding = m.scope_binding AND d.source_ref = m.source_ref
              AND d.support_id = m.support_id
              AND d.extraction_revision = s.published_extraction_revision
            WHERE m.scope_binding = $1
            ORDER BY m.subject, m.result_id, m.support_id`,
          [scopeBinding]
        );
        type MutableSubject = {
          subject: "entity" | "assertion";
          resultId: string;
          supportIds: string[];
          displayValues: PublicationDisplayValue[];
        };
        const subjectMap = new Map<string, MutableSubject>();
        for (const row of currentResult.rows as Record<string, any>[]) {
          const key = `${row.subject}\u0000${row.result_id}`;
          const aggregate: MutableSubject = subjectMap.get(key) ?? {
            subject: row.subject,
            resultId: row.result_id,
            supportIds: [],
            displayValues: [],
          };
          aggregate.supportIds.push(String(row.support_id));
          if (row.canonical_name !== null && row.canonical_name !== undefined) {
            aggregate.displayValues.push({
              supportId: String(row.support_id),
              extractionRevision: safeNumber(
                row.extraction_revision,
                "display extraction revision"
              ),
              canonicalName: String(row.canonical_name),
              type: String(row.entity_type),
            });
          }
          subjectMap.set(key, aggregate);
        }
        const subjects: PublicationSubjectSnapshot[] = [
          ...subjectMap.values(),
        ].map((entry) => ({
          ...entry,
          supportIds: entry.supportIds.sort((left, right) =>
            left.localeCompare(right)
          ),
          displayValues: entry.displayValues.sort((left, right) =>
            left.supportId.localeCompare(right.supportId)
          ),
        }));
        const activeCount = sources.filter((source) => source.active).length;
        const maintenance: PublicationMaintenanceSummary = {
          sourcesInScope: activeCount,
          publishedSources: sources.filter(
            (source) => source.active && source.published !== null
          ).length,
          desiredIndexBuckets: activeCount,
          conflictCheckBuckets: activeCount,
          conflictStatus: "pending",
        };
        return {
          scopeBinding,
          readRevision: String(scope.read_revision),
          maintenanceRevision: String(scope.maintenance_revision),
          sources,
          subjects,
          maintenance,
        };
      }, true);
    } catch (error) {
      throw publicationError(error);
    }
  }

  private async lockDesiredSourceAndGuard(
    client: PublicationClient,
    scopeBinding: string,
    sourceRef: string,
    guard: MaintenanceAttemptGuard
  ): Promise<{ source: PublicationSourceRow }> {
    // Shared lock order: reservation -> owner scope -> source -> job. The job is
    // taken last so this writer never holds a job row while waiting a scope;
    // holding job-before-scope here is what deadlocked publish against the work
    // ledger (settle/reclaim/retry take scope before job).
    await lockSourceBindings(client, [sourceRef]);
    await lockScope(client, scopeBinding);
    const source = await lockSource(client, scopeBinding, sourceRef);
    if (
      !source.active ||
      source.desired_source_version === null ||
      source.desired_extraction_revision === null
    ) {
      throw new StructuredPublicationError(
        "input_stale",
        "source is no longer active with a desired pair"
      );
    }
    const guardRow = await lockAndVerifyJob(client, guard);
    if (
      guardRow.work_kind !== "extract_publish" ||
      guardRow.source_ref !== sourceRef
    ) {
      throw new StructuredPublicationError(
        "input_stale",
        "attempt is bound to another source or work kind"
      );
    }
    if (
      safeNumber(source.generation, "source generation") !==
        guard.sourceGeneration ||
      source.desired_source_version !== guard.sourceVersion ||
      source.desired_config_revision !== guard.configRevision
    ) {
      throw new StructuredPublicationError(
        "input_stale",
        "attempt guard does not match the desired source pair"
      );
    }
    await assertLiveDependencies(client, scopeBinding, guardRow, guard);
    await lockAndVerifyJob(client, guard);
    return { source };
  }

  private async transaction<T>(
    body: (client: PublicationClient) => Promise<T>,
    readOnly = false
  ): Promise<T> {
    return this.scope.runTransaction(
      (client) => body(asPublicationClient(client)),
      { readOnly, fail: publicationError }
    );
  }
}

interface SourceMutationPlan {
  readonly removals: readonly PublicationSourceRow[];
  readonly additions: readonly string[];
  readonly reactivations: readonly string[];
  readonly authorizationChanged: boolean;
}

async function declareDesiredTransaction(
  client: PublicationClient,
  request: DeclarePublicationDesiredInput
): Promise<{ readonly generation: number }> {
  const mutations = await lockAndPlanSourceMutations(client, request);
  const removedSubjects = await readSourceProjectionSubjects(
    client,
    request.scopeBinding,
    mutations.removals.map((row) => row.source_ref)
  );
  await emitProjectionIntents(client, removedSubjects);
  const version = await registerDeclaredSourceVersion(client, request);
  await applySourceMutations(client, request.scopeBinding, mutations);
  const generation = await persistDesiredPair(
    client,
    request,
    version.record.source_version
  );
  await advanceDeclarationRevisions(
    client,
    request.scopeBinding,
    mutations.authorizationChanged
  );
  return { generation };
}

async function lockAndPlanSourceMutations(
  client: PublicationClient,
  request: DeclarePublicationDesiredInput
): Promise<SourceMutationPlan> {
  await client.query(
    "INSERT INTO structured_publication_scopes (scope_binding) VALUES ($1) ON CONFLICT DO NOTHING",
    [request.scopeBinding]
  );
  // Reservations precede the scope lock so this path shares the ledger's order
  // (reservation -> owner scope -> source -> job); taking the scope first while
  // a concurrent work write holds the reservation and waits the scope inverts it.
  await lockSourceBindings(client, request.authorizedSourceRefs);
  const scope = await lockScope(client, request.scopeBinding);
  if (!scope.scope_binding) {
    throw new StructuredPublicationError(
      "maintenance_status_unavailable",
      "publication scope row is missing"
    );
  }
  await assertSingleOwnerScope(
    client,
    request.scopeBinding,
    request.authorizedSourceRefs
  );
  const currentRows = await client.query(
    "SELECT * FROM structured_publication_sources WHERE scope_binding = $1 FOR UPDATE",
    [request.scopeBinding]
  );
  return buildSourceMutationPlan(
    currentRows.rows as PublicationSourceRow[],
    request
  );
}

function buildSourceMutationPlan(
  rows: readonly PublicationSourceRow[],
  request: DeclarePublicationDesiredInput
): SourceMutationPlan {
  const current = new Map(rows.map((row) => [row.source_ref, row]));
  const authorized = new Set(request.authorizedSourceRefs);
  const removals = rows.filter(
    (row) => row.active && !authorized.has(row.source_ref)
  );
  const additions = request.authorizedSourceRefs.filter(
    (sourceRef) => !current.has(sourceRef)
  );
  const reactivations = request.authorizedSourceRefs.filter(
    (sourceRef) =>
      current.get(sourceRef)?.active === false &&
      sourceRef !== request.sourceRef
  );
  return {
    removals,
    additions,
    reactivations,
    authorizationChanged:
      removals.length > 0 || additions.length > 0 || reactivations.length > 0,
  };
}

async function registerDeclaredSourceVersion(
  client: PublicationClient,
  request: DeclarePublicationDesiredInput
): Promise<Awaited<ReturnType<typeof registerSourceVersionRow>>> {
  const suppliedVersion: NewSourceVersion = {
    ...request.sourceVersion,
    source_version_id: request.sourceVersion.source_version_id ?? randomUUID(),
  };
  const version = await registerSourceVersionRow(
    client,
    normalizeSourceVersion(suppliedVersion)
  );
  for (const rawBinding of request.locatorBindings) {
    const binding = normalizeLocatorBinding(rawBinding);
    if (binding.source_version_id !== version.record.source_version_id) {
      throw new StructuredPublicationError(
        "unsupported_source_binding",
        "locator binding names a different source version"
      );
    }
    await bindSourceLocatorRow(client, binding);
  }
  return version;
}

async function applySourceMutations(
  client: PublicationClient,
  scopeBinding: string,
  mutations: SourceMutationPlan
): Promise<void> {
  await deactivateSources(client, scopeBinding, mutations.removals);
  await addAuthorizedSources(client, scopeBinding, mutations.additions);
  await reactivateSources(client, scopeBinding, mutations.reactivations);
}

async function deactivateSources(
  client: PublicationClient,
  scopeBinding: string,
  sources: readonly PublicationSourceRow[]
): Promise<void> {
  for (const source of sources) {
    await clearSourcePublication(client, scopeBinding, source.source_ref);
    await client.query(
      `UPDATE structured_publication_sources
          SET active = false, generation = generation + 1,
              desired_source_version = NULL, desired_extraction_revision = NULL,
              desired_config_revision = NULL, published_source_version = NULL,
              published_extraction_revision = NULL, published_generation = NULL
        WHERE scope_binding = $1 AND source_ref = $2`,
      [scopeBinding, source.source_ref]
    );
  }
}

async function addAuthorizedSources(
  client: PublicationClient,
  scopeBinding: string,
  sourceRefs: readonly string[]
): Promise<void> {
  for (const sourceRef of sourceRefs) {
    await client.query(
      `INSERT INTO structured_publication_sources (scope_binding, source_ref, active)
       VALUES ($1, $2, true)`,
      [scopeBinding, sourceRef]
    );
  }
}

async function reactivateSources(
  client: PublicationClient,
  scopeBinding: string,
  sourceRefs: readonly string[]
): Promise<void> {
  for (const sourceRef of sourceRefs) {
    await clearSourcePublication(client, scopeBinding, sourceRef);
    await client.query(
      `UPDATE structured_publication_sources
          SET active = true, generation = generation + 1,
              desired_source_version = NULL, desired_extraction_revision = NULL,
              desired_config_revision = NULL, published_source_version = NULL,
              published_extraction_revision = NULL, published_generation = NULL
        WHERE scope_binding = $1 AND source_ref = $2`,
      [scopeBinding, sourceRef]
    );
  }
}

async function persistDesiredPair(
  client: PublicationClient,
  request: DeclarePublicationDesiredInput,
  sourceVersion: string
): Promise<number> {
  const desired = await client.query(
    `UPDATE structured_publication_sources
        SET active = true, generation = generation + 1,
            desired_source_version = $3, desired_extraction_revision = $4,
            desired_config_revision = $5
      WHERE scope_binding = $1 AND source_ref = $2
      RETURNING generation`,
    [
      request.scopeBinding,
      request.sourceRef,
      sourceVersion,
      request.desiredExtractionRevision,
      request.configRevision,
    ]
  );
  const row = desired.rows[0] as { generation?: string | number } | undefined;
  if (row?.generation === undefined) {
    throw new StructuredPublicationError(
      "maintenance_status_unavailable",
      "desired source row was not created"
    );
  }
  return safeNumber(row.generation, "source generation");
}

async function advanceDeclarationRevisions(
  client: PublicationClient,
  scopeBinding: string,
  authorizationChanged: boolean
): Promise<void> {
  await client.query(
    `UPDATE structured_publication_scopes
        SET read_revision = read_revision + CASE WHEN $2::boolean THEN 1 ELSE 0 END,
            maintenance_revision = maintenance_revision + 1
      WHERE scope_binding = $1`,
    [scopeBinding, authorizationChanged]
  );
}

function validateStage(
  input: StagePublicationAttemptInput
): StagePublicationAttemptInput {
  requirePublicationString(input?.scopeBinding, "scopeBinding");
  requirePublicationString(input?.sourceRef, "sourceRef");
  requirePublicationString(input?.extractionRef, "extractionRef");
  if (!input?.guard || !Array.isArray(input.accepted)) {
    throw new StructuredPublicationError(
      "invalid_input",
      "stage attempt requires a guard and accepted facts array"
    );
  }
  return input;
}

function validatePublish(
  input: PublishStructuredInput
): PublishStructuredInput {
  requirePublicationString(input?.scopeBinding, "scopeBinding");
  requirePublicationString(input?.sourceRef, "sourceRef");
  if (!input?.guard)
    throw new StructuredPublicationError(
      "invalid_input",
      "publish requires an attempt guard"
    );
  return { ...input, at: requirePublicationInstant(input.at, "at") };
}

function validateWithdrawal(
  input: WithdrawStructuredSourceInput
): WithdrawStructuredSourceInput {
  requirePublicationString(input?.scopeBinding, "scopeBinding");
  requirePublicationString(input?.sourceRef, "sourceRef");
  return {
    ...input,
    expectedGeneration: requirePublicationRevision(
      input?.expectedGeneration,
      "expectedGeneration"
    ),
    at: requirePublicationInstant(input.at, "at"),
  };
}

async function lockSourceBindings(
  client: PublicationClient,
  sourceRefs: readonly string[]
): Promise<void> {
  const keys = [...sourceRefs].sort((left, right) => left.localeCompare(right));
  for (const sourceRef of keys) {
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
      reservationLockParameter(sourceRef),
    ]);
  }
}

async function assertSingleOwnerScope(
  client: PublicationClient,
  scopeBinding: string,
  sourceRefs: readonly string[]
): Promise<void> {
  const { rows } = await client.query(
    `SELECT scope_binding, source_ref FROM structured_publication_sources
      WHERE source_ref = ANY($1::text[]) AND scope_binding <> $2
      LIMIT 1 FOR UPDATE`,
    [[...sourceRefs], scopeBinding]
  );
  if (rows.length > 0) {
    throw new StructuredPublicationError(
      "unsupported_source_binding",
      "source already has another authoritative publication scope"
    );
  }
}

async function lockScope(
  client: PublicationClient,
  scopeBinding: string
): Promise<{ scope_binding: string }> {
  const { rows } = await client.query(
    "SELECT scope_binding FROM structured_publication_scopes WHERE scope_binding = $1 FOR UPDATE",
    [scopeBinding]
  );
  const row = rows[0] as { scope_binding?: string } | undefined;
  if (!row)
    throw new StructuredPublicationError(
      "access_denied",
      "trusted publication scope is not registered"
    );
  return { scope_binding: row.scope_binding! };
}

async function lockSource(
  client: PublicationClient,
  scopeBinding: string,
  sourceRef: string
): Promise<PublicationSourceRow> {
  const { rows } = await client.query(
    `SELECT * FROM structured_publication_sources
      WHERE scope_binding = $1 AND source_ref = $2 FOR UPDATE`,
    [scopeBinding, sourceRef]
  );
  const row = rows[0] as PublicationSourceRow | undefined;
  if (!row)
    throw new StructuredPublicationError(
      "access_denied",
      "source is not authorized in this trusted scope"
    );
  return row;
}

async function lockAndVerifyJob(
  client: PublicationClient,
  guard: MaintenanceAttemptGuard
): Promise<JobRow> {
  const { rows } = await client.query(
    "SELECT * FROM maintenance_jobs WHERE job_key = $1 FOR UPDATE",
    [guard.jobKey]
  );
  const row = rows[0] as JobRow | undefined;
  if (
    !row ||
    row.status !== "running" ||
    row.fencing_token !== guard.fencingToken ||
    Number(row.attempt_count) !== guard.attemptNumber
  ) {
    throw new StructuredPublicationError(
      "lease_lost",
      "maintenance attempt no longer owns its job"
    );
  }
  const actual = guardFromJob(row);
  assertPresentedGuardMatches(actual, guard);
  await lockOpenAttempt(client, guard);
  await verifyJobAgainstDatabaseClock(client, actual, guard);
  return row;
}

function assertPresentedGuardMatches(
  actual: MaintenanceAttemptGuard,
  guard: MaintenanceAttemptGuard
): void {
  if (!sameGuardInputs(actual, guard)) {
    throw new StructuredPublicationError(
      "input_stale",
      "maintenance attempt guard no longer matches its job"
    );
  }
}

async function lockOpenAttempt(
  client: PublicationClient,
  guard: MaintenanceAttemptGuard
): Promise<void> {
  const attempt = await client.query(
    `SELECT finished_at FROM maintenance_job_attempts
      WHERE job_key = $1 AND attempt_number = $2 AND fencing_token = $3 FOR UPDATE`,
    [guard.jobKey, guard.attemptNumber, guard.fencingToken]
  );
  if (attempt.rows.length === 0) {
    throw new StructuredPublicationError(
      "backend_unavailable",
      "maintenance attempt history row is missing"
    );
  }
  if (
    (attempt.rows[0] as { finished_at?: Date | string | null }).finished_at !==
    null
  ) {
    throw new StructuredPublicationError(
      "lease_lost",
      "maintenance attempt has already settled"
    );
  }
}

async function verifyJobAgainstDatabaseClock(
  client: PublicationClient,
  actual: MaintenanceAttemptGuard,
  guard: MaintenanceAttemptGuard
): Promise<void> {
  const clockResult = await client.query("SELECT clock_timestamp() AS instant");
  const instant = toIso(
    (clockResult.rows[0] as { instant?: Date | string } | undefined)?.instant
  );
  if (instant === null) {
    throw new StructuredPublicationError(
      "backend_unavailable",
      "database clock did not return a valid instant"
    );
  }
  const ownership = verifyAttemptOwnership(
    actual,
    new Date(instant),
    guard.fencingToken
  );
  if (!ownership.ok)
    throw new StructuredPublicationError(
      ownership.code,
      "maintenance attempt lease or absolute deadline expired"
    );
}

function guardFromJob(row: JobRow): MaintenanceAttemptGuard {
  const leaseExpiresAt = toIso(row.lease_expires_at);
  const attemptStartedAt = toIso(row.attempt_started_at);
  if (
    leaseExpiresAt === null ||
    attemptStartedAt === null ||
    row.fencing_token === null
  ) {
    throw new StructuredPublicationError(
      "lease_lost",
      "running maintenance job has no live lease fields"
    );
  }
  return {
    jobKey: row.job_key,
    attemptNumber: Number(row.attempt_count),
    fencingToken: row.fencing_token,
    workKind: row.work_kind as MaintenanceAttemptGuard["workKind"],
    sourceRef: row.source_ref,
    sourceVersion: row.source_version,
    sourceGeneration: safeNumber(
      row.source_generation,
      "job source generation"
    ),
    inputRevision: row.input_revision,
    configRevision: row.config_revision,
    leaseExpiresAt,
    attemptStartedAt,
  };
}

function sameGuardInputs(
  left: MaintenanceAttemptGuard,
  right: MaintenanceAttemptGuard
): boolean {
  const fields = [
    "jobKey",
    "attemptNumber",
    "fencingToken",
    "workKind",
    "sourceRef",
    "sourceVersion",
    "sourceGeneration",
    "inputRevision",
    "configRevision",
    "leaseExpiresAt",
    "attemptStartedAt",
  ] as const satisfies readonly (keyof MaintenanceAttemptGuard)[];
  return fields.every((field) => left[field] === right[field]);
}

async function assertLiveDependencies(
  client: PublicationClient,
  scopeBinding: string,
  job: JobRow,
  guard: MaintenanceAttemptGuard
): Promise<void> {
  const dependencies = parseDependencies(job.input_dependencies);
  if (canonicalDependencyRevision(dependencies) !== guard.inputRevision) {
    throw new StructuredPublicationError(
      "backend_unavailable",
      "maintenance dependency snapshot does not match its input revision"
    );
  }
  const live: MaintenanceDependency[] = [];
  for (const dependency of dependencies) {
    live.push(await readLiveDependency(client, scopeBinding, dependency));
  }
  if (canonicalDependencyRevision(live) !== guard.inputRevision) {
    throw new StructuredPublicationError(
      "input_stale",
      "live dependencies no longer match the scheduled input revision"
    );
  }
}

async function readLiveDependency(
  client: PublicationClient,
  scopeBinding: string,
  dependency: MaintenanceDependency
): Promise<MaintenanceDependency> {
  if (dependency.relationBuckets.length > 0) {
    throw new StructuredPublicationError(
      "maintenance_status_unavailable",
      "relation-bucket inputs require the later structural-screening capability"
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
  if (
    row === undefined ||
    row.active !== true ||
    row.generation === undefined
  ) {
    throw new StructuredPublicationError(
      "input_stale",
      "a source dependency changed after this attempt was scheduled"
    );
  }
  if (
    safeNumber(row.generation, "dependency generation") !==
    dependency.generation
  ) {
    throw new StructuredPublicationError(
      "input_stale",
      "a source dependency changed after this attempt was scheduled"
    );
  }
  const extractionRevision =
    row.published_extraction_revision === null ||
    row.published_extraction_revision === undefined
      ? null
      : safeNumber(
          row.published_extraction_revision,
          "dependency extraction revision"
        );
  if (extractionRevision !== dependency.extractionRevision) {
    throw new StructuredPublicationError(
      "input_stale",
      "a dependency extraction changed after this attempt was scheduled"
    );
  }
  return { ...dependency, extractionRevision };
}

function parseDependencies(value: unknown): readonly MaintenanceDependency[] {
  const parsed = parseDependencyJson(value);
  if (!Array.isArray(parsed)) {
    throw new StructuredPublicationError(
      "backend_unavailable",
      "maintenance dependency snapshot is missing"
    );
  }
  return parsed.map(parseDependency);
}

function parseDependencyJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new StructuredPublicationError(
        "backend_unavailable",
        "maintenance dependency snapshot is invalid JSON"
      );
    }
  }
  return value;
}

function parseDependency(value: unknown): MaintenanceDependency {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StructuredPublicationError(
      "backend_unavailable",
      "maintenance dependency snapshot is malformed"
    );
  }
  const item = value as Record<string, unknown>;
  if (typeof item.sourceRef !== "string") {
    throw new StructuredPublicationError(
      "backend_unavailable",
      "maintenance dependency source is malformed"
    );
  }
  if (!Number.isSafeInteger(item.generation) || Number(item.generation) < 0) {
    throw new StructuredPublicationError(
      "backend_unavailable",
      "maintenance dependency generation is malformed"
    );
  }
  const extractionRevision = parseDependencyExtractionRevision(
    item.extractionRevision
  );
  const relationBuckets = parseDependencyRelationBuckets(item.relationBuckets);
  return {
    sourceRef: item.sourceRef,
    generation: Number(item.generation),
    extractionRevision,
    relationBuckets,
  };
}

function parseDependencyExtractionRevision(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new StructuredPublicationError(
      "backend_unavailable",
      "maintenance dependency extraction revision is malformed"
    );
  }
  return Number(value);
}

function parseDependencyRelationBuckets(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((bucket: unknown) => typeof bucket === "string")
  ) {
    throw new StructuredPublicationError(
      "backend_unavailable",
      "maintenance dependency relation buckets are malformed"
    );
  }
  return value;
}

function stageMatchesGuard(
  stage: Record<string, any>,
  guard: MaintenanceAttemptGuard,
  source: PublicationSourceRow
): boolean {
  return (
    safeNumber(stage.generation, "staged generation") ===
      safeNumber(source.generation, "source generation") &&
    stage.job_key === guard.jobKey &&
    Number(stage.attempt_number) === guard.attemptNumber &&
    stage.fencing_token === guard.fencingToken
  );
}

async function assertFactLocatorsBound(
  client: PublicationClient,
  facts: ReturnType<typeof normalizePublicationFacts>
): Promise<void> {
  const checked = new Set<string>();
  for (const fact of facts) {
    const occurrence = fact.occurrence;
    const key = `${occurrence.source_ref}\u0000${occurrence.source_version}\u0000${occurrence.location.document_id}\u0000${occurrence.location.version}\u0000${occurrence.location.unit}`;
    if (checked.has(key)) continue;
    checked.add(key);
    const { rows } = await client.query(
      `SELECT 1 FROM source_versions v
        JOIN source_version_locators l USING (source_version_id)
       WHERE v.source_ref = $1 AND v.source_version = $2
         AND l.document_id = $3 AND l.unit_version = $4 AND l.unit = $5`,
      [
        occurrence.source_ref,
        occurrence.source_version,
        occurrence.location.document_id,
        occurrence.location.version,
        occurrence.location.unit,
      ]
    );
    if (rows.length === 0) {
      throw new StructuredPublicationError(
        "unsupported_source_binding",
        "publication fact locator is not bound to its immutable source version"
      );
    }
  }
}

async function registerFactIdentities(
  client: PublicationClient,
  facts: ReturnType<typeof normalizePublicationFacts>,
  guard: MaintenanceAttemptGuard
): Promise<void> {
  const identityStore = new PgStructuredIdentityStore(client);
  const entityInputs = new Map<string, EntityIdentityInput>();
  const entityVertexNames = new Map<string, string>();
  const assertionInputs = new Map<string, RelationAssertionInput>();
  for (const fact of facts) {
    if (fact.fact.identity.kind === "entity") {
      entityInputs.set(fact.resultId, fact.fact.identity.input);
      entityVertexNames.set(fact.resultId, fact.displayName ?? fact.resultId);
    } else {
      assertionInputs.set(fact.resultId, fact.fact.identity.input);
    }
  }
  // An accepted entity fact is what makes the graph vertex real: publishing it
  // materializes `entities` before `structured_entity_identities` and the
  // membership rows that reference it, so a published fact never hangs off a
  // vertex only a later extraction step would supply. Existing vertices keep
  // their canonical name and embedding — only the closed-set type is refreshed.
  for (const [entityId, input] of entityInputs) {
    await ensureGraphEntityVertex(
      client,
      entityId,
      input.type,
      entityVertexNames.get(entityId) ?? entityId
    );
  }
  for (const entity of entityInputs.values()) {
    await lockAndVerifyJob(client, guard);
    await identityStore.registerEntity(entity);
  }
  for (const assertion of assertionInputs.values()) {
    await lockAndVerifyJob(client, guard);
    await identityStore.registerRelationAssertion(assertion);
  }
}

async function ensureGraphEntityVertex(
  client: PublicationClient,
  entityId: string,
  entityType: string,
  canonicalName: string
): Promise<void> {
  await client.query(
    `INSERT INTO entities (id, canonical_name, type)
          VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type`,
    [entityId, canonicalName, entityType]
  );
}

async function assertOrRecordExtractionBinding(
  client: PublicationClient,
  scopeBinding: string,
  source: PublicationSourceRow,
  extractionRef: string,
  payloadDigest: string,
  facts: ReturnType<typeof normalizePublicationFacts>,
  supports: readonly SupportRecord[],
  guard: MaintenanceAttemptGuard
): Promise<void> {
  const sourceVersion = source.desired_source_version;
  const extractionRevision = safeNumber(
    source.desired_extraction_revision,
    "desired extraction revision"
  );
  const configRevision = source.desired_config_revision;
  if (sourceVersion === null || configRevision === null) {
    throw new StructuredPublicationError(
      "input_stale",
      "desired extraction binding is missing"
    );
  }
  await assertExistingDisplayBindings(
    client,
    scopeBinding,
    source.source_ref,
    sourceVersion,
    extractionRevision,
    facts,
    supports,
    guard
  );
  const existingResult = await client.query(
    `SELECT config_revision, extraction_ref, payload_digest
       FROM structured_publication_extraction_bindings
      WHERE scope_binding = $1 AND source_ref = $2
      AND source_version = $3 AND extraction_revision = $4
      FOR UPDATE`,
    [scopeBinding, source.source_ref, sourceVersion, extractionRevision]
  );
  await lockAndVerifyJob(client, guard);
  const existing = existingResult.rows[0] as
    | {
        config_revision: string;
        extraction_ref: string;
        payload_digest: string;
      }
    | undefined;
  if (existing !== undefined) {
    if (
      !sameExtractionBinding(
        existing,
        configRevision,
        extractionRef,
        payloadDigest
      )
    ) {
      throw new StructuredPublicationError(
        "input_stale",
        "published extraction revision is already bound to different inputs or output"
      );
    }
    return;
  }
  await lockAndVerifyJob(client, guard);
  await client.query(
    `INSERT INTO structured_publication_extraction_bindings
       (scope_binding, source_ref, source_version, extraction_revision,
        config_revision, extraction_ref, payload_digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      scopeBinding,
      source.source_ref,
      sourceVersion,
      extractionRevision,
      configRevision,
      extractionRef,
      payloadDigest,
    ]
  );
}

async function assertExistingDisplayBindings(
  client: PublicationClient,
  scopeBinding: string,
  sourceRef: string,
  sourceVersion: string,
  extractionRevision: number,
  facts: ReturnType<typeof normalizePublicationFacts>,
  supports: readonly SupportRecord[],
  guard: MaintenanceAttemptGuard
): Promise<void> {
  const expected = new Map(
    facts.map((fact, index) => [
      supports[index]!.support_id,
      fact.displayName === undefined || fact.entityType === undefined
        ? null
        : { canonicalName: fact.displayName, entityType: fact.entityType },
    ])
  );
  const { rows } = await client.query(
    `SELECT d.support_id, d.canonical_name, d.entity_type
       FROM structured_publication_display d
       JOIN assertion_supports a USING (support_id)
      WHERE d.scope_binding = $1 AND d.source_ref = $2
        AND d.extraction_revision = $3
        AND a.source_ref = $2 AND a.source_version = $4
      ORDER BY d.support_id
      FOR UPDATE OF d`,
    [scopeBinding, sourceRef, extractionRevision, sourceVersion]
  );
  await lockAndVerifyJob(client, guard);
  for (const row of rows as {
    support_id: string;
    canonical_name: string;
    entity_type: string;
  }[]) {
    const value = expected.get(row.support_id);
    if (
      value === undefined ||
      value === null ||
      value.canonicalName !== row.canonical_name ||
      value.entityType !== row.entity_type
    ) {
      throw new StructuredPublicationError(
        "input_stale",
        "retained display payload conflicts with this immutable extraction revision"
      );
    }
  }
}

function sameExtractionBinding(
  existing: {
    readonly config_revision: string;
    readonly extraction_ref: string;
    readonly payload_digest: string;
  },
  configRevision: string,
  extractionRef: string,
  payloadDigest: string
): boolean {
  return (
    existing.config_revision === configRevision &&
    existing.extraction_ref === extractionRef &&
    existing.payload_digest === payloadDigest
  );
}

async function emitPublicationProjectionIntents(
  client: PublicationClient,
  subjects: readonly ProjectionSubject[],
  guard: MaintenanceAttemptGuard
): Promise<void> {
  await emitProjectionIntents(client, subjects, async () => {
    await lockAndVerifyJob(client, guard);
  });
}

async function finishPublicationAttempt(
  client: PublicationClient,
  scopeBinding: string,
  guard: MaintenanceAttemptGuard,
  completedAt: string
): Promise<void> {
  const result = await client.query(
    `WITH ready_job AS (
       UPDATE maintenance_jobs
          SET status = 'ready', last_failure_code = NULL, next_attempt_at = NULL,
              fencing_token = NULL, lease_expires_at = NULL,
              attempt_started_at = NULL, updated_at = $4::timestamptz
        WHERE job_key = $1 AND status = 'running'
          AND fencing_token = $2 AND attempt_count = $3
          AND lease_expires_at > clock_timestamp()
          AND attempt_started_at + ($5::double precision * interval '1 millisecond') > clock_timestamp()
        RETURNING job_key
     ), finished_attempt AS (
       UPDATE maintenance_job_attempts AS a
          SET finished_at = $4::timestamptz, failure_code = NULL, reclaimed = false
         FROM ready_job AS j
        WHERE a.job_key = j.job_key AND a.attempt_number = $3
          AND a.fencing_token = $2 AND a.finished_at IS NULL
        RETURNING a.job_key
     ), revised_scope AS (
       UPDATE structured_publication_scopes AS s
          SET read_revision = s.read_revision + 1,
              maintenance_revision = s.maintenance_revision + 1
        WHERE s.scope_binding = $6
          AND EXISTS (SELECT 1 FROM finished_attempt)
        RETURNING s.scope_binding
     )
     SELECT (SELECT count(*) FROM ready_job) AS ready_count,
            (SELECT count(*) FROM finished_attempt) AS attempt_count,
            (SELECT count(*) FROM revised_scope) AS scope_count`,
    [
      guard.jobKey,
      guard.fencingToken,
      guard.attemptNumber,
      completedAt,
      WORK_ABSOLUTE_LIMIT_MS,
      scopeBinding,
    ]
  );
  const counts = result.rows[0] as
    | {
        ready_count?: number | string;
        attempt_count?: number | string;
        scope_count?: number | string;
      }
    | undefined;
  if (Number(counts?.ready_count ?? 0) !== 1) {
    await lockAndVerifyJob(client, guard);
    throw new StructuredPublicationError(
      "lease_lost",
      "maintenance job changed during publication"
    );
  }
  if (
    Number(counts?.attempt_count ?? 0) !== 1 ||
    Number(counts?.scope_count ?? 0) !== 1
  ) {
    throw new StructuredPublicationError(
      "backend_unavailable",
      "publication attempt history or scope revision is missing"
    );
  }
}

async function persistFactEvidence(
  client: PublicationClient,
  facts: ReturnType<typeof normalizePublicationFacts>,
  guard: MaintenanceAttemptGuard
): Promise<SupportRecord[]> {
  const supports: SupportRecord[] = [];
  for (const fact of facts) {
    await lockAndVerifyJob(client, guard);
    const occurrence = normalizeOccurrence(fact.fact.occurrence);
    const result = await recordSupportRow(client, occurrence, randomUUID());
    if (
      result.support.result_id !== fact.resultId ||
      result.support.subject !== fact.subject
    ) {
      throw new StructuredPublicationError(
        "invalid_input",
        "persisted support identity does not match accepted publication fact"
      );
    }
    supports.push(result.support);
  }
  return supports;
}

async function replaceSourceMembership(
  client: PublicationClient,
  scopeBinding: string,
  sourceRef: string,
  source: PublicationSourceRow,
  facts: ReturnType<typeof normalizePublicationFacts>,
  supports: readonly SupportRecord[],
  guard: MaintenanceAttemptGuard
): Promise<void> {
  await lockAndVerifyJob(client, guard);
  await client.query(
    "DELETE FROM structured_publication_membership WHERE scope_binding = $1 AND source_ref = $2",
    [scopeBinding, sourceRef]
  );
  const generation = safeNumber(source.generation, "source generation");
  const revision = safeNumber(
    source.desired_extraction_revision,
    "desired extraction revision"
  );
  for (let index = 0; index < facts.length; index += 1) {
    const fact = facts[index]!;
    const support = supports[index]!;
    await lockAndVerifyJob(client, guard);
    await client.query(
      `INSERT INTO structured_publication_membership
         (scope_binding, source_ref, generation, extraction_ref, support_id, subject, result_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        scopeBinding,
        sourceRef,
        generation,
        fact.occurrence.extraction_ref,
        support.support_id,
        fact.subject,
        fact.resultId,
      ]
    );
    if (fact.displayName !== undefined && fact.entityType !== undefined) {
      await lockAndVerifyJob(client, guard);
      await client.query(
        `INSERT INTO structured_publication_display
           (scope_binding, source_ref, support_id, extraction_revision, canonical_name, entity_type)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (scope_binding, source_ref, support_id, extraction_revision) DO NOTHING`,
        [
          scopeBinding,
          sourceRef,
          support.support_id,
          revision,
          fact.displayName,
          fact.entityType,
        ]
      );
    }
  }
  await lockAndVerifyJob(client, guard);
  const update = await client.query(
    `UPDATE structured_publication_sources
        SET published_source_version = desired_source_version,
            published_extraction_revision = desired_extraction_revision,
            published_generation = generation
      WHERE scope_binding = $1 AND source_ref = $2 AND active
        AND generation = $3 AND desired_source_version IS NOT NULL
      RETURNING source_ref`,
    [scopeBinding, sourceRef, generation]
  );
  if (update.rows.length !== 1) {
    throw new StructuredPublicationError(
      "input_stale",
      "desired source pair changed before membership publication"
    );
  }
}

async function clearSourcePublication(
  client: PublicationClient,
  scopeBinding: string,
  sourceRef: string
): Promise<void> {
  await client.query(
    "DELETE FROM structured_publication_membership WHERE scope_binding = $1 AND source_ref = $2",
    [scopeBinding, sourceRef]
  );
  await client.query(
    "DELETE FROM structured_publication_stages WHERE scope_binding = $1 AND source_ref = $2",
    [scopeBinding, sourceRef]
  );
}

async function readSourceProjectionSubjects(
  client: PublicationClient,
  scopeBinding: string,
  sourceRefs: readonly string[]
): Promise<ProjectionSubject[]> {
  if (sourceRefs.length === 0) return [];
  const { rows } = await client.query(
    `SELECT DISTINCT subject, result_id FROM structured_publication_membership
      WHERE scope_binding = $1 AND source_ref = ANY($2::text[])`,
    [scopeBinding, [...sourceRefs]]
  );
  return rows.map((row: Record<string, any>) =>
    projectionSubject(row.subject, String(row.result_id))
  );
}

function projectionSubject(subject: string, id: string): ProjectionSubject {
  return { kind: subject === "entity" ? "entity" : "triple", id };
}

function uniqueSubjects(
  subjects: readonly ProjectionSubject[]
): ProjectionSubject[] {
  const unique = new Map(
    subjects.map((subject) => [`${subject.kind}:${subject.id}`, subject])
  );
  return [...unique.values()];
}

function parseFacts(
  value: unknown
): import("../maintenance/publication-types.js").PublicationFact[] {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      throw new StructuredPublicationError(
        "backend_unavailable",
        "staged publication payload is not valid JSON"
      );
    }
  }
  if (Array.isArray(value)) return value;
  throw new StructuredPublicationError(
    "backend_unavailable",
    "staged publication payload is missing"
  );
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value : new Date(value);
  return Number.isFinite(time.getTime()) ? time.toISOString() : null;
}

function safeNumber(value: string | number | null, field: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new StructuredPublicationError(
      "maintenance_status_unavailable",
      `${field} is outside the safe integer range`
    );
  }
  return number;
}

function emptySnapshot(scopeBinding: string): PublicationSnapshot {
  return {
    scopeBinding,
    readRevision: "0",
    maintenanceRevision: "0",
    sources: [],
    subjects: [],
    maintenance: {
      sourcesInScope: 0,
      publishedSources: 0,
      desiredIndexBuckets: 0,
      conflictCheckBuckets: 0,
      conflictStatus: "pending",
    },
  };
}
