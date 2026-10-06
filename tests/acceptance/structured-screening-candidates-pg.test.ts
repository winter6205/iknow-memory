/**
 * The strict PostgreSQL lane of the structural screening contract.
 *
 * Every case runs against the real database: the real shared scope unit of
 * work, the real durable-work ledger, the real publication adapter and the
 * screening tables this lane's own DDL creates. The driver never skips — an
 * absent marker, an absent DSN and an unreachable database are each named
 * non-zero failures, and a refused case is proven from a separate connection so
 * no partial commit can hide behind the transaction that refused.
 */
import { createHash } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  claimNextWork,
  scheduleWork,
  settleWork,
} from "../../src/core/maintenance/service.js";
import { WORK_ABSOLUTE_LIMIT_MS } from "../../src/core/maintenance/types.js";
import type {
  MaintenanceAttemptGuard,
  MaintenanceDependency,
  MaintenanceWorkKind,
  MaintenanceWorkStore,
} from "../../src/core/maintenance/types.js";
import type {
  PublicationFact,
  StructuredPublicationStorage,
} from "../../src/core/maintenance/publication-types.js";
import {
  deriveRelationAssertionId,
  normalizeRelationAssertion,
} from "../../src/core/structured/identity.js";
import { PgMaintenanceWorkStore } from "../../src/core/storage/maintenance-work-pg.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { PgScreeningStorage } from "../../src/core/storage/screening-pg.js";
import { upSchemaScreening } from "../../src/core/storage/schema-screening.js";
import type {
  AuthorizedScopeContext,
  AuthorizedScopeUnitOfWork,
} from "../../src/core/storage/structured-scope-types.js";
import {
  createPublicationTestClock,
  type PublicationTestClock,
} from "../storage/publication-contract.js";
import {
  describeScreeningContract,
  type ScreeningTestPort,
} from "../storage/screening-contract.js";
import {
  openStrictPgDriver,
  requireFullyRunnable,
  type NotRunCase,
} from "./strict-pg-driver.js";

const EXPECTED_COMMAND =
  "STRUCTURED_SCREENING_CANDIDATES_PG=1 GRAPHRAG_MEMORY_DB_URL=<isolated-development-dsn> npx vitest run tests/acceptance/structured-screening-candidates-pg.test.ts";
const SCHEMA_PREFIX = "structured_screening_candidates";
const DIMENSIONS = 8;
const ACTOR = "screening-candidates-trusted-owner";
const CONFIG_REVISION = "extractor-v1";
const AUTHORIZATION_REVISION = "auth-screening-pg-1";
const DRAIN_LIMIT = 64;

const HEAD = "00000000-0000-4000-8000-000000000401";
const TAILS = [
  "00000000-0000-4000-8000-000000000501",
  "00000000-0000-4000-8000-000000000502",
] as const;

const driver = await openStrictPgDriver({
  envName: "STRUCTURED_SCREENING_CANDIDATES_PG",
  testPath: "tests/acceptance/structured-screening-candidates-pg.test.ts",
  expectedCommand: EXPECTED_COMMAND,
  label: "structured-screening-candidates-pg",
  schemaPrefix: SCHEMA_PREFIX,
  dependency: "real PostgreSQL with pgvector",
});

const SCHEMA_URL = driver.schemaConnectionString;

let admin: pg.Client;
let backend: PgvectorBackend;
let pool: pg.Pool;
let publication: StructuredPublicationStorage;
let work: MaintenanceWorkStore;
let screening: PgScreeningStorage;
let authority: AuthorizedScopeUnitOfWork;
let clock: PublicationTestClock;
let serial = 0;

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

function opaqueDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type Bound = string | null;

interface Shape {
  readonly intervals: readonly { readonly from: Bound; readonly until: Bound }[];
  readonly tails: readonly string[];
}

const SHAPES: Record<string, Shape> = {
  identical: {
    intervals: [
      { from: "2020-01-01T00:00:00.000Z", until: "2025-01-01T00:00:00.000Z" },
      { from: "2020-01-01T00:00:00.000Z", until: "2025-01-01T00:00:00.000Z" },
    ],
    tails: [TAILS[0]!, TAILS[0]!],
  },
  adjacent: {
    intervals: [
      { from: "2020-01-01T00:00:00.000Z", until: "2025-01-01T00:00:00.000Z" },
      { from: "2025-01-01T00:00:00.000Z", until: "2030-01-01T00:00:00.000Z" },
    ],
    tails: [TAILS[0]!, TAILS[1]!],
  },
  disjoint: {
    intervals: [
      { from: "2000-01-01T00:00:00.000Z", until: "2001-01-01T00:00:00.000Z" },
      { from: "2020-01-01T00:00:00.000Z", until: "2021-01-01T00:00:00.000Z" },
    ],
    tails: [TAILS[0]!, TAILS[1]!],
  },
  unbounded: {
    intervals: [
      { from: null, until: null },
      { from: null, until: null },
    ],
    tails: [TAILS[0]!, TAILS[1]!],
  },
  overlapping: {
    intervals: [
      { from: "2020-01-01T00:00:00.000Z", until: "2025-01-01T00:00:00.000Z" },
      { from: "2022-01-01T00:00:00.000Z", until: "2027-01-01T00:00:00.000Z" },
    ],
    tails: [TAILS[0]!, TAILS[1]!],
  },
};

function shapeFor(label: string): Shape {
  if (label.startsWith("sc02")) return SHAPES.unbounded!;
  if (label.startsWith("sc04")) return SHAPES.identical!;
  if (label.startsWith("sc05")) return SHAPES.identical!;
  if (label.startsWith("sc06-adjacent")) return SHAPES.adjacent!;
  if (label.startsWith("sc06-disjoint")) return SHAPES.disjoint!;
  if (label.startsWith("sc06-overlapping")) return SHAPES.overlapping!;
  return SHAPES.overlapping!;
}

/**
 * The relation-assertion identities reference `entities`, so the canonical
 * entity rows are seeded directly rather than as chunks; a screening fixture
 * needs the identity, not the vector index.
 */
async function seedGraphEntities(entityIds: readonly string[]): Promise<void> {
  for (const entityId of entityIds) {
    await pool.query(
      `INSERT INTO entities (id, canonical_name, type, embedding, metadata, retired)
         VALUES ($1, $2, 'organization', NULL, '{}'::jsonb, false)
       ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type`,
      [entityId, `screening pg fixture entity ${entityId}`]
    );
  }
}

async function claimOwnAttempt(input: {
  readonly workKind: MaintenanceWorkKind;
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly generation: number;
  readonly dependencies: readonly MaintenanceDependency[];
}): Promise<MaintenanceAttemptGuard> {
  const deps = { store: work, clock: () => clock() };
  const scheduled = await scheduleWork(
    deps,
    { actorId: ACTOR },
    {
      workKind: input.workKind,
      sourceRef: input.sourceRef,
      sourceVersion: input.sourceVersion,
      sourceGeneration: input.generation,
      configRevision: CONFIG_REVISION,
      dependencies: input.dependencies,
    }
  );
  if ("refused" in scheduled) {
    throw new Error(
      `screening pg fixture schedule refused: ${scheduled.refused}`
    );
  }
  for (let attempt = 0; attempt < DRAIN_LIMIT; attempt += 1) {
    const claimed = await claimNextWork(deps);
    const guard = claimed.guard;
    if (guard === null) break;
    if (guard.jobKey === scheduled.record.jobKey) return guard;
    await settleWork(deps, guard, { status: "failed", failureCode: "input_stale" }, {
      configRevision: CONFIG_REVISION,
      dependencies: input.dependencies,
    });
  }
  throw new Error("screening pg fixture could not claim its own job");
}

/** A second connection, so a rollback claim is never read through the transaction that refused. */
async function withObserver<R>(
  action: (observer: pg.Client) => Promise<R>
): Promise<R> {
  const observer = new pg.Client({ connectionString: SCHEMA_URL });
  await observer.connect();
  try {
    return await action(observer);
  } finally {
    await observer.end();
  }
}

async function countRows(table: string, scopeBinding: string): Promise<number> {
  return withObserver(async (observer) => {
    const { rows } = await observer.query(
      `SELECT count(*)::bigint AS total FROM ${table} WHERE scope_binding = $1`,
      [scopeBinding]
    );
    return Number((rows[0] as { total: string }).total);
  });
}

interface SeededScope {
  readonly context: AuthorizedScopeContext;
  readonly guard: MaintenanceAttemptGuard;
  readonly scopeBinding: string;
  readonly sources: readonly string[];
  readonly sourceRef: string;
  readonly dependentRef: string;
  readonly generation: number;
}

async function seedScope(label: string): Promise<SeededScope> {
  const shape = shapeFor(label);
  const scopeBinding = unique(`screening-pg-scope-${label}`);
  const sourceRef = unique(`${label}-source`);
  await seedGraphEntities([HEAD, ...TAILS]);
  const { record } = await backend.registerSourceVersion({
    source_ref: sourceRef,
    source_version: "v1",
    content_digest: opaqueDigest(`${sourceRef}:v1`),
    origin_object_ref: `objects/${sourceRef}/v1.html`,
    parser_revision: "frozen-html-units-v1",
    unit_manifest: { units: 2, parser_revision: "frozen-html-units-v1" },
    created_at: clock().toISOString(),
    retired_at: null,
    payload_collected_at: null,
    obligations_stopped_at: null,
  });
  const locatorBindings = [1, 2].map((unit) => ({
    source_version_id: record.source_version_id,
    document_id: `${sourceRef}-document`,
    version: "frozen-v1",
    unit,
  }));
  for (const binding of locatorBindings) await backend.bindSourceLocator(binding);
  await backend.setScopeRevisions(scopeBinding, {
    authorizationRevision: AUTHORIZATION_REVISION,
    purgeRevision: "purge-1",
  });
  const declared = await publication.declareDesired({
    scopeBinding,
    authorizedSourceRefs: [sourceRef],
    sourceRef,
    sourceVersion: record,
    locatorBindings,
    desiredExtractionRevision: 1,
    configRevision: CONFIG_REVISION,
  });
  const generation = declared.generation;
  const facts: PublicationFact[] = shape.intervals.map((interval, index) => {
    const tailEntityId = shape.tails[index]!;
    const assertionId = deriveRelationAssertionId(
      normalizeRelationAssertion({
        headEntityId: HEAD,
        relationNorm: "has_chair",
        tailEntityId,
        validWindow: { from: interval.from, until: interval.until },
      })
    );
    return {
      identity: {
        kind: "relation_assertion",
        input: {
          headEntityId: HEAD,
          relationNorm: "has_chair",
          tailEntityId,
          validWindow: { from: interval.from, until: interval.until },
        },
      },
      occurrence: {
        subject: "assertion",
        result_id: assertionId,
        source_ref: sourceRef,
        source_version: "v1",
        location: {
          document_id: `${sourceRef}-document`,
          version: "frozen-v1",
          unit: index + 1,
        },
        extraction_ref: `screening-extraction-${label}`,
        extractedAt: record.created_at,
      },
    } as PublicationFact;
  });
  const publishDependencies: MaintenanceDependency[] = [
    { sourceRef, generation, extractionRevision: null, relationBuckets: [] },
  ];
  const publishGuard = await claimOwnAttempt({
    workKind: "extract_publish",
    sourceRef,
    sourceVersion: "v1",
    generation,
    dependencies: publishDependencies,
  });
  await publication.stageAttempt({
    scopeBinding,
    sourceRef,
    guard: publishGuard,
    extractionRef: `screening-extraction-${label}`,
    accepted: facts,
  });
  await publication.publish({
    scopeBinding,
    sourceRef,
    guard: publishGuard,
    at: clock().toISOString(),
  });
  await settleWork(
    { store: work, clock: () => clock() },
    publishGuard,
    { status: "ready" },
    { configRevision: CONFIG_REVISION, dependencies: publishDependencies }
  );
  const context = authority.createAuthorizedContext({
    actorId: ACTOR,
    ownerScopeBinding: scopeBinding,
    readerBinding: `${scopeBinding}-reader`,
    authorizedSourceRefs: [sourceRef],
    authorizationRevision: AUTHORIZATION_REVISION,
    deadlineAt: new Date(clock().getTime() + 10 * 60_000).toISOString(),
  });
  const dependentRef = unique(`${label}-dependent`);
  const dependentVersion = await backend.registerSourceVersion({
    source_ref: dependentRef,
    source_version: "v1",
    content_digest: opaqueDigest(`${dependentRef}:v1`),
    origin_object_ref: `objects/${dependentRef}/v1.html`,
    parser_revision: "frozen-html-units-v1",
    unit_manifest: { units: 1, parser_revision: "frozen-html-units-v1" },
    created_at: clock().toISOString(),
    retired_at: null,
    payload_collected_at: null,
    obligations_stopped_at: null,
  });
  const dependentLocators = [
    {
      source_version_id: dependentVersion.record.source_version_id,
      document_id: `${dependentRef}-document`,
      version: "frozen-v1",
      unit: 1,
    },
  ];
  for (const binding of dependentLocators) {
    await backend.bindSourceLocator(binding);
  }
  const dependentDeclared = await publication.declareDesired({
    scopeBinding,
    authorizedSourceRefs: [sourceRef, dependentRef],
    sourceRef: dependentRef,
    sourceVersion: dependentVersion.record,
    locatorBindings: dependentLocators,
    desiredExtractionRevision: 1,
    configRevision: CONFIG_REVISION,
  });
  const dependentDependencies: MaintenanceDependency[] = [
    {
      sourceRef: dependentRef,
      generation: dependentDeclared.generation,
      extractionRevision: null,
      relationBuckets: [],
    },
  ];
  const dependentGuard = await claimOwnAttempt({
    workKind: "extract_publish",
    sourceRef: dependentRef,
    sourceVersion: "v1",
    generation: dependentDeclared.generation,
    dependencies: dependentDependencies,
  });
  await publication.stageAttempt({
    scopeBinding,
    sourceRef: dependentRef,
    guard: dependentGuard,
    extractionRef: `screening-extraction-${label}-dependent`,
    accepted: [],
  });
  await publication.publish({
    scopeBinding,
    sourceRef: dependentRef,
    guard: dependentGuard,
    at: clock().toISOString(),
  });
  await settleWork(
    { store: work, clock: () => clock() },
    dependentGuard,
    { status: "ready" },
    { configRevision: CONFIG_REVISION, dependencies: dependentDependencies }
  );
  const guard = await claimOwnAttempt({
    workKind: "conflict_check",
    sourceRef,
    sourceVersion: "v1",
    generation,
    dependencies: [
      { sourceRef, generation, extractionRevision: 1, relationBuckets: ["has_chair"] },
      {
        sourceRef: dependentRef,
        generation: dependentDeclared.generation,
        extractionRevision: 1,
        relationBuckets: [],
      },
    ],
  });
  return {
    context,
    guard,
    scopeBinding,
    sources: [sourceRef, dependentRef],
    sourceRef,
    dependentRef,
    generation,
  };
}

async function openPgLane(): Promise<ScreeningTestPort> {
  const seeded: SeededScope[] = [];
  const movedGenerations = new Map<string, number>();
  const port: ScreeningTestPort = {
    label: "strict-pg",
    async stageScreen(input) {
      return screening.stageScreen({ ...input });
    },
    async startAttempt(label, options = {}) {
      if (options.advanceMs !== undefined) clock.advance(options.advanceMs);
      const scope = await seedScope(label);
      seeded.push(scope);
      return {
        context: scope.context,
        guard: scope.guard,
        scopeBinding: scope.scopeBinding,
        sources: scope.sources,
      };
    },
    acceptedAssertions(label) {
      const shape = shapeFor(label);
      return shape.intervals.map((interval, index) => {
        const tailEntityId = shape.tails[index]!;
        return {
          headEntityId: HEAD,
          relationNorm: "has_chair",
          tailEntityId,
          interval: { lower: interval.from, upper: interval.until },
          assertionId: deriveRelationAssertionId(
            normalizeRelationAssertion({
              headEntityId: HEAD,
              relationNorm: "has_chair",
              tailEntityId,
              validWindow: { from: interval.from, until: interval.until },
            })
          ),
          supportIds: [
            `00000000-0000-4000-8000-0000000009${String(index + 1).padStart(2, "0")}`,
          ],
          extractionRef: `screening-extraction-${label}`,
          extractionRevision: 1,
          inputRevision: `input-revision-${label}`,
        };
      });
    },
    staleTokenGuard() {
      const last = seeded[seeded.length - 1];
      return { ...last!.guard, fencingToken: `${last!.guard.fencingToken}-stale` };
    },
    async expireLease() {
      const last = seeded[seeded.length - 1];
      if (last === undefined) return;
      // PostgreSQL reads its own clock, so a lease is aged by back-dating the
      // committed lease stamp rather than by sleeping: the row ends up in the
      // state a genuinely expired lease leaves behind, and the case observes
      // the lease fence rather than the absolute-deadline fence.
      await pool.query(
        `UPDATE maintenance_jobs
            SET lease_expires_at = clock_timestamp() - interval '1 second',
                attempt_started_at = clock_timestamp() - interval '10 minutes'
          WHERE job_key = $1`,
        [last.guard.jobKey]
      );
    },
    async outliveAbsoluteDeadline() {
      const last = seeded[seeded.length - 1];
      if (last === undefined) return;
      // The attempt start is back-dated past the absolute bound while the lease
      // is pushed forward, so only the deadline fence is under test.
      await pool.query(
        `UPDATE maintenance_jobs
            SET attempt_started_at = clock_timestamp() - ($2::double precision * interval '1 millisecond'),
                lease_expires_at = clock_timestamp() + interval '1 hour'
          WHERE job_key = $1`,
        [last.guard.jobKey, WORK_ABSOLUTE_LIMIT_MS + 60_000]
      );
    },
    async moveConfigRevision() {
      const last = seeded[seeded.length - 1];
      if (last === undefined) return;
      // Re-declaring the source under a new config/ruleset revision moves the
      // revision the source's current row carries, which is what a screen bound
      // to the old revision must refuse.
      await pool.query(
        `UPDATE structured_publication_sources
            SET desired_config_revision = $3
          WHERE scope_binding = $1 AND source_ref = $2`,
        [last.scopeBinding, last.sourceRef, `${CONFIG_REVISION}-moved`]
      );
    },
    async moveDependentExtraction() {
      const last = seeded[seeded.length - 1];
      if (last === undefined) return;
      // Only the dependent source's published extraction revision moves. Its
      // generation, the initiating source and the guard are untouched, so only
      // the complete dependency-vector comparison can catch this.
      await pool.query(
        `UPDATE structured_publication_sources
            SET published_extraction_revision = 2
          WHERE scope_binding = $1 AND source_ref = $2`,
        [last.scopeBinding, last.dependentRef]
      );
    },
    async moveDependency() {
      const last = seeded[seeded.length - 1];
      if (last === undefined) return;
      const current = movedGenerations.get(last.scopeBinding) ?? last.generation;
      const next = current + 1;
      movedGenerations.set(last.scopeBinding, next);
      await pool.query(
        `UPDATE structured_publication_sources
            SET generation = $3
          WHERE scope_binding = $1 AND source_ref = $2`,
        [last.scopeBinding, last.sourceRef, next]
      );
    },
    wrongWorkKindGuard() {
      const last = seeded[seeded.length - 1];
      return { ...last!.guard, workKind: "extract_publish" };
    },
    async readCandidates(scopeBinding) {
      return withObserver(async (observer) => {
        const { rows } = await observer.query(
          `SELECT candidate_id, tail_entity_ids, uncertainty_reason,
                  uncertainty_lower, uncertainty_upper, support_ids, assertion_ids
             FROM structured_screening_candidates
            WHERE scope_binding = $1
            ORDER BY candidate_id`,
          [scopeBinding]
        );
        return rows.map((row) => {
          const candidate = row as {
            candidate_id: string;
            tail_entity_ids: string[];
            uncertainty_reason: string;
            uncertainty_lower: boolean;
            uncertainty_upper: boolean;
            support_ids: string[];
            assertion_ids: string[];
          };
          return {
            candidateId: candidate.candidate_id,
            tailEntityIds: candidate.tail_entity_ids,
            uncertaintyReason: candidate.uncertainty_reason,
            unboundedLower: candidate.uncertainty_lower,
            unboundedUpper: candidate.uncertainty_upper,
            supportIds: candidate.support_ids,
            assertionIds: candidate.assertion_ids,
          };
        });
      });
    },
    async readCheckCount(scopeBinding) {
      return countRows("structured_screening_checks", scopeBinding);
    },
  };
  return port;
}

// EXIT: the backend composition supplies neither the publication adapter nor
// the shared scope authority. The module load throws before any harness or
// schema exists, so no case can publish through a storage surface composition
// does not own.
admin = driver.harness.createClient(SCHEMA_URL);
await admin.connect();
await driver.harness.resetSchema(admin);
backend = new PgvectorBackend(SCHEMA_URL, DIMENSIONS, { annMaxDimensions: 2000 });
await backend.initialize();
pool = new pg.Pool({ connectionString: SCHEMA_URL, max: 4 });
clock = createPublicationTestClock(new Date());
await upSchemaScreening(pool);
const composed = backend as PgvectorBackend & {
  structuredPublication?: StructuredPublicationStorage;
  structuredScopeUnitOfWork?: AuthorizedScopeUnitOfWork;
};
if (!composed.structuredPublication || !composed.structuredScopeUnitOfWork) {
  throw new Error(
    "PgvectorBackend composition must supply the structured publication storage and the shared scope unit of work this lane drives"
  );
}
publication = composed.structuredPublication;
authority = composed.structuredScopeUnitOfWork;
screening = new PgScreeningStorage(composed.structuredScopeUnitOfWork);
work = new PgMaintenanceWorkStore(pool);

const NOT_RUN: NotRunCase = {
  caseId: "screening-candidates-pg",
  expectedCommand: EXPECTED_COMMAND,
  owner: "T15",
  entries: [],
};

describe("screening candidate persistence — strict PostgreSQL lane", () => {
  // Every case below ran against the real database; this suite exists so a lane
  // that silently skipped would still report a named failure.
  it("reached the real PostgreSQL lane", () => {
    expect(pool.totalCount).toBeGreaterThan(0);
  });
});

describeScreeningContract(openPgLane);


describe("screening persistence transaction property", () => {
  it("commits the check and every candidate together, so a separate connection never sees half a result", async () => {
    const scope = await seedScope("atomic-commit");
    const outcome = await screening.stageScreen({
      context: scope.context,
      guard: scope.guard,
      relationBuckets: ["has_chair"],
      relationCatalogVersion: 0,
      relationCatalogEntries: [],
    });
    expect(outcome.candidates).toHaveLength(1);
    // A fresh connection sees the check row and its candidate together, which
    // is only possible if both were written by one transaction.
    const observed = await withObserver(async (observer) => {
      const checks = await observer.query(
        `SELECT count(*)::bigint AS total FROM structured_screening_checks WHERE scope_binding = $1`,
        [scope.scopeBinding]
      );
      const candidates = await observer.query(
        `SELECT count(*)::bigint AS total FROM structured_screening_candidates WHERE scope_binding = $1`,
        [scope.scopeBinding]
      );
      return {
        checks: Number((checks.rows[0] as { total: string }).total),
        candidates: Number((candidates.rows[0] as { total: string }).total),
      };
    });
    expect(observed.checks).toBe(1);
    expect(observed.candidates).toBe(outcome.candidates.length);
  });

  it("leaves no check and no candidate behind when the resource limit refuses the whole check", async () => {
    const scope = await seedScope("atomic-refusal");
    await expect(
      screening.stageScreen({
        context: scope.context,
        guard: scope.guard,
        relationBuckets: ["has_chair"],
        relationCatalogVersion: 0,
        relationCatalogEntries: [],
        maxAssertions: 1,
      })
    ).rejects.toMatchObject({ code: "resource_exhausted" });
    expect(await countRows("structured_screening_checks", scope.scopeBinding)).toBe(0);
    expect(await countRows("structured_screening_candidates", scope.scopeBinding)).toBe(0);
  });

  it("keeps a refusal from changing the scope's maintenance revision", async () => {
    const scope = await seedScope("atomic-revision");
    const revisionOf = async (): Promise<number> => {
      const value = await withObserver(async (observer) => {
        const { rows } = await observer.query(
          `SELECT maintenance_revision FROM structured_publication_scopes WHERE scope_binding = $1`,
          [scope.scopeBinding]
        );
        return Number((rows[0] as { maintenance_revision: string }).maintenance_revision);
      });
      return value;
    };
    const before = await revisionOf();
    await expect(
      screening.stageScreen({
        context: scope.context,
        guard: { ...scope.guard, fencingToken: `${scope.guard.fencingToken}-stale` },
        relationBuckets: ["has_chair"],
        relationCatalogVersion: 0,
        relationCatalogEntries: [],
      })
    ).rejects.toMatchObject({ code: "lease_lost" });
    expect(await revisionOf()).toBe(before);
  });
});

describe("strict PostgreSQL reporting contract", () => {
  afterAll(async () => {
    try {
      if (!driver.schema.startsWith(`${SCHEMA_PREFIX}_`)) {
        // EXIT: the teardown reached a schema this run's own prefix does not
        // name. It refuses and the schema survives, so a schema this run never
        // created is never dropped as if it had.
        throw new Error(
          `refusing to drop a schema outside this run's prefix: ${driver.schema}`
        );
      }
      await driver.dropOwnSchema(admin);
    } finally {
      await pool?.end();
      await backend?.close();
      await admin?.end();
    }
  });

  it("names no absent claim: every lane case ran against the real database", () => {
    requireFullyRunnable(NOT_RUN);
    expect(NOT_RUN.entries).toEqual([]);
  });
});

