import {
  StructuredPublicationError,
  normalizePublicationFacts,
  publicationError,
  publicationPayloadDigest,
  requirePublicationInstant,
  requirePublicationRevision,
  requirePublicationString,
  validatePublicationDeclaration,
} from "../maintenance/publication-service.js";
import type {
  DeclarePublicationDesiredInput,
  PublicationFact,
  PublicationMaintenanceSummary,
  PublicationOutboxPort,
  PublicationSnapshot,
  PublicationSourceSnapshot,
  PublicationSubjectSnapshot,
  PublishStructuredInput,
  StagePublicationAttemptInput,
  StructuredPublicationStorage,
  WithdrawStructuredSourceInput,
} from "../maintenance/publication-types.js";
import type {
  MaintenanceAttemptGuard,
  MaintenanceWorkStatus,
} from "../maintenance/types.js";
import type { ProjectionSubject } from "./projection-outbox.js";
import type {
  NewSourceVersion,
  SourceLocatorBinding,
  SourceVersionRecord,
  SupportRecord,
} from "../types.js";
import type { InMemoryStructuredIdentityStore } from "../structured/identity-store.js";
import type { InMemoryMaintenanceWorkStore } from "./maintenance-work-memory.js";
import type { MemorySerializationPort } from "./structured-scope-uow.js";
import type {
  ScopeRevisionChange,
  ScopeRevisionState,
  ScopedExtractionInput,
  ScopedMembershipInput,
  ScopedSourceInput,
} from "./structured-scope-types.js";
import { canonicalDependencyRevision } from "../maintenance/durable-work.js";

interface MemoryEvidenceAuthority {
  readonly structuredIdentityStore: InMemoryStructuredIdentityStore;
  readonly maintenanceWorkStore: InMemoryMaintenanceWorkStore;
  preparePublicationSource(
    input: NewSourceVersion,
    bindings: readonly SourceLocatorBinding[]
  ): { readonly record: SourceVersionRecord; commit(): void };
  preparePublicationEvidence(
    occurrences: readonly import("../types.js").SupportOccurrence[]
  ): { readonly supports: readonly SupportRecord[]; commit(): void };
}

interface DesiredPair {
  readonly sourceVersion: string;
  readonly extractionRevision: number;
  readonly configRevision: string;
}

interface CurrentPair {
  readonly sourceVersion: string;
  readonly extractionRevision: number;
  readonly generation: number;
}

interface CurrentMember {
  readonly supportId: string;
  readonly subject: "entity" | "assertion";
  readonly resultId: string;
  readonly extractionRef: string;
  readonly displayName?: string;
  readonly entityType?: string;
  readonly extractionRevision: number;
}

interface PublishedExtractionBinding {
  readonly configRevision: string;
  readonly extractionRef: string;
  readonly payloadDigest: string;
}

interface HistoricalDisplayValue {
  readonly supportId: string;
  readonly extractionRevision: number;
  readonly canonicalName: string;
  readonly type: string;
}

interface StagedAttempt {
  readonly generation: number;
  readonly jobKey: string;
  readonly attemptNumber: number;
  readonly fencingToken: string;
  readonly extractionRef: string;
  readonly accepted: readonly PublicationFact[];
}

interface MemorySource {
  readonly sourceRef: string;
  active: boolean;
  generation: number;
  desired: DesiredPair | null;
  published: CurrentPair | null;
  membership: Map<string, CurrentMember>;
  staged: StagedAttempt | null;
  readonly extractionBindings: Map<string, PublishedExtractionBinding>;
  readonly displayHistory: Map<string, HistoricalDisplayValue>;
}

interface MemoryScope {
  readonly scopeBinding: string;
  readRevision: bigint;
  maintenanceRevision: bigint;
  readonly sources: Map<string, MemorySource>;
}

class MemoryProjectionOutbox implements PublicationOutboxPort {
  private readonly pending = new Set<string>();

  async prepareIntents(
    _scopeBinding: string,
    subjects: readonly ProjectionSubject[]
  ): Promise<() => void> {
    const intents = [
      ...new Set(subjects.map((subject) => `${subject.kind}:${subject.id}`)),
    ];
    return () => {
      for (const intent of intents) this.pending.add(intent);
    };
  }
}

/** The one-scope source authority and atomic memory twin of the PG adapter. */
export class MemoryStructuredPublicationStorage implements StructuredPublicationStorage {
  private readonly scopes = new Map<string, MemoryScope>();
  private readonly outbox: PublicationOutboxPort;
  private lockTail: Promise<void> = Promise.resolve();
  private readonly removeProgressListener: () => void;
  /**
   * The queue the shared scope seam owns. Publication and the seam must queue on
   * one tail or their writes interleave, so composition injects it rather than
   * letting this adapter keep a private queue beside the seam's.
   */
  private readonly serialization?: MemorySerializationPort;

  constructor(
    private readonly authority: MemoryEvidenceAuthority,
    outbox?: PublicationOutboxPort,
    serialization?: MemorySerializationPort
  ) {
    this.outbox = outbox ?? new MemoryProjectionOutbox();
    this.serialization = serialization;
    this.removeProgressListener =
      authority.maintenanceWorkStore.onProgressChange((sourceRef, generation) =>
        this.recordWorkProgress(sourceRef, generation)
      );
  }

  async declareDesired(
    input: DeclarePublicationDesiredInput
  ): Promise<{ readonly generation: number }> {
    return this.exclusive(async () => {
      const requested = validatePublicationDeclaration(input);
      this.assertSingleOwnerScope(
        requested.scopeBinding,
        requested.authorizedSourceRefs
      );
      const currentScope = this.scopes.get(requested.scopeBinding);
      const scope = currentScope ?? newScope(requested.scopeBinding);
      const removals = [...scope.sources.values()].filter(
        (source) =>
          source.active &&
          !requested.authorizedSourceRefs.includes(source.sourceRef)
      );
      const generations = planNextGenerations(
        scope,
        removals,
        requested.authorizedSourceRefs,
        requested.sourceRef
      );
      const affected = removals.flatMap((source) => currentSubjects(source));
      const commitOutbox = await this.outbox.prepareIntents(
        requested.scopeBinding,
        affected
      );

      // Rebuild after the async outbox preparation so independent evidence writes
      // that happened meanwhile are included in the shared authoritative maps.
      const sourcePlan = this.authority.preparePublicationSource(
        requested.sourceVersion,
        requested.locatorBindings
      );
      if (sourcePlan.record.source_ref !== requested.sourceRef) {
        throw new StructuredPublicationError(
          "invalid_input",
          "source version belongs to another source"
        );
      }
      commitOutbox();
      if (currentScope === undefined)
        this.scopes.set(scope.scopeBinding, scope);

      let authorizationChanged = false;
      for (const source of removals) {
        source.active = false;
        source.generation = generations.get(source.sourceRef)!;
        source.desired = null;
        source.published = null;
        source.membership.clear();
        source.staged = null;
        authorizationChanged = true;
      }
      for (const sourceRef of requested.authorizedSourceRefs) {
        let source = scope.sources.get(sourceRef);
        if (source === undefined) {
          source = newSource(sourceRef, true);
          source.generation = generations.get(sourceRef)!;
          scope.sources.set(sourceRef, source);
          authorizationChanged = true;
        } else if (!source.active && sourceRef !== requested.sourceRef) {
          source.active = true;
          source.generation = generations.get(sourceRef)!;
          source.desired = null;
          source.published = null;
          source.membership.clear();
          source.staged = null;
          authorizationChanged = true;
        } else {
          source.active = true;
        }
      }
      const source = scope.sources.get(requested.sourceRef)!;
      sourcePlan.commit();
      source.generation = generations.get(requested.sourceRef)!;
      source.desired = {
        sourceVersion: sourcePlan.record.source_version,
        extractionRevision: requested.desiredExtractionRevision,
        configRevision: requested.configRevision,
      };
      source.staged = null;
      scope.maintenanceRevision += 1n;
      if (authorizationChanged) scope.readRevision += 1n;
      return { generation: source.generation };
    }).catch((error: unknown) => {
      throw publicationError(error);
    });
  }

  async stageAttempt(
    input: StagePublicationAttemptInput
  ): Promise<{ readonly staged: true }> {
    return this.exclusive(async () => {
      const normalized = validateStage(input);
      const { scope, source } = this.requireCurrentSource(
        normalized.scopeBinding,
        normalized.sourceRef
      );
      this.assertGuard(scope, source, normalized.guard, new Date());
      const facts = normalizePublicationFacts(
        normalized.accepted,
        source.sourceRef,
        source.desired!.sourceVersion,
        normalized.extractionRef
      );
      this.authority.preparePublicationEvidence(
        facts.map((fact) => fact.fact.occurrence)
      );
      source.staged = {
        generation: source.generation,
        jobKey: normalized.guard.jobKey,
        attemptNumber: normalized.guard.attemptNumber,
        fencingToken: normalized.guard.fencingToken,
        extractionRef: normalized.extractionRef,
        accepted: cloneFacts(normalized.accepted),
      };
      scope.maintenanceRevision += 1n;
      return { staged: true as const };
    }).catch((error: unknown) => {
      throw publicationError(error);
    });
  }

  async publish(
    input: PublishStructuredInput
  ): Promise<{ readonly published: true }> {
    return this.exclusive(async () => {
      const normalized = validatePublish(input);
      const { scope, source } = this.requireCurrentSource(
        normalized.scopeBinding,
        normalized.sourceRef
      );
      this.assertGuard(scope, source, normalized.guard, new Date());
      const staged = source.staged;
      if (!staged || !sameAttempt(staged, normalized.guard)) {
        throw new StructuredPublicationError(
          "input_stale",
          "no staged payload belongs to this attempt"
        );
      }
      const facts = normalizePublicationFacts(
        staged.accepted,
        source.sourceRef,
        source.desired!.sourceVersion,
        staged.extractionRef
      );
      const payloadDigest = publicationPayloadDigest(facts);
      assertExtractionBinding(source, staged.extractionRef, payloadDigest);
      const subjects = projectionSubjects(source, facts);
      const commitOutbox = await this.outbox.prepareIntents(
        scope.scopeBinding,
        subjects
      );

      // The outbox is the only await in the commit path. Recheck the real work
      // ledger afterwards so a concurrent settle/reclaim cannot publish stale data.
      this.assertGuard(scope, source, normalized.guard, new Date());
      if (source.staged !== staged || !sameAttempt(staged, normalized.guard)) {
        throw new StructuredPublicationError(
          "input_stale",
          "staged payload changed during publication"
        );
      }
      const finalFacts = normalizePublicationFacts(
        staged.accepted,
        source.sourceRef,
        source.desired!.sourceVersion,
        staged.extractionRef
      );
      assertExtractionBinding(
        source,
        staged.extractionRef,
        publicationPayloadDigest(finalFacts)
      );
      const identityPlan =
        this.authority.structuredIdentityStore.preparePublicationBatch(
          finalFacts.flatMap((fact) =>
            fact.fact.identity.kind === "entity"
              ? [fact.fact.identity.input]
              : []
          ),
          finalFacts.flatMap((fact) =>
            fact.fact.identity.kind === "relation_assertion"
              ? [fact.fact.identity.input]
              : []
          )
        );
      const evidencePlan = this.authority.preparePublicationEvidence(
        finalFacts.map((fact) => fact.fact.occurrence)
      );
      const workPlan =
        this.authority.maintenanceWorkStore.preparePublicationReady(
          normalized.guard,
          new Date(),
          new Date(normalized.at)
        );
      if (workPlan.failure !== null) {
        throw new StructuredPublicationError(
          workPlan.failure,
          "maintenance attempt lost its publication fence"
        );
      }
      commitOutbox();
      identityPlan.commit();
      evidencePlan.commit();
      workPlan.commit();
      source.membership = new Map(
        evidencePlan.supports.map((support, index) => [
          support.support_id,
          toMember(
            support,
            finalFacts[index]!,
            source.desired!.extractionRevision
          ),
        ])
      );
      rememberExtractionBinding(source, staged.extractionRef, payloadDigest);
      source.published = {
        sourceVersion: source.desired!.sourceVersion,
        extractionRevision: source.desired!.extractionRevision,
        generation: source.generation,
      };
      source.staged = null;
      scope.readRevision += 1n;
      scope.maintenanceRevision += 1n;
      return { published: true as const };
    }).catch((error: unknown) => {
      throw publicationError(error);
    });
  }

  async withdraw(
    input: WithdrawStructuredSourceInput
  ): Promise<{ readonly generation: number }> {
    return this.exclusive(async () => {
      const normalized = validateWithdrawal(input);
      const { scope, source } = this.requireCurrentSource(
        normalized.scopeBinding,
        normalized.sourceRef
      );
      if (source.generation !== normalized.expectedGeneration) {
        throw new StructuredPublicationError(
          "input_stale",
          "source generation changed before withdrawal"
        );
      }
      const nextGeneration = incrementGeneration(source.generation);
      const commitOutbox = await this.outbox.prepareIntents(
        scope.scopeBinding,
        currentSubjects(source)
      );
      if (
        source.generation !== normalized.expectedGeneration ||
        !source.active
      ) {
        throw new StructuredPublicationError(
          "input_stale",
          "source generation changed during withdrawal"
        );
      }
      commitOutbox();
      source.active = false;
      source.generation = nextGeneration;
      source.desired = null;
      source.published = null;
      source.membership.clear();
      source.staged = null;
      scope.readRevision += 1n;
      scope.maintenanceRevision += 1n;
      return { generation: source.generation };
    }).catch((error: unknown) => {
      throw publicationError(error);
    });
  }

  async readSnapshot(input: {
    readonly scopeBinding: string;
  }): Promise<PublicationSnapshot> {
    try {
      const scopeBinding = requirePublicationString(
        input?.scopeBinding,
        "scopeBinding"
      );
      const scope = this.scopes.get(scopeBinding);
      if (scope === undefined) return emptySnapshot(scopeBinding);
      return buildMemorySnapshot(scope, scopeBinding, (source) =>
        this.sourceStatus(source)
      );
    } catch (error) {
      throw publicationError(error);
    }
  }

  close(): void {
    this.removeProgressListener();
    this.scopes.clear();
  }

  /**
   * The seam's authority surface: ownership, revisions and the exact serving
   * rows, read from the maps the publication methods write.
   *
   * These are projections rather than copies of the scope registry because a
   * seam that read a snapshot taken before an accepted write would refuse work
   * that legitimately landed, and a seam that wrote back a stale copy would
   * erase it.
   */
  resolveOwnerScopeBinding(sourceRef: string): string | null {
    for (const scope of this.scopes.values()) {
      if (scope.sources.has(sourceRef)) return scope.scopeBinding;
    }
    return null;
  }

  scopeRevisions(scopeBinding: string): ScopeRevisionState | null {
    const scope = this.scopes.get(scopeBinding);
    if (scope === undefined) return null;
    return {
      readRevision: Number(scope.readRevision),
      maintenanceRevision: Number(scope.maintenanceRevision),
    };
  }

  scopedSourceRows(
    scopeBinding: string,
    sourceRefs: readonly string[]
  ): ScopedSourceInput[] {
    const scope = this.scopes.get(scopeBinding);
    if (scope === undefined) return [];
    const rows: ScopedSourceInput[] = [];
    for (const sourceRef of sourceRefs) {
      const source = scope.sources.get(sourceRef);
      if (source !== undefined) rows.push(memoryScopedRow(source));
    }
    return rows;
  }

  scopedMembershipRows(
    scopeBinding: string,
    sourceRefs: readonly string[]
  ): ScopedMembershipInput[] {
    const scope = this.scopes.get(scopeBinding);
    if (scope === undefined) return [];
    const rows: ScopedMembershipInput[] = [];
    for (const sourceRef of sourceRefs) {
      const source = scope.sources.get(sourceRef);
      if (source !== undefined && source.published !== null) {
        rows.push(...memoryMembershipRows(source));
      }
    }
    return rows;
  }

  scopedExtractionRows(
    scopeBinding: string,
    sourceRefs: readonly string[]
  ): ScopedExtractionInput[] {
    const scope = this.scopes.get(scopeBinding);
    if (scope === undefined) return [];
    const rows: ScopedExtractionInput[] = [];
    for (const sourceRef of sourceRefs) {
      const source = scope.sources.get(sourceRef);
      if (source !== undefined && source.published !== null) {
        rows.push(...memoryExtractionRows(source));
      }
    }
    return rows;
  }

  advanceScopeRevision(
    scopeBinding: string,
    change: ScopeRevisionChange
  ): void {
    const scope = this.scopes.get(scopeBinding);
    if (scope === undefined) return;
    if (change.read) scope.readRevision += 1n;
    if (change.maintenance) scope.maintenanceRevision += 1n;
  }

  private requireCurrentSource(
    scopeBinding: string,
    sourceRef: string
  ): { scope: MemoryScope; source: MemorySource } {
    const scope = this.scopes.get(scopeBinding);
    const source = scope?.sources.get(sourceRef);
    if (scope === undefined || source === undefined) {
      throw new StructuredPublicationError(
        "access_denied",
        "source is not active in this trusted scope"
      );
    }
    if (!source.active || source.desired === null) {
      throw new StructuredPublicationError(
        "input_stale",
        "source is no longer active with the requested desired pair"
      );
    }
    return { scope, source };
  }

  private assertGuard(
    scope: MemoryScope,
    source: MemorySource,
    guard: MaintenanceAttemptGuard,
    at: Date
  ): void {
    const failure = this.authority.maintenanceWorkStore.publicationGuardFailure(
      guard,
      at
    );
    if (failure !== null) {
      throw new StructuredPublicationError(
        failure,
        "maintenance attempt no longer owns its write fence"
      );
    }
    assertGuardSourcePair(source, guard);
    this.assertGuardDependencies(scope, guard);
  }

  private assertGuardDependencies(
    scope: MemoryScope,
    guard: MaintenanceAttemptGuard
  ): void {
    const dependencies =
      this.authority.maintenanceWorkStore.publicationDependenciesForGuard(
        guard
      );
    if (dependencies === null) {
      throw new StructuredPublicationError(
        "backend_unavailable",
        "maintenance dependency snapshot is missing"
      );
    }
    const liveDependencies = dependencies.map((dependency) => {
      if (dependency.relationBuckets.length > 0) {
        throw new StructuredPublicationError(
          "maintenance_status_unavailable",
          "relation-bucket inputs require the later structural-screening capability"
        );
      }
      const liveSource = scope.sources.get(dependency.sourceRef);
      if (
        liveSource === undefined ||
        !liveSource.active ||
        liveSource.generation !== dependency.generation
      ) {
        throw new StructuredPublicationError(
          "input_stale",
          "a source dependency changed after this attempt was scheduled"
        );
      }
      return {
        ...dependency,
        extractionRevision: liveSource.published?.extractionRevision ?? null,
      };
    });
    if (canonicalDependencyRevision(liveDependencies) !== guard.inputRevision) {
      throw new StructuredPublicationError(
        "input_stale",
        "a dependency extraction changed after this attempt was scheduled"
      );
    }
  }

  private sourceStatus(source: MemorySource): MaintenanceWorkStatus {
    if (!source.active) return "stale";
    if (source.desired === null) return "pending";
    const jobs = this.authority.maintenanceWorkStore
      .publicationJobsForSource(source.sourceRef, source.generation)
      .filter(
        (job) =>
          job.workKind === "extract_publish" &&
          job.sourceVersion === source.desired!.sourceVersion &&
          job.configRevision === source.desired!.configRevision
      )
      .sort(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) ||
          left.jobKey.localeCompare(right.jobKey)
      );
    return jobs.at(-1)?.status ?? "pending";
  }

  private recordWorkProgress(sourceRef: string, generation: number): void {
    for (const scope of this.scopes.values()) {
      const source = scope.sources.get(sourceRef);
      if (source?.active && source.generation === generation) {
        scope.maintenanceRevision += 1n;
      }
    }
  }

  private assertSingleOwnerScope(
    scopeBinding: string,
    sourceRefs: readonly string[]
  ): void {
    for (const scope of this.scopes.values()) {
      if (scope.scopeBinding === scopeBinding) continue;
      for (const sourceRef of sourceRefs) {
        if (scope.sources.has(sourceRef)) {
          throw new StructuredPublicationError(
            "unsupported_source_binding",
            `source ${sourceRef} already has an authoritative publication scope`
          );
        }
      }
    }
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.serialization !== undefined) {
      return this.serialization.exclusive(action);
    }
    const previous = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

function assertGuardSourcePair(
  source: MemorySource,
  guard: MaintenanceAttemptGuard
): void {
  if (
    guard.workKind !== "extract_publish" ||
    guard.sourceRef !== source.sourceRef ||
    guard.sourceVersion !== source.desired?.sourceVersion ||
    guard.sourceGeneration !== source.generation ||
    guard.configRevision !== source.desired?.configRevision
  ) {
    throw new StructuredPublicationError(
      "input_stale",
      "attempt guard does not match the desired source pair"
    );
  }
}

function buildMemorySnapshot(
  scope: MemoryScope,
  scopeBinding: string,
  statusOf: (source: MemorySource) => MaintenanceWorkStatus
): PublicationSnapshot {
  return {
    scopeBinding,
    readRevision: scope.readRevision.toString(),
    maintenanceRevision: scope.maintenanceRevision.toString(),
    sources: snapshotSources(scope, statusOf),
    subjects: snapshotSubjects(scope),
    maintenance: summarizeMemoryMaintenance(scope),
  };
}

function snapshotSources(
  scope: MemoryScope,
  statusOf: (source: MemorySource) => MaintenanceWorkStatus
): PublicationSourceSnapshot[] {
  return [...scope.sources.values()]
    .sort((left, right) => left.sourceRef.localeCompare(right.sourceRef))
    .map((source) => ({
      sourceRef: source.sourceRef,
      active: source.active,
      generation: source.generation,
      desired:
        source.desired === null
          ? null
          : {
              sourceVersion: source.desired.sourceVersion,
              extractionRevision: source.desired.extractionRevision,
              configRevision: source.desired.configRevision,
            },
      published:
        source.published === null
          ? null
          : {
              sourceVersion: source.published.sourceVersion,
              extractionRevision: source.published.extractionRevision,
            },
      status: statusOf(source),
    }));
}

interface MemorySubjectAggregate {
  readonly subject: "entity" | "assertion";
  readonly supportIds: Set<string>;
  readonly displayValues: Map<
    string,
    PublicationSubjectSnapshot["displayValues"][number]
  >;
}

function snapshotSubjects(scope: MemoryScope): PublicationSubjectSnapshot[] {
  const aggregates = new Map<string, MemorySubjectAggregate>();
  for (const source of scope.sources.values()) {
    if (!source.active || source.published === null) continue;
    for (const member of source.membership.values()) {
      addMemberToSnapshot(aggregates, member);
    }
  }
  return [...aggregates.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, aggregate]) => ({
      subject: aggregate.subject,
      resultId: key.slice(key.indexOf("\u0000") + 1),
      supportIds: [...aggregate.supportIds].sort((left, right) =>
        left.localeCompare(right)
      ),
      displayValues: [...aggregate.displayValues.values()].sort((left, right) =>
        left.supportId.localeCompare(right.supportId)
      ),
    }));
}

function addMemberToSnapshot(
  aggregates: Map<string, MemorySubjectAggregate>,
  member: CurrentMember
): void {
  const key = `${member.subject}\u0000${member.resultId}`;
  const aggregate = aggregates.get(key) ?? {
    subject: member.subject,
    supportIds: new Set<string>(),
    displayValues: new Map<
      string,
      PublicationSubjectSnapshot["displayValues"][number]
    >(),
  };
  aggregate.supportIds.add(member.supportId);
  if (member.displayName !== undefined && member.entityType !== undefined) {
    aggregate.displayValues.set(member.supportId, {
      supportId: member.supportId,
      extractionRevision: member.extractionRevision,
      canonicalName: member.displayName,
      type: member.entityType,
    });
  }
  aggregates.set(key, aggregate);
}

function summarizeMemoryMaintenance(
  scope: MemoryScope
): PublicationMaintenanceSummary {
  const active = [...scope.sources.values()].filter((source) => source.active);
  return {
    sourcesInScope: active.length,
    publishedSources: active.filter((source) => source.published !== null)
      .length,
    desiredIndexBuckets: active.length,
    conflictCheckBuckets: active.length,
    conflictStatus: "pending",
  };
}

function validateStage(
  input: StagePublicationAttemptInput
): StagePublicationAttemptInput {
  requirePublicationString(input?.scopeBinding, "scopeBinding");
  requirePublicationString(input?.sourceRef, "sourceRef");
  requirePublicationString(input?.extractionRef, "extractionRef");
  if (!input?.guard || !Array.isArray(input.accepted)) {
    throw new StructuredPublicationError(
      "invalid_input",
      "stage attempt requires a guard and accepted facts array"
    );
  }
  return input;
}

function validatePublish(
  input: PublishStructuredInput
): PublishStructuredInput {
  requirePublicationString(input?.scopeBinding, "scopeBinding");
  requirePublicationString(input?.sourceRef, "sourceRef");
  if (!input?.guard)
    throw new StructuredPublicationError(
      "invalid_input",
      "publish requires an attempt guard"
    );
  const at = requirePublicationInstant(input.at, "at");
  return { ...input, at };
}

function validateWithdrawal(
  input: WithdrawStructuredSourceInput
): WithdrawStructuredSourceInput {
  requirePublicationString(input?.scopeBinding, "scopeBinding");
  requirePublicationString(input?.sourceRef, "sourceRef");
  const expectedGeneration = requirePublicationRevision(
    input?.expectedGeneration,
    "expectedGeneration"
  );
  const at = requirePublicationInstant(input.at, "at");
  return { ...input, expectedGeneration, at };
}

function newScope(scopeBinding: string): MemoryScope {
  return {
    scopeBinding,
    readRevision: 0n,
    maintenanceRevision: 0n,
    sources: new Map(),
  };
}

function newSource(sourceRef: string, active: boolean): MemorySource {
  return {
    sourceRef,
    active,
    generation: 0,
    desired: null,
    published: null,
    membership: new Map(),
    staged: null,
    extractionBindings: new Map(),
    displayHistory: new Map(),
  };
}

/** The scope seam's row shape for one memory source. */
function memoryScopedRow(source: MemorySource): ScopedSourceInput {
  return {
    sourceRef: source.sourceRef,
    sourceVersion:
      source.desired?.sourceVersion ?? source.published?.sourceVersion ?? null,
    active: source.active,
    generation: source.generation,
    desired: source.desired === null ? null : { ...source.desired },
    published:
      source.published === null
        ? null
        : {
            sourceVersion: source.published.sourceVersion,
            extractionRevision: source.published.extractionRevision,
          },
  };
}

/**
 * One row per served result with every support behind it, in membership order.
 * Grouping here mirrors the PostgreSQL read so a reader sees the same row count
 * from either twin.
 */
function memoryMembershipRows(source: MemorySource): ScopedMembershipInput[] {
  const grouped = new Map<string, ScopedMembershipInput & {
    supportIds: string[];
    extractionRefs: string[];
  }>();
  for (const member of source.membership.values()) {
    const key = `${member.subject}\u0000${member.resultId}`;
    let entry = grouped.get(key);
    if (entry === undefined) {
      entry = {
        sourceRef: source.sourceRef,
        subject: member.subject,
        resultId: member.resultId,
        supportIds: [],
        extractionRefs: [],
      };
      grouped.set(key, entry);
    }
    if (!entry.supportIds.includes(member.supportId)) {
      entry.supportIds.push(member.supportId);
    }
    if (!entry.extractionRefs.includes(member.extractionRef)) {
      entry.extractionRefs.push(member.extractionRef);
    }
  }
  return [...grouped.values()];
}

/** The published extraction ref and the display values attributed to it. */
function memoryExtractionRows(source: MemorySource): ScopedExtractionInput[] {
  const published = source.published;
  if (published === null) return [];
  const binding = source.extractionBindings.get(
    extractionBindingKey(published.sourceVersion, published.extractionRevision)
  );
  if (binding === undefined) return [];
  const attributedValues = [...source.displayHistory.values()]
    .filter((value) => value.extractionRevision === published.extractionRevision)
    .map((value) => ({
      supportId: value.supportId,
      extractionRevision: value.extractionRevision,
      canonicalName: value.canonicalName,
      entityType: value.type,
    }));
  return [
    {
      sourceRef: source.sourceRef,
      extractionRef: binding.extractionRef,
      attributedValues,
    },
  ];
}

function incrementGeneration(generation: number): number {
  if (
    !Number.isSafeInteger(generation) ||
    generation >= Number.MAX_SAFE_INTEGER
  ) {
    throw new StructuredPublicationError(
      "resource_exhausted",
      "source generation exhausted its safe range"
    );
  }
  return generation + 1;
}

function planNextGenerations(
  scope: MemoryScope,
  removals: readonly MemorySource[],
  authorizedSourceRefs: readonly string[],
  targetSourceRef: string
): Map<string, number> {
  const generations = new Map<string, number>();
  for (const source of removals) {
    generations.set(source.sourceRef, incrementGeneration(source.generation));
  }
  for (const sourceRef of authorizedSourceRefs) {
    const source = scope.sources.get(sourceRef);
    if (
      sourceRef === targetSourceRef ||
      (source !== undefined && !source.active)
    ) {
      generations.set(sourceRef, incrementGeneration(source?.generation ?? 0));
    }
  }
  return generations;
}

function currentSubjects(source: MemorySource): ProjectionSubject[] {
  return [...source.membership.values()].map((member) =>
    projectionSubject(member.subject, member.resultId)
  );
}

function projectionSubjects(
  source: MemorySource,
  facts: readonly ReturnType<typeof normalizePublicationFacts>[number][]
): ProjectionSubject[] {
  const subjects = [
    ...currentSubjects(source),
    ...facts.map((fact) => projectionSubject(fact.subject, fact.resultId)),
  ];
  const unique = new Map(
    subjects.map((subject) => [`${subject.kind}:${subject.id}`, subject])
  );
  return [...unique.values()];
}

function projectionSubject(
  subject: "entity" | "assertion",
  id: string
): ProjectionSubject {
  return { kind: subject === "entity" ? "entity" : "triple", id };
}

function toMember(
  support: SupportRecord,
  fact: ReturnType<typeof normalizePublicationFacts>[number],
  revision: number
): CurrentMember {
  return {
    supportId: support.support_id,
    subject: fact.subject,
    resultId: support.result_id,
    extractionRef: fact.occurrence.extraction_ref,
    ...(fact.displayName === undefined
      ? {}
      : { displayName: fact.displayName }),
    ...(fact.entityType === undefined ? {} : { entityType: fact.entityType }),
    extractionRevision: revision,
  };
}

function assertExtractionBinding(
  source: MemorySource,
  extractionRef: string,
  payloadDigest: string
): void {
  const desired = source.desired!;
  const key = extractionBindingKey(
    desired.sourceVersion,
    desired.extractionRevision
  );
  const existing = source.extractionBindings.get(key);
  if (
    existing !== undefined &&
    (existing.configRevision !== desired.configRevision ||
      existing.extractionRef !== extractionRef ||
      existing.payloadDigest !== payloadDigest)
  ) {
    throw new StructuredPublicationError(
      "input_stale",
      "published extraction revision is already bound to different inputs or output"
    );
  }
}

function rememberExtractionBinding(
  source: MemorySource,
  extractionRef: string,
  payloadDigest: string
): void {
  const desired = source.desired!;
  const key = extractionBindingKey(
    desired.sourceVersion,
    desired.extractionRevision
  );
  source.extractionBindings.set(key, {
    configRevision: desired.configRevision,
    extractionRef,
    payloadDigest,
  });
  for (const member of source.membership.values()) {
    if (member.displayName === undefined || member.entityType === undefined)
      continue;
    const displayKey = `${member.supportId}\u0000${member.extractionRevision}`;
    source.displayHistory.set(displayKey, {
      supportId: member.supportId,
      extractionRevision: member.extractionRevision,
      canonicalName: member.displayName,
      type: member.entityType,
    });
  }
}

function extractionBindingKey(sourceVersion: string, revision: number): string {
  return `${sourceVersion}\u0000${revision}`;
}

function sameAttempt(
  staged: StagedAttempt,
  guard: MaintenanceAttemptGuard
): boolean {
  return (
    staged.jobKey === guard.jobKey &&
    staged.attemptNumber === guard.attemptNumber &&
    staged.fencingToken === guard.fencingToken
  );
}

function cloneFacts(
  facts: readonly PublicationFact[]
): readonly PublicationFact[] {
  try {
    return JSON.parse(JSON.stringify(facts)) as PublicationFact[];
  } catch {
    throw new StructuredPublicationError(
      "invalid_input",
      "accepted facts must be serializable JSON"
    );
  }
}

function emptySnapshot(scopeBinding: string): PublicationSnapshot {
  return {
    scopeBinding,
    readRevision: "0",
    maintenanceRevision: "0",
    sources: [],
    subjects: [],
    maintenance: {
      sourcesInScope: 0,
      publishedSources: 0,
      desiredIndexBuckets: 0,
      conflictCheckBuckets: 0,
      conflictStatus: "pending",
    },
  };
}
