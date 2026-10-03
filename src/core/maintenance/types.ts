/**
 * Durable maintenance work — shared vocabulary (specs/maintenance-durable-work.md).
 *
 * Maintenance work kinds, the bound-job key, attempt history, the lease
 * constants, and the typed work failures. This is a sibling capability to the
 * corpus index-job ledger in `core/types.ts`, not an extension of it: the spec
 * allows reusing durable storage "where it satisfies the contract", and
 * `index_jobs` binds nothing beyond `(source_ref, content_identity)` — no work
 * kind, no revision vector, no attempt history — so maintenance needs its own
 * tables and its own store. The index-job ledger's public contract is
 * unchanged by this capability.
 */
import type { Clock } from "../clock.js";

/**
 * The three maintenance work kinds. They keep independent state, so a job key
 * never spans two of them: the same source scheduled for a re-extraction and
 * for a conflict check is two jobs.
 */
export const MAINTENANCE_WORK_KINDS = [
  "extract_publish",
  "conflict_check",
  "projection_rebuild",
] as const;

export type MaintenanceWorkKind = (typeof MAINTENANCE_WORK_KINDS)[number];

/**
 * The lifecycle the spec's state table names. `pending` is durable work that no
 * worker owns yet — distinct from the index-job ledger, where a queued row is
 * `in_progress` with a null `started_at`, because here the attempt count and
 * the retry deadline are first-class.
 */
export const MAINTENANCE_WORK_STATUS = [
  "pending",
  "running",
  "ready",
  "failed",
  "stale",
] as const;

export type MaintenanceWorkStatus = (typeof MAINTENANCE_WORK_STATUS)[number];

/** Whether an operator retry may return this job to `pending`. */
export function isRetryableStatus(status: MaintenanceWorkStatus): boolean {
  return status === "failed" || status === "stale";
}

/**
 * Typed work failures. A failure is always a value that names its class — never
 * an empty success, and never a message the caller has to parse. The subset the
 * spec fixes for maintenance (Physical collection) is present; `ruleset_unavailable`
 * is the config-class code, and `unsupported_source_binding` arrives with the
 * source-lifecycle slice (MP5).
 */
export const MAINTENANCE_WORK_FAILURE_CODES = [
  "invalid_input",
  "access_denied",
  "input_stale",
  "lease_lost",
  "ruleset_unavailable",
  "resource_exhausted",
  "backend_unavailable",
  "execution_timeout",
] as const;

export type MaintenanceWorkFailureCode =
  (typeof MAINTENANCE_WORK_FAILURE_CODES)[number];

/**
 * Automatic transient retry budget. The spec fixes all three numbers: at most
 * three attempts per job, delayed 5 then 30 seconds, then a visible `failed`.
 * They are constants, not configuration, so no deployment can quietly widen
 * the retry window.
 */
export const MAX_AUTO_ATTEMPTS = 3;
export const RETRY_DELAY_MS = [5_000, 30_000] as const;

/**
 * Worker lease and absolute attempt bound (spec §State and recovery).
 *
 * The spec's third number — heartbeat at most every minute — is deliberately not
 * a constant here. It is an obligation on whoever runs the heartbeat loop, and
 * this slice has no loop yet; a constant nothing reads would document nothing.
 */
export const WORK_LEASE_MS = 5 * 60 * 1000;
export const WORK_ABSOLUTE_LIMIT_MS = 30 * 60 * 1000;

/**
 * One entry of the dependency vector a job is bound to. `extractionRevision`
 * is nullable because a source with no accepted extraction yet has none, and
 * that absence is not revision zero.
 */
export interface MaintenanceDependency {
  readonly sourceRef: string;
  readonly generation: number;
  readonly extractionRevision: number | null;
  readonly relationBuckets: readonly string[];
}

/**
 * The request that produces one job key. Every field here is part of the key,
 * so two requests that differ in any of them are two jobs rather than one
 * joined job — that is the mechanism behind "different dependency sets cannot
 * join the same conflict-check/rebuild job".
 */
export interface MaintenanceWorkRequest {
  readonly workKind: MaintenanceWorkKind;
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly sourceGeneration: number;
  /** Config/ruleset revision; a model or ruleset change supersedes work even
   * when source content is unchanged. */
  readonly configRevision: string;
  /** Canonical unsorted input; the revision digest is order-independent. */
  readonly dependencies: readonly MaintenanceDependency[];
}

/** One persisted job, bound to exactly one key. */
export interface MaintenanceJobRecord {
  readonly jobKey: string;
  readonly workKind: MaintenanceWorkKind;
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly sourceGeneration: number;
  /** Digest of the canonical sorted dependency vector. */
  readonly inputRevision: string;
  readonly configRevision: string;
  readonly status: MaintenanceWorkStatus;
  /** Lifetime attempt count; also names the next attempt number. */
  readonly attemptCount: number;
  /** Consecutive AUTOMATIC attempts since the last explicit retry. The retry
   * ladder keys off this, not off the lifetime count, so an explicit retry after
   * an exhausted budget starts a fresh three-attempt budget while attempts
   * 1..3 stay in the history. */
  readonly autoAttemptCount: number;
  readonly maxAttempts: number;
  /** Earliest instant the next automatic attempt may run; null when none is scheduled. */
  readonly nextAttemptAt: string | null;
  /** Typed failure that last ended an attempt of this job. */
  readonly lastFailureCode: MaintenanceWorkFailureCode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One attempt of a job. Attempts are the retry history: an explicit retry
 * adds a row and never edits or removes an earlier one, so "three transient
 * attempts exhausted" stays auditable after an operator retries.
 */
export interface MaintenanceAttemptRecord {
  readonly jobKey: string;
  readonly attemptNumber: number;
  readonly fencingToken: string;
  /** Typed failure that ended this attempt; null while it still holds its lease. */
  readonly failureCode: MaintenanceWorkFailureCode | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** True when a reclaim took this attempt's lease away rather than the
   * attempt finishing on its own. */
  readonly reclaimed: boolean;
}

/**
 * What a worker holds after a successful claim: the attempt number, an
 * unguessable fencing token, the lease expiry, and a copy of the bound inputs
 * so the worker can recheck them without a second read.
 */
export interface MaintenanceAttemptGuard {
  readonly jobKey: string;
  readonly attemptNumber: number;
  readonly fencingToken: string;
  readonly workKind: MaintenanceWorkKind;
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly sourceGeneration: number;
  readonly inputRevision: string;
  readonly configRevision: string;
  readonly leaseExpiresAt: string;
  readonly attemptStartedAt: string;
}

/** The live inputs a write must be checked against. */
export interface MaintenanceLiveInputs {
  readonly configRevision: string;
  readonly dependencies: readonly MaintenanceDependency[];
}

/** Guard verdict: `ok` or the typed reason the write is refused. */
export type MaintenanceGuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: MaintenanceWorkFailureCode };

/** A scheduled job: the persisted record, and whether this call created it. */
export type MaintenanceScheduleOutcome =
  | { readonly record: MaintenanceJobRecord; readonly inserted: boolean }
  | { readonly refused: MaintenanceWorkFailureCode; readonly detail: string };

/**
 * The outcome a worker publishes once its stages finish. `ready` and `stale`
 * carry no failure code; `failed` always does.
 */
export type MaintenanceSettleOutcome =
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly failureCode: MaintenanceWorkFailureCode }
  | { readonly status: "stale" };

/**
 * What settling actually did, and it keeps the three refusals apart:
 * `lease_lost` means this worker no longer owns the attempt, `timed_out` means
 * the attempt outlived its absolute bound, and `stale` means the bound inputs
 * moved — which supersedes the job rather than failing it. Collapsing these into
 * one "did not settle" would hide the difference between a reclaimable lease and
 * an attempt that must never run again.
 */
export type MaintenanceSettleResult =
  | { readonly result: "settled"; readonly record: MaintenanceJobRecord }
  | { readonly result: "lease_lost" }
  | { readonly result: "stale"; readonly record: MaintenanceJobRecord }
  /**
   * The attempt ran past its absolute bound. It carries the record because the
   * job is settled as `failed` with `execution_timeout` — the spec's "current
   * attempt stopped with a typed cause", with an explicit retry as the remedy.
   */
  | { readonly result: "timed_out"; readonly record: MaintenanceJobRecord };

/** Reclaim outcome for one expired attempt. */
export type MaintenanceReclaimOutcome =
  | { readonly jobKey: string; readonly reclaimed: true }
  | { readonly jobKey: string; readonly reclaimed: false };

/**
 * Persistence seam for maintenance work.
 *
 * Two implementations exist and must agree: `maintenance-work-pg.ts` is the
 * durable one (restart survival is a Postgres property) and
 * `maintenance-work-memory.ts` is the twin the unit suites run against. Every
 * method takes the caller's clock reading explicitly so one instant decides both
 * the write and the comparison it is fenced by.
 */
export interface MaintenanceWorkStore {
  /** Insert the job for this key, or return the existing one joined. */
  scheduleWork(
    request: MaintenanceWorkRequest,
    now: Date
  ): Promise<MaintenanceScheduleOutcome>;
  getJob(jobKey: string): Promise<MaintenanceJobRecord | null>;
  /**
   * Atomically claim the oldest `pending` job whose retry deadline has passed,
   * mint a fresh fencing token, and extend the lease. Returns null when nothing
   * is claimable; concurrent claimants never receive the same job.
   *
   * Only `pending` rows are claimable. A `running` row whose lease expired
   * belongs to `reclaimExpiredWork` first — a third party implementing this
   * interface must not claim expired-lease rows directly, because that is what
   * lets two workers each believe they own a job whose previous attempt died.
   */
  claimWork(now: Date): Promise<MaintenanceAttemptGuard | null>;
  /** Extend the lease while the token, lease, and absolute bound still hold.
   * False means the attempt was reclaimed or timed out and the worker must stop. */
  heartbeatWork(guard: MaintenanceAttemptGuard, now: Date): Promise<boolean>;
  /**
   * Operator retry: return a `failed` or `stale` job to `pending` with a fresh
   * automatic budget. Prior attempts stay in the history untouched — this adds a
   * new attempt rather than rewriting the old ones.
   *
   * Returns null — never the unchanged row — for a job that is not retryable, so
   * a caller cannot mistake "retry did nothing" for "retry happened". Both
   * implementations must answer identically here.
   */
  retryWork(jobKey: string, now: Date): Promise<MaintenanceJobRecord | null>;
  /** Publish the terminal outcome, fenced by token, lease, and bound inputs. */
  settleWork(
    guard: MaintenanceAttemptGuard,
    outcome: MaintenanceSettleOutcome,
    live: MaintenanceLiveInputs,
    now: Date
  ): Promise<MaintenanceSettleResult>;
  /** Invalidate the tokens of attempts whose lease expired, so a stale worker
   * cannot heartbeat, write, publish, or pin collection after reclaim. */
  reclaimExpiredWork(now: Date): Promise<readonly MaintenanceReclaimOutcome[]>;
  /** Full attempt history for a job, oldest first. */
  listAttempts(jobKey: string): Promise<readonly MaintenanceAttemptRecord[]>;
  close(): Promise<void>;
}

/** Dependencies every maintenance work operation needs. */
/**
 * How a refusal is reported at a public entry. A refusal is a value, never a
 * thrown error, because a bad request is an expected outcome: the caller must be
 * able to tell `invalid_input` from `access_denied` without parsing a message.
 */
export type MaintenanceFailure =
  | { readonly refused: true; readonly code: MaintenanceWorkFailureCode; readonly detail: string }
  | { readonly refused: false };

export interface MaintenanceWorkDeps {
  readonly store: MaintenanceWorkStore;
  readonly clock: Clock;
}
