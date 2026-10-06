/**
 * In-memory structural screening, the twin of `screening-pg.ts`.
 *
 * It runs inside the same shared memory authority and the same serialization
 * tail, so a screening commit cannot land between another writer's last
 * validation and its commit. Validation happens during preparation; the
 * candidate map is written in the seam's synchronous commit slice, with no await
 * between the check row and its candidates — the same all-or-nothing property
 * the PostgreSQL transaction gives, expressed without a rollback.
 */
import { randomUUID } from "node:crypto";

import {
  isConflictCheckGuard,
  screenFenceVerdict,
  selectStructuralAlternatives,
  toStructuralCandidates,
} from "../maintenance/screening-selection.js";
import type { MaintenanceAttemptGuard } from "../maintenance/types.js";
import {
  SCREENING_COVERAGE,
  SCREENING_RULESET_REVISION,
  type ScreeningAssertion,
  type StructuralCandidate,
  type StructuralScreenOutcome,
} from "../maintenance/screening-types.js";
import {
  structuredScopeCodeOf,
  StructuredScopeError,
  type AuthorizedScopeContext,
  type AuthorizedScopeRunOptions,
  type PreparedMemoryScopeWork,
} from "./structured-scope-types.js";
import type { PersistedCandidate } from "./screening-pg.js";

export interface MemoryStageScreenInput {
  readonly context: AuthorizedScopeContext;
  readonly guard: MaintenanceAttemptGuard;
  readonly relationBuckets: readonly string[];
  readonly relationCatalogVersion: number;
  readonly relationCatalogEntries: readonly {
    readonly relationNorm: string;
    readonly cardinality: "multi_valued" | "exclusive";
  }[];
  readonly maxAssertions?: number;
  readonly additionalSourceRefs?: readonly string[];
  /**
   * The accepted assertions the lane's authoritative stores actually hold. A
   * lane supplies what its own stores read rather than a private fixture copy,
   * so the memory twin screens the same rows the PostgreSQL twin would.
   */
  readonly acceptedAssertions: readonly ScreeningAssertion[];
  /** Live source rows keyed by source reference, for the dependency fence. */
  readonly liveSources: ReadonlyMap<
    string,
    { readonly active: boolean; readonly generation: number; readonly publishedExtractionRevision: number | null }
  >;
  /**
   * The initiating source's current config/ruleset revision. It arrives
   * separately from the guard so the fence compares the source's live revision
   * against the one the attempt was scheduled with, rather than comparing the
   * guard against itself.
   */
  readonly liveConfigRevision: string;
  /** The work ledger's failure for this guard at an instant, or null. */
  readonly guardFailure: (
    guard: MemoryStageScreenInput["guard"],
    now: Date
  ) => string | null;
  /** The scheduled dependency vector for this guard. */
  readonly scheduledDependencies: (
    guard: MemoryStageScreenInput["guard"]
  ) =>
    | readonly {
        readonly sourceRef: string;
        readonly generation: number;
        readonly extractionRevision: number | null;
        readonly relationBuckets: readonly string[];
      }[]
    | null;
  readonly now: () => Date;
}

/** The seam this adapter runs under. */
export interface MemoryScreeningAuthority {
  withAuthorizedScope<R>(
    context: AuthorizedScopeContext,
    callback: (work: PreparedMemoryScopeWork) => Promise<R>,
    options?: AuthorizedScopeRunOptions
  ): Promise<R>;
}

function candidateKey(scopeBinding: string, candidateId: string): string {
  return `${scopeBinding}|${candidateId}`;
}

function checkKey(scopeBinding: string, checkId: string): string {
  return `${scopeBinding}|${checkId}`;
}

/** In-memory structural screening evidence. */
export class MemoryScreeningStorage {
  private readonly candidates = new Map<
    string,
    PersistedCandidate & { readonly full: StructuralCandidate }
  >();
  private readonly checks = new Map<
    string,
    { readonly checkId: string; readonly candidateCount: number }
  >();

  constructor(private readonly scope: MemoryScreeningAuthority) {}

  /** Publish one structural check and its candidates, or refuse typed. */
  async stageScreen(input: MemoryStageScreenInput): Promise<StructuralScreenOutcome> {
    if (!isConflictCheckGuard(input.guard)) {
      // EXIT: a screen is asked to publish under an attempt that is not a
      // conflict-check attempt. It throws `invalid_input` before the unit of
      // work opens, so no map is written under an attempt that never checked a
      // relation bucket.
      throw new StructuredScopeError(
        "invalid_input",
        "structural screening requires a conflict_check attempt"
      );
    }
    if (input.maxAssertions !== undefined && input.maxAssertions < 1) {
      // EXIT: a caller-supplied assertion ceiling below one is not a limit. The
      // screen throws `invalid_input` rather than refusing every check as if
      // the budget were already exhausted.
      throw new StructuredScopeError(
        "invalid_input",
        "maxAssertions must be a positive integer when supplied"
      );
    }
    return this.scope.withAuthorizedScope(
      input.context,
      async (work) => {
        const now = input.now();
        const failure = input.guardFailure(input.guard, now);
        if (failure !== null) {
          // EXIT: the work ledger reports this attempt no longer owns its
          // fence. The refusal carries the ledger's own code and the unit of
          // work rolls back, so no check row, candidate row or revision advance
          // survives it.
          throw new StructuredScopeError(
            structuredScopeCodeOf(failure) ?? "backend_unavailable",
            "maintenance attempt no longer owns its write fence"
          );
        }
        const scheduled = input.scheduledDependencies(input.guard);
        if (scheduled === null) {
          // EXIT: the ledger no longer holds this attempt's dependency snapshot.
          // The screen throws `backend_unavailable` rather than screening
          // against an empty vector.
          throw new StructuredScopeError(
            "backend_unavailable",
            "maintenance dependency snapshot is missing"
          );
        }
        const liveDependencies = scheduled.map((dependency) => {
          const live = input.liveSources.get(dependency.sourceRef);
          if (live === undefined || !live.active) {
            // EXIT: a scheduled dependency names no active source in this scope.
            // The screen throws `input_stale` rather than treating an
            // unpublished dependency as an empty one.
            throw new StructuredScopeError(
              "input_stale",
              `dependency ${dependency.sourceRef} is not an active source in this scope`
            );
          }
          return {
            sourceRef: dependency.sourceRef,
            generation: live.generation,
            extractionRevision: live.publishedExtractionRevision,
            relationBuckets: [...dependency.relationBuckets],
          };
        });
        const verdict = screenFenceVerdict({
          actualGuard: input.guard,
          presentedToken: input.guard.fencingToken,
          jobStatus: "running",
          attemptFinished: false,
          liveInputs: {
            configRevision: input.liveConfigRevision,
            dependencies: liveDependencies,
          },
          now,
        });
        if (!verdict.ok) {
          // EXIT: the fence refused this attempt. The refusal carries the fence's
          // own code unchanged and the unit of work rolls back, so no check row,
          // candidate row or revision advance survives it.
          throw new StructuredScopeError(
            structuredScopeCodeOf(verdict.code) ?? "backend_unavailable",
            "the structural screen's bound inputs no longer match"
          );
        }
        if (Date.parse(input.context.deadlineAt) <= now.getTime()) {
          // EXIT: the run's own absolute deadline passed. The screen throws
          // `execution_timeout` so an overrunning run refuses instead of
          // committing evidence past its bound.
          throw new StructuredScopeError(
            "execution_timeout",
            "the authorized run outlived its absolute deadline"
          );
        }
        const assertions = input.acceptedAssertions;
        if (
          input.maxAssertions !== undefined &&
          assertions.length > input.maxAssertions
        ) {
          // EXIT: the accepted assertion set exceeds the caller-supplied
          // ceiling. The screen throws `resource_exhausted` before preparing
          // any commit, so no partial candidate set becomes ready.
          throw new StructuredScopeError(
            "resource_exhausted",
            `structural screen read ${assertions.length} assertions, above the supplied limit of ${input.maxAssertions}`
          );
        }
        const selection = selectStructuralAlternatives(assertions, {
          version: input.relationCatalogVersion,
          entries: input.relationCatalogEntries,
        });
        const checkId = randomUUID();
        const publishedAt = now.toISOString();
        const candidates = selection.alternatives.flatMap((alternative) =>
          toStructuralCandidates(alternative, {
            checkId,
            inputRevision: input.guard.inputRevision,
            relationCatalogVersion: input.relationCatalogVersion,
            publishedAt,
          })
        );
        const scopeBinding = input.context.ownerScopeBinding;
        work.prepare(() => {
          this.checks.set(checkKey(scopeBinding, checkId), {
            checkId,
            candidateCount: candidates.length,
          });
          for (const candidate of candidates) {
            // An identical candidate identity is left as it stands: re-screening
            // the same inputs reproduces the same alternative rather than
            // replacing it, so nothing is promoted by a second screen.
            const key = candidateKey(scopeBinding, candidate.candidateId);
            if (this.candidates.has(key)) continue;
            this.candidates.set(key, {
              candidateId: candidate.candidateId,
              checkId: candidate.checkId,
              headEntityId: candidate.headEntityId,
              relationNorm: candidate.relationNorm,
              assertionIds: candidate.assertionIds,
              tailEntityIds: candidate.tailEntityIds,
              supportIds: candidate.supportIds,
              uncertaintyReason: candidate.uncertainty.reason,
              unboundedLower: candidate.uncertainty.unboundedLower,
              unboundedUpper: candidate.uncertainty.unboundedUpper,
              full: candidate,
            });
          }
        });
        work.bumpRevisions({ read: false, maintenance: true });
        return {
          check: {
            checkId,
            scopeBinding,
            jobKey: input.guard.jobKey,
            sourceRef: input.guard.sourceRef,
            rulesetRevision: SCREENING_RULESET_REVISION,
            coverage: SCREENING_COVERAGE,
            relationCatalogVersion: input.relationCatalogVersion,
            relationBuckets: input.relationBuckets,
            inputRevision: input.guard.inputRevision,
            assertionCount: assertions.length,
            candidateCount: candidates.length,
            publishedAt,
          },
          candidates,
          nonCandidates: selection.nonCandidates,
        };
      },
      input.additionalSourceRefs === undefined
        ? undefined
        : { additionalSourceRefs: input.additionalSourceRefs }
    );
  }

  /** The candidates this scope has published. */
  readCandidates(scopeBinding: string, relationNorm?: string): PersistedCandidate[] {
    return [...this.candidates.entries()]
      .filter(([key]) => key.startsWith(`${scopeBinding}|`))
      .map(([, value]) => value)
      .filter((value) => relationNorm === undefined || value.relationNorm === relationNorm)
      .map(({ full: _full, ...rest }) => rest);
  }

  /** How many checks this scope has published. */
  readCheckCount(scopeBinding: string): number {
    let count = 0;
    for (const key of this.checks.keys()) {
      if (key.startsWith(`${scopeBinding}|`)) count += 1;
    }
    return count;
  }

}
