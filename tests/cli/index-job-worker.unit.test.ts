/**
 * Index-job worker CLI (`src/cli/index-job-worker.ts`) — argv, the claim loop,
 * the session lock, and the stage adapters, all over fakes.
 *
 * No live service is reached from this file. The claim loop runs against the
 * REAL production ledger (`MemoryBackend`, the pg ledger's memory twin) behind a
 * thin recording decorator, because what is under test is exactly what the loop
 * promises the queue: keep claiming until the answer is empty, settle every row
 * it claimed, and leave a row that could not be settled running so the
 * stalled-lease arm can hand it out again. A hand-rolled store could not prove
 * the last two.
 *
 * Exit codes are asserted as documented: 0 drained clean, 1 fatal or a job left
 * unsettled, 2 usage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  COMMUNITY_SUMMARY_NOT_CONFIGURED,
  createIndexJobStagePorts,
  createSessionAdvisoryLock,
  EXTRACT_ROUND_CEILING,
  INDEX_JOB_EXTRACT_INCOMPLETE,
  JOB_SERIALIZATION_KEY,
  PROJECTION_DRAIN_FAILURE,
  parseArgs,
  runCli,
  runCliFromEnv,
  type IndexJobLock,
  type IndexJobLockHandle,
  type IndexJobWorkerDeps,
  type StageAdapterDeps,
  type WorkerClient,
  type WorkerPool,
} from "../../src/cli/index-job-worker.js";
import {
  IndexJobStageError,
  type IndexJobExtractOutcome,
  type IndexJobSourceVersion,
  type IndexJobStagePorts,
} from "../../src/core/index-job.js";
import { INVALID_EXTRACT_METHOD_CODE } from "../../src/core/extraction/method.js";
import {
  COMMUNITY_SUMMARY_INDEX_FAILURE,
  INDEX_JOB_STATUS,
  type ExtractMethod,
  type IndexJobClaimOptions,
  type IndexJobRecord,
  type IndexJobStore,
  type IndexJobTerminalOutcome,
} from "../../src/core/types.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { advisoryLockKey } from "../../src/core/storage/schema-lock.js";
import {
  GRAPH_UNAVAILABLE_CODE,
  GraphUnavailableError,
  type GraphWriter,
} from "../../src/core/graph/types.js";
import { CommunitySummaryJobError } from "../../src/cli/community-summary.js";
import { runCli as runCommunitySummaryCli } from "../../src/cli/community-summary.js";
import type { CommunitySummaryDeps } from "../../src/cli/community-summary.js";
import type { DrainDeps } from "../../src/cli/graph-drain.js";
import {
  ConfigError,
  setSettingHomeForTests,
  type LogLevel,
} from "../../src/config.js";
import {
  processBatch,
  selectPendingChunksBySourceRef,
  type BatchSummary,
  type ExtractPipelineDeps,
} from "../../src/core/extraction/pipeline.js";
import type { Logger } from "../../src/logging.js";

/** The summary CLI's exit decision is faked at its own seam: the mapping to a
 * job code is what this file owns, and the real job needs Neo4j plus an LLM. */
vi.mock("../../src/cli/community-summary.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/cli/community-summary.js")>();
  return { ...actual, runCli: vi.fn() };
});

/** The extract stage's two calls are faked at the same seam: the pipeline has
 * its own suite, and what belongs to this file is the rescan rule — when to
 * take another round, when to stop, and when to refuse instead of truncating. */
vi.mock("../../src/core/extraction/pipeline.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/core/extraction/pipeline.js")
    >();
  return {
    ...actual,
    selectPendingChunksBySourceRef: vi.fn(),
    processBatch: vi.fn(),
  };
});

const SOURCE_A = "doc-1/1/main";
const SOURCE_B = "doc-2/1/main";
const IDENTITY_A = `identity:${SOURCE_A}`;
const IDENTITY_B = `identity:${SOURCE_B}`;
const T0 = Date.parse("2026-09-26T00:10:00.000Z");
const LEASE_MS = 60_000;

function identityFor(sourceRef: string): string {
  return `identity:${sourceRef}`;
}

function queuedJob(overrides: Partial<IndexJobRecord>): IndexJobRecord {
  return {
    job_id: "job-1",
    source_ref: SOURCE_A,
    content_identity: IDENTITY_A,
    status: INDEX_JOB_STATUS.IN_PROGRESS,
    created_at: "2026-09-26T00:00:00.000Z",
    started_at: null,
    finished_at: null,
    failure_code: null,
    ...overrides,
  };
}

/** A second queued row for the same queue, older or newer by `created_at`. */
function secondQueuedJob(): IndexJobRecord {
  return queuedJob({
    job_id: "job-2",
    source_ref: SOURCE_B,
    content_identity: IDENTITY_B,
    created_at: "2026-09-26T00:00:01.000Z",
  });
}

/** The production ledger plus the two sequences the loop assertions need. */
function ledger() {
  const backend = new MemoryBackend(1);
  const publishes: IndexJobTerminalOutcome[] = [];
  const claims: IndexJobClaimOptions[] = [];
  const store: IndexJobStore = {
    insertJobOrJoin: (record) => backend.insertJobOrJoin(record),
    getJob: (jobId) => backend.getJob(jobId),
    getActiveJobForSource: (sourceRef) =>
      backend.getActiveJobForSource(sourceRef),
    supersedeReadyJobs: (sourceRef) => backend.supersedeReadyJobs(sourceRef),
    claimNextJob: async (options) => {
      claims.push({ ...options });
      return await backend.claimNextJob(options);
    },
    publishJobOutcome: async (jobId, outcome) => {
      publishes.push(outcome);
      return await backend.publishJobOutcome(jobId, outcome);
    },
  };
  return { backend, store, publishes, claims };
}

class FakePorts implements IndexJobStagePorts {
  readonly calls: string[] = [];
  source: (sourceRef: string) => IndexJobSourceVersion | null = (
    sourceRef
  ) => ({
    contentIdentity: identityFor(sourceRef),
    extractMethod: null,
  });
  extract: (sourceRef: string) => IndexJobExtractOutcome = () => ({
    processed: 2,
    failed: 0,
    writeFailures: 0,
    failureCodes: [],
  });
  extractFault?: (sourceRef: string) => unknown;
  drainFault?: unknown;
  summaryFault?: unknown;

  async readSourceVersion(
    sourceRef: string
  ): Promise<IndexJobSourceVersion | null> {
    this.calls.push(`readSourceVersion:${sourceRef}`);
    return this.source(sourceRef);
  }

  async runExtract(
    sourceRef: string,
    method: ExtractMethod | null
  ): Promise<IndexJobExtractOutcome> {
    this.calls.push(`runExtract:${sourceRef}:${method ?? "unrecorded"}`);
    const fault = this.extractFault?.(sourceRef);
    if (fault !== undefined) throw fault;
    return this.extract(sourceRef);
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
  readonly logs: { level: string; msg: string; fields?: unknown }[] = [];
  debug(msg: string, fields?: unknown): void {
    this.logs.push({ level: "debug", msg, fields });
  }
  info(msg: string, fields?: unknown): void {
    this.logs.push({ level: "info", msg, fields });
  }
  warn(msg: string, fields?: unknown): void {
    this.logs.push({ level: "warn", msg, fields });
  }
  error(msg: string, fields?: unknown): void {
    this.logs.push({ level: "error", msg, fields });
  }
  names(): string[] {
    return this.logs.map((entry) => entry.msg);
  }
}

class FakeLockHandle implements IndexJobLockHandle {
  released = 0;
  async release(): Promise<void> {
    this.released += 1;
  }
}

class FakeLock implements IndexJobLock {
  readonly keys: string[] = [];
  readonly handles: FakeLockHandle[] = [];
  constructor(private readonly fault?: Error) {}
  async acquire(key: string): Promise<IndexJobLockHandle> {
    this.keys.push(key);
    if (this.fault !== undefined) throw this.fault;
    const handle = new FakeLockHandle();
    this.handles.push(handle);
    return handle;
  }
}

function workerDeps(
  store: IndexJobStore,
  ports: FakePorts,
  options: {
    logger?: RecordingLogger;
    lock?: FakeLock;
    clockMs?: number;
  } = {}
): IndexJobWorkerDeps {
  return {
    store,
    ports,
    logger: options.logger ?? new RecordingLogger(),
    lock: options.lock ?? new FakeLock(),
    clock: () => new Date(options.clockMs ?? T0),
  };
}

function captureStderr(): { text: () => string; restore: () => void } {
  let output = "";
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      output += String(chunk);
      return true;
    });
  return { text: () => output, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** A pool whose every statement answers with the rows a test installs. */
class FakeDbClient {
  readonly queries: { text: string; values: unknown[] }[] = [];
  rows: unknown[] = [];
  async query(
    text: string,
    values: unknown[] = []
  ): Promise<{ rows: unknown[] }> {
    this.queries.push({ text, values });
    return { rows: this.rows };
  }
  release(): void {}
}

function fakeDbPool(client: FakeDbClient): WorkerPool {
  return {
    async connect(): Promise<WorkerClient> {
      return client as unknown as WorkerClient;
    },
    async end(): Promise<void> {},
  };
}

const emptyGraphWriter: GraphWriter = {
  async ensureConstraints(): Promise<void> {},
  async mergeNodes(): Promise<void> {},
  async mergeEdges(): Promise<void> {},
  async deleteNodes(): Promise<void> {},
  async deleteEdges(): Promise<void> {},
  async close(): Promise<void> {},
};

function drainDepsThatFailWith(fault: unknown): DrainDeps {
  return {
    pool: fakeDbPool(new FakeDbClient()) as unknown as DrainDeps["pool"],
    logger: new RecordingLogger(),
    connectGraph: async (): Promise<GraphWriter> => {
      throw fault;
    },
  };
}

function adapters(over: Partial<StageAdapterDeps> = {}): IndexJobStagePorts {
  const logger = new RecordingLogger();
  return createIndexJobStagePorts({
    pool: fakeDbPool(new FakeDbClient()),
    pipelineDeps: { logger } as unknown as ExtractPipelineDeps,
    batchLimit: 5,
    drainDeps: {
      pool: fakeDbPool(new FakeDbClient()) as unknown as DrainDeps["pool"],
      logger,
      connectGraph: async () => emptyGraphWriter,
    },
    summaryDeps: undefined,
    ...over,
  });
}

describe("index job worker argv surface", () => {
  it("parses the documented flags", () => {
    const bare = parseArgs([]);
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      expect(bare.options.once).toBe(false);
      expect(bare.options.stalledAfterMs).toBe(15 * 60 * 1000);
    }
    expect(parseArgs(["--once"]).ok).toBe(true);
    const stalled = parseArgs(["--once", "--stalled-after", "60000"]);
    expect(
      stalled.ok && {
        once: stalled.options.once,
        ms: stalled.options.stalledAfterMs,
      }
    ).toEqual({ once: true, ms: 60000 });
  });

  it.each([
    { argv: ["--stalled-after"], why: "a value", mentions: "--stalled-after" },
    {
      argv: ["--stalled-after", "0"],
      why: "a positive value",
      mentions: "--stalled-after",
    },
    {
      argv: ["--stalled-after", "-5"],
      why: "a positive value",
      mentions: "--stalled-after",
    },
    {
      argv: ["--stalled-after", "abc"],
      why: "an integer",
      mentions: "--stalled-after",
    },
    {
      argv: ["--stalled-after", "1.5"],
      why: "an integer",
      mentions: "--stalled-after",
    },
    { argv: ["--nope"], why: "an unknown flag", mentions: "--nope" },
  ])("rejects $argv because a flag needs $why", ({ argv, mentions }) => {
    const parsed = parseArgs(argv);
    expect(parsed.ok).toBe(false);
    // Naming the offending flag is what makes a usage error actionable.
    if (!parsed.ok) expect(parsed.error).toContain(mentions);
  });

  it("exits 2 with the usage line and never claims", async () => {
    const stderr = captureStderr();
    const { store, claims } = ledger();

    expect(
      await runCli(["--nonsense"], workerDeps(store, new FakePorts()))
    ).toBe(2);
    expect(stderr.text()).toContain("usage: index-job-worker");
    expect(claims).toEqual([]);
    stderr.restore();
  });
});

describe("index job worker claim loop", () => {
  it("drains the queue to empty, serializing every job under one key", async () => {
    const { store, publishes, claims } = ledger();
    await store.insertJobOrJoin(queuedJob({}));
    await store.insertJobOrJoin(secondQueuedJob());
    const logger = new RecordingLogger();
    const lock = new FakeLock();

    expect(
      await runCli([], workerDeps(store, new FakePorts(), { logger, lock }))
    ).toBe(0);

    // Two jobs ran, then the claim that answered empty and ended the run.
    expect(claims).toHaveLength(3);
    expect(publishes.map((p) => p.status)).toEqual([
      INDEX_JOB_STATUS.READY,
      INDEX_JOB_STATUS.READY,
    ]);
    expect(lock.keys).toEqual([JOB_SERIALIZATION_KEY, JOB_SERIALIZATION_KEY]);
    expect(lock.handles.map((handle) => handle.released)).toEqual([1, 1]);
    expect(logger.logs.at(-1)?.msg).toBe("index-job-worker-drained");
  });

  it("claims at most one job with --once and leaves the rest queued", async () => {
    const { backend, store, claims } = ledger();
    await store.insertJobOrJoin(queuedJob({}));
    await store.insertJobOrJoin(secondQueuedJob());

    expect(await runCli(["--once"], workerDeps(store, new FakePorts()))).toBe(
      0
    );

    expect(claims).toHaveLength(1);
    const untouched = await backend.getJob("job-2");
    expect(untouched?.status).toBe(INDEX_JOB_STATUS.IN_PROGRESS);
    expect(untouched?.started_at).toBeNull();
  });

  it("hands the claim the lease window the flag names", async () => {
    const { store, claims } = ledger();

    expect(
      await runCli(
        ["--stalled-after", "5000"],
        workerDeps(store, new FakePorts())
      )
    ).toBe(0);

    expect(claims).toEqual([
      {
        startedAt: new Date(T0).toISOString(),
        stalledBefore: new Date(T0 - 5000).toISOString(),
      },
    ]);
  });

  it("keeps going after a typed stage failure", async () => {
    const { store, publishes } = ledger();
    await store.insertJobOrJoin(queuedJob({}));
    await store.insertJobOrJoin(secondQueuedJob());
    const ports = new FakePorts();
    ports.extractFault = (sourceRef) =>
      sourceRef === SOURCE_A
        ? new IndexJobStageError(INDEX_JOB_EXTRACT_INCOMPLETE, "round ceiling")
        : undefined;

    expect(await runCli([], workerDeps(store, ports))).toBe(0);

    expect(publishes.map((p) => [p.status, p.failureCode])).toEqual([
      [INDEX_JOB_STATUS.FAILED, INDEX_JOB_EXTRACT_INCOMPLETE],
      [INDEX_JOB_STATUS.READY, null],
    ]);
  });

  it("reports a lost lease without retrying and still exits clean", async () => {
    const stderr = captureStderr();
    const logger = new RecordingLogger();
    let grants = 1;
    const job = queuedJob({});
    const store: IndexJobStore = {
      insertJobOrJoin: async () => ({ record: job, inserted: true }),
      getJob: async () => job,
      getActiveJobForSource: async () => job,
      supersedeReadyJobs: async () => 0,
      claimNextJob: async () => (grants-- > 0 ? job : null),
      publishJobOutcome: async () => null,
    };
    const ports = new FakePorts();
    const lock = new FakeLock();

    expect(await runCli([], workerDeps(store, ports, { logger, lock }))).toBe(
      0
    );

    expect(logger.names()).toContain("index-job-lease-lost");
    // The stages did run for the claimed row; only its verdict was dropped.
    expect(ports.calls).toContain(`runExtract:${SOURCE_A}:unrecorded`);
    expect(lock.handles.map((handle) => handle.released)).toEqual([1]);
    expect(stderr.text()).toBe("");
    stderr.restore();
  });

  it("leaves a row running after an untyped fault until its lease passes", async () => {
    const stderr = captureStderr();
    const logger = new RecordingLogger();
    const { backend, store, publishes } = ledger();
    await store.insertJobOrJoin(queuedJob({}));
    const ports = new FakePorts();
    ports.extractFault = () => new Error("connection reset by peer");

    expect(
      await runCli(
        ["--stalled-after", String(LEASE_MS)],
        workerDeps(store, ports, { clockMs: T0, logger })
      )
    ).toBe(1);
    expect(stderr.text()).toContain("without a published outcome");
    expect(stderr.text()).toContain(`reclaimable after ${LEASE_MS}ms`);
    // The runbook points an operator at one report line PER unsettled job, so
    // the event name and its `jobId` are the greppable contract: the drained
    // line carries only the counts and cannot name which row is stuck.
    expect(logger.logs).toContainEqual({
      level: "error",
      msg: "index-job-unsettled",
      fields: { jobId: "job-1", error: "connection reset by peer" },
    });
    expect(logger.logs).toContainEqual({
      level: "info",
      msg: "index-job-worker-drained",
      fields: { claimed: 1, unsettled: 1 },
    });
    expect(publishes).toEqual([]);
    const crashed = await backend.getJob("job-1");
    expect(crashed?.status).toBe(INDEX_JOB_STATUS.IN_PROGRESS);
    expect(crashed?.started_at).toBe(new Date(T0).toISOString());
    expect(crashed?.finished_at).toBeNull();

    // Inside the lease window no worker may take the row, so the queue is empty.
    ports.extractFault = undefined;
    expect(
      await runCli(
        ["--stalled-after", String(LEASE_MS)],
        workerDeps(store, ports, { clockMs: T0 + 1000 })
      )
    ).toBe(0);
    expect(publishes).toEqual([]);

    // Past the window the same row is handed out again and settles.
    expect(
      await runCli(
        ["--stalled-after", String(LEASE_MS)],
        workerDeps(store, ports, { clockMs: T0 + LEASE_MS + 1000 })
      )
    ).toBe(0);
    expect(publishes.map((p) => p.status)).toEqual([INDEX_JOB_STATUS.READY]);
    expect((await backend.getJob("job-1"))?.status).toBe(
      INDEX_JOB_STATUS.READY
    );
    stderr.restore();
  });

  it("ends the run loudly when the serialization lock cannot be taken", async () => {
    const stderr = captureStderr();
    const { backend, store, publishes, claims } = ledger();
    await store.insertJobOrJoin(queuedJob({}));
    const deps = workerDeps(store, new FakePorts(), {
      lock: new FakeLock(new Error("connection lost")),
    });

    expect(await runCli([], deps)).toBe(1);

    expect(stderr.text()).toContain("index-job-worker fatal: connection lost");
    expect(publishes).toEqual([]);
    // The claim already marked it running, so the row stays reclaimable.
    expect(claims).toHaveLength(1);
    expect((await backend.getJob("job-1"))?.started_at).toBe(
      new Date(T0).toISOString()
    );
    stderr.restore();
  });
});

describe("createSessionAdvisoryLock", () => {
  class FakeClient implements WorkerClient {
    readonly queries: { text: string; values: unknown[] }[] = [];
    /**
     * Every `release` call and the error it carried: pg removes a pooled client
     * from circulation only when the release is an error, so this is the whole
     * of what the discard path promises.
     */
    readonly releases: (Error | undefined)[] = [];
    constructor(private readonly unlockFault = false) {}
    async query(
      text: string,
      values: unknown[] = []
    ): Promise<{ rows: unknown[] }> {
      this.queries.push({ text, values });
      if (
        text.includes("pg_advisory_lock") &&
        values[0] === advisoryLockKey("boom").toString()
      )
        throw new Error("acquire refused");
      if (text.includes("pg_advisory_unlock") && this.unlockFault)
        throw new Error("unlock refused");
      return { rows: [] };
    }
    release(err?: Error): void {
      this.releases.push(err);
    }
  }

  function fakePool(client: FakeClient): WorkerPool {
    return {
      async connect(): Promise<WorkerClient> {
        return client;
      },
      async end(): Promise<void> {},
    };
  }

  it("holds one connection for the whole job and returns it after the unlock", async () => {
    const client = new FakeClient();
    const lock = createSessionAdvisoryLock(
      fakePool(client),
      new RecordingLogger()
    );

    const handle = await lock.acquire(JOB_SERIALIZATION_KEY);
    await handle.release();

    expect(client.queries.map((query) => query.text)).toEqual([
      "SELECT pg_advisory_lock($1::bigint)",
      "SELECT pg_advisory_unlock($1::bigint)",
    ]);
    expect(client.queries[0]?.values).toEqual([
      advisoryLockKey(JOB_SERIALIZATION_KEY).toString(),
    ]);
    expect(client.releases).toEqual([undefined]);
  });

  it("discards the pooled connection when the unlock itself fails", async () => {
    const logger = new RecordingLogger();
    const client = new FakeClient(true);
    const lock = createSessionAdvisoryLock(fakePool(client), logger);

    const handle = await lock.acquire(JOB_SERIALIZATION_KEY);
    await handle.release();

    expect(client.releases).toHaveLength(1);
    expect(client.releases[0]).toBeInstanceOf(Error);
    expect(String(client.releases[0]?.message)).toContain("advisory unlock");
    expect(logger.names()).toContain("index-job-lock-unlock-failed");
  });

  it("returns the connection when the acquire fails", async () => {
    const client = new FakeClient();
    const lock = createSessionAdvisoryLock(
      fakePool(client),
      new RecordingLogger()
    );

    await expect(lock.acquire("boom")).rejects.toThrow("acquire refused");
    expect(client.releases).toEqual([undefined]);
  });
});

describe("index job stage adapters", () => {
  it("maps a clean drain onto a resolved stage", async () => {
    await expect(adapters().drainProjection()).resolves.toBeUndefined();
  });

  it("re-arms failed intents before it opens the projection target", async () => {
    // A `failed` intent is outside the pending scan, so a drain that ran
    // without this pre-pass could report an empty queue and exit clean while an
    // earlier leg's projection never landed.
    const order: string[] = [];
    const logger = new RecordingLogger();
    const ports = adapters({
      drainDeps: {
        pool: fakeDbPool(new FakeDbClient()) as unknown as DrainDeps["pool"],
        logger: {
          ...logger,
          info: (msg: string, fields?: unknown) => {
            if (msg === "graph-drain-retry-armed") order.push("rearm");
            logger.info(msg, fields);
          },
        },
        connectGraph: async () => {
          order.push("open-target");
          return emptyGraphWriter;
        },
      } as unknown as DrainDeps,
    });

    await ports.drainProjection();
    expect(order).toEqual(["rearm", "open-target"]);
  });

  it("refuses the stage when the re-arm itself does not complete", async () => {
    const reArmSql = "SET status = 'pending'";
    const ports = adapters({
      drainDeps: {
        pool: {
          connect: async () => ({
            query: async (text: string) => {
              if (text.includes(reArmSql)) throw new Error("re-arm refused");
              return { rows: [] };
            },
            release: () => {},
          }),
        },
        logger: new RecordingLogger(),
        connectGraph: async () => emptyGraphWriter,
      } as unknown as DrainDeps,
    });

    await expect(ports.drainProjection()).rejects.toMatchObject({
      failureCode: PROJECTION_DRAIN_FAILURE,
    });
  });

  it("maps an unreachable Neo4j onto the projection's own unavailable code", async () => {
    const stderr = captureStderr();
    const ports = adapters({
      drainDeps: drainDepsThatFailWith(
        new GraphUnavailableError("bolt://x", new Error("refused"))
      ),
    });

    await expect(ports.drainProjection()).rejects.toMatchObject({
      failureCode: GRAPH_UNAVAILABLE_CODE,
    });
    // The nested CLI's own operator report is not swallowed by the mapping.
    expect(stderr.text()).toContain("graph-drain:");
    stderr.restore();
  });

  it("maps an unconfigured projection target onto PROJECTION_DRAIN_FAILURE", async () => {
    const stderr = captureStderr();
    const ports = adapters({
      drainDeps: drainDepsThatFailWith(new ConfigError("no neo4j configured")),
    });

    await expect(ports.drainProjection()).rejects.toMatchObject({
      failureCode: PROJECTION_DRAIN_FAILURE,
    });
    expect(stderr.text()).toContain("graph-drain fatal:");
    stderr.restore();
  });

  it("answers a summary stage the deployment cannot run with the runner's own code", async () => {
    await expect(adapters().summarizeCommunities()).rejects.toMatchObject({
      failureCode: COMMUNITY_SUMMARY_NOT_CONFIGURED,
    });
    expect(runCommunitySummaryCli).not.toHaveBeenCalled();
  });

  it("maps the summary job's own typed failure onto the index failure code", async () => {
    vi.mocked(runCommunitySummaryCli).mockRejectedValue(
      new CommunitySummaryJobError("persist", "swap refused", new Error("x"))
    );
    const ports = adapters({
      summaryDeps: {} as unknown as CommunitySummaryDeps,
    });

    await expect(ports.summarizeCommunities()).rejects.toMatchObject({
      failureCode: COMMUNITY_SUMMARY_INDEX_FAILURE,
    });
  });

  it("throws untyped for a summary exit the CLI cannot explain", async () => {
    // `runCli` answers non-zero only for a usage error, and this call site
    // passes no argv: an unexplained exit is a worker defect, which must leave
    // the claimed row running rather than read as a product-level stage failure.
    vi.mocked(runCommunitySummaryCli).mockResolvedValue(2);
    const ports = adapters({
      summaryDeps: {} as unknown as CommunitySummaryDeps,
    });

    await expect(ports.summarizeCommunities()).rejects.toThrow(
      /community summary CLI exited 2/
    );
  });

  it("maps a summary run that exited clean onto a resolved stage", async () => {
    vi.mocked(runCommunitySummaryCli).mockResolvedValue(0);
    const ports = adapters({
      summaryDeps: {} as unknown as CommunitySummaryDeps,
    });

    await expect(ports.summarizeCommunities()).resolves.toBeUndefined();
  });

  it("reads only the two 资料 fields the runner decides on", async () => {
    const client = new FakeDbClient();
    client.rows = [{ content_identity: "abc", extract_method: "fast" }];
    const ports = adapters({ pool: fakeDbPool(client) });

    await expect(ports.readSourceVersion(SOURCE_A)).resolves.toEqual({
      contentIdentity: "abc",
      extractMethod: "fast",
    });
    expect(client.queries[0]?.text).toContain("content_identity");
    expect(client.queries[0]?.values).toEqual([SOURCE_A]);
  });

  it("fails the typed stage error on a recorded switch outside the vocabulary", async () => {
    // WHY this is not folded onto "unrecorded": a junk value names no method
    // that can safely re-extract the version, so the job must carry the method
    // module's own code for a value outside {standard, fast} — the runner
    // forwards it rather than renaming it, and never reroutes onto standard.
    const client = new FakeDbClient();
    client.rows = [{ content_identity: "abc", extract_method: "turbo" }];
    const ports = adapters({ pool: fakeDbPool(client) });

    await expect(ports.readSourceVersion(SOURCE_A)).rejects.toMatchObject({
      failureCode: INVALID_EXTRACT_METHOD_CODE,
      message: 'unknown extract method "turbo": expected standard or fast',
    });
  });

  it("answers a source with no 资料 row as null, not as an empty version", async () => {
    const ports = adapters();
    await expect(ports.readSourceVersion(SOURCE_A)).resolves.toBeNull();
  });
});

describe("index job extract stage", () => {
  const scan = vi.mocked(selectPendingChunksBySourceRef);
  const batch = vi.mocked(processBatch);
  const oneChunk = {
    chunks: [{ id: "chunk-1", content: "text" }],
    hasMore: true,
  };

  function summary(over: Partial<BatchSummary> = {}): BatchSummary {
    return {
      batchId: "batch-1",
      processed: 1,
      succeeded: 1,
      failed: 0,
      writeFailures: 0,
      ungrounded: 0,
      failureCodes: [],
      ...over,
    };
  }

  beforeEach(() => {
    scan.mockReset();
    batch.mockReset();
  });

  it("takes another round while the scan says more chunks remain", async () => {
    scan
      .mockResolvedValueOnce(oneChunk)
      .mockResolvedValueOnce({ ...oneChunk, hasMore: false });
    batch.mockResolvedValue(summary());

    await expect(adapters().runExtract(SOURCE_A, null)).resolves.toEqual({
      processed: 2,
      failed: 0,
      writeFailures: 0,
      failureCodes: [],
    });
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("caps the scan and forwards the recorded switch to the pipeline", async () => {
    scan.mockResolvedValue({ ...oneChunk, hasMore: false });
    batch.mockResolvedValue(summary());

    await adapters().runExtract(SOURCE_A, "fast");

    expect(scan.mock.calls[0]?.slice(1)).toEqual([SOURCE_A, 5]);
    expect(batch.mock.calls[0]?.[3]).toEqual({ batchSize: 5, method: "fast" });
  });

  it("sends no switch when the source never recorded one", async () => {
    scan.mockResolvedValue({ ...oneChunk, hasMore: false });
    batch.mockResolvedValue(summary());

    await adapters().runExtract(SOURCE_A, null);

    expect(batch.mock.calls[0]?.[3]).toEqual({ batchSize: 5 });
  });

  it("stops rescanning the moment a leg fails", async () => {
    // A rolled-back write leaves its chunk pending, so re-scanning would hand
    // back the same batch: the stage reports the failure and stops.
    scan.mockResolvedValue(oneChunk);
    batch.mockResolvedValue(
      summary({ failed: 1, succeeded: 0, failureCodes: ["FAST_EMPTY_GRAPH"] })
    );

    await expect(adapters().runExtract(SOURCE_A, null)).resolves.toEqual({
      processed: 1,
      failed: 1,
      writeFailures: 0,
      failureCodes: ["FAST_EMPTY_GRAPH"],
    });
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("counts a rolled-back write leg as a failure of the stage", async () => {
    // The pipeline keeps `writeFailures` apart from `failed` because a rolled
    // back leg sealed no record and so carries no code — but the leg indexed
    // nothing and left its chunk pending, so the stage stops rescanning on the
    // total `notIndexed` answers, and the tally it returns still shows the leg
    // (the runner's `batchFailureCode` gate then names WRITE_FAILURE for the
    // job): a batch of rolled-back legs must not read as a clean drain and let
    // the job publish `ready`.
    scan.mockResolvedValue(oneChunk);
    batch.mockResolvedValue(summary({ succeeded: 0, writeFailures: 1 }));

    await expect(adapters().runExtract(SOURCE_A, null)).resolves.toEqual({
      processed: 1,
      failed: 0,
      writeFailures: 1,
      failureCodes: [],
    });
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("refuses with a typed code rather than finishing over an unindexed remainder", async () => {
    scan.mockResolvedValue(oneChunk);
    batch.mockResolvedValue(summary());

    await expect(adapters().runExtract(SOURCE_A, null)).rejects.toMatchObject({
      failureCode: INDEX_JOB_EXTRACT_INCOMPLETE,
    });
    expect(scan).toHaveBeenCalledTimes(EXTRACT_ROUND_CEILING);
  });
});

describe("runCliFromEnv", () => {
  const WORKER_ENV_KEYS = [
    "GRAPHRAG_MEMORY_DB_URL",
    "GRAPHRAG_MEMORY_NEO4J_URI",
    "GRAPHRAG_MEMORY_NEO4J_USER",
    "GRAPHRAG_MEMORY_NEO4J_PASSWORD",
    // ADR-0006 / ADR-0007 fail-start knobs: this suite boots with no sidecars,
    // so the default-on switches must be explicitly off or loadEnv refuses
    // before the worker's own config report can be observed.
    "GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED",
    "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED",
    "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL",
    "GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED",
    "GRAPHRAG_MEMORY_EMBED_DIMENSIONS",
    "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS",
    "GRAPHRAG_MEMORY_EMBED_BASE_URL",
    "GRAPHRAG_MEMORY_EMBED_MODEL",
    "GRAPHRAG_MEMORY_EMBED_API_KEY",
    "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV",
    "GRAPHRAG_MEMORY_VECTOR_API_KEY",
    "GRAPHRAG_MEMORY_ANTHROPIC_API_KEY",
    "GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL",
    "GRAPHRAG_MEMORY_ANTHROPIC_MODEL",
    "ANTHROPIC_AUTH_TOKEN",
  ] as const;

  const BOOT = {
    GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED: "false",
    GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "false",
    GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED: "false",
    GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
    GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "2000",
  };

  async function withScrubbedEnv<T>(
    settings: Record<string, string>,
    fn: () => Promise<T>
  ): Promise<T> {
    const saved = new Map<string, string | undefined>();
    for (const key of WORKER_ENV_KEYS) {
      saved.set(key, process.env[key]);
      process.env[key] = "";
    }
    for (const [key, value] of Object.entries(settings)) {
      process.env[key] = value;
    }
    const settingHome = mkdtempSync(
      join(tmpdir(), "iknow-index-worker-setting-")
    );
    setSettingHomeForTests(settingHome);
    try {
      return await fn();
    } finally {
      setSettingHomeForTests(null);
      rmSync(settingHome, { recursive: true, force: true });
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("refuses to start without the memory database", async () => {
    const stderr = captureStderr();

    const exit = await withScrubbedEnv(BOOT, () => runCliFromEnv([]));

    expect(exit).toBe(1);
    expect(stderr.text()).toContain("GRAPHRAG_MEMORY_DB_URL is required");
    stderr.restore();
  });

  it("names a missing LLM credential without dialling Postgres", async () => {
    const stderr = captureStderr();
    const connect = vi
      .spyOn(Pool.prototype, "connect")
      .mockImplementation(async () => {
        throw new Error(
          "the worker must not open a connection before its config check"
        );
      });

    const exit = await withScrubbedEnv(
      { ...BOOT, GRAPHRAG_MEMORY_DB_URL: "postgres://invalid.test:1/none" },
      () => runCliFromEnv([])
    );

    expect(exit).toBe(1);
    expect(stderr.text()).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(connect).not.toHaveBeenCalled();
    stderr.restore();
  });
});
