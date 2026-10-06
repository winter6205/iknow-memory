/**
 * The guarded decision surface: what an explicit current decision may say about
 * one unresolved structural conflict, and which refusals it can meet.
 *
 * Why this exists at all. A candidate is a record that more than one tail was
 * found, never a claim that one of them is true. That is precisely why a
 * conflict cannot simply resolve itself when new evidence arrives: the
 * inherited specification fixes "conflicting assertions remain queryable until
 * an explicit versioned rule or decision resolves them; no default newest-wins
 * behavior", so the absence of a decision is itself the state a reader sees.
 * A later-arriving fact does not displace an earlier one, and a screen that
 * runs again produces the same alternatives rather than a new ordering.
 *
 * What a decision is therefore NOT. It is not a verdict about which tail is
 * true: the only outcomes are the three the specification names, and every one
 * of them is a statement about visibility and provenance, not about semantics.
 * `keep_both` is the default-shaped action because it is the one that changes
 * nothing about which rows are current — it records that a human looked at the
 * conflict and left both sides standing.
 *
 * Nothing here reads a store or mints a timestamp, so the same request always
 * produces the same content digest, which is what makes a duplicate submission
 * detectable as identical rather than merely similar.
 */
import { createHash } from "node:crypto";

import type { AuthorizedScopeContextLike } from "./screening-types.js";

/**
 * The only three outcomes. This list is closed by the inherited specification:
 * a fourth action is not a gap to be filled in, and `keep_both` exists
 * alongside the two changing actions precisely so that "a human reviewed this
 * and changed nothing" is expressible.
 */
export const SCREENING_DECISION_OUTCOMES = [
  "keep_both",
  "retire_support",
  "supersede_assertion",
] as const;

export type ScreeningDecisionOutcome =
  (typeof SCREENING_DECISION_OUTCOMES)[number];

/** Whether an outcome changes which rows are currently visible. */
export function outcomeChangesVisibility(
  outcome: ScreeningDecisionOutcome
): boolean {
  return outcome !== "keep_both";
}

/**
 * One explicit decision about one conflict, as the trusted caller states it.
 *
 * Every field is load-bearing and none of it is inferred. The expected
 * revisions are what make the decision apply against the state its author
 * actually saw: a decision carrying revisions that have moved since is a
 * decision about inputs that no longer exist, and it refuses rather than
 * re-resolving a conflict nobody looked at.
 */
export interface ScreeningDecisionRequest {
  /** The caller's own decision identity; a reuse with other content refuses. */
  readonly decisionId: string;
  /** The trusted authority this decision runs under; never parsed from input. */
  readonly context: AuthorizedScopeContextLike;
  /** The exact candidate whose conflict this decision addresses. */
  readonly candidateId: string;
  readonly outcome: ScreeningDecisionOutcome;
  /** The author's stated reason; whitespace is not a reason. */
  readonly reason: string;
  /**
   * The exact supports this decision retires, named one by one. The
   * specification forbids inferring a replacement or retiring an undisclosed
   * origin, so this list is the disclosure: an empty list under a changing
   * outcome is an incomplete decision, not a decision to change nothing.
   */
  readonly retireSupportIds: readonly string[];
  /**
   * The exact support that survives `supersede_assertion`. It is required for
   * that outcome alone, because naming a superseded assertion without naming
   * what replaces it would be exactly the inferred replacement the
   * specification rules out.
   */
  readonly retainSupportIds: readonly string[];
  /** The exact assertions the decision affects, named rather than derived. */
  readonly assertionIds: readonly string[];
  /** The conflict's bound input revision as its author read it. */
  readonly expectedInputRevision: string;
  /** The conflict's relation catalog version as its author read it. */
  readonly expectedRelationCatalogVersion: number;
}

/** The decision as the authoritative store keeps it. */
export interface ScreeningDecisionRecord {
  readonly decisionId: string;
  readonly scopeBinding: string;
  readonly candidateId: string;
  readonly checkId: string;
  readonly outcome: ScreeningDecisionOutcome;
  readonly reason: string;
  /** The trusted principal that applied it, as minted by composition. */
  readonly actorId: string;
  readonly retireSupportIds: readonly string[];
  readonly retainSupportIds: readonly string[];
  readonly assertionIds: readonly string[];
  readonly expectedInputRevision: string;
  readonly expectedRelationCatalogVersion: number;
  readonly decidedAt: string;
  /** Identical content yields an identical digest; different content does not. */
  readonly contentDigest: string;
}

/** What one decision did to the conflict's current visibility. */
export interface ScreeningDecisionEffect {
  readonly decisionId: string;
  readonly candidateId: string;
  readonly outcome: ScreeningDecisionOutcome;
  readonly retireSupportIds: readonly string[];
  readonly retainSupportIds: readonly string[];
  readonly assertionIds: readonly string[];
  /** True only when the outcome moved current visibility. */
  readonly visibilityChanged: boolean;
  /** True only when a projection intent was enqueued in the same commit. */
  readonly projectionIntentsEnqueued: boolean;
  /** The read revision the decision was applied at, after its own advance. */
  readonly readRevision: number;
  /** The maintenance revision the decision was applied at. */
  readonly maintenanceRevision: number;
}

export interface ScreeningDecisionOutcomeRecord {
  readonly decision: ScreeningDecisionRecord;
  readonly effect: ScreeningDecisionEffect;
  /**
   * True when an identical decision was already recorded, so the caller learns
   * the outcome is the one it asked for without a second effect being applied.
   */
  readonly idempotent: boolean;
}

/**
 * What the conflict looked like when the decision was presented, as the store
 * holds it. A decision is validated against this and never against the
 * request's own claims about the conflict.
 */
export interface ScreeningConflictFacts {
  readonly scopeBinding: string;
  readonly candidateId: string;
  readonly checkId: string;
  /** Every support the candidate's conflict set contains. */
  readonly supportIds: readonly string[];
  /** Every assertion the candidate's conflict set contains. */
  readonly assertionIds: readonly string[];
  readonly inputRevision: string;
  readonly relationCatalogVersion: number;
  /** The scope's read revision before this decision's own advance. */
  readonly readRevision: number;
  readonly maintenanceRevision: number;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function isBlank(value: string): boolean {
  return value.trim() === "";
}

/**
 * The content digest of one decision.
 *
 * It binds the outcome, the reason, the named supports and assertions, and the
 * expected revisions — everything that would make two submissions of the same
 * decision ID mean different things. The decision ID, the actor and the scope
 * are deliberately outside it: a retry by the same trusted actor carries the
 * same digest, which is what lets an identical resubmission be recognized.
 */
export function decisionContentDigest(
  request: ScreeningDecisionRequest
): string {
  return createHash("sha256")
    .update(
      [
        request.candidateId,
        request.outcome,
        request.reason,
        sortedUnique(request.retireSupportIds).join(","),
        sortedUnique(request.retainSupportIds).join(","),
        sortedUnique(request.assertionIds).join(","),
        request.expectedInputRevision,
        String(request.expectedRelationCatalogVersion),
      ].join("|"),
      "utf8"
    )
    .digest("hex");
}

/**
 * Validate one decision request against the conflict the store actually holds.
 *
 * The order is the contract, and it is the order the refusals are named in:
 * the trusted context, then the action, then the reason, then the exact
 * affected IDs, then the expected revisions. Nothing is written before this
 * returns, so every refusal below leaves the authoritative stores untouched —
 * not "unchanged apart from the part that had already happened", but exactly
 * as they were, because nothing ran.
 *
 * A refusal returns the class of the refusal rather than throwing: the caller
 * owns the transaction, and only the caller knows whether it is validating
 * inside a unit of work it can still roll back.
 */
export type DecisionValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly refusal: "access_denied" | "invalid_input" | "input_stale";
      readonly detail: string;
    };

function refuse(
  refusal: "access_denied" | "invalid_input" | "input_stale",
  detail: string
): DecisionValidation {
  return { ok: false, refusal, detail };
}

export function validateDecisionRequest(
  request: ScreeningDecisionRequest,
  facts: ScreeningConflictFacts
): DecisionValidation {
  // The trusted actor is NOT re-checked here. It is established before this
  // function is reachable at all: a decision's context is minted by trusted
  // composition, and `scopeAuthorityOf` refuses anything not minted with
  // `access_denied` before the decision opens its unit of work. A second check
  // on a value the seam has already authenticated would be a fence that cannot
  // fail, which is worse than no fence — it reads as protection and is not.
  if (isBlank(request.decisionId)) {
    return refuse("invalid_input", "a decision requires a decision id");
  }
  if (!SCREENING_DECISION_OUTCOMES.includes(request.outcome)) {
    return refuse(
      "invalid_input",
      `unsupported screening decision outcome: ${String(request.outcome)}`
    );
  }
  if (isBlank(request.reason)) {
    return refuse(
      "invalid_input",
      "a decision requires a nonempty reason; whitespace is not a reason"
    );
  }
  if (request.candidateId !== facts.candidateId) {
    return refuse(
      "invalid_input",
      `decision names candidate ${request.candidateId} but addresses ${facts.candidateId}`
    );
  }
  if (request.assertionIds.length === 0) {
    return refuse(
      "invalid_input",
      "a decision must name the exact assertions it affects"
    );
  }
  const unknownAssertions = request.assertionIds.filter(
    (id) => !facts.assertionIds.includes(id)
  );
  if (unknownAssertions.length > 0) {
    return refuse(
      "invalid_input",
      `decision names assertions outside this conflict: ${sortedUnique(unknownAssertions).join(",")}`
    );
  }
  const affectedSupports = [
    ...request.retireSupportIds,
    ...request.retainSupportIds,
  ];
  const unknownSupports = affectedSupports.filter(
    (id) => !facts.supportIds.includes(id)
  );
  if (unknownSupports.length > 0) {
    return refuse(
      "invalid_input",
      `decision names supports outside this conflict: ${sortedUnique(unknownSupports).join(",")}`
    );
  }
  if (
    outcomeChangesVisibility(request.outcome) &&
    request.retireSupportIds.length === 0
  ) {
    return refuse(
      "invalid_input",
      `${request.outcome} must name the exact supports it retires`
    );
  }
  if (request.outcome === "supersede_assertion") {
    if (request.retainSupportIds.length !== 1) {
      return refuse(
        "invalid_input",
        "supersede_assertion must name exactly one support as the replacement; a replacement is never inferred"
      );
    }
    if (request.retainSupportIds.includes(request.retireSupportIds[0] ?? "")) {
      return refuse(
        "invalid_input",
        "a support cannot be both the retired origin and its own replacement"
      );
    }
  } else if (request.retainSupportIds.length > 0) {
    return refuse(
      "invalid_input",
      `only supersede_assertion may name a retained support, not ${request.outcome}`
    );
  }
  if (request.expectedInputRevision !== facts.inputRevision) {
    return refuse(
      "input_stale",
      `decision expects input revision ${request.expectedInputRevision} but the conflict is at ${facts.inputRevision}`
    );
  }
  if (
    request.expectedRelationCatalogVersion !== facts.relationCatalogVersion
  ) {
    return refuse(
      "input_stale",
      `decision expects relation catalog ${request.expectedRelationCatalogVersion} but the conflict is at ${facts.relationCatalogVersion}`
    );
  }
  return { ok: true };
}

/**
 * Whether the conflict still reads as unresolved.
 *
 * This is the whole of the "no default newest-wins" rule expressed as a query
 * answer: a conflict with no decision is unresolved whatever order its facts
 * arrived in, and only an explicit decision — including `keep_both`, which
 * resolves it by changing nothing — makes it resolved.
 */
export function conflictIsResolved(
  decisions: readonly ScreeningDecisionRecord[],
  candidateId: string
): boolean {
  return decisions.some((decision) => decision.candidateId === candidateId);
}

/** The closed set of refusals, as the maintenance work vocabulary spells them. */
export const DECISION_REFUSAL_CODES = {
  access_denied: "access_denied",
  invalid_input: "invalid_input",
  input_stale: "input_stale",
} as const;
