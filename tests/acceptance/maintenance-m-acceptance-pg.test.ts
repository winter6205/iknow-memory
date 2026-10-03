/**
 * M acceptance lane for maintenance durable work (MP1 driver).
 *
 * This is the versioned driver `docs/validation/maintenance-m1-m20-acceptance.md`
 * names. Two properties make it an acceptance lane rather than another suite:
 *
 * 1. It runs against real Postgres, never a fake store, and through the package's
 *    real bootstrap. Restart recovery is a property of a committed row, so no
 *    in-memory twin can answer it.
 * 2. It does not skip. Every existing real-boundary suite in this repo turns a
 *    missing Postgres into a local skip that still exits 0, which is exactly how
 *    a green run reports an acceptance case that never ran. Here the lane is
 *    inert under `npm test` and strict under `MAINTENANCE_ACCEPTANCE=1`:
 *
 *      MAINTENANCE_ACCEPTANCE=1 npx vitest run tests/acceptance
 *
 *    With that flag set, an unreachable database fails collection instead of
 *    skipping, so the recorded exit status means what the record says it means.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { computeMaintenanceJobKey } from "../../src/core/maintenance/durable-work.js";
import {
  claimNextWork,
  liveInputsOf,
  retryWork,
  scheduleWork,
  settleWork,
} from "../../src/core/maintenance/service.js";
import type {
  MaintenanceDependency,
  MaintenanceWorkDeps,
  MaintenanceWorkRequest,
} from "../../src/core/maintenance/types.js";
import {
  PgMaintenanceWorkStore,
  type MaintenanceWorkPool,
} from "../../src/core/storage/maintenance-work-pg.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import {
  createPgIntegrationHarness,
  probePostgres,
  resolvePgConnectionString,
} from "../integration/pg-test-harness.js";

const EXPECTED_COMMAND =
  "MAINTENANCE_ACCEPTANCE=1 npx vitest run tests/acceptance/maintenance-m-acceptance-pg.test.ts";
const ACCEPTANCE_ENV = "MAINTENANCE_ACCEPTANCE";
const DIM = 8;

const REQUIRED = process.env[ACCEPTANCE_ENV] === "1";
const CONNECTION_STRING = resolvePgConnectionString(
  "postgresql://postgres@localhost/postgres"
);

const T0 = new Date("2026-10-03T10:00:00.000Z");
const operator = { actorId: "acceptance-operator" };

const dependency = (
  overrides: Partial<MaintenanceDependency> = {}
): MaintenanceDependency => ({
  sourceRef: "s1",
  generation: 1,
  extractionRevision: 2,
  relationBuckets: ["employment"],
  ...overrides,
});

const request = (
  overrides: Partial<MaintenanceWorkRequest> = {}
): MaintenanceWorkRequest => ({
  workKind: "extract_publish",
  sourceRef: "s1",
  sourceVersion: "v1",
  sourceGeneration: 1,
  configRevision: "rules-3",
  dependencies: [dependency()],
  ...overrides,
});

const pgHarness = await createPgIntegrationHarness({
  label: "maintenance-acceptance-pg",
  testPath: "tests/acceptance/maintenance-m-acceptance-pg.test.ts",
  expectedCommand: EXPECTED_COMMAND,
  schemaPrefix: "maintenance_acceptance",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: true,
});
const { schemaConnectionString: SCHEMA_URL, createClient } = pgHarness;

if (REQUIRED) {
  const probe = await probePostgres(CONNECTION_STRING, true);
  if (!probe.available) {
    throw new Error(
      [
        "Validation:",
        "- Not run: maintenance acceptance requires a real Postgres 16 + pgvector.",
        `- Expected command: ${EXPECTED_COMMAND}`,
        `- Blocking issue: ${probe.error instanceof Error ? probe.error.message : String(probe.error)}`,
        "- Start it with: docker compose up -d --wait postgres",
      ].join("\n")
    );
  }
}

const describeAcceptance = REQUIRED
  ? pgHarness.describePg
  : pgHarness.describePg.skip;

type ClosablePool = MaintenanceWorkPool & { end(): Promise<void> };

function poolOf(connectionString: string): ClosablePool {
  return new pg.Pool({
    connectionString,
    max: 4,
  }) as unknown as ClosablePool;
}

describeAcceptance("M acceptance — maintenance durable work", () => {
  let backend: PgvectorBackend;
  let admin: pg.Client;

  beforeAll(async () => {
    // The real boot path: PgvectorBackend creates `chunks` and then runs the
    // package bootstrap, which is where the maintenance tables are created.
    // Bootstrapping by hand would prove a schema the product never builds.
    //
    // `resetSchema` must come first. The harness only names a schema and points
    // `search_path` at it; without the CREATE, Postgres silently falls through
    // to `public` and every assertion below would run against the shared
    // database instead of this run's throwaway one.
    admin = createClient(SCHEMA_URL);
    await admin.connect();
    await pgHarness.resetSchema(admin);
    backend = new PgvectorBackend(SCHEMA_URL, DIM, { annMaxDimensions: 2000 });
    await backend.initialize();
  }, 120_000);

  beforeEach(async () => {
    // One queue per case. Claim always takes the oldest pending job in the
    // ledger, so without this a case would drain the previous case's job and
    // assert on someone else's state.
    await admin.query("TRUNCATE maintenance_job_attempts, maintenance_jobs");
  });

  afterAll(async () => {
    try {
      await pgHarness.dropSchema(admin);
    } finally {
      await admin?.end();
      await backend?.close();
    }
  });

  it("recovers exactly one logical job after the scheduling process dies", async () => {
    const scheduling = new PgMaintenanceWorkStore(poolOf(SCHEMA_URL));
    const scheduled = await scheduleWork(
      { store: scheduling, clock: () => T0 },
      operator,
      request()
    );
    if ("refused" in scheduled) throw new Error(scheduled.detail);
    const jobKey = scheduled.record.jobKey;
    expect(jobKey).toBe(computeMaintenanceJobKey(request()));

    // The scheduling process dies here: the job is committed and unclaimed, and
    // nothing else has touched it.
    await scheduling.close();

    const survivorPool = poolOf(SCHEMA_URL);
    const survivor: MaintenanceWorkDeps = {
      store: new PgMaintenanceWorkStore(survivorPool),
      clock: () => new Date(T0.getTime() + 60_000),
    };

    const { guard } = await claimNextWork(survivor);
    expect(guard?.jobKey).toBe(jobKey);
    expect(guard?.attemptNumber).toBe(1);

    const requeued = await scheduleWork(survivor, operator, request());
    expect(requeued.record.jobKey).toBe(jobKey);
    expect(requeued.inserted).toBe(false);
    expect(await survivor.store.listAttempts(jobKey)).toHaveLength(1);

    const counts = await admin.query<{ jobs: string; attempts: string }>(
      `SELECT (SELECT count(*) FROM maintenance_jobs) AS jobs,
              (SELECT count(*) FROM maintenance_job_attempts) AS attempts`
    );
    expect(counts.rows[0]).toMatchObject({ jobs: "1", attempts: "1" });
    await survivorPool.end();
  });

  it("treats a moved dependency vector as a different logical job", async () => {
    const pool = poolOf(SCHEMA_URL);
    const deps: MaintenanceWorkDeps = {
      store: new PgMaintenanceWorkStore(pool),
      clock: () => T0,
    };
    try {
      const base = await scheduleWork(
        deps,
        operator,
        request({ sourceRef: "s2", sourceVersion: "v7", sourceGeneration: 3 })
      );
      if ("refused" in base) throw new Error(base.detail);

      const moved = await scheduleWork(
        deps,
        operator,
        request({
          sourceRef: "s2",
          sourceVersion: "v7",
          sourceGeneration: 3,
          dependencies: [
            dependency({
              sourceRef: "s2",
              generation: 3,
              relationBuckets: ["employment", "office"],
            }),
          ],
        })
      );

      expect(moved.record.jobKey).not.toBe(base.record.jobKey);
      expect(moved.inserted).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it("writes nothing to the lifecycle ledger when the real query read path runs", async () => {
    const before = await ledgerSnapshot(admin);

    const hits = await backend.search([1, 0, 0, 0, 0, 0, 0, 0], { limit: 5 });
    expect(hits).toEqual([]);

    expect(await ledgerSnapshot(admin)).toEqual(before);
  });

  it("M2 — concurrent duplicate schedules of one key still join a single job", async () => {
    // The obvious `ON CONFLICT DO NOTHING` cannot answer this: a data-modifying
    // CTE's SELECT branch reads the statement snapshot and cannot see the row a
    // concurrent transaction commits, so the join would find nothing.
    const work = request({ sourceRef: "s-race", sourceVersion: "v3" });
    const pools = [poolOf(SCHEMA_URL), poolOf(SCHEMA_URL)];
    try {
      const results = await Promise.all(
        pools.map((pool, index) =>
          scheduleWork(
            { store: new PgMaintenanceWorkStore(pool), clock: () => T0 },
            operator,
            work
          )
        )
      );
      const keys = new Set(results.map((r) => (("record" in r ? r.record.jobKey : null))));
      expect(keys.size).toBe(1);
      expect(results.filter((r) => "inserted" in r && r.inserted)).toHaveLength(1);

      const counts = await admin.query<{ jobs: string }>(
        `SELECT count(*) AS jobs FROM maintenance_jobs`
      );
      expect(counts.rows[0]).toMatchObject({ jobs: "1" });
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  });

  it("M6 — an expired lease invalidates the old token before a new attempt runs", async () => {
    const pool = poolOf(SCHEMA_URL);
    try {
      const job = await scheduleAt(pool, T0, request({ sourceRef: "s6" }));
      const depsAt = (at: Date): MaintenanceWorkDeps => ({
        store: new PgMaintenanceWorkStore(pool),
        clock: () => at,
      });

      const first = await claimNextWork(depsAt(new Date(T0.getTime() + 1_000)));
      expect(first.guard?.attemptNumber).toBe(1);
      const staleToken = first.guard?.fencingToken ?? "";

      // The worker dies; only the lease expiry can release the job.
      const reclaimedAt = new Date(T0.getTime() + 6 * 60_000);
      const afterReclaim = await claimNextWork(depsAt(reclaimedAt));
      expect(afterReclaim.reclaimed).toEqual([
        { jobKey: job.jobKey, reclaimed: true },
      ]);
      expect(afterReclaim.guard?.attemptNumber).toBe(2);
      expect(afterReclaim.guard?.fencingToken).not.toBe(staleToken);

      const staleStore = new PgMaintenanceWorkStore(pool);
      expect(
        await staleStore.heartbeatWork(
          first.guard!,
          new Date(T0.getTime() + 6 * 60_000 + 1_000)
        )
      ).toBe(false);
      expect(
        await settleWork(
          depsAt(new Date(T0.getTime() + 6 * 60_000 + 1_000)),
          first.guard!,
          { status: "ready" },
          liveInputsOf("rules-3", [dependency()])
        )
      ).toEqual({ result: "lease_lost" });
      expect((await staleStore.getJob(job.jobKey))?.status).toBe("running");
    } finally {
      await pool.end();
    }
  });

  it("MP4 — a heartbeat cannot extend an attempt past the absolute bound on real Postgres", async () => {
    // Only the false branch of the clamp was exercised before; nothing reached the
    // LEAST(), so "cannot be extended" was proven solely by the memory twin.
    const pool = poolOf(SCHEMA_URL);
    try {
      const job = await scheduleAt(
        pool,
        T0,
        request({
          sourceRef: "s8",
          dependencies: [dependency({ sourceRef: "s8" })],
        })
      );
      const store = new PgMaintenanceWorkStore(pool);
      const guard = await store.claimWork(new Date(T0.getTime() + 1_000));
      if (!guard) throw new Error("expected a claimable job");

      for (let minute = 1; minute <= 29; minute += 1) {
        const at = new Date(`2026-10-03T10:${String(minute).padStart(2, "0")}:30.000Z`);
        expect(await store.heartbeatWork(guard, at), `minute ${minute}`).toBe(true);
      }

      const stored = await admin.query<{
        lease_expires_at: string;
        attempt_started_at: string;
      }>(
        `SELECT lease_expires_at, attempt_started_at
           FROM maintenance_jobs WHERE job_key = $1`,
        [job.jobKey]
      );
      const row = stored.rows[0]!;
      const lease = new Date(row.lease_expires_at).getTime();
      // The bound is relative to when the attempt actually started, not to T0.
      const absolute = new Date(row.attempt_started_at).getTime() + 30 * 60_000;
      // Clamped to the 30-minute absolute bound, not extended to now + 5 minutes.
      expect(lease).toBe(absolute);
      expect(lease).toBeLessThan(new Date("2026-10-03T10:34:30.000Z").getTime());

      const afterBound = new Date("2026-10-03T10:30:01.000Z");
      expect(await store.heartbeatWork(guard, afterBound)).toBe(false);

      const timedOut = await settleWork(
        { store, clock: () => afterBound },
        guard,
        { status: "ready" },
        liveInputsOf("rules-3", [dependency({ sourceRef: "s8" })])
      );
      expect(timedOut).toMatchObject({ result: "timed_out" });

      // The attempt's real cause must survive in the history. A job left running
      // with an expired lease would be reclaimed, and the reclaim would stamp
      // `lease_lost` over `execution_timeout`.
      const settled = await admin.query<{
        status: string;
        last_failure_code: string;
      }>(
        `SELECT status, last_failure_code FROM maintenance_jobs WHERE job_key = $1`,
        [job.jobKey]
      );
      expect(settled.rows[0]).toMatchObject({
        status: "failed",
        last_failure_code: "execution_timeout",
      });
      const history = await store.listAttempts(job.jobKey);
      expect(history[0]).toMatchObject({
        failureCode: "execution_timeout",
        reclaimed: false,
      });

      // And a later reclaim must not overwrite it.
      await store.reclaimExpiredWork(new Date("2026-10-03T11:00:00.000Z"));
      expect((await store.listAttempts(job.jobKey))[0]).toMatchObject({
        failureCode: "execution_timeout",
        reclaimed: false,
      });
    } finally {
      await pool.end();
    }
  });

  it("M7 — three transient attempts exhaust into a visible failed with history intact", async () => {
    const pool = poolOf(SCHEMA_URL);
    try {
      const job = await scheduleAt(
        pool,
        T0,
        request({
          sourceRef: "s7",
          dependencies: [dependency({ sourceRef: "s7" })],
        })
      );
      const liveInputs = liveInputsOf("rules-3", [dependency({ sourceRef: "s7" })]);

      const statuses: string[] = [];
      for (const offsetMs of [0, 5_000, 35_000]) {
        const at = new Date(T0.getTime() + offsetMs);
        const { guard } = await claimNextWork({
          store: new PgMaintenanceWorkStore(pool),
          clock: () => at,
        });
        if (!guard) throw new Error(`no claimable job at +${offsetMs}ms`);
        const result = await settleWork(
          { store: new PgMaintenanceWorkStore(pool), clock: () => at },
          guard,
          { status: "failed", failureCode: "backend_unavailable" },
          liveInputs
        );
        if (result.result === "settled") statuses.push(result.record.status);
      }

      expect(statuses).toEqual(["pending", "pending", "failed"]);
      const record = await new PgMaintenanceWorkStore(pool).getJob(job.jobKey);
      expect(record?.status).toBe("failed");
      expect(record?.lastFailureCode).toBe("backend_unavailable");
      expect(record?.nextAttemptAt).toBeNull();

      const store = new PgMaintenanceWorkStore(pool);
      const history = await store.listAttempts(job.jobKey);
      expect(history.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3]);
      expect(history.every((attempt) => attempt.failureCode === "backend_unavailable")).toBe(true);
      expect(new Set(history.map((attempt) => attempt.fencingToken)).size).toBe(3);

      const refused = await retryWork({ store, clock: () => T0 }, "   ");
      expect(refused).toHaveProperty("refused", true);

      const retried = await retryWork({ store, clock: () => T0 }, job.jobKey);
      expect(retried).not.toHaveProperty("refused");
      if (!retried || "refused" in retried) throw new Error("expected a retried job");
      expect(retried.status).toBe("pending");
      expect(retried.autoAttemptCount).toBe(0);

      const after = await store.claimWork(new Date(T0.getTime() + 60_000));
      expect(after?.attemptNumber).toBe(4);
      expect((await store.listAttempts(job.jobKey)).map((a) => a.attemptNumber)).toEqual([
        1, 2, 3, 4,
      ]);
    } finally {
      await pool.end();
    }
  });

  it("surfaces a driver fault as a typed failure code, never a raw pg error", async () => {
    const dead = new PgMaintenanceWorkStore({
      connect: () => Promise.reject(new Error("connection refused")),
    });

    await expect(dead.scheduleWork(request(), T0)).rejects.toMatchObject({
      failureCode: "backend_unavailable",
    });
  });
});

async function scheduleAt(
  pool: ClosablePool,
  at: Date,
  work: MaintenanceWorkRequest
): Promise<{ jobKey: string }> {
  const outcome = await scheduleWork(
    { store: new PgMaintenanceWorkStore(pool), clock: () => at },
    operator,
    work
  );
  if ("refused" in outcome) throw new Error(outcome.detail);
  return { jobKey: outcome.record.jobKey };
}

async function ledgerSnapshot(
  client: pg.Client
): Promise<{ jobs: unknown[]; attempts: unknown[] }> {
  const jobs = await client.query(
    `SELECT job_key, status, attempt_count, auto_attempt_count, next_attempt_at,
            updated_at, fencing_token
       FROM maintenance_jobs
      ORDER BY job_key`
  );
  const attempts = await client.query(
    `SELECT job_key, attempt_number, failure_code, finished_at, reclaimed
       FROM maintenance_job_attempts
      ORDER BY job_key, attempt_number`
  );
  return { jobs: jobs.rows, attempts: attempts.rows };
}
