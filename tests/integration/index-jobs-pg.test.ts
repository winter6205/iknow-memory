/**
 * index_jobs + source_documents content identity against real Postgres
 * (specs/corpus-index-job-orchestration.md, Decision 1 + Decision 2).
 *
 * The memory backend proves the semantics; this proves the DURABLE path:
 * a real pool round-trips the ledger, the CHECK / UNIQUE constraints reject
 * at the storage boundary — including the partial unique index that keeps one
 * source single-active even against two DIFFERENT submits racing on two
 * connections —, the submit-identity write collapses a re-submit onto the
 * existing row (including the `submit_index_job` handler joining a terminal
 * `failed` row), and a re-push OVERWRITES the content_identity column.
 * Loud-skips when Postgres/pgvector is unavailable.
 *
 * The second suite below is the worker side:
 * `claimNextJob` and `publishJobOutcome` against real Postgres, including the
 * two-claimant proofs no single-threaded scan can make — a queue never hands
 * one row to two workers, and a lost lease never publishes an outcome.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import pg from "pg";

import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { buildIndexJobSeams } from "../../src/index.js";
import { createSubmitIndexJobHandler } from "../../src/tools/index-job.js";
import type { ToolResult } from "../../src/tools/registry.js";
import {
  INDEX_JOB_STATUS,
  SOURCE_DOC_STATUS,
  type IndexJobInsertOutcome,
  type IndexJobRecord,
} from "../../src/core/types.js";
import {
  computeChunkId,
  computeContentIdentity,
} from "../../src/tools/ingest.js";
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

/**
 * The JSON body a tool handler answered, `isError` ruled out first: a pin on
 * the wire shape is worthless if the call actually failed, and the error body
 * names the typed fault the pin was supposed to see.
 */
function toolBody(result: ToolResult): Record<string, unknown> {
  const text = (result.content ?? [])
    .map((block) => ("text" in block ? (block.text ?? "") : ""))
    .join("");
  if (result.isError === true) {
    throw new Error(`expected a success body, got ${JSON.stringify(text)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
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

/**
 * A second isolated schema for the worker side. `claimNextJob` has no source
 * filter — it walks the whole ledger — so sharing the submit suite's schema
 * would let that suite's queued rows join this queue and turn the FIFO and
 * concurrency assertions into order-dependent ones.
 */
const claimHarness = await createPgIntegrationHarness({
  label: "index-jobs-claim-pg",
  testPath: "tests/integration/index-jobs-pg.test.ts",
  expectedCommand: "npx vitest run tests/integration/index-jobs-pg.test.ts",
  schemaPrefix: "index_jobs_claim",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: true,
});
const {
  schemaConnectionString: CLAIM_SCHEMA_URL,
  createClient: createClaimClient,
  resetSchema: resetClaimSchema,
  dropSchema: dropClaimSchema,
  describePg: describeClaimPg,
} = claimHarness;

/** The instant the primary worker claims with. */
const CLAIM_AT = "2026-04-04T00:00:00.000Z";
/** A rival's distinct claim instant, so a persisted stamp names its writer. */
const RIVAL_CLAIM_AT = "2026-04-06T00:00:00.000Z";
/** Anything still running from before this instant counts as a dead lease. */
const STALLED_BEFORE = "2026-03-01T00:00:00.000Z";
const FINISH_AT = "2026-05-05T00:00:00.000Z";

/**
 * Persist one queued job for a claim test.
 *
 * `started_at` is set AFTER the fixture: `jobFixture` defaults it with `??`,
 * which replaces an explicit null with a running start — the exact row shape
 * the queued arm must not see.
 */
async function seedQueuedJob(
  store: PgvectorBackend,
  jobId: string,
  sourceRef: string,
  createdAt: string
): Promise<void> {
  accepted(
    await store.insertJobOrJoin({
      ...jobFixture({
        job_id: jobId,
        source_ref: sourceRef,
        created_at: createdAt,
      }),
      started_at: null,
    })
  );
}

/** Rows of one job whose persisted `started_at` equals this instant. */
async function countStartedAt(
  admin: pg.Client,
  jobId: string,
  startedAt: string
): Promise<number> {
  const rows = await admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM index_jobs
      WHERE job_id = $1 AND started_at = $2::timestamptz`,
    [jobId, startedAt]
  );
  return Number(rows.rows[0]!.n);
}

describePg("index_jobs durable ledger over real Postgres", () => {
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

  it("submit joins a failed job: the derived pair keeps its terminal row and re-arms nothing", async () => {
    // WHY this is pinned at the real ledger: `job_id` is derived from
    // `(source_ref, content_identity)`, so a `failed` row is what EVERY later
    // submit of that content version resolves to — a transient dependency fault
    // (a dropped embedding request is the measured shape) therefore strands
    // exactly one content version until a new one is pushed. That is the
    // current contract, so it is recorded as it lands rather than as a
    // re-arm nobody built: a re-arm would read back here as a cleared
    // `finished_at`, a reset `status`, or a second row for the pair.
    const sourceRef = "docs/failed-join.md";
    const body = "a body whose only job failed on a transient dependency fault";
    const identity = computeContentIdentity(body);
    const jobId = computeChunkId(sourceRef, identity);
    const seams = buildIndexJobSeams(backend!);
    const submit = createSubmitIndexJobHandler({
      jobStore: seams.indexJobs,
      readPort: seams.indexJobReadPort,
    });
    await backend!.upsertSourceDoc({
      id: "00000000-0000-4000-8000-0000000000a3",
      source_ref: sourceRef,
      title: null,
      content: body,
      created_at: "2026-01-01T00:00:00.000Z",
      status: SOURCE_DOC_STATUS.READY,
      failure_code: null,
      content_identity: identity,
    });

    const queued = toolBody(
      await submit({ source_ref: sourceRef, content_identity: identity })
    );
    expect(queued).toEqual({
      job_id: jobId,
      source_ref: sourceRef,
      content_identity: identity,
      status: INDEX_JOB_STATUS.IN_PROGRESS,
      started_at: null,
      reused: false,
    });
    // The failure is published the way the worker publishes it — through the
    // store's own lease-guarded terminal write, not an UPDATE behind the tool's
    // back — so the row this submit joins is a real terminal row.
    expect(
      await backend!.publishJobOutcome(jobId, {
        status: INDEX_JOB_STATUS.FAILED,
        failureCode: "embedding_failure",
        finishedAt: FINISH_AT,
        claimedStartedAt: null,
      })
    ).toMatchObject({ status: INDEX_JOB_STATUS.FAILED });

    expect(
      toolBody(
        await submit({ source_ref: sourceRef, content_identity: identity })
      )
    ).toEqual({
      job_id: jobId,
      source_ref: sourceRef,
      content_identity: identity,
      status: INDEX_JOB_STATUS.FAILED,
      started_at: null,
      reused: true,
    });

    const terminal = await admin!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM index_jobs
         WHERE job_id = $1 AND status = 'failed' AND started_at IS NULL
           AND finished_at = $2::timestamptz
           AND failure_code = 'embedding_failure'`,
      [jobId, FINISH_AT]
    );
    expect(terminal.rows[0]!.n).toBe("1");
    const rows = await admin!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM index_jobs WHERE source_ref = $1`,
      [sourceRef]
    );
    expect(rows.rows[0]!.n).toBe("1");
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

describeClaimPg("index_jobs claim + publish over real Postgres", () => {
  let admin: pg.Client | undefined;
  let worker: PgvectorBackend | undefined;

  beforeAll(async () => {
    admin = createClaimClient(CLAIM_SCHEMA_URL);
    await admin.connect();
    await resetClaimSchema(admin);
    worker = new PgvectorBackend(CLAIM_SCHEMA_URL, DIM, {
      annMaxDimensions: 2000,
    });
    await worker.initialize();
  });

  afterAll(async () => {
    if (worker) await worker.close();
    if (admin) {
      await dropClaimSchema(admin);
      await admin.end();
    }
  });

  // Each case starts from a queue with nothing claimable: a running or queued
  // row left by the previous case would be the oldest thing in the ledger and
  // win this case's claim, making the FIFO assertions order-dependent.
  beforeEach(async () => {
    await admin!.query(
      `UPDATE index_jobs
        SET status = 'stale', finished_at = created_at
      WHERE status = 'in_progress'`
    );
  });

  /** A second pool — the concurrency cases need two independent transactions. */
  const withRival = async (
    run: (rival: PgvectorBackend) => Promise<void>
  ): Promise<void> => {
    const rival = new PgvectorBackend(CLAIM_SCHEMA_URL, DIM, {
      annMaxDimensions: 2000,
    });
    await rival.initialize();
    try {
      await run(rival);
    } finally {
      await rival.close();
    }
  };

  /** Persist one running row the given claim instant started. */
  const startRunning = async (
    jobId: string,
    sourceRef: string,
    createdAt: string,
    startedAt: string
  ): Promise<void> => {
    await seedQueuedJob(worker!, jobId, sourceRef, createdAt);
    const claimed = await worker!.claimNextJob({ startedAt });
    expect(claimed?.job_id).toBe(jobId);
  };

  it("claims the oldest queued row and the stamp lands in the ledger", async () => {
    await seedQueuedJob(
      worker!,
      "clq-old",
      "docs/clq-a.md",
      "2026-01-01T00:00:00.000Z"
    );
    await seedQueuedJob(
      worker!,
      "clq-new",
      "docs/clq-b.md",
      "2026-02-02T00:00:00.000Z"
    );

    const claimed = await worker!.claimNextJob({ startedAt: CLAIM_AT });
    expect(claimed?.job_id).toBe("clq-old");
    expect(claimed?.started_at).toBe(CLAIM_AT);
    // Decision 2: claiming is a started_at write, never a fifth status word.
    expect(claimed?.status).toBe(INDEX_JOB_STATUS.IN_PROGRESS);
    expect(claimed?.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(claimed?.created_at).toMatch(ISO_RE);

    const persisted = await admin!.query<{ status: string }>(
      `SELECT status FROM index_jobs
      WHERE job_id = 'clq-old' AND started_at = $1::timestamptz`,
      [CLAIM_AT]
    );
    expect(persisted.rows[0]!.status).toBe(INDEX_JOB_STATUS.IN_PROGRESS);
    // Exactly one row moved for this job, and the follower is untouched: a
    // claim takes one row, not the queue.
    expect(await countStartedAt(admin!, "clq-old", CLAIM_AT)).toBe(1);
    expect((await worker!.getJob("clq-new"))?.started_at).toBeNull();
  });

  it("a second claim takes the follower and leaves the running row alone", async () => {
    await seedQueuedJob(
      worker!,
      "sec-old",
      "docs/sec-a.md",
      "2026-01-01T00:00:00.000Z"
    );
    await seedQueuedJob(
      worker!,
      "sec-new",
      "docs/sec-b.md",
      "2026-02-02T00:00:00.000Z"
    );

    const first = await worker!.claimNextJob({ startedAt: CLAIM_AT });
    const second = await worker!.claimNextJob({ startedAt: RIVAL_CLAIM_AT });
    expect(first?.job_id).toBe("sec-old");
    expect(second?.job_id).toBe("sec-new");
    expect((await worker!.getJob("sec-old"))?.started_at).toBe(CLAIM_AT);
  });

  it("answers null when the ledger holds no claimable row", async () => {
    // The table is not empty — the beforeEach left every earlier row `stale` —
    // so this also pins that a terminal row is never claimable, even one whose
    // started_at is NULL, and even with the stalled arm wide open.
    await admin!.query(
      `INSERT INTO index_jobs (job_id, source_ref, content_identity, status, started_at)
     VALUES ('term-q', 'docs/term.md', 'id-term', 'stale', NULL)`
    );
    expect(
      await worker!.claimNextJob({
        startedAt: CLAIM_AT,
        stalledBefore: "2099-01-01T00:00:00.000Z",
      })
    ).toBeNull();
  });

  it("a running row is not claimable without stalledBefore", async () => {
    await startRunning(
      "run-a",
      "docs/run-a.md",
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z"
    );

    expect(await worker!.claimNextJob({ startedAt: CLAIM_AT })).toBeNull();
    expect((await worker!.getJob("run-a"))?.started_at).toBe(
      "2026-02-01T00:00:00.000Z"
    );
  });

  it("re-claims a dead worker's row and re-stamps its start", async () => {
    await startRunning(
      "dead",
      "docs/dead.md",
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z"
    );

    const reclaimed = await worker!.claimNextJob({
      startedAt: CLAIM_AT,
      stalledBefore: STALLED_BEFORE,
    });
    expect(reclaimed?.job_id).toBe("dead");
    expect(reclaimed?.started_at).toBe(CLAIM_AT);
    // created_at still names the queue time; only the attempt moved.
    expect(reclaimed?.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(reclaimed?.status).toBe(INDEX_JOB_STATUS.IN_PROGRESS);
    const rows = await admin!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM index_jobs WHERE job_id = 'dead'`
    );
    expect(rows.rows[0]!.n).toBe("1");
    expect(await countStartedAt(admin!, "dead", CLAIM_AT)).toBe(1);
  });

  it("a row started exactly at stalledBefore is not stalled yet", async () => {
    await startRunning(
      "edge",
      "docs/edge.md",
      "2026-01-01T00:00:00.000Z",
      STALLED_BEFORE
    );

    expect(
      await worker!.claimNextJob({
        startedAt: CLAIM_AT,
        stalledBefore: STALLED_BEFORE,
      })
    ).toBeNull();
    expect((await worker!.getJob("edge"))?.started_at).toBe(STALLED_BEFORE);
  });

  it("two concurrent claimants get two different jobs", async () => {
    await seedQueuedJob(
      worker!,
      "race-a",
      "docs/race-a.md",
      "2026-01-01T00:00:00.000Z"
    );
    await seedQueuedJob(
      worker!,
      "race-b",
      "docs/race-b.md",
      "2026-02-02T00:00:00.000Z"
    );

    await withRival(async (rival) => {
      const [mine, theirs] = await Promise.all([
        worker!.claimNextJob({ startedAt: CLAIM_AT }),
        rival.claimNextJob({ startedAt: RIVAL_CLAIM_AT }),
      ]);
      expect(mine).not.toBeNull();
      expect(theirs).not.toBeNull();
      // The whole design rests on this: FOR UPDATE SKIP LOCKED made the rival
      // step over the row this claim held instead of doubling up on it.
      expect(mine!.job_id).not.toBe(theirs!.job_id);

      const running = await admin!.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM index_jobs
        WHERE job_id IN ('race-a', 'race-b') AND started_at IS NOT NULL`
      );
      expect(running.rows[0]!.n).toBe("2");
    });
  });

  it("a claim steps over the row another transaction is holding", async () => {
    await seedQueuedJob(
      worker!,
      "hold-head",
      "docs/hold-a.md",
      "2026-01-01T00:00:00.000Z"
    );
    await seedQueuedJob(
      worker!,
      "hold-next",
      "docs/hold-b.md",
      "2026-02-02T00:00:00.000Z"
    );
    // Two explicit transactions make the overlap deterministic. An autocommit
    // pair can serialize and still pass, which would prove nothing about the
    // row lock; here the holder has the oldest row locked and uncommitted
    // while the claim runs on a separate connection.
    const holder = createClaimClient(CLAIM_SCHEMA_URL);
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT job_id FROM index_jobs
        WHERE job_id = 'hold-head'
        FOR UPDATE SKIP LOCKED`
      );

      const claimed = await worker!.claimNextJob({ startedAt: CLAIM_AT });
      expect(claimed?.job_id).toBe("hold-next");
      expect((await worker!.getJob("hold-head"))?.started_at).toBeNull();
      await holder.query("ROLLBACK");
    } finally {
      await holder.end();
    }
  });

  it("a concurrent double claim of one queued job leaves exactly one winner", async () => {
    await seedQueuedJob(
      worker!,
      "single",
      "docs/single.md",
      "2026-01-01T00:00:00.000Z"
    );

    await withRival(async (rival) => {
      const claims = await Promise.all([
        worker!.claimNextJob({ startedAt: CLAIM_AT }),
        rival.claimNextJob({ startedAt: RIVAL_CLAIM_AT }),
      ]);
      const winners = claims.filter(
        (claim): claim is IndexJobRecord => claim !== null
      );
      expect(winners).toHaveLength(1);
      expect(winners[0]!.job_id).toBe("single");

      // The loser wrote nothing: the row carries the winner's instant alone.
      const stamped = await admin!.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM index_jobs
        WHERE job_id = 'single' AND started_at = $1::timestamptz`,
        [winners[0]!.started_at]
      );
      expect(stamped.rows[0]!.n).toBe("1");
    });
  });

  it("publish ready stamps finished_at and keeps the claim's started_at", async () => {
    await seedQueuedJob(
      worker!,
      "pub-ready",
      "docs/pub-a.md",
      "2026-01-01T00:00:00.000Z"
    );
    const claimed = await worker!.claimNextJob({ startedAt: CLAIM_AT });
    expect(claimed).not.toBeNull();

    const published = await worker!.publishJobOutcome(claimed!.job_id, {
      status: INDEX_JOB_STATUS.READY,
      finishedAt: FINISH_AT,
      claimedStartedAt: CLAIM_AT,
    });
    expect(published?.status).toBe(INDEX_JOB_STATUS.READY);
    expect(published?.finished_at).toBe(FINISH_AT);
    expect(published?.failure_code).toBeNull();
    expect(published?.started_at).toBe(CLAIM_AT);

    const persisted = await admin!.query<{ status: string }>(
      `SELECT status FROM index_jobs
      WHERE job_id = 'pub-ready' AND finished_at = $1::timestamptz`,
      [FINISH_AT]
    );
    expect(persisted.rows[0]!.status).toBe(INDEX_JOB_STATUS.READY);
  });

  it("publish failed carries the typed failure_code into the ledger", async () => {
    await seedQueuedJob(
      worker!,
      "pub-failed",
      "docs/pub-b.md",
      "2026-01-01T00:00:00.000Z"
    );
    const claimed = await worker!.claimNextJob({ startedAt: CLAIM_AT });
    expect(claimed).not.toBeNull();

    const published = await worker!.publishJobOutcome(claimed!.job_id, {
      status: INDEX_JOB_STATUS.FAILED,
      failureCode: "projection_drain_failure",
      finishedAt: FINISH_AT,
      claimedStartedAt: CLAIM_AT,
    });
    expect(published?.status).toBe(INDEX_JOB_STATUS.FAILED);
    expect(published?.failure_code).toBe("projection_drain_failure");

    const persisted = await admin!.query<{ failure_code: string | null }>(
      `SELECT failure_code FROM index_jobs WHERE job_id = 'pub-failed'`
    );
    expect(persisted.rows[0]!.failure_code).toBe("projection_drain_failure");
  });

  it("publish stale is terminal and carries no failure_code", async () => {
    await startRunning(
      "pub-stale",
      "docs/pub-c.md",
      "2026-01-01T00:00:00.000Z",
      CLAIM_AT
    );

    const published = await worker!.publishJobOutcome("pub-stale", {
      status: INDEX_JOB_STATUS.STALE,
      finishedAt: FINISH_AT,
      claimedStartedAt: CLAIM_AT,
    });
    expect(published?.status).toBe(INDEX_JOB_STATUS.STALE);
    expect(published?.failure_code).toBeNull();
    expect((await worker!.getJob("pub-stale"))?.status).toBe(
      INDEX_JOB_STATUS.STALE
    );
  });

  it("publish clears an older failure_code when the outcome carries none", async () => {
    // Retry re-enters a failed job in place (decision 2), so an active row can
    // still carry the previous attempt's code; a ready publish must not leave
    // it readable beside the success.
    await admin!.query(
      `INSERT INTO index_jobs
       (job_id, source_ref, content_identity, status, failure_code,
        created_at, started_at)
     VALUES ('retry', 'docs/retry.md', 'id-retry', 'in_progress',
             'stage_not_runnable', $1::timestamptz, $2::timestamptz)`,
      ["2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"]
    );

    const published = await worker!.publishJobOutcome("retry", {
      status: INDEX_JOB_STATUS.READY,
      finishedAt: FINISH_AT,
      claimedStartedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(published?.failure_code).toBeNull();
    const persisted = await admin!.query<{ failure_code: string | null }>(
      `SELECT failure_code FROM index_jobs WHERE job_id = 'retry'`
    );
    expect(persisted.rows[0]!.failure_code).toBeNull();
  });

  it("a second publish on the same job is the lost-lease null", async () => {
    await seedQueuedJob(
      worker!,
      "twice",
      "docs/twice.md",
      "2026-01-01T00:00:00.000Z"
    );
    await worker!.claimNextJob({ startedAt: CLAIM_AT });
    const first = await worker!.publishJobOutcome("twice", {
      status: INDEX_JOB_STATUS.READY,
      finishedAt: FINISH_AT,
      claimedStartedAt: CLAIM_AT,
    });
    expect(first).not.toBeNull();

    const second = await worker!.publishJobOutcome("twice", {
      status: INDEX_JOB_STATUS.FAILED,
      failureCode: "embedding_failure",
      finishedAt: "2026-06-06T00:00:00.000Z",
      claimedStartedAt: CLAIM_AT,
    });
    // No row matched `status = 'in_progress'`, so this worker's verdict is
    // dropped rather than written over the outcome that won.
    expect(second).toBeNull();
    const settled = await admin!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM index_jobs
      WHERE job_id = 'twice'
        AND status = 'ready'
        AND finished_at = $1::timestamptz
        AND failure_code IS NULL`,
      [FINISH_AT]
    );
    expect(settled.rows[0]!.n).toBe("1");
  });

  it("a publish naming another worker's claim token is the lost-lease null", async () => {
    await seedQueuedJob(
      worker!,
      "preempted",
      "docs/preempted.md",
      "2026-01-01T00:00:00.000Z"
    );
    await worker!.claimNextJob({ startedAt: CLAIM_AT });
    await worker!.claimNextJob({
      startedAt: "2026-04-20T00:00:00.000Z",
      stalledBefore: "2026-04-10T00:00:00.000Z",
    });

    // The re-claim overwrote the first worker's stamp, so that worker's
    // outcome — computed from stages it really ran — must not stand.
    expect(
      await worker!.publishJobOutcome("preempted", {
        status: INDEX_JOB_STATUS.READY,
        finishedAt: FINISH_AT,
        claimedStartedAt: CLAIM_AT,
      })
    ).toBeNull();
    const row = await worker!.getJob("preempted");
    expect(row?.status).toBe(INDEX_JOB_STATUS.IN_PROGRESS);
    expect(row?.started_at).toBe("2026-04-20T00:00:00.000Z");
  });

  it("publishing an unknown job answers null and persists nothing", async () => {
    const published = await worker!.publishJobOutcome("no-such-job", {
      status: INDEX_JOB_STATUS.READY,
      finishedAt: FINISH_AT,
      claimedStartedAt: null,
    });
    expect(published).toBeNull();
    expect(await worker!.getJob("no-such-job")).toBeNull();
    const rows = await admin!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM index_jobs WHERE job_id = 'no-such-job'`
    );
    expect(rows.rows[0]!.n).toBe("0");
  });

  it("a never-claimed queued row is still active, so a null claim token settles it", async () => {
    // The lease is the status word, not `started_at`: queued and running share
    // one vocabulary, so a publish that lands before any claim is accepted
    // instead of answered with the lost-lease null. Only the real SQL witnesses
    // it — `started_at IS NOT DISTINCT FROM $6` matches a NULL token against a
    // NULL column, where plain `=` would match no row and strand the queued job
    // behind a terminal outcome nobody can publish.
    await seedQueuedJob(
      worker!,
      "queue-pub",
      "docs/queue-pub.md",
      "2026-01-01T00:00:00.000Z"
    );

    const published = await worker!.publishJobOutcome("queue-pub", {
      status: INDEX_JOB_STATUS.FAILED,
      failureCode: "stage_not_runnable",
      finishedAt: FINISH_AT,
      claimedStartedAt: null,
    });
    expect(published?.status).toBe(INDEX_JOB_STATUS.FAILED);
    expect(published?.started_at).toBeNull();
    expect(published?.finished_at).toBe(FINISH_AT);

    // Persisted state, read back outside the store: settled with its code, and
    // still carrying a NULL start — a publish never invents a claim stamp.
    const settled = await admin!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM index_jobs
      WHERE job_id = 'queue-pub'
        AND status = 'failed'
        AND failure_code = 'stage_not_runnable'
        AND started_at IS NULL
        AND finished_at = $1::timestamptz`,
      [FINISH_AT]
    );
    expect(settled.rows[0]!.n).toBe("1");
    expect((await worker!.getJob("queue-pub"))?.status).toBe(
      INDEX_JOB_STATUS.FAILED
    );
  });
});
