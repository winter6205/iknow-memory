/**
 * MP12 serving guard (spec 320-323).
 *
 * One question, asked before a derived hit is served: does the source this hit
 * came from still have a live version?
 *
 * "Live" means at least one version whose payload has not been collected. That
 * single fact covers both halves of the requirement — a withdrawn source has no
 * un-retired version, a sole-purged source has no un-collected payload — while a
 * source that still has one current support stays visible. A predicate per chunk
 * would get that last case wrong: it would hide a live version because a sibling
 * version of the same source was retired.
 *
 * The decision is pure. It reads no clock, touches no storage, and returns a
 * typed refusal rather than a default answer when the lifecycle facts are absent,
 * because serving whatever the derived index holds is precisely the stale-read
 * hazard this guard exists to close.
 */
import type { StructuredErrorCode } from "./errors.js";

/** One source version's lifecycle state, as read from `source_versions`. */
export interface SourceLifecycleFact {
  readonly sourceRef: string;
  readonly retiredAt: string | null;
  readonly payloadCollectedAt: string | null;
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
        "maintenance_status_unavailable" | "structured_search_unavailable"
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
    return !hasLiveVersion(fact);
  });

  return { served: true, dropped };
}

/**
 * Whether a source is still servable.
 *
 * `payload_collected_at IS NULL` is the test, and `retired_at` deliberately does
 * not participate: retirement stops a source being *collected*, not a live
 * sibling version being *served*. A source whose current version is still live
 * stays visible, which is the ticket's "a current remaining support stays
 * visible" clause.
 */
function hasLiveVersion(fact: SourceLifecycleFact): boolean {
  return fact.payloadCollectedAt === null;
}

function unavailable(detail: string): ServingGuardVerdict {
  return {
    served: false,
    code: "maintenance_status_unavailable",
    detail,
  };
}
