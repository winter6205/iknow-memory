/**
 * Index-job runner (`src/core/index-job.ts`) over fake stage ports.
 *
 * Ledger rule for this file, inherited from tests/tools/index-job.test.ts: the
 * job rows are held by the REAL production `IndexJobStore` (MemoryBackend, the
 * pg ledger's memory twin), never a hand-rolled copy — so every "what did the
 * runner write" assertion runs on backend truth, including the lost-lease arm,
 * which is produced by settling the row through the store itself rather than by
 * stubbing a null. Where a scenario needs the call sequence, a thin recording
 * decorator wraps the real backend and delegates every read and write.
 *
 * The stages themselves are fakes on purpose: extract / projection / summary
 * algorithms have their own suites and their own real-service gold runs. What
 * is under test here is only what the runner owns — the ORDER of the four
 * capabilities, the single terminal outcome it publishes, and the exact
 * failure_code it is allowed to carry.
 *
 * Contract asserted per stage outcome:
 *   normal     four ports in order → `ready`, null failure code, the injected
 *              clock's finished_at
 *   extract    a failing leg → `failed` with the pipeline's own code verbatim,
 *              and the graph stages never run
 *   stale      the source's content identity moved on → `stale`, no stages, no
 *              failure code
 *   unknown    no 资料 row → `failed` + index_job_unknown_source
 *   typed throw of a later stage → `failed` + that stage's code, never `ready`
 *   untyped throw → the runner rethrows and the row stays `in_progress`, so the
 *              stalled-lease arm can re-claim it: an internal fault is never
 *              recorded as a product-level stage failure
 *   lost lease → null returned, logged, nothing overwritten
 *   method     the recorded extract switch is forwarded as-is and an unrecorded
 *              one stays null (Fast never runs unasked)
 */
import { describe, expect, it } from "vitest";
import {
  IndexJobStageError,
  runIndexJob,
  type IndexJobExtractOutcome,
  type IndexJobSourceVersion,
  type IndexJobStagePorts,
} from "../../src/core/index-job.js";
import {
  INDEX_JOB_STATUS,
  type ExtractMethod,
  type IndexJobRecord,
  type IndexJobStore,
  type IndexJobTerminalOutcome,
} from "../../src/core/types.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import type { LogLevel } from "../../src/config.js";
import type { Logger } from "../../src/logging.js";
import {
  createMergeEmbedBudget,
  ENTITY_MERGE_EMBED_LIMIT,
  MergeEmbedLimitError,
} from "../../src/core/entities/merge-budget.js";

const SOURCE_REF = "doc-1/1/main";
const IDENTITY = "identity-v1";
const CLAIMED_AT = "2026-09-26T00:05:00.000Z";
const FINISHED_AT = "2026-09-26T00:09:00.000Z";

const CLEAN_EXTRACT: IndexJobExtractOutcome = {
  processed: 3,
  failed: 0,
  writeFailures: 0,
  failureCodes: [],
};

function queuedJob(overrides: Partial<IndexJobRecord> = {}): IndexJobRecord {
  return {
    job_id: "job-1",
    source_ref: SOURCE_REF,
    content_identity: IDENTITY,
    status: INDEX_JOB_STATUS.IN_PROGRESS,
    created_at: "2026-09-26T00:00:00.000Z",
    started_at: null,
    finished_at: null,
    failure_code: null,
    ...overrides,
  };
}

/**
 * The production ledger plus the two sequences the assertions need. Every
 * method delegates, so the published state is always the backend's own.
 */
function ledger() {
  const backend = new MemoryBackend(1);
  const publishes: IndexJobTerminalOutcome[] = [];
  const store: IndexJobStore = {
    insertJobOrJoin: (record) => backend.insertJobOrJoin(record),
    getJob: (jobId) => backend.getJob(jobId),
    getActiveJobForSource: (sourceRef) =>
      backend.getActiveJobForSource(sourceRef),
    supersedeReadyJobs: (sourceRef) => backend.supersedeReadyJobs(sourceRef),
    claimNextJob: (options) => backend.claimNextJob(options),
    publishJobOutcome: (jobId, outcome) => {
      publishes.push(outcome);
      return backend.publishJobOutcome(jobId, outcome);
    },
  };
  return { store, publishes };
}

/** Seed a queued job and claim it, so the runner receives a real running row. */
async function claimed(store: IndexJobStore): Promise<IndexJobRecord> {
  await store.insertJobOrJoin(queuedJob());
  const job = await store.claimNextJob({ startedAt: CLAIMED_AT });
  if (job === null) throw new Error("test setup: the queue answered empty");
  return job;
}

/** Records what the runner asked each capability to do, and how it failed. */
class FakePorts implements IndexJobStagePorts {
  readonly calls: string[] = [];
  readonly selectors: { sourceRef: string; method: ExtractMethod | null }[] =
    [];
  source: IndexJobSourceVersion | null = {
    contentIdentity: IDENTITY,
    extractMethod: null,
  };
  extract: IndexJobExtractOutcome = CLEAN_EXTRACT;
  extractFault: unknown;
  drainFault: unknown;
  summaryFault: unknown;

  async readSourceVersion(
    sourceRef: string
  ): Promise<IndexJobSourceVersion | null> {
    this.calls.push("readSourceVersion");
    this.selectors.push({ sourceRef, method: null });
    return this.source;
  }

  async runExtract(
    sourceRef: string,
    method: ExtractMethod | null
  ): Promise<IndexJobExtractOutcome> {
    this.calls.push("runExtract");
    this.selectors.push({ sourceRef, method });
    if (this.extractFault !== undefined) throw this.extractFault;
    return this.extract;
  }

  async drainProjection(): Promise<void> {
    this.calls.push("drainProjection");
    if (this.drainFault !== undefined) throw this.drainFault;
  }

  async summarizeCommunities(): Promise<void> {
    this.calls.push("summarizeCommunities");
    if (this.summaryFault !== undefined) throw this.summaryFault;
  }
}

class RecordingLogger implements Logger {
  level: LogLevel = "debug";
  readonly events: { name: string; fields?: Record<string, unknown> }[] = [];
  debug(msg: string, fields?: Record<string, unknown>): void {
    this.events.push({ name: msg, fields });
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.events.push({ name: msg, fields });
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.events.push({ name: msg, fields });
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.events.push({ name: msg, fields });
  }
  names(): string[] {
    return this.events.map((event) => event.name);
  }
}

function harness(over: Partial<FakePorts> = {}) {
  const { store, publishes } = ledger();
  const ports = Object.assign(new FakePorts(), over);
  const logger = new RecordingLogger();
  return {
    store,
    ports,
    logger,
    publishes,
    deps: {
      store,
      ports,
      logger,
      clock: () => new Date(FINISHED_AT),
    },
  };
}

function version(
  overrides: Partial<IndexJobSourceVersion>
): IndexJobSourceVersion {
  return { contentIdentity: IDENTITY, extractMethod: null, ...overrides };
}

describe("index job runner stage order and terminal outcome", () => {
  it("runs the four stages in order and publishes ready with no failure code", async () => {
    const h = harness();
    const job = await claimed(h.store);

    const published = await runIndexJob(h.deps, job);

    expect(h.ports.calls).toEqual([
      "readSourceVersion",
      "runExtract",
      "drainProjection",
      "summarizeCommunities",
      "readSourceVersion",
    ]);
    expect(h.ports.selectors.map((call) => call.sourceRef)).toEqual([
      SOURCE_REF,
      SOURCE_REF,
      SOURCE_REF,
    ]);
    expect(published?.status).toBe(INDEX_JOB_STATUS.READY);
    expect(published?.failure_code).toBeNull();
    expect(published?.finished_at).toBe(FINISHED_AT);
    expect(published?.started_at).toBe(CLAIMED_AT);
    // Exactly one terminal write per claimed job, and it is the whole story.
    expect(h.publishes).toEqual([
      {
        status: INDEX_JOB_STATUS.READY,
        failureCode: null,
        finishedAt: FINISHED_AT,
        claimedStartedAt: CLAIMED_AT,
      },
    ]);
    expect(await h.store.getJob(job.job_id)).toEqual({
      ...job,
      status: INDEX_JOB_STATUS.READY,
      finished_at: FINISHED_AT,
      failure_code: null,
    });
  });

  it("publishes ready only after the summary stage returned", async () => {
    const h = harness();
    const job = await claimed(h.store);
    const order: string[] = [];
    h.ports.summarizeCommunities = async () => {
      order.push("summary-returned");
    };
    const publish = h.store.publishJobOutcome.bind(h.store);
    h.store.publishJobOutcome = (jobId, outcome) => {
      order.push(`publish:${outcome.status}`);
      return publish(jobId, outcome);
    };

    await runIndexJob(h.deps, job);

    expect(order).toEqual(["summary-returned", "publish:ready"]);
  });

  it("forwards the recorded extract switch and leaves an unrecorded one null", async () => {
    const recorded = harness({ source: version({ extractMethod: "fast" }) });
    const job = await claimed(recorded.store);
    await runIndexJob(recorded.deps, job);
    expect(recorded.ports.selectors[1]?.method).toBe("fast");

    const unrecorded = harness();
    const other = await claimed(unrecorded.store);
    await runIndexJob(unrecorded.deps, other);
    expect(unrecorded.ports.selectors[1]?.method).toBeNull();
  });

  it("logs the stage counts and the terminal state it published", async () => {
    const h = harness();
    const job = await claimed(h.store);

    await runIndexJob(h.deps, job);

    expect(h.logger.events).toContainEqual({
      name: "index-job-extract-stage",
      fields: { jobId: job.job_id, processed: 3, failed: 0 },
    });
    expect(h.logger.events).toContainEqual({
      name: "index-job-terminal",
      fields: {
        jobId: job.job_id,
        source_ref: job.source_ref,
        status: INDEX_JOB_STATUS.READY,
        failure_code: null,
        finished_at: FINISHED_AT,
      },
    });
  });
});

describe("index job runner extract stage", () => {
  it("carries the pipeline's own failure code verbatim and skips the graph stages", async () => {
    const h = harness({
      extract: {
        processed: 2,
        failed: 1,
        writeFailures: 0,
        failureCodes: ["FAST_EMPTY_GRAPH"],
      },
    });
    const job = await claimed(h.store);

    const published = await runIndexJob(h.deps, job);

    expect(published?.status).toBe(INDEX_JOB_STATUS.FAILED);
    expect(published?.failure_code).toBe("FAST_EMPTY_GRAPH");
    expect(h.ports.calls).toEqual(["readSourceVersion", "runExtract"]);
  });

  it("names a write-failure leg, which reports no code of its own", async () => {
    // The one fault is a rolled-back write: sealed failures are zero, so no
    // `failureCodes` entry exists, and the tally still indexed nothing.
    const h = harness({
      extract: { processed: 1, failed: 0, writeFailures: 1, failureCodes: [] },
    });
    const job = await claimed(h.store);

    expect((await runIndexJob(h.deps, job))?.failure_code).toBe(
      "WRITE_FAILURE"
    );
  });

  it("publishes the first sealed code when one batch failed more than once", async () => {
    const h = harness({
      extract: {
        processed: 3,
        failed: 2,
        writeFailures: 0,
        failureCodes: ["SELF_LOOP_REJECTED", "FAST_EMPTY_GRAPH"],
      },
    });
    const job = await claimed(h.store);

    expect((await runIndexJob(h.deps, job))?.failure_code).toBe(
      "SELF_LOOP_REJECTED"
    );
  });

  it("publishes the sealed code when a batch mixed it with a rolled-back leg", async () => {
    // The precedence `batchFailureCode` pins: a leg that rolled its transaction
    // back explains only that nothing persisted, while the sealed code names the
    // class an operator can act on, so the mixed batch must not degrade to
    // WRITE_FAILURE.
    const h = harness({
      extract: {
        processed: 2,
        failed: 1,
        writeFailures: 1,
        failureCodes: ["SELF_LOOP_REJECTED"],
      },
    });
    const job = await claimed(h.store);

    expect((await runIndexJob(h.deps, job))?.failure_code).toBe(
      "SELF_LOOP_REJECTED"
    );
  });

  it("publishes a typed extract-stage refusal", async () => {
    const h = harness({
      extractFault: new IndexJobStageError(
        "INDEX_JOB_EXTRACT_INCOMPLETE",
        "pending chunks remained"
      ),
    });
    const job = await claimed(h.store);

    const published = await runIndexJob(h.deps, job);

    expect(published?.status).toBe(INDEX_JOB_STATUS.FAILED);
    expect(published?.failure_code).toBe("INDEX_JOB_EXTRACT_INCOMPLETE");
    expect(h.ports.calls).toEqual(["readSourceVersion", "runExtract"]);
  });

  it("reaches ready for a source with nothing pending, which is a re-run", async () => {
    const h = harness({
      extract: { processed: 0, failed: 0, writeFailures: 0, failureCodes: [] },
    });
    const job = await claimed(h.store);

    expect((await runIndexJob(h.deps, job))?.status).toBe(
      INDEX_JOB_STATUS.READY
    );
  });
});

describe("index job runner version guard", () => {
  it("publishes stale, not failed, when the content identity moved on", async () => {
    const h = harness({ source: version({ contentIdentity: "identity-v2" }) });
    const job = await claimed(h.store);

    const published = await runIndexJob(h.deps, job);

    expect(published?.status).toBe(INDEX_JOB_STATUS.STALE);
    expect(published?.failure_code).toBeNull();
    expect(h.ports.calls).toEqual(["readSourceVersion"]);
  });

  it("treats a not-yet-backfilled NULL identity as a superseded version", async () => {
    const h = harness({
      source: version({ contentIdentity: null, extractMethod: "standard" }),
    });
    const job = await claimed(h.store);

    expect((await runIndexJob(h.deps, job))?.status).toBe(
      INDEX_JOB_STATUS.STALE
    );
  });

  it("fails with the submit tool's own unknown-source code and runs no stage", async () => {
    const h = harness({ source: null });
    const job = await claimed(h.store);

    const published = await runIndexJob(h.deps, job);

    expect(published?.status).toBe(INDEX_JOB_STATUS.FAILED);
    expect(published?.failure_code).toBe("index_job_unknown_source");
    expect(h.ports.calls).toEqual(["readSourceVersion"]);
  });

  it("publishes stale when a push supersedes the version mid-run", async () => {
    // A push is never blocked by an active job, so the row this worker claimed
    // can describe a content version that stopped being current while its
    // stages ran; the guard read again after them, before `ready`.
    const h = harness();
    const job = await claimed(h.store);
    const extract = h.ports.runExtract.bind(h.ports);
    h.ports.runExtract = async (sourceRef, method) => {
      h.ports.source = version({ contentIdentity: "identity-v2" });
      return extract(sourceRef, method);
    };

    const published = await runIndexJob(h.deps, job);

    expect(published?.status).toBe(INDEX_JOB_STATUS.STALE);
    expect(published?.failure_code).toBeNull();
    expect(h.publishes).toEqual([
      {
        status: INDEX_JOB_STATUS.STALE,
        failureCode: null,
        finishedAt: FINISHED_AT,
        claimedStartedAt: CLAIMED_AT,
      },
    ]);
  });
});

describe("index job runner graph stages", () => {
  it("publishes the projection's typed code and never reaches the summary", async () => {
    const h = harness({
      drainFault: new IndexJobStageError("NEO4J_UNAVAILABLE", "unreachable"),
    });
    const job = await claimed(h.store);

    const published = await runIndexJob(h.deps, job);

    expect(published?.status).toBe(INDEX_JOB_STATUS.FAILED);
    expect(published?.failure_code).toBe("NEO4J_UNAVAILABLE");
    expect(h.ports.calls).toEqual([
      "readSourceVersion",
      "runExtract",
      "drainProjection",
    ]);
    expect(h.publishes).toHaveLength(1);
  });

  it("publishes the summary failure token and never reports ready", async () => {
    const h = harness({
      summaryFault: new IndexJobStageError(
        "community_summary_index_failure",
        "swap never committed"
      ),
    });
    const job = await claimed(h.store);

    const published = await runIndexJob(h.deps, job);

    expect(published?.status).toBe(INDEX_JOB_STATUS.FAILED);
    expect(published?.failure_code).toBe("community_summary_index_failure");
    expect(h.publishes).toHaveLength(1);
    expect(h.publishes[0]?.status).not.toBe(INDEX_JOB_STATUS.READY);
  });

  it("leaves the row running and rethrows when a stage faults untyped", async () => {
    const h = harness({ drainFault: new Error("driver panic") });
    const job = await claimed(h.store);

    await expect(runIndexJob(h.deps, job)).rejects.toThrow("driver panic");

    // The stalled-lease arm is the recovery path: an internal fault is not a
    // product-level stage outcome, so the ledger keeps the row claimable.
    expect(h.publishes).toHaveLength(0);
    const row = await h.store.getJob(job.job_id);
    expect(row?.status).toBe(INDEX_JOB_STATUS.IN_PROGRESS);
    expect(row?.started_at).toBe(CLAIMED_AT);
    expect(row?.finished_at).toBeNull();
  });
});

describe("index job runner lease", () => {
  it("returns null and logs when another worker already settled the row", async () => {
    const h = harness();
    const job = await claimed(h.store);
    // The lost-lease arm is produced by the ledger itself: this row is no
    // longer in_progress by the time the runner reports.
    await h.store.publishJobOutcome(job.job_id, {
      status: INDEX_JOB_STATUS.FAILED,
      failureCode: "OTHER",
      finishedAt: "2026-09-26T00:06:00.000Z",
      claimedStartedAt: CLAIMED_AT,
    });

    const published = await runIndexJob(h.deps, job);

    expect(published).toBeNull();
    expect(h.logger.names()).toContain("index-job-lease-lost");
    const row = await h.store.getJob(job.job_id);
    expect(row?.status).toBe(INDEX_JOB_STATUS.FAILED);
    expect(row?.failure_code).toBe("OTHER");
    expect(row?.finished_at).toBe("2026-09-26T00:06:00.000Z");
  });
});

/**
 * The runner's half of the entity-merge embed cap (ADR-0013): the breach
 * publishes as a named terminal failure, a reclaimed job re-runs a fresh
 * lifecycle, and two lifecycles never share a counter.
 */
describe("index job runner and the entity-merge embed cap", () => {
  it("row 5: a budget refusal publishes failed with the entity-merge code", async () => {
    const h = harness({
      extractFault: new IndexJobStageError(
        ENTITY_MERGE_EMBED_LIMIT,
        "entity-merge embed cap reached: embed_calls=12 embed_cap=12"
      ),
    });
    const job = await claimed(h.store);

    const published = await runIndexJob(h.deps, job);

    // Named and terminal: the seed classifier branches on this literal, and a
    // cap refusal is retryable by an operator, not an internal fault to reclaim.
    expect(published?.status).toBe(INDEX_JOB_STATUS.FAILED);
    expect(published?.failure_code).toBe(ENTITY_MERGE_EMBED_LIMIT);
    const row = await h.store.getJob(job.job_id);
    expect(row?.failure_code).toBe(ENTITY_MERGE_EMBED_LIMIT);
    // The graph stages never run over a population the cap refused.
    expect(h.ports.calls).toEqual(["readSourceVersion", "runExtract"]);
  });

  it("row 6: a reclaimed job runs a fresh lifecycle over pending chunks only", async () => {
    // First attempt breaches; the row is settled as failed and the operator
    // re-queues it. The second lifecycle starts from the pending set again —
    // nothing about the spent counter survives, and a chunk the first
    // lifecycle already committed is out of scope for the new cap.
    const first = harness({
      extractFault: new IndexJobStageError(
        ENTITY_MERGE_EMBED_LIMIT,
        "entity-merge embed cap reached"
      ),
    });
    const firstJob = await claimed(first.store);
    await runIndexJob(first.deps, firstJob);

    const second = harness();
    const secondJob = await claimed(second.store);
    const published = await runIndexJob(second.deps, secondJob);

    expect(published?.status).toBe(INDEX_JOB_STATUS.READY);
    expect(published?.failure_code).toBeNull();
    // The fresh lifecycle asked for the same source and got a fresh run.
    expect(second.ports.selectors.map((call) => call.sourceRef)).toEqual([
      SOURCE_REF,
      SOURCE_REF,
      SOURCE_REF,
    ]);
  });

  it("row 7: two lifecycles in one process keep independent budgets", async () => {
    // The budget is per-lifecycle, never module state: a shared counter would
    // let one job's spend refuse the other's first resolution.
    const budget = createMergeEmbedBudget();
    const first = budget.fork();
    const second = budget.fork();

    first.arm(3);
    second.arm(5);
    first.countResolution();
    first.countResolution();
    second.countResolution();

    expect(first.snapshot()).toEqual({ embedCap: 3, embedCalls: 2 });
    expect(second.snapshot()).toEqual({ embedCap: 5, embedCalls: 1 });
    // Neither one exhausted the shared owner, and the owner itself is unarmed:
    // it holds no cap of its own to leak into a lifecycle.
    expect(budget.snapshot()).toEqual({ embedCap: null, embedCalls: 0 });
    // The fourth charge on `first` is the one that refuses, on its own cap.
    first.countResolution();
    expect(() => first.countResolution()).toThrow(MergeEmbedLimitError);
    expect(() => second.countResolution()).not.toThrow();
    expect(second.snapshot()).toEqual({ embedCap: 5, embedCalls: 2 });
  });
});
