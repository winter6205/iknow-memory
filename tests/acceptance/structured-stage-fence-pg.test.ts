import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { claimNextWork, scheduleWork } from "../../src/core/maintenance/service.js";
import {
  MAX_AUTO_ATTEMPTS,
  WORK_ABSOLUTE_LIMIT_MS,
  WORK_LEASE_MS,
} from "../../src/core/maintenance/types.js";
import type {
  MaintenanceAttemptGuard,
  MaintenanceDependency,
  MaintenanceWorkRequest,
  MaintenanceWorkStore,
} from "../../src/core/maintenance/types.js";
import type { EntityIdentityInput } from "../../src/core/structured/identity-store.js";
import type {
  PublicationFact,
  StructuredPublicationStorage,
} from "../../src/core/maintenance/publication-types.js";
import { PgMaintenanceWorkStore } from "../../src/core/storage/maintenance-work-pg.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import type { ChunkRecord } from "../../src/core/types.js";
import {
  createPgIntegrationHarness,
  probePostgres,
  type PgIntegrationHarness,
} from "../integration/pg-test-harness.js";
import {
  createPublicationTestClock,
  type PublicationTestClock,
} from "../storage/publication-contract.js";

// EXIT: this driver never skips. The opt-in marker and the DSN must both be
// present or the module refuses at load, and an absent or unreachable database
// is a named non-zero failure rather than a skip.
const OPT_IN = process.env.IK_STRUCTURED_STAGE_FENCE_PG;
if (OPT_IN !== "1") {
  throw new Error(
    "structured-stage-fence-pg.test.ts requires IK_STRUCTURED_STAGE_FENCE_PG=1; it never skips"
  );
}
const DSN = process.env.GRAPHRAG_MEMORY_DB_URL;
if (typeof DSN !== "string" || DSN.trim() === "") {
  throw new Error(
    "structured-stage-fence-pg.test.ts requires GRAPHRAG_MEMORY_DB_URL to be set; it never skips"
  );
}

const SCHEMA_PREFIX = "t09_stage_fence";
const DIMENSIONS = 8;
const ACTOR = "t09-stage-fence-owner";
const CONFIG_REVISION = "extractor-v1";
const AUTHORIZATION_REVISION = "auth-r1";
const SCOPE_BINDING = "scope-t09-stage-fence";
const DRAIN_LIMIT = 64;

const harness: PgIntegrationHarness = await createPgIntegrationHarness({
  schemaPrefix: SCHEMA_PREFIX,
  defaultConnectionString: DSN,
  requiresVector: true,
  testPath: "tests/acceptance/structured-stage-fence-pg.test.ts",
  label: "T09 stage fences",
  expectedCommand:
    "IK_STRUCTURED_STAGE_FENCE_PG=1 GRAPHRAG_MEMORY_DB_URL=<dsn> npx vitest run tests/acceptance/structured-stage-fence-pg.test.ts",
});

const reachability = await probePostgres(DSN, true);
if (!reachability.available) {
  throw new Error(
    "structured-stage-fence-pg.test.ts requires a reachable PostgreSQL with pgvector " +
      "at the configured DSN; it reports an unreachable database as this failure " +
      "rather than skipping"
  );
}

let admin: pg.Client;
let backend: PgvectorBackend;
let pool: pg.Pool;
let clock: PublicationTestClock;
let publication: StructuredPublicationStorage;
let work: MaintenanceWorkStore;

let serial = 0;

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function dependencyOf(
  sourceRef: string,
  generation: number,
  extractionRevision: number | null = null
): MaintenanceDependency {
  return { sourceRef, generation, extractionRevision, relationBuckets: [] };
}

function publishRequest(
  sourceRef: string,
  sourceVersion: string,
  generation: number,
  dependencies: readonly MaintenanceDependency[]
): MaintenanceWorkRequest {
  return {
    workKind: "extract_publish",
    sourceRef,
    sourceVersion,
    sourceGeneration: generation,
    configRevision: CONFIG_REVISION,
    dependencies,
  };
}

async function seedGraphEntities(entityIds: readonly string[]): Promise<void> {
  const chunks: ChunkRecord[] = entityIds.map((id) => ({
    id,
    content: `t09 stage fence entity ${id}`,
    embedding: new Array<number>(DIMENSIONS).fill(0),
    source_ref: "t09-stage-fence-fixture",
    metadata: {},
    valid_from: clock().toISOString(),
    valid_until: null,
    created_at: clock().toISOString(),
  }));
  if (chunks.length > 0) await backend.upsert(chunks);
}

interface Seeded {
  readonly record: { source_ref: string; source_version: string; created_at: string };
  readonly locator: { document_id: string; version: string; unit: number };
  readonly locatorBindings: readonly {
    source_version_id: string;
    document_id: string;
    version: string;
    unit: number;
  }[];
  readonly generation: number;
}

async function seedSource(
  sourceRef: string,
  sourceVersion: string,
  authorizedSourceRefs: readonly string[] = [sourceRef]
): Promise<Seeded> {
  const { record } = await backend.registerSourceVersion({
    source_ref: sourceRef,
    source_version: sourceVersion,
    content_digest: digest(`${sourceRef}:${sourceVersion}`),
    origin_object_ref: `objects/${sourceRef}/${sourceVersion}.html`,
    parser_revision: "frozen-html-units-v1",
    unit_manifest: { units: 3, parser_revision: "frozen-html-units-v1" },
    created_at: clock().toISOString(),
    retired_at: null,
    payload_collected_at: null,
    obligations_stopped_at: null,
  });
  const locator = {
    document_id: `${sourceRef}-document`,
    version: `frozen-${sourceVersion}`,
    unit: 1,
  };
  const locatorBindings = [1, 2, 3].map((unit) => ({
    source_version_id: record.source_version_id,
    ...locator,
    unit,
  }));
  for (const binding of locatorBindings) await backend.bindSourceLocator(binding);
  const declared = await publication.declareDesired({
    scopeBinding: SCOPE_BINDING,
    authorizedSourceRefs: [...authorizedSourceRefs],
    sourceRef,
    sourceVersion: record,
    locatorBindings,
    desiredExtractionRevision: 1,
    configRevision: CONFIG_REVISION,
  });
  return { record, locator, locatorBindings, generation: declared.generation };
}

// EXIT: claiming through a back-dated clock writes the real lease and absolute
// deadline stamps the store will later compare against the database clock, so a
// lease or deadline case ages committed state instead of sleeping.
async function claimOwnJobAt(
  sourceRef: string,
  sourceVersion: string,
  generation: number,
  dependencies: readonly MaintenanceDependency[],
  claimedAt: Date
): Promise<MaintenanceAttemptGuard> {
  clock.set(claimedAt);
  const deps = { store: work, clock: () => clock() };
  const scheduled = await scheduleWork(
    deps,
    { actorId: ACTOR },
    publishRequest(sourceRef, sourceVersion, generation, dependencies)
  );
  if ("refused" in scheduled) {
    throw new Error(`scheduleWork refused: ${scheduled.refused}`);
  }
  for (let attempt = 0; attempt < DRAIN_LIMIT; attempt += 1) {
    const claimed = await claimNextWork(deps);
    const guard = claimed.guard;
    if (guard === null) break;
    if (guard.jobKey === scheduled.record.jobKey) return guard;
    await pool.query(
      `UPDATE maintenance_jobs
          SET status = 'stale', last_failure_code = 'input_stale',
              next_attempt_at = NULL, fencing_token = NULL,
              lease_expires_at = NULL, attempt_started_at = NULL
        WHERE job_key = $1`,
      [guard.jobKey]
    );
  }
  throw new Error(`could not claim job ${scheduled.record.jobKey} for this case`);
}

async function claimOwnJob(
  sourceRef: string,
  sourceVersion: string,
  generation: number,
  dependencies: readonly MaintenanceDependency[]
): Promise<MaintenanceAttemptGuard> {
  return claimOwnJobAt(
    sourceRef,
    sourceVersion,
    generation,
    dependencies,
    new Date()
  );
}

function entityFact(
  seeded: Seeded,
  entityId: string,
  extractionRef: string
): PublicationFact {
  const identityInput: EntityIdentityInput = { entityId, type: "organization" };
  return {
    identity: { kind: "entity", input: identityInput },
    occurrence: {
      subject: "entity",
      result_id: entityId,
      source_ref: seeded.record.source_ref,
      source_version: seeded.record.source_version,
      location: { ...seeded.locator, unit: 1 },
      extraction_ref: extractionRef,
      extractedAt: seeded.record.created_at,
    },
    display: { canonicalName: `Served ${entityId.slice(-4)}`, type: "organization" },
  };
}

interface StageOutcome {
  readonly staged: boolean;
  readonly code?: string;
}

let entitySerial = 0;

function nextEntityId(): string {
  entitySerial += 1;
  return `00000000-0000-4000-8000-${entitySerial.toString().padStart(12, "0")}`;
}

// EXIT: the real production entry point. Every case below drives
// `publication.stageAttempt` itself, so a refusal here is the store's own fence
// and not a test-only helper.
async function stageReal(
  sourceRef: string,
  seeded: Seeded,
  guard: MaintenanceAttemptGuard,
  entityId = nextEntityId()
): Promise<StageOutcome> {
  const extractionRef = `extract-${entityId.slice(-4)}`;
  await seedGraphEntities([entityId]);
  try {
    await publication.stageAttempt({
      scopeBinding: SCOPE_BINDING,
      sourceRef,
      guard,
      extractionRef,
      accepted: [entityFact(seeded, entityId, extractionRef)],
    });
    return { staged: true };
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    return { staged: false, code: typeof code === "string" ? code : undefined };
  }
}

async function stageRowCount(sourceRef: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM structured_publication_stages
      WHERE scope_binding = $1 AND source_ref = $2`,
    [SCOPE_BINDING, sourceRef]
  );
  return rows[0]?.n ?? 0;
}

async function servingMembership(
  sourceRef: string
): Promise<readonly { subject: string; result_id: string }[]> {
  const { rows } = await pool.query(
    `SELECT subject, result_id FROM structured_publication_membership
      WHERE scope_binding = $1 AND source_ref = $2
      ORDER BY subject, result_id`,
    [SCOPE_BINDING, sourceRef]
  );
  return rows;
}

async function publishedPair(
  sourceRef: string
): Promise<{ sourceVersion: string | null; extractionRevision: number | null }> {
  const { rows } = await pool.query(
    `SELECT published_source_version, published_extraction_revision
       FROM structured_publication_sources
      WHERE scope_binding = $1 AND source_ref = $2`,
    [SCOPE_BINDING, sourceRef]
  );
  return {
    sourceVersion: rows[0]?.published_source_version ?? null,
    extractionRevision:
      rows[0]?.published_extraction_revision === null ||
      rows[0]?.published_extraction_revision === undefined
        ? null
        : Number(rows[0].published_extraction_revision),
  };
}

async function currentGeneration(sourceRef: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT generation FROM structured_publication_sources
      WHERE scope_binding = $1 AND source_ref = $2`,
    [SCOPE_BINDING, sourceRef]
  );
  return Number(rows[0].generation);
}

describe("T09 stage fences on the real production path (PostgreSQL)", () => {
  beforeAll(async () => {
    admin = harness.createClient(harness.schemaConnectionString);
    await admin.connect();
    await harness.resetSchema(admin);
    backend = new PgvectorBackend(harness.schemaConnectionString, DIMENSIONS, {
      annMaxDimensions: 2000,
    });
    await backend.initialize();
    pool = new pg.Pool({ connectionString: harness.schemaConnectionString, max: 8 });
    clock = createPublicationTestClock(new Date());
    await backend.setScopeRevisions(SCOPE_BINDING, {
      authorizationRevision: AUTHORIZATION_REVISION,
      purgeRevision: `purge-${AUTHORIZATION_REVISION}`,
    });
    const composed = backend as PgvectorBackend & {
      structuredPublication?: StructuredPublicationStorage;
    };
    const composedPublication = composed.structuredPublication;
    if (!composedPublication) {
      throw new Error(
        "PgvectorBackend composition must supply the structured publication store"
      );
    }
    publication = composedPublication;
    work = new PgMaintenanceWorkStore(pool);
  }, 120_000);

  beforeEach(() => {
    clock.set(new Date());
  });

  afterAll(async () => {
    try {
      if (!harness.schema.startsWith(`${SCHEMA_PREFIX}_`)) {
        throw new Error("refusing to drop a schema outside this run's prefix");
      }
      await harness.dropSchema(admin);
    } finally {
      await pool?.end();
      await backend?.close();
      await admin?.end();
    }
  }, 60_000);

  it("a live attempt stages its payload without changing serving membership", async () => {
    const sourceRef = unique("live");
    const seeded = await seedSource(sourceRef, "v1");
    const guard = await claimOwnJob(sourceRef, "v1", seeded.generation, [
      dependencyOf(sourceRef, seeded.generation),
    ]);

    const outcome = await stageReal(sourceRef, seeded, guard);
    expect(outcome).toEqual({ staged: true });
    expect(await stageRowCount(sourceRef)).toBe(1);
    expect(await servingMembership(sourceRef)).toEqual([]);
    expect(await publishedPair(sourceRef)).toEqual({
      sourceVersion: null,
      extractionRevision: null,
    });
  });

  it("a reclaimed attempt's stale token cannot stage", async () => {
    const sourceRef = unique("stale-token");
    const seeded = await seedSource(sourceRef, "v1");
    const dependencies = [dependencyOf(sourceRef, seeded.generation)];
    const stale = await claimOwnJobAt(
      sourceRef,
      "v1",
      seeded.generation,
      dependencies,
      new Date(Date.now() - WORK_LEASE_MS - 1_000)
    );

    clock.set(new Date());
    const reclaimed = await claimNextWork({ store: work, clock: () => clock() });
    if (reclaimed.guard === null) throw new Error("reclaim produced no guard");
    expect(reclaimed.guard.jobKey).toBe(stale.jobKey);
    expect(reclaimed.guard.fencingToken).not.toBe(stale.fencingToken);

    const outcome = await stageReal(sourceRef, seeded, stale);
    expect(outcome.staged).toBe(false);
    expect(outcome.code).toBe("lease_lost");
    expect(await stageRowCount(sourceRef)).toBe(0);
  });

  it("an expired lease cannot stage", async () => {
    const sourceRef = unique("lease-expiry");
    const seeded = await seedSource(sourceRef, "v1");
    const guard = await claimOwnJobAt(
      sourceRef,
      "v1",
      seeded.generation,
      [dependencyOf(sourceRef, seeded.generation)],
      new Date(Date.now() - WORK_LEASE_MS - 1_000)
    );

    const outcome = await stageReal(sourceRef, seeded, guard);
    expect(outcome.staged).toBe(false);
    expect(outcome.code).toBe("lease_lost");
    expect(await stageRowCount(sourceRef)).toBe(0);
    expect(await servingMembership(sourceRef)).toEqual([]);
  });

  it("an absolute-deadline breach cannot stage", async () => {
    const sourceRef = unique("deadline");
    const seeded = await seedSource(sourceRef, "v1");
    const guard = await claimOwnJobAt(
      sourceRef,
      "v1",
      seeded.generation,
      [dependencyOf(sourceRef, seeded.generation)],
      new Date(Date.now() - WORK_ABSOLUTE_LIMIT_MS - 1_000)
    );

    const outcome = await stageReal(sourceRef, seeded, guard);
    expect(outcome.staged).toBe(false);
    expect(outcome.code).toBe("execution_timeout");
    expect(await stageRowCount(sourceRef)).toBe(0);
  });

  it("a moved dependency generation cannot stage", async () => {
    const sourceRef = unique("dep-move");
    const dependencyRef = unique("dep-move-source");
    const dependency = await seedSource(dependencyRef, "v1");
    const seeded = await seedSource(sourceRef, "v1", [dependencyRef, sourceRef]);
    const guard = await claimOwnJob(sourceRef, "v1", seeded.generation, [
      dependencyOf(dependencyRef, dependency.generation),
      dependencyOf(sourceRef, seeded.generation),
    ]);

    const moved = await seedSource(dependencyRef, "v2", [dependencyRef, sourceRef]);
    expect(moved.generation).toBeGreaterThan(dependency.generation);

    const outcome = await stageReal(sourceRef, seeded, guard);
    expect(outcome.staged).toBe(false);
    expect(outcome.code).toBe("input_stale");
    expect(await stageRowCount(sourceRef)).toBe(0);
  });

  it("a dependency vector the job no longer hashes to cannot stage", async () => {
    const sourceRef = unique("dep-drift");
    const seeded = await seedSource(sourceRef, "v1");
    const dependencies = [dependencyOf(sourceRef, seeded.generation)];
    const guard = await claimOwnJob(sourceRef, "v1", seeded.generation, dependencies);

    await pool.query(
      `UPDATE maintenance_jobs SET input_dependencies = $2::jsonb WHERE job_key = $1`,
      [guard.jobKey, JSON.stringify([dependencyOf(sourceRef, seeded.generation, 7)])]
    );

    const outcome = await stageReal(sourceRef, seeded, guard);
    expect(outcome.staged).toBe(false);
    expect(outcome.code).not.toBeUndefined();
    expect(await stageRowCount(sourceRef)).toBe(0);
  });

  it("a config revision the job no longer carries cannot stage", async () => {
    const sourceRef = unique("config-drift");
    const seeded = await seedSource(sourceRef, "v1");
    const guard = await claimOwnJob(sourceRef, "v1", seeded.generation, [
      dependencyOf(sourceRef, seeded.generation),
    ]);

    await pool.query(
      `UPDATE maintenance_jobs SET config_revision = 'extractor-v2' WHERE job_key = $1`,
      [guard.jobKey]
    );

    const outcome = await stageReal(sourceRef, seeded, guard);
    expect(outcome.staged).toBe(false);
    expect(outcome.code).toBe("input_stale");
    expect(await stageRowCount(sourceRef)).toBe(0);
  });

  it("a generation that moved cannot stage or revert the source", async () => {
    const sourceRef = unique("aba");
    const first = await seedSource(sourceRef, "vA");
    const guardA = await claimOwnJob(sourceRef, "vA", first.generation, [
      dependencyOf(sourceRef, first.generation),
    ]);

    const b = await seedSource(sourceRef, "vB");
    const a = await seedSource(sourceRef, "vA");
    expect(a.generation).toBeGreaterThan(b.generation);

    const outcome = await stageReal(sourceRef, a, guardA);
    expect(outcome.staged).toBe(false);
    expect(outcome.code).toBe("input_stale");
    expect(await stageRowCount(sourceRef)).toBe(0);
    expect(await currentGeneration(sourceRef)).toBe(a.generation);
    expect(await publishedPair(sourceRef)).toEqual({
      sourceVersion: null,
      extractionRevision: null,
    });
  });

  it("a settled attempt cannot stage", async () => {
    const sourceRef = unique("settled");
    const seeded = await seedSource(sourceRef, "v1");
    const dependencies = [dependencyOf(sourceRef, seeded.generation)];
    const guard = await claimOwnJob(sourceRef, "v1", seeded.generation, dependencies);

    clock.set(new Date());
    await work.settleWork(
      guard,
      { status: "failed", failureCode: "backend_unavailable" },
      { configRevision: CONFIG_REVISION, dependencies },
      clock()
    );

    const outcome = await stageReal(sourceRef, seeded, guard);
    expect(outcome.staged).toBe(false);
    expect(outcome.code).toBe("lease_lost");
    expect(await stageRowCount(sourceRef)).toBe(0);
  });

  it("a withdrawn source cannot stage", async () => {
    const sourceRef = unique("withdrawn");
    const seeded = await seedSource(sourceRef, "v1");
    const guard = await claimOwnJob(sourceRef, "v1", seeded.generation, [
      dependencyOf(sourceRef, seeded.generation),
    ]);

    await publication.withdraw({
      scopeBinding: SCOPE_BINDING,
      sourceRef,
      expectedGeneration: seeded.generation,
      at: clock().toISOString(),
    });

    const outcome = await stageReal(sourceRef, seeded, guard);
    expect(outcome.staged).toBe(false);
    expect(outcome.code).toBe("input_stale");
    expect(await stageRowCount(sourceRef)).toBe(0);
  });

  it("the last permitted automatic attempt may still stage", async () => {
    const sourceRef = unique("last-attempt");
    const seeded = await seedSource(sourceRef, "v1");
    const dependencies = [dependencyOf(sourceRef, seeded.generation)];
    const deps = { store: work, clock: () => clock() };
    const scheduled = await scheduleWork(
      deps,
      { actorId: ACTOR },
      publishRequest(sourceRef, "v1", seeded.generation, dependencies)
    );
    if ("refused" in scheduled) {
      throw new Error(`scheduleWork refused: ${scheduled.refused}`);
    }

    let finalGuard: MaintenanceAttemptGuard | null = null;
    for (let round = 0; round < MAX_AUTO_ATTEMPTS; round += 1) {
      clock.set(new Date(Date.now() + round * 60_000));
      let mine: MaintenanceAttemptGuard | null = null;
      for (let attempt = 0; attempt < DRAIN_LIMIT; attempt += 1) {
        const candidate = (await claimNextWork(deps)).guard;
        if (candidate === null) break;
        if (candidate.jobKey === scheduled.record.jobKey) {
          mine = candidate;
          break;
        }
        await pool.query(
          `UPDATE maintenance_jobs
              SET status = 'stale', last_failure_code = 'input_stale',
                  next_attempt_at = NULL, fencing_token = NULL,
                  lease_expires_at = NULL, attempt_started_at = NULL
            WHERE job_key = $1`,
          [candidate.jobKey]
        );
      }
      if (mine === null) throw new Error(`round ${round} could not claim the job`);
      finalGuard = mine;
      const { rows } = await pool.query(
        `SELECT auto_attempt_count, max_attempts FROM maintenance_jobs
          WHERE job_key = $1`,
        [mine.jobKey]
      );
      expect(Number(rows[0].auto_attempt_count)).toBe(round + 1);
      if (round + 1 < MAX_AUTO_ATTEMPTS) {
        await work.settleWork(
          mine,
          { status: "failed", failureCode: "backend_unavailable" },
          { configRevision: CONFIG_REVISION, dependencies },
          clock()
        );
      }
    }
    if (finalGuard === null) throw new Error("no attempt was ever claimed");
    const live = await pool.query(
      `SELECT auto_attempt_count, max_attempts, status FROM maintenance_jobs
        WHERE job_key = $1`,
      [finalGuard.jobKey]
    );
    expect(Number(live.rows[0].auto_attempt_count)).toBe(MAX_AUTO_ATTEMPTS);
    expect(Number(live.rows[0].max_attempts)).toBe(MAX_AUTO_ATTEMPTS);
    expect(live.rows[0].status).toBe("running");

    // EXIT: the automatic budget is spent exactly on the final permitted
    // attempt, which is still `running` and must still be able to stage. A
    // fence reading `auto_attempt_count >= max_attempts` would refuse this
    // legitimate write.
    const outcome = await stageReal(sourceRef, seeded, finalGuard);
    expect(outcome).toEqual({ staged: true });
    expect(await stageRowCount(sourceRef)).toBe(1);
  });

  it("a refused replacement leaves the prior publication intact", async () => {
    const sourceRef = unique("failed-replacement");
    const seeded = await seedSource(sourceRef, "v1");
    const firstAttempt = await claimOwnJob(sourceRef, "v1", seeded.generation, [
      dependencyOf(sourceRef, seeded.generation),
    ]);
    const entityId = nextEntityId();
    const staged = await stageReal(sourceRef, seeded, firstAttempt, entityId);
    expect(staged).toEqual({ staged: true });
    clock.set(new Date());
    const published = await publication.publish({
      scopeBinding: SCOPE_BINDING,
      sourceRef,
      guard: firstAttempt,
      at: clock().toISOString(),
    });
    expect(published).toMatchObject({ published: true });
    const servingBefore = await servingMembership(sourceRef);
    const pairBefore = await publishedPair(sourceRef);
    expect(servingBefore).toEqual([{ subject: "entity", result_id: entityId }]);
    expect(pairBefore).toEqual({ sourceVersion: "v1", extractionRevision: 1 });

    const replacement = await seedSource(sourceRef, "v2");
    const secondAttempt = await claimOwnJobAt(
      sourceRef,
      "v2",
      replacement.generation,
      [dependencyOf(sourceRef, replacement.generation, 1)],
      new Date(Date.now() - WORK_LEASE_MS - 1_000)
    );
    const refused = await stageReal(sourceRef, replacement, secondAttempt);
    expect(refused.staged).toBe(false);
    expect(refused.code).toBe("lease_lost");

    expect(await servingMembership(sourceRef)).toEqual(servingBefore);
    expect(await publishedPair(sourceRef)).toEqual(pairBefore);
    expect(await stageRowCount(sourceRef)).toBe(0);
  });
});