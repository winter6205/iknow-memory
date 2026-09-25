/**
 * Durable corpus index-job tools — MCP names `submit_index_job` and
 * `poll_index_job`.
 *
 * A permanent corpus upload is two separate facts: `push` writes the text and
 * makes the 资料 searchable, and an index job rebuilds the derived graph/档 C
 * layers for ONE content version. This pair owns the handoff wire between them
 * — it never runs extraction itself (that is the worker's stage pipeline), so
 * a successful submit is a durable queue entry, not a claim of readiness.
 *
 * Identity: `job_id` is derived from the same `(source_ref,
 * content_identity)` pair `push` already uses as its idempotency key
 * (`computeChunkId`), so a repeated submit of one content version resolves to
 * one job row rather than a second queue entry.
 *
 * Status separation (never merged, by design):
 *  - `community_index_state` is the corpus-wide 档 C readiness singleton;
 *  - `source_documents.status` is the last text-push outcome;
 *  - an `IndexJobRecord` is one source/content version's job.
 * `poll_index_job` reports the job row and the C singleton as two sibling
 * objects precisely so a host cannot read "job queued" as "C ready" or vice
 * versa.
 *
 * Wire contract:
 *  - `submit_index_job` input `{ source_ref, content_identity }` and
 *    `poll_index_job` input `{ job_id }`: each locator must be a non-empty
 *    string of at most `SOURCE_READ_MAX_LOCATOR_CODE_POINTS` code points —
 *    the very ceiling `read_source` enforces, so push/submit/read share ONE
 *    locator domain and a value no read tool can carry is never queued as a
 *    job. The ceiling is enforced in the handler, not the schema, so an
 *    over-long locator comes back as this tool's typed
 *    `index_job_invalid_locator` body rather than the SDK's prose — and the
 *    oversized value is never echoed back (it is the overflow). Empty/missing
 *    and over-ceiling are named distinctly. Unknown keys are rejected by the
 *    strict schemas.
 *  - Submit success: `{ job_id, source_ref, content_identity, status,
 *    started_at, reused }`. `reused` is the store's own verdict: `false` only
 *    for a row this call freshly inserted, `true` on either join arm (the
 *    pre-`getJob` hit or the ledger's unique-key `ON CONFLICT` loser), so a
 *    host never sees a fresh-queue claim for a row that already existed.
 *    `started_at` echoes the persisted row, so a queued job reads `null` and a
 *    worker-started join reads the real timestamp.
 *  - If the ledger's one-active-job-per-source unique index rejects the insert
 *    (a conflicting submit that raced past the pre-check), the call answers
 *    the typed `index_job_in_progress` with that racing row's `active_job_id`
 *    — a partial write is never reported as success.
 *  - Poll success: the full persisted job row plus a separate
 *    `community_index_state` sub-object projected to `{ status, failure_code }`,
 *    or `null` when the singleton row has never been written.
 *  - Typed errors (all `isError: true`, named bodies, never an empty success):
 *    `index_job_invalid_locator`, `index_job_unknown_source`,
 *    `index_job_identity_mismatch`, `index_job_in_progress` (carrying
 *    `active_job_id`), `index_job_unknown_job`.
 *  - Storage faults are NOT translated into error bodies here: they throw and
 *    the server adapter publishes them, because a swallowed ledger failure
 *    would look like a queue that accepted work it did not persist.
 */
import { z } from "zod";
import {
  textResult,
  type ToolRegistration,
  type ToolResult,
} from "./registry.js";
import {
  INDEX_JOB_STATUS,
  type IndexJobRecord,
  type IndexJobStore,
} from "../core/types.js";
import { computeChunkId } from "./ingest.js";
import { SOURCE_READ_MAX_LOCATOR_CODE_POINTS } from "./read_source.js";

export const SubmitIndexJobInputSchema = z.strictObject({
  source_ref: z.string().min(1),
  content_identity: z.string().min(1),
});

export const PollIndexJobInputSchema = z.strictObject({
  job_id: z.string().min(1),
});

export type SubmitIndexJobInput = z.infer<typeof SubmitIndexJobInputSchema>;
export type PollIndexJobInput = z.infer<typeof PollIndexJobInputSchema>;

/**
 * The one 资料 field submit reads, plus the locator that proves the row is the
 * one the caller meant. Kept structural so this tool stays readable against
 * whichever storage view the read port exposes.
 */
export interface IndexJobSourceView {
  readonly source_ref: string;
  readonly content_identity?: string | null;
}

/** Read port narrowed to the lookup submit needs. `null` means no such row. */
export interface IndexJobReadPort {
  getSourceDoc(sourceRef: string): Promise<IndexJobSourceView | null>;
}

/** 档 C readiness singleton as `poll` projects it: two fields, nothing else. */
export interface CommunityIndexStateView {
  readonly status: string;
  readonly failure_code: string | null;
}

/** `undefined` = the singleton row has never been written (no C job ever ran). */
export interface CommunityIndexStateReader {
  getCommunityIndexState(): Promise<CommunityIndexStateView | undefined>;
}

export interface SubmitIndexJobDeps {
  jobStore: IndexJobStore;
  readPort: IndexJobReadPort;
}

export interface PollIndexJobDeps {
  jobStore: IndexJobStore;
  communityState: CommunityIndexStateReader;
}

/**
 * Submit one durable index job for a pushed content version.
 *
 * Ordered so the cheap idempotency join precedes every storage round trip that
 * could otherwise create a second row: derived id → join → source identity →
 * active-job conflict read → insert → supersede. The sweep follows a
 * successful fresh insert so a failed or conflicted write can never leave the
 * prior version's `ready` rows demoted by work that did not land.
 */
export function createSubmitIndexJobHandler(deps: SubmitIndexJobDeps) {
  return async function submitIndexJobHandler(
    input: SubmitIndexJobInput
  ): Promise<ToolResult> {
    const selectorFault = invalidLocator(input);
    if (selectorFault !== undefined) {
      return selectorFault;
    }

    const jobId = computeChunkId(input.source_ref, input.content_identity);
    const existing = await deps.jobStore.getJob(jobId);
    if (existing !== null) {
      // EXIT: same (source_ref, content_identity) → same job, no new row.
      return submitted(existing, true);
    }

    const identityFault = await sourceIdentityFault(deps.readPort, input);
    if (identityFault !== undefined) {
      return identityFault;
    }

    const conflict = await activeJobConflict(deps.jobStore, input, jobId);
    if (conflict !== undefined) {
      return conflict;
    }

    const created = await deps.jobStore.insertJobOrJoin(
      queuedJob(jobId, input)
    );
    if ("conflict" in created) {
      // EXIT: the one-active-job-per-source constraint rejected the write —
      // the pre-check above read a stale ledger because a conflicting submit
      // raced past it. Same typed answer, now named by the row that owns the
      // source; this call persisted nothing.
      return activeJobError(input.source_ref, created.conflict.job_id);
    }
    // A new content version invalidates the terminal jobs of the old one, so
    // `poll` can never report a stale job as the answer for this source. Only
    // a fresh insert of THIS version sweeps: the join arms (pre-read hit or
    // unique-key `ON CONFLICT` loser) mean the row already existed and its
    // own submit already swept.
    if (created.inserted) {
      await deps.jobStore.supersedeReadyJobs(input.source_ref);
    }
    // `reused` is the store's verdict, not this handler's guess: the unique key
    // collapses two submits that race past the join onto one row, and the loser
    // gets `inserted: false`, so it must report `reused: true`.
    return submitted(created.record, !created.inserted);
  };
}

/**
 * Read a job's persisted state. Pure read: no mutation, no requeue, no
 * projection — a host polls as often as it likes.
 */
export function createPollIndexJobHandler(deps: PollIndexJobDeps) {
  return async function pollIndexJobHandler(
    input: PollIndexJobInput
  ): Promise<ToolResult> {
    const jobIdFault = locatorFault("job_id", input?.job_id);
    if (jobIdFault !== undefined) {
      // EXIT: malformed or oversized id is a locator fault, not a miss — the
      // host must see its request never addressed a row.
      return jobIdFault;
    }
    const jobId = input.job_id;

    const job = await deps.jobStore.getJob(jobId);
    if (job === null) {
      // EXIT: named miss — mirrors read_source_not_found, never an empty body.
      return errorResult({
        error: "index_job_unknown_job",
        job_id: jobId,
        message: `no index job with job_id ${jobId}`,
      });
    }

    const community = await deps.communityState.getCommunityIndexState();
    return textResult(
      JSON.stringify({
        ...job,
        community_index_state:
          community === undefined
            ? null
            : {
                status: community.status,
                failure_code: community.failure_code,
              },
      })
    );
  };
}

export const submitIndexJobTool = (
  deps: SubmitIndexJobDeps
): ToolRegistration => ({
  name: "submit_index_job",
  description:
    "Enqueue a durable corpus index job for one pushed content version, " +
    "addressed by the same (source_ref, content_identity) idempotency key as " +
    "push. Returns the durable job_id immediately — it does NOT run " +
    "extraction, projection, or community summaries, and never changes " +
    "source_documents.status. Re-submitting the same pair joins the existing " +
    "job (reused: true). Typed error results: index_job_invalid_locator, " +
    "index_job_unknown_source, index_job_identity_mismatch, " +
    "index_job_in_progress (with active_job_id).",
  inputSchema: SubmitIndexJobInputSchema,
  handler: createSubmitIndexJobHandler(
    deps
  ) as unknown as ToolRegistration["handler"],
});

export const pollIndexJobTool = (deps: PollIndexJobDeps): ToolRegistration => ({
  name: "poll_index_job",
  description:
    "Read the persisted state of one index job by job_id, plus a separate " +
    "community_index_state sub-object holding only { status, failure_code } " +
    "of the corpus-wide 档 C singleton (null when no C job has ever run). The " +
    "two statuses are distinct facts and are never merged: a job reaching its " +
    "terminal state does not certify 档 C, and 档 C readiness does not certify " +
    "this job. Pure read — never requeues, never mutates. An unknown job_id is " +
    "a named index_job_unknown_job error result, never an empty success.",
  inputSchema: PollIndexJobInputSchema,
  handler: createPollIndexJobHandler(
    deps
  ) as unknown as ToolRegistration["handler"],
});

/** Both submit selectors must be present non-empty strings within the locator
 * ceiling; schema-level `.min(1)` is mirrored here so a direct (non-wire)
 * caller gets the same rejection. */
function invalidLocator(input: SubmitIndexJobInput): ToolResult | undefined {
  const selectors: Record<string, string | undefined> = {
    source_ref: input?.source_ref,
    content_identity: input?.content_identity,
  };
  for (const [name, value] of Object.entries(selectors)) {
    const fault = locatorFault(name, value);
    if (fault !== undefined) {
      // EXIT: structural locator fault — nothing has been read or written.
      return fault;
    }
  }
  return undefined;
}

/**
 * One locator's domain check, shared by submit's selectors and poll's job_id.
 * The ceiling is `read_source`'s locator budget, imported not restated, so
 * the three tools accept exactly the same locator domain. Names empty/missing
 * and over-ceiling distinctly (`missing` vs `oversized`) and never echoes the
 * value: an oversized locator is exactly what would overflow the serialized
 * result, so the offending string is dropped.
 */
function locatorFault(
  name: string,
  value: string | undefined
): ToolResult | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return errorResult({
      error: "index_job_invalid_locator",
      missing: name,
      message: `${name} must be a non-empty string`,
    });
  }
  if (Array.from(value).length > SOURCE_READ_MAX_LOCATOR_CODE_POINTS) {
    return errorResult({
      error: "index_job_invalid_locator",
      oversized: name,
      message: `${name} exceeds ${SOURCE_READ_MAX_LOCATOR_CODE_POINTS} code points`,
    });
  }
  return undefined;
}

/** The 资料 row must exist and carry exactly the identity being indexed. */
async function sourceIdentityFault(
  readPort: IndexJobReadPort,
  input: SubmitIndexJobInput
): Promise<ToolResult | undefined> {
  const source = await readPort.getSourceDoc(input.source_ref);
  if (source === null) {
    return errorResult({
      error: "index_job_unknown_source",
      source_ref: input.source_ref,
      message: `no pushed 资料 with source_ref ${input.source_ref}`,
    });
  }
  // A NULL stored identity is a not-yet-backfilled legacy row: this tool does
  // not guess which content version it stands for, so it is a mismatch.
  if (source.content_identity !== input.content_identity) {
    return errorResult({
      error: "index_job_identity_mismatch",
      source_ref: input.source_ref,
      message:
        "content_identity does not match the pushed version of this source_ref",
    });
  }
  return undefined;
}

/** One source indexes at a time: an active job for a DIFFERENT content
 * version is a conflict, while the same version collapses in `getJob` above. */
async function activeJobConflict(
  jobStore: IndexJobStore,
  input: SubmitIndexJobInput,
  jobId: string
): Promise<ToolResult | undefined> {
  const active = await jobStore.getActiveJobForSource(input.source_ref);
  if (active === null || active.job_id === jobId) {
    return undefined;
  }
  return activeJobError(input.source_ref, active.job_id);
}

/** The one typed `index_job_in_progress` body, shared by the pre-check read
 * and the store-level constraint rejection so both name the racing row alike. */
function activeJobError(sourceRef: string, activeJobId: string): ToolResult {
  return errorResult({
    error: "index_job_in_progress",
    source_ref: sourceRef,
    active_job_id: activeJobId,
    message:
      "an index job for a different content version of this source_ref is " +
      "still active; poll it or wait for a terminal state",
  });
}

/** A queued job: `in_progress` with `started_at: null` is the queue marker. */
function queuedJob(jobId: string, input: SubmitIndexJobInput): IndexJobRecord {
  return {
    job_id: jobId,
    source_ref: input.source_ref,
    content_identity: input.content_identity,
    status: INDEX_JOB_STATUS.IN_PROGRESS,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    failure_code: null,
  };
}

function submitted(job: IndexJobRecord, reused: boolean): ToolResult {
  return textResult(
    JSON.stringify({
      job_id: job.job_id,
      source_ref: job.source_ref,
      content_identity: job.content_identity,
      status: job.status,
      started_at: job.started_at,
      reused,
    })
  );
}

/** Error envelope shape shared with `read_source`: named body, isError true. */
function errorResult(body: Readonly<Record<string, unknown>>): ToolResult {
  return textResult(JSON.stringify(body), true);
}
