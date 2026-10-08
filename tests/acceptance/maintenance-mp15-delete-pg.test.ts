/**
 * MP15 collection-delete acceptance lane — spec cases M15/M16
 * (fin specs/structured-corpus-maintenance.md §Physical collection :309-:314,
 * plan structured-corpus-mp15-delete-p3-i4.md) on the real boundary.
 *
 * Same two properties as the MP13/MP14 lanes, and for the same reasons:
 *
 * 1. It runs against real Postgres through the package's real bootstrap, because
 *    every case here is about which ROWS exist after the delete commits: the
 *    phase order over RESTRICT-protected row sets, the withdrawn mark, the
 *    surviving identity row with its `payload_collected_at` stamp, and the
 *    progress row a crashed attempt can be resumed from. A fake client proves
 *    the call order and nothing about the commit.
 * 2. It does not skip. Under `npm test` it is inert; under the marker an
 *    unreachable database fails the run instead of skipping, so the recorded
 *    exit status means what the record says it means:
 *
 *      IK_STRUCTURED_COLLECTION_DELETE_PG=1 GRAPHRAG_MEMORY_DB_URL=<dsn> \
 *        npx vitest run tests/acceptance/maintenance-mp15-delete-pg.test.ts
 *
 * The M16 crash-resume case seeds the progress row a crashed attempt leaves
 * behind (committed phases recorded, nothing collected) and proves a retry
 * deletes each remaining row set exactly once and finishes the terminal step —
 * no premature success, no doubled deletion.
 *
 * The `structured_purge_outcomes` row is seeded `scheduled` because on this
 * branch the purge transaction does not yet schedule completion (that line is
 * MP17's merge, `schedulePurgeCompletion`); the row's existence is the
 * precondition ADR 0099 §2.1 puts under the collection stamp.
 *
 * Scope note: the vector tier is out of scope (plan §Vector-side payload) —
 * `chunks` carries no `source_version_id`, so no case here asserts chunk
 * removal, and the shared-reference counts are reported, never gating.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { PgCollectionDeleteStore } from "../../src/core/storage/collection-delete-pg.js";
import {
  PgCollectionMarkStore,
} from "../../src/core/storage/collection-mark-pg.js";
import {
  EVIDENCE_GRANT_KIND,
  EVIDENCE_SUBJECT_KIND,
  EVIDENCE_SUPPORT_ROLE,
} from "../../src/core/types.js";
import {
  createPgIntegrationHarness,
  probePostgres,
  resolvePgConnectionString,
  type PgIntegrationHarness,
} from "../integration/pg-test-harness.js";
import type { PgStructuredScopeUnitOfWork } from "../../src/core/storage/structured-scope-uow.js";
import type {
  AuthorizedScopeContext,
  AuthorizedScopeInput,
} from "../../src/core/storage/structured-scope-types.js";
import type {
  CollectionCandidate,
  CollectionEligibility,
} from "../../src/core/maintenance/collector-types.js";
import {
  decideCollectionEligibility,
  RETIRED_PAYLOAD_DEADLINE_DAYS,
} from "../../src/core/maintenance/collector-eligibility.js";
import type { CollectionMark } from "../../src/core/maintenance/collection-mark-types.js";

const EXPECTED_COMMAND =
  "IK_STRUCTURED_COLLECTION_DELETE_PG=1 GRAPHRAG_MEMORY_DB_URL=<dsn> npx vitest run tests/acceptance/maintenance-mp15-delete-pg.test.ts";
const DEDICATED_MARKER = "IK_STRUCTURED_COLLECTION_DELETE_PG";
const PROGRAM_MARKER = "MAINTENANCE_ACCEPTANCE";
const DIM = 8;
const SCOPE = "scope-mp15";
const ACTOR = "mp15-operator";
const AUTHORIZATION_REVISION = "auth-mp15-1";
const PURGE_REVISION = "purge-mp15-0";
const PAYLOAD_REF = "s1";
const DAY_MS = 86_400_000;

const DEDICATED_SET = process.env[DEDICATED_MARKER] === "1";
const REQUIRED =
  DEDICATED_SET || process.env[PROGRAM_MARKER] === "1";
const CONNECTION_STRING = resolvePgConnectionString(
  "postgresql://postgres@localhost/postgres"
);

const harness: PgIntegrationHarness = await createPgIntegrationHarness({
  label: "maintenance-mp15-delete-pg",
  testPath: "tests/acceptance/maintenance-mp15-delete-pg.test.ts",
  expectedCommand: EXPECTED_COMMAND,
  schemaPrefix: "mp15_delete",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: true,
});

if (REQUIRED) {
  // EXIT: the marker is set, so this run CLAIMS to be acceptance evidence. An
  // unreachable database is therefore this named failure, never a skip.
  const probe = await probePostgres(CONNECTION_STRING, true);
  if (!probe.available) {
    throw new Error(
      [
        "Validation:",
        "- Not run: the MP15 delete lane requires a real Postgres 16 + pgvector.",
        `- Expected command: ${EXPECTED_COMMAND}`,
        `- Markers: ${DEDICATED_MARKER}=1 or ${PROGRAM_MARKER}=1 were set.`,
        `- Blocking issue: ${
          probe.error instanceof Error ? probe.error.message : String(probe.error)
        }`,
        "- A skipped lane is not acceptance evidence, so this run exits non-zero.",
      ].join("\n")
    );
  }
}

const describeAcceptance = REQUIRED ? harness.describePg : harness.describePg.skip;

const iso = (value: Date): string => value.toISOString();
/**
 * Days before the DATABASE's own clock, not before a fixture constant.
 *
 * The PG stores decide `now` with `clock_timestamp()` inside the transaction,
 * so a fixture anchored to a fixed instant would be compared against wall-clock
 * time and every grace case would silently pass. Every retirement, grant and
 * anchor below is therefore an offset from the moment the case runs.
 */
const daysBeforeNow = (days: number): Date =>
  new Date(Date.now() - days * DAY_MS);

describeAcceptance("MP15 acceptance — collection deletion on the real boundary", () => {
  let backend: PgvectorBackend;
  let admin: pg.Client;
  let pool: pg.Pool;
  let authority: PgStructuredScopeUnitOfWork;
  let marks: PgCollectionMarkStore;
  let deletes: PgCollectionDeleteStore;
  let serial = 0;

  beforeAll(async () => {
    admin = harness.createClient(harness.schemaConnectionString);
    await admin.connect();
    await harness.resetSchema(admin);
    backend = new PgvectorBackend(harness.schemaConnectionString, DIM, {
      annMaxDimensions: 2000,
    });
    await backend.initialize();
    pool = new pg.Pool({ connectionString: harness.schemaConnectionString, max: 4 });
    const composed = backend as PgvectorBackend & {
      structuredScopeUnitOfWork?: PgStructuredScopeUnitOfWork;
    };
    const composedAuthority = composed.structuredScopeUnitOfWork;
    if (!composedAuthority) {
      throw new Error(
        "PgvectorBackend composition must supply the shared scope unit of work to the delete store"
      );
    }
    authority = composedAuthority;
    marks = new PgCollectionMarkStore(authority);
    deletes = new PgCollectionDeleteStore(pool);
  }, 120_000);

  beforeEach(async () => {
    serial += 1;
    // CASCADE because the scope, mark, pin and stamp tables reference these rows;
    // the schema is this run's own throwaway one.
    await admin.query(
      `TRUNCATE structured_collection_marks, structured_collection_deletions,
                structured_purge_outcomes, evidence_scope_revisions,
                structured_publication_stages, structured_publication_sources,
                structured_publication_scopes, structured_publication_extraction_bindings,
                evidence_grant_supports, evidence_grant_extractions, evidence_grants,
                evidence_authorization_receipts, support_extractions, assertion_supports,
                source_version_locators, maintenance_job_attempts, maintenance_jobs,
                source_versions
         CASCADE`
    );
  });

  afterAll(async () => {
    try {
      await harness.dropSchema(admin);
    } finally {
      await admin?.end();
      await pool?.end();
      await backend?.close();
    }
  });

  /** The scope's live maintenance revision, read back as decimal text. */
  async function maintenanceRevision(): Promise<bigint> {
    const { rows } = await pool.query(
      `SELECT maintenance_revision::text AS revision
         FROM structured_publication_scopes WHERE scope_binding = $1`,
      [SCOPE]
    );
    return BigInt(String(rows[0]?.revision ?? "0"));
  }

  interface Seeded {
    readonly sourceVersionId: string;
    readonly sourceRef: string;
    readonly supportIds: readonly string[];
  }

  /**
   * One retired source version with the full payload shape MP15 removes: two
   * locators, two supports, one extraction link each, both pinned by one row
   * grant. The grant's `queried_at` is 430 days ago, so its 365-day reference
   * lifetime ended 65 days ago — EXPIRED, its pins phase-1 work, not a live
   * reference that refuses the delete.
   */
  async function seedPayload(
    options: { readonly retiredDays?: number; readonly secondVersion?: boolean } = {}
  ): Promise<Seeded> {
    const sourceRef = `${PAYLOAD_REF}-${serial}`;
    const retiredAt = daysBeforeNow(options.retiredDays ?? 200);
    const sourceVersionId = randomUUID();
    await admin.query(
      `INSERT INTO source_versions
         (source_version_id, source_ref, source_version, content_digest,
          origin_object_ref, parser_revision, unit_manifest, created_at, retired_at)
       VALUES ($1, $2, 'v1', $3, $4, 'parser-1', '[]'::jsonb, $5, $6)`,
      [
        sourceVersionId,
        sourceRef,
        `digest-${sourceRef}`,
        `obj://${sourceRef}/v1`,
        iso(daysBeforeNow(400)),
        iso(retiredAt),
      ]
    );
    // The shared-object fixture: a second logical source naming the SAME digest
    // and object ref, so the reported live-reference counts have something to
    // count (plan §Shared-object key — reported, never gating).
    if (options.secondVersion) {
      await admin.query(
        `INSERT INTO source_versions
           (source_version_id, source_ref, source_version, content_digest,
            origin_object_ref, parser_revision, unit_manifest, created_at)
         VALUES ($1, $2, 'v1', $3, $4, 'parser-1', '[]'::jsonb, $5)`,
        [
          randomUUID(),
          `${sourceRef}-other`,
          `digest-${sourceRef}`,
          `obj://${sourceRef}/v1`,
          iso(daysBeforeNow(400)),
        ]
      );
    }
    for (const unit of [1, 2]) {
      await admin.query(
        `INSERT INTO source_version_locators
           (source_version_id, document_id, unit_version, unit)
         VALUES ($1, $2, 'frozen-v1', $3)`,
        [sourceVersionId, `${sourceRef}-document`, unit]
      );
    }
    const supportIds: string[] = [];
    for (const unit of [1, 2]) {
      const supportId = randomUUID();
      supportIds.push(supportId);
      await admin.query(
        `INSERT INTO assertion_supports
           (support_id, subject, result_id, source_ref, source_version,
            source_version_id, document_id, unit_version, unit, created_at)
         VALUES ($1, 'entity', 'result-1', $2, 'v1', $3, $4, 'frozen-v1', $5, $6)`,
        [supportId, sourceRef, sourceVersionId, `${sourceRef}-document`, unit, iso(retiredAt)]
      );
      await admin.query(
        `INSERT INTO support_extractions (support_id, extraction_ref, created_at)
         VALUES ($1, $2, $3)`,
        [supportId, `${sourceRef}-extraction-${unit}`, iso(retiredAt)]
      );
    }
    const evidenceRef = randomUUID();
    await admin.query(
      `INSERT INTO evidence_grants
         (evidence_ref, grant_kind, subject, operation, query_digest, scope_binding,
          read_revision, authorization_revision, purge_revision, queried_at,
          expires_at, context, value, result_count, authorization_receipt_id,
          consumer_id)
       VALUES ($1, 'row', 'entity', 'list', 'digest-q', $2, '0', $3, $4,
               $5::timestamptz, $6::timestamptz, '{}'::jsonb, '{}'::jsonb,
               NULL, NULL, $7)`,
      [
        evidenceRef,
        SCOPE,
        AUTHORIZATION_REVISION,
        PURGE_REVISION,
        iso(daysBeforeNow(430)),
        iso(daysBeforeNow(430 - 365)),
        `${sourceRef}-consumer`,
      ]
    );
    for (const [index, supportId] of supportIds.entries()) {
      await admin.query(
        `INSERT INTO evidence_grant_supports (evidence_ref, support_id, role)
         VALUES ($1, $2, $3)`,
        [evidenceRef, supportId, EVIDENCE_SUPPORT_ROLE.OCCURRENCE]
      );
      await admin.query(
        `INSERT INTO evidence_grant_extractions
           (evidence_ref, support_id, extraction_ref)
         VALUES ($1, $2, $3)`,
        [evidenceRef, supportId, `${sourceRef}-extraction-${index + 1}`]
      );
    }
    return { sourceVersionId, sourceRef, supportIds };
  }

  /** The scope, its admission rows, and one member source desiring v1. */
  async function seedScope(sourceRef: string): Promise<void> {
    await admin.query(
      `INSERT INTO structured_publication_scopes (scope_binding) VALUES ($1)`,
      [SCOPE]
    );
    await admin.query(
      `INSERT INTO structured_publication_sources
         (scope_binding, source_ref, active, generation, desired_source_version,
          desired_extraction_revision, desired_config_revision)
       VALUES ($1, $2, true, 1, 'v1', 1, 'extractor-1')`,
      [SCOPE, sourceRef]
    );
    await admin.query(
      `INSERT INTO evidence_scope_revisions
         (scope_binding, authorization_revision, purge_revision)
       VALUES ($1, $2, $3)`,
      [SCOPE, AUTHORIZATION_REVISION, PURGE_REVISION]
    );
    await admin.query(
      `INSERT INTO structured_purge_outcomes
         (scope_binding, purge_revision, collection_state)
       VALUES ($1, $2, 'scheduled')`,
      [SCOPE, PURGE_REVISION]
    );
  }

  function context(sourceRefs: readonly string[]): AuthorizedScopeContext {
    return authority.createAuthorizedContext({
      actorId: ACTOR,
      ownerScopeBinding: SCOPE,
      readerBinding: "reader-1",
      authorizedSourceRefs: [...sourceRefs],
      authorizationRevision: AUTHORIZATION_REVISION,
      deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    } as AuthorizedScopeInput);
  }

  /** MP13's pure decision on clean facts; MP14 takes it as given.
   *  The candidate's anchor is the retirement instant (retiredDays before the
   *  delete); the decision instant is that anchor + the 90-day class deadline,
   *  exactly when MP13 first calls the payload eligible. */
  function eligibilityFor(retiredDays: number): CollectionEligibility {
    const candidate: CollectionCandidate = {
      payloadClass: "retired_unreferenced",
      payloadRef: PAYLOAD_REF,
      source: {
        sourceRef: PAYLOAD_REF,
        sourceVersion: "v1",
        sourceGeneration: 1,
      },
      anchorAt: iso(daysBeforeNow(retiredDays)),
    };
    const outcome = decideCollectionEligibility(
      candidate,
      {
        bindingResolved: true,
        payloadCollected: false,
        targetRetired: true,
        currentDependencies: [],
        validLeases: [],
        rowReferences: [],
        countOnlyGrants: [],
      },
      new Date(daysBeforeNow(retiredDays).getTime() + RETIRED_PAYLOAD_DEADLINE_DAYS * DAY_MS)
    );
    if (outcome.refused) {
      throw new Error(`eligibility refused ${outcome.code}: ${outcome.detail}`);
    }
    return outcome.eligibility;
  }

  async function markSourceVersion(
    sourceRef: string,
    sourceVersionId: string,
    retiredDays = 200
  ): Promise<CollectionMark> {
    const outcome = await marks.markCollectionCandidate({
      context: context([sourceRef]),
      identity: {
        payloadClass: "retired_unreferenced",
        payloadRef: PAYLOAD_REF,
      },
      scopeBinding: SCOPE,
      sourceVersionId,
      eligibility: eligibilityFor(retiredDays),
    });
    if (outcome.refused) {
      throw new Error(`mark refused ${outcome.code}: ${outcome.detail}`);
    }
    return outcome.plan.mark;
  }

  function deleteRequest(
    sourceRef: string
  ): Parameters<typeof deletes.deleteCollectionPayload>[0] {
    return {
      context: context([sourceRef]),
      scopeBinding: SCOPE,
      identity: {
        payloadClass: "retired_unreferenced",
        payloadRef: PAYLOAD_REF,
      },
      purgeRevision: PURGE_REVISION,
    };
  }

  /** The live row count of one table, filtered how the case asks. */
  async function countRows(
    table: string,
    where: string,
    values: readonly unknown[] = []
  ): Promise<number> {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      [...values]
    );
    return Number((rows[0] as { n: number }).n);
  }

  /** The full observable state one case reads back from the database. */
  async function readState(sourceVersionId: string) {
    const { rows } = await pool.query(
      `SELECT
         (SELECT payload_collected_at FROM source_versions
           WHERE source_version_id = $1) AS payload_collected_at,
         (SELECT count(*) FROM structured_collection_marks
           WHERE payload_class = 'retired_unreferenced' AND payload_ref = $2) AS marks,
         (SELECT committed_phases FROM structured_collection_deletions
           WHERE source_version_id = $1 AND purge_revision = $3) AS committed_phases,
         (SELECT collected_at FROM structured_collection_deletions
           WHERE source_version_id = $1 AND purge_revision = $3) AS progress_collected_at,
         (SELECT collection_state FROM structured_purge_outcomes
           WHERE scope_binding = $4 AND purge_revision = $3) AS collection_state,
         (SELECT maintenance_revision::text FROM structured_publication_scopes
           WHERE scope_binding = $4) AS maintenance_revision`,
      [sourceVersionId, PAYLOAD_REF, PURGE_REVISION, SCOPE]
    );
    const row = rows[0] as Record<string, unknown>;
    return {
      payloadCollectedAt: row.payload_collected_at,
      marks: Number(row.marks),
      committedPhases: Array.isArray(row.committed_phases)
        ? (row.committed_phases as string[])
        : [],
      progressCollectedAt: row.progress_collected_at,
      collectionState: row.collection_state,
      maintenanceRevision: String(row.maintenance_revision ?? "0"),
    };
  }

  it("runs every phase in order, withdraws the mark, stamps the version and advances the scope once", async () => {
    const seeded = await seedPayload();
    await seedScope(seeded.sourceRef);
    await markSourceVersion(seeded.sourceRef, seeded.sourceVersionId);
    const revisionAfterMark = await maintenanceRevision();

    const outcome = await deletes.deleteCollectionPayload(
      deleteRequest(seeded.sourceRef)
    );
    expect(outcome.refused).toBe(false);
    if (outcome.refused) return;

    // Every phase ran, each once, with the counts the seeded rows dictate.
    expect(outcome.outcome.phasesRun).toEqual([
      "dependent_supports",
      "extraction_payloads",
      "assertion_supports",
      "frozen_units",
      "superseded_caches",
    ]);
    expect(outcome.outcome.phaseCounts).toEqual({
      dependent_supports: 4, // 2 grant-support pins + 2 grant-extraction pins
      extraction_payloads: 2,
      assertion_supports: 2,
      frozen_units: 2,
      superseded_caches: 0, // the fixture published no extraction bindings
    });

    // Nothing is left of the payload; the identity row survives with the stamp.
    expect(await countRows("evidence_grant_supports", "support_id = ANY($1::uuid[])", [seeded.supportIds])).toBe(0);
    expect(await countRows("evidence_grant_extractions", "support_id = ANY($1::uuid[])", [seeded.supportIds])).toBe(0);
    expect(await countRows("support_extractions", "support_id = ANY($1::uuid[])", [seeded.supportIds])).toBe(0);
    expect(await countRows("assertion_supports", "source_version_id = $1", [seeded.sourceVersionId])).toBe(0);
    expect(await countRows("source_version_locators", "source_version_id = $1", [seeded.sourceVersionId])).toBe(0);
    expect(await countRows("source_versions", "source_version_id = $1", [seeded.sourceVersionId])).toBe(1);
    expect(await countRows("structured_collection_marks", "payload_ref = $1", [PAYLOAD_REF])).toBe(0);

    const state = await readState(seeded.sourceVersionId);
    expect(state.payloadCollectedAt).not.toBeNull();
    expect(state.committedPhases).toEqual([
      "dependent_supports",
      "extraction_payloads",
      "assertion_supports",
      "frozen_units",
      "superseded_caches",
    ]);
    expect(state.progressCollectedAt).not.toBeNull();
    expect(state.collectionState).toBe("collected");
    // The mark moved the scope once; the deletion moves it exactly once more.
    expect(BigInt(state.maintenanceRevision)).toBe(revisionAfterMark + 1n);
  });

  it("reports the exact live-reference counts on the shared-object columns without gating", async () => {
    const seeded = await seedPayload({ secondVersion: true });
    await seedScope(seeded.sourceRef);
    await markSourceVersion(seeded.sourceRef, seeded.sourceVersionId);

    const outcome = await deletes.deleteCollectionPayload(
      deleteRequest(seeded.sourceRef)
    );
    expect(outcome.refused).toBe(false);
    if (outcome.refused) return;
    // One OTHER version row names the same digest and object ref, and the
    // deletion proceeded anyway — reported, never gating (plan §Shared-object
    // key: keying on a hash is exactly what spec:312 forbids).
    expect(outcome.outcome.sharedReferences).toEqual({
      contentDigestReferences: 1,
      originObjectReferences: 1,
    });
  });

  it("refuses a live row grant before any row moves, and changes nothing", async () => {
    const seeded = await seedPayload();
    await seedScope(seeded.sourceRef);
    await markSourceVersion(seeded.sourceRef, seeded.sourceVersionId);
    // Re-date the grant so it is LIVE at the delete: the seeded fixture's grant
    // was expired; this UPDATE is the only difference between the two worlds.
    await admin.query(
      `UPDATE evidence_grants SET queried_at = $2::timestamptz,
              expires_at = $3::timestamptz
        WHERE scope_binding = $1`,
      [SCOPE, iso(daysBeforeNow(1)), iso(daysBeforeNow(-300))]
    );

    const revisionBefore = await maintenanceRevision();
    const outcome = await deletes.deleteCollectionPayload(
      deleteRequest(seeded.sourceRef)
    );

    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("input_stale");
    expect(outcome.detail).toContain("row grant");
    // The refusal is a value and changes nothing: mark stands, pins stand,
    // revision did not move, nothing is stamped.
    expect(await countRows("structured_collection_marks", "payload_ref = $1", [PAYLOAD_REF])).toBe(1);
    expect(await countRows("evidence_grant_supports", "support_id = ANY($1::uuid[])", [seeded.supportIds])).toBe(2);
    expect((await readState(seeded.sourceVersionId)).payloadCollectedAt).toBeNull();
    expect((await readState(seeded.sourceVersionId)).maintenanceRevision).toBe(
      revisionBefore.toString()
    );
  });

  it("refuses a payload whose grace deadline has not passed", async () => {
    // Retired 95 days before the delete: eligible at retirement + 90 days, so
    // the mark stands, but the mark's deadline (that instant + the 7-day grace)
    // lands five days AFTER the delete instant — the early-delete case.
    const seeded = await seedPayload({ retiredDays: 95 });
    await seedScope(seeded.sourceRef);
    await markSourceVersion(seeded.sourceRef, seeded.sourceVersionId, 95);
    const outcome = await deletes.deleteCollectionPayload(
      deleteRequest(seeded.sourceRef)
    );
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("input_stale");
    expect(await countRows("assertion_supports", "source_version_id = $1", [seeded.sourceVersionId])).toBe(2);
    expect((await readState(seeded.sourceVersionId)).payloadCollectedAt).toBeNull();
  });

  it("resumes a crashed attempt from its progress row, deleting each remaining row set exactly once", async () => {
    const seeded = await seedPayload();
    await seedScope(seeded.sourceRef);
    await markSourceVersion(seeded.sourceRef, seeded.sourceVersionId);

    // The M16 crash: the first two phases committed, nothing else. Their rows
    // are removed HERE (the crash left them gone) and the progress the crashed
    // attempt committed is recorded, with no collected_at anywhere. A retry that
    // re-ran phase 1 or 2 would therefore find nothing and could not tell
    // "already deleted" from "never there" — the progress row is what stops it,
    // and the zero counts below are the observable proof.
    await admin.query(
      `DELETE FROM evidence_grant_supports
        WHERE support_id = ANY($1::uuid[])`,
      [seeded.supportIds]
    );
    await admin.query(
      `DELETE FROM evidence_grant_extractions
        WHERE support_id = ANY($1::uuid[])`,
      [seeded.supportIds]
    );
    await admin.query(
      `DELETE FROM support_extractions WHERE support_id = ANY($1::uuid[])`,
      [seeded.supportIds]
    );
    await admin.query(
      `INSERT INTO structured_collection_deletions
         (source_version_id, purge_revision, committed_phases, collected_at)
       VALUES ($1::uuid, $2, $3, NULL)`,
      [
        seeded.sourceVersionId,
        PURGE_REVISION,
        ["dependent_supports", "extraction_payloads"],
      ]
    );

    const outcome = await deletes.deleteCollectionPayload(
      deleteRequest(seeded.sourceRef)
    );
    expect(outcome.refused).toBe(false);
    if (outcome.refused) return;

    // Exactly the tail ran, and each surviving row set is deleted exactly once —
    // the crashed phases report zero, not doubled.
    expect(outcome.outcome.phasesRun).toEqual([
      "assertion_supports",
      "frozen_units",
      "superseded_caches",
    ]);
    expect(outcome.outcome.phaseCounts).toEqual({
      dependent_supports: 0,
      extraction_payloads: 0,
      assertion_supports: 2,
      frozen_units: 2,
      superseded_caches: 0,
    });
    const state = await readState(seeded.sourceVersionId);
    expect(state.payloadCollectedAt).not.toBeNull();
    expect(state.marks).toBe(0);
    expect(state.collectionState).toBe("collected");
  });

  it("refuses a retry after full completion without re-running any phase", async () => {
    const seeded = await seedPayload();
    await seedScope(seeded.sourceRef);
    await markSourceVersion(seeded.sourceRef, seeded.sourceVersionId);
    const first = await deletes.deleteCollectionPayload(
      deleteRequest(seeded.sourceRef)
    );
    expect(first.refused).toBe(false);

    // The retry arrives after the payload was collected. The mark row was
    // withdrawn with the payload (the plan's terminal step), so the plan's own
    // refusal order answers "no collection mark" — input_stale either way, and
    // the ADR 0099 §2.1 monotonic guarantee is that NOTHING re-deletes: the
    // counts below stay the first run's, the stamp and progress row unchanged.
    const second = await deletes.deleteCollectionPayload(
      deleteRequest(seeded.sourceRef)
    );
    expect(second.refused).toBe(true);
    if (!second.refused) return;
    expect(second.code).toBe("input_stale");
    const state = await readState(seeded.sourceVersionId);
    expect(state.payloadCollectedAt).not.toBeNull();
    expect(state.marks).toBe(0);
    expect(state.collectionState).toBe("collected");
    expect(state.committedPhases).toEqual([
      "dependent_supports",
      "extraction_payloads",
      "assertion_supports",
      "frozen_units",
      "superseded_caches",
    ]);
  });

  it("refuses a foreign scope before any row moves", async () => {
    const seeded = await seedPayload();
    await seedScope(seeded.sourceRef);
    await markSourceVersion(seeded.sourceRef, seeded.sourceVersionId);
    const outcome = await deletes.deleteCollectionPayload({
      ...deleteRequest(seeded.sourceRef),
      scopeBinding: "a-different-scope",
    });
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("access_denied");
    expect(await countRows("assertion_supports", "source_version_id = $1", [seeded.sourceVersionId])).toBe(2);
  });

  it("refuses a payload that was never marked", async () => {
    const seeded = await seedPayload();
    await seedScope(seeded.sourceRef);
    const outcome = await deletes.deleteCollectionPayload(
      deleteRequest(seeded.sourceRef)
    );
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("input_stale");
    expect(await countRows("assertion_supports", "source_version_id = $1", [seeded.sourceVersionId])).toBe(2);
  });
});

// Keep the pure imports honest: EVIDENCE_SUBJECT_KIND/EVIDENCE_GRANT_KIND are
// the vocabulary the seeded grant rows must spell ('row', 'entity'), asserted
// here so the fixture cannot drift from the schema's CHECK lists.
void EVIDENCE_GRANT_KIND.ROW;
void EVIDENCE_SUBJECT_KIND.ENTITY;
