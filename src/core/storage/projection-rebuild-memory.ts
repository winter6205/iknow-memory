/**
 * MP11 — the memory twin of the derived-projection rebuild.
 *
 * Same contract as the PostgreSQL lane and the same fences, verified through the
 * same durable-work ledger helpers (`publicationGuardFailure` /
 * `publicationDependenciesForGuard`) and the same `canonicalDependencyRevision`.
 *
 * The derived generation lives in the store's OWN rows — the publication
 * adapter's authoritative maps — never in adapter-private shadow state, and it
 * runs on the shared serialization tail so a rebuild cannot interleave with the
 * publication writes that own the same maps.
 */
import {
  StructuredPublicationError,
  publicationError,
} from "../maintenance/publication-service.js";
import type {
  ProjectionGenerationSnapshot,
  ProjectionRebuildResult,
  ProjectionRebuildStorage,
  RebuildProjectionInput,
} from "../maintenance/publication-types.js";
import type {
  MaintenanceDependency,
  MaintenanceWorkFailureCode,
} from "../maintenance/types.js";
import { canonicalDependencyRevision } from "../maintenance/durable-work.js";
import type { ProjectionSubject } from "./projection-outbox.js";
import type { MemoryStructuredScopeUnitOfWork } from "./structured-scope-uow.js";
import type { InMemoryMaintenanceWorkStore } from "./maintenance-work-memory.js";
import type {
  AcceptedInputSnapshot,
  AuthorizedScopeContext,
} from "./structured-scope-types.js";

/** One persisted derived generation, keyed by its complete dependency revision. */
interface MemoryDerivedGeneration {
  readonly dependencyRevision: string;
  readonly publicationRevision: string;
  readonly dependencies: readonly MaintenanceDependency[];
  readonly subjects: readonly ProjectionSubject[];
}

/**
 * The seam's read of derived generations. It is additive to
 * `MemoryPublicationScopeAuthority` rather than a change to it, because that
 * interface is not this ticket's to edit.
 */
export interface MemoryProjectionGenerationReader {
  derivedGeneration(
    scopeBinding: string,
    dependencyRevision: string
  ): MemoryDerivedGeneration | undefined;
  recordDerivedGeneration(
    scopeBinding: string,
    generation: MemoryDerivedGeneration
  ): void;
}

export class MemoryProjectionRebuildStorage implements ProjectionRebuildStorage {
  constructor(
    private readonly scope: MemoryStructuredScopeUnitOfWork,
    private readonly work: InMemoryMaintenanceWorkStore,
    private readonly generations: MemoryProjectionGenerationReader,
    private readonly outbox: {
      prepareIntents(
        scopeBinding: string,
        subjects: readonly ProjectionSubject[]
      ): Promise<() => void>;
    }
  ) {}

  async rebuildProjections(
    input: RebuildProjectionInput
  ): Promise<ProjectionRebuildResult> {
    try {
      return await this.scope.withAuthorizedScope(
        input.context,
        async (work) => {
          const scopeBinding = input.context.ownerScopeBinding;
          this.assertGuard(input.guard, new Date());
          const dependencies = this.scheduledDependencies(input.guard);
          if (canonicalDependencyRevision(dependencies) !== input.guard.inputRevision) {
            // EXIT: the scheduled snapshot does not hash to the revision this
            // guard names. It throws `backend_unavailable` rather than rebuilding
            // against a vector the attempt was not scheduled for.
            throw new StructuredPublicationError(
              "backend_unavailable",
              "maintenance dependency snapshot does not match its input revision"
            );
          }
          // One read of the accepted state serves both the fence and the result,
          // so the dependency check and the derived subjects cannot disagree.
          const accepted = await work.readAcceptedInputs(
            dependencies.map((dependency) => dependency.sourceRef)
          );
          this.assertLiveDependencies(accepted, dependencies);
          const dependencyRevision = canonicalDependencyRevision(dependencies);
          const subjects = deriveSubjects(accepted.memberships);
          const publicationRevision = String(accepted.readRevision);
          const existing = this.generations.derivedGeneration(
            scopeBinding,
            dependencyRevision
          );
          const reusedGeneration = existing !== undefined;
          if (reusedGeneration) {
            return {
              subjects: [...existing.subjects],
              dependencyRevision,
              publicationRevision: existing.publicationRevision,
              reusedGeneration: true,
              queuedIntents: 0,
            };
          }
          // The outbox is the only await in the commit path, so the fence is
          // rechecked after it: a concurrent settle or reclaim cannot leave a
          // generation recorded against an attempt that no longer owns the job.
          const commitOutbox = await this.outbox.prepareIntents(
            scopeBinding,
            subjects
          );
          this.assertGuard(input.guard, new Date());
          work.prepare(() => {
            commitOutbox();
            this.generations.recordDerivedGeneration(scopeBinding, {
              dependencyRevision,
              publicationRevision,
              dependencies: [...dependencies],
              subjects,
            });
          });
          return {
            subjects,
            dependencyRevision,
            publicationRevision,
            reusedGeneration: false,
            queuedIntents: subjects.length,
          };
        },
        { additionalSourceRefs: [] }
      );
    } catch (error) {
      throw publicationError(error);
    }
  }

  async readProjectionGeneration(
    context: AuthorizedScopeContext,
    sourceRefs: readonly string[]
  ): Promise<ProjectionGenerationSnapshot> {
    return this.scope.withAuthorizedScope(
      context,
      async (work) => {
        const scopeBinding = context.ownerScopeBinding;
        const accepted = await work.readAcceptedInputs(sourceRefs);
        const live = canonicalDependencyRevision(
          accepted.sources
            .filter((source) => source.active)
            .map((source) => ({
              sourceRef: source.sourceRef,
              generation: source.generation,
              extractionRevision: source.published?.extractionRevision ?? null,
              relationBuckets: [] as readonly string[],
            }))
            .sort((left, right) =>
              left.sourceRef.localeCompare(right.sourceRef)
            )
        );
        const generation = this.generations.derivedGeneration(
          scopeBinding,
          live
        );
        if (generation === undefined) {
          // EXIT: this scope has no derived generation at its current accepted
          // state. The read throws `maintenance_status_unavailable` — the
          // missing-required-record refusal — rather than reporting an empty
          // generation, which a caller would misread as "nothing to rebuild".
          throw new StructuredPublicationError(
            "maintenance_status_unavailable",
            "no derived generation has been recorded for this scope"
          );
        }
        return {
          subjects: [...generation.subjects],
          dependencies: [...generation.dependencies],
          dependencyRevision: generation.dependencyRevision,
          publicationRevision: generation.publicationRevision,
        };
      },
      { additionalSourceRefs: sourceRefs }
    );
  }

  /** T09's ownership/lease/absolute-limit fence against the real ledger row. */
  private assertGuard(
    guard: RebuildProjectionInput["guard"],
    now: Date
  ): void {
    const failure: MaintenanceWorkFailureCode | null =
      this.work.publicationGuardFailure(guard, now);
    if (failure !== null) {
      // EXIT: the attempt does not own its job any more — wrong token, expired
      // lease, exceeded absolute limit, settled, or superseded. The rebuild
      // throws the ledger's own code so a caller branches on the same verdict
      // every other capability reports.
      throw new StructuredPublicationError(
        failure,
        "maintenance attempt no longer owns its write fence"
      );
    }
  }

  private scheduledDependencies(
    guard: RebuildProjectionInput["guard"]
  ): readonly MaintenanceDependency[] {
    const dependencies = this.work.publicationDependenciesForGuard(guard);
    if (dependencies === null) {
      // EXIT: the ledger row carries no dependency snapshot. It throws
      // `backend_unavailable` rather than treating it as an empty vector, which
      // would make a rebuild appear to depend on nothing.
      throw new StructuredPublicationError(
        "backend_unavailable",
        "maintenance dependency snapshot is missing"
      );
    }
    return dependencies;
  }

  private assertLiveDependencies(
    accepted: AcceptedInputSnapshot,
    dependencies: readonly MaintenanceDependency[]
  ): void {
    for (const dependency of dependencies) {
      if (dependency.relationBuckets.length > 0) {
        // EXIT: a rebuild consumes accepted publication state, which carries no
        // relation bucket. It throws `maintenance_status_unavailable` rather
        // than re-screening, because screening is a different work kind.
        throw new StructuredPublicationError(
          "maintenance_status_unavailable",
          "a projection rebuild consumes accepted publication state, not relation buckets"
        );
      }
      const live = accepted.sources.find(
        (entry) => entry.sourceRef === dependency.sourceRef
      );
      if (live === undefined || live.active !== true) {
        // EXIT: a dependency's source row is gone or inactive, so its accepted
        // extraction no longer exists and the generation is not eligible to
        // serve. This is the missing case, typed differently from a stale one so
        // a caller can tell them apart.
        throw new StructuredPublicationError(
          "maintenance_status_unavailable",
          "a rebuild dependency has no accepted publication state"
        );
      }
      if (live.generation !== dependency.generation) {
        throw new StructuredPublicationError(
          "input_stale",
          "a rebuild dependency changed after this attempt was scheduled"
        );
      }
      const liveRevision = live.published?.extractionRevision ?? null;
      if (liveRevision !== dependency.extractionRevision) {
        throw new StructuredPublicationError(
          "input_stale",
          "a rebuild dependency's accepted extraction changed after this attempt was scheduled"
        );
      }
      if (liveRevision === null) {
        // EXIT: the dependency is active and its revision matches what the
        // attempt was scheduled against, but nothing was ever PUBLISHED under
        // it, so there is no accepted extraction to rebuild from. The spec
        // requires a typed unavailable verdict rather than a derived artifact of
        // nothing.
        throw new StructuredPublicationError(
          "maintenance_status_unavailable",
          "a rebuild dependency has no accepted publication to rebuild from"
        );
      }
    }
  }
}

/** The exact accepted subjects, keyed and de-duplicated the one way. */
function deriveSubjects(
  memberships: readonly { subject: string; resultId: string }[]
): ProjectionSubject[] {
  const subjects: ProjectionSubject[] = [];
  const seen = new Set<string>();
  for (const membership of memberships) {
    const kind = membership.subject === "entity" ? "entity" : "triple";
    const key = `${kind}:${membership.resultId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    subjects.push({ kind, id: membership.resultId });
  }
  return subjects;
}