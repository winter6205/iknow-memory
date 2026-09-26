/**
 * MemoryBackend index-job ledger (corpus-index-job T2).
 *
 * The in-memory twin of the pg `index_jobs` store, exercising the same
 * semantics the pg path pins: the idempotent submit arm (including which of
 * two racing submits actually inserted), the one-active-job-per-source
 * conflict arm that mirrors the partial unique index, single active-job
 * lookup, the ready→stale demotion, and the worker side — `claimNextJob`
 * (queued FIFO, stalled re-claim) and `publishJobOutcome` (terminal write with
 * a lost-lease null). Durability across a restart is a pg-only claim;
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
/** The instant a worker claims with; distinct from every seeded timestamp. */
const CLAIM_AT = "2026-04-04T00:00:00.000Z";
/** Anything running from before this instant counts as a dead worker's lease. */
const STALLED_BEFORE = "2026-03-01T00:00:00.000Z";
const FINISH_AT = "2026-05-05T00:00:00.000Z";

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

/** Persist one job through the real submit seam, failing loudly on a conflict. */
async function seed(
  backend: MemoryBackend,
  patch: Partial<IndexJobRecord> & { job_id: string; source_ref: string }
): Promise<IndexJobRecord> {
  return accepted(await backend.insertJobOrJoin(makeJob(patch))).record;
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

describe("MemoryBackend.claimNextJob — queued claim", () => {
  it("claims the oldest queued job, stamps its start, keeps it in_progress", async () => {
    const backend = freshBackend();
    await seed(backend, {
      job_id: "queue-old",
      source_ref: "docs/a.md",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: null,
    });
    await seed(backend, {
      job_id: "queue-new",
      source_ref: "docs/b.md",
      created_at: "2026-02-02T00:00:00.000Z",
      started_at: null,
    });

    const claimed = await backend.claimNextJob({ startedAt: CLAIM_AT });
    // Oldest queue time wins; the two jobs are different sources, so the
    // one-active-per-source rule is not what ordered them.
    expect(claimed?.job_id).toBe("queue-old");
    expect(claimed?.started_at).toBe(CLAIM_AT);
    // Decision 2: claim moves queued→running through started_at only.
    expect(claimed?.status).toBe(INDEX_JOB_STATUS.IN_PROGRESS);
    expect(claimed?.created_at).toBe("2026-01-01T00:00:00.000Z");
    // The claim is a write to the ledger, not a value in the reply.
    expect(await backend.getJob("queue-old")).toEqual(claimed);
  });

  it("the next claim hands out the following queued job, not the running one", async () => {
    const backend = freshBackend();
    await seed(backend, {
      job_id: "queue-old",
      source_ref: "docs/a.md",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: null,
    });
    await seed(backend, {
      job_id: "queue-new",
      source_ref: "docs/b.md",
      created_at: "2026-02-02T00:00:00.000Z",
      started_at: null,
    });

    expect((await backend.claimNextJob({ startedAt: CLAIM_AT }))?.job_id).toBe(
      "queue-old"
    );
    const second = await backend.claimNextJob({
      startedAt: "2026-04-05T00:00:00.000Z",
    });
    expect(second?.job_id).toBe("queue-new");
    // The already-running row is untouched by the second claim.
    expect((await backend.getJob("queue-old"))?.started_at).toBe(CLAIM_AT);
  });

  it("claims nothing when the queue is empty", async () => {
    const backend = freshBackend();
    expect(await backend.claimNextJob({ startedAt: CLAIM_AT })).toBeNull();

    await seed(backend, {
      job_id: "settled",
      source_ref: "docs/a.md",
      status: INDEX_JOB_STATUS.READY,
      started_at: null,
    });
    await seed(backend, {
      job_id: "broken",
      source_ref: "docs/b.md",
      status: INDEX_JOB_STATUS.FAILED,
      started_at: null,
    });
    await seed(backend, {
      job_id: "aged",
      source_ref: "docs/c.md",
      status: INDEX_JOB_STATUS.STALE,
      started_at: null,
    });
    // Terminal words are outside the claimable predicate even with the
    // stalled arm open — a settled job is not waiting for a worker.
    expect(
      await backend.claimNextJob({
        startedAt: CLAIM_AT,
        stalledBefore: STALLED_BEFORE,
      })
    ).toBeNull();
  });

  it("two callers claiming at once get two different jobs", async () => {
    const backend = freshBackend();
    await seed(backend, {
      job_id: "pair-a",
      source_ref: "docs/a.md",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: null,
    });
    await seed(backend, {
      job_id: "pair-b",
      source_ref: "docs/b.md",
      created_at: "2026-02-02T00:00:00.000Z",
      started_at: null,
    });

    const claims = await Promise.all([
      backend.claimNextJob({ startedAt: CLAIM_AT }),
      backend.claimNextJob({ startedAt: "2026-04-06T00:00:00.000Z" }),
    ]);
    // No row lock exists here; the claim body is synchronous, so the second
    // caller sees the row the first already started as unclaimable.
    expect(claims.map((claim) => claim?.job_id).sort()).toEqual([
      "pair-a",
      "pair-b",
    ]);
  });
});

describe("MemoryBackend.claimNextJob — stalled re-claim", () => {
  it("without stalledBefore a running job stays unclaimed", async () => {
    const backend = freshBackend();
    await seed(backend, {
      job_id: "running",
      source_ref: "docs/a.md",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-02-01T00:00:00.000Z",
    });

    expect(await backend.claimNextJob({ startedAt: CLAIM_AT })).toBeNull();
    expect((await backend.getJob("running"))?.started_at).toBe(
      "2026-02-01T00:00:00.000Z"
    );
  });

  it("with stalledBefore a dead worker's job is claimable and re-stamped", async () => {
    const backend = freshBackend();
    await seed(backend, {
      job_id: "crashed",
      source_ref: "docs/a.md",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-02-01T00:00:00.000Z",
    });

    const claimed = await backend.claimNextJob({
      startedAt: CLAIM_AT,
      stalledBefore: STALLED_BEFORE,
    });
    expect(claimed?.job_id).toBe("crashed");
    // The new instant replaces the dead attempt's; created_at stays the queue
    // time, which is what keeps the next ordering decision stable.
    expect(claimed?.started_at).toBe(CLAIM_AT);
    expect(claimed?.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(claimed?.status).toBe(INDEX_JOB_STATUS.IN_PROGRESS);
  });

  it("a row started exactly at stalledBefore is not stalled yet", async () => {
    const backend = freshBackend();
    await seed(backend, {
      job_id: "edge",
      source_ref: "docs/a.md",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: STALLED_BEFORE,
    });

    expect(
      await backend.claimNextJob({
        startedAt: CLAIM_AT,
        stalledBefore: STALLED_BEFORE,
      })
    ).toBeNull();
  });

  it("the stalled arm shares one FIFO with the queued arm", async () => {
    const backend = freshBackend();
    await seed(backend, {
      job_id: "stale-lease",
      source_ref: "docs/a.md",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-02-01T00:00:00.000Z",
    });
    await seed(backend, {
      job_id: "fresh-queue",
      source_ref: "docs/b.md",
      created_at: "2026-02-15T00:00:00.000Z",
      started_at: null,
    });

    // Oldest queue time still wins, whether it is queued or orphaned.
    expect(
      (
        await backend.claimNextJob({
          startedAt: CLAIM_AT,
          stalledBefore: STALLED_BEFORE,
        })
      )?.job_id
    ).toBe("stale-lease");
  });
});

describe("MemoryBackend.publishJobOutcome", () => {
  it("ready is terminal, stamps finished_at, carries no failure_code", async () => {
    const backend = freshBackend();
    const claimed = await seed(backend, {
      job_id: "pub-ready",
      source_ref: "docs/a.md",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: null,
    });
    await backend.claimNextJob({ startedAt: CLAIM_AT });

    const published = await backend.publishJobOutcome(claimed.job_id, {
      status: INDEX_JOB_STATUS.READY,
      finishedAt: FINISH_AT,
      claimedStartedAt: CLAIM_AT,
    });
    expect(published?.status).toBe(INDEX_JOB_STATUS.READY);
    expect(published?.finished_at).toBe(FINISH_AT);
    expect(published?.failure_code).toBeNull();
    // The attempt's start survives the terminal write; publish adds, never
    // resets, the earlier stage timestamps.
    expect(published?.started_at).toBe(CLAIM_AT);
    expect(await backend.getJob("pub-ready")).toEqual(published);
  });

  it("failed carries its typed failure_code", async () => {
    const backend = freshBackend();
    await seed(backend, {
      job_id: "pub-failed",
      source_ref: "docs/a.md",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: null,
    });
    await backend.claimNextJob({ startedAt: CLAIM_AT });

    const published = await backend.publishJobOutcome("pub-failed", {
      status: INDEX_JOB_STATUS.FAILED,
      failureCode: "projection_drain_failure",
      finishedAt: FINISH_AT,
      claimedStartedAt: CLAIM_AT,
    });
    expect(published?.status).toBe(INDEX_JOB_STATUS.FAILED);
    expect(published?.failure_code).toBe("projection_drain_failure");
    expect(published?.finished_at).toBe(FINISH_AT);
    expect((await backend.getJob("pub-failed"))?.failure_code).toBe(
      "projection_drain_failure"
    );
  });

  it("stale is a terminal demotion with no failure_code", async () => {
    const backend = freshBackend();
    await seed(backend, {
      job_id: "pub-stale",
      source_ref: "docs/a.md",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: null,
    });

    const published = await backend.publishJobOutcome("pub-stale", {
      status: INDEX_JOB_STATUS.STALE,
      finishedAt: FINISH_AT,
      claimedStartedAt: null,
    });
    expect(published?.status).toBe(INDEX_JOB_STATUS.STALE);
    expect(published?.failure_code).toBeNull();
    expect((await backend.getJob("pub-stale"))?.status).toBe(
      INDEX_JOB_STATUS.STALE
    );
  });

  it("a failed publish clears an earlier failure_code when none is carried", async () => {
    const backend = freshBackend();
    await seed(backend, {
      job_id: "retry",
      source_ref: "docs/a.md",
      status: INDEX_JOB_STATUS.IN_PROGRESS,
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-02-01T00:00:00.000Z",
      failure_code: "stage_not_runnable",
    });

    const published = await backend.publishJobOutcome("retry", {
      status: INDEX_JOB_STATUS.READY,
      finishedAt: FINISH_AT,
      claimedStartedAt: "2026-02-01T00:00:00.000Z",
    });
    // A success that reports no failure must not leave the previous attempt's
    // code readable beside `ready`.
    expect(published?.failure_code).toBeNull();
    expect((await backend.getJob("retry"))?.failure_code).toBeNull();
  });

  it("publishing a terminalized job again is the lost-lease null", async () => {
    const backend = freshBackend();
    await seed(backend, {
      job_id: "twice",
      source_ref: "docs/a.md",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: null,
    });
    await backend.claimNextJob({ startedAt: CLAIM_AT });
    const first = await backend.publishJobOutcome("twice", {
      status: INDEX_JOB_STATUS.READY,
      finishedAt: FINISH_AT,
      claimedStartedAt: CLAIM_AT,
    });

    const second = await backend.publishJobOutcome("twice", {
      status: INDEX_JOB_STATUS.FAILED,
      failureCode: "embedding_failure",
      finishedAt: "2026-06-06T00:00:00.000Z",
      claimedStartedAt: CLAIM_AT,
    });
    expect(second).toBeNull();
    // The winner's outcome stands: no status, code, or timestamp moved.
    expect(await backend.getJob("twice")).toEqual(first);
  });

  it("an unknown job id publishes nothing and answers null", async () => {
    const backend = freshBackend();
    expect(
      await backend.publishJobOutcome("never-submitted", {
        status: INDEX_JOB_STATUS.READY,
        finishedAt: FINISH_AT,
        claimedStartedAt: null,
      })
    ).toBeNull();
    expect(await backend.getJob("never-submitted")).toBeNull();
  });

  it("a queued row is still active, so publish settles it too", async () => {
    // The lease is the status word (`in_progress`), not started_at: queued and
    // running share one vocabulary by decision 2, so a publish that arrives
    // before any claim is accepted rather than answered with a lost lease.
    const backend = freshBackend();
    await seed(backend, {
      job_id: "never-claimed",
      source_ref: "docs/a.md",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: null,
    });

    const published = await backend.publishJobOutcome("never-claimed", {
      status: INDEX_JOB_STATUS.FAILED,
      failureCode: "stage_not_runnable",
      finishedAt: FINISH_AT,
      claimedStartedAt: null,
    });
    expect(published?.status).toBe(INDEX_JOB_STATUS.FAILED);
    expect(published?.started_at).toBeNull();
  });

  it("a publish naming another worker's claim token is the lost-lease null", async () => {
    // The second worker's `started_at` overwrote the first one's, so the first
    // worker's outcome — computed from stages it really ran — must not stand.
    const backend = freshBackend();
    await seed(backend, {
      job_id: "preempted",
      source_ref: "docs/a.md",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: null,
    });
    await backend.claimNextJob({ startedAt: CLAIM_AT });
    await backend.claimNextJob({
      startedAt: "2026-05-05T00:00:00.000Z",
      stalledBefore: "2026-06-01T00:00:00.000Z",
    });

    expect(
      await backend.publishJobOutcome("preempted", {
        status: INDEX_JOB_STATUS.READY,
        finishedAt: FINISH_AT,
        claimedStartedAt: CLAIM_AT,
      })
    ).toBeNull();
    const row = await backend.getJob("preempted");
    expect(row?.status).toBe(INDEX_JOB_STATUS.IN_PROGRESS);
    expect(row?.started_at).toBe("2026-05-05T00:00:00.000Z");
  });

  it("does not let a caller write through the returned record", async () => {
    const backend = freshBackend();
    await seed(backend, {
      job_id: "copy",
      source_ref: "docs/a.md",
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: null,
    });
    const published = await backend.publishJobOutcome("copy", {
      status: INDEX_JOB_STATUS.READY,
      finishedAt: FINISH_AT,
      claimedStartedAt: null,
    });
    expect(published).not.toBeNull();
    published!.status = INDEX_JOB_STATUS.FAILED;

    expect((await backend.getJob("copy"))?.status).toBe(INDEX_JOB_STATUS.READY);
  });
});
