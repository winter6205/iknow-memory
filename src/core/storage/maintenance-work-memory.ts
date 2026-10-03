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

import { GraphragError } from "../errors.js";
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
  MAX_AUTO_ATTEMPTS,
  type MaintenanceAttemptGuard,
  type MaintenanceAttemptRecord,
  type MaintenanceJobRecord,
  type MaintenanceLiveInputs,
  type MaintenanceReclaimOutcome,
  type MaintenanceScheduleOutcome,
  type MaintenanceSettleOutcome,
  type MaintenanceSettleResult,
  type MaintenanceWorkRequest,
  type MaintenanceWorkStatus,
  type MaintenanceWorkStore,
} from "../maintenance/types.js";

interface StoredJob extends MaintenanceJobRecord {
  readonly fencingToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly attemptStartedAt: string | null;
}

export class InMemoryMaintenanceWorkStore implements MaintenanceWorkStore {
  private readonly jobs = new Map<string, StoredJob>();
  private readonly attempts = new Map<string, MaintenanceAttemptRecord[]>();
  private closed = false;

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

    const absolute = absoluteDeadlineFrom(job.attemptStartedAt ?? now.toISOString());
    this.jobs.set(job.jobKey, {
      ...job,
      leaseExpiresAt: earlier(leaseExpiryFrom(now.toISOString()), absolute),
      updatedAt: now.toISOString(),
    });
    return true;
  }

  async retryWork(
    jobKey: string,
    now: Date
  ): Promise<MaintenanceJobRecord | null> {
    this.assertOpen();
    const job = this.jobs.get(jobKey);
    if (!job) return null;
    if (job.status !== "failed" && job.status !== "stale") {
      return toRecord(job);
    }
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

    const verdict = verifyAttemptGuard(toGuard(job), live, now, guard.fencingToken);
    const stamp = now.toISOString();
    if (!verdict.ok && verdict.code === "input_stale") {
      const superseded = this.persist(job, "stale", stamp, null);
      this.finishAttempt(job.jobKey, job.attemptCount, "input_stale", stamp);
      return { result: "stale", record: toRecord(superseded) };
    }
    if (!verdict.ok) {
      return verdict.code === "execution_timeout"
        ? { result: "timed_out" }
        : { result: "lease_lost" };
    }

    const settled = this.applyOutcome(job, outcome, stamp);
    this.finishAttempt(
      job.jobKey,
      job.attemptCount,
      outcome.status === "failed" ? outcome.failureCode : null,
      stamp
    );
    return { result: "settled", record: toRecord(settled) };
  }

  async reclaimExpiredWork(
    now: Date): Promise<readonly MaintenanceReclaimOutcome[]> {
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
      this.persist(job, "pending", stamp, job.lastFailureCode);
      this.finishAttempt(job.jobKey, job.attemptCount, "lease_lost", stamp, true);
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
    const plan = planSettle(job.autoAttemptCount, job.maxAttempts, outcome);
    const next: StoredJob = {
      ...job,
      status: plan.status === "failed" && plan.nextDelayMs !== null ? "pending" : plan.status,
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
      throw new GraphragError(
        "maintenance work store used after close",
        "STORAGE_ERROR"
      );
    }
  }

  private appendAttempt(attempt: MaintenanceAttemptRecord): void {
    const history = this.attempts.get(attempt.jobKey) ?? [];
    history.push(attempt);
    this.attempts.set(attempt.jobKey, history);
  }

  private finishAttempt(
    jobKey: string,
    attemptNumber: number,
    failureCode: MaintenanceAttemptRecord["failureCode"],
    finishedAt: string,
    reclaimed = false
  ): void {
    const history = this.attempts.get(jobKey) ?? [];
    const index = history.findIndex(
      (attempt) => attempt.attemptNumber === attemptNumber
    );
    if (index < 0) return;
    history[index] = { ...history[index]!, failureCode, finishedAt, reclaimed };
  }
}

function earlier(left: string, right: string): string {
  return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}

function shift(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function byQueueOrder(left: StoredJob, right: StoredJob): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  return left.jobKey < right.jobKey ? -1 : 1;
}

function toRecord(job: StoredJob): MaintenanceJobRecord {
  const { fencingToken, leaseExpiresAt, attemptStartedAt, ...record } = job;
  return record;
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
