/**
 * PostgreSQL persistence for structural screening evidence.
 *
 * The screen runs inside the shared authorized scope unit of work, so it takes
 * the same locks in the same order and commits once. Candidates are inserted
 * only after the real conflict-check attempt's live token, lease and absolute
 * deadline all hold and the complete dependency vector still matches, which is
 * what makes "a stale screen changes neither newer job status nor candidates"
 * true rather than merely intended.
 */
import { randomUUID } from "node:crypto";

import type {
  MaintenanceAttemptGuard,
  MaintenanceDependency,
  MaintenanceLiveInputs,
  MaintenanceWorkFailureCode,
} from "../maintenance/types.js";
import {
  isConflictCheckGuard,
  screenFenceVerdict,
  selectStructuralAlternatives,
  toStructuralCandidates,
} from "../maintenance/screening-selection.js";
import {
  SCREENING_COVERAGE,
  SCREENING_RULESET_REVISION,
  type ScreeningAssertion,
  type StructuralCandidate,
  type StructuralScreenOutcome,
} from "../maintenance/screening-types.js";
import {
  structuredScopeCodeOf,
  StructuredScopeError,
  type AuthorizedScopeContext,
  type AuthorizedScopeRunOptions,
  type AuthorizedScopeWork,
  type StructuredScopeFailureCode,
} from "./structured-scope-types.js";

/** The seam this adapter runs under; composition supplies it exactly once. */
export interface ScreeningAuthority {
  withAuthorizedScope<R>(
    context: AuthorizedScopeContext,
    callback: (work: AuthorizedScopeWork) => Promise<R>,
    options?: AuthorizedScopeRunOptions
  ): Promise<R>;
}

export interface PgStageScreenInput {
  readonly context: AuthorizedScopeContext;
  readonly guard: MaintenanceAttemptGuard;
  readonly relationBuckets: readonly string[];
  readonly relationCatalogVersion: number;
  readonly relationCatalogEntries: readonly {
    readonly relationNorm: string;
    readonly cardinality: "multi_valued" | "exclusive";
  }[];
  readonly maxAssertions?: number;
  /** Extra sources whose dependency rows this screen is fenced against. */
  readonly additionalSourceRefs?: readonly string[];
}

/** What one persisted candidate row carries back to a reader. */
export interface PersistedCandidate {
  readonly candidateId: string;
  readonly checkId: string;
  readonly headEntityId: string;
  readonly relationNorm: string;
  readonly assertionIds: readonly string[];
  readonly tailEntityIds: readonly string[];
  readonly supportIds: readonly string[];
  readonly uncertaintyReason: string;
  readonly unboundedLower: boolean;
  readonly unboundedUpper: boolean;
}

interface ScreeningJobRow {
  readonly job_key: string;
  readonly status: string;
  readonly fencing_token: string | null;
  readonly attempt_count: string;
  readonly work_kind: string;
  readonly source_ref: string;
  readonly source_version: string;
  readonly source_generation: string;
  readonly input_revision: string;
  readonly config_revision: string;
  readonly lease_expires_at: Date | string | null;
  readonly attempt_started_at: Date | string | null;
  readonly input_dependencies: unknown;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function safeNumber(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    // EXIT: a ledger or source row carries a value that is not a non-negative
    // integer where the schema requires one. The screen throws before any
    // candidate row is written, so no evidence is published from a row whose
    // generation or revision cannot be read exactly.
    throw new StructuredScopeError(
      "maintenance_status_unavailable",
      `${field} is not a non-negative integer`
    );
  }
  return parsed;
}

function parseDependencies(value: unknown): MaintenanceDependency[] {
  // The column is jsonb, so a driver may hand it back already decoded; a text
  // spelling is also accepted because the same value is read as text elsewhere.
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      // EXIT: a scheduled dependency vector is text and is not JSON. The screen
      // throws `maintenance_status_unavailable` rather than screening against an
      // empty vector, because an unread dependency is not an absent one.
      throw new StructuredScopeError(
        "maintenance_status_unavailable",
        "scheduled dependency vector is not readable JSON"
      );
    }
  }
  if (!Array.isArray(parsed)) {
    // EXIT: the dependency vector parsed to a non-array. The screen refuses
    // instead of treating the malformed vector as an empty one, which would
    // publish candidates bound to inputs this attempt never checked.
    throw new StructuredScopeError(
      "maintenance_status_unavailable",
      "scheduled dependency vector is not an array"
    );
  }
  return parsed.map((entry) => {
    const dependency = entry as Partial<MaintenanceDependency>;
    return {
      sourceRef: String(dependency.sourceRef ?? ""),
      generation: safeNumber(dependency.generation, "dependency generation"),
      extractionRevision:
        dependency.extractionRevision === null ||
        dependency.extractionRevision === undefined
          ? null
          : safeNumber(
              dependency.extractionRevision,
              "dependency extraction revision"
            ),
      relationBuckets: Array.isArray(dependency.relationBuckets)
        ? dependency.relationBuckets.map(String)
        : [],
    };
  });
}

/** Rebuild the authoritative guard from the ledger row itself. */
function guardFromRow(row: ScreeningJobRow): MaintenanceAttemptGuard {
  const leaseExpiresAt = toIso(row.lease_expires_at);
  const attemptStartedAt = toIso(row.attempt_started_at);
  if (
    row.fencing_token === null ||
    leaseExpiresAt === null ||
    attemptStartedAt === null
  ) {
    // EXIT: a job this screen believes it owns carries no live lease fields.
    // The screen throws `lease_lost` instead of reading a null lease as an
    // infinite one, which would turn a settled attempt into a writable one.
    throw new StructuredScopeError(
      "lease_lost",
      "running maintenance job has no live lease fields"
    );
  }
  return {
    jobKey: row.job_key,
    attemptNumber: safeNumber(row.attempt_count, "job attempt count"),
    fencingToken: row.fencing_token,
    workKind: row.work_kind as MaintenanceAttemptGuard["workKind"],
    sourceRef: row.source_ref,
    sourceVersion: row.source_version,
    sourceGeneration: safeNumber(row.source_generation, "job source generation"),
    inputRevision: row.input_revision,
    configRevision: row.config_revision,
    leaseExpiresAt,
    attemptStartedAt,
  };
}

/**
 * Read the accepted assertions the screen classifies.
 *
 * Only currently accepted, currently published memberships of the locked
 * sources are read, and each row carries the support and extraction revision it
 * was read at. A source with nothing accepted contributes nothing rather than
 * refusing: an empty accepted assertion set is a valid completed check.
 */
async function readAcceptedAssertions(
  client: AuthorizedScopeWork["client"],
  scopeBinding: string,
  sourceRefs: readonly string[],
  buckets: readonly string[]
): Promise<ScreeningAssertion[]> {
  const { rows } = await client.query(
    `SELECT a.assertion_id, a.head_entity_id, a.relation_norm,
            a.tail_entity_id, a.valid_from, a.valid_until,
            m.source_ref, m.support_id, m.extraction_ref,
            s.published_extraction_revision, s.generation
       FROM structured_relation_assertion_identities a
       JOIN structured_publication_membership m
         ON m.scope_binding = $1
        AND m.subject = 'assertion'
        AND m.result_id = a.assertion_id::text
       JOIN structured_publication_sources s
         ON s.scope_binding = m.scope_binding
        AND s.source_ref = m.source_ref
        AND s.active
      WHERE m.source_ref = ANY($2::text[])
        AND s.published_extraction_revision IS NOT NULL
        AND ($3::text[] = ARRAY[]::text[] OR a.relation_norm = ANY($3::text[]))
      ORDER BY a.assertion_id, m.source_ref, m.support_id`,
    [scopeBinding, [...sourceRefs], [...buckets]]
  );
  return rows.map((row) => {
    const source = row as {
      assertion_id: string;
      head_entity_id: string;
      relation_norm: string;
      tail_entity_id: string;
      valid_from: string | null;
      valid_until: string | null;
      source_ref: string;
      support_id: string;
      extraction_ref: string;
      published_extraction_revision: string | number;
      generation: string | number;
    };
    return {
      headEntityId: source.head_entity_id,
      relationNorm: source.relation_norm,
      tailEntityId: source.tail_entity_id,
      interval: { lower: source.valid_from, upper: source.valid_until },
      assertionId: source.assertion_id,
      supportIds: [source.support_id],
      extractionRef: source.extraction_ref,
      extractionRevision: safeNumber(
        source.published_extraction_revision,
        "published extraction revision"
      ),
      inputRevision: `source:${source.source_ref}:generation:${safeNumber(
        source.generation,
        "source generation"
      )}`,
    };
  });
}

/**
 * Rebuild the live dependency vector from the source rows this run locked.
 *
 * Reading it from the rows rather than from the scheduled snapshot is the fence:
 * a generation, extraction revision or active flag that moved after scheduling
 * produces a different vector, and the attempt refuses instead of screening
 * inputs that no longer exist.
 */
interface LiveDependency {
  readonly dependency: MaintenanceDependency;
  /** The source row's current config/ruleset revision. */
  readonly configRevision: string | null;
}

async function readLiveDependencies(
  client: AuthorizedScopeWork["client"],
  scopeBinding: string,
  scheduled: readonly MaintenanceDependency[]
): Promise<LiveDependency[]> {
  const live: LiveDependency[] = [];
  for (const dependency of scheduled) {
    const { rows } = await client.query(
      `SELECT active, generation, published_extraction_revision,
              desired_config_revision, published_source_version
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
          desired_config_revision?: string | null;
          published_source_version?: string | null;
        }
      | undefined;
    if (row === undefined || row.active !== true || row.generation === undefined) {
      // EXIT: a scheduled dependency names no active source row in this scope.
      // The screen throws `input_stale` rather than screening with the source
      // treated as absent, because an unpublished dependency is not an empty one.
      throw new StructuredScopeError(
        "input_stale",
        `dependency ${dependency.sourceRef} is not an active source in this scope`
      );
    }
    const revision = row.published_extraction_revision;
    live.push({
      dependency: {
        sourceRef: dependency.sourceRef,
        generation: safeNumber(row.generation, "live source generation"),
        extractionRevision:
          revision === null || revision === undefined
            ? null
            : safeNumber(revision, "live published extraction revision"),
        relationBuckets: [...dependency.relationBuckets],
      },
      // A published source is bound to the desired config revision it was
      // declared with, so that is the revision a screen must still match. A
      // source with nothing published contributes null and is fenced by its
      // generation instead.
      configRevision:
        row.published_source_version === null ||
        row.published_source_version === undefined
          ? null
          : row.desired_config_revision ?? null,
    });
  }
  return live;
}

/**
 * Narrow a durable-work fence verdict to the closed scope vocabulary.
 *
 * `verifyAttemptOwnership` and `verifyAttemptGuard` answer in the maintenance
 * work vocabulary. Every code they can return is already one of the scope codes,
 * so an unmappable value means a fence grew a code this adapter does not know,
 * and it becomes `backend_unavailable` rather than being passed through.
 */
function scopeFailureCodeOf(
  code: MaintenanceWorkFailureCode
): StructuredScopeFailureCode {
  return structuredScopeCodeOf(code) ?? "backend_unavailable";
}

function fenceMessageOf(code: MaintenanceWorkFailureCode): string {
  if (code === "lease_lost") {
    return "maintenance attempt token, lease, or attempt number no longer holds";
  }
  if (code === "execution_timeout") {
    return "maintenance attempt outlived its absolute deadline";
  }
  if (code === "ruleset_unavailable") {
    return "the bound ruleset revision is not available to this screen";
  }
  return "live dependencies no longer match the scheduled input revision";
}

async function databaseNow(
  client: AuthorizedScopeWork["client"]
): Promise<Date> {
  const { rows } = await client.query("SELECT clock_timestamp() AS instant");
  const value = (rows[0] as { instant?: Date | string } | undefined)?.instant;
  const instant = toIso(value ?? null);
  if (instant === null) {
    // EXIT: the database clock returned nothing readable. The screen throws
    // `backend_unavailable` instead of falling back to a process clock, which
    // would let a lease expire on a different machine's time.
    throw new StructuredScopeError(
      "backend_unavailable",
      "database clock did not return a valid instant"
    );
  }
  return new Date(instant);
}

async function insertCandidates(
  client: AuthorizedScopeWork["client"],
  scopeBinding: string,
  checkId: string,
  candidates: readonly StructuralCandidate[]
): Promise<void> {
  for (const candidate of candidates) {
    await client.query(
      `INSERT INTO structured_screening_candidates
         (candidate_id, check_id, scope_binding, head_entity_id, relation_norm,
          assertion_ids, tail_entity_ids, support_ids, support_revisions,
          extraction_revisions, assertion_input_revisions, input_revision,
          relation_catalog_version, uncertainty_lower, uncertainty_upper,
          uncertainty_reason, published_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,
               $11::jsonb,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (candidate_id) DO NOTHING`,
      [
        candidate.candidateId,
        checkId,
        scopeBinding,
        candidate.headEntityId,
        candidate.relationNorm,
        JSON.stringify(candidate.assertionIds),
        JSON.stringify(candidate.tailEntityIds),
        JSON.stringify(candidate.supportIds),
        JSON.stringify(candidate.supportRevisions),
        JSON.stringify(candidate.extractionRevisions),
        JSON.stringify(candidate.assertionInputRevisions),
        candidate.inputRevision,
        candidate.relationCatalogVersion,
        candidate.uncertainty.unboundedLower,
        candidate.uncertainty.unboundedUpper,
        candidate.uncertainty.reason,
        candidate.publishedAt,
      ]
    );
  }
}

/** PostgreSQL structural screening, bound to the shared scope unit of work. */
export class PgScreeningStorage {
  constructor(private readonly scope: ScreeningAuthority) {}

  /**
   * Publish one structural check and its candidates, or refuse typed.
   *
   * The order is the contract: verify the attempt, rebuild the live inputs from
   * the locked rows, screen, then write the check before its candidates. Any
   * refusal rolls the whole unit of work back, so a refused check leaves no
   * candidate row and no readiness.
   */
  async stageScreen(
    input: PgStageScreenInput
  ): Promise<StructuralScreenOutcome> {
    if (!isConflictCheckGuard(input.guard)) {
      // EXIT: a screen is asked to publish under an attempt that is not a
      // conflict-check attempt. It throws `invalid_input` before the unit of
      // work opens, so no statement runs and no evidence is published under an
      // attempt that never checked a relation bucket.
      throw new StructuredScopeError(
        "invalid_input",
        "structural screening requires a conflict_check attempt"
      );
    }
    if (input.maxAssertions !== undefined && input.maxAssertions < 1) {
      // EXIT: a caller-supplied assertion ceiling below one is not a limit. The
      // screen throws `invalid_input` rather than treating a non-positive limit
      // as an exhausted budget, which would refuse every check.
      throw new StructuredScopeError(
        "invalid_input",
        "maxAssertions must be a positive integer when supplied"
      );
    }
    return this.scope.withAuthorizedScope(
      input.context,
      async (work) => {
        const client = work.client;
        const now = await databaseNow(client);
        const { rows } = await client.query(
          `SELECT * FROM maintenance_jobs WHERE job_key = $1 FOR UPDATE`,
          [input.guard.jobKey]
        );
        const row = rows[0] as ScreeningJobRow | undefined;
        if (
          row === undefined ||
          row.status !== "running" ||
          row.fencing_token !== input.guard.fencingToken ||
          safeNumber(row.attempt_count, "job attempt count") !==
            input.guard.attemptNumber
        ) {
          // EXIT: the ledger row this guard names is missing, no longer
          // running, or carries a different token or attempt number. The screen
          // throws `lease_lost` so a settled, reclaimed or superseded attempt
          // cannot publish candidates or readiness. This is the same ownership
          // test the publication switch applies, in the same order.
          throw new StructuredScopeError(
            "lease_lost",
            "maintenance attempt no longer owns its job"
          );
        }
        const attempt = await client.query(
          `SELECT finished_at FROM maintenance_job_attempts
            WHERE job_key = $1 AND attempt_number = $2 AND fencing_token = $3
            FOR UPDATE`,
          [
            input.guard.jobKey,
            input.guard.attemptNumber,
            input.guard.fencingToken,
          ]
        );
        if (attempt.rows.length === 0) {
          // EXIT: the attempt history row is gone. The screen throws
          // `backend_unavailable` rather than treating a missing history row as
          // an open attempt.
          throw new StructuredScopeError(
            "backend_unavailable",
            "maintenance attempt history row is missing"
          );
        }
        const finishedAt = (attempt.rows[0] as { finished_at?: Date | string | null })
          .finished_at;
        const actualGuard = guardFromRow(row);
        const scheduled = parseDependencies(row.input_dependencies);
        const live = await readLiveDependencies(
          client,
          input.context.ownerScopeBinding,
          scheduled
        );
        // The config/ruleset revision the attempt is bound to is read from the
        // initiating source's own current row, not copied from the job. Reading
        // it from the job would make the comparison self-fulfilling: a source
        // re-declared under a new config revision after this attempt was
        // scheduled would still match, and the screen would publish evidence
        // bound to a config that no longer serves this source.
        const initiating = live.find(
          (entry) =>
            entry.dependency.sourceRef === actualGuard.sourceRef &&
            entry.dependency.generation === actualGuard.sourceGeneration
        );
        const liveInputs: MaintenanceLiveInputs = {
          configRevision:
            initiating?.configRevision ?? actualGuard.configRevision,
          dependencies: live.map((entry) => entry.dependency),
        };
        const verdict = screenFenceVerdict({
          actualGuard,
          presentedToken: input.guard.fencingToken,
          jobStatus: row.status,
          attemptFinished: finishedAt !== null && finishedAt !== undefined,
          liveInputs,
          now,
        });
        if (!verdict.ok) {
          // EXIT: the fence refused this attempt. The refusal carries the fence's
          // own code unchanged — a `lease_lost` masked as anything else would
          // lose the verdict the caller branches on — and the unit of work rolls
          // back, so no check row, candidate row or revision advance survives it.
          throw new StructuredScopeError(
            scopeFailureCodeOf(verdict.code),
            fenceMessageOf(verdict.code)
          );
        }
        if (finishedAt !== null && finishedAt !== undefined) {
          // EXIT: the attempt's history row is already settled while its job row
          // still reads running. The screen throws `lease_lost` so the settled
          // attempt cannot publish on the job row alone.
          throw new StructuredScopeError(
            "lease_lost",
            "maintenance attempt has already settled"
          );
        }
        if (Date.parse(input.context.deadlineAt) <= now.getTime()) {
          // EXIT: the run's own absolute deadline passed inside the transaction.
          // The screen throws `execution_timeout` so an overrunning run refuses
          // rather than committing evidence past its bound.
          throw new StructuredScopeError(
            "execution_timeout",
            "the authorized run outlived its absolute deadline"
          );
        }
        if (
          actualGuard.attemptStartedAt !== input.guard.attemptStartedAt ||
          actualGuard.inputRevision !== input.guard.inputRevision
        ) {
          // EXIT: the presented guard disagrees with the ledger row it names.
          // The screen throws `input_stale` rather than screening against a
          // guard the worker does not actually hold.
          throw new StructuredScopeError(
            "input_stale",
            "maintenance attempt guard no longer matches its job"
          );
        }

        const sourceRefs = [
          ...new Set(scheduled.map((dependency) => dependency.sourceRef)),
        ].sort();
        const assertions = await readAcceptedAssertions(
          client,
          input.context.ownerScopeBinding,
          sourceRefs,
          input.relationBuckets
        );
        if (
          input.maxAssertions !== undefined &&
          assertions.length > input.maxAssertions
        ) {
          // EXIT: the accepted assertion set exceeds the caller-supplied
          // ceiling. The screen throws `resource_exhausted` before writing the
          // check row, so no partial candidate set becomes ready.
          throw new StructuredScopeError(
            "resource_exhausted",
            `structural screen read ${assertions.length} assertions, above the supplied limit of ${input.maxAssertions}`
          );
        }
        const selection = selectStructuralAlternatives(assertions, {
          version: input.relationCatalogVersion,
          entries: input.relationCatalogEntries,
        });
        const checkId = randomUUID();
        const publishedAt = now.toISOString();
        const candidates = selection.alternatives.flatMap((alternative) =>
          toStructuralCandidates(alternative, {
            checkId,
            inputRevision: actualGuard.inputRevision,
            relationCatalogVersion: input.relationCatalogVersion,
            publishedAt,
          })
        );
        await client.query(
          `INSERT INTO structured_screening_checks
             (check_id, scope_binding, job_key, source_ref, ruleset_revision,
              coverage, relation_catalog_version, relation_buckets,
              input_revision, assertion_count, candidate_count, published_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)`,
          [
            checkId,
            input.context.ownerScopeBinding,
            actualGuard.jobKey,
            actualGuard.sourceRef,
            SCREENING_RULESET_REVISION,
            SCREENING_COVERAGE,
            input.relationCatalogVersion,
            JSON.stringify(input.relationBuckets),
            actualGuard.inputRevision,
            assertions.length,
            candidates.length,
            publishedAt,
          ]
        );
        await insertCandidates(
          client,
          input.context.ownerScopeBinding,
          checkId,
          candidates
        );
        work.bumpRevisions({ read: false, maintenance: true });
        return {
          check: {
            checkId,
            scopeBinding: input.context.ownerScopeBinding,
            jobKey: actualGuard.jobKey,
            sourceRef: actualGuard.sourceRef,
            rulesetRevision: SCREENING_RULESET_REVISION,
            coverage: SCREENING_COVERAGE,
            relationCatalogVersion: input.relationCatalogVersion,
            relationBuckets: input.relationBuckets,
            inputRevision: actualGuard.inputRevision,
            assertionCount: assertions.length,
            candidateCount: candidates.length,
            publishedAt,
          },
          candidates,
          nonCandidates: selection.nonCandidates,
        };
      },
      input.additionalSourceRefs === undefined
        ? undefined
        : { additionalSourceRefs: input.additionalSourceRefs }
    );
  }

  /** The candidates this scope has published, newest check first. */
  async readCandidates(
    client: AuthorizedScopeWork["client"],
    scopeBinding: string,
    relationNorm?: string
  ): Promise<PersistedCandidate[]> {
    const { rows } = await client.query(
      `SELECT candidate_id, check_id, head_entity_id, relation_norm,
              assertion_ids, tail_entity_ids, support_ids,
              uncertainty_lower, uncertainty_upper, uncertainty_reason
         FROM structured_screening_candidates
        WHERE scope_binding = $1
          AND ($2::text IS NULL OR relation_norm = $2)
        ORDER BY published_at DESC, candidate_id`,
      [scopeBinding, relationNorm ?? null]
    );
    return rows.map((row) => {
      const candidate = row as {
        candidate_id: string;
        check_id: string;
        head_entity_id: string;
        relation_norm: string;
        assertion_ids: string[];
        tail_entity_ids: string[];
        support_ids: string[];
        uncertainty_lower: boolean;
        uncertainty_upper: boolean;
        uncertainty_reason: string;
      };
      return {
        candidateId: candidate.candidate_id,
        checkId: candidate.check_id,
        headEntityId: candidate.head_entity_id,
        relationNorm: candidate.relation_norm,
        assertionIds: candidate.assertion_ids,
        tailEntityIds: candidate.tail_entity_ids,
        supportIds: candidate.support_ids,
        uncertaintyReason: candidate.uncertainty_reason,
        unboundedLower: candidate.uncertainty_lower,
        unboundedUpper: candidate.uncertainty_upper,
      };
    });
  }
}
