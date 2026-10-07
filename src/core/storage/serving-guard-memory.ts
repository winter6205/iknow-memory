/**
 * The in-memory half of MP12's serving guard.
 *
 * The twin of `serving-guard-pg.ts`, and it reaches the identical verdict by
 * calling the identical pure decision — so a disagreement between the lanes can
 * only ever be about reading the facts, never about what the answer should have
 * been.
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
      });
      this.versions.set(row.sourceRef, versions);
    }
  }

  /**
   * The same facts the SQL aggregate produces: one entry per source, carrying
   * whether any of its versions is still live.
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
        retiredAt: versions.find((v) => v.retiredAt !== null)?.retiredAt ?? null,
        payloadCollectedAt: versions.some((v) => v.payloadCollectedAt === null) ? null : "collected",
      });
    }
    return facts;
  }

  guard(sourceRefs: readonly string[]): ServingGuardVerdict {
    return decideServingGuard(sourceRefs, this.factsFor(sourceRefs));
  }
}
