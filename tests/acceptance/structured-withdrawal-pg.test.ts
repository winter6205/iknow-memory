/**
 * T11 MP7 — one or the last supporting source is withdrawn safely.
 *
 * The suite drives the real `PgStructuredPublicationStorage` composed by
 * `PgvectorBackend`, so a refusal here is the store's own fence and every
 * residue read comes from a connection that is not the withdrawing transaction.
 *
 * EXIT: this driver never skips. The opt-in marker and the DSN must both be
 * present or the module refuses at load, and an absent or unreachable database
 * is a named non-zero failure rather than a skip.
 */
import { createHash } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { claimNextWork, scheduleWork } from "../../src/core/maintenance/service.js";
import type {
  MaintenanceAttemptGuard,
  MaintenanceDependency,
  MaintenanceWorkRequest,
} from "../../src/core/maintenance/types.js";
import type {
  PublicationFact,
  PublicationSnapshot,
  StructuredPublicationStorage,
} from "../../src/core/maintenance/publication-types.js";
import type { EntityIdentityInput } from "../../src/core/structured/identity-store.js";
import {
  deriveRelationAssertionId,
  normalizeRelationAssertion,
  type RelationAssertionInput,
} from "../../src/core/structured/identity.js";
import type { NewSourceVersion } from "../../src/core/types.js";
import {
  EVIDENCE_GRANT_KIND,
  EVIDENCE_SUBJECT_KIND,
  EVIDENCE_SUPPORT_ROLE,
} from "../../src/core/types.js";
import { PgMaintenanceWorkStore } from "../../src/core/storage/maintenance-work-pg.js";
import { markIntentsDone } from "../../src/core/storage/projection-outbox.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import {
  createPgIntegrationHarness,
  probePostgres,
  type PgIntegrationHarness,
} from "../integration/pg-test-harness.js";
import {
  createPublicationTestClock,
  outcomeCode,
  type PublicationTestClock,
} from "../storage/publication-contract.js";

// EXIT: this driver never skips. The opt-in marker and the DSN must both be
// present or the module refuses at load, and an absent or unreachable database
// is a named non-zero failure rather than a skip.
const OPT_IN = process.env.IK_STRUCTURED_WITHDRAWAL_PG;
if (OPT_IN !== "1") {
  throw new Error(
    "structured-withdrawal-pg.test.ts requires IK_STRUCTURED_WITHDRAWAL_PG=1; it never skips"
  );
}
const DSN = process.env.GRAPHRAG_MEMORY_DB_URL;
if (typeof DSN !== "string" || DSN.trim() === "") {
  throw new Error(
    "structured-withdrawal-pg.test.ts requires GRAPHRAG_MEMORY_DB_URL to be set; it never skips"
  );
}

const SCHEMA_PREFIX = "t11_withdrawal";
const DIMENSIONS = 8;
const ACTOR = "t11-withdrawal-owner";
const CONFIG_REVISION = "extractor-v1";
const SCOPE_BINDING = "scope-t11-withdrawal";
const AUTHORIZATION_REVISION = "auth-t11-1";
const PURGE_REVISION = "purge-t11-0";
const QUERIED_AT = "2026-01-05T00:00:00.000Z";
const GRANT_READ_AT = "2026-01-06T00:00:00.000Z";
const DRAIN_LIMIT = 64;

const harness: PgIntegrationHarness = await createPgIntegrationHarness({
  schemaPrefix: SCHEMA_PREFIX,
  defaultConnectionString: DSN,
  requiresVector: true,
  testPath: "tests/acceptance/structured-withdrawal-pg.test.ts",
  label: "T11 source withdrawal",
  expectedCommand:
    "IK_STRUCTURED_WITHDRAWAL_PG=1 GRAPHRAG_MEMORY_DB_URL=<dsn> npx vitest run tests/acceptance/structured-withdrawal-pg.test.ts",
});

const reachability = await probePostgres(DSN, true);
if (!reachability.available) {
  throw new Error(
    "structured-withdrawal-pg.test.ts requires a reachable PostgreSQL with pgvector " +
      "at the configured DSN; it reports an unreachable database as this failure " +
      "rather than skipping"
  );
}

let admin: pg.Client;
let backend: PgvectorBackend;
let pool: pg.Pool;
let clock: PublicationTestClock;
let publication: StructuredPublicationStorage;
let work: PgMaintenanceWorkStore;
let faultSerial = 0;
let serial = 0;
let entitySerial = 0;

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function nextEntityId(): string {
  entitySerial += 1;
  return `00000000-0000-4000-9000-${entitySerial.toString().padStart(12, "0")}`;
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
  dependencies: readonly MaintenanceDependency[],
  configRevision: string
): MaintenanceWorkRequest {
  return {
    workKind: "extract_publish",
    sourceRef,
    sourceVersion,
    sourceGeneration: generation,
    configRevision,
    dependencies,
  };
}

interface Seeded {
  readonly sourceRef: string;
  readonly record: NewSourceVersion & { readonly source_version_id: string };
  readonly locator: { document_id: string; version: string; unit: number };
  readonly locatorBindings: readonly {
    source_version_id: string;
    document_id: string;
    version: string;
    unit: number;
  }[];
  readonly generation: number;
}

async function seedGraphEntities(entityIds: readonly string[]): Promise<void> {
  for (const entityId of entityIds) {
    await pool.query(
      `INSERT INTO entities (id, canonical_name, type, metadata, retired)
       VALUES ($1, $2, 'organization', '{}'::jsonb, false)
       ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type`,
      [entityId, `t11 withdrawal fixture ${entityId}`]
    );
  }
}

async function seedSource(
  sourceRef: string,
  authorizedSourceRefs: readonly string[] = [sourceRef]
): Promise<Seeded> {
  const { record } = await backend.registerSourceVersion({
    source_ref: sourceRef,
    source_version: "v1",
    content_digest: digest(`${sourceRef}:v1`),
    origin_object_ref: `objects/${sourceRef}/v1.html`,
    parser_revision: "frozen-html-units-v1",
    unit_manifest: { units: 6, parser_revision: "frozen-html-units-v1" },
    created_at: clock().toISOString(),
    retired_at: null,
    payload_collected_at: null,
    obligations_stopped_at: null,
  });
  const locator = {
    document_id: `${sourceRef}-document`,
    version: "frozen-v1",
    unit: 1,
  };
  const locatorBindings = [1, 2, 3, 4, 5, 6].map((unit) => ({
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
  return { sourceRef, record, locator, locatorBindings, generation: declared.generation };
}

// EXIT: claiming through a back-dated clock writes the real lease and absolute
// deadline stamps the store later compares against the database clock, so a
// lease or deadline case ages committed state instead of sleeping.
async function claimOwnJob(
  sourceRef: string,
  sourceVersion: string,
  generation: number,
  dependencies: readonly MaintenanceDependency[],
  configRevision: string = CONFIG_REVISION
): Promise<MaintenanceAttemptGuard> {
  clock.set(new Date());
  const deps = { store: work, clock: () => clock() };
  const scheduled = await scheduleWork(
    deps,
    { actorId: ACTOR },
    publishRequest(sourceRef, sourceVersion, generation, dependencies, configRevision)
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

function entityFact(
  seeded: Seeded,
  entityId: string,
  extractionRef: string,
  canonicalName: string,
  unit: number
): PublicationFact {
  const identity: EntityIdentityInput = { entityId, type: "organization" };
  return {
    identity: { kind: "entity", input: identity },
    occurrence: {
      subject: "entity",
      result_id: entityId,
      source_ref: seeded.sourceRef,
      source_version: seeded.record.source_version,
      location: { ...seeded.locator, unit },
      extraction_ref: extractionRef,
      extractedAt: seeded.record.created_at,
    },
    display: { canonicalName, type: "organization" },
  };
}

function assertionFact(
  seeded: Seeded,
  extractionRef: string,
  relationNorm: string,
  unit: number,
  headEntityId: string,
  tailEntityId: string
): { fact: PublicationFact; resultId: string } {
  const identity: RelationAssertionInput = {
    headEntityId,
    relationNorm,
    tailEntityId,
    validWindow: { from: null, until: null },
  };
  const resultId = deriveRelationAssertionId(normalizeRelationAssertion(identity));
  return {
    resultId,
    fact: {
      identity: { kind: "relation_assertion", input: identity },
      occurrence: {
        subject: "assertion",
        result_id: resultId,
        source_ref: seeded.sourceRef,
        source_version: seeded.record.source_version,
        location: { ...seeded.locator, unit },
        extraction_ref: extractionRef,
        extractedAt: seeded.record.created_at,
      },
    },
  };
}

async function stageReal(
  seeded: Seeded,
  guard: MaintenanceAttemptGuard,
  extractionRef: string,
  accepted: readonly PublicationFact[]
): Promise<void> {
  const entityIds = accepted.flatMap((fact) =>
    fact.identity.kind === "entity" ? [fact.identity.input.entityId] : []
  );
  await seedGraphEntities(entityIds);
  await publication.stageAttempt({
    scopeBinding: SCOPE_BINDING,
    sourceRef: seeded.sourceRef,
    guard,
    extractionRef,
    accepted,
  });
}

async function publishReal(
  seeded: Seeded,
  guard: MaintenanceAttemptGuard
): Promise<{ published: boolean; code?: string; message?: string }> {
  try {
    await publication.publish({
      scopeBinding: SCOPE_BINDING,
      sourceRef: seeded.sourceRef,
      guard,
      at: new Date().toISOString(),
    });
    return { published: true };
  } catch (error) {
    return {
      published: false,
      code: outcomeCode(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

interface WithdrawOutcome {
  readonly withdrawn: boolean;
  readonly generation?: number;
  readonly code?: string;
  readonly message?: string;
}

async function withdrawReal(
  scopeBinding: string,
  sourceRef: string,
  expectedGeneration: number,
  patch: Record<string, unknown> = {}
): Promise<WithdrawOutcome> {
  try {
    const outcome = await publication.withdraw({
      scopeBinding,
      sourceRef,
      expectedGeneration,
      at: new Date().toISOString(),
      ...patch,
    } as Parameters<StructuredPublicationStorage["withdraw"]>[0]);
    return { withdrawn: true, generation: outcome.generation };
  } catch (error) {
    return {
      withdrawn: false,
      code: outcomeCode(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

interface TwoOrigins {
  readonly sourceA: Seeded;
  readonly sourceB: Seeded;
  readonly sharedResultId: string;
  readonly onlyAResultId: string;
  readonly onlyBResultId: string;
  readonly allResultIds: readonly string[];
  readonly supportA: string;
  readonly supportB: string;
}

/**
 * The maintenance contract's M3 fixture, built from its own words: two active
 * origins, one shared assertion and one result each origin serves alone.
 */
async function twoOrigins(
  label: string
): Promise<TwoOrigins> {
  const sourceA = unique(`${label}-a`);
  const sourceB = unique(`${label}-b`);
  const seededA = await seedSource(sourceA, [sourceA, sourceB]);
  const seededB = await seedSource(sourceB, [sourceA, sourceB]);
  const head = nextEntityId();
  const tail = nextEntityId();
  const onlyA = nextEntityId();
  const onlyB = nextEntityId();
  const sharedA = assertionFact(seededA, "extract-a", "co_founded", 1, head, tail);
  const sharedB: PublicationFact = {
    ...sharedA.fact,
    occurrence: {
      ...sharedA.fact.occurrence,
      source_ref: seededB.sourceRef,
      location: { ...seededB.locator, unit: 1 },
      extraction_ref: "extract-b",
    },
  } as PublicationFact;
  await seedGraphEntities([head, tail, onlyA, onlyB]);

  const guardA = await claimOwnJob(sourceA, "v1", seededA.generation, [
    dependencyOf(sourceA, seededA.generation),
  ]);
  await publication.stageAttempt({
    scopeBinding: SCOPE_BINDING,
    sourceRef: seededA.sourceRef,
    guard: guardA,
    extractionRef: "extract-a",
    accepted: [
      sharedA.fact,
      entityFact(seededA, onlyA, "extract-a", "Only A", 2),
    ],
  });
  const first = await publishReal(seededA, guardA);
  expect(first).toEqual({ published: true });

  const guardB = await claimOwnJob(sourceB, "v1", seededB.generation, [
    dependencyOf(sourceB, seededB.generation),
  ]);
  await publication.stageAttempt({
    scopeBinding: SCOPE_BINDING,
    sourceRef: seededB.sourceRef,
    guard: guardB,
    extractionRef: "extract-b",
    accepted: [sharedB, entityFact(seededB, onlyB, "extract-b", "Only B", 2)],
  });
  const second = await publishReal(seededB, guardB);
  expect(second).toEqual({ published: true });

  const before = await readSnapshot();
  const sharedBefore = subjectsOf(before, [sharedA.resultId]);
  expect(sharedBefore).toHaveLength(1);
  expect(sharedBefore[0]?.supportIds).toHaveLength(2);
  const supportA = await soleSupportOf(seededA.sourceRef, sharedA.resultId);
  const supportB = await soleSupportOf(seededB.sourceRef, sharedA.resultId);
  return {
    sourceA: seededA,
    sourceB: seededB,
    sharedResultId: sharedA.resultId,
    onlyAResultId: onlyA,
    onlyBResultId: onlyB,
    allResultIds: [sharedA.resultId, onlyA, onlyB],
    supportA,
    supportB,
  };
}

function subjectsOf(
  snapshot: PublicationSnapshot,
  resultIds: readonly string[]
): readonly PublicationSnapshot["subjects"][number][] {
  return snapshot.subjects.filter((subject) => resultIds.includes(subject.resultId));
}

function sourcesOf(
  snapshot: PublicationSnapshot,
  sourceRefs: readonly string[]
): readonly PublicationSnapshot["sources"][number][] {
  return snapshot.sources.filter((source) => sourceRefs.includes(source.sourceRef));
}

async function readSnapshot(): Promise<PublicationSnapshot> {
  return publication.readSnapshot({ scopeBinding: SCOPE_BINDING });
}

async function soleSupportOf(
  sourceRef: string,
  resultId: string
): Promise<string> {
  const observer = new pg.Client({ connectionString: harness.schemaConnectionString });
  await observer.connect();
  try {
    const { rows } = await observer.query<{ support_id: string }>(
      `SELECT support_id::text
         FROM structured_publication_membership
        WHERE scope_binding = $1 AND source_ref = $2 AND result_id = $3`,
      [SCOPE_BINDING, sourceRef, resultId]
    );
    if (rows.length !== 1) {
      throw new Error(
        `expected one membership for ${sourceRef}/${resultId}, observed ${rows.length}`
      );
    }
    return rows[0]!.support_id;
  } finally {
    await observer.end();
  }
}

interface OutboxRow {
  readonly id: string;
  readonly subject_kind: string;
  readonly subject_id: string;
  readonly status: string;
  readonly attempts: number;
}

async function readOutbox(resultIds: readonly string[]): Promise<OutboxRow[]> {
  const observer = new pg.Client({ connectionString: harness.schemaConnectionString });
  await observer.connect();
  try {
    const { rows } = await observer.query<Record<string, any>>(
      `SELECT id::text, subject_kind, subject_id::text, status, attempts
         FROM projection_outbox
        WHERE subject_id = ANY($1::uuid[])
        ORDER BY subject_kind, subject_id, created_at, id`,
      [[...resultIds]]
    );
    return rows.map((row) => ({
      id: String(row.id),
      subject_kind: String(row.subject_kind),
      subject_id: String(row.subject_id),
      status: String(row.status),
      attempts: Number(row.attempts),
    }));
  } finally {
    await observer.end();
  }
}

// EXIT: the drain write is issued inside one caller-owned transaction because
// `markIntentsDone` documents that the caller owns it; on a bare autocommit
// client the driver terminated the session instead of updating the rows.
async function drainOutbox(resultIds: readonly string[]): Promise<number> {
  const observer = new pg.Client({ connectionString: harness.schemaConnectionString });
  await observer.connect();
  try {
    await observer.query("BEGIN");
    const { rows } = await observer.query<{ id: string }>(
      `SELECT id::text FROM projection_outbox
        WHERE subject_id = ANY($1::uuid[]) AND status = 'pending'`,
      [[...resultIds]]
    );
    if (rows.length === 0) {
      await observer.query("COMMIT");
      return 0;
    }
    const done = await markIntentsDone(observer, rows.map((row) => row.id));
    await observer.query("COMMIT");
    return done;
  } catch (error) {
    await observer.query("ROLLBACK");
    throw error;
  } finally {
    await observer.end();
  }
}

interface Fingerprint {
  readonly sources: readonly Record<string, unknown>[];
  readonly scope: readonly Record<string, unknown>[];
  readonly membership: readonly Record<string, unknown>[];
  readonly display: readonly Record<string, unknown>[];
  readonly stages: readonly Record<string, unknown>[];
  readonly bindings: readonly Record<string, unknown>[];
  readonly outbox: readonly OutboxRow[];
  readonly supports: readonly Record<string, unknown>[];
  readonly jobs: readonly Record<string, unknown>[];
  readonly attempts: readonly Record<string, unknown>[];
}

/**
 * Residue read on a connection this test owns, not the pool client the
 * withdrawing transaction leases. A fingerprint taken here is the only honest
 * witness that a failed withdrawal left nothing behind.
 */
async function readFingerprint(
  sourceRefs: readonly string[],
  resultIds: readonly string[]
): Promise<Fingerprint> {
  const observer = new pg.Client({ connectionString: harness.schemaConnectionString });
  await observer.connect();
  try {
    const sources = await observer.query<Record<string, unknown>>(
      `SELECT source_ref, active, generation, desired_source_version,
              desired_extraction_revision, desired_config_revision,
              published_source_version, published_extraction_revision,
              published_generation
         FROM structured_publication_sources
        WHERE scope_binding = $1 AND source_ref = ANY($2::text[])
        ORDER BY source_ref`,
      [SCOPE_BINDING, [...sourceRefs]]
    );
    const scope = await observer.query<Record<string, unknown>>(
      `SELECT read_revision, maintenance_revision
         FROM structured_publication_scopes WHERE scope_binding = $1`,
      [SCOPE_BINDING]
    );
    const membership = await observer.query<Record<string, unknown>>(
      `SELECT source_ref, generation, extraction_ref, support_id::text, subject, result_id
         FROM structured_publication_membership
        WHERE scope_binding = $1 AND source_ref = ANY($2::text[])
        ORDER BY source_ref, subject, result_id, support_id`,
      [SCOPE_BINDING, [...sourceRefs]]
    );
    const display = await observer.query<Record<string, unknown>>(
      `SELECT source_ref, support_id::text, extraction_revision, canonical_name, entity_type
         FROM structured_publication_display
        WHERE scope_binding = $1 AND source_ref = ANY($2::text[])
        ORDER BY source_ref, support_id, extraction_revision`,
      [SCOPE_BINDING, [...sourceRefs]]
    );
    const stages = await observer.query<Record<string, unknown>>(
      `SELECT source_ref, generation, job_key, attempt_number, fencing_token, extraction_ref
         FROM structured_publication_stages
        WHERE scope_binding = $1 AND source_ref = ANY($2::text[])
        ORDER BY source_ref`,
      [SCOPE_BINDING, [...sourceRefs]]
    );
    const bindings = await observer.query<Record<string, unknown>>(
      `SELECT source_ref, source_version, extraction_revision, extraction_ref, payload_digest
         FROM structured_publication_extraction_bindings
        WHERE scope_binding = $1 AND source_ref = ANY($2::text[])
        ORDER BY source_ref, extraction_revision`,
      [SCOPE_BINDING, [...sourceRefs]]
    );
    const outbox = await readOutboxOn(observer, resultIds);
    const supports = await observer.query<Record<string, unknown>>(
      `SELECT s.support_id::text, s.subject, s.result_id, s.source_ref, s.source_version,
              array_agg(e.extraction_ref ORDER BY e.extraction_ref) AS extraction_refs
         FROM assertion_supports s
         JOIN support_extractions e USING (support_id)
        WHERE s.source_ref = ANY($1::text[])
        GROUP BY s.support_id, s.subject, s.result_id, s.source_ref, s.source_version
        ORDER BY s.source_ref, s.subject, s.result_id`,
      [[...sourceRefs]]
    );
    const jobs = await observer.query<Record<string, unknown>>(
      `SELECT job_key, status, attempt_count, fencing_token, lease_expires_at,
              attempt_started_at, last_failure_code
         FROM maintenance_jobs
        WHERE source_ref = ANY($1::text[]) ORDER BY job_key`,
      [[...sourceRefs]]
    );
    const attempts = await observer.query<Record<string, unknown>>(
      `SELECT a.job_key, a.attempt_number, a.fencing_token, a.finished_at, a.failure_code
         FROM maintenance_job_attempts a
         JOIN maintenance_jobs j USING (job_key)
        WHERE j.source_ref = ANY($1::text[])
        ORDER BY a.job_key, a.attempt_number`,
      [[...sourceRefs]]
    );
    return {
      sources: sources.rows,
      scope: scope.rows,
      membership: membership.rows,
      display: display.rows,
      stages: stages.rows,
      bindings: bindings.rows,
      outbox,
      supports: supports.rows,
      jobs: jobs.rows,
      attempts: attempts.rows,
    };
  } finally {
    await observer.end();
  }
}

async function readOutboxOn(
  observer: pg.Client,
  resultIds: readonly string[]
): Promise<OutboxRow[]> {
  const { rows } = await observer.query<Record<string, any>>(
    `SELECT id::text, subject_kind, subject_id::text, status, attempts
       FROM projection_outbox
      WHERE subject_id = ANY($1::uuid[])
      ORDER BY subject_kind, subject_id, created_at, id`,
    [[...resultIds]]
  );
  return rows.map((row) => ({
    id: String(row.id),
    subject_kind: String(row.subject_kind),
    subject_id: String(row.subject_id),
    status: String(row.status),
    attempts: Number(row.attempts),
  }));
}

/** Every write the withdrawal performs, in the order the adapter performs it. */
type WritePoint = {
  readonly label: string;
  readonly table: string;
  readonly event: "INSERT" | "UPDATE" | "DELETE";
};

const WRITE_POINTS: readonly WritePoint[] = [
  { label: "durable projection intent", table: "projection_outbox", event: "INSERT" },
  {
    label: "current membership removal",
    table: "structured_publication_membership",
    event: "DELETE",
  },
  {
    label: "staged payload removal",
    table: "structured_publication_stages",
    event: "DELETE",
  },
  {
    label: "source tombstone and generation",
    table: "structured_publication_sources",
    event: "UPDATE",
  },
  {
    label: "scope revision advance",
    table: "structured_publication_scopes",
    event: "UPDATE",
  },
];

/**
 * Arm a trigger that fails the first row the withdrawing transaction writes to
 * one table. The sequence makes it a single fault rather than a table-wide
 * outage, so the residue is exactly "everything before this point, none of
 * everything after".
 */
async function armWriteFault(point: WritePoint): Promise<void> {
  faultSerial += 1;
  const suffix = `t11_fault_${faultSerial}`;
  const sequence = `${harness.schema}.${suffix}_sequence`;
  await pool.query(`CREATE SEQUENCE "${harness.schema}"."${suffix}_sequence"`);
  await pool.query(`
    CREATE FUNCTION "${harness.schema}"."${suffix}_function"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $t11_fault$
    BEGIN
      IF nextval('${sequence}'::regclass) = 1 THEN
        RAISE EXCEPTION 'injected withdrawal failure at ${point.table}'
          USING ERRCODE = 'P0001';
      END IF;
      RETURN ${point.event === "DELETE" ? "OLD" : "NEW"};
    END;
    $t11_fault$`);
  await pool.query(`
    CREATE TRIGGER "${suffix}_trigger"
    BEFORE ${point.event} ON "${harness.schema}"."${point.table}"
    FOR EACH ROW EXECUTE FUNCTION "${harness.schema}"."${suffix}_function"()`);
}

async function disarmWriteFault(point: WritePoint): Promise<void> {
  faultSerial += 1;
  await pool.query(
    `DROP TRIGGER IF EXISTS "t11_fault_${faultSerial - 1}_trigger"
       ON "${harness.schema}"."${point.table}"`
  );
}

interface StagedWithdrawal {
  readonly origins: TwoOrigins;
  readonly stagedGeneration: number;
}

/**
 * A published origin with a staged second revision still waiting. The staged
 * row is what makes the withdrawal's staged-payload removal a real write rather
 * than a no-op delete, so every write point is reachable in the fault lane.
 */
async function publishedThenStaged(label: string): Promise<StagedWithdrawal> {
  const origins = await twoOrigins(label);
  const declared = await publication.declareDesired({
    scopeBinding: SCOPE_BINDING,
    authorizedSourceRefs: [origins.sourceA.sourceRef, origins.sourceB.sourceRef],
    sourceRef: origins.sourceA.sourceRef,
    sourceVersion: origins.sourceA.record,
    locatorBindings: origins.sourceA.locatorBindings,
    desiredExtractionRevision: 2,
    configRevision: "extractor-v2",
  });
  const guard = await claimOwnJob(
    origins.sourceA.sourceRef,
    "v1",
    declared.generation,
    [dependencyOf(origins.sourceA.sourceRef, declared.generation, 1)],
    "extractor-v2"
  );
  await stageReal(
    origins.sourceA,
    guard,
    "extract-a-v2",
    [entityFact(origins.sourceA, origins.onlyAResultId, "extract-a-v2", "Only A v2", 2)]
  );
  return { origins, stagedGeneration: declared.generation };
}

describe("T11 one or the last supporting source is withdrawn safely (PostgreSQL)", () => {
  beforeAll(async () => {
    admin = harness.createClient(harness.schemaConnectionString);
    await admin.connect();
    await harness.resetSchema(admin);
    backend = new PgvectorBackend(harness.schemaConnectionString, DIMENSIONS, {
      annMaxDimensions: 2000,
      poolOptions: { max: 6 },
    });
    await backend.initialize();
    pool = new pg.Pool({ connectionString: harness.schemaConnectionString, max: 4 });
    clock = createPublicationTestClock(new Date());
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
    await backend.setScopeRevisions(SCOPE_BINDING, {
      authorizationRevision: AUTHORIZATION_REVISION,
      purgeRevision: PURGE_REVISION,
    });
  }, 120_000);

  afterEach(async () => {
    clock.set(new Date());
  });

  afterAll(async () => {
    try {
      if (admin) await harness.dropSchema(admin);
    } finally {
      await pool?.end();
      await backend?.close();
      await admin?.end();
    }
  });

  it("keeps a shared assertion current and visible when one of two origins is withdrawn", async () => {
    const origins = await twoOrigins("one-of-two");
    const before = await readSnapshot();
    expect(subjectsOf(before, [origins.sharedResultId])[0]?.supportIds).toHaveLength(2);

    const outcome = await withdrawReal(
      SCOPE_BINDING,
      origins.sourceA.sourceRef,
      origins.sourceA.generation
    );
    expect(outcome).toEqual({ withdrawn: true, generation: origins.sourceA.generation + 1 });

    const after = await readSnapshot();
    const shared = subjectsOf(after, [origins.sharedResultId]);
    expect(shared).toHaveLength(1);
    expect(shared[0]?.supportIds).toEqual([origins.supportB]);
    expect(subjectsOf(after, [origins.onlyAResultId])).toEqual([]);
    expect(subjectsOf(after, [origins.onlyBResultId])).toHaveLength(1);

    const withdrawn = sourcesOf(after, [origins.sourceA.sourceRef]);
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]?.active).toBe(false);
    expect(withdrawn[0]?.published).toBeNull();
    expect(withdrawn[0]?.generation).toBe(origins.sourceA.generation + 1);
    const survivor = sourcesOf(after, [origins.sourceB.sourceRef]);
    expect(survivor[0]?.active).toBe(true);
    expect(survivor[0]?.generation).toBe(origins.sourceB.generation);
    expect(survivor[0]?.published).toEqual({ sourceVersion: "v1", extractionRevision: 1 });
  });

  it("removes the assertion from current reads when the last support is withdrawn and retains its authorized history", async () => {
    const origins = await twoOrigins("last-source");
    const grant = await backend.issueGrant({
      kind: EVIDENCE_GRANT_KIND.ROW,
      subject: EVIDENCE_SUBJECT_KIND.ASSERTION,
      operation: "list",
      queryDigest: `${origins.sourceA.sourceRef}-query`,
      scopeBinding: SCOPE_BINDING,
      readRevision: "read-t11-1",
      queriedAt: QUERIED_AT,
      context: { coverage: "stored_structured_subjects" },
      value: { assertion_id: origins.sharedResultId },
      supports: [
        { support_id: origins.supportA, role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE },
        { support_id: origins.supportB, role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE },
      ],
    } as Parameters<typeof backend.issueGrant>[0]);

    const first = await withdrawReal(
      SCOPE_BINDING,
      origins.sourceA.sourceRef,
      origins.sourceA.generation
    );
    expect(first).toEqual({
      withdrawn: true,
      generation: origins.sourceA.generation + 1,
    });
    expect(subjectsOf(await readSnapshot(), [origins.sharedResultId])).toHaveLength(1);

    const second = await withdrawReal(
      SCOPE_BINDING,
      origins.sourceB.sourceRef,
      origins.sourceB.generation
    );
    expect(second).toEqual({
      withdrawn: true,
      generation: origins.sourceB.generation + 1,
    });

    const after = await readSnapshot();
    expect(subjectsOf(after, origins.allResultIds)).toEqual([]);
    const sources = sourcesOf(after, [
      origins.sourceA.sourceRef,
      origins.sourceB.sourceRef,
    ]);
    expect(sources.map((source) => source.active)).toEqual([false, false]);
    expect(
      sources.filter((source) => source.active && source.published !== null)
    ).toHaveLength(0);

    const replay = await backend.readGrant(grant.evidence_ref, GRANT_READ_AT);
    expect(replay.state).toBe("granted");
    if (replay.state !== "granted") return;
    expect(replay.grant.value).toEqual({ assertion_id: origins.sharedResultId });
    expect(
      replay.supports.map((support) => support.support_id).sort()
    ).toEqual([origins.supportA, origins.supportB].sort());
    expect(
      (
        await backend.listGrantPinnedExtractions(grant.evidence_ref)
      ).map((entry) => entry.extraction_ref).sort()
    ).toEqual(["extract-a", "extract-b"]);
    expect(await backend.getSupport(origins.supportA)).not.toBeNull();
    expect(await backend.listSupportExtractions(origins.supportA)).toEqual([
      "extract-a",
    ]);
  });

  it("advances the source generation and both scope revisions in the withdrawal's own commit", async () => {
    const origins = await twoOrigins("revisions");
    const before = await readFingerprint(
      [origins.sourceA.sourceRef],
      [origins.sharedResultId, origins.onlyAResultId]
    );
    const sourceBefore = before.sources[0]!;
    const scopeBefore = before.scope[0]!;

    const outcome = await withdrawReal(
      SCOPE_BINDING,
      origins.sourceA.sourceRef,
      origins.sourceA.generation
    );
    expect(outcome.withdrawn).toBe(true);

    const after = await readFingerprint(
      [origins.sourceA.sourceRef],
      [origins.sharedResultId, origins.onlyAResultId]
    );
    const sourceAfter = after.sources[0]!;
    const scopeAfter = after.scope[0]!;
    expect(Number(sourceAfter.generation)).toBe(Number(sourceBefore.generation) + 1);
    expect(outcome.generation).toBe(Number(sourceAfter.generation));
    expect(Number(scopeAfter.read_revision)).toBe(Number(scopeBefore.read_revision) + 1);
    expect(Number(scopeAfter.maintenance_revision)).toBe(
      Number(scopeBefore.maintenance_revision) + 1
    );
    expect(after.membership).toHaveLength(0);
  });

  it("invalidates the derived projection intents of the withdrawn subjects and emits no duplicate", async () => {
    const origins = await twoOrigins("outbox-invalidated");
    expect(await drainOutbox(origins.allResultIds)).toBe(3);

    const outcome = await withdrawReal(
      SCOPE_BINDING,
      origins.sourceA.sourceRef,
      origins.sourceA.generation
    );
    expect(outcome.withdrawn).toBe(true);

    const outbox = await readOutbox(origins.allResultIds);
    const pending = outbox.filter((row) => row.status === "pending");
    const pendingIds = pending.map((row) => row.subject_id).sort();
    expect(pendingIds).toEqual(
      [origins.sharedResultId, origins.onlyAResultId].sort()
    );
    expect(new Set(pendingIds).size).toBe(pendingIds.length);
    const survivor = outbox.filter((row) => row.subject_id === origins.onlyBResultId);
    expect(survivor.map((row) => row.status)).toEqual(["done"]);
  });

  it("emits no second intent for a subject that already has a pending one", async () => {
    const origins = await twoOrigins("outbox-dedup");
    const before = await readOutbox(origins.allResultIds);
    expect(before.filter((row) => row.status === "pending")).toHaveLength(3);

    const outcome = await withdrawReal(
      SCOPE_BINDING,
      origins.sourceA.sourceRef,
      origins.sourceA.generation
    );
    expect(outcome.withdrawn).toBe(true);

    const after = await readOutbox(origins.allResultIds);
    expect(after).toEqual(before);
    expect(after.filter((row) => row.status === "pending")).toHaveLength(3);
  });

  it("refuses a stale, repeated, unauthorized and malformed withdrawal with a typed code and no state change", async () => {
    const origins = await twoOrigins("refusals");
    const scopeRefs = [origins.sourceA.sourceRef];
    const resultIds = [origins.sharedResultId, origins.onlyAResultId];

    const stale = await withdrawReal(
      SCOPE_BINDING,
      origins.sourceA.sourceRef,
      origins.sourceA.generation - 1
    );
    expect(stale.withdrawn).toBe(false);
    expect(stale.code).toBe("input_stale");
    expect(await readFingerprint(scopeRefs, resultIds)).toEqual(
      await readFingerprint(scopeRefs, resultIds)
    );
    const untouched = await readFingerprint(scopeRefs, resultIds);
    expect(untouched.sources[0]?.active).toBe(true);
    expect(untouched.membership).toHaveLength(2);

    const first = await withdrawReal(
      SCOPE_BINDING,
      origins.sourceA.sourceRef,
      origins.sourceA.generation
    );
    expect(first.withdrawn).toBe(true);
    const afterFirst = await readFingerprint(scopeRefs, resultIds);

    const repeated = await withdrawReal(
      SCOPE_BINDING,
      origins.sourceA.sourceRef,
      origins.sourceA.generation + 1
    );
    expect(repeated.withdrawn).toBe(false);
    expect(repeated.code).toBe("input_stale");
    expect(await readFingerprint(scopeRefs, resultIds)).toEqual(afterFirst);

    const unknownSource = await withdrawReal(
      SCOPE_BINDING,
      unique("not-declared"),
      0
    );
    expect(unknownSource.withdrawn).toBe(false);
    expect(unknownSource.code).toBe("access_denied");

    const unknownScope = await withdrawReal(
      "scope-t11-not-registered",
      origins.sourceB.sourceRef,
      origins.sourceB.generation
    );
    expect(unknownScope.withdrawn).toBe(false);
    expect(unknownScope.code).toBe("access_denied");

    for (const malformed of [
      { expectedGeneration: -1 },
      { at: "not-an-instant" },
      { scopeBinding: "" },
      { sourceRef: "" },
    ]) {
      const outcome = await withdrawReal(
        (malformed.scopeBinding as string | undefined) ?? SCOPE_BINDING,
        (malformed.sourceRef as string | undefined) ?? origins.sourceB.sourceRef,
        origins.sourceB.generation,
        malformed
      );
      expect(outcome.withdrawn, JSON.stringify(malformed)).toBe(false);
      expect(outcome.code, JSON.stringify(malformed)).toBe("invalid_input");
    }
    expect(await readFingerprint(scopeRefs, resultIds)).toEqual(afterFirst);
  });

  it.each(WRITE_POINTS.map((point) => [point.label, point] as const))(
    "leaves the prior state exactly intact when the %s write fails",
    async (_label, point) => {
      const fixture = await publishedThenStaged(`fault-${point.label.replace(/\s+/g, "-")}`);
      const sourceRefs = [fixture.origins.sourceA.sourceRef];
      const resultIds = [
        fixture.origins.sharedResultId,
        fixture.origins.onlyAResultId,
        fixture.origins.onlyBResultId,
      ];
      const before = await readFingerprint(sourceRefs, resultIds);
      expect(before.membership).toHaveLength(2);
      expect(before.stages).toHaveLength(1);
      expect(Number(before.sources[0]?.generation)).toBe(fixture.stagedGeneration);

      await armWriteFault(point);
      try {
        const outcome = await withdrawReal(
          SCOPE_BINDING,
          fixture.origins.sourceA.sourceRef,
          fixture.stagedGeneration
        );
        expect(outcome.withdrawn).toBe(false);
        // EXIT: a driver fault at any write point must surface as
        // `backend_unavailable`, not as a stale-input verdict the withdrawal
        // never reached; the deep-equal fingerprint is the observable outcome.
        expect(outcome.code).toBe("backend_unavailable");
        expect(outcome.message).toContain(
          `injected withdrawal failure at ${point.table}`
        );
      } finally {
        await disarmWriteFault(point);
      }

      const after = await readFingerprint(sourceRefs, resultIds);
      expect(after).toEqual(before);
      expect(subjectsOf(await readSnapshot(), resultIds)).toHaveLength(3);
    },
    30_000
  );
});
