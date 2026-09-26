/**
 * Durable index-job runner — the stage orchestrator over the job ledger.
 *
 * One claimed job runs through the four capabilities that make a content
 * version graph-searchable, in this order: read the version's recorded
 * identity and extract switch → extract/merge/persist → projection drain →
 * community detect + summarize + swap. Each capability is reached through
 * `IndexJobStagePorts`, so this module owns only the order and the single
 * terminal ledger write: it holds no pg / LLM / Neo4j dependency and copies no
 * stage algorithm.
 *
 * The rules it exists to enforce:
 * - exactly one terminal outcome per claimed job, published through the
 *   store's lease;
 * - `ready` is reachable only after the summary stage returns;
 * - a stage that cannot complete is `failed` with the code the failing
 *   capability already named, never a code invented here;
 * - `source_documents.status` and `community_index_state` are never written
 *   from here — their owners are the push path and the stages themselves.
 */
import { batchFailureCode } from "./extraction/pipeline.js";
import type { Logger } from "../logging.js";
import {
  INDEX_JOB_ERROR_CODE,
  INDEX_JOB_STATUS,
  type ExtractMethod,
  type IndexJobRecord,
  type IndexJobStore,
  type IndexJobTerminalStatus,
} from "./types.js";

/** The two `source_documents` fields a job is allowed to read about its own
 * source: the version this job was queued for, and the recorded extract
 * switch that decides how it is indexed. */
export interface IndexJobSourceVersion {
  readonly contentIdentity: string | null;
  /** null = the version never recorded a switch, so the job runs standard. */
  readonly extractMethod: ExtractMethod | null;
}

/** The whole extract stage's tally across every batch it ran for this source. */
export interface IndexJobExtractOutcome {
  readonly processed: number;
  /** Legs that sealed a failure, so carry a code in `failureCodes` — the same
   * arithmetic as `BatchSummary.failed`, and the reason the stage's failure
   * code is read from `batchFailureCode` rather than restated here. */
  readonly failed: number;
  /** The separate legs whose transaction rolled back: no sealed record, so no
   * code of their own. Disjoint from `failed`; `notIndexed` is the total. */
  readonly writeFailures: number;
  readonly failureCodes: readonly string[];
}

/**
 * The four capabilities one job composes, as the worker wires them.
 *
 * Contract each port must honour: a stage that cannot complete throws
 * `IndexJobStageError` naming the typed failure code. Any other throw is an
 * internal fault, which the runner deliberately does not turn into a job
 * outcome — the claimed row stays running and the stalled-lease arm re-claims
 * it, so a bug can never be recorded as a product-level stage failure.
 */
export interface IndexJobStagePorts {
  /** null when the source has no 资料 row at all. */
  readSourceVersion(sourceRef: string): Promise<IndexJobSourceVersion | null>;
  /** Takes round after round of this source's pending chunks until the scan
   * answers empty; a failing leg stops the rescan, because a rolled-back write
   * leaves its chunk pending and would be handed out again. `method` is the
   * recorded switch, never a value chosen here. */
  runExtract(
    sourceRef: string,
    method: ExtractMethod | null
  ): Promise<IndexJobExtractOutcome>;
  drainProjection(): Promise<void>;
  summarizeCommunities(): Promise<void>;
}

/** A stage's typed failure: the code is the public fact the job carries. */
export class IndexJobStageError extends Error {
  constructor(
    readonly failureCode: string,
    message: string
  ) {
    super(message);
    this.name = "IndexJobStageError";
  }
}

export interface IndexJobRunnerDeps {
  store: IndexJobStore;
  ports: IndexJobStagePorts;
  logger: Logger;
  /** Injectable so a test can assert the published `finished_at`. */
  clock?: () => Date;
}

/**
 * Run one claimed job to its single terminal outcome, or return null when
 * this worker no longer holds the row.
 */
export async function runIndexJob(
  deps: IndexJobRunnerDeps,
  job: IndexJobRecord
): Promise<IndexJobRecord | null> {
  try {
    return await runIndexJobStages(deps, job);
  } catch (err) {
    if (!(err instanceof IndexJobStageError)) throw err;
    return publishOutcome(deps, job, INDEX_JOB_STATUS.FAILED, err.failureCode);
  }
}

async function runIndexJobStages(
  deps: IndexJobRunnerDeps,
  job: IndexJobRecord
): Promise<IndexJobRecord | null> {
  const before = pairVerdict(
    await deps.ports.readSourceVersion(job.source_ref),
    job
  );
  if (before.kind === "terminal") {
    return publishOutcome(deps, job, before.status, before.failureCode);
  }

  const extracted = await deps.ports.runExtract(
    job.source_ref,
    before.version.extractMethod
  );
  deps.logger.info("index-job-extract-stage", {
    jobId: job.job_id,
    processed: extracted.processed,
    failed: extracted.failed,
  });
  // WHY the pipeline's answer is also the gate: `batchFailureCode` names a code
  // exactly when the tally indexed nothing, and a tally that indexed everything
  // answers null. Reading both facts from that one answer leaves the runner no
  // second predicate to drift and no code of its own to supply.
  const extractFailure = batchFailureCode(extracted);
  if (extractFailure !== null) {
    return publishOutcome(deps, job, INDEX_JOB_STATUS.FAILED, extractFailure);
  }

  await deps.ports.drainProjection();
  await deps.ports.summarizeCommunities();
  // The pair is read again here because a push is never blocked by an active
  // job — only a second *submit* is. A new content version can therefore land
  // mid-stage, and its overwrite drops the chunks this job indexed. Publishing
  // `ready` over it would report the superseded text as graph-searchable; the
  // newer version gets its own job instead.
  const after = pairVerdict(
    await deps.ports.readSourceVersion(job.source_ref),
    job
  );
  if (after.kind === "terminal") {
    return publishOutcome(deps, job, after.status, after.failureCode);
  }
  // WHY ready only here: the summary stage's own atomic generation swap is the
  // single writer of corpus-level C readiness, so publishing job `ready` before
  // it returns would report a summary set that no reader may be served yet.
  return publishOutcome(deps, job, INDEX_JOB_STATUS.READY, null);
}

/**
 * Either the current version the job is allowed to index, or the terminal
 * state the 资料 row now deserves instead.
 */
type PairVerdict =
  | {
      readonly kind: "index";
      readonly version: IndexJobSourceVersion;
    }
  | {
      readonly kind: "terminal";
      readonly status: IndexJobTerminalStatus;
      readonly failureCode: string | null;
    };

/**
 * What this job's pair deserves, given what the 资料 row currently says.
 *
 * WHY stale and not failed: a newer content version landed, so the job names a
 * version that is no longer current — indexing it would build the graph of
 * superseded text, and there is no stage failure to report. A source with no
 * row at all is the `submit_index_job` miss the host already knows how to
 * classify, not a superseded version.
 */
function pairVerdict(
  source: IndexJobSourceVersion | null,
  job: IndexJobRecord
): PairVerdict {
  if (source === null) {
    return {
      kind: "terminal",
      status: INDEX_JOB_STATUS.FAILED,
      failureCode: INDEX_JOB_ERROR_CODE.UNKNOWN_SOURCE,
    };
  }
  return source.contentIdentity === job.content_identity
    ? { kind: "index", version: source }
    : { kind: "terminal", status: INDEX_JOB_STATUS.STALE, failureCode: null };
}

async function publishOutcome(
  deps: IndexJobRunnerDeps,
  job: IndexJobRecord,
  status: IndexJobTerminalStatus,
  failureCode: string | null
): Promise<IndexJobRecord | null> {
  const finishedAt = (deps.clock?.() ?? new Date()).toISOString();
  const row = await deps.store.publishJobOutcome(job.job_id, {
    status,
    failureCode,
    finishedAt,
    // The token this worker's own claim wrote: a row whose started_at moved
    // belongs to another worker now.
    claimedStartedAt: job.started_at,
  });
  if (row === null) {
    // WHY not a retry: a null answer means the row already carries another
    // worker's terminal state. This worker's stages still ran, but the ledger
    // is the authority on what happened, so the outcome is dropped and named.
    deps.logger.warn("index-job-lease-lost", {
      jobId: job.job_id,
      status,
      failure_code: failureCode,
    });
    return null;
  }
  deps.logger.info("index-job-terminal", {
    jobId: row.job_id,
    source_ref: row.source_ref,
    status: row.status,
    failure_code: row.failure_code,
    finished_at: row.finished_at,
  });
  return row;
}
