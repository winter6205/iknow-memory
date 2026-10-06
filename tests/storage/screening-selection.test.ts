/**
 * The selection rule and its fences, exercised as pure functions.
 *
 * Every expectation here is derived from the inherited specification's
 * structural rules, never from a backend's observed output: the accept and
 * reject cases name the spec clause they encode, and the candidate ids asserted
 * are computed from the frozen identity inputs rather than copied from a run.
 */
import { describe, expect, it } from "vitest";

import {
  intervalsAdjacent,
  intervalsOverlap,
  isConflictCheckGuard,
  screenFenceVerdict,
  selectStructuralAlternatives,
  toStructuralCandidates,
  uncertaintyOf,
} from "../../src/core/maintenance/screening-selection.js";
import {
  emptyRelationCatalog,
  SCREENING_COVERAGE,
  SCREENING_RULESET_REVISION,
  type RelationCatalog,
  type ScreeningAssertion,
  type ValidInterval,
} from "../../src/core/maintenance/screening-types.js";
import type { MaintenanceAttemptGuard } from "../../src/core/maintenance/types.js";
import { canonicalDependencyRevision } from "../../src/core/maintenance/durable-work.js";

const HEAD = "00000000-0000-4000-8000-0000000000a1";
const TAIL_A = "00000000-0000-4000-8000-0000000000b1";
const TAIL_B = "00000000-0000-4000-8000-0000000000b2";
const TAIL_C = "00000000-0000-4000-8000-0000000000b3";
const SUPPORT_A = "00000000-0000-4000-8000-0000000000c1";
const SUPPORT_B = "00000000-0000-4000-8000-0000000000c2";

function bounded(lower: BoundInput, upper: BoundInput): ValidInterval {
  return { lower, upper };
}

type BoundInput = string | null;

function open(lower: BoundInput, upper: BoundInput): ValidInterval {
  return { lower, upper };
}

function assertion(
  overrides: Partial<ScreeningAssertion> & Pick<ScreeningAssertion, "assertionId" | "tailEntityId">
): ScreeningAssertion {
  return {
    headEntityId: HEAD,
    relationNorm: "has_chair",
    interval: bounded("2020-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z"),
    supportIds: [SUPPORT_A],
    extractionRef: "extraction-1",
    extractionRevision: 1,
    inputRevision: "input-revision-1",
    ...overrides,
  };
}

function select(
  assertions: readonly ScreeningAssertion[],
  catalog: RelationCatalog = emptyRelationCatalog()
): ReturnType<typeof selectStructuralAlternatives> {
  return selectStructuralAlternatives(assertions, catalog);
}

function candidateIdsOf(
  result: ReturnType<typeof selectStructuralAlternatives>
): string[] {
  const candidates = result.alternatives.flatMap((alternative) =>
    toStructuralCandidates(alternative, {
      checkId: "check-1",
      inputRevision: "input-revision-1",
      relationCatalogVersion: 0,
      publishedAt: "2026-01-01T00:00:00.000Z",
    }).map((candidate) => candidate.candidateId)
  );
  return candidates.sort();
}

describe("structural screen grouping: one exact canonical head and normalized relation", () => {
  it("becomes a candidate when two distinct tails have overlapping half-open intervals", () => {
    // spec: distinct tails with overlapping half-open valid intervals form a
    // potential alternative.
    const result = select([
      assertion({ assertionId: "a-1", tailEntityId: TAIL_A }),
      assertion({
        assertionId: "a-2",
        tailEntityId: TAIL_B,
        supportIds: [SUPPORT_B],
      }),
    ]);
    expect(result.nonCandidates).toEqual([]);
    expect(result.alternatives).toHaveLength(1);
    const [candidate] = toStructuralCandidates(result.alternatives[0]!, {
      checkId: "check-1",
      inputRevision: "input-revision-1",
      relationCatalogVersion: 0,
      publishedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(candidate!.tailEntityIds).toEqual([TAIL_A, TAIL_B]);
    expect(candidate!.assertionIds).toEqual(["a-1", "a-2"]);
    expect(candidate!.rulesetRevision).toBe(SCREENING_RULESET_REVISION);
    expect(candidate!.coverage).toBe(SCREENING_COVERAGE);
  });

  it("does not become a candidate when two distinct tails are merely adjacent", () => {
    // spec: intervals that only touch are not overlapping; the upper bound is
    // excluded from the half-open interval.
    const result = select([
      assertion({
        assertionId: "a-1",
        tailEntityId: TAIL_A,
        interval: bounded("2020-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"),
      }),
      assertion({
        assertionId: "a-2",
        tailEntityId: TAIL_B,
        interval: bounded("2025-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z"),
        supportIds: [SUPPORT_B],
      }),
    ]);
    expect(result.alternatives).toEqual([]);
    expect(result.nonCandidates.map((entry) => entry.reason)).toEqual([
      "adjacent_intervals",
    ]);
  });

  it("does not become a candidate when two distinct tails have disjoint intervals", () => {
    const result = select([
      assertion({
        assertionId: "a-1",
        tailEntityId: TAIL_A,
        interval: bounded("2000-01-01T00:00:00.000Z", "2001-01-01T00:00:00.000Z"),
      }),
      assertion({
        assertionId: "a-2",
        tailEntityId: TAIL_B,
        interval: bounded("2020-01-01T00:00:00.000Z", "2021-01-01T00:00:00.000Z"),
        supportIds: [SUPPORT_B],
      }),
    ]);
    expect(result.alternatives).toEqual([]);
    expect(result.nonCandidates.map((entry) => entry.reason)).toEqual([
      "disjoint_intervals",
    ]);
  });

  it("does not become a candidate when one assertion carries several supports", () => {
    // spec: an exact same head/relation/tail/interval match is one assertion
    // with multiple supports, not a conflict.
    const result = select([
      assertion({
        assertionId: "a-1",
        tailEntityId: TAIL_A,
        supportIds: [SUPPORT_A],
      }),
      assertion({
        assertionId: "a-2",
        tailEntityId: TAIL_A,
        supportIds: [SUPPORT_B],
      }),
    ]);
    expect(result.alternatives).toEqual([]);
    expect(result.nonCandidates.map((entry) => entry.reason)).toEqual([
      "identical_assertion",
    ]);
    // Both contributing assertion ids and both supports stay on the record, so
    // collapsing a duplicate never discards its evidence.
    expect(result.nonCandidates[0]!.assertionIds).toEqual(["a-1", "a-2"]);
  });

  it("does not become a candidate when the same assertion has multiple origins", () => {
    // spec: exact duplicates from several sources are one assertion; several
    // origins are not a conflict.
    const result = select([
      assertion({
        assertionId: "a-1",
        tailEntityId: TAIL_A,
        extractionRef: "extraction-source-1",
        inputRevision: "input-revision-source-1",
      }),
      assertion({
        assertionId: "a-2",
        tailEntityId: TAIL_A,
        extractionRef: "extraction-source-2",
        inputRevision: "input-revision-source-2",
      }),
    ]);
    expect(result.alternatives).toEqual([]);
    expect(result.nonCandidates.map((entry) => entry.reason)).toEqual([
      "identical_assertion",
    ]);
  });

  it("keeps exact duplicates distinct from distinct intervals on one tail", () => {
    // spec: distinct intervals remain distinct assertions.
    const result = select([
      assertion({
        assertionId: "a-1",
        tailEntityId: TAIL_A,
        interval: bounded("2000-01-01T00:00:00.000Z", "2001-01-01T00:00:00.000Z"),
      }),
      assertion({
        assertionId: "a-2",
        tailEntityId: TAIL_A,
        interval: bounded("2020-01-01T00:00:00.000Z", "2021-01-01T00:00:00.000Z"),
      }),
      assertion({
        assertionId: "a-3",
        tailEntityId: TAIL_B,
        interval: bounded("2000-01-01T00:00:00.000Z", "2001-01-01T00:00:00.000Z"),
        supportIds: [SUPPORT_B],
      }),
    ]);
    expect(result.alternatives).toHaveLength(1);
    const [candidate] = toStructuralCandidates(result.alternatives[0]!, {
      checkId: "check-1",
      inputRevision: "input-revision-1",
      relationCatalogVersion: 0,
      publishedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(candidate!.assertionIds).toEqual(["a-1", "a-3"]);
    expect(candidate!.tailEntityIds).toEqual([TAIL_A, TAIL_B]);
  });

  it("does not become a candidate for a relation the catalog labels multi-valued", () => {
    // spec: a versioned relation catalog may label relations multi-valued, and
    // known multi-valued relations do not create a candidate by tail difference
    // alone. The empty initial catalog is left empty.
    const catalog: RelationCatalog = {
      version: 1,
      entries: [
        { relationNorm: "has_chair", cardinality: "multi_valued" },
        { relationNorm: "works_at", cardinality: "exclusive" },
      ],
    };
    const result = select(
      [
        assertion({ assertionId: "a-1", tailEntityId: TAIL_A }),
        assertion({
          assertionId: "a-2",
          tailEntityId: TAIL_B,
          supportIds: [SUPPORT_B],
        }),
      ],
      catalog
    );
    expect(result.alternatives).toEqual([]);
    expect(result.nonCandidates.map((entry) => entry.reason)).toEqual([
      "catalog_multi_valued",
    ]);
    // An exclusive relation is labelled but not excluded, so it still screens.
    const exclusive = select(
      [
        assertion({
          assertionId: "a-3",
          tailEntityId: TAIL_A,
          relationNorm: "works_at",
        }),
        assertion({
          assertionId: "a-4",
          tailEntityId: TAIL_B,
          relationNorm: "works_at",
          supportIds: [SUPPORT_B],
        }),
      ],
      catalog
    );
    expect(exclusive.alternatives).toHaveLength(1);
    expect(emptyRelationCatalog().entries).toEqual([]);
  });

  it("does not group across a different head or a different relation", () => {
    const result = select([
      assertion({ assertionId: "a-1", tailEntityId: TAIL_A }),
      assertion({
        assertionId: "a-2",
        tailEntityId: TAIL_B,
        headEntityId: "00000000-0000-4000-8000-0000000000a2",
        supportIds: [SUPPORT_B],
      }),
      assertion({
        assertionId: "a-3",
        tailEntityId: TAIL_C,
        relationNorm: "founded",
        supportIds: [SUPPORT_B],
      }),
    ]);
    // Each group holds a single distinct tail, so nothing becomes a candidate.
    expect(result.alternatives).toEqual([]);
    expect(result.nonCandidates).toHaveLength(3);
    expect(result.nonCandidates.every((entry) => entry.reason === "single_distinct_tail")).toBe(
      true
    );
  });
});

describe("null bounds preserve uncertainty", () => {
  it("records both null bounds as unknown and unbounded rather than a contradiction", () => {
    const uncertainty = uncertaintyOf([open(null, null)]);
    expect(uncertainty).toEqual({
      unboundedLower: true,
      unboundedUpper: true,
      reason: "null_validity_bounds",
    });
  });

  it("matches a null lower bound against a tail that starts late", () => {
    // A null lower bound means unknown/unbounded, so it overlaps a tail whose
    // interval starts well after any concrete start would have.
    expect(
      intervalsOverlap(
        open(null, "2030-01-01T00:00:00.000Z"),
        bounded("2028-06-01T00:00:00.000Z", "2029-01-01T00:00:00.000Z")
      )
    ).toBe(true);
    // The unknown lower bound extends backwards, never forwards: a known upper
    // bound that ends before the other interval starts is still disjoint.
    expect(
      intervalsOverlap(
        open(null, "2000-01-01T00:00:00.000Z"),
        bounded("2028-06-01T00:00:00.000Z", "2029-01-01T00:00:00.000Z")
      )
    ).toBe(false);
  });

  it("matches a null upper bound against a tail that ends early", () => {
    expect(
      intervalsOverlap(
        bounded("2000-01-01T00:00:00.000Z", null),
        bounded("2028-06-01T00:00:00.000Z", "2028-07-01T00:00:00.000Z")
      )
    ).toBe(true);
    // The unknown upper bound extends forwards only: a known lower bound that
    // starts after the other interval ends is still disjoint.
    expect(
      intervalsOverlap(
        bounded("2031-01-01T00:00:00.000Z", null),
        bounded("2028-06-01T00:00:00.000Z", "2028-07-01T00:00:00.000Z")
      )
    ).toBe(false);
  });

  it("never reads a null bound as zero, so an unbounded interval is not a point", () => {
    // If a null lower bound were zero, this interval would end before the other
    // began and would not overlap.
    expect(
      intervalsOverlap(
        open(null, "1999-01-01T00:00:00.000Z"),
        bounded("2020-01-01T00:00:00.000Z", "2021-01-01T00:00:00.000Z")
      )
    ).toBe(false);
    // And it is not treated as never-ending either: two unknown lower bounds
    // with disjoint concrete uppers still stop overlapping.
    expect(
      intervalsOverlap(
        open(null, "1999-01-01T00:00:00.000Z"),
        bounded("2020-01-01T00:00:00.000Z", "2021-01-01T00:00:00.000Z")
      )
    ).toBe(false);
  });

  it("produces a candidate whose retained uncertainty names the null bounds", () => {
    const result = select([
      assertion({
        assertionId: "a-1",
        tailEntityId: TAIL_A,
        interval: open(null, null),
      }),
      assertion({
        assertionId: "a-2",
        tailEntityId: TAIL_B,
        interval: open(null, null),
        supportIds: [SUPPORT_B],
      }),
    ]);
    expect(result.alternatives).toHaveLength(1);
    const [candidate] = toStructuralCandidates(result.alternatives[0]!, {
      checkId: "check-1",
      inputRevision: "input-revision-1",
      relationCatalogVersion: 0,
      publishedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(candidate!.uncertainty).toEqual({
      unboundedLower: true,
      unboundedUpper: true,
      reason: "null_validity_bounds",
    });
    expect(candidate!.tailEntityIds).toEqual([TAIL_A, TAIL_B]);
  });

  it("distinguishes a null lower bound from a null upper bound in the record", () => {
    expect(uncertaintyOf([open(null, "2030-01-01T00:00:00.000Z")])).toEqual({
      unboundedLower: true,
      unboundedUpper: false,
      reason: "null_lower_bound",
    });
    expect(uncertaintyOf([open("2000-01-01T00:00:00.000Z", null)])).toEqual({
      unboundedLower: false,
      unboundedUpper: true,
      reason: "null_upper_bound",
    });
    expect(
      uncertaintyOf([
        bounded("2000-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z"),
      ])
    ).toEqual({
      unboundedLower: false,
      unboundedUpper: false,
      reason: "bounded_intervals",
    });
  });

  it("overlaps two intervals whose unknown lower bounds precede every known end", () => {
    // Both lower bounds are unknown, so both intervals extend further back than
    // any known instant and they share that region. This is the direction a
    // screen must not resolve by inventing a bound: the alternative is recorded
    // with its uncertainty instead of being dropped.
    expect(
      intervalsOverlap(
        open(null, "2001-01-01T00:00:00.000Z"),
        open(null, "2002-01-01T00:00:00.000Z")
      )
    ).toBe(true);
    const result = select([
      assertion({
        assertionId: "a-1",
        tailEntityId: TAIL_A,
        interval: open(null, "2001-01-01T00:00:00.000Z"),
      }),
      assertion({
        assertionId: "a-2",
        tailEntityId: TAIL_B,
        interval: open(null, "2002-01-01T00:00:00.000Z"),
        supportIds: [SUPPORT_B],
      }),
    ]);
    expect(result.alternatives).toHaveLength(1);
    const [candidate] = toStructuralCandidates(result.alternatives[0]!, {
      checkId: "check-1",
      inputRevision: "input-revision-1",
      relationCatalogVersion: 0,
      publishedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(candidate!.uncertainty).toEqual({
      unboundedLower: true,
      unboundedUpper: false,
      reason: "null_lower_bound",
    });
  });

  it("reports adjacency only when the intervals actually touch", () => {
    expect(
      intervalsAdjacent(
        bounded("2020-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"),
        bounded("2025-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z")
      )
    ).toBe(true);
    expect(
      intervalsAdjacent(
        bounded("2020-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z"),
        bounded("2025-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z")
      )
    ).toBe(false);
    // An unknown bound cannot be shown to touch in its own direction, so an
    // unknown lower bound against a later start is neither overlap nor
    // adjacency.
    expect(
      intervalsAdjacent(
        open(null, "2000-01-01T00:00:00.000Z"),
        bounded("2025-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z")
      )
    ).toBe(false);
  });
});

describe("candidate identity binds the accepted evidence", () => {
  const binding = {
    checkId: "check-1",
    inputRevision: "input-revision-1",
    relationCatalogVersion: 0,
    publishedAt: "2026-01-01T00:00:00.000Z",
  };

  function candidateFor(overrides: Partial<ScreeningAssertion>) {
    const result = select([
      assertion({ assertionId: "a-1", tailEntityId: TAIL_A }),
      assertion({
        assertionId: "a-2",
        tailEntityId: TAIL_B,
        supportIds: [SUPPORT_B],
        ...overrides,
      }),
    ]);
    expect(result.alternatives).toHaveLength(1);
    return toStructuralCandidates(result.alternatives[0]!, binding)[0]!;
  }

  it("binds the accepted support ids and extraction revisions", () => {
    const candidate = candidateFor({});
    expect(candidate.supportIds).toEqual([SUPPORT_A, SUPPORT_B]);
    expect(candidate.supportRevisions).toEqual([
      `${SUPPORT_A}@extraction-1`,
      `${SUPPORT_B}@extraction-1`,
    ]);
    expect(candidate.extractionRevisions).toEqual([1]);
    expect(candidate.inputRevision).toBe("input-revision-1");
  });

  it("changes identity when a support's extraction input revision changes", () => {
    const base = candidateFor({});
    const moved = candidateFor({ extractionRef: "extraction-2" });
    expect(moved.candidateId).not.toBe(base.candidateId);
  });

  it("changes identity when the published extraction revision changes", () => {
    const base = candidateFor({});
    const moved = candidateFor({ extractionRevision: 2 });
    expect(moved.candidateId).not.toBe(base.candidateId);
  });

  it("changes identity when the input revision changes", () => {
    const base = candidateFor({});
    const moved = candidateFor({ inputRevision: "input-revision-2" });
    expect(moved.candidateId).not.toBe(base.candidateId);
  });

  it("changes identity when the relation catalog version changes", () => {
    const result = select([
      assertion({ assertionId: "a-1", tailEntityId: TAIL_A }),
      assertion({
        assertionId: "a-2",
        tailEntityId: TAIL_B,
        supportIds: [SUPPORT_B],
      }),
    ]);
    const atVersionZero = toStructuralCandidates(result.alternatives[0]!, binding)[0]!;
    const atVersionOne = toStructuralCandidates(result.alternatives[0]!, {
      ...binding,
      relationCatalogVersion: 1,
    })[0]!;
    expect(atVersionOne.candidateId).not.toBe(atVersionZero.candidateId);
  });

  it("is stable across repeated screening of the same inputs", () => {
    const first = candidateFor({});
    const second = candidateFor({});
    expect(second.candidateId).toBe(first.candidateId);
    expect(candidateIdsOf(select([
      assertion({ assertionId: "a-1", tailEntityId: TAIL_A }),
      assertion({
        assertionId: "a-2",
        tailEntityId: TAIL_B,
        supportIds: [SUPPORT_B],
      }),
    ]))).toEqual(candidateIdsOf(select([
      assertion({ assertionId: "a-1", tailEntityId: TAIL_A }),
      assertion({
        assertionId: "a-2",
        tailEntityId: TAIL_B,
        supportIds: [SUPPORT_B],
      }),
    ])));
  });
});

describe("candidates remain alternatives, never truth", () => {
  const result = select([
    assertion({ assertionId: "a-1", tailEntityId: TAIL_A }),
    assertion({
      assertionId: "a-2",
      tailEntityId: TAIL_B,
      supportIds: [SUPPORT_B],
    }),
    assertion({
      assertionId: "a-3",
      tailEntityId: TAIL_C,
      supportIds: [SUPPORT_B],
    }),
  ]);

  it("carries no field a caller could read as a semantic verdict", () => {
    const [candidate] = toStructuralCandidates(result.alternatives[0]!, {
      checkId: "check-1",
      inputRevision: "input-revision-1",
      relationCatalogVersion: 0,
      publishedAt: "2026-01-01T00:00:00.000Z",
    });
    const keys = Object.keys(candidate!).sort();
    expect(keys).toEqual([
      "assertionIds",
      "assertionInputRevisions",
      "candidateId",
      "checkId",
      "coverage",
      "extractionRevisions",
      "headEntityId",
      "inputRevision",
      "publishedAt",
      "relationCatalogVersion",
      "relationNorm",
      "rulesetRevision",
      "supportIds",
      "supportRevisions",
      "tailEntityIds",
      "uncertainty",
    ]);
    // No truth flag, no winner, no confidence, no score, no rank.
    for (const key of keys) {
      expect(key).not.toMatch(/truth|winner|score|confidence|rank|verdict|valid|correct|ranked|preferred|best/i);
    }
    expect(candidate!.uncertainty).toEqual({
      unboundedLower: false,
      unboundedUpper: false,
      reason: "bounded_intervals",
    });
    expect(Object.keys(candidate!.uncertainty).sort()).toEqual([
      "reason",
      "unboundedLower",
      "unboundedUpper",
    ]);
  });

  it("keeps every tail and never collapses them to a single winner", () => {
    const [candidate] = toStructuralCandidates(result.alternatives[0]!, {
      checkId: "check-1",
      inputRevision: "input-revision-1",
      relationCatalogVersion: 0,
      publishedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(candidate!.tailEntityIds).toEqual([TAIL_A, TAIL_B, TAIL_C]);
    expect(candidate!.assertionIds).toEqual(["a-1", "a-2", "a-3"]);
    expect(candidate!.supportIds).toEqual([SUPPORT_A, SUPPORT_B]);
  });

  it("is frozen, so a reader cannot promote one alternative in place", () => {
    const [candidate] = toStructuralCandidates(result.alternatives[0]!, {
      checkId: "check-1",
      inputRevision: "input-revision-1",
      relationCatalogVersion: 0,
      publishedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(Object.isFrozen(candidate!)).toBe(true);
    expect(Object.isFrozen(candidate!.tailEntityIds)).toBe(true);
    expect(() => {
      (candidate as { winner?: unknown }).winner = TAIL_A;
    }).toThrow();
  });

  it("yields the same alternatives when the same input is screened again", () => {
    const again = select([
      assertion({ assertionId: "a-1", tailEntityId: TAIL_A }),
      assertion({
        assertionId: "a-2",
        tailEntityId: TAIL_B,
        supportIds: [SUPPORT_B],
      }),
      assertion({
        assertionId: "a-3",
        tailEntityId: TAIL_C,
        supportIds: [SUPPORT_B],
      }),
    ]);
    expect(candidateIdsOf(again)).toEqual(candidateIdsOf(result));
    expect(candidateIdsOf(again)).toHaveLength(1);
  });

  it("publishes structural coverage, never semantic or extraction completeness", () => {
    const [candidate] = toStructuralCandidates(result.alternatives[0]!, {
      checkId: "check-1",
      inputRevision: "input-revision-1",
      relationCatalogVersion: 0,
      publishedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(candidate!.coverage).toBe("structural_candidates_only");
  });
});

describe("screening fences refuse a stale, expired or moved attempt", () => {
  const now = new Date("2026-01-01T00:10:00.000Z");
  const dependencies = [
    {
      sourceRef: "source-a",
      generation: 4,
      extractionRevision: 2,
      relationBuckets: ["has_chair"],
    },
  ];

  function guardFor(
    overrides: Partial<MaintenanceAttemptGuard> = {}
  ): MaintenanceAttemptGuard {
    return {
      jobKey: "job-1",
      attemptNumber: 1,
      fencingToken: "token-1",
      workKind: "conflict_check",
      sourceRef: "source-a",
      sourceVersion: "v1",
      sourceGeneration: 4,
      inputRevision: canonicalDependencyRevision(dependencies),
      configRevision: "extractor-v1",
      leaseExpiresAt: "2026-01-01T00:20:00.000Z",
      attemptStartedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  function facts(overrides: {
    readonly guard?: Partial<MaintenanceAttemptGuard>;
    readonly liveDependencies?: typeof dependencies;
    readonly configRevision?: string;
    readonly now?: Date;
  } = {}) {
    const guard = guardFor(overrides.guard);
    return {
      actualGuard: guard,
      presentedToken: guard.fencingToken,
      jobStatus: "running",
      attemptFinished: false,
      liveInputs: {
        configRevision: overrides.configRevision ?? guard.configRevision,
        dependencies: overrides.liveDependencies ?? dependencies,
      },
      now: overrides.now ?? now,
    };
  }

  it("accepts a live attempt whose inputs still match", () => {
    expect(screenFenceVerdict(facts())).toEqual({ ok: true });
  });

  it("refuses a stale fencing token", () => {
    // The worker's presented token no longer matches the ledger's row, which is
    // the state a reclaim leaves behind.
    const live = facts();
    expect(screenFenceVerdict({ ...live, presentedToken: "token-stolen" })).toEqual(
      { ok: false, code: "lease_lost" }
    );
  });

  it("refuses an expired lease", () => {
    expect(
      screenFenceVerdict(
        facts({ now: new Date("2026-01-01T00:25:00.000Z") })
      )
    ).toEqual({ ok: false, code: "lease_lost" });
  });

  it("refuses an attempt that outlived its absolute deadline", () => {
    expect(
      screenFenceVerdict(
        facts({ now: new Date("2026-01-01T00:31:00.000Z") })
      )
    ).toEqual({ ok: false, code: "execution_timeout" });
  });

  it("refuses a dependency whose generation moved", () => {
    expect(
      screenFenceVerdict(
        facts({
          liveDependencies: [
            { ...dependencies[0]!, generation: 5 },
          ],
        })
      ).ok
    ).toBe(false);
    expect(
      screenFenceVerdict(
        facts({
          liveDependencies: [{ ...dependencies[0]!, generation: 5 }],
        })
      )
    ).toEqual({ ok: false, code: "input_stale" });
  });

  it("refuses a dependency whose extraction revision moved", () => {
    expect(
      screenFenceVerdict(
        facts({
          liveDependencies: [{ ...dependencies[0]!, extractionRevision: 3 }],
        })
      )
    ).toEqual({ ok: false, code: "input_stale" });
  });

  it("refuses a dependency whose relation bucket set changed", () => {
    expect(
      screenFenceVerdict(
        facts({
          liveDependencies: [
            { ...dependencies[0]!, relationBuckets: ["has_chair", "founded"] },
          ],
        })
      )
    ).toEqual({ ok: false, code: "input_stale" });
  });

  it("refuses a moved config or ruleset revision", () => {
    expect(
      screenFenceVerdict(facts({ configRevision: "extractor-v2" }))
    ).toEqual({ ok: false, code: "input_stale" });
  });

  it("accepts only a conflict-check attempt", () => {
    expect(isConflictCheckGuard(guardFor())).toBe(true);
    expect(
      isConflictCheckGuard(guardFor({ workKind: "extract_publish" }))
    ).toBe(false);
    expect(
      isConflictCheckGuard(guardFor({ workKind: "projection_rebuild" }))
    ).toBe(false);
  });
});