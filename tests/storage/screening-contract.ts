/**
 * The screening parity contract both lanes run.
 *
 * The port is deliberately thin: it exposes the lane's real screening storage and
 * work ledger, and maps only fixture construction into backend calls. Every
 * expectation below is derived from the inherited specification's structural
 * rules, never from a backend's observed output, and no candidate id is copied
 * from a run.
 */
import { describe, expect, it } from "vitest";

import type { MaintenanceAttemptGuard } from "../../src/core/maintenance/types.js";
import type {
  ScreeningAssertion,
  StructuralScreenOutcome,
} from "../../src/core/maintenance/screening-types.js";
import {
  SCREENING_COVERAGE,
  SCREENING_RULESET_REVISION,
} from "../../src/core/maintenance/screening-types.js";
import type { AuthorizedScopeContext } from "../../src/core/storage/structured-scope-types.js";

/** What each lane supplies so one contract drives either backend. */
export interface ScreeningTestPort {
  readonly label: string;
  /** The lane's real screening storage under its real shared authority. */
  stageScreen(input: {
    readonly context: AuthorizedScopeContext;
    readonly guard: MaintenanceAttemptGuard;
    readonly relationBuckets: readonly string[];
    readonly relationCatalogVersion: number;
    readonly relationCatalogEntries: readonly {
      readonly relationNorm: string;
      readonly cardinality: "multi_valued" | "exclusive";
    }[];
    readonly maxAssertions?: number;
  }): Promise<StructuralScreenOutcome>;
  /** Mint the trusted authorized context and a live conflict-check attempt. */
  startAttempt(
    label: string,
    options?: {
      readonly relationBuckets?: readonly string[];
      readonly advanceMs?: number;
    }
  ): Promise<{
    readonly context: AuthorizedScopeContext;
    readonly guard: MaintenanceAttemptGuard;
    readonly scopeBinding: string;
    readonly sources: readonly string[];
  }>;
  /** The accepted assertions the lane's authoritative stores actually hold. */
  acceptedAssertions(label: string): readonly ScreeningAssertion[];
  /** Present a guard whose fencing token the ledger no longer recognizes. */
  staleTokenGuard(): MaintenanceAttemptGuard;
  /** Settle or expire the current attempt so its lease no longer holds. */
  expireLease(): void;
  /** Age the attempt past its absolute bound while its lease still holds. */
  outliveAbsoluteDeadline(): void;
  /** Move a dependency's live generation after the attempt was scheduled. */
  moveDependency(): Promise<void> | void;
  /** Re-declare the initiating source under a new config/ruleset revision. */
  moveConfigRevision(): Promise<void> | void;
  /** Move the dependent source's published extraction revision only. */
  moveDependentExtraction(): Promise<void> | void;
  /** Present a guard for an attempt kind that never checked a relation. */
  wrongWorkKindGuard(): MaintenanceAttemptGuard;
  readCandidates(
    scopeBinding: string
  ): Promise<
    readonly {
      readonly candidateId: string;
      readonly tailEntityIds: readonly string[];
      readonly uncertaintyReason: string;
      readonly unboundedLower: boolean;
      readonly unboundedUpper: boolean;
      readonly supportIds: readonly string[];
      readonly assertionIds: readonly string[];
    }[]
  >;
  readCheckCount(scopeBinding: string): Promise<number>;

}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sortedCopy(values: readonly string[]): string[] {
  return [...values].sort(compareText);
}

export function describeScreeningContract(
  openPort: () => Promise<ScreeningTestPort>
): void {
  describe("structural screening S1 parity contract", () => {
    it("SC-01 unclassified relation under the empty initial catalog publishes an alternative rather than refusing", async () => {
      const port = await openPort();
      const attempt = await port.startAttempt("sc01");
      const outcome = await port.stageScreen({
        context: attempt.context,
        guard: attempt.guard,
        relationBuckets: ["has_chair"],
        relationCatalogVersion: 0,
        relationCatalogEntries: [],
      });
      expect(outcome.nonCandidates).toEqual([]);
      expect(outcome.candidates).toHaveLength(1);
      expect(outcome.check.rulesetRevision).toBe(SCREENING_RULESET_REVISION);
      expect(outcome.check.coverage).toBe(SCREENING_COVERAGE);
      // Re-screening the same inputs reproduces the same alternative; nothing
      // about the second screen promotes one tail.
      const again = await port.stageScreen({
        context: attempt.context,
        guard: attempt.guard,
        relationBuckets: ["has_chair"],
        relationCatalogVersion: 0,
        relationCatalogEntries: [],
      });
      expect(again.candidates.map((entry) => entry.candidateId)).toEqual(
        outcome.candidates.map((entry) => entry.candidateId)
      );
      expect(await port.readCandidates(attempt.scopeBinding)).toHaveLength(1);
    });

    it("SC-02 null validity bounds are retained as uncertainty on the published alternative", async () => {
      const port = await openPort();
      const attempt = await port.startAttempt("sc02");
      const outcome = await port.stageScreen({
        context: attempt.context,
        guard: attempt.guard,
        relationBuckets: ["has_chair"],
        relationCatalogVersion: 0,
        relationCatalogEntries: [],
      });
      expect(outcome.candidates).toHaveLength(1);
      expect(outcome.candidates[0]!.uncertainty).toEqual({
        unboundedLower: true,
        unboundedUpper: true,
        reason: "null_validity_bounds",
      });
      const [persisted] = await port.readCandidates(attempt.scopeBinding);
      expect(persisted!.uncertaintyReason).toBe("null_validity_bounds");
      expect(persisted!.unboundedLower).toBe(true);
      expect(persisted!.unboundedUpper).toBe(true);
    });

    it("SC-03 same head and relation with two distinct tails yields one group with two assertions", async () => {
      const port = await openPort();
      const attempt = await port.startAttempt("sc03");
      const outcome = await port.stageScreen({
        context: attempt.context,
        guard: attempt.guard,
        relationBuckets: ["has_chair"],
        relationCatalogVersion: 0,
        relationCatalogEntries: [],
      });
      expect(outcome.candidates).toHaveLength(1);
      expect(outcome.candidates[0]!.tailEntityIds).toHaveLength(2);
      expect(outcome.candidates[0]!.assertionIds).toHaveLength(2);
      expect(outcome.check.assertionCount).toBe(
        port.acceptedAssertions("sc03").length
      );
    });

    it("SC-04 an exact same head/relation/tail/interval with several supports is not a candidate", async () => {
      const port = await openPort();
      const attempt = await port.startAttempt("sc04");
      const outcome = await port.stageScreen({
        context: attempt.context,
        guard: attempt.guard,
        relationBuckets: ["has_chair"],
        relationCatalogVersion: 0,
        relationCatalogEntries: [],
      });
      expect(outcome.candidates).toEqual([]);
      expect(outcome.nonCandidates.map((entry) => entry.reason)).toEqual([
        "identical_assertion",
      ]);
      // Two supports of the same exact tuple are ONE assertion, so the record
      // names that single identity while both supports stay on the evidence.
      expect(outcome.nonCandidates[0]!.assertionIds).toHaveLength(1);
      expect(
        new Set(
          port.acceptedAssertions("sc04").flatMap((entry) => entry.supportIds)
        ).size
      ).toBe(2);
      expect(await port.readCandidates(attempt.scopeBinding)).toHaveLength(0);
    });

    it("SC-05 an exact duplicate is one assertion and never two", async () => {
      const port = await openPort();
      const attempt = await port.startAttempt("sc05");
      const outcome = await port.stageScreen({
        context: attempt.context,
        guard: attempt.guard,
        relationBuckets: ["has_chair"],
        relationCatalogVersion: 0,
        relationCatalogEntries: [],
      });
      expect(outcome.candidates).toEqual([]);
      expect(outcome.nonCandidates.map((entry) => entry.reason)).toEqual([
        "identical_assertion",
      ]);
      expect(outcome.check.assertionCount).toBe(2);
    });

    it("SC-06 adjacent and disjoint intervals produce no candidate while overlap does", async () => {
      const port = await openPort();
      const adjacent = await port.startAttempt("sc06-adjacent");
      const adjacentOutcome = await port.stageScreen({
        context: adjacent.context,
        guard: adjacent.guard,
        relationBuckets: ["has_chair"],
        relationCatalogVersion: 0,
        relationCatalogEntries: [],
      });
      expect(adjacentOutcome.candidates).toEqual([]);
      expect(adjacentOutcome.nonCandidates.map((entry) => entry.reason)).toEqual([
        "adjacent_intervals",
      ]);

      const disjoint = await port.startAttempt("sc06-disjoint");
      const disjointOutcome = await port.stageScreen({
        context: disjoint.context,
        guard: disjoint.guard,
        relationBuckets: ["has_chair"],
        relationCatalogVersion: 0,
        relationCatalogEntries: [],
      });
      expect(disjointOutcome.candidates).toEqual([]);
      expect(disjointOutcome.nonCandidates.map((entry) => entry.reason)).toEqual([
        "disjoint_intervals",
      ]);

      const overlapping = await port.startAttempt("sc06-overlapping");
      const overlappingOutcome = await port.stageScreen({
        context: overlapping.context,
        guard: overlapping.guard,
        relationBuckets: ["has_chair"],
        relationCatalogVersion: 0,
        relationCatalogEntries: [],
      });
      expect(overlappingOutcome.candidates).toHaveLength(1);
    });

    it("SC-07 a versioned multi-valued label excludes the group without touching the empty initial catalog", async () => {
      const port = await openPort();
      const attempt = await port.startAttempt("sc07");
      const unclassified = await port.stageScreen({
        context: attempt.context,
        guard: attempt.guard,
        relationBuckets: ["has_chair"],
        relationCatalogVersion: 0,
        relationCatalogEntries: [],
      });
      expect(unclassified.candidates).toHaveLength(1);

      const labelled = await port.stageScreen({
        context: attempt.context,
        guard: attempt.guard,
        relationBuckets: ["has_chair"],
        relationCatalogVersion: 1,
        relationCatalogEntries: [
          { relationNorm: "has_chair", cardinality: "multi_valued" },
        ],
      });
      expect(labelled.candidates).toEqual([]);
      expect(labelled.nonCandidates.map((entry) => entry.reason)).toEqual([
        "catalog_multi_valued",
      ]);
    });

    it("SC-08 candidate identity binds the accepted support, the extraction and input revisions, and the ruleset", async () => {
      const port = await openPort();
      const attempt = await port.startAttempt("sc08");
      const outcome = await port.stageScreen({
        context: attempt.context,
        guard: attempt.guard,
        relationBuckets: ["has_chair"],
        relationCatalogVersion: 0,
        relationCatalogEntries: [],
      });
      const candidate = outcome.candidates[0]!;
      expect(candidate.supportIds.length).toBeGreaterThanOrEqual(1);
      // The persisted candidate binds real accepted support rows, and it binds
      // every support the contributing assertions were read at. The fixture's
      // support ids are lane-minted, so only the count and the persisted row
      // are asserted here; the identity binding itself is covered by the
      // selection lane, where the inputs are exact.
      const persisted = await port.readCandidates(attempt.scopeBinding);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.supportIds).toEqual(candidate.supportIds);
      expect(port.acceptedAssertions("sc08").length).toBe(2);
      expect(candidate.assertionIds).toEqual(sortedCopy(candidate.assertionIds));
      expect(candidate.rulesetRevision).toBe(SCREENING_RULESET_REVISION);
      expect(outcome.check.inputRevision).toBe(attempt.guard.inputRevision);

      // Every bound input moves the identity, so a changed screen is a new
      // candidate rather than an update to the old one.
      const atCatalogOne = await port.stageScreen({
        context: attempt.context,
        guard: attempt.guard,
        relationBuckets: ["has_chair"],
        relationCatalogVersion: 1,
        relationCatalogEntries: [
          { relationNorm: "founded", cardinality: "exclusive" },
        ],
      });
      expect(atCatalogOne.candidates[0]!.candidateId).not.toBe(
        candidate.candidateId
      );
    });

    it("SC-09 a dependency update and an A-to-B-to-A round trip invalidate the bound readiness", async () => {
      const port = await openPort();
      const attempt = await port.startAttempt("sc09");
      const before = await port.stageScreen({
        context: attempt.context,
        guard: attempt.guard,
        relationBuckets: ["has_chair"],
        relationCatalogVersion: 0,
        relationCatalogEntries: [],
      });
      expect(before.candidates).toHaveLength(1);
      const publishedBefore = await port.readCheckCount(attempt.scopeBinding);
      expect(publishedBefore).toBe(1);

      port.moveDependency();
      await expect(
        port.stageScreen({
          context: attempt.context,
          guard: attempt.guard,
          relationBuckets: ["has_chair"],
          relationCatalogVersion: 0,
          relationCatalogEntries: [],
        })
      ).rejects.toMatchObject({ code: "input_stale" });
      expect(await port.readCheckCount(attempt.scopeBinding)).toBe(publishedBefore);

      // A-to-B-to-A moves the generation again, so returning to the original
      // content does not restore the old readiness.
      port.moveDependency();
      await expect(
        port.stageScreen({
          context: attempt.context,
          guard: attempt.guard,
          relationBuckets: ["has_chair"],
          relationCatalogVersion: 0,
          relationCatalogEntries: [],
        })
      ).rejects.toMatchObject({ code: "input_stale" });
      expect(await port.readCheckCount(attempt.scopeBinding)).toBe(publishedBefore);
    });

    it("a dependent source's extraction revision moving invalidates readiness while the initiating source does not move", async () => {
      const port = await openPort();
      const attempt = await port.startAttempt("sc09-dependent");
      const before = await port.stageScreen({
        context: attempt.context,
        guard: attempt.guard,
        relationBuckets: ["has_chair"],
        relationCatalogVersion: 0,
        relationCatalogEntries: [],
      });
      expect(before.candidates).toHaveLength(1);
      const checks = await port.readCheckCount(attempt.scopeBinding);

      // Only the DEPENDENT source moves: its own generation, its initiation
      // vector and the initiating source are all untouched. Only the complete
      // dependency-vector comparison can catch this.
      await port.moveDependentExtraction();
      await expect(
        port.stageScreen({
          context: attempt.context,
          guard: attempt.guard,
          relationBuckets: ["has_chair"],
          relationCatalogVersion: 0,
          relationCatalogEntries: [],
        })
      ).rejects.toMatchObject({ code: "input_stale" });
      expect(await port.readCheckCount(attempt.scopeBinding)).toBe(checks);
      expect(await port.readCandidates(attempt.scopeBinding)).toHaveLength(1);
    });

    it("SC-10 a stale token, an expired lease, a moved dependency and an exhausted resource limit all publish nothing", async () => {
      const port = await openPort();

      const stale = await port.startAttempt("sc10-stale");
      await expect(
        port.stageScreen({
          context: stale.context,
          guard: port.staleTokenGuard(),
          relationBuckets: ["has_chair"],
          relationCatalogVersion: 0,
          relationCatalogEntries: [],
        })
      ).rejects.toMatchObject({ code: "lease_lost" });
      expect(await port.readCandidates(stale.scopeBinding)).toHaveLength(0);
      expect(await port.readCheckCount(stale.scopeBinding)).toBe(0);

      const expired = await port.startAttempt("sc10-expired");
      port.expireLease();
      await expect(
        port.stageScreen({
          context: expired.context,
          guard: expired.guard,
          relationBuckets: ["has_chair"],
          relationCatalogVersion: 0,
          relationCatalogEntries: [],
        })
      ).rejects.toMatchObject({ code: "lease_lost" });
      expect(await port.readCandidates(expired.scopeBinding)).toHaveLength(0);
      expect(await port.readCheckCount(expired.scopeBinding)).toBe(0);

      const movedConfig = await port.startAttempt("sc10-config");
      await port.moveConfigRevision();
      await expect(
        port.stageScreen({
          context: movedConfig.context,
          guard: movedConfig.guard,
          relationBuckets: ["has_chair"],
          relationCatalogVersion: 0,
          relationCatalogEntries: [],
        })
      ).rejects.toMatchObject({ code: "input_stale" });
      expect(await port.readCandidates(movedConfig.scopeBinding)).toHaveLength(0);
      expect(await port.readCheckCount(movedConfig.scopeBinding)).toBe(0);

      const overrun = await port.startAttempt("sc10-deadline");
      port.outliveAbsoluteDeadline();
      await expect(
        port.stageScreen({
          context: overrun.context,
          guard: overrun.guard,
          relationBuckets: ["has_chair"],
          relationCatalogVersion: 0,
          relationCatalogEntries: [],
        })
      ).rejects.toMatchObject({ code: "execution_timeout" });
      expect(await port.readCandidates(overrun.scopeBinding)).toHaveLength(0);
      expect(await port.readCheckCount(overrun.scopeBinding)).toBe(0);

      const exhausted = await port.startAttempt("sc10-resource");
      await expect(
        port.stageScreen({
          context: exhausted.context,
          guard: exhausted.guard,
          relationBuckets: ["has_chair"],
          relationCatalogVersion: 0,
          relationCatalogEntries: [],
          maxAssertions: 1,
        })
      ).rejects.toMatchObject({ code: "resource_exhausted" });
      expect(await port.readCandidates(exhausted.scopeBinding)).toHaveLength(0);
      expect(await port.readCheckCount(exhausted.scopeBinding)).toBe(0);
    });

    it("refuses to publish under an attempt that never checked a relation bucket", async () => {
      const port = await openPort();
      const attempt = await port.startAttempt("sc-kind");
      await expect(
        port.stageScreen({
          context: attempt.context,
          guard: port.wrongWorkKindGuard(),
          relationBuckets: ["has_chair"],
          relationCatalogVersion: 0,
          relationCatalogEntries: [],
        })
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(await port.readCheckCount(attempt.scopeBinding)).toBe(0);
    });

    it("publishes candidates that remain alternatives with no verdict field", async () => {
      const port = await openPort();
      const attempt = await port.startAttempt("sc-alternatives");
      const outcome = await port.stageScreen({
        context: attempt.context,
        guard: attempt.guard,
        relationBuckets: ["has_chair"],
        relationCatalogVersion: 0,
        relationCatalogEntries: [],
      });
      const candidate = outcome.candidates[0]!;
      for (const key of Object.keys(candidate)) {
        expect(key).not.toMatch(
          /truth|winner|score|confidence|rank|verdict|correct|preferred|best|accepted|rejected|resolved/i
        );
      }
      expect(candidate.tailEntityIds.length).toBeGreaterThanOrEqual(2);
      const [persisted] = await port.readCandidates(attempt.scopeBinding);
      expect(persisted!.tailEntityIds).toEqual(candidate.tailEntityIds);
    });
  });
}