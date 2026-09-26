/**
 * MemoryBackend index-job ledger (corpus-index-job T2).
 *
 * The in-memory twin of the pg `index_jobs` store, exercising the same
 * semantics the pg path pins: the idempotent submit arm (including which of
 * two racing submits actually inserted), the one-active-job-per-source
 * conflict arm that mirrors the partial unique index, single active-job
 * lookup, and the ready→stale demotion. Durability across a restart is a pg-only claim;
 * these tests pin the semantics, not persistence.
 */
import { describe, expect, it } from "vitest";

import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import {
  INDEX_JOB_STATUS,
  type IndexJobInsertOutcome,
  type IndexJobRecord,
  type IndexJobStatus,
} from "../../src/core/types.js";

const TEST_DIM = 8;
const NOW = "2026-01-01T00:00:00.000Z";

function makeJob(
  patch: Partial<IndexJobRecord> & { job_id: string; source_ref: string }
): IndexJobRecord {
  return {
    job_id: patch.job_id,
    source_ref: patch.source_ref,
    content_identity: patch.content_identity ?? `identity-of-${patch.job_id}`,
    status: patch.status ?? INDEX_JOB_STATUS.IN_PROGRESS,
    created_at: patch.created_at ?? NOW,
    started_at: patch.started_at ?? null,
    finished_at: patch.finished_at ?? null,
    failure_code: patch.failure_code ?? null,
  };
}

function freshBackend(): MemoryBackend {
  return new MemoryBackend(TEST_DIM);
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

describe("MemoryBackend.insertJobOrJoin — idempotent submit arm", () => {
  it("a first submit persists, reports itself as inserted, returns the row", async () => {
    const backend = freshBackend();
    const job = makeJob({
      job_id: "job-1",
      source_ref: "docs/a.md",
      status: INDEX_JOB_STATUS.IN_PROGRESS,
      started_at: NOW,
    });

    const { record, inserted } = accepted(await backend.insertJobOrJoin(job));
    expect(inserted).toBe(true);
    expect(record).toEqual(job);
    expect(await backend.getJob("job-1")).toEqual(job);
  });

  it("a repeat submit for the same job_id returns the EXISTING row unchanged", async () => {
    const backend = freshBackend();
    await backend.insertJobOrJoin(
      makeJob({
        job_id: "job-1",
        source_ref: "docs/a.md",
        status: INDEX_JOB_STATUS.IN_PROGRESS,
        started_at: NOW,
      })
    );

    // A re-submit carries a different status/timestamps — the join arm must
    // NOT overwrite the running job the worker already advanced.
    const { record: joined, inserted } = accepted(
      await backend.insertJobOrJoin(
        makeJob({
          job_id: "job-1",
          source_ref: "docs/a.md",
          status: INDEX_JOB_STATUS.READY,
          started_at: "2026-02-02T00:00:00.000Z",
          finished_at: "2026-02-02T00:00:00.000Z",
        })
      )
    );
    expect(inserted).toBe(false);
    expect(joined.status).toBe(INDEX_JOB_STATUS.IN_PROGRESS);
    expect(joined.started_at).toBe(NOW);

    const stored = await backend.getJob("job-1");
    expect(stored?.status).toBe(INDEX_JOB_STATUS.IN_PROGRESS);
  });

  it("two submits of the SAME pair: the loser joins and keeps the first created_at", async () => {
    const backend = freshBackend();
    const firstStamp = "2026-01-01T00:00:00.000Z";
    const secondStamp = "2026-03-03T00:00:00.000Z";

    const [first, second] = (
      await Promise.all([
        backend.insertJobOrJoin(
          makeJob({
            job_id: "job-race",
            source_ref: "docs/a.md",
            created_at: firstStamp,
          })
        ),
        backend.insertJobOrJoin(
          makeJob({
            job_id: "job-race",
            source_ref: "docs/a.md",
            created_at: secondStamp,
          })
        ),
      ])
    ).map(accepted);

    // Exactly one of the two created the row; the other joined it and must
    // not claim a queue entry it did not make.
    expect([first.inserted, second.inserted].sort()).toEqual([false, true]);
    const creator = first.inserted ? first : second;
    const joiner = first.inserted ? second : first;
    // The joiner's own stamp is discarded: the ledger keeps the row that was
    // there first, and reports ITS timestamp.
    expect(creator.record.created_at).toBe(firstStamp);
    expect(joiner.record.created_at).toBe(firstStamp);
    expect((await backend.getJob("job-race"))?.created_at).toBe(firstStamp);
  });

  it("does not invent a row for a caller that mutates the returned record", async () => {
    const backend = freshBackend();
    const { record: returned } = accepted(
      await backend.insertJobOrJoin(
        makeJob({ job_id: "job-1", source_ref: "docs/a.md" })
      )
    );
    returned.status = INDEX_JOB_STATUS.FAILED;

    const stored = await backend.getJob("job-1");
    expect(stored?.status).toBe(INDEX_JOB_STATUS.IN_PROGRESS);
  });

  it("getJob returns null for an unknown id", async () => {
    const backend = freshBackend();
    expect(await backend.getJob("nope")).toBeNull();
  });
});

describe("MemoryBackend.insertJobOrJoin — one active job per source", () => {
  it("refuses a second active row for the source and names the owning row", async () => {
    const backend = freshBackend();
    await backend.insertJobOrJoin(
      makeJob({ job_id: "active-1", source_ref: "docs/a.md" })
    );

    const loser = conflicted(
      await backend.insertJobOrJoin(
        makeJob({ job_id: "active-2", source_ref: "docs/a.md" })
      )
    );
    // The conflict IS the racing row, copied out for the caller's answer.
    expect(loser.job_id).toBe("active-1");
    // Refused means refused: the loser never reaches the ledger.
    expect(await backend.getJob("active-2")).toBeNull();
  });

  it("a queued (started_at NULL) active row blocks a conflicting submit too", async () => {
    const backend = freshBackend();
    await backend.insertJobOrJoin(
      makeJob({
        job_id: "queued",
        source_ref: "docs/a.md",
        started_at: null,
      })
    );
    expect(
      conflicted(
        await backend.insertJobOrJoin(
          makeJob({ job_id: "rival", source_ref: "docs/a.md" })
        )
      ).job_id
    ).toBe("queued");
  });

  it("the same job_id still JOINS even while another version is active", async () => {
    // Idempotency precedes the conflict check: a re-submit of the row that
    // already exists is a join, never a self-conflict.
    const backend = freshBackend();
    await backend.insertJobOrJoin(
      makeJob({ job_id: "active-1", source_ref: "docs/a.md" })
    );
    const outcome = accepted(
      await backend.insertJobOrJoin(
        makeJob({ job_id: "active-1", source_ref: "docs/a.md" })
      )
    );
    expect(outcome.inserted).toBe(false);
    expect(outcome.record.job_id).toBe("active-1");
  });

  it("terminal inserts and other sources are untouched by the guard", async () => {
    const backend = freshBackend();
    await backend.insertJobOrJoin(
      makeJob({ job_id: "active-a", source_ref: "docs/a.md" })
    );
    // A ready row for the SAME source is a history record, not a competitor.
    expect(
      accepted(
        await backend.insertJobOrJoin(
          makeJob({
            job_id: "ready-a",
            source_ref: "docs/a.md",
            status: INDEX_JOB_STATUS.READY,
          })
        )
      ).inserted
    ).toBe(true);
    // A second active row for a DIFFERENT source is legitimate work.
    expect(
      accepted(
        await backend.insertJobOrJoin(
          makeJob({ job_id: "active-b", source_ref: "docs/b.md" })
        )
      ).inserted
    ).toBe(true);
  });
});

describe("MemoryBackend.getActiveJobForSource", () => {
  it("returns the in_progress job and ignores terminal ones", async () => {
    const backend = freshBackend();
    await backend.insertJobOrJoin(
      makeJob({
        job_id: "done",
        source_ref: "docs/a.md",
        status: INDEX_JOB_STATUS.READY,
      })
    );
    await backend.insertJobOrJoin(
      makeJob({
        job_id: "active",
        source_ref: "docs/a.md",
        status: INDEX_JOB_STATUS.IN_PROGRESS,
      })
    );
    await backend.insertJobOrJoin(
      makeJob({
        job_id: "failed",
        source_ref: "docs/a.md",
        status: INDEX_JOB_STATUS.FAILED,
      })
    );

    const active = await backend.getActiveJobForSource("docs/a.md");
    expect(active?.job_id).toBe("active");
  });

  it("treats a queued (started_at NULL) in_progress job as active", async () => {
    const backend = freshBackend();
    await backend.insertJobOrJoin(
      makeJob({
        job_id: "queued",
        source_ref: "docs/a.md",
        status: INDEX_JOB_STATUS.IN_PROGRESS,
        started_at: null,
      })
    );
    expect((await backend.getActiveJobForSource("docs/a.md"))?.job_id).toBe(
      "queued"
    );
  });

  it("returns null when the source has no active job", async () => {
    const backend = freshBackend();
    await backend.insertJobOrJoin(
      makeJob({
        job_id: "ready",
        source_ref: "docs/a.md",
        status: INDEX_JOB_STATUS.READY,
      })
    );
    expect(await backend.getActiveJobForSource("docs/a.md")).toBeNull();
    expect(await backend.getActiveJobForSource("docs/absent.md")).toBeNull();
  });
});

describe("MemoryBackend.supersedeReadyJobs", () => {
  it("demotes every terminal ready job of the source and no other source", async () => {
    const backend = freshBackend();
    const seed = async (
      jobId: string,
      sourceRef: string,
      status: IndexJobStatus
    ): Promise<void> => {
      await backend.insertJobOrJoin(
        makeJob({ job_id: jobId, source_ref: sourceRef, status })
      );
    };
    await seed("ready-a1", "docs/a.md", INDEX_JOB_STATUS.READY);
    await seed("ready-a2", "docs/a.md", INDEX_JOB_STATUS.READY);
    await seed("new-a", "docs/a.md", INDEX_JOB_STATUS.IN_PROGRESS);
    await seed("ready-b", "docs/b.md", INDEX_JOB_STATUS.READY);

    const demoted = await backend.supersedeReadyJobs("docs/a.md");
    expect(demoted).toBe(2);

    expect((await backend.getJob("ready-a1"))?.status).toBe(
      INDEX_JOB_STATUS.STALE
    );
    expect((await backend.getJob("ready-a2"))?.status).toBe(
      INDEX_JOB_STATUS.STALE
    );
    // The in-progress job is not a terminal one, so the `ready` predicate
    // leaves it alone on its own — no id exception exists to spare it.
    expect((await backend.getJob("new-a"))?.status).toBe(
      INDEX_JOB_STATUS.IN_PROGRESS
    );
    expect((await backend.getJob("ready-b"))?.status).toBe(
      INDEX_JOB_STATUS.READY
    );
  });

  it("demotes a lone ready row: the supersede arm is observable, not inferred", async () => {
    const backend = freshBackend();
    await backend.insertJobOrJoin(
      makeJob({
        job_id: "only-ready",
        source_ref: "docs/a.md",
        status: INDEX_JOB_STATUS.READY,
      })
    );

    expect(await backend.supersedeReadyJobs("docs/a.md")).toBe(1);
    expect((await backend.getJob("only-ready"))?.status).toBe(
      INDEX_JOB_STATUS.STALE
    );
  });

  it("leaves a failed row alone — only terminal READY moves to stale", async () => {
    const backend = freshBackend();
    await backend.insertJobOrJoin(
      makeJob({
        job_id: "failed",
        source_ref: "docs/a.md",
        status: INDEX_JOB_STATUS.FAILED,
      })
    );
    expect(await backend.supersedeReadyJobs("docs/a.md")).toBe(0);
    expect((await backend.getJob("failed"))?.status).toBe(
      INDEX_JOB_STATUS.FAILED
    );
  });

  it("returns 0 and changes nothing when the source has no ready jobs", async () => {
    const backend = freshBackend();
    await backend.insertJobOrJoin(
      makeJob({
        job_id: "active",
        source_ref: "docs/a.md",
        status: INDEX_JOB_STATUS.IN_PROGRESS,
      })
    );
    expect(await backend.supersedeReadyJobs("docs/a.md")).toBe(0);
    expect((await backend.getJob("active"))?.status).toBe(
      INDEX_JOB_STATUS.IN_PROGRESS
    );
  });
});
