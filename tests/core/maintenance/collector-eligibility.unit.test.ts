/**
 * MP13 collector eligibility — the day arithmetic, proven at the boundary.
 *
 * Fake clock only: every assertion here sits on one side of day 7, day 90, day 365
 * or the 7-day mark grace, because "somewhere near 90 days" cannot tell a fixed
 * deadline from a sliding one, and the specification's whole claim here is that the
 * deadlines are fixed elapsed UTC 24-hour periods that no read renews (spec
 * lines 299-300).
 */
import { describe, expect, it } from "vitest";

import {
  ATTEMPT_STAGE_GRACE_DAYS,
  COLLECTION_DAY_MS,
  COLLECTION_MARK_GRACE_DAYS,
  DERIVED_REPLACEMENT_GRACE_DAYS,
  JOB_LOG_DEADLINE_DAYS,
  RETIRED_PAYLOAD_DEADLINE_DAYS,
  ROW_REFERENCE_CAP_DAYS,
  decideCollectionEligibility,
} from "../../../src/core/maintenance/collector-eligibility.js";
import type {
  CollectionCandidate,
  CollectionEligibility,
  CollectionPayloadClass,
  CollectionReadFacts,
} from "../../../src/core/maintenance/collector-types.js";
import type { CollectionEligibilityReader } from "../../../src/core/maintenance/collector-types.js";

/** Day 0. Every case measures from here, as the spec's day-0 retirement does. */
const DAY0 = new Date("2026-01-01T00:00:00.000Z");

const days = (count: number): number => DAY0.getTime() + count * COLLECTION_DAY_MS;
const atDay = (count: number): Date => new Date(days(count));

const binding = {
  sourceRef: "s1",
  sourceVersion: "v1",
  sourceGeneration: 1,
};

const candidate = (
  payloadClass: CollectionPayloadClass,
  overrides: Partial<CollectionCandidate> = {}
): CollectionCandidate => ({
  payloadClass,
  payloadRef: "s1",
  source: binding,
  anchorAt: DAY0.toISOString(),
  ...overrides,
});

const cleanFacts: CollectionReadFacts = {
  bindingResolved: true,
  payloadCollected: false,
  targetRetired: true,
  currentDependencies: [],
  validLeases: [],
  rowReferences: [],
  countOnlyGrants: [],
};

const decide = (
  payload: CollectionCandidate,
  facts: Partial<CollectionReadFacts>,
  now: Date
): CollectionEligibility => {
  const outcome = decideCollectionEligibility(payload, { ...cleanFacts, ...facts }, now);
  if (outcome.refused) throw new Error(`${outcome.code}: ${outcome.detail}`);
  return outcome.eligibility;
};

describe("collector eligibility — the 7-day classes", () => {
  it("holds a failed attempt stage one millisecond short of day 7", () => {
    const payload = candidate("attempt_stage");
    const blocked = decide(payload, {}, atDay(7) && new Date(days(7) - 1));

    expect(blocked.eligible).toBe(false);
    expect(blocked.blockingReasons).toContain("deadline_not_reached");
    expect(blocked.earliestCandidateAt).toBe(atDay(ATTEMPT_STAGE_GRACE_DAYS).toISOString());
  });

  it("makes the attempt stage a candidate at exactly day 7", () => {
    const eligibility = decide(candidate("attempt_stage"), {}, atDay(7));

    expect(eligibility.eligible).toBe(true);
    expect(eligibility.blockingReasons).toEqual([]);
    expect(eligibility.nextEvaluationAt).toBeNull();
  });

  it("applies the same 7 days to a replaced derived generation", () => {
    const payload = candidate("derived_generation");

    expect(decide(payload, {}, new Date(days(7) - 1)).eligible).toBe(false);
    expect(decide(payload, {}, atDay(7)).eligible).toBe(true);
  });

  it("uses 7 days and 90 days as the fixed numbers, not configuration", () => {
    expect(ATTEMPT_STAGE_GRACE_DAYS).toBe(7);
    expect(DERIVED_REPLACEMENT_GRACE_DAYS).toBe(7);
    expect(RETIRED_PAYLOAD_DEADLINE_DAYS).toBe(90);
    expect(JOB_LOG_DEADLINE_DAYS).toBe(90);
    expect(ROW_REFERENCE_CAP_DAYS).toBe(365);
    expect(COLLECTION_DAY_MS).toBe(86_400_000);
  });
});

describe("collector eligibility — the 90-day classes", () => {
  it("holds a retired unreferenced payload until day 90 and releases it at day 90", () => {
    const payload = candidate("retired_unreferenced");

    const before = decide(payload, {}, new Date(days(90) - 1));
    expect(before.eligible).toBe(false);
    expect(before.earliestCandidateAt).toBe(atDay(90).toISOString());
    expect(before.nextEvaluationAt).toBe(atDay(90).toISOString());

    expect(decide(payload, {}, atDay(90)).eligible).toBe(true);
  });

  it("holds completed job detailed logs to day 90 as well", () => {
    const payload = candidate("job_detailed_logs");

    expect(decide(payload, {}, new Date(days(90) - 1)).eligible).toBe(false);
    expect(decide(payload, {}, atDay(90)).eligible).toBe(true);
  });

  it("puts an expired snapshot payload at reference expiry with no added delay", () => {
    const payload = candidate("expired_snapshot", {
      payloadRef: "snapshot-1",
      source: null,
      anchorAt: atDay(30).toISOString(),
    });

    expect(decide(payload, {}, new Date(days(30) - 1)).eligible).toBe(false);
    const atExpiry = decide(payload, {}, atDay(30));
    expect(atExpiry.eligible).toBe(true);
    expect(atExpiry.earliestCandidateAt).toBe(atDay(30).toISOString());
  });
});

describe("collector eligibility — candidate time is not purge time", () => {
  it("separates day 90 candidate time from day 97 physical purge time", () => {
    const eligibility = decide(candidate("retired_unreferenced"), {}, atDay(90));

    expect(eligibility.earliestCandidateAt).toBe(atDay(90).toISOString());
    expect(eligibility.physicalPurgeNotBefore).toBe(atDay(97).toISOString());
  });

  it("still refuses deletion at day 96, one day inside the grace", () => {
    const eligibility = decide(candidate("retired_unreferenced"), {}, atDay(96));

    expect(eligibility.eligible).toBe(true);
    expect(eligibility.physicalPurgeNotBefore).toBe(atDay(97).toISOString());
    expect(atDay(96).getTime()).toBeLessThan(
      Date.parse(eligibility.physicalPurgeNotBefore)
    );
  });
});

describe("collector eligibility — dependencies, leases and references block", () => {
  it("blocks on a current source or compiled-object dependency", () => {
    const eligibility = decide(
      candidate("retired_unreferenced"),
      {
        currentDependencies: [
          { kind: "published_or_desired_scope", holder: "scope-a" },
        ],
      },
      atDay(200)
    );

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockingReasons).toContain("current_dependency");
    // No clock reading releases a dependency, so there is no instant to schedule.
    expect(eligibility.nextEvaluationAt).toBeNull();
  });

  it("blocks while a job lease is valid and releases at the lease instant", () => {
    const payload = candidate("retired_unreferenced");
    const facts = {
      validLeases: [
        { kind: "job" as const, holder: "job-1", expiresAt: atDay(120).toISOString() },
      ],
    };

    expect(decide(payload, facts, atDay(119)).blockingReasons).toContain("valid_lease");
    expect(decide(payload, facts, atDay(120)).eligible).toBe(true);
  });

  it("blocks while a reader lease is valid", () => {
    const eligibility = decide(
      candidate("retired_unreferenced"),
      {
        validLeases: [
          { kind: "reader", holder: "reader-7", expiresAt: atDay(120).toISOString() },
        ],
      },
      atDay(100)
    );

    expect(eligibility.blockingReasons).toContain("valid_lease");
  });

  it("blocks on an unexpired row-content reference and releases it at expiry", () => {
    const payload = candidate("retired_unreferenced");
    const facts = {
      rowReferences: [
        { evidenceRef: "grant-1", expiresAt: atDay(200).toISOString() },
      ],
    };

    const before = decide(payload, facts, atDay(199));
    expect(before.blockingReasons).toContain("row_content_reference");
    expect(before.nextEvaluationAt).toBe(atDay(200).toISOString());

    // A nonrenewing reference releases the payload at its own boundary.
    expect(decide(payload, facts, atDay(200)).eligible).toBe(true);
  });

  it("does not let a read renew an expired row reference", () => {
    const payload = candidate("retired_unreferenced");
    const expired = {
      rowReferences: [
        { evidenceRef: "grant-1", expiresAt: atDay(50).toISOString() },
      ],
    };

    // Released at its own boundary: what still holds the payload at day 50 is
    // this class's own 90-day deadline, never the dead reference.
    expect(decide(payload, expired, atDay(50)).blockingReasons).toEqual([
      "deadline_not_reached",
    ]);
    expect(decide(payload, expired, atDay(90)).eligible).toBe(true);
    expect(decide(payload, expired, atDay(365)).eligible).toBe(true);
  });
});

describe("collector eligibility — count-only grants do not block", () => {
  it("leaves a source payload collectable with a live count grant present", () => {
    const eligibility = decide(
      candidate("retired_unreferenced"),
      {
        countOnlyGrants: [
          {
            evidenceRef: "count-1",
            receiptId: "receipt-1",
            expiresAt: atDay(300).toISOString(),
          },
        ],
      },
      atDay(90)
    );

    expect(eligibility.eligible).toBe(true);
    expect(eligibility.blockingReasons).toEqual([]);
    // The grant is recorded as seen-and-ignored, never as a reason.
    expect(eligibility.ignoredCountGrants).toEqual(["count-1"]);
  });

  it("has no blocking reason a count grant could ever produce", () => {
    const eligibility = decide(
      candidate("retired_unreferenced"),
      {
        countOnlyGrants: [
          { evidenceRef: "count-1", receiptId: "r1", expiresAt: atDay(300).toISOString() },
        ],
      },
      atDay(1)
    );

    expect(eligibility.blockingReasons).toEqual(["deadline_not_reached"]);
  });
});

describe("collector eligibility — the 365-day cap", () => {
  const protectedPayload = candidate("retired_evidence_protected");

  it("extends past day 90 to a finite row reference that outlives it", () => {
    const eligibility = decide(
      protectedPayload,
      { rowReferences: [{ evidenceRef: "g1", expiresAt: atDay(200).toISOString() }] },
      atDay(200)
    );

    expect(eligibility.earliestCandidateAt).toBe(atDay(200).toISOString());
    expect(eligibility.eligible).toBe(true);
  });

  it("does not extend at all when the reference expires before day 90", () => {
    const eligibility = decide(
      protectedPayload,
      { rowReferences: [{ evidenceRef: "g1", expiresAt: atDay(30).toISOString() }] },
      atDay(90)
    );

    expect(eligibility.earliestCandidateAt).toBe(atDay(90).toISOString());
    expect(eligibility.eligible).toBe(true);
  });

  it("caps a long-lived reference at day 365 while no dependency exists", () => {
    const eligibility = decide(
      protectedPayload,
      { rowReferences: [{ evidenceRef: "g1", expiresAt: atDay(400).toISOString() }] },
      atDay(365)
    );

    expect(eligibility.earliestCandidateAt).toBe(atDay(365).toISOString());
    expect(eligibility.eligible).toBe(true);
    expect(atDay(364).getTime()).toBeLessThan(
      Date.parse(eligibility.earliestCandidateAt)
    );
  });

  it("delays the mark recheck of a day-365 candidate to day 372", () => {
    const eligibility = decide(
      protectedPayload,
      { rowReferences: [{ evidenceRef: "g1", expiresAt: atDay(400).toISOString() }] },
      atDay(365)
    );

    expect(eligibility.physicalPurgeNotBefore).toBe(atDay(372).toISOString());
  });

  it("lifts the cap for a reference a current dependency holds alive", () => {
    const eligibility = decide(
      protectedPayload,
      {
        rowReferences: [{ evidenceRef: "g1", expiresAt: atDay(400).toISOString() }],
        currentDependencies: [{ kind: "current_source_version", holder: "v2" }],
      },
      atDay(365)
    );

    // The cap is conditioned on the absence of a current dependency (spec 292), so
    // the reported deadline is the reference's own expiry. MP14 persists this
    // deadline, which is why the branch is asserted rather than left implicit.
    expect(eligibility.earliestCandidateAt).toBe(atDay(400).toISOString());
    expect(eligibility.blockingReasons).toContain("current_dependency");
  });
});

describe("collector eligibility — retirement is a store fact, not a claim", () => {
  it("refuses a retired_* class for a source version that is not retired", () => {
    const outcome = decideCollectionEligibility(
      candidate("retired_unreferenced"),
      { ...cleanFacts, targetRetired: false },
      atDay(90)
    );

    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("invalid_input");
  });

  it("refuses the same class at day 400, where being old would otherwise suffice", () => {
    const outcome = decideCollectionEligibility(
      candidate("retired_evidence_protected"),
      { ...cleanFacts, targetRetired: false },
      atDay(400)
    );

    expect(outcome.refused).toBe(true);
  });

  it("still collects the two classes that legitimately sit on a current version", () => {
    // Attempt stages and derived generations hang off a source version that is
    // still current (spec 289-290): their anchors are a terminal state and a stable
    // replacement, not a retirement.
    expect(
      decide(candidate("attempt_stage"), { targetRetired: false }, atDay(7)).eligible
    ).toBe(true);
    expect(
      decide(candidate("derived_generation"), { targetRetired: false }, atDay(7)).eligible
    ).toBe(true);
  });
});

describe("collector eligibility — refusals are typed values", () => {
  it("refuses a missing anchor as invalid_input instead of reading it as zero", () => {
    const outcome = decideCollectionEligibility(
      candidate("retired_unreferenced", { anchorAt: null }),
      cleanFacts,
      atDay(90)
    );

    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("invalid_input");
  });

  it("refuses an unbound source-bound class", () => {
    const outcome = decideCollectionEligibility(
      candidate("retired_unreferenced", { source: null }),
      cleanFacts,
      atDay(90)
    );

    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("invalid_input");
  });

  it("refuses an unresolvable source binding as unsupported_source_binding", () => {
    const outcome = decideCollectionEligibility(
      candidate("retired_unreferenced"),
      { ...cleanFacts, bindingResolved: false },
      atDay(90)
    );

    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("unsupported_source_binding");
  });

  it("refuses an unknown payload class", () => {
    const outcome = decideCollectionEligibility(
      candidate("retired_unreferenced", {
        payloadClass: "whatever" as CollectionPayloadClass,
      }),
      cleanFacts,
      atDay(90)
    );

    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("invalid_input");
  });

  it("reports an already-collected payload as a no-op, not a verdict", () => {
    const eligibility = decide(
      candidate("retired_unreferenced"),
      { payloadCollected: true },
      atDay(200)
    );

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockingReasons).toContain("already_collected");
  });

  it("treats an unreadable reference expiry as protection that never releases", () => {
    const eligibility = decide(
      candidate("retired_evidence_protected"),
      { rowReferences: [{ evidenceRef: "g1", expiresAt: "not-a-date" }] },
      atDay(1000)
    );

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockingReasons).toContain("row_content_reference");
    expect(eligibility.nextEvaluationAt).toBeNull();
  });
});

describe("readCollectionEligibility", () => {
  it("reads once through the injected clock and never touches Date.now", async () => {
    const reads: number[] = [];
    const reader: CollectionEligibilityReader = {
      async readCollectionFacts(candidate, now) {
        reads.push(now.getTime());
        return cleanFacts;
      },
    };
    const { readCollectionEligibility } = await import(
      "../../../src/core/maintenance/collector-eligibility.js"
    );

    const outcome = await readCollectionEligibility(
      { reader, clock: () => atDay(90) },
      candidate("retired_unreferenced")
    );

    expect(reads).toEqual([atDay(90).getTime()]);
    expect(outcome.refused).toBe(false);
    if (outcome.refused) return;
    expect(outcome.eligibility.eligible).toBe(true);
  });

  it("refuses before reading, so a malformed candidate never reaches the store", async () => {
    let readCount = 0;
    const reader: CollectionEligibilityReader = {
      async readCollectionFacts() {
        readCount += 1;
        return cleanFacts;
      },
    };
    const { readCollectionEligibility } = await import(
      "../../../src/core/maintenance/collector-eligibility.js"
    );

    const outcome = await readCollectionEligibility(
      { reader, clock: () => atDay(90) },
      candidate("retired_unreferenced", { anchorAt: null })
    );

    expect(readCount).toBe(0);
    expect(outcome.refused).toBe(true);
  });
});