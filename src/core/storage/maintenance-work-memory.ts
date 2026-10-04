/**
 * In-memory twin of the maintenance work store.
 *
 * Durability across a process restart is a Postgres property, so this twin
 * cannot answer MP2's recovery case — that case runs against the real backend.
 * What it does answer is the policy: join semantics, the retry ladder, attempt
 * history, and every fencing rule, through exactly the same pure predicates the
 * SQL store implements in-database. Both implementations must agree on these
 * rules; the PG suite re-proves the same behaviours on the real boundary.
 */
import { randomUUID } from "node:crypto";

import { MaintenanceStoreError } from "../maintenance/store-error.js";
import {
  absoluteDeadlineFrom,
  canonicalDependencyRevision,
  computeMaintenanceJobKey,
  leaseExpiryFrom,
  planSettle,
  verifyAttemptGuard,
  verifyAttemptOwnership,
} from "../maintenance/durable-work.js";
import {
  isRetryableStatus,
  MAX_AUTO_ATTEMPTS,
  type MaintenanceAttemptGuard,
  type MaintenanceAttemptRecord,
  type MaintenanceDependency,
  type MaintenanceJobRecord,
  type MaintenanceLiveInputs,
  type MaintenanceReclaimOutcome,
  type MaintenanceScheduleOutcome,
  type MaintenanceSettleOutcome,
  type MaintenanceSettleResult,
  type MaintenanceWorkRequest,
  type MaintenanceWorkFailureCode,
  type MaintenanceWorkStatus,
  type MaintenanceWorkStore,
} from "../maintenance/types.js";

interface StoredJob extends MaintenanceJobRecord {
  readonly dependencies: readonly MaintenanceDependency[];
  readonly fencingToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly attemptStartedAt: string | null;
}

export class InMemoryMaintenanceWorkStore implements MaintenanceWorkStore {
  private readonly jobs = new Map<string, StoredJob>();
  private readonly attempts = new Map<string, MaintenanceAttemptRecord[]>();
  private readonly progressListeners = new Set<
    (sourceRef: string, generation: number) => void
  >();
  private closed = false;

  /** Internal observer for publication summaries backed by this same ledger. */
  onProgressChange(
    listener: (sourceRef: string, generation: number) => void
  ): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  publicationJobsForSource(
    sourceRef: string,
    generation: number
  ): readonly MaintenanceJobRecord[] {
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.sourceRef === sourceRef && job.sourceGeneration === generation
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map(toRecord);
  }

  publicationDependenciesForGuard(
    guard: MaintenanceAttemptGuard
  ): readonly MaintenanceDependency[] | null {
    const job = this.jobs.get(guard.jobKey);
    if (job === undefined) return null;
    return job.dependencies.map((dependency) => ({
      ...dependency,
      relationBuckets: [...dependency.relationBuckets],
    }));
  }

  publicationGuardFailure(
    guard: MaintenanceAttemptGuard,
    now: Date
  ): MaintenanceWorkFailureCode | null {
    const job = this.jobs.get(guard.jobKey);
    if (job === undefined || job.status !== "running") return "lease_lost";
    const actual = toGuard(job);
    const ownership = verifyAttemptOwnership(actual, now, guard.fencingToken);
    if (!ownership.ok) return ownership.code;
    if (!samePublicationGuardInputs(actual, guard)) return "input_stale";
    const history = this.attempts.get(guard.jobKey);
    if (!hasOpenPublicationAttempt(history, guard))
      return "backend_unavailable";
    return null;
  }

  preparePublicationReady(
    guard: MaintenanceAttemptGuard,
    now: Date,
    completedAt: Date = now
  ): { readonly failure: MaintenanceWorkFailureCode | null; commit(): void } {
    const failure = this.publicationGuardFailure(guard, now);
    const job = this.jobs.get(guard.jobKey);
    if (failure !== null || job === undefined) {
      return { failure: failure ?? "lease_lost", commit: () => undefined };
    }
    const history = this.attempts.get(guard.jobKey)!;
    const historyIndex = history.findIndex(
      (attempt) =>
        attempt.attemptNumber === guard.attemptNumber &&
        attempt.fencingToken === guard.fencingToken &&
        attempt.finishedAt === null
    );
    const stamp = completedAt.toISOString();
    return {
      failure: null,
      commit: () => {
        this.jobs.set(job.jobKey, {
          ...job,
          status: "ready",
          lastFailureCode: null,
          nextAttemptAt: null,
          fencingToken: null,
          leaseExpiresAt: null,
          attemptStartedAt: null,
          updatedAt: stamp,
        });
        history[historyIndex] = {
          ...history[historyIndex]!,
          failureCode: null,
          finishedAt: stamp,
          reclaimed: false,
        };
        this.notifyProgress(job.sourceRef, job.sourceGeneration);
      },
    };
  }

  async scheduleWork(
    request: MaintenanceWorkRequest,
    now: Date
  ): Promise<MaintenanceScheduleOutcome> {
    this.assertOpen();
    const jobKey = computeMaintenanceJobKey(request);
    const existing = this.jobs.get(jobKey);
    if (existing) return { record: toRecord(existing), inserted: false };

    const stamp = now.toISOString();
    const stored: StoredJob = {
      jobKey,
      workKind: request.workKind,
      sourceRef: request.sourceRef,
      sourceVersion: request.sourceVersion,
      sourceGeneration: request.sourceGeneration,
      inputRevision: canonicalDependencyRevision(request.dependencies),
      dependencies: request.dependencies.map((dependency) => ({
        ...dependency,
        relationBuckets: [...dependency.relationBuckets],
      })),
      configRevision: request.configRevision,
      status: "pending",
      attemptCount: 0,
      autoAttemptCount: 0,
      maxAttempts: MAX_AUTO_ATTEMPTS,
      nextAttemptAt: stamp,
      lastFailureCode: null,
      createdAt: stamp,
      updatedAt: stamp,
      fencingToken: null,
      leaseExpiresAt: null,
      attemptStartedAt: null,
    };
    this.jobs.set(jobKey, stored);
    this.notifyProgress(stored.sourceRef, stored.sourceGeneration);
    return { record: toRecord(stored), inserted: true };
  }

  async getJob(jobKey: string): Promise<MaintenanceJobRecord | null> {
    this.assertOpen();
    const job = this.jobs.get(jobKey);
    return job ? toRecord(job) : null;
  }

  async claimWork(now: Date): Promise<MaintenanceAttemptGuard | null> {
    this.assertOpen();
    const stamp = now.toISOString();
    const target = [...this.jobs.values()]
      .filter(
        (job) =>
          job.status === "pending" &&
          (job.nextAttemptAt === null || job.nextAttemptAt <= stamp)
      )
      .sort(byQueueOrder)[0];
    if (!target) return null;

    const fencingToken = randomUUID();
    const claimed: StoredJob = {
      ...target,
      status: "running",
      attemptCount: target.attemptCount + 1,
      autoAttemptCount: target.autoAttemptCount + 1,
      nextAttemptAt: null,
      lastFailureCode: null,
      fencingToken,
      leaseExpiresAt: leaseExpiryFrom(stamp),
      attemptStartedAt: stamp,
      updatedAt: stamp,
    };
    this.jobs.set(claimed.jobKey, claimed);
    this.appendAttempt({
      jobKey: claimed.jobKey,
      attemptNumber: claimed.attemptCount,
      fencingToken,
      failureCode: null,
      startedAt: stamp,
      finishedAt: null,
      reclaimed: false,
    });
    this.notifyProgress(claimed.sourceRef, claimed.sourceGeneration);
    return toGuard(claimed);
  }

  /**
   * A heartbeat fences on ownership only — token, lease, and the absolute
   * attempt bound — because it carries no re-read of canonical lifecycle state.
   * The dependency vector is rechecked where the live inputs are actually
   * available, which is `settleWork`.
   */
  async heartbeatWork(
    guard: MaintenanceAttemptGuard,
    now: Date
  ): Promise<boolean> {
    this.assertOpen();
    const job = this.jobs.get(guard.jobKey);
    if (!job || job.status !== "running") return false;

    const verdict = verifyAttemptOwnership(
      toGuard(job),
      now,
      guard.fencingToken
    );
    if (!verdict.ok) return false;

    const absolute = absoluteDeadlineFrom(
      job.attemptStartedAt ?? now.toISOString()
    );
    this.jobs.set(job.jobKey, {
      ...job,
      leaseExpiresAt: earlier(leaseExpiryFrom(now.toISOString()), absolute),
      updatedAt: now.toISOString(),
    });
    this.notifyProgress(job.sourceRef, job.sourceGeneration);
    return true;
  }

  async retryWork(
    jobKey: string,
    now: Date
  ): Promise<MaintenanceJobRecord | null> {
    this.assertOpen();
    const job = this.jobs.get(jobKey);
    if (!job) return null;
    // null, not a success-shaped record, for a job that is not retryable — the
    // SQL twin's `WHERE status IN ('failed','stale')` returns no row here, and the
    // two implementations must answer identically.
    if (!isRetryableStatus(job.status)) return null;
    const stamp = now.toISOString();
    const retried: StoredJob = {
      ...job,
      status: "pending",
      autoAttemptCount: 0,
      nextAttemptAt: stamp,
      lastFailureCode: null,
      updatedAt: stamp,
    };
    this.jobs.set(jobKey, retried);
    this.notifyProgress(retried.sourceRef, retried.sourceGeneration);
    return toRecord(retried);
  }

  async settleWork(
    guard: MaintenanceAttemptGuard,
    outcome: MaintenanceSettleOutcome,
    live: MaintenanceLiveInputs,
    now: Date
  ): Promise<MaintenanceSettleResult> {
    this.assertOpen();
    const job = this.jobs.get(guard.jobKey);
    if (!job || job.status !== "running") return { result: "lease_lost" };

    const verdict = verifyAttemptGuard(
      toGuard(job),
      live,
      now,
      guard.fencingToken
    );
    const stamp = now.toISOString();
    if (!verdict.ok && verdict.code === "input_stale") {
      const superseded = this.persist(job, "stale", stamp, "input_stale");
      this.finishAttempt({
        jobKey: job.jobKey,
        attemptNumber: job.attemptCount,
        failureCode: "input_stale",
        finishedAt: stamp,
      });
      this.notifyProgress(job.sourceRef, job.sourceGeneration);
      return { result: "stale", record: toRecord(superseded) };
    }
    if (!verdict.ok) {
      if (verdict.code !== "execution_timeout") return { result: "lease_lost" };
      // Same terminal shape as the SQL twin: settle the job so the attempt's
      // real cause survives, instead of leaving it for a reclaim to overwrite.
      const timedOut: StoredJob = {
        ...job,
        status: "failed",
        lastFailureCode: "execution_timeout",
        nextAttemptAt: null,
        fencingToken: null,
        leaseExpiresAt: null,
        attemptStartedAt: null,
        updatedAt: stamp,
      };
      this.jobs.set(timedOut.jobKey, timedOut);
      this.finishAttempt({
        jobKey: job.jobKey,
        attemptNumber: job.attemptCount,
        failureCode: "execution_timeout",
        finishedAt: stamp,
      });
      this.notifyProgress(job.sourceRef, job.sourceGeneration);
      return { result: "timed_out", record: toRecord(timedOut) };
    }

    const settled = this.applyOutcome(job, outcome, stamp);
    this.finishAttempt({
      jobKey: job.jobKey,
      attemptNumber: job.attemptCount,
      failureCode: outcome.status === "failed" ? outcome.failureCode : null,
      finishedAt: stamp,
    });
    this.notifyProgress(job.sourceRef, job.sourceGeneration);
    return { result: "settled", record: toRecord(settled) };
  }

  async reclaimExpiredWork(
    now: Date
  ): Promise<readonly MaintenanceReclaimOutcome[]> {
    this.assertOpen();
    const stamp = now.toISOString();
    const outcomes: MaintenanceReclaimOutcome[] = [];
    for (const job of [...this.jobs.values()]) {
      if (
        job.status !== "running" ||
        job.leaseExpiresAt === null ||
        job.leaseExpiresAt > stamp
      ) {
        continue;
      }
      const reclaimed: StoredJob = {
        ...this.persist(job, "pending", stamp, job.lastFailureCode),
        nextAttemptAt: stamp,
      };
      this.jobs.set(reclaimed.jobKey, reclaimed);
      this.notifyProgress(job.sourceRef, job.sourceGeneration);
      this.finishAttempt({
        jobKey: job.jobKey,
        attemptNumber: job.attemptCount,
        failureCode: "lease_lost",
        finishedAt: stamp,
        reclaimed: true,
        tolerateMissing: true,
      });
      this.notifyProgress(job.sourceRef, job.sourceGeneration);
      outcomes.push({ jobKey: job.jobKey, reclaimed: true });
    }
    return outcomes;
  }

  async listAttempts(
    jobKey: string
  ): Promise<readonly MaintenanceAttemptRecord[]> {
    this.assertOpen();
    return [...(this.attempts.get(jobKey) ?? [])];
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /**
   * Terminal or retrying status for a settled attempt, and the live lease
   * released in every case — a settled job holds no token, so nothing can write
   * through an attempt that already finished.
   */
  /**
   * Terminal or retrying status for a settled attempt, and the live lease
   * released in every case — a settled job holds no token, so nothing can write
   * through an attempt that already finished. `planSettle` owns the policy, so
   * this twin and the SQL store cannot drift apart on the retry ladder.
   */
  private applyOutcome(
    job: StoredJob,
    outcome: MaintenanceSettleOutcome,
    stamp: string
  ): StoredJob {
    const plan = planSettle(job.autoAttemptCount, MAX_AUTO_ATTEMPTS, outcome);
    const next: StoredJob = {
      ...job,
      status: plan.status,
      lastFailureCode: plan.lastFailureCode,
      nextAttemptAt:
        plan.nextDelayMs === null ? null : shift(stamp, plan.nextDelayMs),
      fencingToken: null,
      leaseExpiresAt: null,
      attemptStartedAt: null,
      updatedAt: stamp,
    };
    this.jobs.set(next.jobKey, next);
    return next;
  }

  private persist(
    job: StoredJob,
    status: MaintenanceWorkStatus,
    stamp: string,
    lastFailureCode: StoredJob["lastFailureCode"]
  ): StoredJob {
    const next: StoredJob = {
      ...job,
      status,
      lastFailureCode,
      nextAttemptAt: null,
      fencingToken: null,
      leaseExpiresAt: null,
      attemptStartedAt: null,
      updatedAt: stamp,
    };
    this.jobs.set(job.jobKey, next);
    return next;
  }

  private assertOpen(): void {
    if (this.closed) {
      // The same typed fault the SQL twin raises, so a caller branching on
      // `failureCode` gets the same answer from either store.
      throw new MaintenanceStoreError(
        "maintenance work store used after close",
        "backend_unavailable"
      );
    }
  }

  private notifyProgress(sourceRef: string, generation: number): void {
    for (const listener of this.progressListeners) {
      listener(sourceRef, generation);
    }
  }

  private appendAttempt(attempt: MaintenanceAttemptRecord): void {
    const history = this.attempts.get(attempt.jobKey) ?? [];
    history.push(attempt);
    this.attempts.set(attempt.jobKey, history);
  }

  private finishAttempt(attempt: {
    readonly jobKey: string;
    readonly attemptNumber: number;
    readonly failureCode: MaintenanceAttemptRecord["failureCode"];
    readonly finishedAt: string;
    readonly reclaimed?: boolean;
    readonly tolerateMissing?: boolean;
  }): void {
    const history = this.attempts.get(attempt.jobKey) ?? [];
    const index = history.findIndex(
      (entry) => entry.attemptNumber === attempt.attemptNumber
    );
    if (index >= 0 && history[index]!.finishedAt !== null) return;
    if (index < 0 && attempt.tolerateMissing) return;
    if (index < 0) {
      // A settle whose attempt row is missing means the history is broken, and
      // reporting `settled` on top of it would report a success the ledger cannot
      // explain.
      throw new MaintenanceStoreError(
        `maintenance attempt ${attempt.attemptNumber} missing for job ${attempt.jobKey}`,
        "backend_unavailable"
      );
    }
    history[index] = {
      ...history[index]!,
      failureCode: attempt.failureCode,
      finishedAt: attempt.finishedAt,
      reclaimed: attempt.reclaimed ?? false,
    };
  }
}

function earlier(left: string, right: string): string {
  return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}

function shift(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

/**
 * Queue order mirroring the SQL claim's `ORDER BY next_attempt_at ASC NULLS FIRST,
 * created_at, job_key`. Nulls first is Postgres's default for ASC and must be
 * reproduced explicitly: the twins claiming different jobs from the same ledger
 * state is a parity bug, not a preference.
 */
function byQueueOrder(left: StoredJob, right: StoredJob): number {
  if (left.nextAttemptAt !== right.nextAttemptAt) {
    const leftRank =
      left.nextAttemptAt === null ? -Infinity : Date.parse(left.nextAttemptAt);
    const rightRank =
      right.nextAttemptAt === null
        ? -Infinity
        : Date.parse(right.nextAttemptAt);
    if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  return left.jobKey < right.jobKey ? -1 : 1;
}

function toRecord(job: StoredJob): MaintenanceJobRecord {
  const {
    fencingToken,
    leaseExpiresAt,
    attemptStartedAt,
    dependencies,
    ...record
  } = job;
  return record;
}

function samePublicationGuardInputs(
  actual: MaintenanceAttemptGuard,
  presented: MaintenanceAttemptGuard
): boolean {
  const fields = [
    "attemptNumber",
    "sourceRef",
    "sourceVersion",
    "sourceGeneration",
    "inputRevision",
    "configRevision",
    "leaseExpiresAt",
    "attemptStartedAt",
  ] as const satisfies readonly (keyof MaintenanceAttemptGuard)[];
  return fields.every((field) => actual[field] === presented[field]);
}

function hasOpenPublicationAttempt(
  history: readonly MaintenanceAttemptRecord[] | undefined,
  guard: MaintenanceAttemptGuard
): boolean {
  return (
    history?.some(
      (attempt) =>
        attempt.attemptNumber === guard.attemptNumber &&
        attempt.fencingToken === guard.fencingToken &&
        attempt.finishedAt === null
    ) ?? false
  );
}

function toGuard(job: StoredJob): MaintenanceAttemptGuard {
  return {
    jobKey: job.jobKey,
    attemptNumber: job.attemptCount,
    fencingToken: job.fencingToken ?? "",
    workKind: job.workKind,
    sourceRef: job.sourceRef,
    sourceVersion: job.sourceVersion,
    sourceGeneration: job.sourceGeneration,
    inputRevision: job.inputRevision,
    configRevision: job.configRevision,
    leaseExpiresAt: job.leaseExpiresAt ?? "",
    attemptStartedAt: job.attemptStartedAt ?? "",
  };
}
