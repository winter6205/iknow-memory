/**
 * MP14 collection marks — the grace boundary and the revision fence, proven at the
 * boundary.
 *
 * Fake clock only, on the same terms as MP13's unit lane: every assertion sits on
 * one side of the 7-day grace or on an exact revision value, because "roughly a
 * week later" cannot tell a fixed grace from a recomputed deadline, and a revision
 * fence that compares loosely is a fence that does not fence.
 */
import { describe, expect, it } from "vitest";

import { COLLECTION_DAY_MS, decideCollectionEligibility } from "../../../src/core/maintenance/collector-eligibility.js";
import {
  planCollectionMark,
  planCollectionReactivation,
  recheckCollectionMark,
} from "../../../src/core/maintenance/collection-mark.js";
import type {
  CollectionMark,
  CollectionMarkRequest,
  CollectionPayloadClass,
  CollectionReactivationRequest,
} from "../../../src/core/maintenance/collection-mark-types.js";
import type {
  CollectionCandidate,
  CollectionEligibility,
  CollectionReadFacts,
} from "../../../src/core/maintenance/collector-types.js";

const DAY0 = new Date("2026-01-01T00:00:00.000Z");
const atDay = (count: number): Date =>
  new Date(DAY0.getTime() + count * COLLECTION_DAY_MS);

const cleanFacts: CollectionReadFacts = {
  bindingResolved: true,
  payloadCollected: false,
  targetRetired: true,
  currentDependencies: [],
  validLeases: [],
  rowReferences: [],
  countOnlyGrants: [],
};

const candidate = (
  payloadClass: CollectionPayloadClass,
  overrides: Partial<CollectionCandidate> = {}
): CollectionCandidate => ({
  payloadClass,
  payloadRef: "s1",
  source: { sourceRef: "s1", sourceVersion: "v1", sourceGeneration: 1 },
  anchorAt: DAY0.toISOString(),
  ...overrides,
});

/** Eligibility as MP13 decided it — MP14 must not recompute this. */
const eligible = (
  payloadClass: CollectionPayloadClass = "retired_unreferenced"
): CollectionEligibility => {
  const outcome = decideCollectionEligibility(
    candidate(payloadClass, payloadClass === "expired_snapshot" ? { source: null } : {}),
    cleanFacts,
    atDay(90)
  );
  if (outcome.refused) throw new Error(`${outcome.code}: ${outcome.detail}`);
  return outcome.eligibility;
};

const markRequest = (
  overrides: Partial<CollectionMarkRequest> = {}
): CollectionMarkRequest => ({
  payloadClass: "retired_unreferenced",
  payloadRef: "s1",
  scopeBinding: "scope-a",
  sourceVersionId: "sv-1",
  eligibility: eligible(),
  lifecycleRevision: "7",
  ...overrides,
});

const plan = (request: CollectionMarkRequest) => {
  const outcome = planCollectionMark(request, atDay(90));
  if (outcome.refused) throw new Error(`${outcome.code}: ${outcome.detail}`);
  return outcome.plan;
};

const persisted = (overrides: Partial<CollectionMark> = {}): CollectionMark => ({
  payloadClass: "retired_unreferenced",
  payloadRef: "s1",
  scopeBinding: "scope-a",
  sourceVersionId: "sv-1",
  expectedLifecycleRevision: "7",
  deadlineAt: atDay(97).toISOString(),
  markedAt: atDay(90).toISOString(),
  state: "marked",
  ...overrides,
});

const reactivation = (
  overrides: Partial<CollectionReactivationRequest> = {}
): CollectionReactivationRequest => ({
  payloadClass: "retired_unreferenced",
  payloadRef: "s1",
  scopeBinding: "scope-a",
  sourceVersionId: "sv-1",
  payloadCollected: false,
  obligationsStopped: true,
  expectedLifecycleRevision: "7",
  observedLifecycleRevision: "7",
  ...overrides,
});

describe("MP14 mark — candidate time is not purge time", () => {
  it("records the purge deadline, exactly seven days after candidate time", () => {
    const eligibility = eligible();
    const mark = plan(markRequest({ eligibility })).mark;
    expect(mark.deadlineAt).toBe(eligibility.physicalPurgeNotBefore);
    expect(mark.deadlineAt).not.toBe(eligibility.earliestCandidateAt);
  });

  it("puts the deadline a whole number of grace days after the candidate instant", () => {
    const eligibility = eligible();
    const gapMs =
      Date.parse(eligibility.physicalPurgeNotBefore) -
      Date.parse(eligibility.earliestCandidateAt);
    expect(gapMs).toBe(7 * COLLECTION_DAY_MS);
  });

  it("cannot record day 90 as the deadline, because day 90 is when the mark is written", () => {
    const eligibility = eligible();
    // A mark written at eligibility time still refuses to move the deadline back to
    // the candidate instant; the 7 days are what separate the two facts.
    expect(Date.parse(plan(markRequest({ eligibility })).mark.deadlineAt)).toBeGreaterThan(
      Date.parse(eligibility.earliestCandidateAt)
    );
  });
});

describe("MP14 mark — the recorded revision is the one it commits at", () => {
  it("stores the supplied commit revision verbatim, not a derived one", () => {
    const mark = plan(markRequest({ lifecycleRevision: "7" })).mark;
    expect(mark.expectedLifecycleRevision).toBe("7");
  });

  it("stays live against the revision it committed at, so it cannot cancel itself", () => {
    const mark = plan(markRequest({ lifecycleRevision: "7" })).mark;
    const outcome = recheckCollectionMark(mark, {
      lifecycleRevision: "7",
      now: atDay(97),
    });
    if (outcome.refused) throw new Error(`${outcome.code}: ${outcome.detail}`);
    expect(outcome.recheck.stale).toBe(false);
  });

  it("refuses a revision that is not a decimal, rather than comparing loosely", () => {
    const outcome = recheckCollectionMark(persisted(), {
      lifecycleRevision: "7 ",
      now: atDay(97),
    });
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("invalid_input");
  });
});

describe("MP14 mark — eligibility is a precondition, not a hint", () => {
  it("refuses to mark a payload still held by a current dependency", () => {
    const held = decideCollectionEligibility(candidate("retired_unreferenced"), {
      ...cleanFacts,
      currentDependencies: [{ kind: "current_source_version", holder: "row-1" }],
    }, atDay(200));
    if (held.refused) throw new Error(`${held.code}: ${held.detail}`);
    const outcome = planCollectionMark(
      markRequest({ eligibility: held.eligibility }),
      atDay(200)
    );
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("invalid_input");
    expect(outcome.detail).toContain("current_dependency");
  });

  it("refuses to mark a payload whose deadline has not arrived", () => {
    const early = decideCollectionEligibility(
      candidate("retired_unreferenced"),
      cleanFacts,
      atDay(10)
    );
    if (early.refused) throw new Error(`${early.code}: ${early.detail}`);
    const outcome = planCollectionMark(markRequest({ eligibility: early.eligibility }), atDay(10));
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.detail).toContain("deadline_not_reached");
  });

  it("refuses an eligibility computed for a different payload class", () => {
    const outcome = planCollectionMark(
      markRequest({ payloadClass: "job_detailed_logs", sourceVersionId: null }),
      atDay(90)
    );
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.detail).toContain("payload class");
  });
});

describe("MP14 mark — the obligations effect follows the class", () => {
  it("stops obligations for a source-bound class", () => {
    expect(plan(markRequest()).stopsObligations).toBe(true);
  });

  it("stops nothing for an object-scoped class, which has no source version", () => {
    const snapshot = plan(
      markRequest({
        payloadClass: "expired_snapshot",
        sourceVersionId: null,
        eligibility: eligible("expired_snapshot"),
      })
    );
    expect(snapshot.stopsObligations).toBe(false);
  });

  it("refuses a source-bound mark with no source version to stop obligations on", () => {
    const outcome = planCollectionMark(
      markRequest({ sourceVersionId: null }),
      atDay(90)
    );
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.detail).toContain("source-bound");
  });

  it("refuses an object-scoped mark that names a source version", () => {
    const outcome = planCollectionMark(
      markRequest({ payloadClass: "job_detailed_logs" }),
      atDay(90)
    );
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.detail).toContain("object-scoped");
  });
});

describe("MP14 mark — malformed requests", () => {
  it("refuses an empty payload ref", () => {
    const outcome = planCollectionMark(markRequest({ payloadRef: "  " }), atDay(90));
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("invalid_input");
  });

  it("refuses an empty scope binding", () => {
    const outcome = planCollectionMark(markRequest({ scopeBinding: "" }), atDay(90));
    expect(outcome.refused).toBe(true);
  });

  it("refuses a missing eligibility rather than treating it as eligible", () => {
    const outcome = planCollectionMark(
      markRequest({ eligibility: undefined as never }),
      atDay(90)
    );
    expect(outcome.refused).toBe(true);
  });

  it("refuses a deadline that is not an unambiguous instant", () => {
    const outcome = planCollectionMark(
      markRequest({
        eligibility: { ...eligible(), physicalPurgeNotBefore: "2026-04-07" },
      }),
      atDay(90)
    );
    expect(outcome.refused).toBe(true);
  });
});

describe("MP14 recheck — stale and due are independent facts", () => {
  it("reports a moved revision as stale while the deadline is still unmet", () => {
    const outcome = recheckCollectionMark(persisted(), {
      lifecycleRevision: "8",
      now: atDay(96),
    });
    if (outcome.refused) throw new Error(`${outcome.code}: ${outcome.detail}`);
    expect(outcome.recheck.stale).toBe(true);
    expect(outcome.recheck.deadlineReached).toBe(false);
  });

  it("reports an unmoved revision as not stale once the deadline is reached", () => {
    const outcome = recheckCollectionMark(persisted(), {
      lifecycleRevision: "7",
      now: atDay(97),
    });
    if (outcome.refused) throw new Error(`${outcome.code}: ${outcome.detail}`);
    expect(outcome.recheck.stale).toBe(false);
    expect(outcome.recheck.deadlineReached).toBe(true);
  });

  it("is stale AND due at once, so a late mark is cancelled rather than deleted", () => {
    const outcome = recheckCollectionMark(persisted(), {
      lifecycleRevision: "8",
      now: atDay(97),
    });
    if (outcome.refused) throw new Error(`${outcome.code}: ${outcome.detail}`);
    expect(outcome.recheck.stale).toBe(true);
    expect(outcome.recheck.deadlineReached).toBe(true);
  });

  it("holds the deadline one millisecond early", () => {
    const outcome = recheckCollectionMark(persisted(), {
      lifecycleRevision: "7",
      now: new Date(Date.parse(atDay(97).toISOString()) - 1),
    });
    if (outcome.refused) throw new Error(`${outcome.code}: ${outcome.detail}`);
    expect(outcome.recheck.deadlineReached).toBe(false);
  });

  it("refuses to recheck a mark that is already cancelled", () => {
    const outcome = recheckCollectionMark(persisted({ state: "cancelled" }), {
      lifecycleRevision: "7",
      now: atDay(97),
    });
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("input_stale");
  });
});

describe("MP14 reactivation — cancel before dependencies", () => {
  it("resumes obligations for a source-bound mark that stopped them", () => {
    const outcome = planCollectionReactivation(reactivation(), atDay(91));
    if (outcome.refused) throw new Error(`${outcome.code}: ${outcome.detail}`);
    expect(outcome.plan.resumedObligations).toBe(true);
    expect(outcome.plan.sourceVersionId).toBe("sv-1");
  });

  it("resumes nothing when no mark was stopping obligations", () => {
    const outcome = planCollectionReactivation(
      reactivation({ obligationsStopped: false }),
      atDay(91)
    );
    if (outcome.refused) throw new Error(`${outcome.code}: ${outcome.detail}`);
    expect(outcome.plan.resumedObligations).toBe(false);
  });

  it("refuses to reactivate a payload that is already collected", () => {
    const outcome = planCollectionReactivation(
      reactivation({ payloadCollected: true }),
      atDay(91)
    );
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("input_stale");
    expect(outcome.detail).toContain("already collected");
  });

  it("refuses when the scope revision moved since the caller read it", () => {
    const outcome = planCollectionReactivation(
      reactivation({ expectedLifecycleRevision: "7", observedLifecycleRevision: "8" }),
      atDay(91)
    );
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("input_stale");
  });

  it("refuses an object-scoped reactivation that names a source version", () => {
    const outcome = planCollectionReactivation(
      reactivation({ payloadClass: "job_detailed_logs" }),
      atDay(91)
    );
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.detail).toContain("object-scoped");
  });
});

describe("MP14 — purity", () => {
  it("reads only the injected instant, never the wall clock", () => {
    const real = Date.now;
    let calls = 0;
    Date.now = () => {
      calls += 1;
      return real();
    };
    try {
      const mark = plan(markRequest());
      recheckCollectionMark(mark.mark, { lifecycleRevision: "7", now: atDay(97) });
      planCollectionReactivation(reactivation(), atDay(91));
    } finally {
      Date.now = real;
    }
    expect(calls).toBe(0);
  });
});
