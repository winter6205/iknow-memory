/**
 * The strict PostgreSQL lane of the MP11 projection-rebuild contract.
 *
 * Every case runs against the real database: the real shared scope unit of
 * work, the real durable-work ledger, the real publication adapter, the real
 * projection outbox and the real derived-generation table. The driver never
 * skips — an absent marker, an absent DSN and an unreachable database are each
 * named non-zero failures.
 *
 * The residue cases observe from a SEPARATE connection, so no partial commit can
 * hide behind the reader.
 */
import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  claimNextWork,
  scheduleWork,
  settleWork,
} from "../../src/core/maintenance/service.js";
import type {
  MaintenanceAttemptGuard,
  MaintenanceDependency,
  MaintenanceWorkStore,
} from "../../src/core/maintenance/types.js";
import type { PublicationFact } from "../../src/core/maintenance/publication-types.js";
import {
  deriveRelationAssertionId,
  normalizeRelationAssertion,
} from "../../src/core/structured/identity.js";
import { PgMaintenanceWorkStore } from "../../src/core/storage/maintenance-work-pg.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { PgProjectionRebuildStorage } from "../../src/core/storage/projection-rebuild-pg.js";
import type {
  AuthorizedScopeContext,
  AuthorizedScopeUnitOfWork,
  ScopeTransactionOwner,
} from "../../src/core/storage/structured-scope-types.js";
import { createPublicationTestClock } from "../storage/publication-contract.js";
import {
  describeProjectionRebuildContract,
  type DerivedProjectionObservation,
  type ProjectionRebuildScope,
  type StableHistoryFingerprint,
} from "../storage/projection-rebuild-contract.js";
import {
  openStrictPgDriver,
  requireFullyRunnable,
  type NotRunCase,
} from "./strict-pg-driver.js";

const EXPECTED_COMMAND =
  "STRUCTURED_PROJECTION_REBUILD_PG=1 GRAPHRAG_MEMORY_DB_URL=<isolated-development-dsn> npx vitest run tests/acceptance/projection-rebuild-pg.test.ts";
const SCHEMA_PREFIX = "structured_projection_rebuild";
const DIMENSIONS = 8;
const ACTOR = "rebuild-pg-trusted-owner";
const AUTHORIZATION_REVISION = "auth-rebuild-pg-1";
const PURGE_REVISION = "purge-1";
const CONFIG_REVISION = "extractor-v1";
const RELATION = "has_chair";
const HEAD = "00000000-0000-4000-8000-000000000801";
const TAILS = [
  "00000000-0000-4000-8000-000000000811",
  "00000000-0000-4000-8000-000000000812",
] as const;

const driver = await openStrictPgDriver({
  envName: "STRUCTURED_PROJECTION_REBUILD_PG",
  testPath: "tests/acceptance/projection-rebuild-pg.test.ts",
  expectedCommand: EXPECTED_COMMAND,
  label: "structured-projection-rebuild-pg",
  schemaPrefix: SCHEMA_PREFIX,
  dependency: "real PostgreSQL with pgvector",
});

const SCHEMA_URL = driver.schemaConnectionString;

let admin: pg.Client;
let backend: PgvectorBackend;
let pool: pg.Pool;
let work: MaintenanceWorkStore;
let rebuild: PgProjectionRebuildStorage;
let authority: AuthorizedScopeUnitOfWork & ScopeTransactionOwner;
let clock: ReturnType<typeof createPublicationTestClock>;
let serial = 0;

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

function opaqueDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A separate connection, so an observation cannot share a failed transaction. */
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

function contextFor(
  scopeBinding: string,
  sourceRefs: readonly string[]
): AuthorizedScopeContext {
  return authority.createAuthorizedContext({
    actorId: ACTOR,
    ownerScopeBinding: scopeBinding,
    readerBinding: `${scopeBinding}-reader`,
    authorizedSourceRefs: sourceRefs,
    authorizationRevision: AUTHORIZATION_REVISION,
    deadlineAt: new Date(clock().getTime() + 10 * 60_000).toISOString(),
  });
}

async function registerVersion(
  sourceRef: string,
  version: string,
  units: number
): Promise<{ readonly record: any; readonly locators: readonly any[] }> {
  const { record } = await backend.registerSourceVersion({
    source_ref: sourceRef,
    source_version: version,
    content_digest: opaqueDigest(`${sourceRef}:${version}`),
    origin_object_ref: `objects/${sourceRef}/${version}.html`,
    parser_revision: "frozen-html-units-v1",
    unit_manifest: { units, parser_revision: "frozen-html-units-v1" },
    created_at: clock().toISOString(),
    retired_at: null,
    payload_collected_at: null,
    obligations_stopped_at: null,
  });
  const locatorBindings = Array.from({ length: units }, (_, index) => ({
    source_version_id: record.source_version_id,
    document_id: `${sourceRef}-document`,
    version: `frozen-${version}`,
    unit: index + 1,
  }));
  for (const binding of locatorBindings) await backend.bindSourceLocator(binding);
  return { record, locators: locatorBindings };
}

async function declare(
  scopeBinding: string,
  sourceRef: string,
  version: string,
  authorizedSourceRefs: readonly string[],
  extractionRevision: number,
  units: number = 2
): Promise<number> {
  const { record, locators } = await registerVersion(sourceRef, version, units);
  const declared = await backend.structuredPublication.declareDesired({
    scopeBinding,
    authorizedSourceRefs,
    sourceRef,
    sourceVersion: record,
    locatorBindings: locators,
    desiredExtractionRevision: extractionRevision,
    configRevision: CONFIG_REVISION,
  });
  return declared.generation;
}

function dependenciesFor(
  sourceRef: string,
  generation: number,
  extractionRevision: number | null
): readonly MaintenanceDependency[] {
  return [
    { sourceRef, generation, extractionRevision, relationBuckets: [] },
  ];
}

async function claimOwnAttempt(input: {
  readonly workKind: "extract_publish" | "projection_rebuild";
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly generation: number;
  readonly extractionRevision: number | null;
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
      dependencies: dependenciesFor(
        input.sourceRef,
        input.generation,
        input.extractionRevision
      ),
    }
  );
  if ("refused" in scheduled) {
    // EXIT: the fixture could not schedule the attempt a case needs. It throws
    // naming the refusal, so no case runs on an unscheduled job.
    throw new Error(`rebuild pg fixture schedule refused: ${scheduled.refused}`);
  }
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const claimed = await claimNextWork(deps);
    if (claimed.guard === null) break;
    if (claimed.guard.jobKey === scheduled.record.jobKey) return claimed.guard;
    // EXIT: the claim queue offered a foreign job first, which this lane cannot
    // release back to pending. The fixture throws instead of settling a foreign
    // job into a state the case did not arrange.
    throw new Error(
      `rebuild pg fixture claimed a foreign job first: ${claimed.guard.jobKey}`
    );
  }
  // EXIT: the durable-work queue drained without ever offering the job this
  // fixture scheduled, so no case would run against an attempt nobody claimed.
  throw new Error("rebuild pg fixture could not claim its own job");
}

async function settle(
  guard: MaintenanceAttemptGuard,
  dependencies: readonly MaintenanceDependency[]
): Promise<void> {
  const outcome = await settleWork(
    { store: work, clock: () => clock() },
    guard,
    { status: "ready" },
    { configRevision: CONFIG_REVISION, dependencies }
  );
  if ("refused" in outcome && outcome.refused !== undefined) {
    // EXIT: settling a fixture attempt was refused, so the ledger state a later
    // claim depends on is not what the fixture arranged.
    throw new Error(`rebuild pg fixture settle refused: ${outcome.refused}`);
  }
}

function relationFacts(
  sourceRef: string,
  extractionRef: string,
  version: string
): PublicationFact[] {
  const intervals = [
    { from: "2020-01-01T00:00:00.000Z", until: "2025-01-01T00:00:00.000Z" },
    { from: "2022-01-01T00:00:00.000Z", until: "2027-01-01T00:00:00.000Z" },
  ];
  return intervals.map((interval, index) => ({
    identity: {
      kind: "relation_assertion",
      input: {
        headEntityId: HEAD,
        relationNorm: RELATION,
        tailEntityId: TAILS[index]!,
        validWindow: { from: interval.from, until: interval.until },
      },
    },
    occurrence: {
      subject: "assertion",
      result_id: deriveRelationAssertionId(
        normalizeRelationAssertion({
          headEntityId: HEAD,
          relationNorm: RELATION,
          tailEntityId: TAILS[index]!,
          validWindow: { from: interval.from, until: interval.until },
        })
      ),
      source_ref: sourceRef,
      source_version: version,
      location: {
        document_id: `${sourceRef}-document`,
        version: `frozen-${version}`,
        unit: index + 1,
      },
      extraction_ref: extractionRef,
      extractedAt: clock().toISOString(),
    },
  })) as unknown as PublicationFact[];
}

async function publishVersion(input: {
  readonly scopeBinding: string;
  readonly sourceRef: string;
  readonly version: string;
  readonly generation: number;
  readonly extractionRevision: number;
  readonly liveRevision: number | null;
  readonly extractionRef: string;
}): Promise<void> {
  const guard = await claimOwnAttempt({
    workKind: "extract_publish",
    sourceRef: input.sourceRef,
    sourceVersion: input.version,
    generation: input.generation,
    extractionRevision: input.liveRevision,
  });
  await backend.structuredPublication.stageAttempt({
    scopeBinding: input.scopeBinding,
    sourceRef: input.sourceRef,
    guard,
    extractionRef: input.extractionRef,
    accepted: relationFacts(
      input.sourceRef,
      input.extractionRef,
      input.version
    ),
  });
  await backend.structuredPublication.publish({
    scopeBinding: input.scopeBinding,
    sourceRef: input.sourceRef,
    guard,
    at: clock().toISOString(),
  });
  await settle(
    guard,
    dependenciesFor(input.sourceRef, input.generation, input.liveRevision)
  );
}

async function seedGraphEntities(): Promise<void> {
  // The relation-assertion identity FKs to the entity registry, so the head and
  // tail entities must exist before a publication can register an assertion
  // identity. Every case shares these rows; they are corpus, not fixture state.
  for (const entityId of [HEAD, ...TAILS]) {
    await pool.query(
      `INSERT INTO entities (id, canonical_name, type, embedding, metadata, retired)
         VALUES ($1, $2, 'organization', NULL, '{}'::jsonb, false)
       ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type`,
      [entityId, `rebuild fixture entity ${entityId}`]
    );
  }
}

async function seedScope(label: string): Promise<ProjectionRebuildScope> {
  await seedGraphEntities();
  const scopeBinding = unique(`rebuild-pg-${label}`);
  const sourceRef = unique(`rebuild-pg-src-${label}`);
  await backend.setScopeRevisions(scopeBinding, {
    authorizationRevision: AUTHORIZATION_REVISION,
    purgeRevision: PURGE_REVISION,
  });
  const generation = await declare(
    scopeBinding,
    sourceRef,
    "v1",
    [sourceRef],
    1
  );
  await publishVersion({
    scopeBinding,
    sourceRef,
    version: "v1",
    generation,
    extractionRevision: 1,
    liveRevision: null,
    extractionRef: `${sourceRef}-extraction-v1-1`,
  });
  return {
    context: contextFor(scopeBinding, [sourceRef]),
    scopeBinding,
    sourceRef,
    generation,
    dependencies: dependenciesFor(sourceRef, generation, 1),
  };
}

/**
 * Every stable-history row the Inherits clause names, read from one observer
 * connection. Field-named so a diff says WHICH kind of history moved.
 */
async function fingerprintFrom(
  observer: pg.Client,
  scope: ProjectionRebuildScope
): Promise<StableHistoryFingerprint> {
  const versions = await observer.query(
    `SELECT source_version_id, source_ref, source_version
       FROM source_versions WHERE source_ref = $1 ORDER BY source_version`,
    [scope.sourceRef]
  );
  const entities = await observer.query(
    `SELECT entity_id FROM structured_entity_identities ORDER BY entity_id`
  );
  const assertions = await observer.query(
    `SELECT assertion_id FROM structured_relation_assertion_identities
      ORDER BY assertion_id`
  );
  const supports = await observer.query(
    `SELECT support_id FROM assertion_supports
      WHERE source_ref = $1 ORDER BY support_id`,
    [scope.sourceRef]
  );
  const extractions = await observer.query(
    `SELECT DISTINCT se.extraction_ref
       FROM support_extractions se
       JOIN assertion_supports s ON s.support_id = se.support_id
      WHERE s.source_ref = $1
      ORDER BY se.extraction_ref`,
    [scope.sourceRef]
  );
  const sources = await observer.query(
    `SELECT generation, published_extraction_revision
       FROM structured_publication_sources
      WHERE scope_binding = $1 AND source_ref = $2`,
    [scope.scopeBinding, scope.sourceRef]
  );
  const membership = await observer.query(
    `SELECT support_id FROM structured_publication_membership
      WHERE scope_binding = $1 AND source_ref = $2 ORDER BY support_id`,
    [scope.scopeBinding, scope.sourceRef]
  );
  return {
    sourceVersionIds: versions.rows.map((row) => row.source_version_id),
    sourceVersionNames: versions.rows.map((row) => row.source_version),
    sourceGenerations: sources.rows.map((row) => Number(row.generation)),
    identityIds: [
      ...entities.rows.map((row) => row.entity_id),
      ...assertions.rows.map((row) => row.assertion_id),
    ],
    assertionIds: assertions.rows.map((row) => row.assertion_id),
    supportIds: supports.rows.map((row) => row.support_id),
    extractionIds: extractions.rows.map((row) => row.extraction_ref),
    extractionRevisions: sources.rows.map((row) =>
      row.published_extraction_revision === null
        ? null
        : Number(row.published_extraction_revision)
    ),
    membershipSupportIds: membership.rows.map((row) => row.support_id),
  };
}

async function observeDerivedFrom(
  observer: pg.Client,
  scope: ProjectionRebuildScope
): Promise<DerivedProjectionObservation | null> {
  const generation = await observer.query(
    `SELECT dependency_revision, publication_revision, dependencies, subjects
       FROM structured_projection_generations
      WHERE scope_binding = $1
      ORDER BY rebuilt_at DESC, dependency_revision
      LIMIT 1`,
    [scope.scopeBinding]
  );
  if (generation.rows.length === 0) return null;
  const row = generation.rows[0] as Record<string, any>;
  const intents = await observer.query(
    `SELECT subject_kind, subject_id FROM projection_outbox
      WHERE status = 'pending' ORDER BY subject_kind, subject_id`
  );
  return {
    subjects: (row.subjects as Array<{ kind: string; id: string }>).map(
      (subject) => `${subject.kind}:${subject.id}`
    ),
    dependencyRevision: row.dependency_revision as string,
    dependencies: row.dependencies as readonly MaintenanceDependency[],
    publicationRevision: String(row.publication_revision),
    pendingIntents: intents.rows.map(
      (entry) => `${entry.subject_kind}:${entry.subject_id}`
    ),
    generationExisted: true,
  } as DerivedProjectionObservation & { generationExisted: boolean };
}

describeProjectionRebuildContract(async () => ({
  label: "strict-pg",

  async seedPublishedSource(label: string) {
    await pool.query("DELETE FROM maintenance_jobs");
    await pool.query("DELETE FROM projection_outbox");
    await pool.query("DELETE FROM structured_projection_generations");
    return seedScope(label);
  },

  async seedUnpublishedDependency(label: string) {
    await pool.query("DELETE FROM maintenance_jobs");
    await pool.query("DELETE FROM projection_outbox");
    await pool.query("DELETE FROM structured_projection_generations");
    const scopeBinding = unique(`rebuild-pg-${label}`);
    const sourceRef = unique(`rebuild-pg-src-${label}`);
    await backend.setScopeRevisions(scopeBinding, {
      authorizationRevision: AUTHORIZATION_REVISION,
      purgeRevision: PURGE_REVISION,
    });
    // Declared and authorized but NEVER published: the dependency resolves to an
    // active source whose accepted extraction does not exist yet.
    const generation = await declare(
      scopeBinding,
      sourceRef,
      "v1",
      [sourceRef],
      1
    );
    return {
      context: contextFor(scopeBinding, [sourceRef]),
      scopeBinding,
      sourceRef,
      generation,
      dependencies: dependenciesFor(sourceRef, generation, null),
    };
  },

  async moveSourceDesired(scope: ProjectionRebuildScope) {
    const generation = await declare(
      scope.scopeBinding,
      scope.sourceRef,
      "v2",
      [scope.sourceRef],
      2
    );
    return {
      ...scope,
      context: contextFor(scope.scopeBinding, [scope.sourceRef]),
      generation,
      dependencies: dependenciesFor(scope.sourceRef, generation, 2),
    };
  },

  async withdrawPublishedSource(scope: ProjectionRebuildScope) {
    await backend.structuredPublication.withdraw({
      scopeBinding: scope.scopeBinding,
      sourceRef: scope.sourceRef,
      expectedGeneration: scope.generation,
      at: clock().toISOString(),
    });
  },

  desynchronizedGuard(
    scope: ProjectionRebuildScope,
    guard: MaintenanceAttemptGuard
  ) {
    // A well-formed digest that is simply not the one the ledger issued. No
    // production row is touched: this is the guard a hostile or buggy caller
    // would present.
    return {
      ...guard,
      inputRevision: createHash("sha256")
        .update(`desynchronized:${scope.sourceRef}`, "utf8")
        .digest("hex"),
    };
  },

  async republishWithNewExtraction(scope: ProjectionRebuildScope) {
    const generation = await declare(
      scope.scopeBinding,
      scope.sourceRef,
      "v1",
      [scope.sourceRef],
      2
    );
    await publishVersion({
      scopeBinding: scope.scopeBinding,
      sourceRef: scope.sourceRef,
      version: "v1",
      generation,
      extractionRevision: 2,
      liveRevision: 1,
      extractionRef: `${scope.sourceRef}-extraction-v1-2`,
    });
    return {
      ...scope,
      context: contextFor(scope.scopeBinding, [scope.sourceRef]),
      generation,
      dependencies: dependenciesFor(scope.sourceRef, generation, 2),
    };
  },

  async claimRebuildAttempt(scope: ProjectionRebuildScope) {
    const guard = await claimOwnAttempt({
      workKind: "projection_rebuild",
      sourceRef: scope.sourceRef,
      sourceVersion: "v1",
      generation: scope.generation,
      extractionRevision: scope.dependencies[0]!.extractionRevision,
    });
    return guard;
  },

  async rebuild(scope: ProjectionRebuildScope, guard: MaintenanceAttemptGuard) {
    return rebuild.rebuildProjections({
      context: scope.context,
      guard,
      at: clock().toISOString(),
    });
  },

  async observeDerived(scope: ProjectionRebuildScope) {
    return withObserver((observer) => observeDerivedFrom(observer, scope));
  },

  async fingerprint(scope: ProjectionRebuildScope) {
    return withObserver((observer) => fingerprintFrom(observer, scope));
  },

  async liveGeneration(scope: ProjectionRebuildScope) {
    return withObserver(async (observer) => {
      const result = await observer.query(
        `SELECT generation FROM structured_publication_sources
          WHERE scope_binding = $1 AND source_ref = $2`,
        [scope.scopeBinding, scope.sourceRef]
      );
      const row = result.rows[0] as { generation?: string } | undefined;
      return row?.generation === undefined ? null : Number(row.generation);
    });
  },
}));

/**
 * Write-point residue.
 *
 * Each injection arm raises on exactly the FIRST row of one table, using the
 * same `nextval`-gated trigger technique T10 proved load-bearing for the
 * publication switch. The point is not that a failure is reported but that the
 * pre-rebuild state survives it byte-identically, observed from a separate
 * connection that never shared the aborted transaction.
 */
/**
 * Every table the rebuild WRITES.
 *
 * `projection-rebuild-pg.ts` issues exactly two write statements: the derived
 * generation insert and the outbox emit. `maintenance_jobs` is only read
 * (`FOR UPDATE`) here, so it is deliberately absent — a third arm would inject
 * into a statement the rebuild never issues, and would report a failure that
 * says nothing about the rebuild's own atomicity.
 */
const WRITE_TABLES = [
  "structured_projection_generations",
  "projection_outbox",
] as const;

/**
 * The extraction-revision fence, isolated.
 *
 * Every published extraction-revision change the publication API can make is
 * preceded by a generation advance, so a caller cannot reach "the revision moved
 * and the generation did not" through it. PostgreSQL can be put in that state
 * directly — as an out-of-band row edit or restore would — and only then does the
 * extraction-revision fence become the one that refuses. Without this case the
 * fence is never exercised, and disabling it changes nothing the suite observes.
 *
 * This case is PostgreSQL-only on purpose: the memory store keeps its accepted
 * rows private, and adding a production method that exists only to let a test
 * edit them would be a backdoor rather than evidence.
 */
describe("MP11 extraction-revision fence on real PostgreSQL", () => {
  it("refuses with input_stale when a dependency's extraction revision moved without its generation", async () => {
    await pool.query("DELETE FROM maintenance_jobs");
    await pool.query("DELETE FROM projection_outbox");
    await pool.query("DELETE FROM structured_projection_generations");
    const scope = await seedScope("revision-only");
    const guard = await claimOwnAttempt({
      workKind: "projection_rebuild",
      sourceRef: scope.sourceRef,
      sourceVersion: "v1",
      generation: scope.generation,
      extractionRevision: 1,
    });
    await pool.query(
      `UPDATE structured_publication_sources
          SET published_extraction_revision = 2
        WHERE scope_binding = $1 AND source_ref = $2`,
      [scope.scopeBinding, scope.sourceRef]
    );
    const live = await withObserver(async (observer) => {
      const result = await observer.query(
        `SELECT generation FROM structured_publication_sources
          WHERE scope_binding = $1 AND source_ref = $2`,
        [scope.scopeBinding, scope.sourceRef]
      );
      return Number((result.rows[0] as { generation: string }).generation);
    });
    // The generation must NOT have moved, or the generation fence would refuse
    // first and this case would prove nothing about the revision fence.
    expect(live, "the fixture advanced the source generation").toBe(
      scope.generation
    );

    let code: string | undefined;
    let detail = "";
    try {
      await rebuild.rebuildProjections({
        context: scope.context,
        guard,
        at: clock().toISOString(),
      });
    } catch (error: unknown) {
      code = (error as { code?: unknown }).code as string | undefined;
      detail = error instanceof Error ? error.message : String(error);
    }
    expect(
      code,
      `a rebuild against a moved extraction revision did not refuse; detail: ${detail}`
    ).toBe("input_stale");
  });
});

describe("MP11 rebuild write-point residue on real PostgreSQL", () => {
  it.each(WRITE_TABLES)(
    "a failure at the first %s write leaves the pre-rebuild state byte-identical",
    async (table) => {
      const scope = await seedScope(`residue-${table}`);
      const guard = await claimOwnAttempt({
        workKind: "projection_rebuild",
        sourceRef: scope.sourceRef,
        sourceVersion: "v1",
        generation: scope.generation,
        extractionRevision: 1,
      });
      const before = await withObserver(async (observer) => ({
        history: await fingerprintFrom(observer, scope),
        derived: await observeDerivedFrom(observer, scope),
        intents: await countRows(observer, "projection_outbox"),
        generations: await countRows(
          observer,
          "structured_projection_generations"
        ),
      }));
      expect(before.derived, "the fixture recorded a generation before rebuilding")
        .toBeNull();

      await withObserver(async (observer) => {
        await observer.query(
          "CREATE SEQUENCE IF NOT EXISTS t23_fail_gate"
        );
        await observer.query("SELECT setval('t23_fail_gate', 1, false)");
        await observer.query(`
          CREATE OR REPLACE FUNCTION t23_fail_first_row() RETURNS trigger
          LANGUAGE plpgsql AS $t23$
          BEGIN
            IF nextval('t23_fail_gate') = 1 THEN
              RAISE EXCEPTION 'injected rebuild write failure'
                USING ERRCODE = 'raise_exception';
            END IF;
            RETURN NEW;
          END $t23$`);
        await observer.query(`DROP TRIGGER IF EXISTS t23_fail ON ${table}`);
        await observer.query(`CREATE TRIGGER t23_fail
          BEFORE INSERT OR UPDATE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION t23_fail_first_row()`);
      });

      let code: string | undefined;
      try {
        await rebuild.rebuildProjections({
          context: scope.context,
          guard,
          at: clock().toISOString(),
        });
      } catch (error: unknown) {
        code = (error as { code?: unknown }).code as string | undefined;
      } finally {
        await withObserver(async (observer) => {
          await observer.query(`DROP TRIGGER IF EXISTS t23_fail ON ${table}`);
          await observer.query(
            "DROP FUNCTION IF EXISTS t23_fail_first_row()"
          );
          await observer.query("DROP SEQUENCE IF EXISTS t23_fail_gate");
        });
      }
      expect(
        code,
        `an injected failure on ${table} was not reported as a typed refusal`
      ).toBeDefined();

      const after = await withObserver(async (observer) => ({
        history: await fingerprintFrom(observer, scope),
        derived: await observeDerivedFrom(observer, scope),
        intents: await countRows(observer, "projection_outbox"),
        generations: await countRows(
          observer,
          "structured_projection_generations"
        ),
      }));
      expect(after.history, `history changed after a failed ${table} write`).toEqual(
        before.history
      );
      expect(after.derived, `a generation survived a failed ${table} write`).toBeNull();
      expect(after.intents, `an intent survived a failed ${table} write`).toBe(
        before.intents
      );
      expect(
        after.generations,
        `a generation row survived a failed ${table} write`
      ).toBe(before.generations);
    }
  );
});

async function countRows(observer: pg.Client, table: string): Promise<number> {
  const result = await observer.query(`SELECT count(*)::int AS count FROM ${table}`);
  return Number((result.rows[0] as { count: number }).count);
}

// EXIT: backend composition supplies neither the publication adapter nor the
// shared scope authority. The module load throws before any harness or schema
// exists, so no case can publish through a storage surface composition does not
// own.
beforeAll(async () => {
  admin = driver.harness.createClient(SCHEMA_URL);
  await admin.connect();
  await driver.harness.resetSchema(admin);
  backend = new PgvectorBackend(SCHEMA_URL, DIMENSIONS, { annMaxDimensions: 2000 });
  await backend.initialize();
  pool = new pg.Pool({ connectionString: SCHEMA_URL, max: 6 });
  clock = createPublicationTestClock(new Date());
  const composed = backend as PgvectorBackend & {
    structuredPublication?: { structuredPublication: unknown };
    structuredScopeUnitOfWork?: AuthorizedScopeUnitOfWork & ScopeTransactionOwner;
  };
  if (!composed.structuredPublication || !composed.structuredScopeUnitOfWork) {
    throw new Error(
      "PgvectorBackend composition must supply the structured publication storage and the shared scope unit of work this lane drives"
    );
  }
  work = new PgMaintenanceWorkStore(pool);
  authority = composed.structuredScopeUnitOfWork;
  rebuild = new PgProjectionRebuildStorage(
    composed.structuredScopeUnitOfWork as ConstructorParameters<
      typeof PgProjectionRebuildStorage
    >[0]
  );
});

afterAll(async () => {
  requireFullyRunnable({
    caseId: "projection-rebuild-pg",
    expectedCommand: EXPECTED_COMMAND,
    owner: "T23",
    entries: [],
  });
  await pool?.end();
  driver.dropOwnSchema(admin).catch(() => undefined);
  await admin?.end();
});