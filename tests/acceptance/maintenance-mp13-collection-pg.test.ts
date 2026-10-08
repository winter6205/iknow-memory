/**
 * MP13 collector eligibility acceptance lane — spec case M14
 * (fin specs/structured-corpus-maintenance.md line 359) on the real boundary.
 *
 * Same two properties as the MP1 acceptance lane, and for the same reasons:
 *
 * 1. It runs against real Postgres through the package's real bootstrap, because
 *    every clause of M14 is about which ROWS exist — a live scope row, a ledger
 *    lease, an unexpired grant, an expired one. A hand-built fact object proves
 *    the arithmetic and nothing about the read that feeds it.
 * 2. It does not skip. Under `npm test` it is inert; under `MAINTENANCE_ACCEPTANCE=1`
 *    an unreachable database fails collection instead of skipping, so the recorded
 *    exit status means what the record says it means:
 *
 *      MAINTENANCE_ACCEPTANCE=1 npx vitest run tests/acceptance/maintenance-mp13-collection-pg.test.ts
 *
 * Scope note: this lane proves ELIGIBILITY only. Marking is MP14 and the deletion
 * phases are MP15, so no case here asserts that a payload was removed.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { COLLECTION_DAY_MS } from "../../src/core/maintenance/collector-eligibility.js";
import type {
  CollectionCandidate,
  CollectionEligibility,
  CollectionPayloadClass,
  CollectionReadFacts,
} from "../../src/core/maintenance/collector-types.js";
import { claimNextWork, liveInputsOf, scheduleWork, settleWork } from "../../src/core/maintenance/service.js";
import type {
  MaintenanceAttemptGuard,
  MaintenanceDependency,
  MaintenanceWorkDeps,
  MaintenanceWorkRequest,
} from "../../src/core/maintenance/types.js";
import { PgCollectionEligibilityReader } from "../../src/core/storage/collector-eligibility-pg.js";
import { InMemoryCollectionEligibilityReader } from "../../src/core/storage/collector-eligibility-memory.js";
import { PgMaintenanceWorkStore } from "../../src/core/storage/maintenance-work-pg.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import {
  createPgIntegrationHarness,
  probePostgres,
  resolvePgConnectionString,
} from "../integration/pg-test-harness.js";

const EXPECTED_COMMAND =
  "MAINTENANCE_ACCEPTANCE=1 npx vitest run tests/acceptance/maintenance-mp13-collection-pg.test.ts";
const ACCEPTANCE_ENV = "MAINTENANCE_ACCEPTANCE";
const DIM = 8;
const SCOPE = "scope-a";
const SOURCE_VERSION_ID = "11111111-1111-4111-8111-111111111111";

const REQUIRED = process.env[ACCEPTANCE_ENV] === "1";
const CONNECTION_STRING = resolvePgConnectionString(
  "postgresql://postgres@localhost/postgres"
);

/** Day 0. Every boundary in this lane is measured from it. */
const DAY0 = new Date("2026-01-01T00:00:00.000Z");
const atDay = (count: number): Date =>
  new Date(DAY0.getTime() + count * COLLECTION_DAY_MS);
const iso = (value: Date): string => value.toISOString();

const pgHarness = await createPgIntegrationHarness({
  label: "maintenance-mp13-collection-pg",
  testPath: "tests/acceptance/maintenance-mp13-collection-pg.test.ts",
  expectedCommand: EXPECTED_COMMAND,
  schemaPrefix: "mp13_collection",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: true,
});
const { schemaConnectionString: SCHEMA_URL, createClient } = pgHarness;

if (REQUIRED) {
  const probe = await probePostgres(CONNECTION_STRING, true);
  if (!probe.available) {
    throw new Error(
      [
        "Validation:",
        "- Not run: the MP13 collection lane requires a real Postgres 16 + pgvector.",
        `- Expected command: ${EXPECTED_COMMAND}`,
        `- Blocking issue: ${probe.error instanceof Error ? probe.error.message : String(probe.error)}`,
      ].join("\n")
    );
  }
}

const describeAcceptance = REQUIRED
  ? pgHarness.describePg
  : pgHarness.describePg.skip;

type ClosablePool = ConstructorParameters<typeof PgCollectionEligibilityReader>[0] & {
  end(): Promise<void>;
};

function poolOf(connectionString: string): ClosablePool {
  return new pg.Pool({ connectionString, max: 4 }) as unknown as ClosablePool;
}

/** The ledger request a collection job is scheduled under. */
const collectRequest = (
  sourceRef: string,
  sourceVersion: string
): MaintenanceWorkRequest => {
  const dependencies: MaintenanceDependency[] = [
    { sourceRef, generation: 1, extractionRevision: 1, relationBuckets: ["employment"] },
  ];
  return {
    workKind: "collect_payload",
    sourceRef,
    sourceVersion,
    sourceGeneration: 1,
    configRevision: "collector-1",
    dependencies,
  };
};

const candidate = (
  payloadClass: CollectionPayloadClass,
  overrides: Partial<CollectionCandidate> = {}
): CollectionCandidate => ({
  payloadClass,
  payloadRef: "s1",
  source: { sourceRef: "s1", sourceVersion: "v1", sourceGeneration: 1 },
  anchorAt: iso(DAY0),
  ...overrides,
});

describeAcceptance("M14 acceptance — collector eligibility on the real boundary", () => {
  let backend: PgvectorBackend;
  let admin: pg.Client;

  beforeAll(async () => {
    // The real boot path: the maintenance, evidence and publication tables come
    // from the package bootstrap, so this lane cannot prove a schema the product
    // never builds.
    admin = createClient(SCHEMA_URL);
    await admin.connect();
    await pgHarness.resetSchema(admin);
    backend = new PgvectorBackend(SCHEMA_URL, DIM, { annMaxDimensions: 2000 });
    await backend.initialize();
  }, 120_000);

  beforeEach(async () => {
    // CASCADE because the publication and evidence tables reference these rows by
    // foreign key; every case seeds the rows it needs, and the schema is this run's
    // own throwaway one.
    await admin.query(
      `TRUNCATE maintenance_job_attempts, maintenance_jobs,
                structured_publication_stages, structured_publication_sources,
                structured_publication_scopes, evidence_grant_supports,
                evidence_grant_extractions, evidence_grants,
                evidence_authorization_receipts, assertion_supports,
                source_versions
         CASCADE`
    );
  });

  afterAll(async () => {
    try {
      await pgHarness.dropSchema(admin);
    } finally {
      await admin?.end();
      await backend?.close();
    }
  });

  /** One retired source version with one support, both real rows. */
  async function seedSource(options: { readonly retired: boolean }): Promise<string> {
    const sourceVersionId = randomUUID();
    const supportId = randomUUID();
    await admin.query(
      `INSERT INTO source_versions
         (source_version_id, source_ref, source_version, content_digest,
          origin_object_ref, parser_revision, unit_manifest, created_at, retired_at)
       VALUES ($1, 's1', 'v1', $2, 'obj://s1', 'parser-1', '[]'::jsonb, $3, $4)`,
      [
        sourceVersionId,
        "a".repeat(64),
        iso(DAY0),
        options.retired ? iso(DAY0) : null,
      ]
    );
    await admin.query(
      `INSERT INTO assertion_supports
         (support_id, subject, result_id, source_ref, source_version,
          source_version_id, document_id, unit_version, unit, span_start,
          span_end, created_at)
       VALUES ($1, 'assertion', 'r1', 's1', 'v1', $2, 'doc-1', 'u1', 1, -1, -1, $3)`,
      [supportId, sourceVersionId, iso(DAY0)]
    );
    return supportId;
  }

  /** A grant holding one support. `row` protects content; `count` only receipts. */
  async function seedGrant(
    supportId: string,
    grantKind: "row" | "count",
    expiresAt: Date
  ): Promise<string> {
    const evidenceRef = randomUUID();
    const receiptId = randomUUID();
    if (grantKind === "count") {
      await admin.query(
        `INSERT INTO evidence_authorization_receipts
           (receipt_id, scope_binding, authorization_revision, purge_revision, created_at)
         VALUES ($1, 'scope-a', 'auth-1', 'purge-1', $2)`,
        [receiptId, iso(DAY0)]
      );
    }
    await admin.query(
      `INSERT INTO evidence_grants
         (evidence_ref, grant_kind, subject, operation, query_digest,
          scope_binding, read_revision, authorization_revision, purge_revision,
          queried_at, expires_at, context, value, result_count,
          authorization_receipt_id, consumer_id)
       VALUES ($1, $2, 'assertion', 'search', 'digest-1', 'scope-a', 'read-1',
               'auth-1', 'purge-1', $3, $4, '{}'::jsonb, $5, $6, $7, 'consumer-1')`,
      [
        evidenceRef,
        grantKind,
        iso(DAY0),
        iso(expiresAt),
        grantKind === "count" ? '{"count":3}' : '{"rows":[]}',
        grantKind === "count" ? 3 : null,
        grantKind === "count" ? receiptId : null,
      ]
    );
    await admin.query(
      `INSERT INTO evidence_grant_supports (evidence_ref, support_id, role)
       VALUES ($1, $2, 'occurrence')`,
      [evidenceRef, supportId]
    );
    return evidenceRef;
  }

  /** A scope row that still desires this source version: a current dependency. */
  async function seedDesiredScope(): Promise<void> {
    await admin.query(
      `INSERT INTO structured_publication_scopes (scope_binding) VALUES ($1)
       ON CONFLICT DO NOTHING`,
      [SCOPE]
    );
    await admin.query(
      `INSERT INTO structured_publication_sources
         (scope_binding, source_ref, active, generation, desired_source_version,
          desired_extraction_revision, desired_config_revision)
       VALUES ($1, 's1', true, 1, 'v1', 1, 'extractor-1')
       ON CONFLICT DO NOTHING`,
      [SCOPE]
    );
  }

  /** A staged extraction attempt on that scope. */
  async function seedStage(): Promise<void> {
    await admin.query(
      `INSERT INTO structured_publication_stages
         (scope_binding, source_ref, generation, job_key, attempt_number,
          fencing_token, extraction_ref, accepted_facts, staged_at)
       VALUES ($1, 's1', 1, 'job-stage-1', 1, 'token-1', 'extraction-1',
               '[]'::jsonb, $2)`,
      [SCOPE, iso(DAY0)]
    );
  }

  /** A running ledger job holding a real lease over the payload. */
  async function seedRunningLease(now: Date): Promise<MaintenanceWorkDeps> {
    const deps: MaintenanceWorkDeps = {
      store: new PgMaintenanceWorkStore(poolOf(SCHEMA_URL)),
      clock: () => now,
    };
    const scheduled = await scheduleWork(
      deps,
      { actorId: "m14-operator" },
      collectRequest("s1", "v1")
    );
    if ("refused" in scheduled) throw new Error(scheduled.detail);
    const claimed = await claimNextWork(deps);
    if (claimed.guard === null) throw new Error("expected a claimable collect_payload job");
    return deps;
  }

  /** Settle the attempt as stale, inside its lease, so the job leaves the live set. */
  async function settleStale(
    deps: MaintenanceWorkDeps,
    guard: MaintenanceAttemptGuard,
    now: Date
  ): Promise<void> {
    const settled = await settleWork(
      deps,
      guard,
      { status: "failed", failureCode: "input_stale" },
      liveInputsOf("collector-1", collectRequest("s1", "v1").dependencies),
      now
    );
    if (settled.refused) throw new Error(`settle refused ${settled.code}`);
  }

  /** The raw facts, so a case can assert WHICH dependency the read found. */
  async function readFacts(
    payload: CollectionCandidate,
    now: Date
  ): Promise<CollectionReadFacts> {
    const pool = poolOf(SCHEMA_URL);
    try {
      return await new PgCollectionEligibilityReader(pool).readCollectionFacts(
        payload,
        now
      );
    } finally {
      await pool.end();
    }
  }

  async function decide(
    payload: CollectionCandidate,
    now: Date
  ): Promise<CollectionEligibility> {
    const pool = poolOf(SCHEMA_URL);
    try {
      const { readCollectionEligibility } = await import(
        "../../src/core/maintenance/collector-eligibility.js"
      );
      const outcome = await readCollectionEligibility(
        { reader: new PgCollectionEligibilityReader(pool), clock: () => now },
        payload
      );
      if (outcome.refused) throw new Error(`${outcome.code}: ${outcome.detail}`);
      return outcome.eligibility;
    } finally {
      await pool.end();
    }
  }

  it("accepts collect_payload as a work kind in the ledger and the database CHECK", async () => {
    await seedSource({ retired: true });
    const store = new PgMaintenanceWorkStore(poolOf(SCHEMA_URL));
    const scheduled = await scheduleWork(
      { store, clock: () => DAY0 },
      { actorId: "m14-operator" },
      collectRequest("s1", "v1")
    );

    if ("refused" in scheduled) throw new Error(scheduled.detail);
    expect(scheduled.record.workKind).toBe("collect_payload");

    // The value reached the row through the schema's rendered CHECK list.
    const row = await admin.query<{ work_kind: string }>(
      "SELECT work_kind FROM maintenance_jobs WHERE job_key = $1",
      [scheduled.record.jobKey]
    );
    expect(row.rows[0]?.work_kind).toBe("collect_payload");
    await store.close();
  });

  it("migrates the work-kind CHECK on a store bootstrapped before MP13", async () => {
    // The deployed shape: the table exists, and its inline CHECK is still the
    // three-kind list, so nothing about CREATE TABLE IF NOT EXISTS can reach it.
    await admin.query(
      `ALTER TABLE maintenance_jobs
        DROP CONSTRAINT maintenance_jobs_work_kind_closed_check`
    );
    await admin.query(
      `ALTER TABLE maintenance_jobs
        ADD CONSTRAINT maintenance_jobs_work_kind_check
        CHECK (work_kind IN ('extract_publish','conflict_check','projection_rebuild'))`
    );

    // The state the migration exists to fix, asserted rather than assumed.
    await expect(
      admin.query(
        `INSERT INTO maintenance_jobs
           (job_key, work_kind, source_ref, source_version, source_generation,
            input_revision, config_revision, created_at, updated_at)
         VALUES ('legacy-probe', 'collect_payload', 's1', 'v1', 1, 'rev-1',
                 'collector-1', $1, $1)`,
        [iso(DAY0)]
      )
    ).rejects.toThrow(/maintenance_jobs_work_kind_check/);

    // The readiness probe must answer not-ready for the widened CHECK, or this
    // replay would be short-circuited away.
    await upSchemaBootstrap(admin, DIM, 2000);

    const store = new PgMaintenanceWorkStore(poolOf(SCHEMA_URL));
    const scheduled = await scheduleWork(
      { store, clock: () => DAY0 },
      { actorId: "m14-operator" },
      collectRequest("s1", "v1")
    );

    if ("refused" in scheduled) throw new Error(scheduled.detail);
    expect(scheduled.record.workKind).toBe("collect_payload");
    await store.close();
  });

  it("leaves the rebuilt CHECK alone on a second bootstrap", async () => {
    const definitions = async (): Promise<string[]> => {
      const { rows } = await admin.query<{ conname: string; definition: string }>(
        `SELECT k.conname, pg_get_constraintdef(k.oid) AS definition
           FROM pg_constraint k
           JOIN pg_class t ON t.oid = k.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = current_schema()
            AND t.relname = 'maintenance_jobs'
            AND k.contype = 'c'
          ORDER BY k.conname`
      );
      return rows.map((row) => `${row.conname}:${row.definition}`);
    };

    await upSchemaBootstrap(admin, DIM, 2000);
    const first = await definitions();

    await upSchemaBootstrap(admin, DIM, 2000);
    expect(await definitions()).toEqual(first);
    // Exactly one work-kind constraint, so the rebuild cannot stack copies.
    expect(first.filter((name) => name.includes("work_kind"))).toHaveLength(1);
  });

  it("refuses a source-bound candidate whose source version is not in the store", async () => {
    const pool = poolOf(SCHEMA_URL);
    const { readCollectionEligibility } = await import(
      "../../src/core/maintenance/collector-eligibility.js"
    );
    const outcome = await readCollectionEligibility(
      { reader: new PgCollectionEligibilityReader(pool), clock: () => atDay(90) },
      candidate("retired_unreferenced")
    );

    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("unsupported_source_binding");
    await pool.end();
  });

  it("holds a retired source until day 90 and releases it at day 90", async () => {
    await seedSource({ retired: true });
    const payload = candidate("retired_unreferenced");

    const before = await decide(payload, new Date(atDay(90).getTime() - 1));
    expect(before.eligible).toBe(false);
    expect(before.blockingReasons).toContain("deadline_not_reached");
    expect(before.earliestCandidateAt).toBe(iso(atDay(90)));

    const atBoundary = await decide(payload, atDay(90));
    expect(atBoundary.eligible).toBe(true);
    expect(atBoundary.blockingReasons).toEqual([]);
  });

  it("separates day 90 candidate time from day 97 physical purge time", async () => {
    await seedSource({ retired: true });
    const eligibility = await decide(candidate("retired_unreferenced"), atDay(90));

    expect(eligibility.earliestCandidateAt).toBe(iso(atDay(90)));
    expect(eligibility.physicalPurgeNotBefore).toBe(iso(atDay(97)));
  });

  it("refuses a retired_unreferenced candidate for a source that is not retired", async () => {
    await seedSource({ retired: false });
    const pool = poolOf(SCHEMA_URL);
    const { readCollectionEligibility } = await import(
      "../../src/core/maintenance/collector-eligibility.js"
    );

    const outcome = await readCollectionEligibility(
      { reader: new PgCollectionEligibilityReader(pool), clock: () => atDay(400) },
      candidate("retired_unreferenced")
    );
    await pool.end();

    // Day 400, no dependency, no grant, no lease — and still not collectible,
    // because current knowledge is never collected for being old.
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("invalid_input");
  });

  it("still collects an attempt stage sitting on that same unretired source", async () => {
    await seedSource({ retired: false });
    const eligibility = await decide(candidate("attempt_stage"), atDay(7));

    expect(eligibility.eligible).toBe(true);
  });

  it("blocks on a current compiled object that still depends on the retired source", async () => {
    const supportId = await seedSource({ retired: true });
    void supportId;
    await admin.query(
      `INSERT INTO structured_publication_scopes (scope_binding) VALUES ('scope-a')`
    );
    await admin.query(
      `INSERT INTO structured_publication_sources
         (scope_binding, source_ref, active, generation, desired_source_version,
          desired_extraction_revision, desired_config_revision)
       VALUES ('scope-a', 's1', true, 1, 'v1', 1, 'extractor-1')`
    );

    const eligibility = await decide(candidate("retired_unreferenced"), atDay(365));

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockingReasons).toContain("current_dependency");
    expect(eligibility.nextEvaluationAt).toBeNull();
  });

  it("drops the lease reason when the lease expires, but keeps the live job", async () => {
    await seedSource({ retired: true });
    const payload = candidate("retired_unreferenced");
    await seedRunningLease(atDay(90));
    const afterLease = new Date(atDay(90).getTime() + 10 * 60 * 1000);

    const insideLease = await readFacts(payload, atDay(90));
    expect(insideLease.validLeases.map((lease) => lease.kind)).toEqual(["job"]);
    expect(insideLease.currentDependencies.map((dep) => dep.kind)).toEqual([
      "live_maintenance_job",
    ]);

    const held = await decide(payload, atDay(90));
    expect(held.blockingReasons).toContain("valid_lease");
    expect(held.blockingReasons).toContain("current_dependency");
    expect(held.eligible).toBe(false);

    // Ten minutes on the five-minute lease is over, but the job is still running
    // and a running job is a live input dependency rather than a timed one — so no
    // clock reading alone frees the payload.
    const leased = await decide(payload, afterLease);
    expect(leased.blockingReasons).not.toContain("valid_lease");
    expect(leased.blockingReasons).toContain("current_dependency");
    expect(leased.nextEvaluationAt).toBeNull();
  });

  it("becomes collectable once the live attempt settles and its lease is over", async () => {
    await seedSource({ retired: true });
    const payload = candidate("retired_unreferenced");
    const deps: MaintenanceWorkDeps = {
      store: new PgMaintenanceWorkStore(poolOf(SCHEMA_URL)),
      clock: () => atDay(90),
    };
    const scheduled = await scheduleWork(
      deps,
      { actorId: "m14-operator" },
      collectRequest("s1", "v1")
    );
    if ("refused" in scheduled) throw new Error(scheduled.detail);
    const claimed = await claimNextWork(deps);
    if (claimed.guard === null) throw new Error("expected a claimable collect_payload job");

    await settleStale(deps, claimed.guard, atDay(90));
    const afterLease = new Date(atDay(90).getTime() + 10 * 60 * 1000);
    const released = await decide(payload, afterLease);

    expect(released.blockingReasons).toEqual([]);
    expect(released.eligible).toBe(true);
  });

  it("blocks on an unexpired row-content reference", async () => {
    const supportId = await seedSource({ retired: true });
    await seedGrant(supportId, "row", atDay(200));

    const eligibility = await decide(candidate("retired_unreferenced"), atDay(100));

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockingReasons).toContain("row_content_reference");
  });

  it("does NOT block on a count-only grant, and keeps its receipt visible", async () => {
    const supportId = await seedSource({ retired: true });
    const evidenceRef = await seedGrant(supportId, "count", atDay(300));

    const eligibility = await decide(candidate("retired_unreferenced"), atDay(90));

    expect(eligibility.eligible).toBe(true);
    expect(eligibility.blockingReasons).toEqual([]);
    expect(eligibility.ignoredCountGrants).toEqual([evidenceRef]);

    // The receipt itself is untouched by the decision: it is still a row.
    const receipt = await admin.query<{ receipt_id: string }>(
      "SELECT receipt_id FROM evidence_authorization_receipts"
    );
    expect(receipt.rows).toHaveLength(1);
  });

  it("extends a protected payload to a finite row reference that outlives day 90", async () => {
    const supportId = await seedSource({ retired: true });
    await seedGrant(supportId, "row", atDay(200));

    const blocked = await decide(candidate("retired_evidence_protected"), atDay(199));
    expect(blocked.earliestCandidateAt).toBe(iso(atDay(200)));
    expect(blocked.eligible).toBe(false);

    const released = await decide(candidate("retired_evidence_protected"), atDay(200));
    expect(released.eligible).toBe(true);
  });

  it("caps a long-lived reference at day 365 absent a current dependency", async () => {
    const supportId = await seedSource({ retired: true });
    await seedGrant(supportId, "row", atDay(400));

    const beforeCap = await decide(
      candidate("retired_evidence_protected"),
      new Date(atDay(364).getTime())
    );
    expect(beforeCap.eligible).toBe(false);

    const atCap = await decide(candidate("retired_evidence_protected"), atDay(365));
    expect(atCap.earliestCandidateAt).toBe(iso(atDay(365)));
    expect(atCap.eligible).toBe(true);
    expect(atCap.physicalPurgeNotBefore).toBe(iso(atDay(372)));
  });

  it("lifts the day-365 cap while a current dependency keeps the reference alive", async () => {
    const supportId = await seedSource({ retired: true });
    await seedGrant(supportId, "row", atDay(400));
    await seedDesiredScope();

    const eligibility = await decide(candidate("retired_evidence_protected"), atDay(365));

    // The cap is conditioned on the absence of a current dependency (spec 292),
    // so the deadline MP14 would persist is the reference's own expiry.
    expect(eligibility.earliestCandidateAt).toBe(iso(atDay(400)));
    expect(eligibility.blockingReasons).toContain("current_dependency");
    expect(eligibility.eligible).toBe(false);
  });

  it("reports the same dependencies as the in-memory twin, holder included", async () => {
    await seedSource({ retired: true });
    await seedDesiredScope();
    await seedStage();
    await seedRunningLease(atDay(90));
    const job = await admin.query<{ job_key: string }>(
      "SELECT job_key FROM maintenance_jobs LIMIT 1"
    );
    const jobKey = job.rows[0]?.job_key as string;

    const payload = candidate("retired_unreferenced");
    const fromPg = await readFacts(payload, atDay(90));
    const fromMemory = await new InMemoryCollectionEligibilityReader({
      sourceVersions: [
        {
          sourceRef: "s1",
          sourceVersion: "v1",
          sourceVersionId: SOURCE_VERSION_ID,
          retiredAt: iso(DAY0),
          payloadCollectedAt: null,
        },
      ],
      publicationSources: [
        { sourceRef: "s1", scopeBinding: SCOPE, desiredSourceVersion: "v1" },
      ],
      stagedPublications: [{ sourceRef: "s1", scopeBinding: SCOPE }],
      jobs: [
        { jobKey, sourceRef: "s1", status: "running", leaseExpiresAt: iso(atDay(95)) },
      ],
    }).readCollectionFacts(payload, atDay(90));

    // `holder` is the row a recheck has to name, so a lane that answered a
    // different one would send MP14's cancellation to the wrong row.
    expect(fromMemory.currentDependencies).toEqual(fromPg.currentDependencies);
    expect(fromPg.currentDependencies).toEqual([
      { kind: "live_maintenance_job", holder: jobKey },
      { kind: "published_or_desired_scope", holder: SCOPE },
      { kind: "staged_publication", holder: SCOPE },
    ]);
  });

  it("releases a payload at the boundary a nonrenewing expired row reference reaches", async () => {
    const supportId = await seedSource({ retired: true });
    await seedGrant(supportId, "row", atDay(120));

    const held = await decide(candidate("retired_unreferenced"), new Date(atDay(120).getTime() - 1));
    expect(held.blockingReasons).toContain("row_content_reference");

    // The reference expires exactly here and is not renewed by this read.
    const released = await decide(candidate("retired_unreferenced"), atDay(120));
    expect(released.blockingReasons).not.toContain("row_content_reference");
    expect(released.eligible).toBe(true);
  });

  it("reports an already-collected payload as a no-op rather than eligible", async () => {
    await seedSource({ retired: true });
    await admin.query(
      `UPDATE source_versions SET payload_collected_at = $1 WHERE source_ref = 's1'`,
      [iso(atDay(90))]
    );

    const eligibility = await decide(candidate("retired_unreferenced"), atDay(200));

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockingReasons).toContain("already_collected");
  });
});