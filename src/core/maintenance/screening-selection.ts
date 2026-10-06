/**
 * The pure structural screen: which accepted assertions become potential
 * alternatives, and which fact is screened as a non-candidate.
 *
 * Nothing here reads a store, mints a timestamp or mutates authority, so the
 * same inputs always yield the same alternatives. That determinism is what makes
 * a candidate id an identity rather than an observation: re-screening the same
 * inputs reproduces the same set of candidates and promotes nothing.
 */
import { createHash } from "node:crypto";

import {
  canonicalDependencyRevision,
  verifyAttemptGuard,
  verifyAttemptOwnership,
} from "./durable-work.js";
import type {
  MaintenanceAttemptGuard,
  MaintenanceGuardVerdict,
} from "./types.js";
import {
  SCREENING_COVERAGE,
  SCREENING_RULESET_REVISION,
  type CandidateUncertainty,
  type RelationCatalog,
  type ScreeningAssertion,
  type ScreeningLiveFacts,
  type ScreeningNonCandidate,
  type ScreeningNonCandidateReason,
  type ScreeningUncertaintyReason,
  type StructuralCandidate,
  type ValidInterval,
} from "./screening-types.js";

/** One grouped and normalized assertion, after duplicate coalescing. */
interface CoalescedAssertion {
  readonly assertionId: string;
  readonly headEntityId: string;
  readonly relationNorm: string;
  readonly tailEntityId: string;
  readonly interval: ValidInterval;
  /** Every exact-duplicate row that collapsed into this one assertion. */
  readonly assertionIds: readonly string[];
  readonly supportIds: readonly string[];
  readonly supportRevisions: readonly string[];
  readonly extractionRevisions: readonly number[];
  readonly inputRevisions: readonly string[];
}

function groupKeyOf(assertion: ScreeningAssertion): string {
  // Exact canonical head plus normalized relation: the only grouping the
  // specification allows. A fuzzy or case-folded head match is not implemented
  // because it is not specified.
  return `${assertion.headEntityId}|${assertion.relationNorm}`;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function intervalKeyOf(interval: ValidInterval): string {
  // A null bound is written as a distinct token rather than as a sentinel
  // number, so "unknown lower" and "lower equal to 1970-01-01" can never
  // collapse into one interval.
  return `${interval.lower ?? "|unknown-lower"}|${interval.upper ?? "|unknown-upper"}`;
}

function assertionKeyOf(assertion: ScreeningAssertion): string {
  return `${assertion.tailEntityId}|${intervalKeyOf(assertion.interval)}`;
}

/**
 * Collapse rows that name the exact same head, relation, tail and interval.
 *
 * An exact duplicate is one assertion with several supports — or several
 * origins — and never a conflict. Merging keeps every contributing row's
 * assertion id, support and revision, so the candidate still binds all of the
 * evidence; only the row count collapses.
 */
function coalesceGroup(
  group: readonly ScreeningAssertion[]
): { readonly assertions: readonly CoalescedAssertion[]; readonly merged: number } {
  const byTuple = new Map<string, CoalescedAssertion>();
  let merged = 0;
  for (const assertion of group) {
    const key = assertionKeyOf(assertion);
    const existing = byTuple.get(key);
    if (existing === undefined) {
      byTuple.set(key, {
        assertionId: assertion.assertionId,
        headEntityId: assertion.headEntityId,
        relationNorm: assertion.relationNorm,
        tailEntityId: assertion.tailEntityId,
        interval: assertion.interval,
        assertionIds: [assertion.assertionId],
        supportIds: [...assertion.supportIds],
        supportRevisions: [
          `${assertion.supportIds.join("+")}@${assertion.extractionRef}`,
        ],
        extractionRevisions: [assertion.extractionRevision],
        inputRevisions: [assertion.inputRevision],
      });
      continue;
    }
    merged += 1;
    byTuple.set(key, {
      ...existing,
      assertionIds: [...existing.assertionIds, assertion.assertionId],
      supportIds: [...existing.supportIds, ...assertion.supportIds],
      supportRevisions: [
        ...existing.supportRevisions,
        `${assertion.supportIds.join("+")}@${assertion.extractionRef}`,
      ],
      extractionRevisions: [
        ...existing.extractionRevisions,
        assertion.extractionRevision,
      ],
      inputRevisions: [...existing.inputRevisions, assertion.inputRevision],
    });
  }
  return {
    assertions: [...byTuple.values()].sort((left, right) =>
      compareText(left.assertionId, right.assertionId)
    ),
    merged,
  };
}

/**
 * Whether two half-open intervals overlap, treating a null bound as unknown and
 * unbounded in that direction.
 *
 * A null bound never compares as zero and never becomes an infinite value: a
 * pair is disjoint only when BOTH sides of the gap are known, which is what
 * keeps "starts late" matching an unknown lower bound and "ends early" matching
 * an unknown upper bound. Intervals that merely touch are disjoint, because the
 * upper bound is excluded.
 */
export function intervalsOverlap(
  left: ValidInterval,
  right: ValidInterval
): boolean {
  const leftEndsBeforeRightStarts =
    left.upper !== null && right.lower !== null && left.upper <= right.lower;
  const rightEndsBeforeLeftStarts =
    right.upper !== null && left.lower !== null && right.upper <= left.lower;
  return !(leftEndsBeforeRightStarts || rightEndsBeforeLeftStarts);
}

/** Whether two intervals only touch at one endpoint, the adjacency case. */
export function intervalsAdjacent(
  left: ValidInterval,
  right: ValidInterval
): boolean {
  if (intervalsOverlap(left, right)) return false;
  const touching =
    (left.upper !== null && left.upper === right.lower) ||
    (right.upper !== null && right.upper === left.lower);
  return touching;
}

/** The closed uncertainty record for a contributing set of intervals. */
export function uncertaintyOf(
  intervals: readonly ValidInterval[]
): CandidateUncertainty {
  const unboundedLower = intervals.some((entry) => entry.lower === null);
  const unboundedUpper = intervals.some((entry) => entry.upper === null);
  const reason: ScreeningUncertaintyReason = unboundedLower
    ? unboundedUpper
      ? "null_validity_bounds"
      : "null_lower_bound"
    : unboundedUpper
      ? "null_upper_bound"
      : "bounded_intervals";
  return { unboundedLower, unboundedUpper, reason };
}

function candidateIdOf(input: {
  readonly assertionIds: readonly string[];
  readonly supportRevisions: readonly string[];
  readonly extractionRevisions: readonly number[];
  readonly assertionInputRevisions: readonly string[];
  readonly inputRevision: string;
  readonly uncertaintyReason: string;
  readonly catalogVersion: number;
}): string {
  // Identity binds the sorted assertion identities, the accepted support and
  // extraction/input revisions, the ruleset revision and the uncertainty
  // reason, so a different bound input is a different candidate rather than an
  // update to this one.
  return digest([
    input.assertionIds.join(","),
    input.supportRevisions.join(","),
    [...input.extractionRevisions].sort((left, right) => left - right).join(","),
    input.assertionInputRevisions.join(","),
    input.inputRevision,
    input.uncertaintyReason,
    SCREENING_RULESET_REVISION,
    `catalog:${input.catalogVersion}`,
  ]);
}

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
}

/**
 * Every pair of assertions with distinct tails that `predicate` accepts.
 *
 * Both members of an accepted pair are returned, and a pair is found in one
 * direction only so an ordered scan cannot miss the pair that happens to sit at
 * the end of the array. Taking the union of the pairs is what keeps a three-way
 * alternative whole: the middle assertion is a contributor whether its overlap
 * partner sorts before or after it.
 */
function distinctTailPairs(
  assertions: readonly CoalescedAssertion[],
  predicate: (left: ValidInterval, right: ValidInterval) => boolean
): ReadonlyArray<readonly [CoalescedAssertion, CoalescedAssertion]> {
  const pairs: Array<readonly [CoalescedAssertion, CoalescedAssertion]> = [];
  for (let left = 0; left < assertions.length; left += 1) {
    for (let right = left + 1; right < assertions.length; right += 1) {
      const first = assertions[left]!;
      const second = assertions[right]!;
      if (first.tailEntityId === second.tailEntityId) continue;
      if (!predicate(first.interval, second.interval)) continue;
      pairs.push([first, second]);
    }
  }
  return pairs;
}

/** One alternative the screen found. */
export interface SelectedAlternative {
  readonly headEntityId: string;
  readonly relationNorm: string;
  /** The two or more coalesced assertions whose intervals overlap. */
  readonly assertions: readonly CoalescedAssertion[];
}

export interface SelectionResult {
  readonly alternatives: readonly SelectedAlternative[];
  readonly nonCandidates: readonly ScreeningNonCandidate[];
}

/**
 * The complete screening rule.
 *
 * A candidate needs exactly three things at once: one exact canonical head and
 * normalized relation, two or more distinct tails, and at least one pair of
 * those tails whose half-open intervals overlap. Every other shape is recorded
 * as a structural non-candidate with its reason, so a reader can tell "screened
 * and produced nothing" from "never looked at".
 */
export function selectStructuralAlternatives(
  assertions: readonly ScreeningAssertion[],
  catalog: RelationCatalog
): SelectionResult {
  const multiValued = new Set(
    catalog.entries
      .filter((entry) => entry.cardinality === "multi_valued")
      .map((entry) => entry.relationNorm)
  );
  const groups = new Map<string, ScreeningAssertion[]>();
  for (const assertion of assertions) {
    const key = groupKeyOf(assertion);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [assertion]);
    else bucket.push(assertion);
  }

  const alternatives: SelectedAlternative[] = [];
  const nonCandidates: ScreeningNonCandidate[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key) ?? [];
    const head = group[0];
    if (head === undefined) continue;
    const relation = head.relationNorm;
    const screenedIds = sortedUnique(group.map((entry) => entry.assertionId));
    if (multiValued.has(relation)) {
      nonCandidates.push({
        headEntityId: head.headEntityId,
        relationNorm: relation,
        reason: "catalog_multi_valued",
        assertionIds: screenedIds,
      });
      continue;
    }
    const { assertions: coalesced, merged } = coalesceGroup(group);
    const tails = sortedUnique(coalesced.map((entry) => entry.tailEntityId));
    if (tails.length < 2) {
      nonCandidates.push({
        headEntityId: head.headEntityId,
        relationNorm: relation,
        reason: merged > 0 ? "identical_assertion" : "single_distinct_tail",
        assertionIds: screenedIds,
      });
      continue;
    }
    const overlappingPairs = distinctTailPairs(coalesced, intervalsOverlap);
    const contributing = new Set(
      overlappingPairs.flatMap(([left, right]) => [left, right])
    );
    if (contributing.size < 2) {
      nonCandidates.push({
        headEntityId: head.headEntityId,
        relationNorm: relation,
        reason:
          distinctTailPairs(coalesced, intervalsAdjacent).length > 0
            ? "adjacent_intervals"
            : "disjoint_intervals",
        assertionIds: screenedIds,
      });
      continue;
    }
    alternatives.push({
      headEntityId: head.headEntityId,
      relationNorm: relation,
      assertions: coalesced.filter((entry) => contributing.has(entry)),
    });
  }
  return { alternatives, nonCandidates };
}

/**
 * Mint the immutable candidate records for one alternative.
 *
 * The returned records carry no verdict: there is no winner, no score and no
 * field a caller could read as "this tail is true". Sorting the tails and the
 * assertion identities is canonicalization of an unordered set, not a ranking.
 */
export function toStructuralCandidates(
  alternative: SelectedAlternative,
  binding: {
    readonly checkId: string;
    readonly inputRevision: string;
    readonly relationCatalogVersion: number;
    readonly publishedAt: string;
  }
): StructuralCandidate[] {
  const intervals = alternative.assertions.map((entry) => entry.interval);
  const uncertainty = uncertaintyOf(intervals);
  const assertionIds = sortedUnique(
    alternative.assertions.flatMap((entry) => entry.assertionIds)
  );
  const supportRevisions = sortedUnique(
    alternative.assertions.flatMap((entry) => entry.supportRevisions)
  );
  const supportIds = sortedUnique(
    alternative.assertions.flatMap((entry) => entry.supportIds)
  );
  const extractionRevisions = [
    ...new Set(alternative.assertions.flatMap((entry) => entry.extractionRevisions)),
  ].sort((left, right) => left - right);
  const assertionInputRevisions = sortedUnique(
    alternative.assertions.flatMap((entry) => entry.inputRevisions)
  );
  const tailEntityIds = sortedUnique(
    alternative.assertions.map((entry) => entry.tailEntityId)
  );
  return [
    Object.freeze({
      candidateId: candidateIdOf({
        assertionIds,
        supportRevisions,
        extractionRevisions,
        assertionInputRevisions,
        inputRevision: binding.inputRevision,
        uncertaintyReason: uncertainty.reason,
        catalogVersion: binding.relationCatalogVersion,
      }),
      checkId: binding.checkId,
      rulesetRevision: SCREENING_RULESET_REVISION,
      coverage: SCREENING_COVERAGE,
      headEntityId: alternative.headEntityId,
      relationNorm: alternative.relationNorm,
      assertionIds: Object.freeze(assertionIds),
      tailEntityIds: Object.freeze(tailEntityIds),
      supportIds: Object.freeze(supportIds),
      supportRevisions: Object.freeze(supportRevisions),
      extractionRevisions: Object.freeze(extractionRevisions),
      assertionInputRevisions: Object.freeze(assertionInputRevisions),
      inputRevision: binding.inputRevision,
      relationCatalogVersion: binding.relationCatalogVersion,
      uncertainty: Object.freeze(uncertainty),
      publishedAt: binding.publishedAt,
    }),
  ];
}

/**
 * Decide whether one guarded attempt may publish candidates and readiness.
 *
 * Ownership is verified first and through the same durable-work primitives the
 * work ledger and publication switch already use, so a screening write cannot
 * disagree with them about a token, a lease or a deadline. The input fences
 * follow: the scheduled config/ruleset revision, the initiating generation, and
 * the complete dependency vector — a source that moved after this attempt was
 * scheduled refuses rather than publishing evidence for inputs that no longer
 * exist.
 */
export function screenFenceVerdict(
  facts: ScreeningLiveFacts
): MaintenanceGuardVerdict {
  const ownership = verifyAttemptOwnership(
    facts.actualGuard,
    facts.now,
    facts.presentedToken
  );
  if (!ownership.ok) return ownership;
  const inputs = verifyAttemptGuard(
    facts.actualGuard,
    facts.liveInputs,
    facts.now,
    facts.presentedToken
  );
  if (!inputs.ok) return inputs;
  if (
    canonicalDependencyRevision(facts.liveInputs.dependencies) !==
    facts.actualGuard.inputRevision
  ) {
    return { ok: false, code: "input_stale" };
  }
  return { ok: true };
}

/** Whether a guard names a conflict-check attempt, which is the only kind. */
export function isConflictCheckGuard(guard: MaintenanceAttemptGuard): boolean {
  return guard.workKind === "conflict_check";
}

export type { ScreeningNonCandidateReason };