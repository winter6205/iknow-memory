/**
 * Postgres maintenance work store (specs/maintenance-durable-work.md).
 *
 * This is the durable half: recovery of a scheduled job across a process
 * restart is a property of a committed row, so it cannot be demonstrated
 * against the memory twin. Every rule that the twin also implements — the join,
 * the retry ladder, the lease fence, the absolute bound — is applied here with
 * the same pure predicates, and the PG suite re-proves the same behaviours on
 * the real boundary.
 *
 * Why its own module rather than more methods on `PgvectorBackend`: that file is
 * already the package's largest module and serves the ingest/read path, while
 * this capability is an opt-in lifecycle ledger that no read path touches. A
 * separate class also keeps the maintenance tables unreachable from a query.
 *
 * Lock order is the shared authority's, not a ledger-local one. The scope
 * progress bump a job write triggers reaches `structured_publication_scopes`
 * from inside the statement that writes the job, so a writer that took the job
 * row first held the job and the scope in the opposite order to publication,
 * which takes the scope before the job. Every mutation here now reserves the
 * sources and locks owner scope and source rows — in publication's order —
 * before it touches a job row, which makes that trigger's scope write reentrant
 * instead of a deadlock. A source nobody owns keeps the standalone path: the
 * reservation it holds is what proves nobody became the owner mid-write.
 */
import { randomUUID } from "node:crypto";

import { MaintenanceStoreError } from "../maintenance/store-error.js";
import {
  canonicalDependencyRevision,
  computeMaintenanceJobKey,
  planSettle,
  verifyAttemptGuard,
} from "../maintenance/durable-work.js";
import {
  MAINTENANCE_WORK_FAILURE_CODES,
  MAX_AUTO_ATTEMPTS,
  WORK_ABSOLUTE_LIMIT_MS,
  WORK_LEASE_MS,
  type MaintenanceAttemptGuard,
  type MaintenanceAttemptRecord,
  type MaintenanceJobRecord,
  type MaintenanceLiveInputs,
  type MaintenanceReclaimOutcome,
  type MaintenanceScheduleOutcome,
  type MaintenanceSettleOutcome,
  type MaintenanceSettleResult,
  type MaintenanceWorkFailureCode,
  type MaintenanceWorkRequest,
  type MaintenanceWorkStatus,
  type MaintenanceWorkStore,
} from "../maintenance/types.js";
import { PgScopeTransactionRunner } from "./structured-scope-uow.js";
import {
  lockAffectedSources,
  lockOwnerScope,
  reserveSources,
  resolveOwnership,
  stableSourceRefs,
} from "./structured-scope-locks-pg.js";
import { structuredScopeError } from "./structured-scope-types.js";
import type {
  ScopeTransactionClient,
  ScopeTransactionOwner,
  SourceOwnership,
} from "./structured-scope-types.js";

/** A leased connection. Satisfied by `pg.PoolClient` and by the test fakes. */
export interface MaintenanceWorkLease {
  query(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

/** Anything that can lease a connection: `pg.Pool` satisfies this. */
export interface MaintenanceWorkPool {
  connect(): Promise<MaintenanceWorkLease>;
}

/**
 * A seam client and a work lease are the same pooled connection seen through two
 * query typings. Two connections would let one ledger write wait on a lock
 * another of its own transactions holds, which is how the old scope-after-job
 * progress path stalled behind a publication it was blocking itself.
 */
function asWorkLease(client: ScopeTransactionClient): MaintenanceWorkLease {
  return client as MaintenanceWorkLease;
}

/**
 * The store's own typed failure, so the ledger keeps one error vocabulary at its
 * boundary. A fault this store raised is re-raised unchanged — a caller branches
 * on `failureCode`, and re-wrapping it would rename the verdict. Anything else
 * carries a code the ledger may not state, and `backend_unavailable` is the only
 * honest reading of a storage fault with no name.
 */
function workStoreError(error: unknown): MaintenanceStoreError {
  if (error instanceof MaintenanceStoreError) return error;
  const scoped = structuredScopeError(error);
  return new MaintenanceStoreError(
    scoped.message,
    workFailureCodeOf(scoped.code)
  );
}

const WORK_FAILURE_CODES: ReadonlySet<string> = new Set(
  MAINTENANCE_WORK_FAILURE_CODES
);

function workFailureCodeOf(
  code: string
): MaintenanceWorkFailureCode {
  return WORK_FAILURE_CODES.has(code)
    ? (code as MaintenanceWorkFailureCode)
    : "backend_unavailable";
}

/**
 * How many candidates one global claim inspects. Bounded because a contended
 * candidate set must not turn a claim into a scan: giving up is honest, since a
 * worker polls again and the reservation each candidate needs is released as
 * soon as the losing transaction ends.
 */
const CLAIM_CANDIDATE_LIMIT = 5;

const JOB_COLUMNS =
  "job_key, work_kind, source_ref, source_version, source_generation, " +
  "input_revision, config_revision, status, attempt_count, auto_attempt_count, " +
  "max_attempts, next_attempt_at, last_failure_code, created_at, updated_at";

/**
 * The absolute bound and the lease, both rendered from the compile-time
 * constants. No request value ever reaches these strings — only module-level
 * numbers do, so interpolating them is not an injection surface.
 */
const ABSOLUTE_BOUND_SQL = `attempt_started_at + interval '${WORK_ABSOLUTE_LIMIT_MS / 1000} seconds'`;
const LEASE_SQL = `interval '${WORK_LEASE_MS / 1000} seconds'`;

/** One row of the claimable set, read before any job lock exists. */
interface ClaimCandidate {
  readonly jobKey: string;
  readonly sourceRef: string;
}

/** What one nonblocking claim sweep ended with, and what it left to wait for. */
interface ClaimPass {
  readonly guard: MaintenanceAttemptGuard | null;
  readonly head: ClaimCandidate | null;
}

export class PgMaintenanceWorkStore implements MaintenanceWorkStore {
  private readonly pool: MaintenanceWorkPool;
  /**
   * The transaction owner shared with publication. Composition injects the
   * backend's own instance, so a work write and a publication write take the
   * same lock order under one seam. A store constructed without it keeps the
   * plan's declared standalone behavior on a runner that can only open and close
   * a transaction — it cannot mint a context, so it cannot become a second
   * write authority.
   */
  private readonly scope: ScopeTransactionOwner;
  private closed = false;

  constructor(pool: MaintenanceWorkPool, scope?: ScopeTransactionOwner) {
    this.pool = pool;
    this.scope = scope ?? new PgScopeTransactionRunner(() => this.lease());
  }

  /**
   * Insert the job, or join the one already holding this key.
   *
   * `ON CONFLICT ... DO UPDATE` whose `SET` is a no-op is what makes the join
   * correct under concurrency. The obvious `DO NOTHING` cannot be: a
   * data-modifying CTE's SELECT branch reads the statement's own snapshot, so a
   * row another transaction commits concurrently would be invisible to it and
   * the call would see nothing at all. Taking the conflicting row instead forces
   * the same speculative lock and returns that row.
   *
   * `xmax = 0` distinguishes the two outcomes — a row this statement inserted
   * has no locking transaction, one it merely updated does.
   */
  async scheduleWork(
    request: MaintenanceWorkRequest,
    now: Date
  ): Promise<MaintenanceScheduleOutcome> {
    return this.transact(async (lease) => {
      // Only the initiating source: the progress bump a schedule triggers is
      // gated on the scope owning this job's own (source_ref, generation), so
      // locking the dependency vector would serialize a schedule behind sources
      // the write cannot reach.
      await this.secureSourceAuthority(lease, [request.sourceRef]);
      const { rows } = await lease.query(
        `INSERT INTO maintenance_jobs
           (job_key, work_kind, source_ref, source_version, source_generation,
            input_revision, input_dependencies, config_revision, status, attempt_count,
            auto_attempt_count, max_attempts, next_attempt_at, last_failure_code,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'pending',0,0,$9,$10,NULL,$10,$10)
         ON CONFLICT (job_key) DO UPDATE SET updated_at = maintenance_jobs.updated_at
         RETURNING ${JOB_COLUMNS}, (xmax = 0) AS inserted`,
        [
          computeMaintenanceJobKey(request),
          request.workKind,
          request.sourceRef,
          request.sourceVersion,
          request.sourceGeneration,
          canonicalDependencyRevision(request.dependencies),
          JSON.stringify(request.dependencies),
          request.configRevision,
          MAX_AUTO_ATTEMPTS,
          now.toISOString(),
        ]
      );
      const row = rows[0];
      if (!row) {
        throw new MaintenanceStoreError(
          "maintenance job schedule returned no row",
          "backend_unavailable"
        );
      }
      return { record: toRecord(row), inserted: row.inserted === true };
    });
  }

  async getJob(jobKey: string): Promise<MaintenanceJobRecord | null> {
    const lease = await this.lease();
    try {
      const { rows } = await lease.query(
        `SELECT ${JOB_COLUMNS} FROM maintenance_jobs WHERE job_key = $1`,
        [jobKey]
      );
      return rows[0] ? toRecord(rows[0]) : null;
    } finally {
      lease.release();
    }
  }

  /**
   * Claim and record the attempt. `FOR UPDATE SKIP LOCKED` is what makes
   * concurrent workers safe: the second steps over the row the first holds
   * instead of blocking or claiming the same job.
   *
   * Only `pending` rows are claimable. A running job whose lease expired belongs
   * to `reclaimExpiredWork`, and keeping the two apart is what guarantees the
   * reclaimer invalidates the old token before anybody claims a new attempt.
   *
   * The sweep takes candidates in queue order and reserves each without waiting,
   * so a claim never queues behind a write it cannot predict. The head is the one
   * exception and gets a second pass: a head whose reservation is refused is a
   * source mid first-assignment, which is work rather than an empty queue, and a
   * worker that reported none would let the oldest job starve behind repeated
   * assignments. That pass runs in its own transaction, so it waits holding
   * nothing but the reservation it is waiting for.
   */
  async claimWork(now: Date): Promise<MaintenanceAttemptGuard | null> {
    const { guard, head } = await this.transact((lease) =>
      this.claimPass(lease, now)
    );
    if (guard !== null) return guard;
    if (head === null) return null;
    return this.transact((lease) => this.claimWaiting(lease, head, now));
  }

  /**
   * One nonblocking sweep of the claimable set: the guard taken, or the head
   * candidate that was refused a reservation, or neither when the queue is empty
   * or every candidate was already taken by another worker.
   */
  private async claimPass(
    lease: MaintenanceWorkLease,
    now: Date
  ): Promise<ClaimPass> {
    const passed: string[] = [];
    let head: ClaimCandidate | null = null;
    for (let index = 0; index < CLAIM_CANDIDATE_LIMIT; index += 1) {
      const candidate = await nextClaimCandidate(lease, now, passed);
      if (!candidate) break;
      if (await this.secureSourceAuthority(lease, [candidate.sourceRef], true)) {
        const guard = await this.takeJob(lease, candidate, now);
        if (guard) return { guard, head: null };
      } else if (index === 0) {
        head = candidate;
      }
      passed.push(candidate.jobKey);
    }
    return { guard: null, head };
  }

  /**
   * Take the head candidate after waiting for its reservation. Waiting is correct
   * only because the caller knows which job it wants and the order still begins
   * with the reservation, so the wait ends when the assignment that held it does.
   */
  private async claimWaiting(
    lease: MaintenanceWorkLease,
    candidate: ClaimCandidate,
    now: Date
  ): Promise<MaintenanceAttemptGuard | null> {
    if (!(await this.secureSourceAuthority(lease, [candidate.sourceRef]))) {
      return null;
    }
    return this.takeJob(lease, candidate, now);
  }

  /**
   * Extend the lease while the attempt still owns the job. The new expiry is
   * clamped to the absolute bound, so a heartbeat loop can never buy an attempt
   * more than thirty minutes.
   */
  async heartbeatWork(
    guard: MaintenanceAttemptGuard,
    now: Date
  ): Promise<boolean> {
    return this.transact(async (lease) => {
      await this.secureSourceAuthority(lease, [guard.sourceRef]);
      const { rows } = await lease.query(
        `UPDATE maintenance_jobs
            SET lease_expires_at = LEAST($2::timestamptz + ${LEASE_SQL}, ${ABSOLUTE_BOUND_SQL}),
                updated_at = $2
          WHERE job_key = $1
            AND status = 'running'
            AND fencing_token = $3
            AND lease_expires_at > $2
            AND ${ABSOLUTE_BOUND_SQL} > $2
        RETURNING job_key`,
        [guard.jobKey, now.toISOString(), guard.fencingToken]
      );
      return rows.length > 0;
    });
  }

  async retryWork(
    jobKey: string,
    now: Date
  ): Promise<MaintenanceJobRecord | null> {
    return this.transact(async (lease) => {
      const sourceRef = await jobSourceRef(lease, jobKey);
      if (sourceRef === null) return null;
      await this.secureSourceAuthority(lease, [sourceRef]);
      const { rows } = await lease.query(
        `UPDATE maintenance_jobs
            SET status = 'pending',
                auto_attempt_count = 0,
                next_attempt_at = $2,
                last_failure_code = NULL,
                updated_at = $2
          WHERE job_key = $1 AND status IN ('failed','stale')
        RETURNING ${JOB_COLUMNS}`,
        [jobKey, now.toISOString()]
      );
      return rows[0] ? toRecord(rows[0]) : null;
    });
  }

  /**
   * Publish the terminal outcome under the full fence. The row is re-read
   * `FOR UPDATE` first, so the ownership and input verdicts are decided against
   * the committed row inside the same transaction that then writes, rather than
   * against a value read before the write began.
   */
  async settleWork(
    guard: MaintenanceAttemptGuard,
    outcome: MaintenanceSettleOutcome,
    live: MaintenanceLiveInputs,
    now: Date
  ): Promise<MaintenanceSettleResult> {
    return this.transact(async (lease) => {
      const stamp = now.toISOString();
      await this.secureSourceAuthority(lease, [guard.sourceRef]);
      const row = await this.lockRunningJob(lease, guard.jobKey);
      if (!row) return { result: "lease_lost" };

      const verdict = verifyAttemptGuard(
        toGuard(row),
        live,
        now,
        guard.fencingToken
      );
      if (!verdict.ok)
        return this.refuseSettle(lease, row, verdict.code, stamp);

      // MAX_AUTO_ATTEMPTS, not the row's `max_attempts`: the column is readable
      // and writable, and the retry budget must not be something an UPDATE can
      // widen past the spec's three attempts.
      const plan = planSettle(
        Number(row.auto_attempt_count),
        MAX_AUTO_ATTEMPTS,
        outcome
      );
      const record = await this.writeSettled(lease, row, plan, stamp);
      await this.finishAttempt(lease, {
        jobKey: String(row.job_key),
        attemptNumber: Number(row.attempt_count),
        failureCode: plan.lastFailureCode,
        finishedAt: stamp,
      });
      return { result: "settled", record };
    });
  }

  /**
   * Invalidate the token of every attempt whose lease ran out. Clearing
   * `fencing_token` is the invalidation: a stale worker's next write presents a
   * token the row no longer carries, so it is refused before any data write.
   *
   * The expired set is read without a job lock and only those keys are reclaimed,
   * so the reservations for their sources are the first thing this transaction
   * takes. Reclaim waits on those reservations rather than passing candidates
   * over: an expired lease must be invalidated before anybody may claim again, and
   * a reclaim that skipped a job would let two workers each believe they own it.
   */
  async reclaimExpiredWork(
    now: Date
  ): Promise<readonly MaintenanceReclaimOutcome[]> {
    return this.transact(async (lease) => {
      const stamp = now.toISOString();
      const expired = await expiredRunningJobs(lease, stamp);
      if (expired.length === 0) return [];
      await this.secureSourceAuthority(
        lease,
        expired.map((job) => job.sourceRef)
      );
      const { rows } = await lease.query(
        `UPDATE maintenance_jobs
            SET status = 'pending',
                next_attempt_at = $1,
                fencing_token = NULL,
                lease_expires_at = NULL,
                attempt_started_at = NULL,
                updated_at = $1
          WHERE status = 'running'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= $1
            AND job_key = ANY($2::text[])
        RETURNING job_key, attempt_count`,
        [stamp, expired.map((job) => job.jobKey)]
      );
      for (const row of rows) {
        await this.finishAttempt(lease, {
          jobKey: String(row.job_key),
          attemptNumber: Number(row.attempt_count),
          failureCode: "lease_lost",
          finishedAt: stamp,
          reclaimed: true,
          tolerateMissing: true,
        });
      }
      return rows.map((row) => ({
        jobKey: String(row.job_key),
        reclaimed: true,
      }));
    });
  }

  async listAttempts(
    jobKey: string
  ): Promise<readonly MaintenanceAttemptRecord[]> {
    const lease = await this.lease();
    try {
      const { rows } = await lease.query(
        `SELECT job_key, attempt_number, fencing_token, failure_code,
                started_at, finished_at, reclaimed
           FROM maintenance_job_attempts
          WHERE job_key = $1
          ORDER BY attempt_number ASC`,
        [jobKey]
      );
      return rows.map(toAttempt);
    } finally {
      lease.release();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /**
   * Take the ledger's place in the shared lock order: the source reservations in
   * stable reference order, then each owner scope, then that scope's source rows.
   *
   * Ownership is resolved only after the reservations are held, which is what
   * makes the map authoritative — a first assignment reserves the same advisory
   * lock, so it cannot slip in between reading the owner and locking the scope. A
   * source no scope owns takes no further lock and keeps the standalone path.
   *
   * `nonblocking` belongs to the global claim alone. It is false elsewhere, where
   * the caller already knows which job it must write and waiting is correct; a
   * blocking reservation cannot report false, so only the claim branches on it.
   */
  private async secureSourceAuthority(
    lease: MaintenanceWorkLease,
    sourceRefs: readonly string[],
    nonblocking = false
  ): Promise<boolean> {
    const refs = stableSourceRefs([...new Set(sourceRefs)]);
    if (refs.length === 0) return true;
    if (!(await reserveSources(lease, refs, nonblocking))) return false;
    for (const [scopeBinding, owned] of ownersByScope(
      await resolveOwnership(lease, refs)
    )) {
      await lockOwnerScope(lease, scopeBinding);
      await lockAffectedSources(lease, scopeBinding, owned);
    }
    return true;
  }

  /**
   * Take one candidate whose authority the caller already holds, re-validating it
   * with `SKIP LOCKED`. Returns null — never a wait — when another worker took the
   * row in between, so the caller moves on to the next candidate.
   */
  private async takeJob(
    lease: MaintenanceWorkLease,
    candidate: ClaimCandidate,
    now: Date
  ): Promise<MaintenanceAttemptGuard | null> {
    const stamp = now.toISOString();
    const { rows } = await lease.query(
      `UPDATE maintenance_jobs SET
           status = 'running',
           attempt_count = attempt_count + 1,
           auto_attempt_count = auto_attempt_count + 1,
           fencing_token = $1,
           lease_expires_at = $2,
           attempt_started_at = $3,
           last_failure_code = NULL,
           next_attempt_at = NULL,
           updated_at = $3
         WHERE job_key = (
           SELECT job_key FROM maintenance_jobs
            WHERE job_key = $4
              AND status = 'pending'
              AND (next_attempt_at IS NULL OR next_attempt_at <= $3)
            FOR UPDATE SKIP LOCKED
            LIMIT 1)
         RETURNING ${JOB_COLUMNS}, fencing_token, lease_expires_at, attempt_started_at`,
      [randomUUID(), new Date(now.getTime() + WORK_LEASE_MS).toISOString(), stamp, candidate.jobKey]
    );
    const row = rows[0];
    if (!row) return null;
    await lease.query(
      `INSERT INTO maintenance_job_attempts
           (job_key, attempt_number, fencing_token, started_at)
         VALUES ($1,$2,$3,$4)`,
      [
        String(row.job_key),
        Number(row.attempt_count),
        String(row.fencing_token),
        stamp,
      ]
    );
    return toGuard(row);
  }

  /**
   * Run `fn` inside one transaction of the shared authority. The seam owns BEGIN,
   * COMMIT and the single ROLLBACK, which keeps the primary failure and records
   * only safe metadata for a rollback that itself failed.
   */
  private transact<T>(
    fn: (lease: MaintenanceWorkLease) => Promise<T>
  ): Promise<T> {
    // Checked before leasing so a closed store refuses identically whether it owns
    // its authority or was handed the backend's.
    if (this.closed) {
      throw new MaintenanceStoreError(
        "maintenance work store used after close",
        "backend_unavailable"
      );
    }
    return this.scope.runTransaction((client) => fn(asWorkLease(client)), {
      fail: workStoreError,
    });
  }

  /**
   * The job row, fenced, taken LAST.
   *
   * This is where the old order inverted: the row used to be locked here before
   * any scope or source lock existed, while publication locks the scope and then
   * the job, and the two deadlocked. The caller holds the reservation, the owner
   * scope and the source rows before reaching this statement, so the progress
   * bump this write triggers finds the scope row already ours.
   */
  private async lockRunningJob(
    lease: MaintenanceWorkLease,
    jobKey: string
  ): Promise<Record<string, unknown> | null> {
    const { rows } = await lease.query(
      `SELECT ${JOB_COLUMNS}, fencing_token, lease_expires_at, attempt_started_at
         FROM maintenance_jobs
        WHERE job_key = $1
        FOR UPDATE`,
      [jobKey]
    );
    const row = rows[0];
    if (!row || row.status !== "running") return null;
    return row;
  }

  /** Persist the refusal itself: a superseded attempt is `stale`, not a failure. */
  private async refuseSettle(
    lease: MaintenanceWorkLease,
    row: Record<string, unknown>,
    code: MaintenanceWorkFailureCode,
    stamp: string
  ): Promise<MaintenanceSettleResult> {
    if (code === "input_stale") {
      const record = await this.writeSettled(
        lease,
        row,
        { status: "stale", nextDelayMs: null, lastFailureCode: "input_stale" },
        stamp
      );
      await this.finishAttempt(lease, {
        jobKey: String(row.job_key),
        attemptNumber: Number(row.attempt_count),
        failureCode: "input_stale",
        finishedAt: stamp,
      });
      return { result: "stale", record };
    }
    if (code === "execution_timeout") {
      // The spec's `failed` state is exactly this: the current attempt stopped
      // with a typed cause, and an explicit retry is the remedy. Settling the job
      // rather than leaving it `running` is what keeps the outcome in the attempt
      // history — a job left running with an expired lease would be reclaimed,
      // and the reclaim would overwrite this attempt's real cause with
      // `lease_lost`.
      const record = await this.writeSettled(
        lease,
        row,
        {
          status: "failed",
          nextDelayMs: null,
          lastFailureCode: "execution_timeout",
        },
        stamp
      );
      await this.finishAttempt(lease, {
        jobKey: String(row.job_key),
        attemptNumber: Number(row.attempt_count),
        failureCode: "execution_timeout",
        finishedAt: stamp,
      });
      return { result: "timed_out", record };
    }
    return { result: "lease_lost" };
  }

  private async writeSettled(
    lease: MaintenanceWorkLease,
    row: Record<string, unknown>,
    plan: {
      readonly status: MaintenanceWorkStatus;
      readonly nextDelayMs: number | null;
      readonly lastFailureCode: MaintenanceWorkFailureCode | null;
    },
    stamp: string
  ): Promise<MaintenanceJobRecord> {
    const nextAttemptAt =
      plan.nextDelayMs === null
        ? null
        : new Date(new Date(stamp).getTime() + plan.nextDelayMs).toISOString();
    const { rows } = await lease.query(
      `UPDATE maintenance_jobs
          SET status = $2,
              next_attempt_at = $3,
              last_failure_code = $4,
              fencing_token = NULL,
              lease_expires_at = NULL,
              attempt_started_at = NULL,
              updated_at = $5
        WHERE job_key = $1
      RETURNING ${JOB_COLUMNS}`,
      [
        String(row.job_key),
        plan.status,
        nextAttemptAt,
        plan.lastFailureCode,
        stamp,
      ]
    );
    const updated = rows[0];
    if (!updated) {
      throw new MaintenanceStoreError(
        "maintenance job settle updated no row",
        "backend_unavailable"
      );
    }
    return toRecord(updated);
  }

  private async finishAttempt(
    lease: MaintenanceWorkLease,
    attempt: {
      readonly jobKey: string;
      readonly attemptNumber: number;
      readonly failureCode: MaintenanceWorkFailureCode | null;
      readonly finishedAt: string;
      readonly reclaimed?: boolean;
      readonly tolerateMissing?: boolean;
    }
  ): Promise<void> {
    const { rows } = await lease.query(
      `UPDATE maintenance_job_attempts
          SET failure_code = $3, finished_at = $4, reclaimed = $5
        WHERE job_key = $1 AND attempt_number = $2 AND finished_at IS NULL
      RETURNING job_key`,
      [
        attempt.jobKey,
        attempt.attemptNumber,
        attempt.failureCode,
        attempt.finishedAt,
        attempt.reclaimed ?? false,
      ]
    );
    if (rows.length === 0 && !attempt.tolerateMissing) {
      // A settle whose attempt row is gone means the history cannot explain the
      // outcome, so it must not be reported as a success. A reclaim is exempt:
      // the attempt may already carry a recorded terminal outcome.
      throw new MaintenanceStoreError(
        `maintenance attempt ${attempt.attemptNumber} missing for job ${attempt.jobKey}`,
        "backend_unavailable"
      );
    }
  }

  private async lease(): Promise<MaintenanceWorkLease> {
    if (this.closed) {
      throw new MaintenanceStoreError(
        "maintenance work store used after close",
        "backend_unavailable"
      );
    }
    try {
      return await this.pool.connect();
    } catch (error) {
      throw new MaintenanceStoreError(
        `maintenance work store connection failed: ${messageOf(error)}`,
        "backend_unavailable"
      );
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owner scopes with the sources they own, ordered by scope binding.
 *
 * The order matters wherever one statement reaches several scopes — reclaim
 * does — because two writers that group the same scopes differently can each hold
 * one and wait for the other's.
 */
function ownersByScope(
  ownership: readonly SourceOwnership[]
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const entry of ownership) {
    const scopeBinding = entry.ownerScopeBinding;
    if (scopeBinding === null) continue;
    const owned = grouped.get(scopeBinding);
    if (owned) owned.push(entry.sourceRef);
    else grouped.set(scopeBinding, [entry.sourceRef]);
  }
  return new Map(
    [...grouped].sort(([left], [right]) => left.localeCompare(right))
  );
}

/**
 * The oldest claimable job, read with no lock of any kind.
 *
 * Candidates this pass already passed over are excluded: a contended candidate
 * stays at the head of the same order, so re-reading it would return the same row
 * and the scan would stop early instead of claiming the next job.
 */
async function nextClaimCandidate(
  lease: MaintenanceWorkLease,
  now: Date,
  passed: readonly string[]
): Promise<ClaimCandidate | null> {
  const { rows } = await lease.query(
    `SELECT job_key, source_ref FROM maintenance_jobs
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
        AND NOT (job_key = ANY($2::text[]))
      ORDER BY next_attempt_at ASC NULLS FIRST, created_at ASC, job_key ASC
      LIMIT 1`,
    [now.toISOString(), [...passed]]
  );
  const row = rows[0];
  if (!row) return null;
  return { jobKey: String(row.job_key), sourceRef: String(row.source_ref) };
}

/** Every running job whose lease ran out, read before any job lock exists. */
async function expiredRunningJobs(
  lease: MaintenanceWorkLease,
  stamp: string
): Promise<ClaimCandidate[]> {
  const { rows } = await lease.query(
    `SELECT job_key, source_ref FROM maintenance_jobs
      WHERE status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= $1
      ORDER BY job_key ASC`,
    [stamp]
  );
  return rows.map((row) => ({
    jobKey: String(row.job_key),
    sourceRef: String(row.source_ref),
  }));
}

/**
 * The source a retry reaches, read without a job lock. An operator retry names
 * only the job key, and the authority to lock is decided by the source that job
 * belongs to, so the lock order still begins with the reservation.
 */
async function jobSourceRef(
  lease: MaintenanceWorkLease,
  jobKey: string
): Promise<string | null> {
  const { rows } = await lease.query(
    "SELECT source_ref FROM maintenance_jobs WHERE job_key = $1",
    [jobKey]
  );
  const row = rows[0];
  return row ? String(row.source_ref) : null;
}

function toRecord(row: Record<string, unknown>): MaintenanceJobRecord {
  return {
    jobKey: String(row.job_key),
    workKind: row.work_kind as MaintenanceWorkRequest["workKind"],
    sourceRef: String(row.source_ref),
    sourceVersion: String(row.source_version),
    sourceGeneration: Number(row.source_generation),
    inputRevision: String(row.input_revision),
    configRevision: String(row.config_revision),
    status: row.status as MaintenanceWorkStatus,
    attemptCount: Number(row.attempt_count),
    autoAttemptCount: Number(row.auto_attempt_count),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: isoOrNull(row.next_attempt_at),
    lastFailureCode:
      (row.last_failure_code as MaintenanceWorkFailureCode | null) ?? null,
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at),
  };
}

function toGuard(row: Record<string, unknown>): MaintenanceAttemptGuard {
  return {
    jobKey: String(row.job_key),
    attemptNumber: Number(row.attempt_count),
    fencingToken: String(row.fencing_token ?? ""),
    workKind: row.work_kind as MaintenanceWorkRequest["workKind"],
    sourceRef: String(row.source_ref),
    sourceVersion: String(row.source_version),
    sourceGeneration: Number(row.source_generation),
    inputRevision: String(row.input_revision),
    configRevision: String(row.config_revision),
    leaseExpiresAt: isoOf(row.lease_expires_at),
    attemptStartedAt: isoOf(row.attempt_started_at),
  };
}

function toAttempt(row: Record<string, unknown>): MaintenanceAttemptRecord {
  return {
    jobKey: String(row.job_key),
    attemptNumber: Number(row.attempt_number),
    fencingToken: String(row.fencing_token),
    failureCode:
      (row.failure_code as MaintenanceWorkFailureCode | null) ?? null,
    startedAt: isoOf(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
    reclaimed: row.reclaimed === true,
  };
}

/** Never throw a bare `RangeError` out of a storage read. */
function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new MaintenanceStoreError(
      `maintenance timestamp column unreadable: ${String(value)}`,
      "backend_unavailable"
    );
  }
  return parsed.toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : isoOf(value);
}
