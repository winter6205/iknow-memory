/**
 * The strict PostgreSQL lane of the same-snapshot M-STATUS contract.
 *
 * Every case runs against the real database: the real shared scope unit of
 * work, the real durable-work ledger, the real publication adapter, the real
 * structural screening tables and the real decision tables. The driver never
 * skips — an absent marker, an absent DSN and an unreachable database are each
 * named non-zero failures, and the one-snapshot cases are observed from a
 * separate connection so no partial commit can hide behind the reader.
 */
import { createHash } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  claimNextWork,
  scheduleWork,
  settleWork,
} from "../../src/core/maintenance/service.js";
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
import { PgScreeningDecisionStorage } from "../../src/core/storage/screening-decision-pg.js";
import { upSchemaScreening, upSchemaScreeningDecisions } from "../../src/core/storage/schema-screening.js";
import {
  composeMaintenanceSnapshot,
  PgMaintenanceStatusStorage,
  readPgMaintenanceComponents,
  readPgScopedScreeningStatus,
  readPgStatusRevisions,
  readPgStatusWork,
} from "../../src/core/storage/structured-status-reads.js";
import {
  buildMaintenanceStatus,
  type MaintenanceStatus,
} from "../../src/core/maintenance/maintenance-status.js";
import type {
  AuthorizedScopeContext,
  AuthorizedScopeUnitOfWork,
  ScopeTransactionClient,
  ScopeTransactionOwner,
} from "../../src/core/storage/structured-scope-types.js";
import { createPublicationTestClock } from "../storage/publication-contract.js";
import {
  describeMaintenanceStatusContract,
  type MaintenanceStatusScope,
  type MaintenanceStatusTestPort,
} from "../storage/maintenance-status-contract.js";
import {
  openStrictPgDriver,
  requireFullyRunnable,
  type NotRunCase,
} from "./strict-pg-driver.js";

const EXPECTED_COMMAND =
  "STRUCTURED_MAINTENANCE_STATUS_PG=1 GRAPHRAG_MEMORY_DB_URL=<isolated-development-dsn> npx vitest run tests/acceptance/structured-maintenance-status-pg.test.ts";
const SCHEMA_PREFIX = "structured_maintenance_status";
const DIMENSIONS = 8;
const ACTOR = "status-pg-trusted-owner";
const AUTHORIZATION_REVISION = "auth-status-pg-1";
const PURGE_REVISION = "purge-1";
const CONFIG_REVISION = "extractor-v1";
const DRAIN_LIMIT = 64;
const RELATION = "has_chair";
const HEAD = "00000000-0000-4000-8000-000000000601";
const TAILS = [
  "00000000-0000-4000-8000-000000000701",
  "00000000-0000-4000-8000-000000000702",
] as const;

const driver = await openStrictPgDriver({
  envName: "STRUCTURED_MAINTENANCE_STATUS_PG",
  testPath: "tests/acceptance/structured-maintenance-status-pg.test.ts",
  expectedCommand: EXPECTED_COMMAND,
  label: "structured-maintenance-status-pg",
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
let decisions: PgScreeningDecisionStorage;
let authority: AuthorizedScopeUnitOfWork & ScopeTransactionOwner;
let statusReader: PgMaintenanceStatusStorage;
let clock: ReturnType<typeof createPublicationTestClock>;
let serial = 0;

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

function opaqueDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

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

async function seedGraphEntities(entityIds: readonly string[]): Promise<void> {
  for (const entityId of entityIds) {
    await pool.query(
      `INSERT INTO entities (id, canonical_name, type, embedding, metadata, retired)
         VALUES ($1, $2, 'organization', NULL, '{}'::jsonb, false)
       ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type`,
      [entityId, `status fixture entity ${entityId}`]
    );
  }
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
  units: number = 1
): Promise<number> {
  const { record, locators } = await registerVersion(sourceRef, version, units);
  const declared = await publication.declareDesired({
    scopeBinding,
    authorizedSourceRefs,
    sourceRef,
    sourceVersion: record,
    locatorBindings: locators,
    desiredExtractionRevision: 1,
    configRevision: CONFIG_REVISION,
  });
  return declared.generation;
}

async function newScope(
  label: string,
  sourceRefs: readonly string[],
  units: number = 1
): Promise<{
  readonly scope: MaintenanceStatusScope;
  readonly generations: Map<string, number>;
}> {
  const scopeBinding = unique(`status-scope-${label}`);
  await backend.setScopeRevisions(scopeBinding, {
    authorizationRevision: AUTHORIZATION_REVISION,
    purgeRevision: PURGE_REVISION,
  });
  // The durable-work ledger is one shared queue whose claims cannot be
  // released, so a job a previous scenario deliberately left pending would be
  // claimed by this one. Clearing it between scenarios is what isolates them.
  await pool.query("DELETE FROM maintenance_jobs");
  const generations = new Map<string, number>();
  for (const sourceRef of sourceRefs) {
    generations.set(
      sourceRef,
      await declare(scopeBinding, sourceRef, "v1", sourceRefs, units)
    );
  }
  return {
    scope: {
      scopeBinding,
      authorizedSourceRefs: sourceRefs,
      context: contextFor(scopeBinding, sourceRefs),
    },
    generations,
  };
}

function contextFor(
  scopeBinding: string,
  authorizedSourceRefs: readonly string[]
): AuthorizedScopeContext {
  return authority.createAuthorizedContext({
    actorId: ACTOR,
    ownerScopeBinding: scopeBinding,
    readerBinding: `${scopeBinding}-reader`,
    authorizedSourceRefs,
    authorizationRevision: AUTHORIZATION_REVISION,
    deadlineAt: new Date(clock().getTime() + 10 * 60_000).toISOString(),
  });
}

function extractDependencies(
  sourceRef: string,
  generation: number
): readonly MaintenanceDependency[] {
  return [
    { sourceRef, generation, extractionRevision: null, relationBuckets: [] },
  ];
}

function checkDependencies(
  sourceRef: string,
  generation: number
): readonly MaintenanceDependency[] {
  return [
    {
      sourceRef,
      generation,
      extractionRevision: 1,
      relationBuckets: [RELATION],
    },
  ];
}

async function claimOwnAttempt(input: {
  readonly workKind: MaintenanceWorkKind;
  readonly sourceRef: string;
  readonly sourceVersion?: string;
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
      sourceVersion: input.sourceVersion ?? "v1",
      sourceGeneration: input.generation,
      configRevision: CONFIG_REVISION,
      dependencies: input.dependencies,
    }
  );
  if ("refused" in scheduled) {
    // EXIT: the fixture could not schedule the attempt a case needs. It throws
    // naming the refusal, so a case never runs on an unscheduled job and reads
    // its absence from the ledger as a pending bucket it did not arrange.
    throw new Error(`status pg fixture schedule refused: ${scheduled.refused}`);
  }
  for (let attempt = 0; attempt < DRAIN_LIMIT; attempt += 1) {
    const claimed = await claimNextWork(deps);
    if (claimed.guard === null) break;
    if (claimed.guard.jobKey === scheduled.record.jobKey) return claimed.guard;
    // EXIT: the claim queue offered a foreign job first, which this lane cannot
    // release back to pending. The fixture throws instead of settling a foreign
    // job into a state the case did not arrange.
    throw new Error(
      `status pg fixture claimed a foreign job first: ${claimed.guard.jobKey} instead of ${scheduled.record.jobKey}`
    );
  }
  // EXIT: the queue drained without ever offering the scheduled job. The fixture
  // throws, so no case proceeds on a job that was never claimed.
  throw new Error("status pg fixture could not claim its own job");
}

async function settle(
  guard: MaintenanceAttemptGuard,
  outcome: "ready" | "failed",
  dependencies: readonly MaintenanceDependency[]
): Promise<void> {
  const settled = await settleWork(
    { store: work, clock: () => clock() },
    guard,
    outcome === "ready"
      ? { status: "ready" }
      : { status: "failed", failureCode: "input_stale" },
    { configRevision: CONFIG_REVISION, dependencies }
  );
  if ("refused" in settled && settled.refused !== undefined) {
    // EXIT: settling a fixture attempt was refused. The fixture throws, so the
    // case cannot proceed believing the ledger holds an outcome it does not.
    throw new Error(`status pg fixture settle refused: ${settled.refused}`);
  }
}

async function publishVersion(input: {
  readonly scopeBinding: string;
  readonly sourceRef: string;
  readonly sourceVersion?: string;
  readonly generation: number;
  readonly accepted: readonly PublicationFact[];
  readonly extractionRef?: string;
  /**
   * The dependency vector to schedule with. A source that already holds a
   * published version is republished against that live extraction revision,
   * because the publication fence compares the scheduled vector against the
   * live one.
   */
  readonly dependencies?: readonly MaintenanceDependency[];
}): Promise<MaintenanceAttemptGuard> {
  const guard = await claimOwnAttempt({
    workKind: "extract_publish",
    sourceRef: input.sourceRef,
    sourceVersion: input.sourceVersion,
    generation: input.generation,
    dependencies:
      input.dependencies ??
      extractDependencies(input.sourceRef, input.generation),
  });
  await publication.stageAttempt({
    scopeBinding: input.scopeBinding,
    sourceRef: input.sourceRef,
    guard,
    extractionRef: input.extractionRef ?? `${input.sourceRef}-extraction`,
    accepted: input.accepted,
  });
  await publication.publish({
    scopeBinding: input.scopeBinding,
    sourceRef: input.sourceRef,
    guard,
    at: clock().toISOString(),
  });
  await settle(
    guard,
    "ready",
    input.dependencies ?? extractDependencies(input.sourceRef, input.generation)
  );
  return guard;
}

function relationFacts(
  sourceRef: string,
  extractionRef: string
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
      source_version: "v1",
      location: {
        document_id: `${sourceRef}-document`,
        version: "frozen-v1",
        unit: index + 1,
      },
      extraction_ref: extractionRef,
      extractedAt: clock().toISOString(),
    },
  })) as unknown as PublicationFact[];
}

async function stageStructuralScreen(input: {
  readonly context: AuthorizedScopeContext;
  readonly sourceRef: string;
  readonly generation: number;
}): Promise<MaintenanceAttemptGuard> {
  const guard = await claimOwnAttempt({
    workKind: "conflict_check",
    sourceRef: input.sourceRef,
    generation: input.generation,
    dependencies: checkDependencies(input.sourceRef, input.generation),
  });
  const outcome = await screening.stageScreen({
    context: input.context,
    guard,
    relationBuckets: [RELATION],
    relationCatalogVersion: 0,
    relationCatalogEntries: [],
  });
  if (outcome.candidates.length === 0) {
    // EXIT: the fixture's own screen published no conflict, so a case about
    // persisted screening evidence would run against nothing. The fixture throws
    // before the case body rather than asserting an empty result is a pass.
    throw new Error(
      `status pg fixture published no structural candidate for ${input.sourceRef}`
    );
  }
  return guard;
}

async function openLane(): Promise<MaintenanceStatusTestPort> {
  return {
    label: "strict-pg",
    async seedFullMatrix(label) {
      const notReady = {
        running: unique("status-desired-running"),
        failed: unique("status-desired-failed"),
        stale: unique("status-desired-stale"),
        pending: unique("status-desired-pending"),
      };
      const conflict = {
        running: unique("status-conflict-running"),
        ready: unique("status-conflict-ready"),
        failed: unique("status-conflict-failed"),
        stale: unique("status-conflict-stale"),
      };
      const superseded = unique("status-desired-superseded");
      const refs = [
        ...Object.values(notReady),
        superseded,
        ...Object.values(conflict),
      ];
      const { scope, generations } = await newScope(label, refs);
      const generationOf = (sourceRef: string): number =>
        generations.get(sourceRef)!;

      await claimOwnAttempt({
        workKind: "extract_publish",
        sourceRef: notReady.running,
        generation: generationOf(notReady.running),
        dependencies: extractDependencies(
          notReady.running,
          generationOf(notReady.running)
        ),
      });
      const failedGuard = await claimOwnAttempt({
        workKind: "extract_publish",
        sourceRef: notReady.failed,
        generation: generationOf(notReady.failed),
        dependencies: extractDependencies(
          notReady.failed,
          generationOf(notReady.failed)
        ),
      });
      await settle(
        failedGuard,
        "failed",
        extractDependencies(notReady.failed, generationOf(notReady.failed))
      );
      await publishVersion({
        scopeBinding: scope.scopeBinding,
        sourceRef: notReady.stale,
        generation: generationOf(notReady.stale),
        accepted: [],
      });
      generations.set(
        notReady.stale,
        await declare(scope.scopeBinding, notReady.stale, "v2", refs)
      );
      // A second source with an old settled-ready record and a CURRENT running
      // attempt: the older record must not answer for the current desired pair.
      await publishVersion({
        scopeBinding: scope.scopeBinding,
        sourceRef: superseded,
        generation: generationOf(superseded),
        accepted: [],
      });
      const supersededMoved = await declare(
        scope.scopeBinding,
        superseded,
        "v2",
        refs
      );
      generations.set(superseded, supersededMoved);
      await claimOwnAttempt({
        workKind: "extract_publish",
        sourceRef: superseded,
        sourceVersion: "v2",
        generation: supersededMoved,
        dependencies: [
          {
            sourceRef: superseded,
            generation: supersededMoved,
            extractionRevision: 1,
            relationBuckets: [],
          },
        ],
      });
      await publishVersion({
        scopeBinding: scope.scopeBinding,
        sourceRef: conflict.running,
        generation: generationOf(conflict.running),
        accepted: [],
      });
      await claimOwnAttempt({
        workKind: "conflict_check",
        sourceRef: conflict.running,
        generation: generationOf(conflict.running),
        dependencies: checkDependencies(
          conflict.running,
          generationOf(conflict.running)
        ),
      });
      await publishVersion({
        scopeBinding: scope.scopeBinding,
        sourceRef: conflict.ready,
        generation: generationOf(conflict.ready),
        accepted: [],
      });
      const readyCheck = await claimOwnAttempt({
        workKind: "conflict_check",
        sourceRef: conflict.ready,
        generation: generationOf(conflict.ready),
        dependencies: checkDependencies(
          conflict.ready,
          generationOf(conflict.ready)
        ),
      });
      await settle(
        readyCheck,
        "ready",
        checkDependencies(conflict.ready, generationOf(conflict.ready))
      );
      await publishVersion({
        scopeBinding: scope.scopeBinding,
        sourceRef: conflict.failed,
        generation: generationOf(conflict.failed),
        accepted: [],
      });
      const failedCheck = await claimOwnAttempt({
        workKind: "conflict_check",
        sourceRef: conflict.failed,
        generation: generationOf(conflict.failed),
        dependencies: checkDependencies(
          conflict.failed,
          generationOf(conflict.failed)
        ),
      });
      await settle(
        failedCheck,
        "failed",
        checkDependencies(conflict.failed, generationOf(conflict.failed))
      );
      await publishVersion({
        scopeBinding: scope.scopeBinding,
        sourceRef: conflict.stale,
        generation: generationOf(conflict.stale),
        accepted: [],
      });
      await claimOwnAttempt({
        workKind: "conflict_check",
        sourceRef: conflict.stale,
        generation: generationOf(conflict.stale),
        dependencies: checkDependencies(
          conflict.stale,
          generationOf(conflict.stale)
        ),
      });
      const moved = await declare(scope.scopeBinding, conflict.stale, "v2", refs);
      generations.set(conflict.stale, moved);
      await publishVersion({
        scopeBinding: scope.scopeBinding,
        sourceRef: conflict.stale,
        sourceVersion: "v2",
        generation: moved,
        accepted: [],
        extractionRef: `${conflict.stale}-extraction-v2`,
        // The republished source already holds a live extraction revision, so
        // its vector names that revision with no relation bucket: the
        // publication fence refuses any relation-bucket dependency.
        dependencies: [
          {
            sourceRef: conflict.stale,
            generation: moved,
            extractionRevision: 1,
            relationBuckets: [],
          },
        ],
      });

      // desired_index = pending: the one job left in the queue, scheduled last
      // so no other claim in this scenario can reach it.
      await scheduleWork(
        { store: work, clock: () => clock() },
        { actorId: ACTOR },
        {
          workKind: "extract_publish",
          sourceRef: notReady.pending,
          sourceVersion: "v1",
          sourceGeneration: generationOf(notReady.pending),
          configRevision: CONFIG_REVISION,
          dependencies: extractDependencies(
            notReady.pending,
            generationOf(notReady.pending)
          ),
        }
      );

      return {
        ...scope,
        authorizedSourceRefs: refs,
        context: contextFor(scope.scopeBinding, refs),
      };
    },

    async seedZeroHitAndUnpublished(label) {
      const zeroHit = unique("status-zero-hit");
      const unpublished = unique("status-unpublished");
      const refs = [zeroHit, unpublished];
      const { scope, generations } = await newScope(label, refs);
      await publishVersion({
        scopeBinding: scope.scopeBinding,
        sourceRef: zeroHit,
        generation: generations.get(zeroHit)!,
        accepted: [],
      });
      return scope;
    },

    async seedHiddenSource(label) {
      const visible = unique("status-visible");
      const hidden = unique("status-hidden");
      const { scope, generations } = await newScope(label, [visible]);
      await publishVersion({
        scopeBinding: scope.scopeBinding,
        sourceRef: visible,
        generation: generations.get(visible)!,
        accepted: [],
      });
      const hiddenGeneration = await declare(scope.scopeBinding, hidden, "v1", [
        visible,
        hidden,
      ]);
      await publishVersion({
        scopeBinding: scope.scopeBinding,
        sourceRef: hidden,
        generation: hiddenGeneration,
        accepted: [],
      });
      return { scope, hidden };
    },

    async seedPendingOverOldReady(label) {
      const sourceRef = unique("status-old-ready");
      const { scope, generations } = await newScope(label, [sourceRef]);
      const generation = generations.get(sourceRef)!;
      await publishVersion({
        scopeBinding: scope.scopeBinding,
        sourceRef,
        generation,
        accepted: [],
      });
      const checkGuard = await claimOwnAttempt({
        workKind: "conflict_check",
        sourceRef,
        generation,
        dependencies: checkDependencies(sourceRef, generation),
      });
      await settle(checkGuard, "ready", checkDependencies(sourceRef, generation));
      await declare(scope.scopeBinding, sourceRef, "v2", scope.authorizedSourceRefs);
      return scope;
    },

    async seedMissingRequiredState(label) {
      const sourceRef = unique("status-missing");
      const { scope, generations } = await newScope(label, [sourceRef]);
      await publishVersion({
        scopeBinding: scope.scopeBinding,
        sourceRef,
        generation: generations.get(sourceRef)!,
        accepted: [],
      });
      await pool.query(
        `UPDATE structured_publication_sources
            SET desired_source_version = NULL,
                desired_extraction_revision = NULL,
                desired_config_revision = NULL
          WHERE scope_binding = $1 AND source_ref = $2`,
        [scope.scopeBinding, sourceRef]
      );
      return scope;
    },

    async seedUnlandedPublication(label) {
      const sourceRef = unique("status-unlanded");
      const { scope, generations } = await newScope(label, [sourceRef]);
      const generation = generations.get(sourceRef)!;
      await publishVersion({
        scopeBinding: scope.scopeBinding,
        sourceRef,
        generation,
        accepted: [],
      });
      // The current desired pair is a second version whose extract attempt
      // settled ready without the publication switch ever running. The source
      // still holds the older usable publication, so readiness has to be judged
      // against the current desired pair rather than against anything
      // published at all.
      const moved = await declare(scope.scopeBinding, sourceRef, "v2", [
        sourceRef,
      ]);
      const dependencies = [
        {
          sourceRef,
          generation: moved,
          extractionRevision: 1,
          relationBuckets: [],
        },
      ];
      const guard = await claimOwnAttempt({
        workKind: "extract_publish",
        sourceRef,
        sourceVersion: "v2",
        generation: moved,
        dependencies,
      });
      await publication.stageAttempt({
        scopeBinding: scope.scopeBinding,
        sourceRef,
        guard,
        extractionRef: `${sourceRef}-extraction-v2`,
        accepted: [],
      });
      await settle(guard, "ready", dependencies);
      return scope;
    },

    async seedMovedAuthorization(label) {
      const sourceRef = unique("status-moved-auth");
      const { scope, generations } = await newScope(label, [sourceRef]);
      await publishVersion({
        scopeBinding: scope.scopeBinding,
        sourceRef,
        generation: generations.get(sourceRef)!,
        accepted: [],
      });
      await pool.query(
        `UPDATE evidence_scope_revisions
            SET authorization_revision = $2
          WHERE scope_binding = $1`,
        [scope.scopeBinding, `${AUTHORIZATION_REVISION}-moved`]
      );
      return scope;
    },

    async readStatus(scope) {
      return statusReader.readMaintenanceStatus(
        scope.context,
        scope.authorizedSourceRefs
      );
    },

    async advanceProgressOnly(scope) {
      await authority.withAuthorizedScope(
        scope.context,
        async (view) => {
          view.bumpRevisions({ read: false, maintenance: true });
        },
        { additionalSourceRefs: [] }
      );
    },

    async advanceVisibility(scope) {
      await authority.withAuthorizedScope(
        scope.context,
        async (view) => {
          view.bumpRevisions({ read: true, maintenance: false });
        },
        { additionalSourceRefs: [] }
      );
    },
  };
}

// EXIT: backend composition supplies neither the publication adapter nor the
// shared scope authority. The module load throws before any harness or schema
// exists, so no case can publish through a storage surface composition does not
// own.
admin = driver.harness.createClient(SCHEMA_URL);
await admin.connect();
await driver.harness.resetSchema(admin);
backend = new PgvectorBackend(SCHEMA_URL, DIMENSIONS, { annMaxDimensions: 2000 });
await backend.initialize();
pool = new pg.Pool({ connectionString: SCHEMA_URL, max: 6 });
clock = createPublicationTestClock(new Date());
await upSchemaScreening(pool);
await upSchemaScreeningDecisions(pool);
const composed = backend as PgvectorBackend & {
  structuredPublication?: StructuredPublicationStorage;
  structuredScopeUnitOfWork?: AuthorizedScopeUnitOfWork & ScopeTransactionOwner;
};
if (!composed.structuredPublication || !composed.structuredScopeUnitOfWork) {
  throw new Error(
    "PgvectorBackend composition must supply the structured publication storage and the shared scope unit of work this lane drives"
  );
}
publication = composed.structuredPublication;
authority = composed.structuredScopeUnitOfWork;
screening = new PgScreeningStorage(composed.structuredScopeUnitOfWork);
decisions = new PgScreeningDecisionStorage(composed.structuredScopeUnitOfWork);
work = new PgMaintenanceWorkStore(pool);
statusReader = new PgMaintenanceStatusStorage(authority);

const NOT_RUN: NotRunCase = {
  caseId: "maintenance-status-pg",
  expectedCommand: EXPECTED_COMMAND,
  owner: "T17",
  entries: [],
};

describeMaintenanceStatusContract(openLane);

describe("M-STATUS persisted screening evidence", () => {
  it("reports the ruleset revision and coverage of the persisted check record, not a constant", async () => {
    await seedGraphEntities([HEAD, ...TAILS]);
    const sourceRef = unique("status-evidence");
    const { scope, generations } = await newScope("evidence", [sourceRef], 2);
    const generation = generations.get(sourceRef)!;
    const extractionRef = `${sourceRef}-extraction`;
    await publishVersion({
      scopeBinding: scope.scopeBinding,
      sourceRef,
      generation,
      accepted: relationFacts(sourceRef, extractionRef),
    });
    await stageStructuralScreen({
      context: scope.context,
      sourceRef,
      generation,
    });
    const before = await statusReader.readMaintenanceStatus(
      scope.context,
      [sourceRef]
    );
    expect(before.rulesetRevision).toBe("structural-alternatives:1");
    expect(before.coverage).toBe("structural_candidates_only");

    // Rewrite only the persisted ruleset revision, leaving every other row
    // alone. A status that answered from a constant instead of the persisted
    // record would not move here.
    await pool.query(
      `UPDATE structured_screening_checks SET ruleset_revision = 'structural-alternatives:probe'
        WHERE scope_binding = $1 AND source_ref = $2`,
      [scope.scopeBinding, sourceRef]
    );
    const after = await statusReader.readMaintenanceStatus(scope.context, [
      sourceRef,
    ]);
    expect(after.rulesetRevision).toBe("structural-alternatives:probe");
    expect(after.coverage).toBe("structural_candidates_only");
  });

  it("refuses maintenance_status_unavailable when two persisted check records disagree on the ruleset revision", async () => {
    await seedGraphEntities([HEAD, ...TAILS]);
    const sourceRef = unique("status-divergent");
    const { scope, generations } = await newScope("divergent", [sourceRef], 2);
    const generation = generations.get(sourceRef)!;
    const extractionRef = `${sourceRef}-extraction`;
    await publishVersion({
      scopeBinding: scope.scopeBinding,
      sourceRef,
      generation,
      accepted: relationFacts(sourceRef, extractionRef),
    });
    await stageStructuralScreen({
      context: scope.context,
      sourceRef,
      generation,
    });
    await pool.query(
      `INSERT INTO structured_screening_checks
         (check_id, scope_binding, job_key, source_ref, ruleset_revision, coverage,
          relation_catalog_version, relation_buckets, input_revision,
          assertion_count, candidate_count, published_at)
       SELECT gen_random_uuid(), scope_binding, job_key, source_ref,
              'structural-alternatives:other', coverage,
              relation_catalog_version, relation_buckets, input_revision,
              assertion_count, candidate_count, published_at
         FROM structured_screening_checks
        WHERE scope_binding = $1 AND source_ref = $2`,
      [scope.scopeBinding, sourceRef]
    );
    await expect(
      statusReader.readMaintenanceStatus(scope.context, [sourceRef])
    ).rejects.toMatchObject({ code: "maintenance_status_unavailable" });
  });
});

describe("M-STATUS and a decided retirement", () => {
  it("reads a retired support out of the screening conflict visibility table and reads the check as stale", async () => {
    await seedGraphEntities([HEAD, ...TAILS]);
    const sourceRef = unique("status-retired");
    const { scope, generations } = await newScope("retired", [sourceRef], 2);
    const generation = generations.get(sourceRef)!;
    const extractionRef = `${sourceRef}-extraction`;
    await publishVersion({
      scopeBinding: scope.scopeBinding,
      sourceRef,
      generation,
      accepted: relationFacts(sourceRef, extractionRef),
    });
    const checkGuard = await stageStructuralScreen({
      context: scope.context,
      sourceRef,
      generation,
    });
    await settle(checkGuard, "ready", checkDependencies(sourceRef, generation));
    const beforeRetirement = await statusReader.readMaintenanceStatus(
      scope.context,
      [sourceRef]
    );
    expect(beforeRetirement.conflictChecks).toEqual({
      pending: 0,
      running: 0,
      ready: 1,
      failed: 0,
      stale: 0,
    });

    const candidates = await withObserver(async (observer) => {
      const { rows } = await observer.query(
        `SELECT c.candidate_id, c.check_id::text AS check_id, c.support_ids,
                c.assertion_ids, c.input_revision, c.relation_catalog_version
           FROM structured_screening_candidates c
           JOIN structured_screening_checks k
             ON k.check_id = c.check_id AND k.scope_binding = c.scope_binding
          WHERE c.scope_binding = $1 AND k.source_ref = $2
          ORDER BY c.candidate_id`,
        [scope.scopeBinding, sourceRef]
      );
      return rows;
    });
    const candidate = candidates[0] as
      | {
          candidate_id?: string;
          check_id?: string;
          support_ids?: string[];
          assertion_ids?: string[];
          input_revision?: string;
          relation_catalog_version?: number;
        }
      | undefined;
    if (candidate === undefined) {
      // EXIT: the fixture screened a conflict a separate connection cannot read
      // back. The setup refuses rather than deciding against nothing.
      throw new Error(`status pg fixture cannot read back a candidate for ${sourceRef}`);
    }
    const revisions = await withObserver(async (observer) => {
      const { rows } = await observer.query(
        `SELECT read_revision FROM structured_publication_scopes WHERE scope_binding = $1`,
        [scope.scopeBinding]
      );
      return Number((rows[0] as { read_revision: string }).read_revision);
    });
    const supportIds = candidate.support_ids ?? [];
    await decisions.applyDecision({
      request: {
        decisionId: unique("status-decision"),
        context: scope.context,
        candidateId: candidate.candidate_id!,
        outcome: "retire_support",
        reason: "the support is superseded by an explicit decision",
        retireSupportIds: [supportIds[0]!],
        retainSupportIds: [],
        assertionIds: candidate.assertion_ids ?? [],
        expectedInputRevision: candidate.input_revision!,
        expectedRelationCatalogVersion: candidate.relation_catalog_version ?? 0,
      },
      facts: {
        scopeBinding: scope.scopeBinding,
        candidateId: candidate.candidate_id!,
        checkId: candidate.check_id!,
        supportIds,
        assertionIds: candidate.assertion_ids ?? [],
        inputRevision: candidate.input_revision!,
        relationCatalogVersion: candidate.relation_catalog_version ?? 0,
        readRevision: revisions,
        maintenanceRevision: 0,
      },
    });

    const afterRetirement = await statusReader.readMaintenanceStatus(
      scope.context,
      [sourceRef]
    );
    // The check is real and settled ready, but the decision made part of its
    // evidence non-current, so the check no longer targets the current affected
    // dependencies and the bucket reads stale.
    expect(afterRetirement.conflictChecks).toEqual({
      pending: 0,
      running: 0,
      ready: 0,
      failed: 0,
      stale: 1,
    });
    // The publication lane's membership is private, so the retired support is
    // still served; M-STATUS reports the bucket, not a row count.
    const stillServed = await withObserver(async (observer) => {
      const { rows } = await observer.query(
        `SELECT count(*)::bigint AS total
           FROM structured_publication_membership
          WHERE scope_binding = $1 AND source_ref = $2`,
        [scope.scopeBinding, sourceRef]
      );
      return Number((rows[0] as { total: string }).total);
    });
    expect(stillServed).toBeGreaterThan(0);
  });
});

describe("M-STATUS one-snapshot property", () => {
  it("never mixes a pre-revision count with a post-revision membership when a publication commits mid-read", async () => {
    const sourceRef = unique("status-interleave");
    const { scope, generations } = await newScope("interleave", [sourceRef]);
    const generation = generations.get(sourceRef)!;
    const before = await statusReader.readMaintenanceStatus(scope.context, [
      sourceRef,
    ]);
    expect(before.publishedSources).toBe(0);

    // The reader's own transaction, opened the same way the status reader opens
    // it, and stopped between its first and second component.
    const reader = new pg.Client({ connectionString: SCHEMA_URL });
    await reader.connect();
    try {
      await reader.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
      );
      const readerClient = asTransactionClient(reader);
      const firstComponent = await readComponentSources(readerClient, scope, [
        sourceRef,
      ]);
      expect(firstComponent.map((row) => row.published)).toEqual([null]);

      // A separate writer publishes and commits while the reader is parked
      // between components.
      await publishVersion({
        scopeBinding: scope.scopeBinding,
        sourceRef,
        generation,
        accepted: [],
      });
      const committed = await withObserver(async (observer) => {
        const { rows } = await observer.query(
          `SELECT published_source_version FROM structured_publication_sources
            WHERE scope_binding = $1 AND source_ref = $2`,
          [scope.scopeBinding, sourceRef]
        );
        return (rows[0] as { published_source_version: string | null })
          .published_source_version;
      });
      expect(committed).not.toBeNull();

      const secondComponent = await readComponentWork(readerClient, [sourceRef]);
      const observed = await buildFromComponents({
        client: readerClient,
        scope,
        sourceRefs: [sourceRef],
        sources: firstComponent,
        work: secondComponent,
      });
      expect(observed.publishedSources).toBe(0);
      expect(observed.desiredIndex.pending).toBe(1);
      expect(observed.desiredIndex.stale).toBe(0);
      await reader.query("COMMIT");
    } finally {
      await reader.end();
    }

    // A fresh read sees the committed publication, so the interleaved read was
    // genuinely behind and not merely reading an empty scope.
    const after = await statusReader.readMaintenanceStatus(scope.context, [
      sourceRef,
    ]);
    expect(after.publishedSources).toBe(1);
    expect(after.desiredIndex.ready).toBe(1);
  });

  it("backs the whole status with one transaction, observed from a separate connection", async () => {
    const sourceRef = unique("status-single-txn");
    const { scope } = await newScope("single-txn", [sourceRef]);
    const reader = new pg.Client({ connectionString: SCHEMA_URL });
    await reader.connect();
    const observer = new pg.Client({ connectionString: SCHEMA_URL });
    await observer.connect();
    try {
      await reader.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
      );
      await reader.query(
        `SELECT count(*) FROM structured_publication_sources WHERE scope_binding = $1`,
        [scope.scopeBinding]
      );
      const backendPid = await reader.query("SELECT pg_backend_pid()::int AS pid");
      const pid = (backendPid.rows[0] as { pid: number }).pid;
      const observed = await observer.query(
        `SELECT state, xact_start IS NOT NULL AS in_transaction, backend_xmin
           FROM pg_stat_activity WHERE pid = $1`,
        [pid]
      );
      const row = observed.rows[0] as
        | { state?: string; in_transaction?: boolean; backend_xmin?: unknown }
        | undefined;
      if (row === undefined) {
        // EXIT: a separate connection cannot see the reader's backend at all,
        // so no transaction-property observation is possible. The case throws
        // rather than asserting green without an observation.
        throw new Error(
          "separate connection cannot observe the reader's backend transaction"
        );
      }
      expect(row.state).toBe("idle in transaction");
      expect(row.in_transaction).toBe(true);
      // A REPEATABLE READ snapshot pins an xmin, which is what makes every
      // later component of the status read the same committed state.
      expect(row.backend_xmin).not.toBeNull();
      await reader.query("COMMIT");
    } finally {
      await reader.end();
      await observer.end();
    }
  });

  it("mixes the two revisions under READ COMMITTED, so the isolation level is load-bearing", async () => {
    const sourceRef = unique("status-read-committed");
    const { scope, generations } = await newScope("read-committed", [
      sourceRef,
    ]);
    const generation = generations.get(sourceRef)!;
    const reader = new pg.Client({ connectionString: SCHEMA_URL });
    await reader.connect();
    try {
      await reader.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
      const readerClient = asTransactionClient(reader);
      const firstComponent = await readComponentSources(readerClient, scope, [
        sourceRef,
      ]);
      expect(firstComponent.map((row) => row.published)).toEqual([null]);
      await publishVersion({
        scopeBinding: scope.scopeBinding,
        sourceRef,
        generation,
        accepted: [],
      });
      const secondComponent = await readComponentWork(readerClient, [sourceRef]);
      const mixed = await buildFromComponents({
        client: readerClient,
        scope,
        sourceRefs: [sourceRef],
        sources: firstComponent,
        work: secondComponent,
      });
      // Under READ COMMITTED the ledger component advances while the source
      // component does not: the new settled-ready extract job is visible beside
      // a source row that still says nothing has been published. The bucket
      // therefore flips from pending to stale, which is exactly the mixed state
      // the repeatable-read reader above never produces.
      expect(mixed.publishedSources).toBe(0);
      expect(mixed.desiredIndex.pending).toBe(0);
      expect(mixed.desiredIndex.stale).toBe(1);
      await reader.query("COMMIT");
    } finally {
      await reader.end();
    }
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

/**
 * The reader's own components, read through the same production readers the
 * status builder uses, so the interleaving case exercises the real reads rather
 * than a hand-written copy of their SQL.
 */
/** A leased backend hands its own release; this client is closed by its test. */
function asTransactionClient(client: pg.Client): ScopeTransactionClient {
  return { query: client.query.bind(client), release: () => undefined };
}

async function readComponentSources(
  client: ScopeTransactionClient,
  scope: MaintenanceStatusScope,
  sourceRefs: readonly string[]
): Promise<readonly { published: unknown }[]> {
  return readPgMaintenanceComponents(client, scope.scopeBinding, sourceRefs);
}

async function readComponentWork(
  client: ScopeTransactionClient,
  sourceRefs: readonly string[]
): Promise<unknown> {
  return readPgStatusWork(client, sourceRefs);
}

async function buildFromComponents(input: {
  readonly client: ScopeTransactionClient;
  readonly scope: MaintenanceStatusScope;
  readonly sourceRefs: readonly string[];
  readonly sources: unknown;
  readonly work: unknown;
}): Promise<MaintenanceStatus> {
  const revisions = await readPgStatusRevisions(
    input.client,
    input.scope.scopeBinding
  );
  const screening = await readPgScopedScreeningStatus(
    input.client,
    input.scope.scopeBinding,
    input.sourceRefs
  );
  return buildMaintenanceStatus({
    snapshot: composeMaintenanceSnapshot(
      {
        revisions,
        sources: input.sources as never,
        work: input.work as never,
        screening,
      },
      input.sourceRefs
    ),
    screening: screening.filter((record) =>
      input.sourceRefs.includes(record.sourceRef)
    ),
  });
}
