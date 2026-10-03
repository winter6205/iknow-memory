import { describe, expect, it } from "vitest";

import {
  absoluteDeadlineFrom,
  canonicalDependencyRevision,
  computeMaintenanceJobKey,
  leaseExpiryFrom,
  nextRetryDelayMs,
  verifyAttemptGuard,
} from "../../../src/core/maintenance/durable-work.js";
import {
  MAX_AUTO_ATTEMPTS,
  type MaintenanceAttemptGuard,
  type MaintenanceDependency,
  type MaintenanceWorkRequest,
} from "../../../src/core/maintenance/types.js";

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

const guard = (
  overrides: Partial<MaintenanceAttemptGuard> = {}
): MaintenanceAttemptGuard => ({
  jobKey: "key",
  attemptNumber: 1,
  fencingToken: "token-a",
  workKind: "extract_publish",
  sourceRef: "s1",
  sourceVersion: "v1",
  sourceGeneration: 1,
  inputRevision: canonicalDependencyRevision([dependency()]),
  configRevision: "rules-3",
  leaseExpiresAt: "2026-10-03T10:05:00.000Z",
  attemptStartedAt: "2026-10-03T10:00:00.000Z",
  ...overrides,
});

describe("canonicalDependencyRevision", () => {
  it("is stable regardless of dependency order", () => {
    const forward = canonicalDependencyRevision([
      dependency({ sourceRef: "s1" }),
      dependency({ sourceRef: "s2", generation: 4 }),
    ]);
    const reverse = canonicalDependencyRevision([
      dependency({ sourceRef: "s2", generation: 4 }),
      dependency({ sourceRef: "s1" }),
    ]);

    expect(forward).toBe(reverse);
  });

  it("changes when any generation, extraction revision, or bucket set differs", () => {
    const base = canonicalDependencyRevision([dependency()]);

    expect(canonicalDependencyRevision([dependency({ generation: 2 })])).not.toBe(base);
    expect(canonicalDependencyRevision([dependency({ extractionRevision: 3 })])).not.toBe(base);
    expect(
      canonicalDependencyRevision([dependency({ relationBuckets: ["employment", "office"] })])
    ).not.toBe(base);
  });

  it("treats a relation bucket list as a set, not as an ordered tuple", () => {
    expect(canonicalDependencyRevision([dependency({ relationBuckets: ["a", "b"] })])).toBe(
      canonicalDependencyRevision([dependency({ relationBuckets: ["b", "a"] })])
    );
  });

  it("distinguishes an absent extraction revision from revision zero", () => {
    expect(canonicalDependencyRevision([dependency({ extractionRevision: null })])).not.toBe(
      canonicalDependencyRevision([dependency({ extractionRevision: 0 })])
    );
  });
});

describe("computeMaintenanceJobKey", () => {
  it("is stable for the same request", () => {
    expect(computeMaintenanceJobKey(request())).toBe(computeMaintenanceJobKey(request()));
  });

  it("is UUID-shaped so it can key a text primary key", () => {
    expect(computeMaintenanceJobKey(request())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("gives a different job to a different work kind", () => {
    expect(computeMaintenanceJobKey(request({ workKind: "conflict_check" }))).not.toBe(
      computeMaintenanceJobKey(request())
    );
  });

  it("gives a different job to a different source version or generation", () => {
    expect(computeMaintenanceJobKey(request({ sourceVersion: "v2" }))).not.toBe(
      computeMaintenanceJobKey(request())
    );
    expect(computeMaintenanceJobKey(request({ sourceGeneration: 2 }))).not.toBe(
      computeMaintenanceJobKey(request())
    );
  });

  it("gives a different job to a different config/ruleset revision", () => {
    expect(computeMaintenanceJobKey(request({ configRevision: "rules-4" }))).not.toBe(
      computeMaintenanceJobKey(request())
    );
  });

  it("gives a different job to a different dependency vector", () => {
    expect(
      computeMaintenanceJobKey(
        request({ dependencies: [dependency(), dependency({ sourceRef: "s2", generation: 7 })] })
      )
    ).not.toBe(computeMaintenanceJobKey(request()));
  });

  it("does not join a rebuild job whose relation buckets moved", () => {
    const before = request({ workKind: "projection_rebuild", dependencies: [dependency()] });
    const after = request({
      workKind: "projection_rebuild",
      dependencies: [dependency({ relationBuckets: ["employment", "office"] })],
    });

    expect(computeMaintenanceJobKey(after)).not.toBe(computeMaintenanceJobKey(before));
  });
});

describe("nextRetryDelayMs", () => {
  it("delays 5 seconds then 30 seconds and gives up after the third attempt", () => {
    expect(nextRetryDelayMs(1)).toBe(5_000);
    expect(nextRetryDelayMs(2)).toBe(30_000);
    expect(nextRetryDelayMs(MAX_AUTO_ATTEMPTS)).toBeNull();
  });

  it("refuses an attempt number outside the automatic budget", () => {
    expect(nextRetryDelayMs(0)).toBeNull();
    expect(nextRetryDelayMs(MAX_AUTO_ATTEMPTS + 1)).toBeNull();
  });
});

describe("leaseExpiryFrom", () => {
  it("grants exactly the five-minute lease", () => {
    expect(leaseExpiryFrom("2026-10-03T10:00:00.000Z")).toBe("2026-10-03T10:05:00.000Z");
  });
});

describe("absoluteDeadlineFrom", () => {
  it("puts the absolute execution limit at thirty minutes", () => {
    expect(absoluteDeadlineFrom("2026-10-03T10:00:00.000Z")).toBe(
      "2026-10-03T10:30:00.000Z"
    );
  });
});

describe("verifyAttemptGuard", () => {
  const live = {
    configRevision: "rules-3",
    dependencies: [dependency()],
  };

  it("accepts a live attempt whose token, lease, and inputs all hold", () => {
    expect(
      verifyAttemptGuard(
        guard(),
        live,
        new Date("2026-10-03T10:01:00.000Z"),
        guard().fencingToken
      )
    ).toEqual({ ok: true });
  });

  it("rejects a superseded fencing token", () => {
    expect(
      verifyAttemptGuard(
        guard({ fencingToken: "token-b" }),
        live,
        new Date("2026-10-03T10:01:00.000Z"),
        "token-a"
      )
    ).toEqual({ ok: false, code: "lease_lost" });
  });

  it("rejects a write at and after the lease expiry instant", () => {
    // The SQL twin uses `lease_expires_at > $now`, so the boundary instant is
    // already outside the lease. `+0.001Z` alone would let the twins disagree.
    for (const instant of ["2026-10-03T10:05:00.000Z", "2026-10-03T10:05:00.001Z"]) {
      expect(
        verifyAttemptGuard(guard(), live, new Date(instant), guard().fencingToken),
        instant
      ).toEqual({ ok: false, code: "lease_lost" });
    }
  });

  it("rejects a write past the absolute execution limit even with a heartbeat-extended lease", () => {
    const heartbeatExtended = guard({ leaseExpiresAt: "2026-10-03T10:59:00.000Z" });
    const result = verifyAttemptGuard(
      heartbeatExtended,
      live,
      new Date("2026-10-03T10:31:00.000Z"),
      heartbeatExtended.fencingToken
    );

    expect(result).toEqual({ ok: false, code: "execution_timeout" });
  });

  it("rejects a config/ruleset revision that moved under the attempt", () => {
    expect(
      verifyAttemptGuard(
        guard(),
        { ...live, configRevision: "rules-4" },
        new Date("2026-10-03T10:01:00.000Z"),
        guard().fencingToken
      )
    ).toEqual({ ok: false, code: "input_stale" });
  });

  it("rejects a dependency vector that changed under the attempt", () => {
    expect(
      verifyAttemptGuard(
        guard(),
        { ...live, dependencies: [dependency({ generation: 2 })] },
        new Date("2026-10-03T10:01:00.000Z"),
        guard().fencingToken
      )
    ).toEqual({ ok: false, code: "input_stale" });
  });

  it("treats missing dependency metadata as stale rather than serving it", () => {
    expect(
      verifyAttemptGuard(
        guard(),
        { ...live, dependencies: [] },
        new Date("2026-10-03T10:01:00.000Z"),
        guard().fencingToken
      )
    ).toEqual({ ok: false, code: "input_stale" });
  });
});

describe("canonicalDependencyRevision — bucket set identity", () => {
  it("does not let [a,b] and [ab] share one revision", () => {
    expect(
      canonicalDependencyRevision([dependency({ relationBuckets: ["a", "b"] })])
    ).not.toBe(canonicalDependencyRevision([dependency({ relationBuckets: ["ab"] })]));
  });

  it("does not let a bucket list prefix another", () => {
    expect(
      canonicalDependencyRevision([dependency({ relationBuckets: ["a"] })])
    ).not.toBe(
      canonicalDependencyRevision([dependency({ relationBuckets: ["a", "b"] })])
    );
  });
});
