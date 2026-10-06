/**
 * T10 MP6 — the exact accepted source set is published atomically.
 *
 * The suite drives the real `PgStructuredPublicationStorage` composed by
 * `PgvectorBackend`, so a refusal here is the store's own fence and every
 * residue read comes from a connection that is not the publishing transaction.
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
  StructuredPublicationStorage,
} from "../../src/core/maintenance/publication-types.js";
import type { EntityIdentityInput } from "../../src/core/structured/identity-store.js";
import {
  deriveRelationAssertionId,
  normalizeRelationAssertion,
  type RelationAssertionInput,
} from "../../src/core/structured/identity.js";
import type { NewSourceVersion } from "../../src/core/types.js";
import { PgMaintenanceWorkStore } from "../../src/core/storage/maintenance-work-pg.js";
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
const OPT_IN = process.env.IK_STRUCTURED_PUBLISH_ATOMICITY_PG;
if (OPT_IN !== "1") {
  throw new Error(
    "structured-publish-atomicity-pg.test.ts requires IK_STRUCTURED_PUBLISH_ATOMICITY_PG=1; it never skips"
  );
}
const DSN = process.env.GRAPHRAG_MEMORY_DB_URL;
if (typeof DSN !== "string" || DSN.trim() === "") {
  throw new Error(
    "structured-publish-atomicity-pg.test.ts requires GRAPHRAG_MEMORY_DB_URL to be set; it never skips"
  );
}

const SCHEMA_PREFIX = "t10_publish_atomicity";
const DIMENSIONS = 8;
const ACTOR = "t10-publish-atomicity-owner";
const CONFIG_REVISION = "extractor-v1";
const SCOPE_BINDING = "scope-t10-publish-atomicity";
const DRAIN_LIMIT = 64;

const harness: PgIntegrationHarness = await createPgIntegrationHarness({
  schemaPrefix: SCHEMA_PREFIX,
  defaultConnectionString: DSN,
  requiresVector: true,
  testPath: "tests/acceptance/structured-publish-atomicity-pg.test.ts",
  label: "T10 publish atomicity",
  expectedCommand:
    "IK_STRUCTURED_PUBLISH_ATOMICITY_PG=1 GRAPHRAG_MEMORY_DB_URL=<dsn> npx vitest run tests/acceptance/structured-publish-atomicity-pg.test.ts",
});

const reachability = await probePostgres(DSN, true);
if (!reachability.available) {
  throw new Error(
    "structured-publish-atomicity-pg.test.ts requires a reachable PostgreSQL with pgvector " +
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
      [entityId, `t10 publish fixture ${entityId}`]
    );
  }
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
    unit_manifest: { units: 6, parser_revision: "frozen-html-units-v1" },
    created_at: clock().toISOString(),
    retired_at: null,
    payload_collected_at: null,
    obligations_stopped_at: null,
  });  const locator = {
    document_id: `${sourceRef}-document`,
    version: `frozen-${sourceVersion}`,
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
  return { record, locator, locatorBindings, generation: declared.generation };
}

async function declareRevision(
  seeded: Seeded,
  extractionRevision: number,
  configRevision = CONFIG_REVISION
): Promise<number> {
  const declared = await publication.declareDesired({
    scopeBinding: SCOPE_BINDING,
    authorizedSourceRefs: [seeded.record.source_ref],
    sourceRef: seeded.record.source_ref,
    sourceVersion: seeded.record,
    locatorBindings: seeded.locatorBindings,
    desiredExtractionRevision: extractionRevision,
    configRevision,
  });
  return declared.generation;
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

interface Facts {
  readonly entities: readonly string[];
  readonly sharedAssertion: string;
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
      source_ref: seeded.record.source_ref,
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
        source_ref: seeded.record.source_ref,
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
    sourceRef: seeded.record.source_ref,
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
      sourceRef: seeded.record.source_ref,
      guard,
      at: new Date().toISOString(),
    });
    return { published: true };
  } catch (error) {
    return {
      published: false,
      code: outcomeCode(error),
      message: error instanceof Error ? `${error.message} :: ${describeCause(error)}` : String(error),
    };
  }
}

function describeCause(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = (error as { cause?: unknown })?.cause;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" <- ");
}

/**
 * Residue read on a connection this test owns, not the pool client the
 * publishing transaction leases. A fingerprint taken here is the only honest
 * witness that a failed switch left nothing behind.
 */
async function readResidue(
  sourceRef: string,
  outboxSubjectIds: readonly string[] = []
): Promise<Record<string, unknown>> {
  const observer = new pg.Client({ connectionString: harness.schemaConnectionString });
  await observer.connect();
  try {
    const source = await observer.query<Record<string, unknown>>(
      `SELECT active, generation, desired_source_version, desired_extraction_revision,
              desired_config_revision, published_source_version,
              published_extraction_revision, published_generation
         FROM structured_publication_sources
        WHERE scope_binding = $1 AND source_ref = $2`,
      [SCOPE_BINDING, sourceRef]
    );
    const scope = await observer.query<Record<string, unknown>>(
      `SELECT read_revision, maintenance_revision
         FROM structured_publication_scopes WHERE scope_binding = $1`,
      [SCOPE_BINDING]
    );
    const membership = await observer.query<Record<string, unknown>>(
      `SELECT source_ref, generation, extraction_ref, support_id::text, subject, result_id
         FROM structured_publication_membership
        WHERE scope_binding = $1 AND source_ref = $2
        ORDER BY subject, result_id, support_id`,
      [SCOPE_BINDING, sourceRef]
    );
    const display = await observer.query<Record<string, unknown>>(
      `SELECT source_ref, support_id::text, extraction_revision, canonical_name, entity_type
         FROM structured_publication_display
        WHERE scope_binding = $1 AND source_ref = $2
        ORDER BY support_id, extraction_revision`,
      [SCOPE_BINDING, sourceRef]
    );
    const stages = await observer.query<Record<string, unknown>>(
      `SELECT source_ref, generation, job_key, attempt_number, fencing_token, extraction_ref
         FROM structured_publication_stages
        WHERE scope_binding = $1 AND source_ref = $2`,
      [SCOPE_BINDING, sourceRef]
    );
    const bindings = await observer.query<Record<string, unknown>>(
      `SELECT source_ref, source_version, extraction_revision, extraction_ref, payload_digest
         FROM structured_publication_extraction_bindings
        WHERE scope_binding = $1 AND source_ref = $2
        ORDER BY extraction_revision`,
      [SCOPE_BINDING, sourceRef]
    );
    const outbox = await observer.query<Record<string, unknown>>(
      `SELECT subject_kind, subject_id, status
         FROM projection_outbox
        WHERE subject_id = ANY($1::uuid[])
        ORDER BY subject_kind, subject_id`,
      [outboxSubjectIds]
    );
    const supports = await observer.query<Record<string, unknown>>(
      `SELECT s.support_id::text, s.subject, s.result_id, s.source_ref, s.source_version,
              array_agg(e.extraction_ref ORDER BY e.extraction_ref) AS extraction_refs
         FROM assertion_supports s
         JOIN support_extractions e USING (support_id)
        WHERE s.source_ref = $1
        GROUP BY s.support_id, s.subject, s.result_id, s.source_ref, s.source_version
        ORDER BY s.subject, s.result_id`,
      [sourceRef]
    );
    const entities = await observer.query<Record<string, unknown>>(
      `SELECT entity_id, entity_type FROM structured_entity_identities ORDER BY entity_id`
    );
    const assertions = await observer.query<Record<string, unknown>>(
      `SELECT assertion_id FROM structured_relation_assertion_identities ORDER BY assertion_id`
    );
    const jobs = await observer.query<Record<string, unknown>>(
      `SELECT job_key, status, attempt_count, fencing_token, lease_expires_at,
              attempt_started_at, last_failure_code
         FROM maintenance_jobs WHERE source_ref = $1 ORDER BY job_key`,
      [sourceRef]
    );
    const attempts = await observer.query<Record<string, unknown>>(
      `SELECT a.job_key, a.attempt_number, a.fencing_token, a.finished_at, a.failure_code
         FROM maintenance_job_attempts a
         JOIN maintenance_jobs j USING (job_key)
        WHERE j.source_ref = $1
        ORDER BY a.job_key, a.attempt_number`,
      [sourceRef]
    );
    return {
      source: source.rows,
      scope: scope.rows,
      membership: membership.rows,
      display: display.rows,
      stages: stages.rows,
      bindings: bindings.rows,
      outbox: outbox.rows,
      supports: supports.rows,
      identities: { entities: entities.rows, assertions: assertions.rows },
      jobs: jobs.rows,
      attempts: attempts.rows,
    };
  } finally {
    await observer.end();
  }
}

/** Every write the switch performs, in the order the adapter performs it. */
type WritePoint = {
  readonly label: string;
  readonly table: string;
  readonly event: "INSERT" | "UPDATE" | "DELETE";
};

const WRITE_POINTS: readonly WritePoint[] = [
  { label: "graph entity vertex upsert", table: "entities", event: "INSERT" },
  {
    label: "entity identity registration",
    table: "structured_entity_identities",
    event: "INSERT",
  },
  {
    label: "relation assertion identity registration",
    table: "structured_relation_assertion_identities",
    event: "INSERT",
  },
  { label: "immutable support occurrence", table: "assertion_supports", event: "INSERT" },
  { label: "support extraction link", table: "support_extractions", event: "INSERT" },
  {
    label: "extraction binding",
    table: "structured_publication_extraction_bindings",
    event: "INSERT",
  },
  {
    label: "omitted-occurrence retirement",
    table: "structured_publication_membership",
    event: "DELETE",
  },
  {
    label: "accepted-occurrence membership",
    table: "structured_publication_membership",
    event: "INSERT",
  },
  {
    label: "attributed display value",
    table: "structured_publication_display",
    event: "INSERT",
  },
  {
    label: "published pair pointer",
    table: "structured_publication_sources",
    event: "UPDATE",
  },
  { label: "staged payload removal", table: "structured_publication_stages", event: "DELETE" },
  { label: "durable projection intent", table: "projection_outbox", event: "INSERT" },
  { label: "attempt settlement", table: "maintenance_jobs", event: "UPDATE" },
  { label: "attempt history settlement", table: "maintenance_job_attempts", event: "UPDATE" },
  { label: "scope revision advance", table: "structured_publication_scopes", event: "UPDATE" },
];

/**
 * Arm a trigger that fails the first row the publishing transaction writes to
 * one table. The sequence makes it a single fault rather than a table-wide
 * outage, so the residue is exactly "everything before this point, none of
 * everything after".
 */
async function armWriteFault(point: WritePoint): Promise<void> {
  faultSerial += 1;
  const suffix = `t10_fault_${faultSerial}`;
  const sequence = `${harness.schema}.${suffix}_sequence`;
  await pool.query(`CREATE SEQUENCE "${harness.schema}"."${suffix}_sequence"`);
  await pool.query(`
    CREATE FUNCTION "${harness.schema}"."${suffix}_function"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $t10_fault$
    BEGIN
      IF nextval('${sequence}'::regclass) = 1 THEN
        RAISE EXCEPTION 'injected publication switch failure at ${point.table}'
          USING ERRCODE = 'P0001';
      END IF;
      RETURN ${point.event === "DELETE" ? "OLD" : "NEW"};
    END;
    $t10_fault$`);
  await pool.query(`
    CREATE TRIGGER "${suffix}_trigger"
    BEFORE ${point.event} ON "${harness.schema}"."${point.table}"
    FOR EACH ROW EXECUTE FUNCTION "${harness.schema}"."${suffix}_function"()`);
}

async function disarmWriteFault(point: WritePoint): Promise<void> {
  faultSerial += 1;
  await pool.query(
    `DROP TRIGGER IF EXISTS "t10_fault_${faultSerial - 1}_trigger"
       ON "${harness.schema}"."${point.table}"`
  );
}

interface PublishedPair {
  readonly sourceVersion: string | null;
  readonly extractionRevision: number | null;
}

async function readPublishedPair(sourceRef: string): Promise<PublishedPair> {
  const observer = new pg.Client({ connectionString: harness.schemaConnectionString });
  await observer.connect();
  try {
    const { rows } = await observer.query<{
      published_source_version: string | null;
      published_extraction_revision: string | null;
    }>(
      `SELECT published_source_version, published_extraction_revision
         FROM structured_publication_sources
        WHERE scope_binding = $1 AND source_ref = $2`,
      [SCOPE_BINDING, sourceRef]
    );
    const revision = rows[0]?.published_extraction_revision;
    return {
      sourceVersion: rows[0]?.published_source_version ?? null,
      extractionRevision: revision === null || revision === undefined ? null : Number(revision),
    };
  } finally {
    await observer.end();
  }
}

async function readServingMembership(
  sourceRef: string
): Promise<readonly { subject: string; result_id: string; support_id: string }[]> {
  const observer = new pg.Client({ connectionString: harness.schemaConnectionString });
  await observer.connect();
  try {
    const { rows } = await observer.query<{
      subject: string;
      result_id: string;
      support_id: string;
    }>(
      `SELECT m.subject, m.result_id, m.support_id::text
         FROM structured_publication_membership m
         JOIN structured_publication_sources s
           ON s.scope_binding = m.scope_binding AND s.source_ref = m.source_ref
          AND s.active AND s.published_generation = m.generation
        WHERE m.scope_binding = $1 AND m.source_ref = $2
        ORDER BY m.subject, m.result_id, m.support_id`,
      [SCOPE_BINDING, sourceRef]
    );
    return rows;
  } finally {
    await observer.end();
  }
}

async function readDisplay(
  sourceRef: string
): Promise<
  readonly {
    support_id: string;
    extraction_revision: number;
    canonical_name: string;
    entity_type: string;
  }[]
> {
  const observer = new pg.Client({ connectionString: harness.schemaConnectionString });
  await observer.connect();
  try {
    const { rows } = await observer.query<{
      support_id: string;
      extraction_revision: string;
      canonical_name: string;
      entity_type: string;
    }>(
      `SELECT d.support_id::text, d.extraction_revision::text, d.canonical_name, d.entity_type
         FROM structured_publication_display d
         JOIN structured_publication_sources s
           ON s.scope_binding = d.scope_binding AND s.source_ref = d.source_ref
          AND s.active AND s.published_extraction_revision = d.extraction_revision
        WHERE d.scope_binding = $1 AND d.source_ref = $2
        ORDER BY d.support_id, d.extraction_revision`,
      [SCOPE_BINDING, sourceRef]
    );
    return rows.map((row) => ({
      support_id: row.support_id,
      extraction_revision: Number(row.extraction_revision),
      canonical_name: row.canonical_name,
      entity_type: row.entity_type,
    }));
  } finally {
    await observer.end();
  }
}

/**
 * A source published at revision 1 with three entities and one assertion, and a
 * revision 2 that omits one entity, keeps the two retained entities under the
 * same support identity, renames one display value, and adds a new entity.
 */
async function publishedThenRestaged(
  label: string
): Promise<{
  readonly sourceRef: string;
  readonly seeded: Seeded;
  readonly guard: MaintenanceAttemptGuard;
  readonly retained: readonly string[];
  readonly omitted: string;
  readonly added: string;
  readonly sharedResultId: string;
  readonly v1SupportIds: ReadonlyMap<string, string>;
}> {
  const sourceRef = unique(label);
  const seeded = await seedSource(sourceRef, "v1");
  const generation1 = await claimOwnJob(sourceRef, "v1", seeded.generation, [
    dependencyOf(sourceRef, seeded.generation),
  ]);
  const retainedA = nextEntityId();
  const retainedB = nextEntityId();
  const omitted = nextEntityId();
  const shared = assertionFact(
    seeded,
    "extract-v1",
    "mentions",
    4,
    retainedA,
    retainedB
  );
  await stageReal(seeded, generation1, "extract-v1", [
    entityFact(seeded, retainedA, "extract-v1", "Retained A v1", 1),
    entityFact(seeded, retainedB, "extract-v1", "Retained B v1", 2),
    entityFact(seeded, omitted, "extract-v1", "Omitted v1", 3),
    shared.fact,
  ]);
  const first = await publishReal(seeded, generation1);
  expect(first).toEqual({ published: true });

  const v1Membership = await readServingMembership(sourceRef);
  const v1SupportIds = new Map(
    v1Membership.map((row) => [row.result_id, row.support_id])
  );
  expect(v1SupportIds.size).toBe(4);

  const generation2 = await declareRevision(seeded, 2, "extractor-v2");
  const guard2 = await claimOwnJob(
    sourceRef,
    "v1",
    generation2,
    [dependencyOf(sourceRef, generation2, 1)],
    "extractor-v2"
  );
  const added = nextEntityId();
  const replayedShared = {
    ...shared.fact,
    occurrence: {
      ...shared.fact.occurrence,
      extraction_ref: "extract-v2",
    },
  } as PublicationFact;
  await stageReal(seeded, guard2, "extract-v2", [
    entityFact(seeded, retainedA, "extract-v2", "Retained A v2", 1),
    entityFact(seeded, retainedB, "extract-v2", "Retained B v2", 2),
    entityFact(seeded, added, "extract-v2", "Added v2", 5),
    replayedShared,
  ]);

  return {
    sourceRef,
    seeded,
    guard: guard2,
    retained: [retainedA, retainedB],
    omitted,
    added,
    sharedResultId: shared.resultId,
    v1SupportIds,
  };
}

describe("T10 the accepted source set is published atomically (PostgreSQL)", () => {
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

  it("switches a completed desired pair to the current published pair in one unit", async () => {
    const fixture = await publishedThenRestaged("switch-one-unit");

    const published = await publishReal(fixture.seeded, fixture.guard);
    expect(published).toEqual({ published: true });

    expect(await readPublishedPair(fixture.sourceRef)).toEqual({
      sourceVersion: "v1",
      extractionRevision: 2,
    });
    const serving = await readServingMembership(fixture.sourceRef);
    expect(serving.map((row) => row.result_id).sort()).toEqual(
      [
        fixture.retained[0],
        fixture.retained[1],
        fixture.added,
        fixture.sharedResultId,
      ].sort()
    );
    const stages = await readResidue(fixture.sourceRef, [
      fixture.retained[0],
      fixture.retained[1],
      fixture.omitted,
      fixture.added,
      fixture.sharedResultId,
    ]);
    expect(stages.stages).toEqual([]);
  });

  it("retires only the omitted occurrences from that source", async () => {
    const fixture = await publishedThenRestaged("retire-omitted");
    const otherRef = unique("retire-omitted-other");
    const other = await seedSource(otherRef, "v1", [otherRef, fixture.sourceRef]);
    const omittedElsewhere = nextEntityId();
    const otherGuard = await claimOwnJob(
      otherRef,
      "v1",
      other.generation,
      [dependencyOf(otherRef, other.generation)]
    );
    await stageReal(other, otherGuard, "extract-other", [
      entityFact(other, omittedElsewhere, "extract-other", "Also omitted", 1),
    ]);
    expect(await publishReal(other, otherGuard)).toEqual({ published: true });

    expect(await publishReal(fixture.seeded, fixture.guard)).toEqual({
      published: true,
    });

    const fromThisSource = await readServingMembership(fixture.sourceRef);
    expect(fromThisSource.map((row) => row.result_id)).not.toContain(fixture.omitted);
    const fromOtherSource = await readServingMembership(otherRef);
    expect(fromOtherSource.map((row) => row.result_id)).toContain(omittedElsewhere);
    const scope = await publication.readSnapshot({ scopeBinding: SCOPE_BINDING });
    expect(scope.subjects.map((subject) => subject.resultId)).not.toContain(
      fixture.omitted
    );
  });

  it("keeps exactly one result for a support shared by two sources", async () => {
    const sourceA = unique("shared-a");
    const sourceB = unique("shared-b");
    const seededA = await seedSource(sourceA, "v1", [sourceA, sourceB]);
    const seededB = await seedSource(sourceB, "v1", [sourceA, sourceB]);
    const head = nextEntityId();
    const tail = nextEntityId();
    const shared = assertionFact(seededA, "extract-shared", "co_founded", 1, head, tail);
    const mirrored = {
      ...shared.fact,
      occurrence: {
        ...shared.fact.occurrence,
        source_ref: sourceB,
        source_version: "v1",
        location: { ...seededB.locator, unit: 1 },
        extraction_ref: "extract-shared-b",
      },
    } as PublicationFact;

    const guardA = await claimOwnJob(sourceA, "v1", seededA.generation, [
      dependencyOf(sourceA, seededA.generation),
    ]);
    await seedGraphEntities([head, tail]);
    await stageReal(seededA, guardA, "extract-shared", [shared.fact]);
    const guardB = await claimOwnJob(sourceB, "v1", seededB.generation, [
      dependencyOf(sourceB, seededB.generation),
    ]);
    await stageReal(seededB, guardB, "extract-shared-b", [mirrored]);

    const outcomeA = await publishReal(seededA, guardA);
    if (!outcomeA.published) {
      throw new Error(`publish A refused ${outcomeA.code}: ${outcomeA.message}`);
    }
    const outcomeB = await publishReal(seededB, guardB);
    if (!outcomeB.published) {
      throw new Error(`publish B refused ${outcomeB.code}: ${outcomeB.message}`);
    }

    const scope = await publication.readSnapshot({ scopeBinding: SCOPE_BINDING });
    const results = scope.subjects.filter(
      (subject) => subject.resultId === shared.resultId
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.supportIds).toHaveLength(2);
  });

  it("binds display to the accepted support and its extraction revision", async () => {
    const fixture = await publishedThenRestaged("display-binding");

    const before = await readDisplay(fixture.sourceRef);
    expect(before.map((row) => row.extraction_revision)).toEqual([1, 1, 1]);
    const retainedSupport = fixture.v1SupportIds.get(fixture.retained[0])!;
    expect(before.find((row) => row.support_id === retainedSupport)).toMatchObject({
      extraction_revision: 1,
      canonical_name: "Retained A v1",
      entity_type: "organization",
    });

    expect(await publishReal(fixture.seeded, fixture.guard)).toEqual({
      published: true,
    });

    const after = await readDisplay(fixture.sourceRef);
    expect(after.every((row) => row.extraction_revision === 2)).toBe(true);
    expect(after).toHaveLength(3);
    expect(after.find((row) => row.support_id === retainedSupport)).toMatchObject({
      extraction_revision: 2,
      canonical_name: "Retained A v2",
      entity_type: "organization",
    });
    const addedSupport = after.find(
      (row) => row.canonical_name === "Added v2"
    );
    expect(addedSupport).toBeDefined();
  });

  it("lets exactly one of two concurrent publication attempts win", async () => {
    const sourceRef = unique("concurrent-publish");
    const seeded = await seedSource(sourceRef, "v1");
    const guard = await claimOwnJob(sourceRef, "v1", seeded.generation, [
      dependencyOf(sourceRef, seeded.generation),
    ]);
    const head = nextEntityId();
    await stageReal(seeded, guard, "extract-concurrent", [
      entityFact(seeded, head, "extract-concurrent", "Concurrent", 1),
    ]);

    const attempts = await Promise.all([publishReal(seeded, guard), publishReal(seeded, guard)]);
    const winners = attempts.filter((attempt) => attempt.published);
    const losers = attempts.filter((attempt) => !attempt.published);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    // The loser is a fence refusal the second writer must reach on its own, not
    // a transport error: it named the attempt, so the two attempts really met.
    expect(losers[0]?.code).toBe("lease_lost");

    expect(await readPublishedPair(sourceRef)).toEqual({
      sourceVersion: "v1",
      extractionRevision: 1,
    });
    expect(await readServingMembership(sourceRef)).toHaveLength(1);
    const residue = await readResidue(sourceRef, [head]);
    expect(residue.stages).toEqual([]);
    expect(residue.outbox).toHaveLength(1);
    expect(residue.membership).toHaveLength(1);
  });

  it.each(WRITE_POINTS.map((point) => [point.label, point] as const))(
    "rolls the switch back when the %s write fails",
    async (_label, point) => {
      const fixture = await publishedThenRestaged(`fault-${faultSerial}`);
      const before = await readResidue(fixture.sourceRef, [
        fixture.retained[0],
        fixture.retained[1],
        fixture.omitted,
        fixture.added,
        fixture.sharedResultId,
      ]);
      expect(before.membership).toHaveLength(4);
      expect(before.display).toHaveLength(3);
      expect(
        (before.source as Record<string, unknown>[])[0]?.published_extraction_revision
      ).toBe("1");

      await armWriteFault(point);
      try {
        const outcome = await publishReal(fixture.seeded, fixture.guard);
        expect(outcome.published).toBe(false);
        // A driver fault is a backend failure, not a fence refusal: the switch
        // refused to continue and rolled the unit back rather than reporting a
        // stale-input verdict it did not reach.
        expect(outcome.code).toBe("backend_unavailable");
        expect(outcome.message).toContain(`injected publication switch failure at ${point.table}`);
      } finally {
        await disarmWriteFault(point);
      }

      const after = await readResidue(fixture.sourceRef, [
        fixture.retained[0],
        fixture.retained[1],
        fixture.omitted,
        fixture.added,
        fixture.sharedResultId,
      ]);
      expect(after).toEqual(before);
    },
    30_000
  );
});
