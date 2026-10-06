/**
 * Optional atomic publication capability for the accepted structured corpus.
 * The scope binding and authorized source set are supplied by the trusted
 * server owner; callers must never derive them from query/model input.
 * This integration slice gives each source one authoritative owner scope.
 * Per-caller subset views and multi-company source sharing do not create a
 * second desired/published state and remain unsupported until modeled directly.
 */
import type {
  MaintenanceAttemptGuard,
  MaintenanceDependency,
  MaintenanceWorkStatus,
} from "./types.js";
import type { EntityIdentityInput } from "../structured/identity-store.js";
import type { RelationAssertionInput } from "../structured/identity.js";
import type { ProjectionSubject } from "../storage/projection-outbox.js";
import type { AuthorizedScopeContext } from "../storage/structured-scope-types.js";
import type {
  NewSourceVersion,
  SourceLocatorBinding,
  SupportOccurrence,
} from "../types.js";

export type PublicationFact = {
  readonly identity:
    | { readonly kind: "entity"; readonly input: EntityIdentityInput }
    | {
        readonly kind: "relation_assertion";
        readonly input: RelationAssertionInput;
      };
  readonly occurrence: SupportOccurrence;
  readonly display?: {
    readonly canonicalName: string;
    readonly type: string;
  };
};

export interface PublicationPair {
  readonly sourceVersion: string;
  readonly extractionRevision: number;
}

export interface PublicationSourceSnapshot {
  readonly sourceRef: string;
  readonly active: boolean;
  readonly generation: number;
  readonly desired:
    (PublicationPair & { readonly configRevision: string }) | null;
  readonly published: PublicationPair | null;
  readonly status: MaintenanceWorkStatus;
}

export interface PublicationDisplayValue {
  readonly supportId: string;
  readonly extractionRevision: number;
  readonly canonicalName: string;
  readonly type: string;
}

export interface PublicationSubjectSnapshot {
  readonly subject: "entity" | "assertion";
  readonly resultId: string;
  readonly supportIds: readonly string[];
  readonly displayValues: readonly PublicationDisplayValue[];
}

export interface PublicationMaintenanceSummary {
  readonly sourcesInScope: number;
  readonly publishedSources: number;
  readonly desiredIndexBuckets: number;
  readonly conflictCheckBuckets: number;
  /** MP8/MP9 do not yet record structural screening outcomes. */
  readonly conflictStatus: "pending";
}

export interface PublicationSnapshot {
  readonly scopeBinding: string;
  readonly readRevision: string;
  readonly maintenanceRevision: string;
  readonly sources: readonly PublicationSourceSnapshot[];
  readonly subjects: readonly PublicationSubjectSnapshot[];
  readonly maintenance: PublicationMaintenanceSummary;
}

export interface DeclarePublicationDesiredInput {
  readonly scopeBinding: string;
  readonly authorizedSourceRefs: readonly string[];
  readonly sourceRef: string;
  readonly sourceVersion: NewSourceVersion;
  readonly locatorBindings: readonly SourceLocatorBinding[];
  readonly desiredExtractionRevision: number;
  readonly configRevision: string;
}

export interface StagePublicationAttemptInput {
  readonly scopeBinding: string;
  readonly sourceRef: string;
  readonly guard: MaintenanceAttemptGuard;
  readonly extractionRef: string;
  readonly accepted: readonly PublicationFact[];
}

export interface PublishStructuredInput {
  readonly scopeBinding: string;
  readonly sourceRef: string;
  readonly guard: MaintenanceAttemptGuard;
  readonly at: string;
}

export interface WithdrawStructuredSourceInput {
  readonly scopeBinding: string;
  readonly sourceRef: string;
  readonly expectedGeneration: number;
  readonly at: string;
}

/**
 * Prepare a memory outbox write without changing visible state. The returned
 * synchronous closure commits the outbox together with the shared memory UOW.
 */
export interface PublicationOutboxPort {
  prepareIntents(
    scopeBinding: string,
    subjects: readonly ProjectionSubject[]
  ): Promise<() => void>;
}

/**
 * One `projection_rebuild` request.
 *
 * The guard is a `projection_rebuild` maintenance attempt, so the rebuild runs
 * under the same durable-work fences every other capability reuses. It carries
 * no accepted payload: a rebuild consumes what publication already accepted and
 * never carries a new interpretation of the source.
 */
export interface RebuildProjectionInput {
  readonly context: AuthorizedScopeContext;
  readonly guard: MaintenanceAttemptGuard;
  readonly at: string;
}

/**
 * What one rebuild produced.
 *
 * `dependencyRevision` is the canonical digest of the COMPLETE dependency vector
 * and `publicationRevision` is the scope read revision the generation was built
 * at, so a later consumer can decide staleness without re-deriving either.
 * `reusedGeneration` is true when a generation already existed at this exact
 * dependency revision, which is what makes a repeat rebuild a no-op rather than
 * a second derived artifact.
 */
export interface ProjectionRebuildResult {
  readonly subjects: readonly ProjectionSubject[];
  readonly dependencyRevision: string;
  readonly publicationRevision: string;
  readonly reusedGeneration: boolean;
  readonly queuedIntents: number;
}

/**
 * The persisted record of one derived generation, as a reader sees it.
 *
 * This is the boundary MP12's serving guard will read: it carries the complete
 * dependency vector, not a count, plus the publication revision it was built at.
 */
export interface ProjectionGenerationSnapshot {
  readonly subjects: readonly ProjectionSubject[];
  readonly dependencies: readonly MaintenanceDependency[];
  readonly dependencyRevision: string;
  readonly publicationRevision: string;
}

export interface StructuredPublicationStorage {
  /** Trusted owner declaration advances a source generation before scheduling. */
  declareDesired(
    input: DeclarePublicationDesiredInput
  ): Promise<{ readonly generation: number }>;
  /** Store an isolated attempt payload; this never changes serving membership. */
  stageAttempt(
    input: StagePublicationAttemptInput
  ): Promise<{ readonly staged: true }>;
  /** Atomically publish the staged pair and update current membership. */
  publish(input: PublishStructuredInput): Promise<{ readonly published: true }>;
  /** Withdraw one active source and advance its generation. */
  withdraw(
    input: WithdrawStructuredSourceInput
  ): Promise<{ readonly generation: number }>;
  /** Read current membership and its scope summary from one authorized snapshot. */
  readSnapshot(input: {
    readonly scopeBinding: string;
  }): Promise<PublicationSnapshot>;
}

/**
 * MP11's derived-projection rebuild, as its own surface.
 *
 * Deliberately NOT part of `StructuredPublicationStorage`: a rebuild is a
 * separate work kind under the shared scope unit of work, the same way
 * structural screening is. Keeping it separate is what makes "rebuild is
 * distinct from extraction" structural — the publication interface cannot grow a
 * method that stages a payload, so a rebuild has no path to one.
 */
export interface ProjectionRebuildStorage {
  rebuildProjections(
    input: RebuildProjectionInput
  ): Promise<ProjectionRebuildResult>;
  readProjectionGeneration(
    context: AuthorizedScopeContext,
    sourceRefs: readonly string[]
  ): Promise<ProjectionGenerationSnapshot>;
}
