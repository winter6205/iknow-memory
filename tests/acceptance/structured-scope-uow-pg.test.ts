/**
 * Strict PostgreSQL acceptance driver for the shared authorized-scope unit of work.
 *
 * Why this file exists: the memory driver can only prove the contract's shape. The
 * properties that made one storage-owned authority necessary — a single transaction
 * owner shared by publication and work, one lock order instead of two that form a
 * cycle, refusals decided against the database clock, and a rollback that leaves no
 * partial row behind — are properties of PostgreSQL under real row locks. Every
 * scenario here therefore runs the actual claim, heartbeat, settle, retry, reclaim
 * and publication paths; no scenario is manufactured by writing rows directly.
 *
 * This driver never degrades into a skip. A missing flag, a missing DSN or an
 * unreachable PostgreSQL fails the run, because a silently skipped acceptance run
 * is not evidence of anything.
 */
import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { getSuppressedFailureContext } from "../../src/core/errors.js";
import {
  claimNextWork,
  retryWork,
  scheduleWork,
  settleWork,
} from "../../src/core/maintenance/service.js";
import type {
  MaintenanceAttemptGuard,
  MaintenanceDependency,
  MaintenanceJobRecord,
  MaintenanceLiveInputs,
  MaintenanceWorkKind,
  MaintenanceWorkRequest,
  MaintenanceWorkStore,
} from "../../src/core/maintenance/types.js";
import {
  WORK_ABSOLUTE_LIMIT_MS,
  WORK_LEASE_MS,
} from "../../src/core/maintenance/types.js";
import type {
  PublicationFact,
  PublicationSnapshot,
  StructuredPublicationStorage,
} from "../../src/core/maintenance/publication-types.js";
import { PgStructuredIdentityStore } from "../../src/core/structured/identity-store.js";
import type {
  EntityIdentityInput,
  StructuredIdentityStore,
} from "../../src/core/structured/identity-store.js";
import {
  deriveRelationAssertionId,
  normalizeRelationAssertion,
  type RelationAssertionInput,
} from "../../src/core/structured/identity.js";
import { PgMaintenanceWorkStore } from "../../src/core/storage/maintenance-work-pg.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { withAuthorizedScope } from "../../src/core/storage/structured-scope-uow.js";
import type {
  AuthorizedScopeContext,
  AuthorizedScopeContextInput,
  AuthorizedScopeUnitOfWork,
  ScopeWorkHandle,
} from "../../src/core/storage/structured-scope-types.js";
import type { ChunkRecord } from "../../src/core/types.js";
import {
  createPublicationTestClock,
  expectFailure,
  type PublicationTestClock,
  type SeededVersion,
} from "../storage/publication-contract.js";
import {
  createPgIntegrationHarness,
  probePostgres,
  resolvePgConnectionString,
} from "../integration/pg-test-harness.js";

const EXPECTED_COMMAND =
  "STRUCTURED_SCOPE_UOW_ACCEPTANCE=1 GRAPHRAG_MEMORY_DB_URL=<isolated-development-dsn> npx vitest run tests/acceptance/structured-scope-uow-pg.test.ts";
const ACCEPTANCE_ENV = "STRUCTURED_SCOPE_UOW_ACCEPTANCE";
const SCHEMA_PREFIX = "structured_scope_uow_acceptance";
const DIMENSIONS = 8;
const ACTOR = "scope-uow-trusted-owner";
const INJECTED_DETAIL = "injected scope uow commit-side failure at /payload/SECRET-LEAK";
const UUIDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
] as const;

if (process.env[ACCEPTANCE_ENV] !== "1") {
  throw new Error(
    [
      `${ACCEPTANCE_ENV}=1 is required to run this acceptance driver.`,
      "Validation:",
      "- Not run: tests/acceptance/structured-scope-uow-pg.test.ts",
      `- Expected command: ${EXPECTED_COMMAND}`,
      "- Blocking issue: the strict flag is absent, so PostgreSQL evidence would be skipped.",
      "- This driver deliberately has no skip path: a skipped acceptance run is not evidence.",
    ].join("\n")
  );
}

const CONNECTION_STRING = resolvePgConnectionString(
  "postgresql://postgres@localhost/postgres"
);

const pgHarness = await createPgIntegrationHarness({
  label: "structured-scope-uow-acceptance-pg",
  testPath: "tests/acceptance/structured-scope-uow-pg.test.ts",
  expectedCommand: EXPECTED_COMMAND,
  schemaPrefix: SCHEMA_PREFIX,
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: true,
});

const probe = await probePostgres(CONNECTION_STRING, true);
if (!probe.available) {
  throw new Error(
    [
      "Validation:",
      "- Not run: the shared scope authority acceptance suite requires real PostgreSQL + pgvector.",
      `- Expected command: ${EXPECTED_COMMAND}`,
      `- Blocking issue: ${probe.error instanceof Error ? probe.error.message : String(probe.error)}`,
      "- Start it with: docker compose up -d --wait postgres",
      "- This driver deliberately has no skip path: a skipped acceptance run is not evidence.",
    ].join("\n")
  );
}

const SCHEMA_URL = pgHarness.schemaConnectionString;

let backend: PgvectorBackend;
let pool: pg.Pool;
let admin: pg.Client;
let identity: StructuredIdentityStore;
let work: MaintenanceWorkStore;
let publication: StructuredPublicationStorage;
let authority: AuthorizedScopeUnitOfWork;
let clock: PublicationTestClock;

const createdFaults: { name: string; table: string }[] = [];
const createdJobs: string[] = [];
let serial = 0;

type AuthorizedScopeInput = AuthorizedScopeContextInput;

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

function opaqueDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function errorCodeOf(error: unknown): string {
  const coded = error as { readonly code?: unknown; readonly failureCode?: unknown };
  const direct = coded?.code ?? coded?.failureCode;
  if (typeof direct === "string") return direct;
  return "untyped_error";
}

async function codeOf(action: Promise<unknown>): Promise<string | undefined> {
  try {
    await action;
    return undefined;
  } catch (error) {
    return errorCodeOf(error);
  }
}

/** Walks the cause chain because a wrapped storage fault keeps its SQLSTATE. */
function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current);
    const candidate = current as {
      readonly code?: unknown;
      readonly sqlState?: unknown;
      readonly cause?: unknown;
    };
    if (typeof candidate.sqlState === "string") return candidate.sqlState;
    if (
      typeof candidate.code === "string" &&
      /^[0-9A-Z]{5}$/.test(candidate.code) &&
      !(candidate.code.includes("_"))
    ) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return undefined;
}

function refsOf(sources: readonly { sourceRef: string }[]): string[] {
  return sources.map((source) => source.sourceRef).sort();
}

function resultIdsOf(
  memberships: readonly { resultId: string }[]
): string[] {
  return memberships.map((membership) => membership.resultId).sort();
}

function supportIdsOf(
  memberships: readonly { supportIds: readonly string[] }[]
): string[] {
  return memberships.flatMap((membership) => [...membership.supportIds]).sort();
}

function sourceRow(
  snapshot: PublicationSnapshot,
  sourceRef: string
): PublicationSnapshot["sources"][number] | undefined {
  return snapshot.sources.find(
    (candidate) => candidate.sourceRef === sourceRef
  );
}

function currentIds(snapshot: PublicationSnapshot): string[] {
  return snapshot.subjects
    .map((subject) => subject.resultId)
    .sort((left, right) => left.localeCompare(right));
}

function supportIdFor(
  snapshot: PublicationSnapshot,
  resultId: string
): string {
  const subject = snapshot.subjects.find(
    (candidate) => candidate.resultId === resultId
  );
  const supportId = subject?.supportIds[0];
  if (supportId === undefined) {
    throw new Error(`test setup found no support for ${resultId}`);
  }
  return supportId;
}

function publishRequest(
  sourceRef: string,
  sourceGeneration: number,
  dependencies?: readonly MaintenanceDependency[],
  workKind: MaintenanceWorkKind = "extract_publish"
): MaintenanceWorkRequest {
  return {
    workKind,
    sourceRef,
    sourceVersion: "v1",
    sourceGeneration,
    configRevision: "extractor-v1",
    dependencies:
      dependencies ??
      [
        {
          sourceRef,
          generation: sourceGeneration,
          extractionRevision: null,
          relationBuckets: [],
        },
      ],
  };
}

function requireScheduled(outcome: {
  readonly record?: MaintenanceJobRecord;
  readonly refused?: string;
}): MaintenanceJobRecord {
  if ("refused" in outcome && outcome.refused !== undefined) {
    throw new Error(`test setup schedule refused: ${outcome.refused}`);
  }
  const record = (outcome as { record?: MaintenanceJobRecord }).record;
  if (record === undefined) throw new Error("test setup schedule returned no record");
  return record;
}

function requireGuard(
  guard: MaintenanceAttemptGuard | null
): MaintenanceAttemptGuard {
  if (guard === null) throw new Error("test setup could not claim work");
  return guard;
}

function entityFact(
  seeded: SeededVersion,
  entityId: string,
  extractionRef: string,
  canonicalName: string,
  unit = 1
): PublicationFact {
  const identityInput: EntityIdentityInput = {
    entityId,
    type: "organization",
  };
  return {
    identity: { kind: "entity", input: identityInput },
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
  seeded: SeededVersion,
  extractionRef: string,
  relationNorm: string,
  unit = 2
): PublicationFact {
  const identityInput: RelationAssertionInput = {
    headEntityId: UUIDS[0],
    relationNorm,
    tailEntityId: UUIDS[1],
    validWindow: { from: null, until: null },
  };
  const normalized = normalizeRelationAssertion(identityInput);
  return {
    identity: { kind: "relation_assertion", input: identityInput },
    occurrence: {
      subject: "assertion",
      result_id: deriveRelationAssertionId(normalized),
      source_ref: seeded.record.source_ref,
      source_version: seeded.record.source_version,
      location: { ...seeded.locator, unit },
      extraction_ref: extractionRef,
      extractedAt: seeded.record.created_at,
    },
  };
}

function derivedAssertionId(relationNorm: string): string {
  return deriveRelationAssertionId(
    normalizeRelationAssertion({
      headEntityId: UUIDS[0],
      relationNorm,
      tailEntityId: UUIDS[1],
      validWindow: { from: null, until: null },
    })
  );
}

async function countRows(query: string, values?: readonly unknown[]): Promise<number> {
  const result = await pool.query<{ count: string }>(query, values as unknown[]);
  return Number(result.rows[0]?.count ?? "0");
}

function readOutboxCount(): Promise<number> {
  return countRows("SELECT count(*)::text AS count FROM projection_outbox");
}

/**
 * Counts one seam-written outbox intent by its primary key, so the oracle is a
 * per-run row rather than the global queue a shared constant could leak into.
 */
function countOutboxIntent(id: string): Promise<number> {
  return countRows(
    "SELECT count(*)::text AS count FROM projection_outbox WHERE id = $1::uuid",
    [id]
  );
}

function readRevisionPair(
  scopeBinding: string
): Promise<{ read: string; maintenance: string }> {
  return pool
    .query<{ read_revision: string; maintenance_revision: string }>(
      `SELECT read_revision::text AS read_revision,
              maintenance_revision::text AS maintenance_revision
         FROM structured_publication_scopes WHERE scope_binding = $1`,
      [scopeBinding]
    )
    .then((result) => {
      const row = result.rows[0];
      return {
        read: row?.read_revision ?? "absent",
        maintenance: row?.maintenance_revision ?? "absent",
      };
    });
}

async function seedGraphEntities(entityIds: readonly string[]): Promise<void> {
  const chunks: ChunkRecord[] = entityIds.map((id) => ({
    id,
    content: `scope authority acceptance entity ${id}`,
    embedding: new Array<number>(DIMENSIONS).fill(0),
    source_ref: "structured-scope-uow-acceptance-fixture",
    metadata: {},
    valid_from: clock().toISOString(),
    valid_until: null,
    created_at: clock().toISOString(),
  }));
  if (chunks.length > 0) await backend.upsert(chunks);
}

/**
 * Faults are gated on the exact subject or job they must break and fire once, so a
 * leftover trigger can never fail a later scenario's write.
 */
async function injectFault(options: {
  table:
    | "projection_outbox"
    | "maintenance_jobs"
    | "structured_publication_scopes";
  mode: "fail" | "delay";
  milliseconds?: number;
  subjectId?: string;
  jobKey?: string;
}): Promise<void> {
  serial += 1;
  const base = `scope_uow_fault_${serial}`;
  const functionName = `${base}_function`;
  const triggerName = `${base}_trigger`;
  const sequenceName = `${base}_sequence`;
  await pool.query(`CREATE SEQUENCE "${pgHarness.schema}"."${sequenceName}"`);
  const gate =
    options.table === "projection_outbox" && options.subjectId !== undefined
      ? `NEW.subject_id = '${options.subjectId}'::uuid AND `
      : options.table === "maintenance_jobs" && options.jobKey !== undefined
        ? `NEW.job_key = '${options.jobKey}' AND `
        : "";
  const fired = `${gate}nextval('${pgHarness.schema}.${sequenceName}'::regclass) = 1`;
  const action =
    options.mode === "fail"
      ? `RAISE EXCEPTION '%', '${INJECTED_DETAIL}' USING ERRCODE = 'P0001';`
      : `PERFORM pg_sleep(${((options.milliseconds ?? 250) / 1000).toFixed(3)});`;
  await pool.query(`
    CREATE FUNCTION "${pgHarness.schema}"."${functionName}"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $scope_uow_fault$
    BEGIN
      IF ${fired} THEN
        ${action}
      END IF;
      RETURN NEW;
    END;
    $scope_uow_fault$`);
  await pool.query(`
    CREATE TRIGGER "${triggerName}"
    BEFORE INSERT OR UPDATE ON "${options.table}"
    FOR EACH ROW EXECUTE FUNCTION "${pgHarness.schema}"."${functionName}"()`);
  createdFaults.push({ name: triggerName, table: options.table });
}

async function clearFaults(): Promise<void> {
  const faults = createdFaults.splice(0);
  for (const fault of faults) {
    await pool.query(
      `DROP TRIGGER IF EXISTS "${fault.name}" ON "${fault.table}"`
    );
    await pool.query(
      `DROP FUNCTION IF EXISTS "${pgHarness.schema}"."${fault.name.replace(/_trigger$/, "_function")}()"`
    );
    await pool.query(
      `DROP SEQUENCE IF EXISTS "${pgHarness.schema}"."${fault.name.replace(/_trigger$/, "_sequence")}"`
    );
  }
}

/**
 * Fixture teardown only: attempts this run opened must be closed so a later
 * scenario's global claim cannot pick up another scenario's pending job. No
 * scenario outcome is produced this way.
 *
 * The claim is global (`ORDER BY next_attempt_at NULLS FIRST, created_at`), so
 * isolation must neutralize the whole claimable queue, not only the jobs this
 * run tracked by key: a concurrency scenario can leave a ready job that never
 * reached `createdJobs`, and that leftover would be claimed by the next
 * scenario's `startAttempt`.
 */
async function finishOpenAttempts(): Promise<void> {
  const jobKeys = createdJobs.splice(0);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (jobKeys.length > 0) {
      await client.query(
        `UPDATE maintenance_job_attempts
            SET finished_at = clock_timestamp(), failure_code = 'input_stale'
          WHERE finished_at IS NULL AND job_key = ANY($1::text[])`,
        [jobKeys]
      );
    }
    await client.query(
      `UPDATE maintenance_jobs
          SET status = 'stale', last_failure_code = 'input_stale',
              next_attempt_at = NULL, fencing_token = NULL,
              lease_expires_at = NULL, attempt_started_at = NULL,
              updated_at = clock_timestamp()
        WHERE status IN ('running', 'pending')`
    );
    // The outbox is a global table and several scenarios assert its delta, so a
    // prior scenario's committed intents would leak into the next baseline. Clearing
    // it here produces no scenario outcome: each scenario writes its own intents
    // after this point, and no scenario depends on another's outbox rows.
    await client.query("DELETE FROM projection_outbox");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function workDeps(): { store: MaintenanceWorkStore; clock: () => Date } {
  return { store: work, clock: () => clock() };
}

async function registerVersion(
  sourceRef: string,
  sourceVersion: string,
  content = `${sourceRef}:${sourceVersion}:original`
): Promise<SeededVersion> {
  const { record } = await backend.registerSourceVersion({
    source_ref: sourceRef,
    source_version: sourceVersion,
    content_digest: opaqueDigest(content),
    origin_object_ref: `objects/${sourceRef}/${sourceVersion}.html`,
    parser_revision: "frozen-html-units-v1",
    unit_manifest: { units: 5, parser_revision: "frozen-html-units-v1" },
    created_at: clock().toISOString(),
  });
  const locator = {
    document_id: `${sourceRef}-document`,
    version: `frozen-${sourceVersion}`,
    unit: 1,
  };
  const locatorBindings = Array.from({ length: 5 }, (_, index) => ({
    source_version_id: record.source_version_id,
    ...locator,
    unit: index + 1,
  }));
  for (const binding of locatorBindings) {
    await backend.bindSourceLocator(binding);
  }
  return { record, locator, locatorBindings };
}

async function declareDesired(
  scopeBinding: string,
  authorizedSourceRefs: readonly string[],
  seeded: SeededVersion,
  extractionRevision: number
): Promise<{ readonly generation: number }> {
  return publication.declareDesired({
    scopeBinding,
    authorizedSourceRefs,
    sourceRef: seeded.record.source_ref,
    sourceVersion: seeded.record,
    locatorBindings: seeded.locatorBindings,
    desiredExtractionRevision: extractionRevision,
    configRevision: "extractor-v1",
  });
}

/** Trusted owner grant: an owner scope is admitted with a known revision. */
async function admitScope(
  scopeBinding: string,
  authorizationRevision: string
): Promise<void> {
  await backend.setScopeRevisions(scopeBinding, {
    authorizationRevision,
    purgeRevision: `purge-${authorizationRevision}`,
  });
}

async function startAttempt(
  sourceRef: string,
  sourceGeneration: number
): Promise<{
  readonly guard: MaintenanceAttemptGuard;
  readonly live: MaintenanceLiveInputs;
}> {
  const deps = workDeps();
  const scheduled = await scheduleWork(
    deps,
    { actorId: ACTOR },
    publishRequest(sourceRef, sourceGeneration)
  );
  const job = requireScheduled(scheduled);
  createdJobs.push(job.jobKey);
  const claimed = await claimNextWork(deps);
  const guard = requireGuard(claimed.guard);
  expect(guard.jobKey).toBe(job.jobKey);
  return {
    guard,
    live: {
      configRevision: "extractor-v1",
      dependencies: [
        {
          sourceRef,
          generation: sourceGeneration,
          extractionRevision: null,
          relationBuckets: [],
        },
      ],
    },
  };
}

async function stageAttempt(
  scopeBinding: string,
  sourceRef: string,
  guard: MaintenanceAttemptGuard,
  extractionRef: string,
  accepted: readonly PublicationFact[]
): Promise<void> {
  await seedGraphEntities(
    accepted.flatMap((fact) =>
      fact.identity.kind === "entity" ? [fact.identity.input.entityId] : []
    )
  );
  const staged = await publication.stageAttempt({
    scopeBinding,
    sourceRef,
    guard,
    extractionRef,
    accepted,
  });
  expect(staged).toMatchObject({ staged: true });
}

function publish(
  scopeBinding: string,
  sourceRef: string,
  guard: MaintenanceAttemptGuard,
  at?: string
): Promise<unknown> {
  return publication.publish({
    scopeBinding,
    sourceRef,
    guard,
    at: at ?? new Date().toISOString(),
  });
}

async function withdrawSource(
  scopeBinding: string,
  sourceRef: string,
  expectedGeneration: number
): Promise<{ readonly generation: number }> {
  return publication.withdraw({
    scopeBinding,
    sourceRef,
    expectedGeneration,
    at: new Date().toISOString(),
  });
}

function context(
  input: AuthorizedScopeInput
): AuthorizedScopeContext {
  return authority.createAuthorizedContext(input);
}

function farDeadline(): string {
  return new Date(Date.now() + 10 * 60_000).toISOString();
}

describe("authorized scope unit of work — PostgreSQL acceptance", () => {
  beforeAll(async () => {
    admin = pgHarness.createClient(SCHEMA_URL);
    await admin.connect();
    await pgHarness.resetSchema(admin);
    backend = new PgvectorBackend(SCHEMA_URL, DIMENSIONS, {
      annMaxDimensions: 2000,
    });
    await backend.initialize();
    pool = new pg.Pool({ connectionString: SCHEMA_URL, max: 8 });
    clock = createPublicationTestClock(new Date());

    const composed = backend as PgvectorBackend & {
      structuredPublication?: StructuredPublicationStorage;
      structuredScopeUnitOfWork?: AuthorizedScopeUnitOfWork;
    };
    const composedPublication = composed.structuredPublication;
    const composedAuthority = composed.structuredScopeUnitOfWork;
    if (!composedPublication || !composedAuthority) {
      throw new Error(
        "PgvectorBackend composition must supply the shared authorized scope unit of work to the publication and work adapters"
      );
    }
    publication = composedPublication;
    authority = composedAuthority;
    identity = new PgStructuredIdentityStore(pool);
    work = new PgMaintenanceWorkStore(pool);
  }, 120_000);

  afterAll(async () => {
    try {
      if (!pgHarness.schema.startsWith(`${SCHEMA_PREFIX}_`)) {
        throw new Error("refusing to drop a schema outside this run's prefix");
      }
      await clearFaults();
      await finishOpenAttempts();
      await pgHarness.dropSchema(admin);
    } finally {
      await pool?.end();
      await backend?.close();
      await admin?.end();
    }
  });

  afterEach(async () => {
    await clearFaults();
    await finishOpenAttempts();
  });

  it("refuses a context whose scope lost its current authorization before running any write", async () => {
    const sourceRef = unique("revoked-source");
    const scopeBinding = unique("revoked-scope");
    const seeded = await registerVersion(sourceRef, "v1");
    await admitScope(scopeBinding, "auth-1");
    const generation = (
      await declareDesired(scopeBinding, [sourceRef], seeded, 1)
    ).generation;
    const before = await publication.readSnapshot({ scopeBinding });
    const outboxBefore = await readOutboxCount();
    const revisionsBefore = await readRevisionPair(scopeBinding);
    const stale = context({
      actorId: ACTOR,
      ownerScopeBinding: scopeBinding,
      readerBinding: "reader-1",
      authorizedSourceRefs: [sourceRef],
      authorizationRevision: "auth-1",
      deadlineAt: farDeadline(),
    });
    await admitScope(scopeBinding, "auth-2");
    let invoked = false;

    const code = await codeOf(
      withAuthorizedScope(stale, async () => {
        invoked = true;
      })
    );

    expect(code).toBe("access_denied");
    expect(invoked).toBe(false);
    const after = await publication.readSnapshot({ scopeBinding });
    expect(after).toEqual(before);
    expect(sourceRow(after, sourceRef)?.generation).toBe(generation);
    expect(await readOutboxCount()).toBe(outboxBefore);
    expect(await readRevisionPair(scopeBinding)).toEqual(revisionsBefore);
  });

  it("refuses a trusted set that names a source owned by another scope before running any write", async () => {
    const ownedSource = unique("other-owner-source");
    const ownedScope = unique("other-owner-scope");
    const callerScope = unique("caller-scope");
    const callerSource = unique("caller-own-source");
    const seeded = await registerVersion(ownedSource, "v1");
    const callerSeeded = await registerVersion(callerSource, "v1");
    await admitScope(ownedScope, "auth-1");
    await admitScope(callerScope, "auth-1");
    await declareDesired(ownedScope, [ownedSource], seeded, 1);
    // The caller owns a source of its own, so the only anomaly left in its
    // trusted set is the foreign reference.
    await declareDesired(callerScope, [callerSource], callerSeeded, 1);
    const ownerBefore = await publication.readSnapshot({
      scopeBinding: ownedScope,
    });
    const callerBefore = await publication.readSnapshot({
      scopeBinding: callerScope,
    });
    const outboxBefore = await readOutboxCount();
    let invoked = false;

    const code = await codeOf(
      withAuthorizedScope(
        context({
          actorId: ACTOR,
          ownerScopeBinding: callerScope,
          readerBinding: "reader-1",
          authorizedSourceRefs: [ownedSource, callerSource],
          authorizationRevision: "auth-1",
          deadlineAt: farDeadline(),
        }),
        async () => {
          invoked = true;
        }
      )
    );

    // Either verdict is an authority refusal: a source owned by another scope is
    // not a binding this context holds. What cannot vary is that the refusal
    // happens before a single row is written.
    expect(["access_denied", "unsupported_source_binding"]).toContain(code);
    expect(invoked).toBe(false);
    expect(await publication.readSnapshot({ scopeBinding: callerScope })).toEqual(
      callerBefore
    );
    expect(await publication.readSnapshot({ scopeBinding: ownedScope })).toEqual(
      ownerBefore
    );
    expect(
      await countRows(
        `SELECT count(*)::text AS count FROM structured_publication_sources
          WHERE scope_binding = $1 AND source_ref = $2`,
        [callerScope, ownedSource]
      )
    ).toBe(0);
    expect(await readOutboxCount()).toBe(outboxBefore);
  });

  it("refuses an empty authorized source set without registering a publication scope", async () => {
    const scopeBinding = unique("empty-set-scope");
    await admitScope(scopeBinding, "auth-1");
    let invoked = false;

    const code = await codeOf(
      withAuthorizedScope(
        context({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-1",
          authorizedSourceRefs: [],
          authorizationRevision: "auth-1",
          deadlineAt: farDeadline(),
        }),
        async () => {
          invoked = true;
        }
      )
    );

    expect(code).toBe("invalid_input");
    expect(invoked).toBe(false);
    expect(
      await countRows(
        "SELECT count(*)::text AS count FROM structured_publication_scopes WHERE scope_binding = $1",
        [scopeBinding]
      )
    ).toBe(0);
    expect((await publication.readSnapshot({ scopeBinding })).sources).toEqual([]);
  });

  it("refuses a caller-supplied source array wider than the trusted context", async () => {
    const keptSource = unique("widen-kept");
    const extraSource = unique("widen-extra");
    const scopeBinding = unique("widen-scope");
    const extraScope = unique("widen-extra-scope");
    const kept = await registerVersion(keptSource, "v1");
    const extra = await registerVersion(extraSource, "v1");
    await admitScope(scopeBinding, "auth-1");
    await admitScope(extraScope, "auth-1");
    const authorizedSourceRefs = [keptSource];
    const generation = (
      await declareDesired(scopeBinding, authorizedSourceRefs, kept, 1)
    ).generation;
    const extraGeneration = (
      await declareDesired(extraScope, [extraSource], extra, 1)
    ).generation;
    await publishOneEntity(extraScope, extraSource, extra, extraGeneration, UUIDS[2]);
    const outboxBefore = await readOutboxCount();
    const revisionsBefore = await readRevisionPair(scopeBinding);
    const extraBefore = await publication.readSnapshot({ scopeBinding: extraScope });

    const innerCode = await codeOf(
      withAuthorizedScope(
        context({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-1",
          authorizedSourceRefs,
          authorizationRevision: "auth-1",
          deadlineAt: farDeadline(),
        }),
        async (scope: ScopeWorkHandle) => {
          await scope.readAcceptedInputs([...authorizedSourceRefs, extraSource]);
        }
      )
    );
    expect(innerCode).toBe("access_denied");

    // A wider set handed to the run itself must not widen its locks either.
    let outerInvoked = false;
    const outerCode = await codeOf(
      withAuthorizedScope(
        context({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-1",
          authorizedSourceRefs,
          authorizationRevision: "auth-1",
          deadlineAt: farDeadline(),
        }),
        async () => {
          outerInvoked = true;
        },
        { additionalSourceRefs: [extraSource] }
      )
    );
    expect(outerCode).toBe("access_denied");
    expect(outerInvoked).toBe(false);

    const after = await publication.readSnapshot({ scopeBinding });
    expect(refsOf(after.sources)).toEqual([keptSource]);
    expect(sourceRow(after, keptSource)?.generation).toBe(generation);
    // The foreign scope keeps every row the widened array named.
    expect(await publication.readSnapshot({ scopeBinding: extraScope })).toEqual(
      extraBefore
    );
    expect(refsOf(extraBefore.sources)).toEqual([extraSource]);
    expect(
      await countRows(
        `SELECT count(*)::text AS count FROM structured_publication_sources
          WHERE scope_binding = $1 AND source_ref = $2`,
        [scopeBinding, extraSource]
      )
    ).toBe(0);
    expect(currentIds(after)).not.toContain(UUIDS[2]);
    expect(await readOutboxCount()).toBe(outboxBefore);
    expect(await readRevisionPair(scopeBinding)).toEqual(revisionsBefore);
  });

  it("refuses a context that carries another scope's authorization revision", async () => {
    const sourceRef = unique("foreign-revision-source");
    const scopeBinding = unique("foreign-revision-scope");
    const otherScope = unique("foreign-revision-other");
    const seeded = await registerVersion(sourceRef, "v1");
    await admitScope(otherScope, "auth-7");
    await admitScope(scopeBinding, "auth-1");
    const generation = (
      await declareDesired(scopeBinding, [sourceRef], seeded, 1)
    ).generation;
    const before = await publication.readSnapshot({ scopeBinding });
    const outboxBefore = await readOutboxCount();
    const revisionsBefore = await readRevisionPair(scopeBinding);
    let invoked = false;

    const code = await codeOf(
      withAuthorizedScope(
        context({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-1",
          authorizedSourceRefs: [sourceRef],
          // The revision is real, but it belongs to a different scope, so it
          // proves the check compares bindings rather than mere values.
          authorizationRevision: "auth-7",
          deadlineAt: farDeadline(),
        }),
        async () => {
          invoked = true;
        }
      )
    );

    expect(code).toBe("access_denied");
    expect(invoked).toBe(false);
    const after = await publication.readSnapshot({ scopeBinding });
    expect(after).toEqual(before);
    expect(sourceRow(after, sourceRef)?.generation).toBe(generation);
    expect(await readOutboxCount()).toBe(outboxBefore);
    expect(await readRevisionPair(scopeBinding)).toEqual(revisionsBefore);
  });

  it("serves only active scoped sources and keeps a zero-hit source in the view", async () => {
    const hitSource = unique("view-hit");
    const zeroSource = unique("view-zero");
    const hiddenSource = unique("view-hidden");
    const scopeBinding = unique("view-scope");
    const hiddenScope = unique("view-hidden-scope");
    const hit = await registerVersion(hitSource, "v1");
    const zero = await registerVersion(zeroSource, "v1");
    const hidden = await registerVersion(hiddenSource, "v1");
    await admitScope(scopeBinding, "auth-1");
    await admitScope(hiddenScope, "auth-1");
    const authorizedSourceRefs = [hitSource, zeroSource];
    const hitGeneration = (
      await declareDesired(scopeBinding, authorizedSourceRefs, hit, 1)
    ).generation;
    const zeroGeneration = (
      await declareDesired(scopeBinding, authorizedSourceRefs, zero, 1)
    ).generation;
    const hitAttempt = await startAttempt(hitSource, hitGeneration);
    await stageAttempt(
      scopeBinding,
      hitSource,
      hitAttempt.guard,
      "extract-hit",
      [entityFact(hit, UUIDS[0], "extract-hit", "View entity")]
    );
    expect(await publish(scopeBinding, hitSource, hitAttempt.guard)).toMatchObject({
      published: true,
    });
    const zeroAttempt = await startAttempt(zeroSource, zeroGeneration);
    await stageAttempt(scopeBinding, zeroSource, zeroAttempt.guard, "extract-zero", []);
    expect(await publish(scopeBinding, zeroSource, zeroAttempt.guard)).toMatchObject({
      published: true,
    });
    const hiddenGeneration = (
      await declareDesired(hiddenScope, [hiddenSource], hidden, 1)
    ).generation;
    await startAttempt(hiddenSource, hiddenGeneration);

    const views = await withAuthorizedScope(
      context({
        actorId: ACTOR,
        ownerScopeBinding: scopeBinding,
        readerBinding: "reader-1",
        authorizedSourceRefs,
        authorizationRevision: "auth-1",
        deadlineAt: farDeadline(),
      }),
      async (scope: ScopeWorkHandle) => ({
        accepted: await scope.readAcceptedInputs(authorizedSourceRefs),
        maintenance: await scope.readMaintenanceInputs(authorizedSourceRefs),
      })
    );
    const owner = await publication.readSnapshot({ scopeBinding });

    expect(refsOf(views.accepted.sources)).toEqual([hitSource, zeroSource]);
    expect(views.accepted.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRef: hitSource,
          sourceVersion: "v1",
          generation: hitGeneration,
          active: true,
        }),
        expect.objectContaining({
          sourceRef: zeroSource,
          generation: zeroGeneration,
          active: true,
        }),
      ])
    );
    expect(refsOf(views.maintenance.sources)).toEqual([hitSource, zeroSource]);
    expect(supportIdsOf(views.accepted.memberships)).toContain(
      supportIdFor(owner, UUIDS[0])
    );
    expect(resultIdsOf(views.accepted.memberships)).toContain(UUIDS[0]);
    expect(refsOf(views.accepted.memberships)).not.toContain(hiddenSource);
    expect(resultIdsOf(views.accepted.memberships)).not.toContain(UUIDS[2]);
    expect(views.maintenance.work.map((entry) => entry.sourceRef).sort()).toEqual([
      hitSource,
      zeroSource,
    ]);
    // The work rows must be the ledger's own records for this subset: a copy
    // minted per reader would mean the view is not the authority.
    expect(views.maintenance.work.map((entry) => entry.jobKey).sort()).toEqual(
      [hitAttempt.guard.jobKey, zeroAttempt.guard.jobKey].sort()
    );
    expect(
      views.maintenance.work.every((entry) => entry.status === "ready")
    ).toBe(true);
  });

  it("refuses a withdrawn source named by the trusted set without touching the rest of the scope", async () => {
    const keptSource = unique("kept-source");
    const droppedSource = unique("dropped-source");
    const scopeBinding = unique("drop-scope");
    const kept = await registerVersion(keptSource, "v1");
    const dropped = await registerVersion(droppedSource, "v1");
    await admitScope(scopeBinding, "auth-1");
    const authorizedSourceRefs = [keptSource, droppedSource];
    const keptGeneration = (
      await declareDesired(scopeBinding, authorizedSourceRefs, kept, 1)
    ).generation;
    await declareDesired(scopeBinding, authorizedSourceRefs, dropped, 1);
    const attempt = await startAttempt(keptSource, keptGeneration);
    await stageAttempt(
      scopeBinding,
      keptSource,
      attempt.guard,
      "extract-kept",
      [entityFact(kept, UUIDS[0], "extract-kept", "Kept name")]
    );
    expect(await publish(scopeBinding, keptSource, attempt.guard)).toMatchObject({
      published: true,
    });
    await withdrawSource(scopeBinding, droppedSource, 1);
    const before = await publication.readSnapshot({ scopeBinding });
    const outboxBefore = await readOutboxCount();
    const revisionsBefore = await readRevisionPair(scopeBinding);
    let invoked = false;

    const code = await codeOf(
      withAuthorizedScope(
        context({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-1",
          authorizedSourceRefs,
          authorizationRevision: "auth-1",
          deadlineAt: farDeadline(),
        }),
        async () => {
          invoked = true;
        }
      )
    );

    expect(code).toBe("input_stale");
    expect(invoked).toBe(false);
    const after = await publication.readSnapshot({ scopeBinding });
    expect(after).toEqual(before);
    expect(currentIds(after)).toEqual([UUIDS[0]]);
    expect(await readOutboxCount()).toBe(outboxBefore);
    expect(await readRevisionPair(scopeBinding)).toEqual(revisionsBefore);
  });

  it("refuses an expired execution deadline before running any write", async () => {
    const sourceRef = unique("expired-deadline-source");
    const scopeBinding = unique("expired-deadline-scope");
    const seeded = await registerVersion(sourceRef, "v1");
    await admitScope(scopeBinding, "auth-1");
    await declareDesired(scopeBinding, [sourceRef], seeded, 1);
    const before = await publication.readSnapshot({ scopeBinding });
    const revisionsBefore = await readRevisionPair(scopeBinding);
    let invoked = false;

    const code = await codeOf(
      withAuthorizedScope(
        context({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-1",
          authorizedSourceRefs: [sourceRef],
          authorizationRevision: "auth-1",
          deadlineAt: new Date(Date.now() - 1_000).toISOString(),
        }),
        async () => {
          invoked = true;
        }
      )
    );

    expect(code).toBe("execution_timeout");
    expect(invoked).toBe(false);
    expect(await publication.readSnapshot({ scopeBinding })).toEqual(before);
    expect(await readRevisionPair(scopeBinding)).toEqual(revisionsBefore);
  });

  it("refuses a deadline that expires while the callback is awaited", async () => {
    const sourceRef = unique("mid-deadline-source");
    const scopeBinding = unique("mid-deadline-scope");
    const seeded = await registerVersion(sourceRef, "v1");
    await admitScope(scopeBinding, "auth-1");
    const generation = (
      await declareDesired(scopeBinding, [sourceRef], seeded, 1)
    ).generation;
    const before = await publication.readSnapshot({ scopeBinding });
    const revisionsBefore = await readRevisionPair(scopeBinding);
    const outboxBefore = await readOutboxCount();
    const deadlineAt = new Date(Date.now() + 60).toISOString();

    await expectFailure(
      withAuthorizedScope(
        context({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-1",
          authorizedSourceRefs: [sourceRef],
          authorizationRevision: "auth-1",
          deadlineAt,
        }),
        async (scope: ScopeWorkHandle) => {
          await scope.readAcceptedInputs([sourceRef]);
          await sleep(220);
          expect(Date.now()).toBeGreaterThanOrEqual(new Date(deadlineAt).getTime());
        }
      ),
      "execution_timeout"
    );

    const after = await publication.readSnapshot({ scopeBinding });
    expect(after).toEqual(before);
    expect(sourceRow(after, sourceRef)?.generation).toBe(generation);
    expect(await readOutboxCount()).toBe(outboxBefore);
    expect(await readRevisionPair(scopeBinding)).toEqual(revisionsBefore);
  });

  it("refuses the publication path once the attempt outlives its absolute bound", async () => {
    const sourceRef = unique("absolute-bound-source");
    const scopeBinding = unique("absolute-bound-scope");
    const seeded = await registerVersion(sourceRef, "v1");
    await admitScope(scopeBinding, "auth-1");
    const generation = (
      await declareDesired(scopeBinding, [sourceRef], seeded, 1)
    ).generation;
    // The fence is decided by the database clock, so the attempt is claimed with
    // an already expired start stamp instead of waiting out the limit. The lease
    // expires from the same stamp, so only the correct precedence of the
    // absolute bound can report a timeout here.
    clock.set(new Date(Date.now() - WORK_ABSOLUTE_LIMIT_MS - 1_000));
    const attempt = await startAttempt(sourceRef, generation);
    const before = await publication.readSnapshot({ scopeBinding });
    const revisionsBefore = await readRevisionPair(scopeBinding);
    const outboxBefore = await readOutboxCount();

    await expectFailure(
      publish(scopeBinding, sourceRef, attempt.guard),
      "execution_timeout"
    );

    const after = await publication.readSnapshot({ scopeBinding });
    expect(after).toEqual(before);
    expect(await readOutboxCount()).toBe(outboxBefore);
    expect(await readRevisionPair(scopeBinding)).toEqual(revisionsBefore);
    expect(await work.getJob(attempt.guard.jobKey)).toMatchObject({
      status: "running",
      attemptCount: 1,
    });
    clock.set(new Date());
  });

  it("rolls back identity, membership, ledger and outbox when the projection write fails", async () => {
    const sourceRef = unique("projection-fault-source");
    const scopeBinding = unique("projection-fault-scope");
    const seeded = await registerVersion(sourceRef, "v1");
    await admitScope(scopeBinding, "auth-1");
    const generation = (
      await declareDesired(scopeBinding, [sourceRef], seeded, 1)
    ).generation;
    const attempt = await startAttempt(sourceRef, generation);
    const relationNorm = unique("fault_relation");
    await stageAttempt(
      scopeBinding,
      sourceRef,
      attempt.guard,
      "extract-fault",
      [
        entityFact(seeded, UUIDS[0], "extract-fault", "Head"),
        entityFact(seeded, UUIDS[1], "extract-fault", "Tail", 3),
        assertionFact(seeded, "extract-fault", relationNorm),
      ]
    );
    const before = await publication.readSnapshot({ scopeBinding });
    const revisionsBefore = await readRevisionPair(scopeBinding);
    const outboxBefore = await readOutboxCount();
    const identityBefore = await countRows(
      "SELECT count(*)::text AS count FROM structured_entity_identities WHERE entity_id = $1::uuid",
      [UUIDS[0]]
    );
    const assertionId = derivedAssertionId(relationNorm);
    expect(await identity.findRelationAssertion(assertionId)).toBeNull();
    await injectFault({
      table: "projection_outbox",
      mode: "fail",
      subjectId: UUIDS[0],
    });

    await expectFailure(
      publish(scopeBinding, sourceRef, attempt.guard),
      "backend_unavailable"
    );

    const after = await publication.readSnapshot({ scopeBinding });
    expect(after).toEqual(before);
    expect(currentIds(after)).toEqual([]);
    expect(await identity.findRelationAssertion(assertionId)).toBeNull();
    // entity_id is a global organization primary key reused across scenarios, so an
    // earlier published identity legitimately owns this row; a prior scenario, not
    // this one, accounts for a non-zero baseline. Rollback means the failed publish
    // changed nothing, measured as a delta exactly like outbox/snapshot/revisions
    // above. A leaked insert would still move the count and fail here.
    expect(
      await countRows(
        "SELECT count(*)::text AS count FROM structured_entity_identities WHERE entity_id = $1::uuid",
        [UUIDS[0]]
      )
    ).toBe(identityBefore);
    expect(await readOutboxCount()).toBe(outboxBefore);
    expect(await readRevisionPair(scopeBinding)).toEqual(revisionsBefore);
    expect(await work.getJob(attempt.guard.jobKey)).toMatchObject({
      status: "running",
      attemptCount: 1,
    });
  });

  it("keeps the primary typed failure when a commit-side write fails and keeps rollback diagnostics safe", async () => {
    const sourceRef = unique("commit-fault-source");
    const scopeBinding = unique("commit-fault-scope");
    const seeded = await registerVersion(sourceRef, "v1");
    await admitScope(scopeBinding, "auth-1");
    const generation = (
      await declareDesired(scopeBinding, [sourceRef], seeded, 1)
    ).generation;
    const attempt = await startAttempt(sourceRef, generation);
    await stageAttempt(
      scopeBinding,
      sourceRef,
      attempt.guard,
      "extract-commit-fault",
      [entityFact(seeded, UUIDS[0], "extract-commit-fault", "Commit fault")]
    );
    const before = await publication.readSnapshot({ scopeBinding });
    const revisionsBefore = await readRevisionPair(scopeBinding);
    const outboxBefore = await readOutboxCount();
    await injectFault({
      table: "maintenance_jobs",
      mode: "fail",
      jobKey: attempt.guard.jobKey,
    });

    let thrown: unknown;
    try {
      await publish(scopeBinding, sourceRef, attempt.guard);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    // A fault that carries no domain code of its own is still a named backend
    // failure; mapping it away would lose the reason the caller branches on.
    expect(errorCodeOf(thrown)).toBe("backend_unavailable");
    // Rollback metadata stays safe: error names and SQLSTATE-shaped codes only,
    // never the injected message text or a SQL fragment.
    const suppressed = getSuppressedFailureContext(thrown);
    expect(
      suppressed.every(
        (entry) =>
          !JSON.stringify(entry).includes("SECRET-LEAK") &&
          !JSON.stringify(entry).toLowerCase().includes("update")
      )
    ).toBe(true);

    const after = await publication.readSnapshot({ scopeBinding });
    expect(after).toEqual(before);
    expect(await readOutboxCount()).toBe(outboxBefore);
    expect(await readRevisionPair(scopeBinding)).toEqual(revisionsBefore);
  });

  it("advances the scope revision exactly once when a write commits through the seam", async () => {
    const sourceRef = unique("seam-write-source");
    const scopeBinding = unique("seam-write-scope");
    const seeded = await registerVersion(sourceRef, "v1");
    await admitScope(scopeBinding, "auth-1");
    await declareDesired(scopeBinding, [sourceRef], seeded, 1);
    const marker = randomUUID();
    const revisionsBefore = await readRevisionPair(scopeBinding);
    expect(await countOutboxIntent(marker)).toBe(0);

    await backend.structuredScopeUnitOfWork.withAuthorizedScope(
      context({
        actorId: ACTOR,
        ownerScopeBinding: scopeBinding,
        readerBinding: "reader-1",
        authorizedSourceRefs: [sourceRef],
        authorizationRevision: "auth-1",
        deadlineAt: farDeadline(),
      }),
      async (work) => {
        // The durable effect and the deferred revision intent share the seam's one
        // transaction: the bump is only registered here and must move the counters
        // exactly once, at the single commit, alongside this insert.
        await work.client.query(
          `INSERT INTO projection_outbox (id, subject_kind, subject_id, status)
           VALUES ($1, 'entity', $2, 'pending')`,
          [marker, marker]
        );
        work.bumpRevisions({ read: true, maintenance: true });
      }
    );

    expect(await countOutboxIntent(marker)).toBe(1);
    const revisionsAfter = await readRevisionPair(scopeBinding);
    expect(BigInt(revisionsAfter.read)).toBe(BigInt(revisionsBefore.read) + 1n);
    expect(BigInt(revisionsAfter.maintenance)).toBe(
      BigInt(revisionsBefore.maintenance) + 1n
    );
  });

  it("rolls back a seam write and its revision bump together when the commit-side advance fails", async () => {
    const sourceRef = unique("seam-rollback-source");
    const scopeBinding = unique("seam-rollback-scope");
    const seeded = await registerVersion(sourceRef, "v1");
    await admitScope(scopeBinding, "auth-1");
    await declareDesired(scopeBinding, [sourceRef], seeded, 1);
    const marker = randomUUID();
    const revisionsBefore = await readRevisionPair(scopeBinding);

    // Injected after the scenario's own setup writes, the once-firing trigger hits
    // the first scope UPDATE the seam makes: its deferred revision advance, which
    // runs after the callback already inserted the outbox intent. That is a failure
    // inside the commit window, so neither the intent nor the counters may survive.
    await injectFault({ table: "structured_publication_scopes", mode: "fail" });

    await expectFailure(
      backend.structuredScopeUnitOfWork.withAuthorizedScope(
        context({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-1",
          authorizedSourceRefs: [sourceRef],
          authorizationRevision: "auth-1",
          deadlineAt: farDeadline(),
        }),
        async (work) => {
          await work.client.query(
            `INSERT INTO projection_outbox (id, subject_kind, subject_id, status)
           VALUES ($1, 'entity', $2, 'pending')`,
            [marker, marker]
          );
          work.bumpRevisions({ read: true, maintenance: true });
        }
      ),
      "backend_unavailable"
    );

    expect(await countOutboxIntent(marker)).toBe(0);
    expect(await readRevisionPair(scopeBinding)).toEqual(revisionsBefore);
  });

  it("leaves the last accepted state intact across a sequence of refused attempts", async () => {
    const keptSource = unique("refusal-sequence-kept");
    const droppedSource = unique("refusal-sequence-dropped");
    const scopeBinding = unique("refusal-sequence-scope");
    const kept = await registerVersion(keptSource, "v1");
    const dropped = await registerVersion(droppedSource, "v1");
    await admitScope(scopeBinding, "auth-1");
    const authorizedSourceRefs = [keptSource, droppedSource];
    const keptGeneration = (
      await declareDesired(scopeBinding, authorizedSourceRefs, kept, 1)
    ).generation;
    await declareDesired(scopeBinding, authorizedSourceRefs, dropped, 1);
    const acceptedAttempt = await startAttempt(keptSource, keptGeneration);
    await stageAttempt(
      scopeBinding,
      keptSource,
      acceptedAttempt.guard,
      "extract-sequence",
      [entityFact(kept, UUIDS[0], "extract-sequence", "Kept entity")]
    );
    expect(
      await publish(scopeBinding, keptSource, acceptedAttempt.guard)
    ).toMatchObject({ published: true });
    await withdrawSource(scopeBinding, droppedSource, 1);
    const accepted = await publication.readSnapshot({ scopeBinding });
    const acceptedOutbox = await readOutboxCount();
    const acceptedRevisions = await readRevisionPair(scopeBinding);
    const acceptedLedger = await work.getJob(acceptedAttempt.guard.jobKey);
    expect(currentIds(accepted)).toEqual([UUIDS[0]]);
    const readView = async (scope: ScopeWorkHandle) =>
      scope.readAcceptedInputs([keptSource]);

    await expectFailure(
      withAuthorizedScope(
        context({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-1",
          authorizedSourceRefs,
          authorizationRevision: "auth-1",
          deadlineAt: farDeadline(),
        }),
        readView
      ),
      "input_stale"
    );
    await expectFailure(
      withAuthorizedScope(
        context({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-1",
          authorizedSourceRefs: [keptSource],
          authorizationRevision: "auth-1",
          deadlineAt: new Date(Date.now() - 1_000).toISOString(),
        }),
        readView
      ),
      "execution_timeout"
    );
    // The attempt that already settled has no write fence left.
    await expectFailure(
      publish(scopeBinding, keptSource, acceptedAttempt.guard),
      "lease_lost"
    );

    expect(await publication.readSnapshot({ scopeBinding })).toEqual(accepted);
    expect(await readOutboxCount()).toBe(acceptedOutbox);
    expect(await readRevisionPair(scopeBinding)).toEqual(acceptedRevisions);
    expect(await work.getJob(acceptedAttempt.guard.jobKey)).toEqual(acceptedLedger);
  });

  it("publishes the same staged payload on the attempt after a refused one", async () => {
    const sourceRef = unique("restart-source");
    const scopeBinding = unique("restart-scope");
    const seeded = await registerVersion(sourceRef, "v1");
    await admitScope(scopeBinding, "auth-1");
    const generation = (
      await declareDesired(scopeBinding, [sourceRef], seeded, 1)
    ).generation;
    const attempt = await startAttempt(sourceRef, generation);
    await stageAttempt(
      scopeBinding,
      sourceRef,
      attempt.guard,
      "extract-restart",
      [entityFact(seeded, UUIDS[0], "extract-restart", "Restarted entity")]
    );
    await injectFault({
      table: "projection_outbox",
      mode: "fail",
      subjectId: UUIDS[0],
    });
    const firstCode = await codeOf(
      publish(scopeBinding, sourceRef, attempt.guard)
    );
    expect(firstCode).toBe("backend_unavailable");
    const refusedState = await publication.readSnapshot({ scopeBinding });
    const refusedOutbox = await readOutboxCount();
    expect(currentIds(refusedState)).toEqual([]);

    const published = await publish(scopeBinding, sourceRef, attempt.guard);

    expect(published).toMatchObject({ published: true });
    const settled = await publication.readSnapshot({ scopeBinding });
    expect(currentIds(settled)).toEqual([UUIDS[0]]);
    // Exactly one accepted write, so the counters moved exactly once.
    expect(settled.readRevision).not.toBe(refusedState.readRevision);
    expect(await readOutboxCount()).toBe(refusedOutbox + 1);
    expect(await work.getJob(attempt.guard.jobKey)).toMatchObject({
      status: "ready",
    });
  });

  const workMutations = [
    "schedule",
    "claim",
    "heartbeat",
    "settle",
    "retry",
    "reclaim",
  ] as const;
  type WorkMutation = (typeof workMutations)[number];

  const expectedLedger: Record<
    WorkMutation,
    { status: MaintenanceJobRecord["status"]; attemptCount: number }
  > = {
    schedule: { status: "pending", attemptCount: 0 },
    claim: { status: "running", attemptCount: 1 },
    heartbeat: { status: "running", attemptCount: 1 },
    settle: { status: "failed", attemptCount: 1 },
    retry: { status: "pending", attemptCount: 1 },
    reclaim: { status: "pending", attemptCount: 1 },
  };

  it.each(workMutations)(
    "first owner assignment racing %s keeps one owner and its own ledger state",
    async (mutation) => {
      const sourceRef = unique(`race-${mutation}-source`);
      const scopeBinding = unique(`race-${mutation}-scope`);
      const otherScope = unique(`race-${mutation}-other`);
      const seeded = await registerVersion(sourceRef, "v1");
      await admitScope(scopeBinding, "auth-1");
      await admitScope(otherScope, "auth-1");
      const deps = workDeps();
      const dependencies: MaintenanceDependency[] = [
        {
          sourceRef,
          generation: 1,
          extractionRevision: null,
          relationBuckets: [],
        },
      ];
      const live: MaintenanceLiveInputs = {
        configRevision: "extractor-v1",
        dependencies,
      };

      // The job is scheduled by the standalone path while the source still has
      // no owner, which is exactly the state a first assignment must not orphan.
      const job = requireScheduled(
        await scheduleWork(
          deps,
          { actorId: ACTOR },
          publishRequest(sourceRef, 1, dependencies)
        )
      );
      createdJobs.push(job.jobKey);
      let guard: MaintenanceAttemptGuard | null = null;
      // For the claim race the raced call is itself the first claim, so the job
      // must stay pending until it runs against the incoming assignment.
      if (mutation !== "schedule" && mutation !== "claim") {
        guard = requireGuard((await claimNextWork(deps)).guard);
      }
      if (mutation === "retry") {
        expect(
          await settleWork(
            deps,
            requireGuard(guard),
            { status: "failed", failureCode: "invalid_input" },
            live
          )
        ).toMatchObject({ result: "settled" });
      }
      if (mutation === "reclaim") {
        clock.advance(WORK_LEASE_MS + 1);
      }

      const raced: Promise<unknown> = (async () => {
        switch (mutation) {
          case "schedule":
            return scheduleWork(
              deps,
              { actorId: ACTOR },
              publishRequest(sourceRef, 1, [
                ...dependencies,
                {
                  sourceRef: `${sourceRef}-dependency`,
                  generation: 1,
                  extractionRevision: null,
                  relationBuckets: [],
                },
              ])
            );
          case "claim":
            return claimNextWork(deps);
          case "heartbeat":
            return work.heartbeatWork(requireGuard(guard), clock());
          case "settle":
            return settleWork(
              deps,
              requireGuard(guard),
              { status: "failed", failureCode: "invalid_input" },
              live
            );
          case "retry":
            return retryWork(deps, job.jobKey);
          case "reclaim":
            return work.reclaimExpiredWork(clock());
        }
      })();
      const assignment = declareDesired(scopeBinding, [sourceRef], seeded, 1);
      const [assignmentCode, racedOutcome] = await Promise.all([
        codeOf(assignment),
        raced,
      ]);

      expect(assignmentCode).toBeUndefined();
      if (mutation === "heartbeat") expect(racedOutcome).toBe(true);
      if (mutation === "claim") {
        expect(
          (racedOutcome as { guard: MaintenanceAttemptGuard | null }).guard
        ).toMatchObject({ jobKey: job.jobKey, attemptNumber: 1 });
      }
      if (mutation === "settle") {
        expect(racedOutcome).toMatchObject({
          result: "settled",
          record: { status: "failed", lastFailureCode: "invalid_input" },
        });
      }
      if (mutation === "retry") {
        expect(racedOutcome).toMatchObject({ status: "pending" });
      }
      if (mutation === "reclaim") {
        expect(racedOutcome).toEqual([{ jobKey: job.jobKey, reclaimed: true }]);
      }

      const owned = await publication.readSnapshot({ scopeBinding });
      expect(sourceRow(owned, sourceRef)).toMatchObject({
        active: true,
        generation: 1,
        desired: { sourceVersion: "v1", extractionRevision: 1 },
        published: null,
      });
      expect(owned.subjects).toEqual([]);
      expect(
        await countRows(
          `SELECT count(*)::text AS count FROM structured_publication_sources
            WHERE source_ref = $1`,
          [sourceRef]
        )
      ).toBe(1);

      const ledger = await work.getJob(job.jobKey);
      expect(ledger).toMatchObject({
        jobKey: job.jobKey,
        sourceRef,
        sourceGeneration: 1,
        status: expectedLedger[mutation].status,
        attemptCount: expectedLedger[mutation].attemptCount,
      });

      const secondOwnerCode = await codeOf(
        publication.declareDesired({
          scopeBinding: otherScope,
          authorizedSourceRefs: [sourceRef],
          sourceRef,
          sourceVersion: seeded.record,
          locatorBindings: seeded.locatorBindings,
          desiredExtractionRevision: 1,
          configRevision: "extractor-v1",
        })
      );
      expect(secondOwnerCode).toBe("unsupported_source_binding");
      expect(
        (await publication.readSnapshot({ scopeBinding: otherScope })).sources
      ).toEqual([]);
    }
  );

  it("keeps an already-running formerly unowned job publishable under its new single owner", async () => {
    const sourceRef = unique("running-owner-source");
    const scopeBinding = unique("running-owner-scope");
    const seeded = await registerVersion(sourceRef, "v1");
    await admitScope(scopeBinding, "auth-1");
    const deps = workDeps();
    const job = requireScheduled(
      await scheduleWork(deps, { actorId: ACTOR }, publishRequest(sourceRef, 1))
    );
    createdJobs.push(job.jobKey);
    const guard = requireGuard((await claimNextWork(deps)).guard);
    expect(guard.jobKey).toBe(job.jobKey);

    // A standalone attempt cannot serve current state before anyone owns it.
    await expectFailure(
      publication.stageAttempt({
        scopeBinding,
        sourceRef,
        guard,
        extractionRef: "extract-orphan",
        accepted: [],
      }),
      "access_denied"
    );

    const generation = (
      await declareDesired(scopeBinding, [sourceRef], seeded, 1)
    ).generation;
    expect(generation).toBe(1);
    expect(await work.heartbeatWork(guard, clock())).toBe(true);
    expect(await work.getJob(job.jobKey)).toMatchObject({
      status: "running",
      attemptCount: 1,
    });

    await stageAttempt(scopeBinding, sourceRef, guard, "extract-owner", [
      entityFact(seeded, UUIDS[0], "extract-owner", "Owned entity"),
    ]);
    expect(await publish(scopeBinding, sourceRef, guard)).toMatchObject({
      published: true,
    });

    const snapshot = await publication.readSnapshot({ scopeBinding });
    expect(currentIds(snapshot)).toEqual([UUIDS[0]]);
    expect(sourceRow(snapshot, sourceRef)).toMatchObject({
      generation: 1,
      published: { sourceVersion: "v1", extractionRevision: 1 },
      status: "ready",
    });
    expect(await work.getJob(job.jobKey)).toMatchObject({
      status: "ready",
      attemptCount: 1,
    });
    expect(await work.listAttempts(job.jobKey)).toHaveLength(1);
    // One owner row for the one owned source: ownership is not replicated when a
    // standalone job gains its first owner.
    expect(snapshot.sources.filter((row) => row.active)).toHaveLength(1);
    expect(new Set(snapshot.sources.map((row) => row.sourceRef)).size).toBe(
      snapshot.sources.length
    );
  });

  it("lets exactly one of two concurrent first assignments win without partial state", async () => {
    const sourceRef = unique("dual-owner-source");
    const scopeA = unique("dual-owner-a");
    const scopeB = unique("dual-owner-b");
    const seeded = await registerVersion(sourceRef, "v1");
    await admitScope(scopeA, "auth-1");
    await admitScope(scopeB, "auth-1");

    const [firstCode, secondCode] = await Promise.all([
      codeOf(declareDesired(scopeA, [sourceRef], seeded, 1)),
      codeOf(declareDesired(scopeB, [sourceRef], seeded, 1)),
    ]);

    expect(
      [firstCode, secondCode].filter((code) => code === undefined)
    ).toHaveLength(1);
    expect(
      [firstCode, secondCode].filter((code) => code !== undefined)
    ).toEqual(["unsupported_source_binding"]);
    const winner = firstCode === undefined ? scopeA : scopeB;
    const loser = firstCode === undefined ? scopeB : scopeA;
    const winnerSnapshot = await publication.readSnapshot({
      scopeBinding: winner,
    });
    const loserSnapshot = await publication.readSnapshot({
      scopeBinding: loser,
    });
    expect(sourceRow(winnerSnapshot, sourceRef)?.generation).toBe(1);
    expect(winnerSnapshot.subjects).toEqual([]);
    expect(loserSnapshot.sources).toEqual([]);
    expect(loserSnapshot.subjects).toEqual([]);
    expect(
      await countRows(
        `SELECT count(*)::text AS count FROM structured_publication_sources
          WHERE scope_binding = $1 AND source_ref = $2`,
        [loser, sourceRef]
      )
    ).toBe(0);
    expect(
      await countRows(
        "SELECT count(*)::text AS count FROM structured_publication_sources WHERE source_ref = $1",
        [sourceRef]
      )
    ).toBe(1);

    const views = await withAuthorizedScope(
      context({
        actorId: ACTOR,
        ownerScopeBinding: winner,
        readerBinding: "reader-1",
        authorizedSourceRefs: [sourceRef],
        authorizationRevision: "auth-1",
        deadlineAt: farDeadline(),
      }),
      async (scope: ScopeWorkHandle) =>
        refsOf((await scope.readAcceptedInputs([sourceRef])).sources)
    );
    expect(views).toEqual([sourceRef]);
  });

  it("serves two disjoint reader subsets under one owner without duplicating owner state", async () => {
    const firstSource = unique("subset-first");
    const secondSource = unique("subset-second");
    const scopeBinding = unique("subset-scope");
    const first = await registerVersion(firstSource, "v1");
    const second = await registerVersion(secondSource, "v1");
    await admitScope(scopeBinding, "auth-1");
    const authorizedSourceRefs = [firstSource, secondSource];
    const firstGeneration = (
      await declareDesired(scopeBinding, authorizedSourceRefs, first, 1)
    ).generation;
    const secondGeneration = (
      await declareDesired(scopeBinding, authorizedSourceRefs, second, 1)
    ).generation;
    const firstAttempt = await startAttempt(firstSource, firstGeneration);
    await stageAttempt(
      scopeBinding,
      firstSource,
      firstAttempt.guard,
      "extract-first",
      [entityFact(first, UUIDS[0], "extract-first", "First name")]
    );
    expect(await publish(scopeBinding, firstSource, firstAttempt.guard)).toMatchObject({
      published: true,
    });
    const secondAttempt = await startAttempt(secondSource, secondGeneration);
    await stageAttempt(
      scopeBinding,
      secondSource,
      secondAttempt.guard,
      "extract-second",
      [entityFact(second, UUIDS[1], "extract-second", "Second name")]
    );
    expect(await publish(scopeBinding, secondSource, secondAttempt.guard)).toMatchObject({
      published: true,
    });
    const sharedAuthorization = await readRevisionPair(scopeBinding);

    const subsets = await Promise.all(
      [
        { reader: "reader-first", refs: [firstSource] },
        { reader: "reader-second", refs: [secondSource] },
      ].map(async ({ reader, refs }) =>
        withAuthorizedScope(
          context({
            actorId: ACTOR,
            ownerScopeBinding: scopeBinding,
            readerBinding: reader,
            authorizedSourceRefs,
            authorizationRevision: "auth-1",
            deadlineAt: farDeadline(),
          }),
          async (scope: ScopeWorkHandle) => {
            const accepted = await scope.readAcceptedInputs(refs);
            const maintenance = await scope.readMaintenanceInputs(refs);
            return {
              reader,
              sources: refsOf(accepted.sources),
              results: resultIdsOf(accepted.memberships),
              jobs: maintenance.work.map((entry) => entry.jobKey).sort(),
              revisions: accepted.readRevision,
              authorization: accepted.authorizationRevision,
            };
          }
        )
      )
    );

    // One owner, two authorized subsets: each reader sees only its own rows, and
    // neither can see a hidden count or another reader's material.
    expect(subsets[0]?.sources).toEqual([firstSource]);
    expect(subsets[0]?.results).toEqual([UUIDS[0]]);
    expect(subsets[0]?.jobs).toEqual([firstAttempt.guard.jobKey]);
    expect(subsets[1]?.sources).toEqual([secondSource]);
    expect(subsets[1]?.results).toEqual([UUIDS[1]]);
    expect(subsets[1]?.jobs).toEqual([secondAttempt.guard.jobKey]);
    expect(subsets[0]?.results).not.toContain(UUIDS[1]);
    expect(subsets[1]?.results).not.toContain(UUIDS[0]);
    expect(subsets[0]?.authorization).toBe("auth-1");
    expect(subsets[1]?.authorization).toBe("auth-1");
    // Both readers are bound to the same live owner state, not to a copy.
    expect(typeof subsets[0]?.revisions).toBe("number");
    expect(await readRevisionPair(scopeBinding)).toEqual(sharedAuthorization);

    const owner = await publication.readSnapshot({ scopeBinding });
    expect(currentIds(owner)).toEqual([UUIDS[0], UUIDS[1]].sort());
    expect(
      await countRows(
        `SELECT count(*)::text AS count FROM structured_publication_sources
          WHERE scope_binding = $1`,
        [scopeBinding]
      )
    ).toBe(2);
    expect(
      await countRows(
        "SELECT count(*)::text AS count FROM structured_publication_scopes WHERE scope_binding = $1",
        [scopeBinding]
      )
    ).toBe(1);
  });

  it("refuses a reader that selects another reader's subset inside the unit of work", async () => {
    const ownSource = unique("select-own");
    const foreignSource = unique("select-foreign");
    const scopeBinding = unique("select-scope");
    const own = await registerVersion(ownSource, "v1");
    const foreign = await registerVersion(foreignSource, "v1");
    await admitScope(scopeBinding, "auth-1");
    const authorizedSourceRefs = [ownSource, foreignSource];
    const ownGeneration = (
      await declareDesired(scopeBinding, authorizedSourceRefs, own, 1)
    ).generation;
    const foreignGeneration = (
      await declareDesired(scopeBinding, authorizedSourceRefs, foreign, 1)
    ).generation;
    const ownAttempt = await startAttempt(ownSource, ownGeneration);
    await stageAttempt(scopeBinding, ownSource, ownAttempt.guard, "extract-own", [
      entityFact(own, UUIDS[0], "extract-own", "Own name"),
    ]);
    expect(await publish(scopeBinding, ownSource, ownAttempt.guard)).toMatchObject({
      published: true,
    });
    const foreignAttempt = await startAttempt(foreignSource, foreignGeneration);
    await stageAttempt(
      scopeBinding,
      foreignSource,
      foreignAttempt.guard,
      "extract-foreign",
      [entityFact(foreign, UUIDS[1], "extract-foreign", "Foreign name")]
    );
    expect(await publish(scopeBinding, foreignSource, foreignAttempt.guard)).toMatchObject({
      published: true,
    });
    const before = await publication.readSnapshot({ scopeBinding });
    const revisionsBefore = await readRevisionPair(scopeBinding);
    const outboxBefore = await readOutboxCount();

    const code = await codeOf(
      withAuthorizedScope(
        context({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-narrow",
          authorizedSourceRefs: [ownSource],
          authorizationRevision: "auth-1",
          deadlineAt: farDeadline(),
        }),
        async (scope: ScopeWorkHandle) => {
          await scope.readAcceptedInputs([ownSource]);
          return scope.readMaintenanceInputs([ownSource, foreignSource]);
        }
      )
    );

    expect(code).toBe("access_denied");
    expect(await publication.readSnapshot({ scopeBinding })).toEqual(before);
    expect(await readRevisionPair(scopeBinding)).toEqual(revisionsBefore);
    expect(await readOutboxCount()).toBe(outboxBefore);
  });

  it("settles an owner churn race without partial state or a lost accepted write", async () => {
    const sourceRef = unique("churn-source");
    const stableSource = unique("churn-stable");
    const scopeBinding = unique("churn-scope");
    const seeded = await registerVersion(sourceRef, "v1");
    const stable = await registerVersion(stableSource, "v1");
    await admitScope(scopeBinding, "auth-1");
    const authorizedSourceRefs = [sourceRef, stableSource];
    const generation = (
      await declareDesired(scopeBinding, authorizedSourceRefs, seeded, 1)
    ).generation;
    const stableGeneration = (
      await declareDesired(scopeBinding, authorizedSourceRefs, stable, 1)
    ).generation;
    await publishOneEntity(scopeBinding, sourceRef, seeded, generation, UUIDS[0]);
    await publishOneEntity(
      scopeBinding,
      stableSource,
      stable,
      stableGeneration,
      UUIDS[1]
    );
    const churnedFrom = (
      await publication.readSnapshot({ scopeBinding })
    ).sources.find((row) => row.sourceRef === sourceRef)?.generation;
    if (churnedFrom === undefined) {
      throw new Error("test setup lost the churn source row");
    }
    const revisionsBefore = await readRevisionPair(scopeBinding);
    const outboxBefore = await readOutboxCount();
    let churnCommits = 0;
    let stop = false;
    const churnState = { generation: churnedFrom };

    // Real owner-side writes from separate connections: the source repeatedly
    // leaves and re-enters the active set while the unit of work routes. A router
    // that never releases its locks long enough for these to commit would hang
    // this scenario, and one that commits an attempt it could not revalidate
    // would leave a partial write.
    const churn = (async () => {
      while (!stop && churnCommits < 12) {
        const withdrawn = await withdrawSource(
          scopeBinding,
          sourceRef,
          churnState.generation
        );
        churnState.generation = withdrawn.generation;
        churnCommits += 1;
        if (stop) break;
        const declared = await declareDesired(
          scopeBinding,
          [sourceRef, stableSource],
          seeded,
          churnCommits + 10
        );
        churnState.generation = declared.generation;
        churnCommits += 1;
      }
    })();
    const code = await codeOf(
      withAuthorizedScope(
        context({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-1",
          authorizedSourceRefs,
          authorizationRevision: "auth-1",
          deadlineAt: farDeadline(),
        }),
        async (scope: ScopeWorkHandle) => {
          await scope.readAcceptedInputs(authorizedSourceRefs);
          return scope.readMaintenanceInputs(authorizedSourceRefs);
        }
      )
    );
    stop = true;
    await churn;

    expect(
      code === undefined || code === "input_stale" || code === "execution_timeout"
    ).toBe(true);
    expect(code).not.toBe("backend_unavailable");
    expect(churnCommits).toBeGreaterThan(0);
    const after = await publication.readSnapshot({ scopeBinding });
    // Whatever the routed run decided, every accepted churn write is visible and
    // the untouched sibling source is intact.
    expect(sourceRow(after, sourceRef)?.generation).toBe(churnState.generation);
    expect(sourceRow(after, stableSource)?.generation).toBe(stableGeneration);
    expect(currentIds(after)).toEqual([UUIDS[1]]);
    const revisionsAfter = await readRevisionPair(scopeBinding);
    expect(Number(revisionsAfter.read) > Number(revisionsBefore.read)).toBe(true);
    // The routed unit of work is read-only, and churn withdraws a source that no
    // longer has current published subjects to remove, so it emits no projection
    // intent. The spec's outbox promise here is negative (L151): no refused or
    // restarted attempt adds an outbox effect. The accepted churn writes are proven
    // visible by the generation and current-subject assertions above.
    expect(await readOutboxCount()).toBe(outboxBefore);
  });

  it("keeps concurrent owners, claims, settlements and publications lock-compatible", async () => {
    const scopes = [unique("lock-scope-a"), unique("lock-scope-b")];
    const sources = [
      unique("lock-source-1"),
      unique("lock-source-2"),
      unique("lock-source-3"),
      unique("lock-source-4"),
    ];
    const seededBySource = new Map<string, SeededVersion>();
    for (const sourceRef of sources) {
      seededBySource.set(sourceRef, await registerVersion(sourceRef, "v1"));
    }
    for (const scopeBinding of scopes) await admitScope(scopeBinding, "auth-1");

    // Declare each scope's full authorized set up front. `declareDesired` replaces
    // the scope's authorized set, so a per-flow single-source declaration would
    // deactivate a sibling and turn a legitimate publish into `input_stale` — an
    // outcome this test must not confuse with a lock failure.
    const plan = sources.map((sourceRef, index) => ({
      sourceRef,
      scopeBinding: scopes[index % 2] as string,
      seeded: seededBySource.get(sourceRef) as SeededVersion,
      generation: 0,
      guard: undefined as unknown as MaintenanceAttemptGuard,
    }));
    for (const scopeBinding of scopes) {
      const members = plan.filter((entry) => entry.scopeBinding === scopeBinding);
      const refs = members.map((entry) => entry.sourceRef);
      for (const member of members) {
        member.generation = (
          await declareDesired(scopeBinding, refs, member.seeded, 1)
        ).generation;
      }
    }

    // Claim serially before the concurrent phase: the ledger's claim is global, so
    // concurrent `startAttempt` calls would cross-pick one another's jobs. Serial
    // claiming pins each flow to its own guard, so only the publish commit runs
    // concurrently — which is exactly the job/scope/source ordering the shared
    // authority guarantees to be lock-compatible.
    for (const member of plan) {
      member.guard = (await startAttempt(member.sourceRef, member.generation)).guard;
    }

    const outcomes = await Promise.all(
      plan.map(async (member, index) => {
        const { sourceRef, scopeBinding, seeded, guard } = member;
        try {
          await stageAttempt(scopeBinding, sourceRef, guard, "extract-lock", [
            entityFact(seeded, UUIDS[2], "extract-lock", `Lock entity ${index}`),
          ]);
          await publish(scopeBinding, sourceRef, guard);
          // A settled attempt must lose its lease rights: the heartbeat is
          // refused by the ledger rather than resurrecting the finished run,
          // and the refusal is a plain false, not a lock timeout or a
          // rolled-back publication.
          const heartbeat = await work.heartbeatWork(guard, clock());
          return {
            sourceRef,
            scopeBinding,
            code: undefined as string | undefined,
            sqlState: undefined as string | undefined,
            heartbeat,
          };
        } catch (error) {
          return {
            sourceRef,
            scopeBinding,
            code: errorCodeOf(error),
            sqlState: sqlStateOf(error),
            heartbeat: undefined as boolean | undefined,
          };
        }
      })
    );

    for (const outcome of outcomes) {
      // A lock inversion shows up here as a storage failure or a deadlock/
      // serialization SQLSTATE; neither is an acceptable outcome of one order.
      expect(outcome.code).toBeUndefined();
      expect(outcome.sqlState).toBeUndefined();
      expect(outcome.heartbeat).toBe(false);
    }
    for (const sourceRef of sources) {
      expect(
        await countRows(
          "SELECT count(*)::text AS count FROM structured_publication_sources WHERE source_ref = $1",
          [sourceRef]
        )
      ).toBe(1);
    }
    for (const scopeBinding of scopes) {
      const snapshot = await publication.readSnapshot({ scopeBinding });
      expect(snapshot.subjects.length).toBeGreaterThan(0);
    }
  });
});

/** One published source with a single entity subject, for authority probes. */
async function publishOneEntity(
  scopeBinding: string,
  sourceRef: string,
  seeded: SeededVersion,
  generation: number,
  entityId: string
): Promise<{ readonly jobKey: string; readonly resultId: string }> {
  const attempt = await startAttempt(sourceRef, generation);
  await stageAttempt(scopeBinding, sourceRef, attempt.guard, "extract", [
    entityFact(seeded, entityId, "extract", `Name ${entityId}`),
  ]);
  const published = await publish(scopeBinding, sourceRef, attempt.guard);
  expect(published).toMatchObject({ published: true });
  return { jobKey: attempt.guard.jobKey, resultId: entityId };
}
