/**
 * index_jobs + source_documents content identity against real Postgres
 * (corpus-index-job T2).
 *
 * The memory backend proves the semantics; this proves the DURABLE path:
 * a real pool round-trips the ledger, the CHECK / UNIQUE constraints reject
 * at the storage boundary — including the partial unique index that keeps one
 * source single-active even against two DIFFERENT submits racing on two
 * connections —, the submit-identity write collapses a re-submit onto the
 * existing row, and a re-push OVERWRITES the content_identity column. Loud-skips when Postgres/pgvector is unavailable.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import pg from "pg";

import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import {
  INDEX_JOB_STATUS,
  SOURCE_DOC_STATUS,
  type IndexJobInsertOutcome,
  type IndexJobRecord,
} from "../../src/core/types.js";
import { computeContentIdentity } from "../../src/tools/ingest.js";
import { createPgIntegrationHarness } from "./pg-test-harness.js";

const DIM = 8;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;

function jobFixture(overrides: Partial<IndexJobRecord> = {}): IndexJobRecord {
  const jobId = overrides.job_id ?? "job-1";
  return {
    job_id: jobId,
    source_ref: overrides.source_ref ?? "docs/a.md",
    content_identity: overrides.content_identity ?? `identity-${jobId}`,
    status: overrides.status ?? INDEX_JOB_STATUS.IN_PROGRESS,
    created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
    started_at: overrides.started_at ?? "2026-01-01T00:00:00.000Z",
    finished_at: overrides.finished_at ?? null,
    failure_code: overrides.failure_code ?? null,
  };
}

/** Assert the accepted arm (`record`/`inserted`) and hand it back narrowed. */
function accepted(outcome: IndexJobInsertOutcome): {
  record: IndexJobRecord;
  inserted: boolean;
} {
  if ("conflict" in outcome) {
    throw new Error(
      `expected an accepted outcome, got conflict with ${outcome.conflict.job_id}`
    );
  }
  return outcome;
}

/** Assert the conflict arm and return the row that owns the source. */
function conflicted(outcome: IndexJobInsertOutcome): IndexJobRecord {
  if (!("conflict" in outcome)) {
    throw new Error(
      `expected a conflict outcome, got ${outcome.inserted ? "insert" : "join"} of ${outcome.record.job_id}`
    );
  }
  return outcome.conflict;
}

const pgHarness = await createPgIntegrationHarness({
  label: "index-jobs-pg",
  testPath: "tests/integration/index-jobs-pg.test.ts",
  expectedCommand: "npx vitest run tests/integration/index-jobs-pg.test.ts",
  schemaPrefix: "index_jobs_pg",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: true,
});
const {
  schemaConnectionString: SCHEMA_URL,
  createClient,
  resetSchema,
  dropSchema,
  describePg,
} = pgHarness;

describePg("index_jobs durable ledger (corpus-index-job T2)", () => {
  let admin: pg.Client | undefined;
  let backend: PgvectorBackend | undefined;

  beforeAll(async () => {
    admin = createClient(SCHEMA_URL);
    await admin.connect();
    await resetSchema(admin);
    backend = new PgvectorBackend(SCHEMA_URL, DIM, { annMaxDimensions: 2000 });
    await backend.initialize();
  });

  afterAll(async () => {
    if (backend) await backend.close();
    if (admin) {
      await dropSchema(admin);
      await admin.end();
    }
  });

  it("round-trips a job through a real pool with ISO timestamp strings", async () => {
    const { record: written, inserted } = accepted(
      await backend!.insertJobOrJoin(jobFixture())
    );
    expect(inserted).toBe(true);
    expect(written.status).toBe(INDEX_JOB_STATUS.IN_PROGRESS);

    const read = await backend!.getJob("job-1");
    expect(read).not.toBeNull();
    expect(read!.job_id).toBe("job-1");
    expect(read!.created_at).toMatch(ISO_RE);
    expect(read!.started_at).toMatch(ISO_RE);
    expect(read!.finished_at).toBeNull();
  });

  it("ON CONFLICT join returns the EXISTING row, not the re-submit payload", async () => {
    await backend!.insertJobOrJoin(
      jobFixture({
        job_id: "job-join",
        source_ref: "docs/join.md",
        status: INDEX_JOB_STATUS.IN_PROGRESS,
        started_at: "2026-01-01T00:00:00.000Z",
      })
    );
    const { record: joined, inserted } = accepted(
      await backend!.insertJobOrJoin(
        jobFixture({
          job_id: "job-join",
          source_ref: "docs/join.md",
          status: INDEX_JOB_STATUS.READY,
          started_at: "2026-02-02T00:00:00.000Z",
        })
      )
    );
    // The running job wins — a re-submit never advances it to ready, and it
    // must not report that it queued anything either.
    expect(inserted).toBe(false);
    expect(joined.status).toBe(INDEX_JOB_STATUS.IN_PROGRESS);
    expect(joined.started_at).toBe("2026-01-01T00:00:00.000Z");

    const count = await admin!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM index_jobs WHERE job_id = 'job-join'`
    );
    expect(count.rows[0]!.n).toBe("1");
  });

  it("two concurrent submits of one pair: one inserts, the loser joins", async () => {
    const pair = {
      job_id: "job-race",
      source_ref: "docs/race.md",
      content_identity: "identity-race",
    };
    const [first, second] = (
      await Promise.all([
        backend!.insertJobOrJoin(
          jobFixture({ ...pair, created_at: "2026-01-01T00:00:00.000Z" })
        ),
        backend!.insertJobOrJoin(
          jobFixture({ ...pair, created_at: "2026-03-03T00:00:00.000Z" })
        ),
      ])
    ).map(accepted);

    // Which of the two won the race is not decided here, so the assertion is
    // on the shape of the outcome: exactly one row was created, and the other
    // caller got the FIRST row's timestamps rather than its own.
    expect([first.inserted, second.inserted].sort()).toEqual([false, true]);
    const creator = first.inserted ? first : second;
    const joiner = first.inserted ? second : first;
    expect(creator.record.created_at).toMatch(ISO_RE);
    expect(joiner.record.created_at).toBe(creator.record.created_at);

    const rows = await admin!.query<{ n: string; created_at: string }>(
      `SELECT count(*)::text AS n, min(created_at)::text AS created_at
         FROM index_jobs WHERE job_id = 'job-race'`
    );
    expect(rows.rows[0]!.n).toBe("1");
  });

  it("the ledger carries the one-active-per-source partial unique index", async () => {
    const res = await admin!.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
         WHERE schemaname = current_schema()
           AND indexname = 'index_jobs_one_active_per_source_idx'`
    );
    expect(res.rows).toHaveLength(1);
    const def = res.rows[0]!.indexdef;
    expect(def).toMatch(/^CREATE UNIQUE INDEX/i);
    expect(def).toMatch(/\(source_ref\)/);
    // The predicate is the whole point: only `in_progress` rows compete.
    expect(def).toMatch(/WHERE \(status = 'in_progress'::text\)/);
  });

  it("a raw second in_progress row for one source is rejected by the index", async () => {
    await admin!.query(
      `INSERT INTO index_jobs (job_id, source_ref, content_identity, status)
         VALUES ('raw-active-1', 'docs/raw.md', 'id-1', 'in_progress')`
    );
    await expect(
      admin!.query(
        `INSERT INTO index_jobs (job_id, source_ref, content_identity, status)
           VALUES ('raw-active-2', 'docs/raw.md', 'id-2', 'in_progress')`
      )
    ).rejects.toThrow(/index_jobs_one_active_per_source_idx|duplicate key/);
    // Terminal rows and other sources stay unrestricted — the predicate is
    // partial, not a blanket unique.
    await admin!.query(
      `INSERT INTO index_jobs (job_id, source_ref, content_identity, status)
         VALUES ('raw-ready', 'docs/raw.md', 'id-3', 'ready'),
                ('raw-other', 'docs/raw-other.md', 'id-4', 'in_progress')`
    );
    await admin!.query(
      `UPDATE index_jobs SET status = 'ready' WHERE job_id = 'raw-active-1'`
    );
    await admin!.query(
      `INSERT INTO index_jobs (job_id, source_ref, content_identity, status)
         VALUES ('raw-active-3', 'docs/raw.md', 'id-5', 'in_progress')`
    );
    expect((await backend!.getJob("raw-active-3"))?.status).toBe(
      INDEX_JOB_STATUS.IN_PROGRESS
    );
  });

  it("insertJobOrJoin reports a conflict outcome naming the owning row", async () => {
    await backend!.insertJobOrJoin(
      jobFixture({ job_id: "conf-active", source_ref: "docs/conflict.md" })
    );
    const loser = conflicted(
      await backend!.insertJobOrJoin(
        jobFixture({
          job_id: "conf-rival",
          source_ref: "docs/conflict.md",
          content_identity: "identity-rival",
        })
      )
    );
    expect(loser.job_id).toBe("conf-active");
    // The rejected write left nothing behind — the constraint is the refusal.
    expect(await backend!.getJob("conf-rival")).toBeNull();
  });

  it("two connections submitting conflicting versions keep the source single-active", async () => {
    // Different job_ids for one source: neither connection's ON CONFLICT
    // (job_id) arbiter can absorb the other, and no pre-check read sees an
    // uncommitted rival — only the partial unique index settles this race.
    const rival = new PgvectorBackend(SCHEMA_URL, DIM, {
      annMaxDimensions: 2000,
    });
    await rival.initialize();
    try {
      const outcomes = await Promise.all([
        backend!.insertJobOrJoin(
          jobFixture({
            job_id: "two-conn-a",
            source_ref: "docs/two-conn.md",
            content_identity: "identity-a",
          })
        ),
        rival.insertJobOrJoin(
          jobFixture({
            job_id: "two-conn-b",
            source_ref: "docs/two-conn.md",
            content_identity: "identity-b",
          })
        ),
      ]);
      const fresh = outcomes.filter(
        (o) => "inserted" in o && o.inserted === true
      );
      const conflicts = outcomes.filter((o) => "conflict" in o);
      expect(fresh).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      // The loser's conflict names the very row the winner persisted.
      const winnerId = (fresh[0] as { record: IndexJobRecord }).record.job_id;
      expect(
        (conflicts[0] as { conflict: IndexJobRecord }).conflict.job_id
      ).toBe(winnerId);

      const rows = await admin!.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM index_jobs
          WHERE source_ref = 'docs/two-conn.md'
            AND status = '${INDEX_JOB_STATUS.IN_PROGRESS}'`
      );
      expect(rows.rows[0]!.n).toBe("1");
      const loserId = winnerId === "two-conn-a" ? "two-conn-b" : "two-conn-a";
      expect(await backend!.getJob(loserId)).toBeNull();
    } finally {
      await rival.close();
    }
  });

  it("getActiveJobForSource returns the single in_progress row", async () => {
    await backend!.insertJobOrJoin(
      jobFixture({
        job_id: "active-1",
        source_ref: "docs/active.md",
        status: INDEX_JOB_STATUS.IN_PROGRESS,
      })
    );
    await backend!.insertJobOrJoin(
      jobFixture({
        job_id: "done-1",
        source_ref: "docs/active.md",
        status: INDEX_JOB_STATUS.READY,
      })
    );
    const active = await backend!.getActiveJobForSource("docs/active.md");
    expect(active?.job_id).toBe("active-1");
    expect(await backend!.getActiveJobForSource("docs/none.md")).toBeNull();
  });

  it("supersedeReadyJobs demotes every ready row of the source only", async () => {
    await backend!.insertJobOrJoin(
      jobFixture({
        job_id: "sup-a1",
        source_ref: "docs/sup.md",
        status: INDEX_JOB_STATUS.READY,
      })
    );
    await backend!.insertJobOrJoin(
      jobFixture({
        job_id: "sup-a2",
        source_ref: "docs/sup.md",
        status: INDEX_JOB_STATUS.READY,
      })
    );
    await backend!.insertJobOrJoin(
      jobFixture({
        job_id: "sup-new",
        source_ref: "docs/sup.md",
        status: INDEX_JOB_STATUS.IN_PROGRESS,
      })
    );
    await backend!.insertJobOrJoin(
      jobFixture({
        job_id: "sup-b",
        source_ref: "docs/other.md",
        status: INDEX_JOB_STATUS.READY,
      })
    );

    const demoted = await backend!.supersedeReadyJobs("docs/sup.md");
    expect(demoted).toBe(2);
    expect((await backend!.getJob("sup-a1"))?.status).toBe(
      INDEX_JOB_STATUS.STALE
    );
    expect((await backend!.getJob("sup-a2"))?.status).toBe(
      INDEX_JOB_STATUS.STALE
    );
    // The incoming job is in_progress, so the `ready` predicate never selects
    // it — there is no id exception to spare it with.
    expect((await backend!.getJob("sup-new"))?.status).toBe(
      INDEX_JOB_STATUS.IN_PROGRESS
    );
    expect((await backend!.getJob("sup-b"))?.status).toBe(
      INDEX_JOB_STATUS.READY
    );
  });

  it("a ready row really is demoted to stale in the ledger", async () => {
    await backend!.insertJobOrJoin(
      jobFixture({
        job_id: "lone-ready",
        source_ref: "docs/lone.md",
        status: INDEX_JOB_STATUS.READY,
      })
    );

    // Count alone would pass on a no-op UPDATE; the flipped row is the
    // observable supersede outcome the poll tool reports.
    expect(await backend!.supersedeReadyJobs("docs/lone.md")).toBe(1);
    expect((await backend!.getJob("lone-ready"))?.status).toBe(
      INDEX_JOB_STATUS.STALE
    );

    const persisted = await admin!.query<{ status: string }>(
      `SELECT status FROM index_jobs WHERE job_id = 'lone-ready'`
    );
    expect(persisted.rows[0]!.status).toBe(INDEX_JOB_STATUS.STALE);
  });

  it("superseding a source with no ready row demotes nothing", async () => {
    await backend!.insertJobOrJoin(
      jobFixture({
        job_id: "failed-only",
        source_ref: "docs/failed.md",
        status: INDEX_JOB_STATUS.FAILED,
      })
    );
    expect(await backend!.supersedeReadyJobs("docs/failed.md")).toBe(0);
    expect(await backend!.supersedeReadyJobs("docs/unseen.md")).toBe(0);
    expect((await backend!.getJob("failed-only"))?.status).toBe(
      INDEX_JOB_STATUS.FAILED
    );
  });

  it("the status CHECK rejects a fifth state word", async () => {
    await expect(
      admin!.query(
        `INSERT INTO index_jobs (job_id, source_ref, content_identity, status)
           VALUES ('bad-status', 'docs/bad.md', 'id', 'queued')`
      )
    ).rejects.toThrow(/index_jobs_status_check/);
  });

  it("source_documents carries the UNIQUE (source_ref, content_identity) pair", async () => {
    const res = await admin!.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
         WHERE schemaname = current_schema()
           AND tablename = 'source_documents'`
    );
    expect(
      res.rows.some(
        (row) =>
          /^CREATE UNIQUE INDEX/i.test(row.indexdef) &&
          /\(source_ref, content_identity\)/.test(row.indexdef)
      ),
      "the (source_ref, content_identity) unique index is absent"
    ).toBe(true);
  });

  it("upsertSourceDoc persists the document identity and a re-push overwrites it", async () => {
    const sourceRef = "docs/identity.md";
    const body = "the first body";
    await backend!.upsertSourceDoc({
      id: "00000000-0000-4000-8000-0000000000a1",
      source_ref: sourceRef,
      title: null,
      content: body,
      created_at: "2026-01-01T00:00:00.000Z",
      status: SOURCE_DOC_STATUS.IN_PROGRESS,
      failure_code: null,
      content_identity: computeContentIdentity(body),
    });
    const read = (params: unknown[]) =>
      admin!.query<{ content_identity: string | null }>(
        `SELECT content_identity FROM source_documents WHERE source_ref = $1`,
        params
      );
    expect((await read([sourceRef])).rows[0]!.content_identity).toBe(
      computeContentIdentity(body)
    );

    const changed = "a second, different body";
    await backend!.upsertSourceDoc({
      id: "00000000-0000-4000-8000-0000000000a1",
      source_ref: sourceRef,
      title: null,
      content: changed,
      created_at: "2026-01-01T00:00:00.000Z",
      content_identity: computeContentIdentity(changed),
    });
    const overwritten = await read([sourceRef]);
    expect(overwritten.rows[0]!.content_identity).toBe(
      computeContentIdentity(changed)
    );
    const rows = await admin!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM source_documents WHERE source_ref = $1`,
      [sourceRef]
    );
    expect(rows.rows[0]!.n).toBe("1");
  });

  it("a status-less write (the ingest shape) updates the identity, never nulls it", async () => {
    const sourceRef = "docs/ingest-shape.md";
    const pushed = "body as push wrote it";
    await backend!.upsertSourceDoc({
      id: "00000000-0000-4000-8000-0000000000a2",
      source_ref: sourceRef,
      title: null,
      content: pushed,
      created_at: "2026-01-01T00:00:00.000Z",
      status: SOURCE_DOC_STATUS.READY,
      failure_code: null,
      content_identity: computeContentIdentity(pushed),
    });

    // The ingest write path declares no status on purpose (a re-ingest must
    // not downgrade 就绪), so it is the arm that used to leave the identity
    // column out of the record entirely and blank the pushed value.
    const ingested = "body as ingest rewrote it";
    await backend!.upsertSourceDoc({
      id: "00000000-0000-4000-8000-0000000000a2",
      source_ref: sourceRef,
      title: null,
      content: ingested,
      created_at: "2026-01-02T00:00:00.000Z",
      content_identity: computeContentIdentity(ingested),
    });

    const row = await admin!.query<{
      content_identity: string | null;
      status: string;
    }>(
      `SELECT content_identity, status FROM source_documents WHERE source_ref = $1`,
      [sourceRef]
    );
    expect(row.rows[0]!.content_identity).toBe(
      computeContentIdentity(ingested)
    );
    expect(row.rows[0]!.status).toBe(SOURCE_DOC_STATUS.READY);
  });
});
