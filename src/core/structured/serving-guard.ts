/**
 * MP12 serving guard (spec 320-323).
 *
 * One question, asked before a derived hit is served: may this source be served
 * at all?
 *
 * Two independent facts answer it, and they are independent on purpose — the
 * spec's rule covers a withdrawn OR a sole-purged source, and neither fact can
 * stand in for the other:
 *
 * - **Payload**: at least one version still has an un-collected payload. This
 *   covers the sole-purged half, and it stays a per-SOURCE fact rather than a
 *   per-version one so that one live version keeps its collected siblings'
 *   source visible; a predicate per chunk would get that wrong by hiding a live
 *   version because a sibling version was purged.
 * - **Withdrawal**: `structured_publication_sources.active = false`. `withdraw()`
 *   writes that column and nothing else — it never retires a version and never
 *   stamps a collection — so a withdrawn-but-uncollected source looks perfectly
 *   live to the payload rule alone. Reading withdrawal as "every version is
 *   retired" is the mistake this separation exists to prevent.
 *
 * Retirement is deliberately NOT a third rule: `retired_at` is carried so a
 * caller can see it and so the cross-lane contract has something to aggregate,
 * but retirement stops a source being collected, not a live sibling version
 * being served.
 *
 * The decision is pure. It reads no clock, touches no storage, and returns a
 * typed refusal rather than a default answer when the lifecycle facts are absent,
 * because serving whatever the derived index holds is precisely the stale-read
 * hazard this guard exists to close.
 */
import type { StructuredErrorCode } from "./errors.js";

/** One source's lifecycle state, as read from the store. */
export interface SourceLifecycleFact {
  readonly sourceRef: string;
  readonly retiredAt: string | null;
  readonly payloadCollectedAt: string | null;
  /**
   * False only when a `structured_publication_sources` row says the source was
   * withdrawn.
   *
   * A source with NO such row is `true`, not unknown: the row is only ever
   * written by publication, so a source that was ingested and never published
   * has not been withdrawn and must keep serving. That is why the withdrawal
   * half of the rule is phrased as "is not withdrawn" rather than "is published
   * and active".
   */
  readonly active: boolean;
}

/**
 * The lifecycle state of every source a candidate set touches.
 *
 * A source that is absent from this map is a source the store could not account
 * for. That is NOT the same as a source with no live version, and the difference
 * is the whole point: absent means unknown, and unknown must not serve.
 */
export type SourceLifecycleFacts = ReadonlyMap<string, SourceLifecycleFact>;

export type ServingGuardVerdict =
  | { readonly served: true; readonly dropped: readonly string[] }
  | {
      readonly served: false;
      readonly code: Extract<
        StructuredErrorCode,
        "maintenance_status_unavailable"
      >;
      readonly detail: string;
    };

/**
 * Decide whether the candidate sources may be served.
 *
 * `candidates` is the distinct set of `source_ref` values behind the hits being
 * served. An empty set is served: a result with no source attribution has nothing
 * to guard, and refusing it would take down every query that legitimately returns
 * nothing attributable.
 */
export function decideServingGuard(
  candidates: readonly string[],
  facts: SourceLifecycleFacts | null
): ServingGuardVerdict {
  const distinct = [...new Set(candidates)];
  if (distinct.length === 0) return { served: true, dropped: [] };

  // No facts at all, or a fact missing for a source we were asked about: the
  // store could not answer, so we do not answer either.
  if (facts === null) {
    return unavailable("the source lifecycle could not be read, so no hit may be served as current");
  }
  const unknown = distinct.filter((ref) => !facts.has(ref));
  if (unknown.length > 0) {
    return unavailable(
      `no lifecycle state for ${unknown.length} of ${distinct.length} candidate source(s), starting ${unknown[0]}`
    );
  }

  const dropped = distinct.filter((ref) => {
    const fact = facts.get(ref);
    // Unreachable by construction — `unknown` above already refused — but the
    // narrowing is what lets the rule below read as a rule rather than a guard
    // against `undefined`.
    if (fact === undefined) return true;
    return !isServable(fact);
  });

  return { served: true, dropped };
}

/**
 * Whether a source may be served: not withdrawn, and one version still
 * un-collected.
 *
 * `payload_collected_at IS NULL` is the payload test and `retired_at` does not
 * participate: retirement stops a source being *collected*, not a live sibling
 * version being *served*. `active` is the withdrawal test, and it is checked
 * first because it is the one fact whose absence is not a reason to serve —
 * `active` is `true` only when nothing has withdrawn the source.
 */
function isServable(fact: SourceLifecycleFact): boolean {
  return fact.active && fact.payloadCollectedAt === null;
}

function unavailable(detail: string): ServingGuardVerdict {
  return {
    served: false,
    code: "maintenance_status_unavailable",
    detail,
  };
}
