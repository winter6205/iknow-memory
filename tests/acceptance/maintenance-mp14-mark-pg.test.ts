/**
 * MP14 collection-mark acceptance lane — spec cases M15-M18
 * (fin specs/structured-corpus-maintenance.md lines 368-375) on the real boundary.
 *
 * Same two properties as the MP13 collection lane, and for the same reasons:
 *
 * 1. It runs against real Postgres through the package's real bootstrap, because
 *    every case here is about which ROWS exist and which of them moved together:
 *    a revision counter, a stamp on `source_versions`, a cancelled mark. A fake
 *    client proves the call order and nothing about the commit.
 * 2. It does not skip. Under `npm test` it is inert; under `MAINTENANCE_ACCEPTANCE=1`
 *    an unreachable database fails collection instead of skipping, so the recorded
 *    exit status means what the record says it means:
 *
 *      MAINTENANCE_ACCEPTANCE=1 npx vitest run tests/acceptance/maintenance-mp14-mark-pg.test.ts
 *
 * Scope note: this lane proves MARKING and REACTIVATION only. Deletion is MP15, so
 * no case here asserts that a payload was physically removed — a mark's deadline is
 * a promise, and the promise is the thing under test.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import {
  COLLECTION_DAY_MS,
  readCollectionEligibility,
} from "../../src/core/maintenance/collector-eligibility.js";
import type {
  CollectionCandidate,
  CollectionEligibility,
} from "../../src/core/maintenance/collector-types.js";
import { PgCollectionEligibilityReader } from "../../src/core/storage/collector-eligibility-pg.js";
import {
  PgCollectionMarkStore,
  type CollectionMarkReadOutcome,
} from "../../src/core/storage/collection-mark-pg.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { upSchemaCollectionMark } from "../../src/core/storage/schema-collection-mark.js";
import type { PgStructuredScopeUnitOfWork } from "../../src/core/storage/structured-scope-uow.js";
import type {
  AuthorizedScopeContext,
  AuthorizedScopeInput,
} from "../../src/core/storage/structured-scope-types.js";
import {
  createPgIntegrationHarness,
  probePostgres,
  resolvePgConnectionString,
} from "../integration/pg-test-harness.js";

const EXPECTED_COMMAND =
  "MAINTENANCE_ACCEPTANCE=1 npx vitest run tests/acceptance/maintenance-mp14-mark-pg.test.ts";
const ACCEPTANCE_ENV = "MAINTENANCE_ACCEPTANCE";
const DIM = 8;
const SCOPE = "scope-a";
const ACTOR = "m18-operator";
const AUTHORIZATION_REVISION = "auth-1";

const REQUIRED = process.env[ACCEPTANCE_ENV] === "1";
const CONNECTION_STRING = resolvePgConnectionString(
  "postgresql://postgres@localhost/postgres"
);

const iso = (value: Date): string => value.toISOString();
/** Days before the database's own clock, so a purge floor lands before or after it. */
const daysBeforeNow = (days: number): Date =>
  new Date(Date.now() - days * COLLECTION_DAY_MS);

const pgHarness = await createPgIntegrationHarness({
  label: "maintenance-mp14-mark-pg",
  testPath: "tests/acceptance/maintenance-mp14-mark-pg.test.ts",
  expectedCommand: EXPECTED_COMMAND,
  schemaPrefix: "mp14_mark",
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
        "- Not run: the MP14 mark lane requires a real Postgres 16 + pgvector.",
        `- Expected command: ${EXPECTED_COMMAND}`,
        `- Blocking issue: ${probe.error instanceof Error ? probe.error.message : String(probe.error)}`,
      ].join("\n")
    );
  }
}

const describeAcceptance = REQUIRED
  ? pgHarness.describePg
  : pgHarness.describePg.skip;

interface MarkedRow {
  readonly payload_class: string;
  readonly payload_ref: string;
  readonly scope_binding: string;
  readonly source_version_id: string | null;
  readonly expected_lifecycle_revision: string;
  readonly deadline_at: Date;
  readonly marked_at: Date;
  readonly state: string;
  readonly cancelled_at: Date | null;
  readonly cancelled_reason: string | null;
}

describeAcceptance("M15-M18 acceptance — collection marks on the real boundary", () => {
  let backend: PgvectorBackend;
  let admin: pg.Client;
  let pool: pg.Pool;
  let authority: PgStructuredScopeUnitOfWork;
  let marks: PgCollectionMarkStore;

  beforeAll(async () => {
    admin = createClient(SCHEMA_URL);
    await admin.connect();
    await pgHarness.resetSchema(admin);
    backend = new PgvectorBackend(SCHEMA_URL, DIM, { annMaxDimensions: 2000 });
    await backend.initialize();
    // One deviation from the MP13 lane, and it is a wiring gap rather than a
    // choice: the mark DDL is applied directly because `upSchemaBootstrap` does not
    // yet call `upSchemaCollectionMark`. Until that one call is added, the product
    // cannot build this table, and this lane is what proves the table's shape and
    // the store's transaction before the wiring lands.
    await upSchemaCollectionMark(admin);
    pool = new pg.Pool({ connectionString: SCHEMA_URL, max: 4 });
    const composed = backend as PgvectorBackend & {
      structuredScopeUnitOfWork?: PgStructuredScopeUnitOfWork;
    };
    const composedAuthority = composed.structuredScopeUnitOfWork;
    if (!composedAuthority) {
      throw new Error(
        "PgvectorBackend composition must supply the shared authorized scope unit of work to the mark store"
      );
    }
    authority = composedAuthority;
    marks = new PgCollectionMarkStore(authority);
  }, 120_000);

  beforeEach(async () => {
    // CASCADE because the scope, mark and stamp tables reference these rows; the
    // schema is this run's own throwaway one.
    await admin.query(
      `TRUNCATE structured_collection_marks, evidence_scope_revisions,
                structured_publication_stages, structured_publication_sources,
                structured_publication_scopes, evidence_grant_supports,
                evidence_grant_extractions, evidence_grants,
                evidence_authorization_receipts, assertion_supports,
                maintenance_job_attempts, maintenance_jobs, source_versions
         CASCADE`
    );
  });

  afterAll(async () => {
    try {
      await pgHarness.dropSchema(admin);
    } finally {
      await admin?.end();
      await pool?.end();
      await backend?.close();
    }
  });

  /**
   * A scope the authority admits, owning the named sources.
   *
   * The membership desires `v2` while the collected version is `v1`, which is both
   * the coherent state for this lane and the only shape that works: ownership
   * resolves on `source_ref` alone, but MP13 counts a scope as a current dependency
   * only when it desires or publishes the *collected* version. A scope that had
   * moved on to v2 is exactly why v1 is collectible.
   */
  async function seedScope(sourceRefs: readonly string[]): Promise<void> {
    await admin.query(
      `INSERT INTO structured_publication_scopes (scope_binding) VALUES ($1)`,
      [SCOPE]
    );
    for (const sourceRef of sourceRefs) {
      await admin.query(
        `INSERT INTO structured_publication_sources
           (scope_binding, source_ref, active, generation, desired_source_version,
            desired_extraction_revision, desired_config_revision)
         VALUES ($1, $2, true, 2, 'v2', 1, 'extractor-1')`,
        [SCOPE, sourceRef]
      );
    }
    await backend.setScopeRevisions(SCOPE, {
      authorizationRevision: AUTHORIZATION_REVISION,
      purgeRevision: "purge-1",
    });
  }

  /**
   * One retired, unreferenced source version — a real row, nothing citing it.
   *
   * The second row is the version this scope desires, and it is retired on purpose:
   * the membership needs it to satisfy its foreign key, while an unretired sibling
   * would be a `current_source_version` dependency and the candidate would not be
   * collectible at all.
   */
  async function seedSourceVersion(
    sourceRef: string,
    retiredAt: Date
  ): Promise<string> {
    let collectedVersionId = "";
    for (const version of ["v1", "v2"]) {
      const sourceVersionId = randomUUID();
      if (version === "v1") collectedVersionId = sourceVersionId;
      await admin.query(
        `INSERT INTO source_versions
           (source_version_id, source_ref, source_version, content_digest,
            origin_object_ref, parser_revision, unit_manifest, created_at, retired_at)
         VALUES ($1, $2, $3, $4, $5, 'parser-1', '[]'::jsonb, $6, $7)`,
        [
          sourceVersionId,
          sourceRef,
          version,
          "b".repeat(64),
          `obj://${sourceRef}/${version}`,
          iso(retiredAt),
          iso(retiredAt),
        ]
      );
    }
    return collectedVersionId;
  }

  function candidate(
    sourceRef: string,
    anchorAt: Date
  ): CollectionCandidate {
    return {
      payloadClass: "retired_unreferenced",
      payloadRef: sourceRef,
      source: {
        sourceRef,
        sourceVersion: "v1",
        sourceGeneration: 1,
      },
      anchorAt: iso(anchorAt),
    };
  }

  /** MP13's own read, so the mark's deadline comes from the eligibility boundary. */
  async function decide(
    payload: CollectionCandidate,
    now: Date
  ): Promise<CollectionEligibility> {
    const outcome = await readCollectionEligibility(
      { reader: new PgCollectionEligibilityReader(pool), clock: () => now },
      payload
    );
    if (outcome.refused) {
      throw new Error(`eligibility refused ${outcome.code}: ${outcome.detail}`);
    }
    return outcome.eligibility;
  }

  function context(
    sourceRefs: readonly string[],
    input: Partial<AuthorizedScopeInput> = {}
  ): AuthorizedScopeContext {
    return authority.createAuthorizedContext({
      actorId: ACTOR,
      ownerScopeBinding: SCOPE,
      readerBinding: "reader-1",
      authorizedSourceRefs: [...sourceRefs],
      authorizationRevision: AUTHORIZATION_REVISION,
      deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      ...input,
    } as AuthorizedScopeInput);
  }

  async function maintenanceRevision(): Promise<bigint> {
    const { rows } = await pool.query(
      `SELECT maintenance_revision::text AS revision
         FROM structured_publication_scopes WHERE scope_binding = $1`,
      [SCOPE]
    );
    return BigInt(String(rows[0]?.revision ?? "0"));
  }

  async function readMarkRow(payloadRef: string): Promise<MarkedRow | null> {
    const { rows } = await pool.query<MarkedRow>(
      `SELECT payload_class, payload_ref, scope_binding, source_version_id,
              expected_lifecycle_revision::text AS expected_lifecycle_revision,
              deadline_at, marked_at, state, cancelled_at, cancelled_reason
         FROM structured_collection_marks
        WHERE payload_class = 'retired_unreferenced' AND payload_ref = $1`,
      [payloadRef]
    );
    return rows[0] ?? null;
  }

  async function obligationsStoppedAt(
    sourceVersionId: string
  ): Promise<Date | null> {
    const { rows } = await pool.query<{ obligations_stopped_at: Date | null }>(
      `SELECT obligations_stopped_at FROM source_versions WHERE source_version_id = $1`,
      [sourceVersionId]
    );
    return rows[0]?.obligations_stopped_at ?? null;
  }

  /** M15: the mark holds the post-commit revision, and the purge floor. */
  it("records the post-commit revision and the purge floor as the deadline", async () => {
    const sourceVersionId = await seedSourceVersion("s1", daysBeforeNow(200));
    await seedScope(["s1"]);
    const eligibility = await decide(candidate("s1", daysBeforeNow(200)), new Date());
    expect(eligibility.eligible).toBe(true);

    // The two candidate instants are seven days apart, so a lane that persisted
    // `earliestCandidateAt` could not satisfy the deadline assertion below.
    const candidateAt = Date.parse(eligibility.earliestCandidateAt);
    const purgeFloorAt = Date.parse(eligibility.physicalPurgeNotBefore);
    expect(purgeFloorAt - candidateAt).toBe(7 * COLLECTION_DAY_MS);

    const before = await maintenanceRevision();
    const outcome = await marks.markCollectionCandidate({
      context: context(["s1"]),
      identity: { payloadClass: "retired_unreferenced", payloadRef: "s1" },
      scopeBinding: SCOPE,
      sourceVersionId,
      eligibility,
    });
    if (outcome.refused) {
      throw new Error(`mark refused ${outcome.code}: ${outcome.detail}`);
    }
    expect(outcome.plan.mark.deadlineAt).toBe(eligibility.physicalPurgeNotBefore);

    // Marking advances the very counter the mark records, so the recorded value is
    // the one the scope holds AFTER the commit — not the value observed inside it.
    const after = await maintenanceRevision();
    expect(after).toBe(before + 1n);

    const row = await readMarkRow("s1");
    expect(row).not.toBeNull();
    expect(row?.expected_lifecycle_revision).toBe(after.toString());
    expect(row?.state).toBe("marked");
    expect(row?.scope_binding).toBe(SCOPE);
    expect(row?.source_version_id).toBe(sourceVersionId);

    const persistedDeadline = (row?.deadline_at as Date).toISOString();
    expect(persistedDeadline).toBe(eligibility.physicalPurgeNotBefore);
    expect(persistedDeadline).not.toBe(eligibility.earliestCandidateAt);

    // A bigint must never reach the decision: the row crosses as decimal text.
    expect(typeof row?.expected_lifecycle_revision).toBe("string");
  });

  /**
   * M16: the mark and the obligations stamp are ONE transaction. A deferred
   * constraint trigger raises at COMMIT, which is the only failure point that lands
   * after both writes — so a rollback there proves neither is committed alone.
   */
  it("rolls the mark and the obligations stamp back together", async () => {
    const sourceVersionId = await seedSourceVersion("s1", daysBeforeNow(200));
    await seedScope(["s1"]);
    const eligibility = await decide(candidate("s1", daysBeforeNow(200)), new Date());
    const before = await maintenanceRevision();

    try {
      await admin.query(
        `CREATE FUNCTION mp14_injected_commit_fault() RETURNS trigger
           LANGUAGE plpgsql AS $$
           BEGIN
             RAISE EXCEPTION 'injected commit fault' USING ERRCODE = '58000';
           END $$`
      );
      await admin.query(
        `CREATE CONSTRAINT TRIGGER mp14_mark_commit_fault
           AFTER INSERT ON structured_collection_marks
           DEFERRABLE INITIALLY DEFERRED
           FOR EACH ROW EXECUTE FUNCTION mp14_injected_commit_fault()`
      );

      // The trigger has to be deferred, or it would fire on the INSERT and this
      // case would pass without ever proving anything about the stamp: the rollback
      // would simply have happened before the stamp was reached. Asserted from the
      // catalog so the failure point is the commit, after both writes.
      const deferral = await admin.query<{
        condeferrable: boolean;
        condeferred: boolean;
      }>(
        `SELECT con.condeferrable, con.condeferred
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
          WHERE rel.relname = 'structured_collection_marks'
            AND con.conname = 'mp14_mark_commit_fault'`
      );
      expect(deferral.rows[0]?.condeferrable).toBe(true);
      expect(deferral.rows[0]?.condeferred).toBe(true);

      await expect(
        marks.markCollectionCandidate({
          context: context(["s1"]),
          identity: { payloadClass: "retired_unreferenced", payloadRef: "s1" },
          scopeBinding: SCOPE,
          sourceVersionId,
          eligibility,
        })
      ).rejects.toThrow();

      // Neither the mark nor the stamp survived, and neither did the bump: all
      // three were inside the transaction the fault rolled back.
      expect(await readMarkRow("s1")).toBeNull();
      expect(await obligationsStoppedAt(sourceVersionId)).toBeNull();
      expect(await maintenanceRevision()).toBe(before);
    } finally {
      await admin.query(
        `DROP TRIGGER IF EXISTS mp14_mark_commit_fault ON structured_collection_marks`
      );
      await admin.query(`DROP FUNCTION IF EXISTS mp14_injected_commit_fault()`);
    }

    // The same mark, without the fault, stops obligations in the same commit.
    const outcome = await marks.markCollectionCandidate({
      context: context(["s1"]),
      identity: { payloadClass: "retired_unreferenced", payloadRef: "s1" },
      scopeBinding: SCOPE,
      sourceVersionId,
      eligibility,
    });
    if (outcome.refused) {
      throw new Error(`mark refused ${outcome.code}: ${outcome.detail}`);
    }
    expect(outcome.plan.stopsObligations).toBe(true);
    expect(await readMarkRow("s1")).not.toBeNull();
    expect(await obligationsStoppedAt(sourceVersionId)).not.toBeNull();
  });

  /** M17: reactivation cancels, resumes, and refuses a collected payload. */
  it("cancels the mark, resumes obligations, and refuses a collected payload", async () => {
    const sourceVersionId = await seedSourceVersion("s1", daysBeforeNow(200));
    await seedScope(["s1"]);
    const eligibility = await decide(candidate("s1", daysBeforeNow(200)), new Date());
    const marked = await marks.markCollectionCandidate({
      context: context(["s1"]),
      identity: { payloadClass: "retired_unreferenced", payloadRef: "s1" },
      scopeBinding: SCOPE,
      sourceVersionId,
      eligibility,
    });
    if (marked.refused) {
      throw new Error(`mark refused ${marked.code}: ${marked.detail}`);
    }
    expect(await obligationsStoppedAt(sourceVersionId)).not.toBeNull();

    const reactivate = await marks.reactivateCollectionCandidate({
      context: context(["s1"]),
      identity: { payloadClass: "retired_unreferenced", payloadRef: "s1" },
      scopeBinding: SCOPE,
      sourceVersionId,
      expectedLifecycleRevision: (await maintenanceRevision()).toString(),
    });
    if (reactivate.refused) {
      throw new Error(
        `reactivation refused ${reactivate.code}: ${reactivate.detail}`
      );
    }
    expect(reactivate.plan.resumedObligations).toBe(true);

    const cancelled = await readMarkRow("s1");
    expect(cancelled?.state).toBe("cancelled");
    expect(cancelled?.cancelled_reason).toBe("reactivated");
    expect(cancelled?.cancelled_at).not.toBeNull();
    // Resuming has to clear the stamp, or the next grant read would keep refusing
    // a payload that is back in service.
    expect(await obligationsStoppedAt(sourceVersionId)).toBeNull();

    // The caller supplies no fact about collection, so the refusal can only have
    // come from the store reading `payload_collected_at` itself.
    await admin.query(
      `UPDATE source_versions SET payload_collected_at = $2 WHERE source_version_id = $1`,
      [sourceVersionId, iso(new Date())]
    );
    const afterCollection = await marks.reactivateCollectionCandidate({
      context: context(["s1"]),
      identity: { payloadClass: "retired_unreferenced", payloadRef: "s1" },
      scopeBinding: SCOPE,
      sourceVersionId,
      expectedLifecycleRevision: (await maintenanceRevision()).toString(),
    });
    expect(afterCollection.refused).toBe(true);
    if (!afterCollection.refused) return;
    expect(afterCollection.code).toBe("input_stale");
    expect(afterCollection.detail).toContain("already collected");
  });

  /**
   * M18: `stale` and `deadlineReached` are independent. Each is observed alone —
   * a deadline reached against a revision that never moved, and a revision that
   * moved against a deadline that has not arrived.
   */
  it("reports stale and deadlineReached independently", async () => {
    const retiredLongAgo = daysBeforeNow(200);
    const retiredRecently = daysBeforeNow(91);

    // 200 days retired: the purge floor is 110 days in the past, so the deadline is
    // reached while the revision is still exactly the one this mark committed.
    const pastSource = await seedSourceVersion("s1", retiredLongAgo);
    // 91 days retired: the purge floor is 6 days ahead, so a later mark has a
    // deadline the database clock has not reached.
    const futureSource = await seedSourceVersion("s2", retiredRecently);
    await seedScope(["s1", "s2"]);

    const pastEligibility = await decide(
      candidate("s1", retiredLongAgo),
      new Date()
    );
    const pastMark = await marks.markCollectionCandidate({
      context: context(["s1", "s2"]),
      identity: { payloadClass: "retired_unreferenced", payloadRef: "s1" },
      scopeBinding: SCOPE,
      sourceVersionId: pastSource,
      eligibility: pastEligibility,
    });
    if (pastMark.refused) {
      throw new Error(`mark refused ${pastMark.code}: ${pastMark.detail}`);
    }

    const pastRead = await marks.readCollectionMark({
      context: context(["s1", "s2"]),
      identity: { payloadClass: "retired_unreferenced", payloadRef: "s1" },
      scopeBinding: SCOPE,
    });
    expect(recheckOf(pastRead).deadlineReached).toBe(true);
    expect(recheckOf(pastRead).stale).toBe(false);

    const futureEligibility = await decide(
      candidate("s2", retiredRecently),
      new Date()
    );
    const futureMark = await marks.markCollectionCandidate({
      context: context(["s1", "s2"]),
      identity: { payloadClass: "retired_unreferenced", payloadRef: "s2" },
      scopeBinding: SCOPE,
      sourceVersionId: futureSource,
      eligibility: futureEligibility,
    });
    if (futureMark.refused) {
      throw new Error(`mark refused ${futureMark.code}: ${futureMark.detail}`);
    }
    expect(
      Date.parse(futureMark.plan.mark.deadlineAt)
    ).toBeGreaterThan(Date.now());

    // Move the scope's maintenance counter without touching a mark, through the
    // same authority the store composes through.
    await authority.withAuthorizedScope(context(["s1", "s2"]), async (work) => {
      work.bumpRevisions({ read: false, maintenance: true });
    });

    const futureRead = await marks.readCollectionMark({
      context: context(["s1", "s2"]),
      identity: { payloadClass: "retired_unreferenced", payloadRef: "s2" },
      scopeBinding: SCOPE,
    });
    expect(recheckOf(futureRead).stale).toBe(true);
    expect(recheckOf(futureRead).deadlineReached).toBe(false);

    // Both facts again, together, for the past mark.
    const bothRead = await marks.readCollectionMark({
      context: context(["s1", "s2"]),
      identity: { payloadClass: "retired_unreferenced", payloadRef: "s1" },
      scopeBinding: SCOPE,
    });
    expect(recheckOf(bothRead).stale).toBe(true);
    expect(recheckOf(bothRead).deadlineReached).toBe(true);
  });

  it("records a stale cancellation, and refuses one aimed at a revision the recheck never saw", async () => {
    const retiredLongAgo = daysBeforeNow(200);
    const source = await seedSourceVersion("s1", retiredLongAgo);
    await seedScope(["s1"]);

    const eligibility = await decide(candidate("s1", retiredLongAgo), new Date());
    const marked = await marks.markCollectionCandidate({
      context: context(["s1"]),
      identity: { payloadClass: "retired_unreferenced", payloadRef: "s1" },
      scopeBinding: SCOPE,
      sourceVersionId: source,
      eligibility,
    });
    if (marked.refused) {
      throw new Error(`mark refused ${marked.code}: ${marked.detail}`);
    }

    // A cancellation naming a revision this recheck never observed must be
    // refused, and must leave the mark standing: a verdict computed against a
    // revision that has since moved is not evidence that this mark is stale.
    const wrongRevision = await marks.cancelStaleCollectionMark({
      context: context(["s1"]),
      scopeBinding: SCOPE,
      payloadClass: "retired_unreferenced",
      payloadRef: "s1",
      observedLifecycleRevision: "0",
    });
    expect(wrongRevision.refused).toBe(true);
    if (!wrongRevision.refused) return;
    expect(wrongRevision.code).toBe("input_stale");
    const afterRefusal = await marks.readCollectionMark({
      context: context(["s1"]),
      identity: { payloadClass: "retired_unreferenced", payloadRef: "s1" },
      scopeBinding: SCOPE,
    });
    expect(afterRefusal?.mark.state).toBe("marked");

    // The real one, against the revision the recheck actually observed.
    const read = await marks.readCollectionMark({
      context: context(["s1"]),
      identity: { payloadClass: "retired_unreferenced", payloadRef: "s1" },
      scopeBinding: SCOPE,
    });
    const observed = String(
      (await authority.withAuthorizedScope(context(["s1"]), async (work) =>
        (await work.readMaintenanceInputs([])).maintenanceRevision
      )) ?? ""
    );
    const cancelled = await marks.cancelStaleCollectionMark({
      context: context(["s1"]),
      scopeBinding: SCOPE,
      payloadClass: "retired_unreferenced",
      payloadRef: "s1",
      observedLifecycleRevision: observed,
    });
    expect(cancelled.refused).toBe(false);

    const persisted = await marks.readCollectionMark({
      context: context(["s1"]),
      identity: { payloadClass: "retired_unreferenced", payloadRef: "s1" },
      scopeBinding: SCOPE,
    });
    expect(persisted?.mark.state).toBe("cancelled");
    // The reason is the whole point: MP15 must be able to tell a recheck having
    // run from a caller having deliberately undone the mark.
    expect(persisted?.mark.cancelledReason).toBe("lifecycle_revision_changed");
    expect(persisted?.mark.cancelledAt).not.toBeNull();
    expect(read?.mark.cancelledReason).toBeNull();
  });
});

/** The recheck verdict of a read that found a marked row, or a named failure. */
function recheckOf(read: CollectionMarkReadOutcome): {
  readonly stale: boolean;
  readonly deadlineReached: boolean;
} {
  if (!read.found) throw new Error("expected a persisted mark to read");
  if ("recheckRefusal" in read) {
    throw new Error(
      `recheck refused ${read.recheckRefusal.code}: ${read.recheckRefusal.detail}`
    );
  }
  return read.recheck;
}
