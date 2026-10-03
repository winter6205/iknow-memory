import { beforeEach, describe, expect, it } from "vitest";

import { GraphragError } from "../../src/core/errors.js";
import {
  claimNextWork,
  liveInputsOf,
  retryWork,
  scheduleWork,
  settleWork,
} from "../../src/core/maintenance/service.js";
import type {
  MaintenanceAttemptGuard,
  MaintenanceDependency,
  MaintenanceWorkDeps,
  MaintenanceWorkRequest,
} from "../../src/core/maintenance/types.js";
import { InMemoryMaintenanceWorkStore } from "../../src/core/storage/maintenance-work-memory.js";

const T0 = new Date("2026-10-03T10:00:00.000Z");

const operator = { actorId: "operator-1" };

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

function harness() {
  let now = T0;
  const store = new InMemoryMaintenanceWorkStore();
  const deps: MaintenanceWorkDeps = { store, clock: () => now };
  return {
    store,
    deps,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    setNow(instant: Date) {
      now = instant;
    },
    now: () => now,
  };
}

async function scheduleDefault(h: ReturnType<typeof harness>) {
  const outcome = await scheduleWork(h.deps, operator, request());
  if ("refused" in outcome) throw new Error(`refused: ${outcome.detail}`);
  return outcome.record;
}

async function claim(h: ReturnType<typeof harness>): Promise<MaintenanceAttemptGuard> {
  const { guard } = await claimNextWork(h.deps);
  if (!guard) throw new Error("expected a claimable job");
  return guard;
}

const live = liveInputsOf("rules-3", [dependency()]);

describe("MP2 — durable job key", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("joins a repeated schedule of the same key into one job", async () => {
    const first = await scheduleDefault(h);
    const second = await scheduleWork(h.deps, operator, request());

    expect(first.jobKey).toBe(second.record.jobKey);
    expect(second.inserted).toBe(false);
    expect(await h.store.listAttempts(first.jobKey)).toHaveLength(0);
  });

  it("refuses to join a job whose dependency vector differs", async () => {
    const first = await scheduleDefault(h);
    const second = await scheduleWork(h.deps, operator, request({
      dependencies: [dependency({ relationBuckets: ["employment", "office"] })],
    }));

    expect(second.record.jobKey).not.toBe(first.jobKey);
    expect(second.inserted).toBe(true);
  });

  it("refuses to join across work kinds, versions, generations, and config revisions", async () => {
    const base = await scheduleDefault(h);

    for (const variant of [
      request({ workKind: "conflict_check" }),
      request({ workKind: "projection_rebuild" }),
      request({ sourceVersion: "v2" }),
      request({ sourceGeneration: 2 }),
      request({ configRevision: "rules-4" }),
    ]) {
      const outcome = await scheduleWork(h.deps, operator, variant);
      if ("refused" in outcome) throw new Error(outcome.detail);
      expect(outcome.record.jobKey).not.toBe(base.jobKey);
    }
  });

  it("keeps a joined job's attempts untouched when it is scheduled again mid-run", async () => {
    const job = await scheduleDefault(h);
    const guard = await claim(h);
    const rescheduled = await scheduleWork(h.deps, operator, request());

    expect(rescheduled.inserted).toBe(false);
    expect(rescheduled.record.status).toBe("running");
    expect(await h.store.listAttempts(job.jobKey)).toHaveLength(1);
    expect(guard.attemptNumber).toBe(1);
  });

  it("refuses an empty or malformed identity with invalid_input and writes nothing", async () => {
    const cases: Array<[string, MaintenanceWorkRequest]> = [
      ["sourceRef", request({ sourceRef: "  " })],
      ["sourceVersion", request({ sourceVersion: "" })],
      ["configRevision", request({ configRevision: "" })],
      ["sourceGeneration", request({ sourceGeneration: -1 })],
      ["dependencies", request({ dependencies: [] })],
      ["work kind", request({ workKind: "nope" as MaintenanceWorkRequest["workKind"] })],
    ];

    for (const [label, invalid] of cases) {
      const outcome = await scheduleWork(h.deps, operator, invalid);
      expect(outcome, label).toHaveProperty("refused", "invalid_input");
      expect("record" in outcome, label).toBe(false);
    }
    const claimable = await claimNextWork(h.deps);
    expect(claimable.guard).toBeNull();
    expect(claimable.reclaimed).toEqual([]);
  });

  it("refuses a denied actor without scheduling", async () => {
    const outcome = await scheduleWork(h.deps, { actorId: "" }, request());

    expect(outcome).toHaveProperty("refused", "access_denied");
    expect((await claimNextWork(h.deps)).guard).toBeNull();
  });

  it("surfaces a storage fault as a typed error rather than an empty success", async () => {
    await h.store.close();

    await expect(scheduleWork(h.deps, operator, request())).rejects.toBeInstanceOf(
      GraphragError
    );
  });
});

describe("MP3 — bounded retry and attempt history", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("delays the second attempt 5 seconds and the third 30 seconds", async () => {
    const job = await scheduleDefault(h);

    const first = await claim(h);
    await settleWork(h.deps, first, { status: "failed", failureCode: "backend_unavailable" }, live);
    let record = await h.store.getJob(job.jobKey);
    expect(record?.status).toBe("pending");
    expect(record?.nextAttemptAt).toBe("2026-10-03T10:00:05.000Z");

    h.setNow(new Date("2026-10-03T10:00:05.000Z"));
    const second = await claim(h);
    expect(second.attemptNumber).toBe(2);
    await settleWork(h.deps, second, { status: "failed", failureCode: "backend_unavailable" }, live);
    record = await h.store.getJob(job.jobKey);
    expect(record?.nextAttemptAt).toBe("2026-10-03T10:00:35.000Z");
  });

  it("exhausts the third transient attempt into a visible failed with no further schedule", async () => {
    const job = await scheduleDefault(h);

    const codes: string[] = [];
    for (const at of ["10:00:00.000", "10:00:05.000", "10:00:35.000"]) {
      h.setNow(new Date(`2026-10-03T${at}Z`));
      const guard = await claim(h);
      const result = await settleWork(
        h.deps,
        guard,
        { status: "failed", failureCode: "backend_unavailable" },
        live
      );
      if (result.result === "settled") codes.push(result.record.status);
    }

    const record = await h.store.getJob(job.jobKey);
    expect(codes).toEqual(["pending", "pending", "failed"]);
    expect(record?.status).toBe("failed");
    expect(record?.nextAttemptAt).toBeNull();
    expect(record?.lastFailureCode).toBe("backend_unavailable");
    expect(h.now().toISOString()).toBe("2026-10-03T10:00:35.000Z");
    expect((await claimNextWork(h.deps)).guard).toBeNull();
  });

  it("does not auto-retry a validation failure", async () => {
    const job = await scheduleDefault(h);
    const guard = await claim(h);

    await settleWork(h.deps, guard, { status: "failed", failureCode: "invalid_input" }, live);

    const record = await h.store.getJob(job.jobKey);
    expect(record?.status).toBe("failed");
    expect(record?.nextAttemptAt).toBeNull();
    expect((await claimNextWork(h.deps)).guard).toBeNull();
  });

  it("keeps resource exhaustion visible instead of retrying it into empty output", async () => {
    const job = await scheduleDefault(h);
    const guard = await claim(h);

    await settleWork(h.deps, guard, { status: "failed", failureCode: "resource_exhausted" }, live);

    expect((await h.store.getJob(job.jobKey))?.lastFailureCode).toBe(
      "resource_exhausted"
    );
    expect((await claimNextWork(h.deps)).guard).toBeNull();
  });

  it("retains a reclaimed attempt in the history and starts the next attempt", async () => {
    const job = await scheduleDefault(h);

    const first = await claim(h);
    h.advance(6 * 60_000);
    await claimNextWork(h.deps);
    const history = await h.store.listAttempts(job.jobKey);

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      attemptNumber: 1,
      failureCode: "lease_lost",
      reclaimed: true,
    });
    expect(history[1]).toMatchObject({ attemptNumber: 2, reclaimed: false });
    expect(first.fencingToken).toBe(history[0]?.fencingToken);
  });

  it("answers a non-retryable job the same way the SQL twin does", async () => {
    const job = await scheduleDefault(h);
    const guard = await claim(h);
    await settleWork(h.deps, guard, { status: "ready" }, live);

    // Both implementations must answer `null` here. The memory twin used to
    // return the unchanged record, which made "retry did nothing" look like
    // "retry happened" to any caller branching on the result.
    expect(await h.store.retryWork(job.jobKey, h.now())).toBeNull();
    expect((await h.store.getJob(job.jobKey))?.status).toBe("ready");
  });

  it("refuses a retry with no job key instead of silently doing nothing", async () => {
    const outcome = await retryWork(h.deps, "   ");

    expect(outcome).toHaveProperty("refused", true);
    expect(outcome).toHaveProperty("code", "invalid_input");
  });

  it("gives an explicit retry a fresh budget without erasing prior attempts", async () => {
    const job = await scheduleDefault(h);
    for (const at of ["10:00:00.000", "10:00:05.000", "10:00:35.000"]) {
      h.setNow(new Date(`2026-10-03T${at}Z`));
      const guard = await claim(h);
      await settleWork(h.deps, guard, { status: "failed", failureCode: "backend_unavailable" }, live);
    }

    const retried = await retryWork(h.deps, job.jobKey);
    expect(retried).not.toHaveProperty("refused");
    if (!retried || "refused" in retried) throw new Error("expected a retried job");
    expect(retried.status).toBe("pending");
    expect(retried?.autoAttemptCount).toBe(0);

    const guard = await claim(h);
    expect(guard.attemptNumber).toBe(4);
    const history = await h.store.listAttempts(job.jobKey);
    expect(history.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3, 4]);
    expect(history.slice(0, 3).every((attempt) => attempt.failureCode === "backend_unavailable")).toBe(true);
  });
});

describe("MP4 — lease, fencing token, and dependency fence", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("mints a distinct unguessable token per attempt", async () => {
    const job = await scheduleDefault(h);
    const first = await claim(h);
    expect(first.fencingToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    h.advance(6 * 60_000);
    await claimNextWork(h.deps);
    const history = await h.store.listAttempts(job.jobKey);
    expect(history[1]?.fencingToken).not.toBe(first.fencingToken);
  });

  it("grants a five-minute lease", async () => {
    await scheduleDefault(h);
    expect((await claim(h)).leaseExpiresAt).toBe("2026-10-03T10:05:00.000Z");
  });

  it("invalidates the old token on reclaim so the stale worker cannot heartbeat or settle", async () => {
    const job = await scheduleDefault(h);
    const first = await claim(h);

    h.advance(6 * 60_000);
    const reclaimed = await claimNextWork(h.deps);
    expect(reclaimed.reclaimed).toEqual([{ jobKey: job.jobKey, reclaimed: true }]);

    expect(await h.store.heartbeatWork(first, h.now())).toBe(false);
    expect(
      await settleWork(h.deps, first, { status: "ready" }, live)
    ).toEqual({ result: "lease_lost" });
  });

  it("refuses a settle whose dependency vector moved under the attempt", async () => {
    const job = await scheduleDefault(h);
    const guard = await claim(h);

    const result = await settleWork(
      h.deps,
      guard,
      { status: "ready" },
      liveInputsOf("rules-3", [dependency({ generation: 2 })])
    );

    expect(result.result).toBe("stale");
    expect((await h.store.getJob(job.jobKey))?.status).toBe("stale");
  });

  it("refuses a settle whose config/ruleset revision was superseded", async () => {
    await scheduleDefault(h);
    const guard = await claim(h);

    const result = await settleWork(
      h.deps,
      guard,
      { status: "ready" },
      liveInputsOf("rules-4", [dependency()])
    );

    expect(result.result).toBe("stale");
  });

  it("extends the lease on every heartbeat but never past the thirty-minute absolute bound", async () => {
    const job = await scheduleDefault(h);
    const guard = await claim(h);

    for (let minute = 1; minute <= 29; minute += 1) {
      h.setNow(new Date(`2026-10-03T10:${String(minute).padStart(2, "0")}:00.000Z`));
      expect(await h.store.heartbeatWork(guard, h.now()), `minute ${minute}`).toBe(true);
    }

    h.setNow(new Date("2026-10-03T10:29:30.000Z"));
    expect(await h.store.heartbeatWork(guard, h.now())).toBe(true);

    h.setNow(new Date("2026-10-03T10:30:01.000Z"));
    expect(await h.store.heartbeatWork(guard, h.now())).toBe(false);
    const timedOut = await settleWork(h.deps, guard, { status: "ready" }, live);
    expect(timedOut).toMatchObject({ result: "timed_out" });

    // Settled, not left running: an attempt that outlived its bound stopped with a
    // typed cause, and leaving the job `running` would let the next reclaim
    // overwrite that cause with `lease_lost`.
    const record = (await h.store.getJob(job.jobKey)) ?? null;
    expect(record).toMatchObject({
      status: "failed",
      lastFailureCode: "execution_timeout",
      nextAttemptAt: null,
    });
    const history = await h.store.listAttempts(job.jobKey);
    expect(history[0]).toMatchObject({
      attemptNumber: 1,
      failureCode: "execution_timeout",
      reclaimed: false,
    });
  });

  it("settles a live attempt to ready exactly once", async () => {
    const job = await scheduleDefault(h);
    const guard = await claim(h);

    const first = await settleWork(h.deps, guard, { status: "ready" }, live);
    expect(first.result).toBe("settled");
    const second = await settleWork(h.deps, guard, { status: "ready" }, live);

    expect(second).toEqual({ result: "lease_lost" });
    expect((await h.store.getJob(job.jobKey))?.status).toBe("ready");
  });
});
