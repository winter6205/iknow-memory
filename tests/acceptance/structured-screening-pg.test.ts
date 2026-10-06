import { createHash } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  claimNextWork,
  scheduleWork,
} from "../../src/core/maintenance/service.js";
import type {
  MaintenanceAttemptGuard,
  MaintenanceJobRecord,
  MaintenanceWorkStore,
} from "../../src/core/maintenance/types.js";
import type {
  PublicationFact,
  StructuredPublicationStorage,
} from "../../src/core/maintenance/publication-types.js";
import { PgMaintenanceWorkStore } from "../../src/core/storage/maintenance-work-pg.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import type { ChunkRecord } from "../../src/core/types.js";
import {
  createPublicationTestClock,
  type PublicationTestClock,
  type SeededVersion,
} from "../storage/publication-contract.js";
import {
  openStrictPgDriver,
  requireFullyRunnable,
  warnNotRun,
  type NotRunCase,
} from "./strict-pg-driver.js";

const EXPECTED_COMMAND =
  "STRUCTURED_SCREENING_ACCEPTANCE=1 GRAPHRAG_MEMORY_DB_URL=<isolated-development-dsn> npx vitest run tests/acceptance/structured-screening-pg.test.ts";
const SCHEMA_PREFIX = "structured_screening_acceptance";
const DIMENSIONS = 8;
const ACTOR = "screening-parity-trusted-owner";
const RULESET_REVISION = "structural-alternatives:1";
const COVERAGE = "structural_candidates_only";
const SC01_RELATION_BUCKET = "has_chair";
const ENTITY_ID = "00000000-0000-4000-8000-000000000011";
const SC01_EXPRESSIBILITY_SOURCE =
  "src/core/maintenance/service.ts:172-174 validates a relation bucket as a real array at scheduling, so the screening input is expressible on the public dependency contract today; no backend value is read here and the expected result is the spec's empty-catalog rule, never an observed candidate";
const SC01_STAGE_EXPECTATION_SOURCE =
  "specs/structured-corpus-maintenance.md:216-219 via the frozen T05 record case-map row SC-01: the initial relation catalog is empty, so has_chair is unclassified and yields a potential alternative, which the guarded write must stage; a maintenance_status_unavailable refusal is the missing screening behaviour this frozen case exists to expose as RED";

const driver = await openStrictPgDriver({
  envName: "STRUCTURED_SCREENING_ACCEPTANCE",
  testPath: "tests/acceptance/structured-screening-pg.test.ts",
  expectedCommand: EXPECTED_COMMAND,
  label: "structured-screening-acceptance-pg",
  schemaPrefix: SCHEMA_PREFIX,
  dependency: "real PostgreSQL with pgvector",
});

const SCHEMA_URL = driver.schemaConnectionString;

const CLEANUP_CONTRACT =
  "one unique schema per run created by this lane's own resetSchema and dropped CASCADE by this run's afterAll behind the schemaPrefix assertion; no object outside that schema is created or removed";

interface FrozenCase {
  readonly id: string;
  readonly owner: string;
  readonly scenario: string;
  readonly scenarioSource: string;
  readonly boundary: string;
  readonly expectedSource: string;
  readonly cleanup: string;
  readonly notRun: NotRunCase;
}

function frozenCase(entry: {
  readonly id: string;
  readonly owner: string;
  readonly scenario: string;
  readonly scenarioSource: string;
  readonly boundary: string;
  readonly expectedSource: string;
  readonly cleanup: string;
  readonly notRun: readonly { claim: string; owner: string; reason: string }[];
}): FrozenCase {
  return {
    ...entry,
    notRun: {
      caseId: entry.id,
      expectedCommand: EXPECTED_COMMAND,
      owner: entry.owner,
      entries: entry.notRun,
    },
  };
}

const CASES: readonly FrozenCase[] = [
  frozenCase({
    id: "SC-01",
    owner: "T15",
    scenario:
      "an unclassified relation under the empty initial catalog is a potential alternative, not a refusal",
    scenarioSource: "pinned plan S2; specs/structured-corpus-maintenance.md:216-219",
    boundary:
      "real PostgreSQL: the guarded publication write of the S0 shared authorized scope, reached with a relation bucket in the scheduled dependency vector",
    expectedSource:
      "specs/structured-corpus-maintenance.md:216-219 via the frozen T05 record case-map row SC-01: the initial relation catalog is empty, so an unclassified relation yields a potential alternative and the guarded write must stage",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "memory lane",
        owner: "T15",
        reason:
          "the frozen memory suite tests/storage/screening-memory.test.ts and the shared contract tests/storage/screening-contract.ts do not exist and S2 (T15) owns creating them, so the memory half of this case's both-lane boundary has no driver to run",
      },
      {
        claim: "catalog rule proper",
        owner: "T15",
        reason:
          `no relation catalog, no screen type, no persisted check-input record and no ${RULESET_REVISION} or ${COVERAGE} literal exist in src/ or tests/; src/core/maintenance/publication-types.ts:70 records the gap, so only the relation-bucket guard proxy is reachable and the case's own rule is unexercised`,
      },
    ],
  }),
  frozenCase({
    id: "SC-02",
    owner: "T15",
    scenario: "null validity bounds retain explicit unknown/unbounded uncertainty",
    scenarioSource: "pinned plan S2; specs/structured-corpus-maintenance.md:212-213",
    boundary: "memory and PostgreSQL; no screen type exists to drive either lane",
    expectedSource:
      "specs/structured-corpus-maintenance.md:212-213 via the frozen T05 record case-map row SC-02: both null bounds mean unknown/unbounded and are retained as uncertainty, never a contradiction",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both lanes",
        owner: "T15",
        reason:
          "no screen type exists, so there is no accepted-assertion input a screen could read and no uncertainty field a case could assert; all 45 QP1 facts are null-bounded and carry no interval, so QP1 is admissible as fixture only and never as the sole expected result",
      },
    ],
  }),
  frozenCase({
    id: "SC-03",
    owner: "T15",
    scenario: "same head/relation with two distinct tails",
    scenarioSource: "pinned plan S2; specs/structured-corpus-maintenance.md:210-211",
    boundary: "memory and PostgreSQL; no screen type exists to drive either lane",
    expectedSource:
      "specs/structured-corpus-maintenance.md:210-211 via the frozen T05 record case-map row SC-03: grouping is by exact canonical head and normalized relation, so two tails of one head and relation are two assertions in one group",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both lanes",
        owner: "T15",
        reason:
          "no screen type exists to group assertions; QP1's 9 multi-tail groups are an input fixture only and the expected outcome derives from the spec grouping rule rather than from any QP1 value",
      },
    ],
  }),
  frozenCase({
    id: "SC-04",
    owner: "T15",
    scenario: "same assertion with multiple supports is not a conflict",
    scenarioSource: "pinned plan S2; specs/structured-corpus-maintenance.md:214-215",
    boundary: "memory and PostgreSQL; no screen type exists to drive either lane",
    expectedSource:
      "specs/structured-corpus-maintenance.md:214-215 via the frozen T05 record case-map row SC-04: an exact same head/relation/tail/interval match is one assertion with multiple supports, not a conflict",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both lanes",
        owner: "T15",
        reason:
          "no screen type exists to classify a multi-support assertion; QP1's 8 multi-support facts are an input fixture only and the expected outcome derives from the spec rule",
      },
    ],
  }),
  frozenCase({
    id: "SC-05",
    owner: "T15",
    scenario: "exact same head/relation/tail/interval is one assertion",
    scenarioSource: "pinned plan S2; specs/structured-corpus-maintenance.md:214-215",
    boundary: "memory and PostgreSQL; no screen type exists to drive either lane",
    expectedSource:
      "specs/structured-corpus-maintenance.md:214-215 via the frozen T05 record case-map row SC-05: an exact duplicate is one assertion with multiple supports, never two assertions",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both lanes",
        owner: "T15",
        reason:
          "no screen type exists; QP1 contains 0 duplicate head+relation+tail triples, so this negative example must be a synthetic fixture and there is no screen to classify it",
      },
    ],
  }),
  frozenCase({
    id: "SC-06",
    owner: "T15",
    scenario: "overlap versus adjacency of half-open intervals",
    scenarioSource: "pinned plan S2; specs/structured-corpus-maintenance.md:210-215",
    boundary: "memory and PostgreSQL; no screen type exists to drive either lane",
    expectedSource:
      "specs/structured-corpus-maintenance.md:210-215 via the frozen T05 record case-map row SC-06: overlapping half-open intervals form a potential alternative while disjoint or merely touching intervals do not",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both lanes",
        owner: "T15",
        reason:
          "no screen type exists; all 45 QP1 facts carry valid_window null, so the interval fixture must be authored independently and no QP1 value can be this case's expected result",
      },
    ],
  }),
  frozenCase({
    id: "SC-07",
    owner: "T15",
    scenario:
      "versioned multi-valued exclusion without modifying the empty initial catalog",
    scenarioSource: "pinned plan S2; specs/structured-corpus-maintenance.md:216-219",
    boundary: "memory and PostgreSQL; no catalog and no persisted screening schema exist",
    expectedSource:
      "specs/structured-corpus-maintenance.md:216-219 via the frozen T05 record case-map row SC-07: the initial catalog is empty and no domain cardinality is invented, so a relation the catalog never labelled multi-valued is a potential alternative",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both lanes",
        owner: "T15",
        reason:
          "no versioned relation catalog and no persisted screening schema exist; the catalog's versioning and persistence shape is unspecified beyond versioned and initially empty, so the case cannot be authored precisely before S2 fixes it",
      },
    ],
  }),
  frozenCase({
    id: "SC-08",
    owner: "T15",
    scenario: "exact immutable candidate identity",
    scenarioSource: "pinned plan S2; specs/structured-corpus-maintenance.md:221-222",
    boundary: "memory and PostgreSQL; no screen type exists to mint a candidate identity",
    expectedSource:
      "specs/structured-corpus-maintenance.md:221-222 via the frozen T05 record case-map row SC-08: identity binds sorted assertion IDs, relevant support and extraction input revisions, ruleset revision and uncertainty reason",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both lanes",
        owner: "T15",
        reason:
          "no screen type exists to mint a candidate and no code in src/ schedules the real conflict_check work kind, so the case has no entry point to drive; QP1 carries no support or extraction revision, so no QP1 value could be the expected identity",
      },
    ],
  }),
  frozenCase({
    id: "SC-09",
    owner: "T15",
    scenario: "dependency update and A-to-B-to-A invalidate readiness",
    scenarioSource: "pinned plan S2 and shared",
    boundary: "memory and PostgreSQL; no screen readiness state exists",
    expectedSource:
      "specs/structured-corpus-maintenance.md:196-204 via the frozen T05 record case-map row SC-09: a dependency change invalidates the readiness the old screen established",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both lanes",
        owner: "T15",
        reason:
          "no screen attempt publishes readiness and no code schedules conflict_check, so there is no readiness state for a dependency update or an A-to-B-to-A round trip to invalidate",
      },
    ],
  }),
  frozenCase({
    id: "SC-10",
    owner: "T15",
    scenario: "expiry during awaited writes refuses typed",
    scenarioSource: "pinned plan S2 and shared",
    boundary: "memory and PostgreSQL; no screen attempt path exists",
    expectedSource:
      "pinned plan S0/S2 fence rule via the frozen T05 record case-map row SC-10: a screen publishes only after checking the live token, lease and absolute deadline, including after awaited work, and a resource limit refuses the whole check",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both lanes",
        owner: "T15",
        reason:
          "no screen attempt path exists and no code schedules conflict_check, so no screen can be awaiting writes when its deadline expires",
      },
    ],
  }),
  frozenCase({
    id: "SC-11",
    owner: "T16",
    scenario: "current versus stale decisions and the three normative outcomes",
    scenarioSource: "pinned plan S3; specs/structured-corpus-maintenance.md:227-233",
    boundary: "memory and PostgreSQL; no decision type exists",
    expectedSource:
      "specs/structured-corpus-maintenance.md:227-233 via the frozen T05 record case-map row SC-11: the backend-owned decision accepts only currently matching inputs in a transaction and its outcome is one of keep_both, retire_support or supersede_assertion",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both lanes",
        owner: "T16",
        reason:
          "no decision type and no decision record exists — keep_both, retire_support and supersede_assertion each return 0 matching files under src/ and tests/ — so there is no current-versus-stale decision input to accept or refuse",
      },
    ],
  }),
  frozenCase({
    id: "SC-12",
    owner: "T16",
    scenario:
      "shared-origin preservation; never infer a replacement or retire an undisclosed origin",
    scenarioSource: "pinned plan S3",
    boundary: "memory and PostgreSQL; no decision type exists",
    expectedSource:
      "specs/structured-corpus-maintenance.md:230-233 via the frozen T05 record case-map row SC-12: a decision requires explicit affected visibility and preserves original source, support and extraction",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both lanes",
        owner: "T16",
        reason:
          "no decision type exists to record an affected visibility, so neither shared-origin preservation nor the never-infer rule has an entry point",
      },
    ],
  }),
  frozenCase({
    id: "SC-13",
    owner: "T16",
    scenario: "rollback of all authoritative stores and outbox on refusal",
    scenarioSource: "pinned plan S3 and shared",
    boundary: "memory and PostgreSQL; no decision transaction exists",
    expectedSource:
      "pinned plan S3 refusal rule via the frozen T05 record case-map row SC-13: unknown, denied, stale or ambiguous inputs refuse without mutation, so no authoritative write, outbox effect or revision bump survives a refused decision",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both lanes",
        owner: "T16",
        reason:
          "no decision transaction exists to roll back; this case folds into SC-11 and cannot be driven until T16 introduces the decision type",
      },
    ],
  }),
  frozenCase({
    id: "SC-14",
    owner: "T17",
    scenario: "no-hit and hidden-source status",
    scenarioSource: "pinned plan S4; specs/structured-corpus-maintenance.md:251-259",
    boundary: "memory and PostgreSQL; no status shape exists",
    expectedSource:
      "specs/structured-corpus-maintenance.md:251-259 via the frozen T05 record case-map row SC-14: every active scoped source occupies exactly one bucket in each family, bucket totals equal sources_in_scope, and missing required state records maintenance_status_unavailable",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both lanes",
        owner: "T17",
        reason:
          "the frozen status shape does not exist: PublicationMaintenanceSummary carries desiredIndexBuckets and conflictCheckBuckets as integers and a constant conflictStatus, with no ruleset_revision, no coverage and no per-bucket breakdown, so a hidden-source count has nowhere to be reported",
      },
    ],
  }),
  frozenCase({
    id: "SC-15",
    owner: "T17",
    scenario: "progress-only revision change versus changed visibility",
    scenarioSource: "pinned plan S4; specs/structured-corpus-maintenance.md:268-274",
    boundary: "memory and PostgreSQL; no status shape exists",
    expectedSource:
      "specs/structured-corpus-maintenance.md:268-274 via the frozen T05 record case-map row SC-15: read_revision moves for query-visible change while maintenance_revision moves for job progress and status only",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "both lanes",
        owner: "T17",
        reason:
          "the frozen status shape does not exist, and maintenance_revision and read_revision appear today only as opaque strings on a publication snapshot rather than as the S4 status, so the two revision kinds cannot be told apart on the status object",
      },
    ],
  }),
];

const CASE_IDS = CASES.map((entry) => entry.id);

let admin: pg.Client;
let backend: PgvectorBackend;
let pool: pg.Pool;
let publication: StructuredPublicationStorage;
let work: MaintenanceWorkStore;
let clock: PublicationTestClock;
let serial = 0;
const createdJobs: string[] = [];

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

function opaqueDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function requireScheduled(outcome: {
  readonly record?: MaintenanceJobRecord;
  readonly refused?: string;
}): MaintenanceJobRecord {
  if ("refused" in outcome && outcome.refused !== undefined) {
    // EXIT: the setup could not schedule the screening attempt's work request.
    // The setup throws naming the refusal, so a case can never proceed on a work
    // request the scheduler refused.
    throw new Error(`test setup schedule refused: ${outcome.refused}`);
  }
  const record = (outcome as { readonly record?: MaintenanceJobRecord }).record;
  if (record === undefined) {
    // EXIT: the scheduler returned neither a record nor a refusal. The setup
    // throws, so no case treats an unrecognised scheduling outcome as staged.
    throw new Error("test setup schedule returned no record");
  }
  return record;
}

function requireGuard(
  guard: MaintenanceAttemptGuard | null
): MaintenanceAttemptGuard {
  if (guard === null) {
    // EXIT: no claimable attempt was returned. The setup throws, so a case can
    // never reach its guarded write without a live attempt.
    throw new Error("test setup could not claim work");
  }
  return guard;
}

type StageOutcome =
  | { readonly staged: true }
  | { readonly refusal: { readonly code: string; readonly message: string } };

async function stageOutcome(action: Promise<unknown>): Promise<StageOutcome> {
  try {
    await action;
    return { staged: true };
  } catch (error) {
    const coded = error as {
      readonly code?: unknown;
      readonly failureCode?: unknown;
      readonly message?: unknown;
    };
    const code = coded.code ?? coded.failureCode;
    return {
      refusal: {
        code: typeof code === "string" ? code : "untyped_error",
        message:
          typeof coded.message === "string" ? coded.message : String(error),
      },
    };
  }
}

async function registerVersion(
  sourceRef: string,
  sourceVersion: string
): Promise<SeededVersion> {
  const { record } = await backend.registerSourceVersion({
    source_ref: sourceRef,
    source_version: sourceVersion,
    content_digest: opaqueDigest(`${sourceRef}:${sourceVersion}:original`),
    origin_object_ref: `objects/${sourceRef}/${sourceVersion}.html`,
    parser_revision: "frozen-html-units-v1",
    unit_manifest: { units: 5, parser_revision: "frozen-html-units-v1" },
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

async function seedGraphEntity(entityId: string): Promise<void> {
  const chunk: ChunkRecord = {
    id: entityId,
    content: `screening parity acceptance entity ${entityId}`,
    embedding: new Array<number>(DIMENSIONS).fill(0),
    source_ref: "structured-screening-acceptance-fixture",
    metadata: {},
    valid_from: clock().toISOString(),
    valid_until: null,
    created_at: clock().toISOString(),
  };
  await backend.upsert([chunk]);
}

function entityFact(seeded: SeededVersion, entityId: string): PublicationFact {
  return {
    identity: { kind: "entity", input: { entityId, type: "organization" } },
    occurrence: {
      subject: "entity",
      result_id: entityId,
      source_ref: seeded.record.source_ref,
      source_version: seeded.record.source_version,
      location: { ...seeded.locator, unit: 1 },
      extraction_ref: "screening-sc01-extraction",
      extractedAt: seeded.record.created_at,
    },
    display: { canonicalName: `Name ${entityId}`, type: "organization" },
  };
}

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
      await client.query(
        `UPDATE maintenance_jobs
            SET status = 'stale', last_failure_code = 'input_stale',
                next_attempt_at = NULL, fencing_token = NULL,
                lease_expires_at = NULL, attempt_started_at = NULL,
                updated_at = clock_timestamp()
          WHERE job_key = ANY($1::text[]) AND status IN ('running', 'pending')`,
        [jobKeys]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    // EXIT: fixture teardown could not close the attempts this run opened. The
    // error propagates, so a teardown that reports success over a still-claimed
    // attempt is not mistaken for a clean release.
    throw error;
  } finally {
    client.release();
  }
}

const RUNNABLE_CLAIMS: Readonly<Record<string, () => Promise<void>>> = {
  "SC-01": async () => {
    const sourceRef = unique("screening-sc01-source");
    const scopeBinding = unique("screening-sc01-scope");
    const seeded = await registerVersion(sourceRef, "v1");
    await backend.setScopeRevisions(scopeBinding, {
      authorizationRevision: "auth-1",
      purgeRevision: "purge-1",
    });
    const declared = await publication.declareDesired({
      scopeBinding,
      authorizedSourceRefs: [sourceRef],
      sourceRef: seeded.record.source_ref,
      sourceVersion: seeded.record,
      locatorBindings: seeded.locatorBindings,
      desiredExtractionRevision: 1,
      configRevision: "extractor-v1",
    });
    const deps = { store: work, clock: () => clock() };
    const scheduled = await scheduleWork(
      deps,
      { actorId: ACTOR },
      {
        workKind: "extract_publish",
        sourceRef,
        sourceVersion: "v1",
        sourceGeneration: declared.generation,
        configRevision: "extractor-v1",
        dependencies: [
          {
            sourceRef,
            generation: declared.generation,
            extractionRevision: null,
            relationBuckets: [SC01_RELATION_BUCKET],
          },
        ],
      }
    );
    const job = requireScheduled(scheduled);
    createdJobs.push(job.jobKey);

    expect("refused" in scheduled, SC01_EXPRESSIBILITY_SOURCE).toBe(false);

    const claimed = await claimNextWork(deps);
    const guard = requireGuard(claimed.guard);
    await seedGraphEntity(ENTITY_ID);

    const outcome = await stageOutcome(
      publication.stageAttempt({
        scopeBinding,
        sourceRef,
        guard,
        extractionRef: "screening-sc01-extraction",
        accepted: [entityFact(seeded, ENTITY_ID)],
      })
    );

    expect(outcome, SC01_STAGE_EXPECTATION_SOURCE).toEqual({ staged: true });
  },
};

describe("structural screening S1 parity contract — PostgreSQL acceptance", () => {
  beforeAll(async () => {
    admin = driver.harness.createClient(SCHEMA_URL);
    await admin.connect();
    await driver.harness.resetSchema(admin);
    backend = new PgvectorBackend(SCHEMA_URL, DIMENSIONS, {
      annMaxDimensions: 2000,
    });
    await backend.initialize();
    pool = new pg.Pool({ connectionString: SCHEMA_URL, max: 4 });
    clock = createPublicationTestClock(new Date());
    const composed = backend as PgvectorBackend & {
      structuredPublication?: StructuredPublicationStorage;
    };
    const composedPublication = composed.structuredPublication;
    if (!composedPublication) {
      // EXIT: PgvectorBackend composition supplied no publication adapter. The
      // setup throws before any case runs, so no case can drive screening input
      // through a storage surface the composition does not own.
      throw new Error(
        "PgvectorBackend composition must supply the structured publication storage this case drives"
      );
    }
    publication = composedPublication;
    work = new PgMaintenanceWorkStore(pool);
  }, 120_000);

  afterAll(async () => {
    try {
      await finishOpenAttempts();
      await driver.dropOwnSchema(admin);
    } finally {
      await pool?.end();
      await backend?.close();
      await admin?.end();
    }
  });

  for (const entry of CASES) {
    it(`${entry.id} ${entry.scenario} — owner ${entry.owner}`, async () => {
      warnNotRun(entry.notRun);
      const runnable = RUNNABLE_CLAIMS[entry.id];
      if (runnable !== undefined) {
        await runnable();
      }
      requireFullyRunnable(entry.notRun);
    });
  }

  it("carries the complete frozen S1 case map with an owner, a real boundary, an expected-result source and a cleanup contract per case", () => {
    for (const entry of CASES) {
      expect(entry.owner, `${entry.id} has no owning ticket`).not.toBe("");
      expect(
        entry.scenarioSource,
        `${entry.id} has no scenario source`
      ).not.toBe("");
      expect(entry.boundary, `${entry.id} has no real boundary`).not.toBe("");
      expect(
        entry.expectedSource,
        `${entry.id} has no expected-result source`
      ).not.toBe("");
      expect(entry.cleanup, `${entry.id} has no cleanup contract`).not.toBe("");
      expect(
        entry.notRun.entries.length,
        `${entry.id} has no named absent claim`
      ).toBeGreaterThan(0);
      for (const claim of entry.notRun.entries) {
        expect(
          claim.owner,
          `${entry.id} ${claim.claim} has no owning ticket`
        ).not.toBe("");
        expect(
          claim.reason,
          `${entry.id} ${claim.claim} has no reason`
        ).not.toBe("");
      }
    }
    expect(CASE_IDS).toEqual([
      "SC-01",
      "SC-02",
      "SC-03",
      "SC-04",
      "SC-05",
      "SC-06",
      "SC-07",
      "SC-08",
      "SC-09",
      "SC-10",
      "SC-11",
      "SC-12",
      "SC-13",
      "SC-14",
      "SC-15",
    ]);
  });
});
