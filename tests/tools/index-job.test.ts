/**
 * Unit + wire tests for the durable index-job MCP tools
 * (`src/tools/index-job.ts`: `submit_index_job`, `poll_index_job`).
 *
 * Test-fidelity rule for this file: every ledger the handlers write to is a
 * REAL `MemoryBackend` (the production `IndexJobStore`), never a hand-rolled
 * copy that could drift from the storage semantics it claims to mirror. Where a
 * scenario needs ordering or "no traffic" evidence, a thin recording decorator
 * wraps the real backend, records the call sequence, and delegates every read
 * and write to it — so ledger-state assertions always run on backend truth.
 * The read-port adapter `submit` uses comes from the exported production seam
 * factory `buildIndexJobSeams` (same reason `buildRetrieveDeps` /
 * `buildExtractDeps` are exported), not a re-implementation.
 *
 * Wire shape under test:
 *   submit input  { source_ref, content_identity }   non-empty, code-point
 *                 ceiling `SOURCE_READ_MAX_LOCATOR_CODE_POINTS` (the one
 *                 locator domain `read_source` enforces — imported, not
 *                 restated, so push/submit/read agree on carryable)
 *   submit success { job_id, source_ref, content_identity, status,
 *                    started_at, reused }            `reused` = the STORE's
 *                 verdict (false only for a freshly inserted row)
 *   poll input    { job_id }                         same ceiling
 *   poll success  the persisted row + a SEPARATE `community_index_state`
 *                 sub-object { status, failure_code } (null when the singleton
 *                 row has never been written) — the two statuses are distinct
 *                 facts and are never merged.
 *   errors        isError true + one named body: index_job_invalid_locator
 *                 (empty vs oversized named distinctly, oversized value never
 *                 echoed), index_job_unknown_source, index_job_identity_mismatch,
 *                 index_job_in_progress (with active_job_id),
 *                 index_job_unknown_job.
 *   storage fault throws — the server adapter names it; a ledger that could
 *                 not persist must never read as an accepted submit.
 *
 * Input-contract classes covered per tool:
 *   normal    — submit queues the derived job; poll reads it back.
 *   failure   — unknown source, identity mismatch, active-job conflict,
 *               unknown job id, ledger throw.
 *   boundary  — empty selectors, whitespace-only, unknown keys, over-ceiling
 *               locators, a NULL stored identity (not-yet-backfilled legacy
 *               row), a join arm whose row the worker already started, absent
 *               档 C singleton row.
 *   idempotency / concurrency — the same pair submitted twice and submitted
 *               in parallel collapses to one row; a different-identity submit
 *               while one is active is refused, not queued behind it — both
 *               through the pre-check read AND through the ledger's
 *               one-active-per-source conflict outcome (raced past the read).
 *   ordering  — supersedeReadyJobs(source_ref) strictly AFTER a successful
 *               fresh insertJobOrJoin, so a failed or conflicted insert never
 *               demotes the prior version's ready rows; the join arm's early
 *               return precedes the sweep entirely (single-arg supersede needs
 *               no self-exemption).
 *   stale arm — a new version's submit demotes the prior version's READY row
 *               to STALE through the real backend.
 *   purity    — poll mutates nothing; submit writes nothing but a job row (no
 *               source_documents.status or community_index_state writer is even
 *               reachable from this module — asserted on its source text).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import {
  createPollIndexJobHandler,
  createSubmitIndexJobHandler,
  pollIndexJobTool,
  PollIndexJobInputSchema,
  submitIndexJobTool,
  SubmitIndexJobInputSchema,
  type CommunityIndexStateReader,
  type CommunityIndexStateView,
  type IndexJobReadPort,
  type IndexJobSourceView,
  type PollIndexJobInput,
  type SubmitIndexJobInput,
} from "../../src/tools/index-job.js";
import { SOURCE_READ_MAX_LOCATOR_CODE_POINTS } from "../../src/tools/read_source.js";
import { buildIndexJobSeams } from "../../src/index.js";
import { computeChunkId } from "../../src/tools/ingest.js";
import { textResult, type ToolResult } from "../../src/tools/registry.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import {
  supportsCommunityIndexState,
  supportsIndexJobStore,
} from "../../src/core/storage/backend.js";
import type {
  IndexJobClaimOptions,
  IndexJobInsertOutcome,
  IndexJobRecord,
  IndexJobStore,
  IndexJobTerminalOutcome,
  SourceDocRecord,
} from "../../src/core/types.js";

const SOURCE_REF = "corpus/annual-report-2024.md";
const IDENTITY = "sha256:aaaa1111";
const OTHER_IDENTITY = "sha256:bbbb2222";
/** A superseded content version: its job is still active while the 资料 row
 * already carries `IDENTITY`, which is the only submit that can pass the
 * identity check and still collide with it. */
const PREVIOUS_VERSION = "sha256:0000-before";
/** One code point over the locator ceiling — the overflow class. */
const OVER_CEILING = "x".repeat(SOURCE_READ_MAX_LOCATOR_CODE_POINTS + 1);
/** Exactly at the ceiling — must NOT be a locator fault. */
const AT_CEILING = "y".repeat(SOURCE_READ_MAX_LOCATOR_CODE_POINTS);
/**
 * The ceiling counted in CODE POINTS, not UTF-16 units: these emoji are two
 * `length` each, so this string passes `.length` but sits exactly at the
 * code-point budget — the same `Array.from` domain `read_source` measures.
 */
const AT_CEILING_CODE_POINTS = "😀".repeat(SOURCE_READ_MAX_LOCATOR_CODE_POINTS);

/** The 6 submit keys and the row + sub-object poll keys, pinned as a set. */
const SUBMIT_KEYS = [
  "job_id",
  "source_ref",
  "content_identity",
  "status",
  "started_at",
  "reused",
].sort();

/** The full persisted row plus the one separate sub-object — nothing merged. */
const POLL_KEYS = [
  "job_id",
  "source_ref",
  "content_identity",
  "status",
  "created_at",
  "started_at",
  "finished_at",
  "failure_code",
  "community_index_state",
].sort();

const WRITE_METHODS = [
  "insertJobOrJoin",
  "supersedeReadyJobs",
  "claimNextJob",
  "publishJobOutcome",
];

type LedgerCall =
  | { method: "insertJobOrJoin"; jobId: string }
  | { method: "getJob"; jobId: string }
  | { method: "getActiveJobForSource"; sourceRef: string }
  | { method: "supersedeReadyJobs"; sourceRef: string }
  | { method: "claimNextJob" }
  | { method: "publishJobOutcome"; jobId: string };

/**
 * Records the ledger call sequence while delegating every read and write to the
 * REAL `MemoryBackend`. State assertions read from `backend`; only ordering and
 * no-traffic assertions come from `calls`. This is why there is no fake ledger:
 * the truth stays in the production store, so it cannot drift from it.
 */
class RecordingJobStore implements IndexJobStore {
  readonly calls: LedgerCall[] = [];
  /** job_ids this recorder saw a genuine fresh insert for (`inserted: true`). */
  readonly insertedIds = new Set<string>();

  constructor(readonly backend: MemoryBackend) {}

  async insertJobOrJoin(
    record: IndexJobRecord
  ): Promise<IndexJobInsertOutcome> {
    this.calls.push({ method: "insertJobOrJoin", jobId: record.job_id });
    const out = await this.backend.insertJobOrJoin(record);
    if ("inserted" in out && out.inserted) {
      this.insertedIds.add(record.job_id);
    }
    return out;
  }

  async getJob(jobId: string): Promise<IndexJobRecord | null> {
    this.calls.push({ method: "getJob", jobId });
    return this.backend.getJob(jobId);
  }

  async getActiveJobForSource(
    sourceRef: string
  ): Promise<IndexJobRecord | null> {
    this.calls.push({ method: "getActiveJobForSource", sourceRef });
    return this.backend.getActiveJobForSource(sourceRef);
  }

  async supersedeReadyJobs(sourceRef: string): Promise<number> {
    this.calls.push({ method: "supersedeReadyJobs", sourceRef });
    return this.backend.supersedeReadyJobs(sourceRef);
  }

  async claimNextJob(
    options: IndexJobClaimOptions
  ): Promise<IndexJobRecord | null> {
    this.calls.push({ method: "claimNextJob" });
    return this.backend.claimNextJob(options);
  }

  async publishJobOutcome(
    jobId: string,
    outcome: IndexJobTerminalOutcome
  ): Promise<IndexJobRecord | null> {
    this.calls.push({ method: "publishJobOutcome", jobId });
    return this.backend.publishJobOutcome(jobId, outcome);
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}

function writeCallCount(store: RecordingJobStore): number {
  return store.calls.filter((c) => WRITE_METHODS.includes(c.method)).length;
}

function jobRow(overrides: Partial<IndexJobRecord> = {}): IndexJobRecord {
  return {
    job_id: "seeded-job",
    source_ref: SOURCE_REF,
    content_identity: IDENTITY,
    status: "in_progress",
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    finished_at: null,
    failure_code: null,
    ...overrides,
  };
}

/** Read port over an explicit source table; `null` = never pushed. */
class FakeReadPort implements IndexJobReadPort {
  lookupCount = 0;

  constructor(
    private readonly sources: Record<string, IndexJobSourceView | null> = {}
  ) {}

  async getSourceDoc(sourceRef: string): Promise<IndexJobSourceView | null> {
    this.lookupCount += 1;
    if (!(sourceRef in this.sources)) {
      return null;
    }
    return this.sources[sourceRef] ?? null;
  }
}

class FakeCommunityState implements CommunityIndexStateReader {
  readCount = 0;

  constructor(private readonly row: CommunityIndexStateView | undefined) {}

  async getCommunityIndexState(): Promise<CommunityIndexStateView | undefined> {
    this.readCount += 1;
    return this.row;
  }
}

function parseBody(result: ToolResult): Record<string, unknown> {
  const text = result.content[0]?.text;
  if (typeof text !== "string") {
    throw new Error("expected a text content block in the ToolResult");
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function expectError(
  result: ToolResult,
  code: string
): Record<string, unknown> {
  expect(result.isError).toBe(true);
  const body = parseBody(result);
  expect(body.error).toBe(code);
  return body;
}

/** A handler over the per-test ledger, so a malformed input that the strict
 * schema would never let through the wire still reaches the handler's own
 * locator check. */
function submitIndexJobHandlerWith(): (input: unknown) => Promise<ToolResult> {
  const handler = createSubmitIndexJobHandler({ jobStore: store, readPort });
  return (input: unknown) => handler(input as SubmitIndexJobInput);
}

let backend: MemoryBackend;
let store: RecordingJobStore;
let readPort: FakeReadPort;
let submit: (input: SubmitIndexJobInput) => Promise<ToolResult>;

beforeEach(() => {
  backend = new MemoryBackend(4);
  store = new RecordingJobStore(backend);
  readPort = new FakeReadPort({
    [SOURCE_REF]: { source_ref: SOURCE_REF, content_identity: IDENTITY },
    "corpus/legacy.md": {
      source_ref: "corpus/legacy.md",
      content_identity: null,
    },
    "corpus/other.md": {
      source_ref: "corpus/other.md",
      content_identity: OTHER_IDENTITY,
    },
  });
  submit = createSubmitIndexJobHandler({ jobStore: store, readPort });
});

describe("submit_index_job — happy path and durable identity", () => {
  it("queues the derived job and returns it immediately, without starting it", async () => {
    const body = parseBody(await submit(validSubmit()));
    const jobId = computeChunkId(SOURCE_REF, IDENTITY);

    expect(Object.keys(body).sort()).toEqual(SUBMIT_KEYS);
    expect(body).toMatchObject({
      job_id: jobId,
      source_ref: SOURCE_REF,
      content_identity: IDENTITY,
      status: "in_progress",
      started_at: null,
      reused: false,
    });
    expect(body.isError).toBeUndefined();
    // The job_id is the push idempotency pair, not a random uuid.
    expect(jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    // Durable, on the real backend: queued marker, and submit never touches a
    // source row (read once, for the identity check).
    const row = await backend.getJob(jobId);
    expect(row?.started_at).toBeNull();
    expect(row?.finished_at).toBeNull();
    expect(row?.failure_code).toBeNull();
    expect(Date.parse(String(row?.created_at))).not.toBeNaN();
    expect(readPort.lookupCount).toBe(1);
  });

  it("does not run any stage: the persisted row stays queued", async () => {
    await submit(validSubmit());
    const row = await backend.getJob(computeChunkId(SOURCE_REF, IDENTITY));
    expect(row?.status).toBe("in_progress");
    expect(row?.started_at).toBeNull();
    expect(row?.finished_at).toBeNull();
  });

  it("every submit body carries EXACTLY the six pinned keys in the pinned shape", async () => {
    const body = parseBody(await submit(validSubmit()));
    expect(Object.keys(body).sort()).toEqual(SUBMIT_KEYS);
    expect(body.started_at).toBeNull();
    expect(body.reused).toBe(false);
    expect(body.status).toBe("in_progress");
  });
});

describe("submit_index_job — idempotent join", () => {
  it("a re-submit of the same pair returns the same job with reused: true", async () => {
    const first = parseBody(await submit(validSubmit()));
    const second = parseBody(await submit(validSubmit()));

    // Only one genuine insert reached the backend; the second joined it.
    expect(store.insertedIds.size).toBe(1);
    expect(second.job_id).toBe(first.job_id);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.status).toBe(first.status);
  });

  it("the join arm echoes the persisted state, not a fresh queue marker", async () => {
    const jobId = computeChunkId(SOURCE_REF, IDENTITY);
    // The worker picked it up first: seed a started row straight into the real
    // ledger, so the host must see the real state rather than a manufactured
    // `started_at: null`.
    await backend.insertJobOrJoin(
      jobRow({ job_id: jobId, started_at: "2026-02-02T02:02:02.000Z" })
    );

    const body = parseBody(await submit(validSubmit()));
    expect(body).toMatchObject({
      job_id: jobId,
      started_at: "2026-02-02T02:02:02.000Z",
      reused: true,
    });
  });

  it("parallel duplicate submits collapse to exactly one row", async () => {
    const bodies = (
      await Promise.all([submit(validSubmit()), submit(validSubmit())])
    ).map(parseBody);

    // The unique key lets exactly one submit claim a fresh queue entry.
    expect(store.insertedIds.size).toBe(1);
    expect(new Set(bodies.map((b) => b.job_id)).size).toBe(1);
    expect(bodies.filter((b) => b.reused === false).length).toBe(1);
    expect(bodies.filter((b) => b.reused === true).length).toBe(1);
    expect(bodies.every((b) => b.status === "in_progress")).toBe(true);
  });

  it("the join arm answers from the ledger alone — no source read, no supersede", async () => {
    await backend.insertJobOrJoin(
      jobRow({ job_id: computeChunkId(SOURCE_REF, IDENTITY), status: "ready" })
    );
    await submit(validSubmit());

    expect(readPort.lookupCount).toBe(0);
    expect(store.methods()).toEqual(["getJob"]);
  });
});

describe("submit_index_job — invalid input", () => {
  it("rejects an empty or missing selector with index_job_invalid_locator", async () => {
    for (const input of [
      { source_ref: "", content_identity: IDENTITY },
      { source_ref: SOURCE_REF, content_identity: "" },
      { content_identity: IDENTITY },
      { source_ref: SOURCE_REF },
      {},
      { source_ref: 42, content_identity: IDENTITY },
    ]) {
      const body = expectError(
        await submitIndexJobHandlerWith()(input),
        "index_job_invalid_locator"
      );
      expect(typeof body.message).toBe("string");
      expect(await backend.getJob(computeChunkId("", IDENTITY))).toBeNull();
      expect(store.calls.length).toBe(0);
      expect(readPort.lookupCount).toBe(0);
    }
  });

  it("keeps the strict schemas as the wire-level contract", async () => {
    expect(SubmitIndexJobInputSchema.safeParse(validSubmit()).success).toBe(
      true
    );
    expect(
      SubmitIndexJobInputSchema.safeParse({ ...validSubmit(), extra: 1 })
        .success
    ).toBe(false);
    // The pinned wire schema is `.min(1)` with no trim: a whitespace-only
    // selector is a locator the storage layer will simply never resolve, so it
    // is not this tool's domain check.
    expect(
      SubmitIndexJobInputSchema.safeParse({
        source_ref: "   ",
        content_identity: "   ",
      }).success
    ).toBe(true);
    expectError(
      await submitIndexJobHandlerWith()({
        source_ref: "   ",
        content_identity: IDENTITY,
      }),
      "index_job_unknown_source"
    );
    expect(PollIndexJobInputSchema.safeParse({ job_id: "" }).success).toBe(
      false
    );
    expect(
      PollIndexJobInputSchema.safeParse({ job_id: "x", source_ref: "y" })
        .success
    ).toBe(false);
  });

  it("a locator fault carries no locator echo and no ledger traffic", async () => {
    const body = expectError(
      await submitIndexJobHandlerWith()({
        source_ref: "",
        content_identity: "",
      }),
      "index_job_invalid_locator"
    );
    expect(Object.keys(body).sort()).toEqual(["error", "message", "missing"]);
    expect(body.missing).toBe("source_ref");
  });
});

describe("submit_index_job — locator ceiling (overflow class)", () => {
  it("rejects an oversized selector with a distinctly-worded oversized fault and no echo", async () => {
    const body = expectError(
      await submitIndexJobHandlerWith()({
        source_ref: OVER_CEILING,
        content_identity: IDENTITY,
      }),
      "index_job_invalid_locator"
    );
    expect(Object.keys(body).sort()).toEqual(["error", "message", "oversized"]);
    expect(body.oversized).toBe("source_ref");
    // The message names the shared 1 024-code-point domain value, not the old
    // private 32 768 constant.
    expect(String(body.message)).toBe(
      `source_ref exceeds ${SOURCE_READ_MAX_LOCATOR_CODE_POINTS} code points`
    );
    expect(SOURCE_READ_MAX_LOCATOR_CODE_POINTS).toBe(1_024);
    // The oversized value is exactly what would overflow the result — dropped.
    expect(JSON.stringify(body)).not.toContain(OVER_CEILING);
    expect(store.calls.length).toBe(0);
    expect(readPort.lookupCount).toBe(0);
  });

  it("names an oversized content_identity distinctly from an empty one", async () => {
    const oversized = expectError(
      await submitIndexJobHandlerWith()({
        source_ref: SOURCE_REF,
        content_identity: OVER_CEILING,
      }),
      "index_job_invalid_locator"
    );
    expect(oversized.oversized).toBe("content_identity");
    expect(String(oversized.message)).toContain("exceeds");

    const empty = expectError(
      await submitIndexJobHandlerWith()({
        source_ref: SOURCE_REF,
        content_identity: "",
      }),
      "index_job_invalid_locator"
    );
    expect(empty.missing).toBe("content_identity");
    expect(String(empty.message)).toContain("non-empty");
  });

  it("enforces the ceiling in the handler, not the schema", async () => {
    // The schema's `.min(1)` lets an over-long value through — the handler's
    // typed fault is the enforcement point, mirroring read_source.
    expect(
      SubmitIndexJobInputSchema.safeParse({
        source_ref: OVER_CEILING,
        content_identity: IDENTITY,
      }).success
    ).toBe(true);

    const atCeiling = await submit({
      source_ref: AT_CEILING,
      content_identity: IDENTITY,
    });
    // At the ceiling it is not a locator fault — it proceeds and misses the
    // source, proving the ceiling let the value through.
    expectError(atCeiling, "index_job_unknown_source");
  });

  it("counts the ceiling in code points, not UTF-16 units", async () => {
    // The emoji locator is over twice the ceiling as `.length` but exactly at
    // it in code points — `.length`-based enforcement would falsely reject
    // it. read_source measures the same `Array.from` domain.
    expect(AT_CEILING_CODE_POINTS.length).toBeGreaterThan(
      SOURCE_READ_MAX_LOCATOR_CODE_POINTS
    );
    expectError(
      await submit({
        source_ref: AT_CEILING_CODE_POINTS,
        content_identity: IDENTITY,
      }),
      "index_job_unknown_source"
    );

    // One code point over, whatever the UTF-16 count says, is the overflow.
    const oneCodePointOver = `${AT_CEILING_CODE_POINTS}x`;
    const body = expectError(
      await submitIndexJobHandlerWith()({
        source_ref: oneCodePointOver,
        content_identity: IDENTITY,
      }),
      "index_job_invalid_locator"
    );
    expect(body.oversized).toBe("source_ref");
  });
});

describe("poll_index_job — locator ceiling", () => {
  it("rejects an oversized job_id without echoing it or touching the ledger", async () => {
    const poll = createPollIndexJobHandler({
      jobStore: store,
      communityState: new FakeCommunityState(undefined),
    });
    const before = store.calls.length;
    const body = expectError(
      await poll({ job_id: OVER_CEILING }),
      "index_job_invalid_locator"
    );
    expect(body.oversized).toBe("job_id");
    expect(String(body.message)).toContain("exceeds");
    expect(JSON.stringify(body)).not.toContain(OVER_CEILING);
    expect(store.calls.length).toBe(before);
  });
});

describe("submit_index_job — source identity", () => {
  it("names an unknown source_ref instead of queueing a job for nothing", async () => {
    const body = expectError(
      await submit({
        source_ref: "corpus/never-pushed.md",
        content_identity: IDENTITY,
      }),
      "index_job_unknown_source"
    );
    expect(body.source_ref).toBe("corpus/never-pushed.md");
    expect(store.calls.map((c) => c.method)).toEqual(["getJob"]);
    expect(
      await backend.getJob(computeChunkId("corpus/never-pushed.md", IDENTITY))
    ).toBeNull();
  });

  it("refuses a content_identity that is not the pushed version", async () => {
    const body = expectError(
      await submit({
        source_ref: SOURCE_REF,
        content_identity: "sha256:stale",
      }),
      "index_job_identity_mismatch"
    );
    expect(body.source_ref).toBe(SOURCE_REF);
    expect(
      await backend.getJob(computeChunkId(SOURCE_REF, "sha256:stale"))
    ).toBeNull();
  });

  it("refuses a legacy row whose identity is still NULL (not-yet-backfilled)", async () => {
    expectError(
      await submit({
        source_ref: "corpus/legacy.md",
        content_identity: IDENTITY,
      }),
      "index_job_identity_mismatch"
    );
    expect(
      await backend.getJob(computeChunkId("corpus/legacy.md", IDENTITY))
    ).toBeNull();
  });

  it("an empty-string identity is a locator fault, never a mismatch lookup", async () => {
    expectError(
      await submit({ source_ref: SOURCE_REF, content_identity: "" }),
      "index_job_invalid_locator"
    );
    expect(readPort.lookupCount).toBe(0);
  });
});

describe("submit_index_job — one active job per source", () => {
  it("refuses a new-version submit while the previous version still runs", async () => {
    // The 资料 row already carries the new identity (push ran), while the
    // superseded version's job is still active — exactly the re-push race.
    const activeJobId = computeChunkId(SOURCE_REF, PREVIOUS_VERSION);
    await backend.insertJobOrJoin(
      jobRow({
        job_id: activeJobId,
        content_identity: PREVIOUS_VERSION,
        started_at: "2026-01-01T01:00:00.000Z",
      })
    );

    const body = expectError(
      await submit(validSubmit()),
      "index_job_in_progress"
    );
    expect(body).toMatchObject({
      source_ref: SOURCE_REF,
      active_job_id: activeJobId,
    });
    // Refused means refused: no new row and no supersede of the old version.
    expect(store.methods()).toContain("getActiveJobForSource");
    expect(store.methods()).not.toContain("supersedeReadyJobs");
    expect((await backend.getJob(activeJobId))?.status).toBe("in_progress");
    expect(
      await backend.getJob(computeChunkId(SOURCE_REF, IDENTITY))
    ).toBeNull();
  });

  it("a conflict that raced past the pre-check still answers index_job_in_progress", async () => {
    // The real ledger holds an active row for this source, but the decorator's
    // pre-check read is blind to it — exactly the window two concurrent
    // conflicting submits exploit. The store's conflict outcome must carry
    // the typed answer instead of a queued-row success.
    const activeJobId = computeChunkId(SOURCE_REF, PREVIOUS_VERSION);
    await backend.insertJobOrJoin(
      jobRow({ job_id: activeJobId, content_identity: PREVIOUS_VERSION })
    );
    const blindStore = new RecordingJobStore(backend);
    blindStore.getActiveJobForSource = async (sourceRef: string) => {
      blindStore.calls.push({ method: "getActiveJobForSource", sourceRef });
      return null;
    };
    const handler = createSubmitIndexJobHandler({
      jobStore: blindStore,
      readPort,
    });

    const body = expectError(
      await handler(validSubmit()),
      "index_job_in_progress"
    );
    expect(body).toMatchObject({
      source_ref: SOURCE_REF,
      active_job_id: activeJobId,
    });
    // The loser persisted nothing and swept nothing: one active row remains,
    // and the derived id of this submit was never written.
    expect(blindStore.methods()).toContain("insertJobOrJoin");
    expect(blindStore.methods()).not.toContain("supersedeReadyJobs");
    expect(
      await backend.getJob(computeChunkId(SOURCE_REF, IDENTITY))
    ).toBeNull();
    expect((await backend.getJob(activeJobId))?.status).toBe("in_progress");
  });

  it("an active job for another source does not block this one", async () => {
    const otherJobId = computeChunkId("corpus/other.md", OTHER_IDENTITY);
    await backend.insertJobOrJoin(
      jobRow({
        job_id: otherJobId,
        source_ref: "corpus/other.md",
        content_identity: OTHER_IDENTITY,
      })
    );
    const body = parseBody(await submit(validSubmit()));
    expect(body.reused).toBe(false);
    // Both rows live on, one per source — the real ledger kept them apart.
    expect((await backend.getJob(otherJobId))?.status).toBe("in_progress");
    expect(
      await backend.getActiveJobForSource("corpus/other.md")
    ).toMatchObject({ job_id: otherJobId });
  });

  it("a terminal ready row of the previous version is demoted by the sweep", async () => {
    const previous = computeChunkId(SOURCE_REF, PREVIOUS_VERSION);
    await backend.insertJobOrJoin(
      jobRow({
        job_id: previous,
        content_identity: PREVIOUS_VERSION,
        status: "ready",
        started_at: "2026-01-01T01:00:00.000Z",
        finished_at: "2026-01-01T02:00:00.000Z",
      })
    );
    const body = parseBody(await submit(validSubmit()));
    expect(body.reused).toBe(false);
    // The real backend's supersede moved the superseded version's READY row to
    // STALE — the stale arm proven through the handler, not a fake.
    expect((await backend.getJob(previous))?.status).toBe("stale");
  });
});

describe("submit_index_job — insert, then supersede a successful fresh row", () => {
  it("calls supersedeReadyJobs(source_ref) only after a successful fresh insert", async () => {
    await submit(validSubmit());
    const methods = store.methods();

    expect(methods.indexOf("insertJobOrJoin")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("supersedeReadyJobs")).toBeGreaterThan(
      methods.indexOf("insertJobOrJoin")
    );
    // Single-arg contract: the sweep is keyed only on the source.
    expect(store.calls.find((c) => c.method === "supersedeReadyJobs")).toEqual({
      method: "supersedeReadyJobs",
      sourceRef: SOURCE_REF,
    });
  });

  it("an insert that fails never demotes the prior version's ready rows", async () => {
    const previous = computeChunkId(SOURCE_REF, PREVIOUS_VERSION);
    await backend.insertJobOrJoin(
      jobRow({
        job_id: previous,
        content_identity: PREVIOUS_VERSION,
        status: "ready",
        started_at: "2026-01-01T01:00:00.000Z",
        finished_at: "2026-01-01T02:00:00.000Z",
      })
    );
    const failing = new RecordingJobStore(backend);
    failing.insertJobOrJoin = async (record) => {
      failing.calls.push({ method: "insertJobOrJoin", jobId: record.job_id });
      throw new Error("connection terminated");
    };
    const handler = createSubmitIndexJobHandler({
      jobStore: failing,
      readPort,
    });

    // The sweep trailing the write is the point: a submit that did not land
    // must not also invalidate the answer that was good before it.
    await expect(handler(validSubmit())).rejects.toThrow(
      /connection terminated/
    );
    expect((await backend.getJob(previous))?.status).toBe("ready");
    expect(failing.methods()).not.toContain("supersedeReadyJobs");
  });

  it("the derived job's own row never meets the sweep — the early join answers", async () => {
    const jobId = computeChunkId(SOURCE_REF, IDENTITY);
    // Even a READY row at the derived id is short-circuited by the pre-`getJob`
    // join, so single-arg supersede needs no self-exemption.
    await backend.insertJobOrJoin(jobRow({ job_id: jobId, status: "ready" }));
    const body = parseBody(await submit(validSubmit()));

    expect(body.reused).toBe(true);
    expect(store.methods()).not.toContain("supersedeReadyJobs");
    expect((await backend.getJob(jobId))?.status).toBe("ready");
  });
});

describe("poll_index_job — reading persisted state", () => {
  it("returns the persisted row beside a separate community_index_state object", async () => {
    const jobId = computeChunkId(SOURCE_REF, IDENTITY);
    // Seed a worker-started row directly, then poll through the recorder so the
    // recorder sees only the poll's reads.
    await backend.insertJobOrJoin(
      jobRow({ job_id: jobId, started_at: "2026-01-02T03:04:05.000Z" })
    );
    const poll = createPollIndexJobHandler({
      jobStore: store,
      communityState: new FakeCommunityState({
        status: "ready",
        failure_code: null,
      }),
    });

    const body = parseBody(await poll({ job_id: jobId }));
    expect(body).toMatchObject({
      job_id: jobId,
      source_ref: SOURCE_REF,
      content_identity: IDENTITY,
      status: "in_progress",
      started_at: "2026-01-02T03:04:05.000Z",
      finished_at: null,
      failure_code: null,
      created_at: expect.any(String),
      community_index_state: { status: "ready", failure_code: null },
    });
    // Two distinct facts: the job's own keys plus ONE nested sub-object, so a
    // host can never read "queued" as "档 C ready".
    expect(Object.keys(body).sort()).toEqual(POLL_KEYS);
    expect(body.status).toBe("in_progress");
    expect(body.failure_code).toBeNull();
    expect(Object.keys(body.community_index_state as object)).toEqual([
      "status",
      "failure_code",
    ]);
    expect((body.community_index_state as { status: string }).status).not.toBe(
      body.status
    );
  });

  it("poll reads only: getJob plus the C read, never a ledger write", async () => {
    const jobId = computeChunkId(SOURCE_REF, IDENTITY);
    await backend.insertJobOrJoin(jobRow({ job_id: jobId }));
    const poll = createPollIndexJobHandler({
      jobStore: store,
      communityState: new FakeCommunityState({
        status: "stale",
        failure_code: null,
      }),
    });
    await poll({ job_id: jobId });

    expect(writeCallCount(store)).toBe(0);
    expect(store.methods()).toEqual(["getJob"]);
  });

  it("reports a failed job with its typed stage code and the C failure beside it", async () => {
    await backend.insertJobOrJoin(
      jobRow({
        job_id: "j2",
        status: "failed",
        started_at: "2026-01-01T01:00:00.000Z",
        finished_at: "2026-01-01T01:30:00.000Z",
        failure_code: "projection_drain_timeout",
      })
    );
    const poll = createPollIndexJobHandler({
      jobStore: store,
      communityState: new FakeCommunityState({
        status: "failed",
        failure_code: "summary_generation_crashed",
      }),
    });

    const body = parseBody(await poll({ job_id: "j2" }));
    expect(body).toMatchObject({
      status: "failed",
      failure_code: "projection_drain_timeout",
      community_index_state: {
        status: "failed",
        failure_code: "summary_generation_crashed",
      },
    });
  });

  it("a never-written C singleton is null, not an empty object or a guess", async () => {
    await backend.insertJobOrJoin(jobRow({ job_id: "j3" }));
    const communityState = new FakeCommunityState(undefined);
    const poll = createPollIndexJobHandler({
      jobStore: store,
      communityState,
    });

    const body = parseBody(await poll({ job_id: "j3" }));
    expect(body.community_index_state).toBeNull();
    expect(body.status).toBe("in_progress");
    expect(communityState.readCount).toBe(1);
  });

  it("names an unknown job_id — a miss is never an empty success", async () => {
    const poll = createPollIndexJobHandler({
      jobStore: store,
      communityState: new FakeCommunityState(undefined),
    });
    const body = expectError(
      await poll({ job_id: "00000000-0000-4000-8000-000000000000" }),
      "index_job_unknown_job"
    );
    expect(body.job_id).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("rejects a malformed job_id as a locator fault without a ledger read", async () => {
    const poll = createPollIndexJobHandler({
      jobStore: store,
      communityState: new FakeCommunityState(undefined),
    });
    const before = store.calls.length;
    expectError(
      await poll({} as PollIndexJobInput),
      "index_job_invalid_locator"
    );
    expectError(await poll({ job_id: "" }), "index_job_invalid_locator");
    expect(store.calls.length).toBe(before);
  });

  it("never mutates job or C state, however often it polls", async () => {
    await backend.insertJobOrJoin(jobRow({ job_id: "j4" }));
    const communityState = new FakeCommunityState({
      status: "stale",
      failure_code: "graph_rebuilt",
    });
    const poll = createPollIndexJobHandler({
      jobStore: store,
      communityState,
    });
    const snapshot = JSON.stringify(await backend.getJob("j4"));

    const results = await Promise.all([
      poll({ job_id: "j4" }),
      poll({ job_id: "j4" }),
      poll({ job_id: "j4" }),
    ]);

    expect(JSON.stringify(await backend.getJob("j4"))).toBe(snapshot);
    expect(writeCallCount(store)).toBe(0);
    expect(communityState.readCount).toBe(3);
    for (const result of results) {
      expect(result.isError).toBeUndefined();
      expect(parseBody(result).status).toBe("in_progress");
    }
  });
});

describe("storage faults are not dressed up as tool outcomes", () => {
  it("a ledger throw on submit propagates to the caller", async () => {
    // The sweep is the trip that fails here — and it runs only after the
    // insert, so the queue entry this call genuinely persisted must survive
    // while the fault still propagates unrepaired.
    const broken = new RecordingJobStore(backend);
    broken.supersedeReadyJobs = async () => {
      throw new Error("connection terminated");
    };
    const handler = createSubmitIndexJobHandler({
      jobStore: broken,
      readPort,
    });
    await expect(handler(validSubmit())).rejects.toThrow(
      /connection terminated/
    );
    expect(
      await backend.getJob(computeChunkId(SOURCE_REF, IDENTITY))
    ).toMatchObject({ status: "in_progress", started_at: null });
  });

  it("a C read throw on poll propagates instead of reporting null readiness", async () => {
    await backend.insertJobOrJoin(jobRow({ job_id: "j5" }));
    const poll = createPollIndexJobHandler({
      jobStore: store,
      communityState: {
        async getCommunityIndexState() {
          throw new Error("ledger unreachable");
        },
      },
    });
    await expect(poll({ job_id: "j5" })).rejects.toThrow(/ledger unreachable/);
  });
});

/**
 * The same handlers driven end-to-end through the REAL production wiring: the
 * exported `buildIndexJobSeams` factory produces the read-port and 档 C seam
 * exactly as `src/index.ts` wires them, over `MemoryBackend`'s own ledger. The
 * storage layer's namers are the precondition checks, so a submit's identity
 * comparison runs against the row the backend actually stores.
 */
describe("submit / poll against the real backend ledger", () => {
  const LEGACY_ID = "11111111-1111-4111-8111-111111111111";

  /** A pushed 资料 row: the shape `push` writes, identity included. */
  function pushedDoc(
    overrides: Partial<SourceDocRecord> = {}
  ): SourceDocRecord {
    return {
      id: LEGACY_ID,
      source_ref: SOURCE_REF,
      title: null,
      content: "the body this content version carries",
      created_at: "2026-01-01T00:00:00.000Z",
      content_identity: IDENTITY,
      ...overrides,
    };
  }

  it("the backend satisfies both wiring preconditions", () => {
    const wired = new MemoryBackend(4);
    expect(supportsIndexJobStore(wired)).toBe(true);
    expect(supportsCommunityIndexState(wired)).toBe(true);
    // buildIndexJobSeams asserts the same preconditions and never throws here.
    expect(() => buildIndexJobSeams(wired)).not.toThrow();
  });

  it("submit persists in the real ledger and a re-submit joins the same row", async () => {
    const wired = new MemoryBackend(4);
    await wired.upsertSourceDoc(pushedDoc());
    const seams = buildIndexJobSeams(wired);
    const handler = createSubmitIndexJobHandler({
      jobStore: seams.indexJobs,
      readPort: seams.indexJobReadPort,
    });

    const first = parseBody(await handler(validSubmit()));
    const second = parseBody(await handler(validSubmit()));
    const jobId = String(first.job_id);

    expect(second.job_id).toBe(jobId);
    expect(second.reused).toBe(true);
    expect(await wired.getJob(jobId)).toMatchObject({
      job_id: jobId,
      source_ref: SOURCE_REF,
      content_identity: IDENTITY,
      status: "in_progress",
      started_at: null,
      finished_at: null,
      failure_code: null,
    });
    // The active-job lookup is what a second submit must keep finding.
    expect(await wired.getActiveJobForSource(SOURCE_REF)).toMatchObject({
      job_id: jobId,
    });
  });

  it("poll reads the real ledger and the real 档 C singleton as two facts", async () => {
    const wired = new MemoryBackend(4);
    const seams = buildIndexJobSeams(wired);
    await wired.insertJobOrJoin(jobRow({ job_id: "real-1", status: "ready" }));
    const poll = createPollIndexJobHandler({
      jobStore: seams.indexJobs,
      communityState: seams.communityState,
    });

    const absent = parseBody(await poll({ job_id: "real-1" }));
    expect(absent.community_index_state).toBeNull();
    expect(absent.status).toBe("ready");

    await wired.setCommunityIndexState({
      status: "in_progress",
      failure_code: null,
    });
    const present = parseBody(await poll({ job_id: "real-1" }));
    expect(present).toMatchObject({
      status: "ready",
      community_index_state: { status: "in_progress", failure_code: null },
    });
    // Reading is not a transition.
    expect(await wired.getJob("real-1")).toMatchObject({ status: "ready" });
  });

  it("a new version supersedes the real ledger's ready row", async () => {
    const wired = new MemoryBackend(4);
    await wired.upsertSourceDoc(pushedDoc());
    const seams = buildIndexJobSeams(wired);
    const previous = computeChunkId(SOURCE_REF, PREVIOUS_VERSION);
    await wired.insertJobOrJoin(
      jobRow({
        job_id: previous,
        content_identity: PREVIOUS_VERSION,
        status: "ready",
        started_at: "2026-01-01T01:00:00.000Z",
        finished_at: "2026-01-01T02:00:00.000Z",
      })
    );
    const handler = createSubmitIndexJobHandler({
      jobStore: seams.indexJobs,
      readPort: seams.indexJobReadPort,
    });

    const body = parseBody(await handler(validSubmit()));
    expect(body.reused).toBe(false);
    expect(await wired.getJob(previous)).toMatchObject({ status: "stale" });
    expect(await wired.getJob(String(body.job_id))).toMatchObject({
      status: "in_progress",
      started_at: null,
    });
  });

  it("a legacy source row with no stored identity is a mismatch, never a guess", async () => {
    const wired = new MemoryBackend(4);
    await wired.upsertSourceDoc(
      pushedDoc({
        content: "body pushed before the identity column existed",
        content_identity: null,
      })
    );
    const seams = buildIndexJobSeams(wired);
    const handler = createSubmitIndexJobHandler({
      jobStore: seams.indexJobs,
      readPort: seams.indexJobReadPort,
    });

    expectError(await handler(validSubmit()), "index_job_identity_mismatch");
    expect(await wired.getJob(computeChunkId(SOURCE_REF, IDENTITY))).toBeNull();
  });

  it("an unknown source_ref on the real read port is a named miss", async () => {
    const wired = new MemoryBackend(4);
    const seams = buildIndexJobSeams(wired);
    const handler = createSubmitIndexJobHandler({
      jobStore: seams.indexJobs,
      readPort: seams.indexJobReadPort,
    });
    expectError(await handler(validSubmit()), "index_job_unknown_source");
  });
});

describe("the index-job tools never write push or 档 C state", () => {
  const moduleSource = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "tools", "index-job.ts"),
    "utf8"
  );

  it("imports only the registry, the frozen types, the id derivation, and the shared locator ceiling", () => {
    const specifiers = [...moduleSource.matchAll(/from\s+"([^"]+)"/g)].map(
      (m) => m[1]
    );
    expect(specifiers.sort()).toEqual([
      "../core/types.js",
      "./ingest.js",
      "./read_source.js",
      "./registry.js",
      "zod",
    ]);
    expect(moduleSource).not.toMatch(/from\s+"[^"]*core\/storage\//);
  });

  it("names no push or 档 C writer", () => {
    for (const forbidden of [
      "upsertSourceDoc",
      "markSourceDocReady",
      "recordSourceDocFailure",
      "invalidateSourceRef",
      "setCommunityIndexState",
      "SOURCE_DOC_STATUS",
    ]) {
      expect(moduleSource, forbidden).not.toContain(forbidden);
    }
  });
});

describe("MCP wire round trip (InMemoryTransport)", () => {
  /** Serves ONLY the two job tools, the way `registerOne` wraps them. */
  async function connectJobTools(): Promise<{
    client: Client;
    close: () => Promise<void>;
  }> {
    const server = new McpServer(
      { name: "index-job-test", version: "0.0.0" },
      { capabilities: { tools: {} } }
    );
    const deps = { jobStore: store, readPort };
    const pollDeps = {
      jobStore: store,
      communityState: new FakeCommunityState({
        status: "in_progress",
        failure_code: null,
      }),
    };
    for (const tool of [submitIndexJobTool(deps), pollIndexJobTool(pollDeps)]) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.inputSchema },
        async (input: unknown) => {
          try {
            return await tool.handler(input);
          } catch (err) {
            return textResult(
              err instanceof Error ? err.message : String(err),
              true
            );
          }
        }
      );
    }

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "index-job-test-client", version: "0.0.0" },
      { capabilities: {} }
    );
    await client.connect(clientTransport);
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  function wireText(result: { content: unknown }): string {
    return (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  }

  it("tools/list advertises both job tools with object input schemas", async () => {
    const { client, close } = await connectJobTools();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["poll_index_job", "submit_index_job"]);
      for (const tool of tools) {
        expect((tool.inputSchema as { type?: string }).type).toBe("object");
        expect(tool.description.length).toBeGreaterThan(0);
      }
    } finally {
      await close();
    }
  });

  it("submit then poll over the wire returns the same durable job", async () => {
    const { client, close } = await connectJobTools();
    try {
      const submitted = await client.callTool({
        name: "submit_index_job",
        arguments: { source_ref: SOURCE_REF, content_identity: IDENTITY },
      });
      expect(submitted.isError).toBeUndefined();
      const submitBody = JSON.parse(wireText(submitted)) as Record<
        string,
        unknown
      >;
      expect(submitBody.started_at).toBeNull();
      expect(submitBody.reused).toBe(false);

      const polled = await client.callTool({
        name: "poll_index_job",
        arguments: { job_id: submitBody.job_id },
      });
      expect(polled.isError).toBeUndefined();
      const pollBody = JSON.parse(wireText(polled)) as Record<string, unknown>;
      expect(pollBody.job_id).toBe(submitBody.job_id);
      expect(pollBody.status).toBe("in_progress");
      expect(pollBody.community_index_state).toEqual({
        status: "in_progress",
        failure_code: null,
      });

      const again = await client.callTool({
        name: "submit_index_job",
        arguments: { source_ref: SOURCE_REF, content_identity: IDENTITY },
      });
      expect(
        (JSON.parse(wireText(again)) as Record<string, unknown>).reused
      ).toBe(true);
      // Over the wire, one content version produced exactly one ledger row.
      expect(store.insertedIds.size).toBe(1);
    } finally {
      await close();
    }
  });

  it("the wire rejects an empty selector and an unknown key with isError, not a job", async () => {
    const { client, close } = await connectJobTools();
    try {
      for (const args of [
        { source_ref: "", content_identity: IDENTITY },
        { source_ref: SOURCE_REF },
        { source_ref: SOURCE_REF, content_identity: IDENTITY, extra: true },
      ]) {
        const result = await client.callTool({
          name: "submit_index_job",
          arguments: args,
        });
        expect(result.isError).toBe(true);
      }
      expect(store.calls.filter((c) => c.method === "insertJobOrJoin")).toEqual(
        []
      );

      const miss = await client.callTool({
        name: "poll_index_job",
        arguments: { job_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
      });
      expect(miss.isError).toBe(true);
      expect(JSON.parse(wireText(miss)).error).toBe("index_job_unknown_job");
    } finally {
      await close();
    }
  });
});

/**
 * Corpus-index-job T2 acceptance names "storage exceptions" as a boundary class
 * of the submit/poll MCP boundary. The established contract, read off the code:
 *  - `src/tools/index-job.ts` has no `try`/`catch` at all, and its wire
 *    docblock (:46-49) states storage faults are NOT translated into error
 *    bodies here — a swallowed ledger failure would read as a queue that
 *    accepted work it never persisted;
 *  - `src/tools/registry.ts:33-37` — the handler is pure and throws on internal
 *    errors, the adapter translates thrown errors into `isError: true`;
 *  - `src/index.ts:614-640` (`registerOne`) — the catch publishes a plain
 *    non-`GraphragError` as `textResult(redactedMessage, true)`, i.e. the raw
 *    storage message as the only text block, never a JSON verdict body.
 * So the boundary proof is: the fault leaves the handler as a throw and leaves
 * the MCP boundary as `isError: true` carrying the storage message — not an
 * empty success, not one of this module's typed `index_job_*` bodies.
 */
describe("index-job MCP boundary — storage exceptions", () => {
  /** A plain driver error: `failureTokenOf` declines it, so the adapter
   * publishes the message itself rather than a typed `error` field. */
  const STORAGE_DOWN = "connection terminated unexpectedly";

  /** One tool, registered with `registerOne`'s catch, driven over the wire. */
  async function callOverWire(
    tool: ReturnType<typeof submitIndexJobTool>,
    args: Record<string, unknown>
  ): Promise<{ isError: boolean | undefined; text: string }> {
    const server = new McpServer(
      { name: "index-job-fault", version: "0.0.0" },
      { capabilities: { tools: {} } }
    );
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (input: unknown) => {
        try {
          return await tool.handler(input);
        } catch (err) {
          return textResult(
            err instanceof Error ? err.message : String(err),
            true
          );
        }
      }
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "index-job-fault-client", version: "0.0.0" },
      { capabilities: {} }
    );
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: tool.name,
        arguments: args,
      });
      return {
        isError: result.isError,
        text: (result.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join(""),
      };
    } finally {
      await client.close();
      await server.close();
    }
  }

  function rejectOn<T extends object>(target: T, method: keyof T): T {
    Object.assign(target, {
      [method]: async () => {
        throw new Error(STORAGE_DOWN);
      },
    });
    return target;
  }

  it("each submit storage blow-up reaches the wire as isError, never a verdict", async () => {
    const jobId = computeChunkId(SOURCE_REF, IDENTITY);
    const arms = [
      // The idempotency join is the first storage trip submit makes.
      ["jobStore.getJob", rejectOn(new RecordingJobStore(backend), "getJob")],
      [
        "jobStore.insertJobOrJoin",
        rejectOn(new RecordingJobStore(backend), "insertJobOrJoin"),
      ],
      [
        "readPort.getSourceDoc",
        new RecordingJobStore(backend),
        rejectOn(
          new FakeReadPort({
            [SOURCE_REF]: {
              source_ref: SOURCE_REF,
              content_identity: IDENTITY,
            },
          }),
          "getSourceDoc"
        ),
      ],
    ] as const;

    for (const [label, jobStore, port] of arms) {
      const { isError, text } = await callOverWire(
        submitIndexJobTool({ jobStore, readPort: port ?? readPort }),
        validSubmit()
      );
      // Published as a fault, and the storage message is the whole payload:
      // neither an empty success nor a typed `index_job_*` body.
      expect(isError, label).toBe(true);
      expect(text, label).toBe(STORAGE_DOWN);
      // A submit the ledger could not answer must not have left a row behind.
      expect(await backend.getJob(jobId), label).toBeNull();
    }
  });

  it("a poll storage blow-up is not dressed as unknown_job or null readiness", async () => {
    const jobId = computeChunkId(SOURCE_REF, IDENTITY);
    // Seed the row the faulted reads are standing in for: with a working
    // ledger both arms answer, so a not-found / null-C result here is a
    // translation, not a genuine miss.
    await backend.insertJobOrJoin(jobRow({ job_id: jobId }));
    const arms = [
      [
        "jobStore.getJob",
        rejectOn(new RecordingJobStore(backend), "getJob"),
        new FakeCommunityState({ status: "ready", failure_code: null }),
      ],
      [
        "communityState.getCommunityIndexState",
        new RecordingJobStore(backend),
        rejectOn(new FakeCommunityState(undefined), "getCommunityIndexState"),
      ],
    ] as const;

    for (const [label, jobStore, communityState] of arms) {
      const { isError, text } = await callOverWire(
        pollIndexJobTool({ jobStore, communityState }),
        { job_id: jobId }
      );
      expect(isError, label).toBe(true);
      expect(text, label).toBe(STORAGE_DOWN);
      // Poll stayed a pure read even while failing.
      expect(await backend.getJob(jobId), label).toMatchObject({
        status: "in_progress",
        finished_at: null,
      });
    }
  });
});

function validSubmit(): SubmitIndexJobInput {
  return { source_ref: SOURCE_REF, content_identity: IDENTITY };
}
