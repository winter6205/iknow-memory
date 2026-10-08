/**
 * The in-memory half of MP12's serving guard.
 *
 * The twin of `serving-guard-pg.ts`, and it reaches the identical verdict by
 * calling the identical pure decision — so a disagreement between the lanes can
 * only ever be about reading the facts, never about what the answer should have
 * been. "Reading the facts" includes the aggregation: this file reproduces
 * `max(retired_at)` rather than picking whichever row came first, because the
 * aggregation is part of the rule the lanes share, not an implementation detail
 * of either one.
 */
import { decideServingGuard } from "../structured/serving-guard.js";
import type {
  SourceLifecycleFact,
  SourceLifecycleFacts,
  ServingGuardVerdict,
} from "../structured/serving-guard.js";

/** What a test or an embedder seeds. One entry per source version. */
export interface MemorySourceLifecycleSeed {
  readonly sourceRef: string;
  readonly retiredAt?: string | null;
  readonly payloadCollectedAt?: string | null;
  /**
   * The source's publication state, as `structured_publication_sources.active`.
   * Omitted means "no publication row", which is ingested-not-withdrawn.
   */
  readonly active?: boolean;
}

export class MemoryServingGuard {
  private readonly versions = new Map<string, SourceLifecycleFact[]>();

  constructor(seed: readonly MemorySourceLifecycleSeed[] = []) {
    for (const row of seed) {
      const versions = this.versions.get(row.sourceRef) ?? [];
      versions.push({
        sourceRef: row.sourceRef,
        retiredAt: row.retiredAt ?? null,
        payloadCollectedAt: row.payloadCollectedAt ?? null,
        active: row.active ?? true,
      });
      this.versions.set(row.sourceRef, versions);
    }
  }

  /**
   * The same facts the SQL aggregate produces: one entry per source, carrying
   * whether any of its versions is still live and whether it was withdrawn.
   */
  factsFor(sourceRefs: readonly string[]): SourceLifecycleFacts | null {
    const facts = new Map<string, SourceLifecycleFact>();
    for (const ref of new Set(sourceRefs)) {
      const versions = this.versions.get(ref);
      // An unregistered source is absent, exactly as the SQL's GROUP BY leaves it
      // absent — and absent is what the guard refuses, so the two lanes agree on
      // the case that matters most.
      if (versions === undefined) continue;
      facts.set(ref, {
        sourceRef: ref,
        retiredAt: latest(versions.map((v) => v.retiredAt)),
        payloadCollectedAt: versions.some((v) => v.payloadCollectedAt === null) ? null : "collected",
        // Withdrawal is a per-SOURCE flag, so it is an AND across the source's
        // rows: one withdrawn row withdraws the source. The SQL spells the same
        // thing as `bool_and(COALESCE(ps.active, true))`.
        active: versions.every((v) => v.active),
      });
    }
    return facts;
  }

  guard(sourceRefs: readonly string[]): ServingGuardVerdict {
    return decideServingGuard(sourceRefs, this.factsFor(sourceRefs));
  }
}

/**
 * `max(retired_at)`: the latest stamp, not the first non-null one.
 *
 * Compared as instants rather than as strings because the SQL lane compares
 * `timestamptz` values, and a lexicographic comparison would silently disagree
 * with the database the moment two stamps had different offsets.
 */
function latest(values: readonly (string | null)[]): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value === null) continue;
    const ms = Date.parse(value);
    if (Number.isNaN(ms) || ms <= bestMs) continue;
    best = value;
    bestMs = ms;
  }
  return best;
}
