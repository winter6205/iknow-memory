/**
 * Deterministic barrier for the shared authorized-scope unit of work.
 *
 * Why this file exists: accepted structured state must be decided by one
 * storage-owned unit of work that the publication, work, identity and Evidence
 * authorities all cooperate with. These tests drive the real publication and
 * durable-work paths and then inspect the real stores, so a seam that only
 * pretends to share authority — a private copy, a second registry, or
 * sequentially calling independently transaction-owning stores — cannot pass.
 *
 * Expected values come from the behaviour contract (one owner per source, typed
 * refusals, bounded routing, no partial commit, per-reader authorized subsets),
 * never from identifiers a backend happened to mint.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { getSuppressedFailureContext } from "../../src/core/errors.js";
import {
  claimNextWork,
  retryWork,
  scheduleWork,
  settleWork,
} from "../../src/core/maintenance/service.js";
import type {
  MaintenanceAttemptGuard,
  MaintenanceDependency,
  MaintenanceJobRecord,
  MaintenanceLiveInputs,
  MaintenanceWorkKind,
  MaintenanceWorkRequest,
  MaintenanceWorkStore,
} from "../../src/core/maintenance/types.js";
import {
  WORK_ABSOLUTE_LIMIT_MS,
  WORK_LEASE_MS,
} from "../../src/core/maintenance/types.js";
import type {
  PublicationFact,
  PublicationOutboxPort,
  PublicationSnapshot,
  StructuredPublicationStorage,
} from "../../src/core/maintenance/publication-types.js";
import type {
  EntityIdentityInput,
  StructuredIdentityStore,
} from "../../src/core/structured/identity-store.js";
import {
  deriveRelationAssertionId,
  normalizeRelationAssertion,
  type RelationAssertionInput,
} from "../../src/core/structured/identity.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { withAuthorizedScope } from "../../src/core/storage/structured-scope-uow.js";
import type {
  AuthorizedScopeContext,
  AuthorizedScopeContextInput,
  AuthorizedScopeUnitOfWork,
  PreparedMemoryScopeWork,
  ScopedInputView,
  StructuredScopeUnitOfWork,
} from "../../src/core/storage/structured-scope-types.js";
import type { ChunkRecord } from "../../src/core/types.js";
import {
  createPublicationTestClock,
  expectFailure,
  outcomeCode,
  type PublicationTestPort,
  type SeededVersion,
} from "./publication-contract.js";

const DIMENSIONS = 8;
const ACTOR = "scope-uow-trusted-owner";
const INJECTED_COMMIT_DETAIL = "injected commit failure at /payload/SECRET-LEAK";
const UUIDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
] as const;

type AuthorizedScopeInput = AuthorizedScopeContextInput;

interface TestOutbox extends PublicationOutboxPort {
  failNextPreparation(): void;
  failNextCommit(detail: string): void;
  delayNextPreparation(milliseconds: number): void;
  preparations(): number;
  resetPreparations(): void;
  resetCounts(): void;
  count(scopeBinding: string): number;
}

interface ScopeTestPort extends PublicationTestPort {
  readonly authority: AuthorizedScopeUnitOfWork;
  readonly outbox: TestOutbox;
  authorizedContext(input: AuthorizedScopeInput): AuthorizedScopeContext;
  farDeadline(): string;
}

interface Attempt {
  readonly guard: MaintenanceAttemptGuard;
  readonly live: MaintenanceLiveInputs;
}

let serial = 0;

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

function opaqueDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function createTestOutbox(): TestOutbox {
  const committed = new Map<string, number>();
  let failPrepare = false;
  let commitFailure: string | null = null;
  let delayMilliseconds = 0;
  let preparationCount = 0;

  return {
    failNextPreparation() {
      failPrepare = true;
    },
    failNextCommit(detail) {
      commitFailure = detail;
    },
    delayNextPreparation(milliseconds) {
      delayMilliseconds = milliseconds;
    },
    preparations() {
      return preparationCount;
    },
    resetPreparations() {
      preparationCount = 0;
    },
    resetCounts() {
      committed.clear();
    },
    count(scopeBinding) {
      return committed.get(scopeBinding) ?? 0;
    },
    async prepareIntents(scopeBinding, subjects) {
      preparationCount += 1;
      const delay = delayMilliseconds;
      delayMilliseconds = 0;
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
      if (failPrepare) {
        failPrepare = false;
        throw new Error("injected outbox preparation failure");
      }
      const intentCount = new Set(
        subjects.map((subject) => `${subject.kind}:${subject.id}`)
      ).size;
      return () => {
        if (commitFailure !== null) {
          const detail = commitFailure;
          commitFailure = null;
          throw new Error(detail);
        }
        if (intentCount > 0) {
          committed.set(
            scopeBinding,
            (committed.get(scopeBinding) ?? 0) + intentCount
          );
        }
      };
    },
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/** The typed failure an action reported, or undefined when it reported success. */
async function codeOf(action: Promise<unknown>): Promise<string | undefined> {
  try {
    const value = await action;
    return outcomeCode(value);
  } catch (error) {
    return outcomeCode(error) ?? "untyped_error";
  }
}

function errorCodeOf(error: unknown): string {
  return outcomeCode(error) ?? "untyped_error";
}

function refsOf(sources: readonly { sourceRef: string }[]): string[] {
  return sources.map((source) => source.sourceRef).sort();
}

function resultIdsOf(
  memberships: readonly { resultId: string }[]
): string[] {
  return memberships.map((membership) => membership.resultId).sort();
}

function supportIdsOf(
  memberships: readonly { supportIds: readonly string[] }[]
): string[] {
  return memberships
    .flatMap((membership) => [...membership.supportIds])
    .sort();
}

type SourceRow = PublicationSnapshot["sources"][number];

function sourceRow(
  snapshot: PublicationSnapshot,
  sourceRef: string
): SourceRow | undefined {
  return snapshot.sources.find((source) => source.sourceRef === sourceRef);
}

function currentIds(snapshot: PublicationSnapshot): string[] {
  return snapshot.subjects
    .map((subject) => subject.resultId)
    .sort((left, right) => left.localeCompare(right));
}

function supportIdFor(
  snapshot: PublicationSnapshot,
  resultId: string
): string {
  const subject = snapshot.subjects.find(
    (candidate) => candidate.resultId === resultId
  );
  const supportId = subject?.supportIds[0];
  if (supportId === undefined) {
    throw new Error(`test setup found no support for ${resultId}`);
  }
  return supportId;
}

function publishRequest(
  sourceRef: string,
  sourceGeneration: number,
  dependencies?: readonly MaintenanceDependency[],
  workKind: MaintenanceWorkKind = "extract_publish"
): MaintenanceWorkRequest {
  return {
    workKind,
    sourceRef,
    sourceVersion: "v1",
    sourceGeneration,
    configRevision: "extractor-v1",
    dependencies:
      dependencies ??
      [
        {
          sourceRef,
          generation: sourceGeneration,
          extractionRevision: null,
          relationBuckets: [],
        },
      ],
  };
}

function requireScheduled(outcome: {
  readonly record?: MaintenanceJobRecord;
  readonly refused?: string;
}): MaintenanceJobRecord {
  if ("refused" in outcome && outcome.refused !== undefined) {
    throw new Error(`test setup schedule refused: ${outcome.refused}`);
  }
  const record = (outcome as { record?: MaintenanceJobRecord }).record;
  if (record === undefined) throw new Error("test setup schedule returned no record");
  return record;
}

function requireGuard(
  guard: MaintenanceAttemptGuard | null
): MaintenanceAttemptGuard {
  if (guard === null) throw new Error("test setup could not claim work");
  return guard;
}

function entityFact(
  seeded: SeededVersion,
  entityId: string,
  extractionRef: string,
  canonicalName: string,
  unit = 1
): PublicationFact {
  const identity: EntityIdentityInput = { entityId, type: "organization" };
  return {
    identity: { kind: "entity", input: identity },
    occurrence: {
      subject: "entity",
      result_id: entityId,
      source_ref: seeded.record.source_ref,
      source_version: seeded.record.source_version,
      location: { ...seeded.locator, unit },
      extraction_ref: extractionRef,
      extractedAt: seeded.record.created_at,
    },
    display: { canonicalName, type: "organization" },
  };
}

function assertionFact(
  seeded: SeededVersion,
  extractionRef: string,
  relationNorm: string,
  unit = 2
): PublicationFact {
  const identity: RelationAssertionInput = {
    headEntityId: UUIDS[0],
    relationNorm,
    tailEntityId: UUIDS[1],
    validWindow: { from: null, until: null },
  };
  const normalized = normalizeRelationAssertion(identity);
  return {
    identity: { kind: "relation_assertion", input: identity },
    occurrence: {
      subject: "assertion",
      result_id: deriveRelationAssertionId(normalized),
      source_ref: seeded.record.source_ref,
      source_version: seeded.record.source_version,
      location: { ...seeded.locator, unit },
      extraction_ref: extractionRef,
      extractedAt: seeded.record.created_at,
    },
  };
}

function derivedAssertionId(relationNorm: string): string {
  return deriveRelationAssertionId(
    normalizeRelationAssertion({
      headEntityId: UUIDS[0],
      relationNorm,
      tailEntityId: UUIDS[1],
      validWindow: { from: null, until: null },
    })
  );
}

async function openMemoryPort(): Promise<ScopeTestPort> {
  const outbox = createTestOutbox();
  const backend = new MemoryBackend(DIMENSIONS, {
    publicationOutbox: outbox,
  }) as MemoryBackend & {
    structuredPublication?: StructuredPublicationStorage;
    structuredIdentityStore?: StructuredIdentityStore;
    maintenanceWorkStore?: MaintenanceWorkStore;
    structuredScopeUnitOfWork?: AuthorizedScopeUnitOfWork;
  };
  const publication = backend.structuredPublication;
  const identity = backend.structuredIdentityStore;
  const work = backend.maintenanceWorkStore;
  const authority = backend.structuredScopeUnitOfWork;
  if (!publication || !identity || !work || !authority) {
    throw new Error(
      "backend composition must supply one shared scope authority to the publication, identity and work stores"
    );
  }
  const clock = createPublicationTestClock(new Date());

  return {
    publication,
    evidence: backend,
    identity,
    work,
    clock,
    authority,
    outbox,
    authorizedContext(input) {
      return authority.createAuthorizedContext(input);
    },
    farDeadline() {
      return new Date(Date.now() + 10 * 60_000).toISOString();
    },
    async seedGraphEntities(entityIds) {
      const chunks: ChunkRecord[] = entityIds.map((id) => ({
        id,
        content: `scope authority test entity ${id}`,
        embedding: new Array<number>(DIMENSIONS).fill(0),
        source_ref: "structured-scope-uow-fixture",
        metadata: {},
        valid_from: clock().toISOString(),
        valid_until: null,
        created_at: clock().toISOString(),
      }));
      if (chunks.length > 0) await backend.upsert(chunks);
    },
    async failNextOutboxWrite() {
      outbox.failNextPreparation();
    },
    async delayNextOutboxWrite(milliseconds) {
      outbox.delayNextPreparation(milliseconds);
    },
    async readOutboxCount(scopeBinding) {
      return outbox.count(scopeBinding);
    },
    close: () => backend.close(),
  };
}

async function registerVersion(
  port: ScopeTestPort,
  sourceRef: string,
  sourceVersion: string,
  content = `${sourceRef}:${sourceVersion}:original`
): Promise<SeededVersion> {
  const { record } = await port.evidence.registerSourceVersion({
    source_ref: sourceRef,
    source_version: sourceVersion,
    content_digest: opaqueDigest(content),
    origin_object_ref: `objects/${sourceRef}/${sourceVersion}.html`,
    parser_revision: "frozen-html-units-v1",
    unit_manifest: { units: 5, parser_revision: "frozen-html-units-v1" },
    created_at: port.clock().toISOString(),
  });
  const locator = {
    document_id: `${sourceRef}-document`,
    version: `frozen-${sourceVersion}`,
    unit: 1,
  };
  const locatorBindings = Array.from({ length: 5 }, (_, index) => ({
    source_version_id: record.source_version_id,
    ...locator,
    unit: index + 1,
  }));
  for (const binding of locatorBindings) {
    await port.evidence.bindSourceLocator(binding);
  }
  return { record, locator, locatorBindings };
}

async function declareDesired(
  port: ScopeTestPort,
  scopeBinding: string,
  authorizedSourceRefs: readonly string[],
  seeded: SeededVersion,
  extractionRevision: number,
  configRevision = "extractor-v1"
): Promise<{ readonly generation: number }> {
  return port.publication.declareDesired({
    scopeBinding,
    authorizedSourceRefs,
    sourceRef: seeded.record.source_ref,
    sourceVersion: seeded.record,
    locatorBindings: seeded.locatorBindings,
    desiredExtractionRevision: extractionRevision,
    configRevision,
  });
}

/** Trusted owner grant: an owner scope is admitted with a known revision. */
async function admitScope(
  port: ScopeTestPort,
  scopeBinding: string,
  authorizationRevision: string
): Promise<void> {
  await port.evidence.setScopeRevisions(scopeBinding, {
    authorizationRevision,
    purgeRevision: `purge-${authorizationRevision}`,
  });
}

async function startAttempt(
  port: ScopeTestPort,
  sourceRef: string,
  sourceGeneration: number
): Promise<Attempt> {
  const deps = { store: port.work, clock: port.clock };
  const scheduled = await scheduleWork(
    deps,
    { actorId: ACTOR },
    publishRequest(sourceRef, sourceGeneration)
  );
  const job = requireScheduled(scheduled);
  const claimed = await claimNextWork(deps);
  const guard = requireGuard(claimed.guard);
  expect(guard.jobKey).toBe(job.jobKey);
  return {
    guard,
    live: {
      configRevision: "extractor-v1",
      dependencies: [
        {
          sourceRef,
          generation: sourceGeneration,
          extractionRevision: null,
          relationBuckets: [],
        },
      ],
    },
  };
}

async function stageAttempt(
  port: ScopeTestPort,
  scopeBinding: string,
  sourceRef: string,
  guard: MaintenanceAttemptGuard,
  extractionRef: string,
  accepted: readonly PublicationFact[]
): Promise<void> {
  await port.seedGraphEntities(
    accepted.flatMap((fact) =>
      fact.identity.kind === "entity" ? [fact.identity.input.entityId] : []
    )
  );
  const staged = await port.publication.stageAttempt({
    scopeBinding,
    sourceRef,
    guard,
    extractionRef,
    accepted,
  });
  expect(staged).toMatchObject({ staged: true });
}

async function publish(
  port: ScopeTestPort,
  scopeBinding: string,
  sourceRef: string,
  guard: MaintenanceAttemptGuard
): Promise<unknown> {
  return port.publication.publish({
    scopeBinding,
    sourceRef,
    guard,
    at: port.clock().toISOString(),
  });
}

/** One published source with a single entity subject, for authority probes. */
async function publishOneEntity(
  port: ScopeTestPort,
  scopeBinding: string,
  sourceRef: string,
  seeded: SeededVersion,
  generation: number,
  entityId: string
): Promise<{ readonly jobKey: string; readonly resultId: string }> {
  const attempt = await startAttempt(port, sourceRef, generation);
  await stageAttempt(port, scopeBinding, sourceRef, attempt.guard, "extract", [
    entityFact(seeded, entityId, "extract", `Name ${entityId}`),
  ]);
  const published = await publish(port, scopeBinding, sourceRef, attempt.guard);
  expect(published).toMatchObject({ published: true });
  return { jobKey: attempt.guard.jobKey, resultId: entityId };
}

/** Owner-side withdrawal: leaves the source inactive and unowned. */
async function withdrawSource(
  port: ScopeTestPort,
  scopeBinding: string,
  sourceRef: string,
  expectedGeneration: number
): Promise<{ readonly generation: number }> {
  return port.publication.withdraw({
    scopeBinding,
    sourceRef,
    expectedGeneration,
    at: port.clock().toISOString(),
  });
}

const openPorts: ScopeTestPort[] = [];

async function open(): Promise<ScopeTestPort> {
  const port = await openMemoryPort();
  openPorts.push(port);
  return port;
}

afterEach(async () => {
  await Promise.all(openPorts.splice(0).map((port) => port.close()));
});

describe("authorized scope unit of work — memory authority", () => {
  it("refuses a context whose scope lost its current authorization before running any write", async () => {
    const port = await open();
    const sourceRef = unique("revoked-source");
    const scopeBinding = unique("revoked-scope");
    const seeded = await registerVersion(port, sourceRef, "v1");
    await admitScope(port, scopeBinding, "auth-1");
    const generation = (
      await declareDesired(port, scopeBinding, [sourceRef], seeded, 1)
    ).generation;
    const before = await port.publication.readSnapshot({ scopeBinding });
    const stale = port.authorizedContext({
      actorId: ACTOR,
      ownerScopeBinding: scopeBinding,
      readerBinding: "reader-1",
      authorizedSourceRefs: [sourceRef],
      authorizationRevision: "auth-1",
      deadlineAt: port.farDeadline(),
    });
    await admitScope(port, scopeBinding, "auth-2");
    let invoked = false;

    const code = await codeOf(
      withAuthorizedScope(stale, async () => {
        invoked = true;
      })
    );

    expect(code).toBe("access_denied");
    expect(invoked).toBe(false);
    const after = await port.publication.readSnapshot({ scopeBinding });
    expect(after).toEqual(before);
    expect(sourceRow(after, sourceRef)?.generation).toBe(generation);
    expect(after.readRevision).toBe(before.readRevision);
    expect(after.maintenanceRevision).toBe(before.maintenanceRevision);
    expect(await port.readOutboxCount(scopeBinding)).toBe(0);
  });

  it("refuses a trusted set that names a source owned by another scope before running any write", async () => {
    const port = await open();
    const ownedSource = unique("other-owner-source");
    const ownedScope = unique("other-owner-scope");
    const callerScope = unique("caller-scope");
    const callerSource = unique("caller-own-source");
    const seeded = await registerVersion(port, ownedSource, "v1");
    const callerSeeded = await registerVersion(port, callerSource, "v1");
    await admitScope(port, ownedScope, "auth-1");
    await admitScope(port, callerScope, "auth-1");
    await declareDesired(port, ownedScope, [ownedSource], seeded, 1);
    // The caller is a real registered owner of its own source, so the only
    // anomaly left is the foreign reference inside its trusted set.
    await declareDesired(port, callerScope, [callerSource], callerSeeded, 1);
    const ownerBefore = await port.publication.readSnapshot({
      scopeBinding: ownedScope,
    });
    const callerBefore = await port.publication.readSnapshot({
      scopeBinding: callerScope,
    });
    let invoked = false;

    const code = await codeOf(
      withAuthorizedScope(
        port.authorizedContext({
          actorId: ACTOR,
          ownerScopeBinding: callerScope,
          readerBinding: "reader-1",
          authorizedSourceRefs: [ownedSource, callerSource],
          authorizationRevision: "auth-1",
          deadlineAt: port.farDeadline(),
        }),
        async () => {
          invoked = true;
        }
      )
    );

    // Either verdict is an authority refusal for a set this context was never
    // granted: a source nobody owns was not granted to it, and a source another
    // scope owns is a binding it cannot take. What must never vary is that the
    // refusal happens before a single write.
    expect(["access_denied", "unsupported_source_binding"]).toContain(code);
    expect(invoked).toBe(false);
    expect(await port.publication.readSnapshot({ scopeBinding: callerScope })).toEqual(
      callerBefore
    );
    expect(await port.publication.readSnapshot({ scopeBinding: ownedScope })).toEqual(
      ownerBefore
    );
    expect(sourceRow(callerBefore, callerSource)?.generation).toBe(1);
    expect(sourceRow(ownerBefore, ownedSource)?.generation).toBe(1);
    expect(ownerBefore.maintenance.sourcesInScope).toBe(1);
    expect(await port.readOutboxCount(ownedScope)).toBe(0);
    expect(await port.readOutboxCount(callerScope)).toBe(0);
  });

  it("refuses an empty authorized source set without creating scope state", async () => {
    const port = await open();
    const scopeBinding = unique("empty-set-scope");
    await admitScope(port, scopeBinding, "auth-1");
    let invoked = false;

    const code = await codeOf(
      withAuthorizedScope(
        port.authorizedContext({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-1",
          authorizedSourceRefs: [],
          authorizationRevision: "auth-1",
          deadlineAt: port.farDeadline(),
        }),
        async () => {
          invoked = true;
        }
      )
    );

    expect(code).toBe("invalid_input");
    expect(invoked).toBe(false);
    const snapshot = await port.publication.readSnapshot({ scopeBinding });
    expect(snapshot.sources).toEqual([]);
    expect(snapshot.subjects).toEqual([]);
  });

  it("refuses a caller-supplied source array wider than the trusted context", async () => {
    const port = await open();
    const visibleSource = unique("visible-source");
    const hiddenSource = unique("wider-hidden-source");
    const visibleScope = unique("visible-scope");
    const hiddenScope = unique("hidden-scope");
    const visible = await registerVersion(port, visibleSource, "v1");
    const hidden = await registerVersion(port, hiddenSource, "v1");
    await admitScope(port, visibleScope, "auth-1");
    await admitScope(port, hiddenScope, "auth-1");
    const visibleGeneration = (
      await declareDesired(port, visibleScope, [visibleSource], visible, 1)
    ).generation;
    const hiddenGeneration = (
      await declareDesired(port, hiddenScope, [hiddenSource], hidden, 1)
    ).generation;
    await publishOneEntity(
      port,
      hiddenScope,
      hiddenSource,
      hidden,
      hiddenGeneration,
      UUIDS[2]
    );
    const before = await port.publication.readSnapshot({
      scopeBinding: visibleScope,
    });
    const hiddenBefore = await port.publication.readSnapshot({
      scopeBinding: hiddenScope,
    });

    let invoked = false;
    let innerCode = "not_run";
    let observedResults: string[] = [];
    const outerCode = await codeOf(
      withAuthorizedScope(
        port.authorizedContext({
          actorId: ACTOR,
          ownerScopeBinding: visibleScope,
          readerBinding: "reader-1",
          authorizedSourceRefs: [visibleSource],
          authorizationRevision: "auth-1",
          deadlineAt: port.farDeadline(),
        }),
        async (scope: ScopedInputView) => {
          invoked = true;
          try {
            const wider = await scope.readAcceptedInputs([
              visibleSource,
              hiddenSource,
            ]);
            observedResults = resultIdsOf(wider.memberships);
          } catch (error) {
            innerCode = errorCodeOf(error);
            throw error;
          }
        }
      )
    );

    expect(invoked).toBe(true);
    expect(innerCode).toBe("access_denied");
    expect(outerCode).toBe("access_denied");
    expect(observedResults).toEqual([]);
    const after = await port.publication.readSnapshot({
      scopeBinding: visibleScope,
    });
    expect(after).toEqual(before);
    expect(currentIds(after)).not.toContain(UUIDS[2]);
    expect(await port.publication.readSnapshot({ scopeBinding: hiddenScope })).toEqual(
      hiddenBefore
    );
    expect(sourceRow(after, visibleSource)?.generation).toBe(visibleGeneration);
    expect(await port.readOutboxCount(visibleScope)).toBe(0);

    // A wider set handed to the run itself must not widen its locks either.
    let optionsInvoked = false;
    let optionsObserved: string[] = [];
    const optionsCode = await codeOf(
      withAuthorizedScope(
        port.authorizedContext({
          actorId: ACTOR,
          ownerScopeBinding: visibleScope,
          readerBinding: "reader-1",
          authorizedSourceRefs: [visibleSource],
          authorizationRevision: "auth-1",
          deadlineAt: port.farDeadline(),
        }),
        async (scope: ScopedInputView) => {
          optionsInvoked = true;
          optionsObserved = refsOf(
            (await scope.readAcceptedInputs([visibleSource])).sources
          );
        },
        { additionalSourceRefs: [hiddenSource] }
      )
    );

    expect(optionsCode).toBe("access_denied");
    expect(optionsInvoked).toBe(false);
    expect(optionsObserved).toEqual([]);
    expect(await port.publication.readSnapshot({ scopeBinding: hiddenScope })).toEqual(
      hiddenBefore
    );
  });

  it("serves only active scoped sources and keeps a zero-hit source in the view", async () => {
    const port = await open();
    const hitSource = unique("view-hit");
    const zeroSource = unique("view-zero");
    const hiddenSource = unique("view-hidden");
    const scopeBinding = unique("view-scope");
    const hiddenScope = unique("view-hidden-scope");
    const hit = await registerVersion(port, hitSource, "v1");
    const zero = await registerVersion(port, zeroSource, "v1");
    const hidden = await registerVersion(port, hiddenSource, "v1");
    await admitScope(port, scopeBinding, "auth-1");
    await admitScope(port, hiddenScope, "auth-1");
    const authorizedSourceRefs = [hitSource, zeroSource];
    const hitGeneration = (
      await declareDesired(port, scopeBinding, authorizedSourceRefs, hit, 1)
    ).generation;
    const zeroGeneration = (
      await declareDesired(port, scopeBinding, authorizedSourceRefs, zero, 1)
    ).generation;
    const hitAccepted = await publishOneEntity(
      port,
      scopeBinding,
      hitSource,
      hit,
      hitGeneration,
      UUIDS[0]
    );
    const zeroAttempt = await startAttempt(port, zeroSource, zeroGeneration);
    await stageAttempt(port, scopeBinding, zeroSource, zeroAttempt.guard, "extract-zero", []);
    await publish(port, scopeBinding, zeroSource, zeroAttempt.guard);
    const zeroSettled = await port.work.getJob(zeroAttempt.guard.jobKey);
    if (!zeroSettled) throw new Error("test setup left zero-hit work unstored");
    const hiddenGeneration = (
      await declareDesired(port, hiddenScope, [hiddenSource], hidden, 1)
    ).generation;
    await publishOneEntity(
      port,
      hiddenScope,
      hiddenSource,
      hidden,
      hiddenGeneration,
      UUIDS[2]
    );

    const views = await withAuthorizedScope(
      port.authorizedContext({
        actorId: ACTOR,
        ownerScopeBinding: scopeBinding,
        readerBinding: "reader-1",
        authorizedSourceRefs,
        authorizationRevision: "auth-1",
        deadlineAt: port.farDeadline(),
      }),
      async (scope) => ({
        accepted: await scope.readAcceptedInputs(authorizedSourceRefs),
        maintenance: await scope.readMaintenanceInputs(authorizedSourceRefs),
      })
    );
    const owner = await port.publication.readSnapshot({ scopeBinding });

    expect(refsOf(views.accepted.sources)).toEqual(
      [hitSource, zeroSource].sort()
    );
    expect(views.accepted.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRef: hitSource,
          sourceVersion: "v1",
          generation: hitGeneration,
          active: true,
        }),
        expect.objectContaining({
          sourceRef: zeroSource,
          generation: zeroGeneration,
          active: true,
        }),
      ])
    );
    expect(refsOf(views.maintenance.sources)).toEqual([hitSource, zeroSource].sort());
    expect(supportIdsOf(views.accepted.memberships)).toContain(
      supportIdFor(owner, UUIDS[0])
    );
    expect(resultIdsOf(views.accepted.memberships)).toContain(hitAccepted.resultId);
    expect(refsOf(views.accepted.memberships)).not.toContain(hiddenSource);
    expect(resultIdsOf(views.accepted.memberships)).not.toContain(UUIDS[2]);
    expect(
      views.maintenance.work.map((work) => work.sourceRef).sort()
    ).toEqual([hitSource, zeroSource]);
    expect(
      views.maintenance.work.every((work) => work.status === "ready")
    ).toBe(true);
    // The work rows must be the owner ledger's own records for this subset:
    // a per-reader copy or an invented second record breaks shared authority.
    expect(
      views.maintenance.work.map((work) => work.jobKey).sort()
    ).toEqual([hitAccepted.jobKey, zeroSettled.jobKey].sort());
  });

  it("refuses a source that left the trusted set during discovery without touching the rest of the scope", async () => {
    const port = await open();
    const keptSource = unique("kept-source");
    const droppedSource = unique("dropped-source");
    const scopeBinding = unique("discovery-scope");
    const kept = await registerVersion(port, keptSource, "v1");
    const dropped = await registerVersion(port, droppedSource, "v1");
    await admitScope(port, scopeBinding, "auth-1");
    const authorizedSourceRefs = [keptSource, droppedSource];
    const keptGeneration = (
      await declareDesired(port, scopeBinding, authorizedSourceRefs, kept, 1)
    ).generation;
    await declareDesired(port, scopeBinding, authorizedSourceRefs, dropped, 1);
    await publishOneEntity(
      port,
      scopeBinding,
      keptSource,
      kept,
      keptGeneration,
      UUIDS[0]
    );
    const context = port.authorizedContext({
      actorId: ACTOR,
      ownerScopeBinding: scopeBinding,
      readerBinding: "reader-1",
      authorizedSourceRefs,
      authorizationRevision: "auth-1",
      deadlineAt: port.farDeadline(),
    });
    const before = await port.publication.readSnapshot({ scopeBinding });
    const withdrawn = await port.publication.withdraw({
      scopeBinding,
      sourceRef: droppedSource,
      expectedGeneration: 1,
      at: port.clock().toISOString(),
    });
    expect(withdrawn.generation).toBe(2);
    const afterWithdrawal = await port.publication.readSnapshot({ scopeBinding });

    await expectFailure(
      withAuthorizedScope(context, async (scope) =>
        scope.readAcceptedInputs(authorizedSourceRefs)
      ),
      "input_stale"
    );

    const after = await port.publication.readSnapshot({ scopeBinding });
    expect(after).toEqual(afterWithdrawal);
    expect(after.readRevision).toBe(afterWithdrawal.readRevision);
    expect(after.maintenanceRevision).not.toBe(before.maintenanceRevision);
    expect(currentIds(after)).toEqual([UUIDS[0]]);
    expect(sourceRow(after, keptSource)?.published).toEqual({
      sourceVersion: "v1",
      extractionRevision: 1,
    });
  });

  it("refuses an expired execution deadline before running any write", async () => {
    const port = await open();
    const sourceRef = unique("deadline-source");
    const scopeBinding = unique("deadline-scope");
    const seeded = await registerVersion(port, sourceRef, "v1");
    await admitScope(port, scopeBinding, "auth-1");
    const generation = (
      await declareDesired(port, scopeBinding, [sourceRef], seeded, 1)
    ).generation;
    const before = await port.publication.readSnapshot({ scopeBinding });
    let invoked = false;

    await expectFailure(
      withAuthorizedScope(
        port.authorizedContext({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-1",
          authorizedSourceRefs: [sourceRef],
          authorizationRevision: "auth-1",
          deadlineAt: new Date(Date.now() - 1_000).toISOString(),
        }),
        async () => {
          invoked = true;
        }
      ),
      "execution_timeout"
    );

    expect(invoked).toBe(false);
    const after = await port.publication.readSnapshot({ scopeBinding });
    expect(after).toEqual(before);
    expect(sourceRow(after, sourceRef)?.generation).toBe(generation);
    expect(await port.readOutboxCount(scopeBinding)).toBe(0);
  });

  it("refuses a deadline that expires while preparation is awaited", async () => {
    const port = await open();
    const sourceRef = unique("mid-deadline-source");
    const scopeBinding = unique("mid-deadline-scope");
    const seeded = await registerVersion(port, sourceRef, "v1");
    await admitScope(port, scopeBinding, "auth-1");
    await declareDesired(port, scopeBinding, [sourceRef], seeded, 1);
    const before = await port.publication.readSnapshot({ scopeBinding });
    const deadlineAt = new Date(Date.now() + 40).toISOString();

    await expectFailure(
      withAuthorizedScope(
        port.authorizedContext({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-1",
          authorizedSourceRefs: [sourceRef],
          authorizationRevision: "auth-1",
          deadlineAt,
        }),
        async (scope) => {
          await scope.readAcceptedInputs([sourceRef]);
          await sleep(90);
          expect(Date.now()).toBeGreaterThanOrEqual(
            new Date(deadlineAt).getTime()
          );
        }
      ),
      "execution_timeout"
    );

    const after = await port.publication.readSnapshot({ scopeBinding });
    expect(after).toEqual(before);
    expect(await port.readOutboxCount(scopeBinding)).toBe(0);
  });

  it("advances the scope revision exactly once when a prepared mutation commits through the seam", async () => {
    const port = await open();
    const sourceRef = unique("mem-seam-write-source");
    const scopeBinding = unique("mem-seam-write-scope");
    const seeded = await registerVersion(port, sourceRef, "v1");
    await admitScope(port, scopeBinding, "auth-1");
    await declareDesired(port, scopeBinding, [sourceRef], seeded, 1);
    const seam =
      port.authority as unknown as StructuredScopeUnitOfWork<PreparedMemoryScopeWork>;
    const marker = { kind: "entity" as const, id: randomUUID() };
    const before = await port.publication.readSnapshot({ scopeBinding });

    await seam.withAuthorizedScope(
      port.authorizedContext({
        actorId: ACTOR,
        ownerScopeBinding: scopeBinding,
        readerBinding: "reader-1",
        authorizedSourceRefs: [sourceRef],
        authorizationRevision: "auth-1",
        deadlineAt: port.farDeadline(),
      }),
      async (work) => {
        // The commit closure is prepared before visibility but applied only in the
        // final synchronous slice, beside the one deferred revision advance; both
        // must land together, exactly once.
        const commit = await port.outbox.prepareIntents(scopeBinding, [marker]);
        work.prepare(commit);
        work.bumpRevisions({ read: true, maintenance: true });
      }
    );

    expect(await port.readOutboxCount(scopeBinding)).toBe(1);
    const after = await port.publication.readSnapshot({ scopeBinding });
    expect(Number(after.readRevision)).toBe(Number(before.readRevision) + 1);
    expect(Number(after.maintenanceRevision)).toBe(
      Number(before.maintenanceRevision) + 1
    );
  });

  it("applies neither the prepared mutation nor the revision bump when the deadline expires in the commit window", async () => {
    const port = await open();
    const sourceRef = unique("mem-seam-rollback-source");
    const scopeBinding = unique("mem-seam-rollback-scope");
    const seeded = await registerVersion(port, sourceRef, "v1");
    await admitScope(port, scopeBinding, "auth-1");
    await declareDesired(port, scopeBinding, [sourceRef], seeded, 1);
    const seam =
      port.authority as unknown as StructuredScopeUnitOfWork<PreparedMemoryScopeWork>;
    const marker = { kind: "entity" as const, id: randomUUID() };
    const before = await port.publication.readSnapshot({ scopeBinding });
    const deadlineAt = new Date(Date.now() + 40).toISOString();

    await expectFailure(
      seam.withAuthorizedScope(
        port.authorizedContext({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-1",
          authorizedSourceRefs: [sourceRef],
          authorizationRevision: "auth-1",
          deadlineAt,
        }),
        async (work) => {
          const commit = await port.outbox.prepareIntents(scopeBinding, [marker]);
          work.prepare(commit);
          work.bumpRevisions({ read: true, maintenance: true });
          // Preparation fully succeeded; the deadline crosses only now, after the
          // callback returned, so the commit slice must refuse before applying.
          await sleep(90);
        }
      ),
      "execution_timeout"
    );

    expect(await port.readOutboxCount(scopeBinding)).toBe(0);
    const after = await port.publication.readSnapshot({ scopeBinding });
    expect(after).toEqual(before);
    expect(after.readRevision).toBe(before.readRevision);
    expect(after.maintenanceRevision).toBe(before.maintenanceRevision);
  });

  it("gives up with a typed stale input once repeated source-set changes exhaust internal routing", async () => {
    const port = await open();
    const sourceRef = unique("routing-source");
    const scopeBinding = unique("routing-scope");
    const seeded = await registerVersion(port, sourceRef, "v1");
    await admitScope(port, scopeBinding, "auth-1");
    const generation = (
      await declareDesired(port, scopeBinding, [sourceRef], seeded, 1)
    ).generation;
    await publishOneEntity(
      port,
      scopeBinding,
      sourceRef,
      seeded,
      generation,
      UUIDS[0]
    );
    const context = port.authorizedContext({
      actorId: ACTOR,
      ownerScopeBinding: scopeBinding,
      readerBinding: "reader-1",
      authorizedSourceRefs: [sourceRef],
      authorizationRevision: "auth-1",
      deadlineAt: port.farDeadline(),
    });
    port.outbox.resetPreparations();
    // Only the churn's own accepted projection effects may appear from here on.
    port.outbox.resetCounts();

    // The source repeatedly leaves and re-enters the active owner set, so every
    // re-discovery sees a different affected set. Only a reservation-first router
    // with a bounded attempt budget can settle this call instead of spinning,
    // silently publishing one attempt, or serialising the owner behind it.
    const churnBudget = 40;
    const routedRevision = 900;
    let stop = false;
    let churnGeneration = generation;
    let churnOps = 0;
    const churn = (async () => {
      while (!stop && churnOps < churnBudget) {
        churnOps += 1;
        const outcome =
          churnOps % 2 === 1
            ? await withdrawSource(
                port,
                scopeBinding,
                sourceRef,
                churnGeneration
              )
            : await declareDesired(
                port,
                scopeBinding,
                [sourceRef],
                seeded,
                churnOps + 1
              );
        churnGeneration = outcome.generation;
      }
    })();
    const code = await codeOf(
      withAuthorizedScope(context, async (scope) => {
        await scope.readAcceptedInputs([sourceRef]);
        // Accepted owner changes land while this unit of work has prepared its
        // inputs but has not committed them yet.
        await sleep(30);
        await scope.readMaintenanceInputs([sourceRef]);
      })
    );
    stop = true;
    await churn;
    // Close the churn deterministically so the expected final state is derived
    // from the issued operations rather than from whatever the churn reached.
    const settledGeneration = (
      await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        seeded,
        routedRevision
      )
    ).generation;
    const after = await port.publication.readSnapshot({ scopeBinding });

    expect(code).toBe("input_stale");
    // Each refused routing attempt may re-prepare, but never beyond its budget;
    // one preparation per accepted churn operation plus three attempts.
    expect(port.outbox.preparations()).toBeLessThanOrEqual(churnOps + 3);
    // The refused call committed no projection effect at all.
    expect(await port.readOutboxCount(scopeBinding)).toBe(1);
    expect(sourceRow(after, sourceRef)?.generation).toBe(settledGeneration);
    expect(settledGeneration).toBeGreaterThan(generation);
    expect(sourceRow(after, sourceRef)?.active).toBe(true);
    expect(sourceRow(after, sourceRef)?.published).toBeNull();
    expect(sourceRow(after, sourceRef)?.desired).toMatchObject({
      sourceVersion: "v1",
      extractionRevision: routedRevision,
    });
    expect(currentIds(after)).toEqual([]);
  });

  it("refuses the publication path once the attempt outlives its absolute bound", async () => {
    const port = await open();
    const sourceRef = unique("absolute-bound-source");
    const scopeBinding = unique("absolute-bound-scope");
    const seeded = await registerVersion(port, sourceRef, "v1");
    await admitScope(port, scopeBinding, "auth-1");
    const generation = (
      await declareDesired(port, scopeBinding, [sourceRef], seeded, 1)
    ).generation;
    // The write fence is measured against real time, so the attempt is claimed
    // with an already expired start stamp instead of waiting out the limit. The
    // lease is expired by the same stamp, so only a correct precedence of the
    // absolute bound over lease loss can report the timeout.
    port.clock.set(new Date(Date.now() - WORK_ABSOLUTE_LIMIT_MS - 1_000));
    const attempt = await startAttempt(port, sourceRef, generation);
    const before = await port.publication.readSnapshot({ scopeBinding });
    const outboxBefore = await port.readOutboxCount(scopeBinding);

    await expectFailure(
      port.publication.publish({
        scopeBinding,
        sourceRef,
        guard: attempt.guard,
        at: new Date().toISOString(),
      }),
      "execution_timeout"
    );

    const after = await port.publication.readSnapshot({ scopeBinding });
    expect(after).toEqual(before);
    expect(currentIds(after)).toEqual([]);
    expect(await port.readOutboxCount(scopeBinding)).toBe(outboxBefore);
    expect(await port.work.getJob(attempt.guard.jobKey)).toMatchObject({
      status: "running",
      attemptCount: 1,
    });
  });

  it("reports the primary typed failure and rolls every authority back when the projection write fails", async () => {
    const port = await open();
    const sourceRef = unique("projection-fault-source");
    const scopeBinding = unique("projection-fault-scope");
    const seeded = await registerVersion(port, sourceRef, "v1");
    await admitScope(port, scopeBinding, "auth-1");
    const generation = (
      await declareDesired(port, scopeBinding, [sourceRef], seeded, 1)
    ).generation;
    const attempt = await startAttempt(port, sourceRef, generation);
    const relationNorm = unique("fault_relation");
    await stageAttempt(
      port,
      scopeBinding,
      sourceRef,
      attempt.guard,
      "extract-fault",
      [
        entityFact(seeded, UUIDS[0], "extract-fault", "Head"),
        entityFact(seeded, UUIDS[1], "extract-fault", "Tail", 3),
        assertionFact(seeded, "extract-fault", relationNorm),
      ]
    );
    const before = await port.publication.readSnapshot({ scopeBinding });
    const assertionId = derivedAssertionId(relationNorm);
    expect(await port.identity.findRelationAssertion(assertionId)).toBeNull();
    port.outbox.failNextPreparation();

    let thrown: unknown;
    try {
      await publish(port, scopeBinding, sourceRef, attempt.guard);
    } catch (error) {
      thrown = error;
    }

    expect(outcomeCode(thrown)).toBe("backend_unavailable");
    expect(await port.identity.findRelationAssertion(assertionId)).toBeNull();
    const after = await port.publication.readSnapshot({ scopeBinding });
    expect(after).toEqual(before);
    expect(currentIds(after)).toEqual([]);
    expect(await port.readOutboxCount(scopeBinding)).toBe(0);
    expect(await port.work.getJob(attempt.guard.jobKey)).toMatchObject({
      status: "running",
    });
  });

  it("keeps the primary typed failure when the commit step itself fails and keeps rollback diagnostics safe", async () => {
    const port = await open();
    const sourceRef = unique("commit-fault-source");
    const scopeBinding = unique("commit-fault-scope");
    const seeded = await registerVersion(port, sourceRef, "v1");
    await admitScope(port, scopeBinding, "auth-1");
    const generation = (
      await declareDesired(port, scopeBinding, [sourceRef], seeded, 1)
    ).generation;
    const attempt = await startAttempt(port, sourceRef, generation);
    await stageAttempt(
      port,
      scopeBinding,
      sourceRef,
      attempt.guard,
      "extract-commit-fault",
      [entityFact(seeded, UUIDS[0], "extract-commit-fault", "Commit fault")]
    );
    const before = await port.publication.readSnapshot({ scopeBinding });
    port.outbox.failNextCommit(INJECTED_COMMIT_DETAIL);

    let thrown: unknown;
    try {
      await publish(port, scopeBinding, sourceRef, attempt.guard);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    // A storage fault that carries no code of its own is still a named backend
    // failure: masking it would lose the reason the caller has to branch on.
    expect(errorCodeOf(thrown)).toBe("backend_unavailable");
    // Rollback metadata stays safe: only error names and SQLSTATE-shaped codes,
    // never the injected message text or any SQL fragment.
    const suppressed = getSuppressedFailureContext(thrown);
    expect(
      suppressed.every(
        (entry) =>
          !JSON.stringify(entry).includes("SECRET-LEAK") &&
          !JSON.stringify(entry).toLowerCase().includes("insert")
      )
    ).toBe(true);
    const after = await port.publication.readSnapshot({ scopeBinding });
    expect(currentIds(after)).toEqual(currentIds(before));
    expect(after.readRevision).toBe(before.readRevision);
    expect(after.maintenanceRevision).toBe(before.maintenanceRevision);
    expect(await port.readOutboxCount(scopeBinding)).toBe(0);
  });

  it("leaves the last accepted state intact across a sequence of refused and restarted attempts", async () => {
    const port = await open();
    const keptSource = unique("refusal-sequence-kept");
    const droppedSource = unique("refusal-sequence-dropped");
    const scopeBinding = unique("refusal-sequence-scope");
    const kept = await registerVersion(port, keptSource, "v1");
    const dropped = await registerVersion(port, droppedSource, "v1");
    await admitScope(port, scopeBinding, "auth-1");
    const authorizedSourceRefs = [keptSource, droppedSource];
    const keptGeneration = (
      await declareDesired(port, scopeBinding, authorizedSourceRefs, kept, 1)
    ).generation;
    await declareDesired(port, scopeBinding, authorizedSourceRefs, dropped, 1);
    const acceptedAttempt = await startAttempt(port, keptSource, keptGeneration);
    await stageAttempt(
      port,
      scopeBinding,
      keptSource,
      acceptedAttempt.guard,
      "extract-sequence",
      [entityFact(kept, UUIDS[0], "extract-sequence", "Kept entity")]
    );
    expect(
      await publish(port, scopeBinding, keptSource, acceptedAttempt.guard)
    ).toMatchObject({ published: true });
    await port.publication.withdraw({
      scopeBinding,
      sourceRef: droppedSource,
      expectedGeneration: 1,
      at: port.clock().toISOString(),
    });
    const accepted = await port.publication.readSnapshot({ scopeBinding });
    const acceptedOutbox = await port.readOutboxCount(scopeBinding);
    const acceptedLedger = await port.work.getJob(acceptedAttempt.guard.jobKey);
    const readView = async (scope: ScopedInputView) =>
      scope.readAcceptedInputs([keptSource]);
    expect(currentIds(accepted)).toEqual([UUIDS[0]]);

    await expectFailure(
      withAuthorizedScope(
        port.authorizedContext({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-1",
          authorizedSourceRefs: [keptSource, droppedSource],
          authorizationRevision: "auth-1",
          deadlineAt: port.farDeadline(),
        }),
        readView
      ),
      "input_stale"
    );
    await expectFailure(
      withAuthorizedScope(
        port.authorizedContext({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-1",
          authorizedSourceRefs: [keptSource],
          authorizationRevision: "auth-1",
          deadlineAt: new Date(Date.now() - 1_000).toISOString(),
        }),
        readView
      ),
      "execution_timeout"
    );
    // The attempt that already settled has no write fence left.
    await expectFailure(
      publish(port, scopeBinding, keptSource, acceptedAttempt.guard),
      "lease_lost"
    );

    expect(await port.publication.readSnapshot({ scopeBinding })).toEqual(
      accepted
    );
    expect(await port.readOutboxCount(scopeBinding)).toBe(acceptedOutbox);
    expect(await port.work.getJob(acceptedAttempt.guard.jobKey)).toEqual(
      acceptedLedger
    );
  });

  it("preserves concurrent identity, work and grant-source writes across a shared memory tail", async () => {
    const port = await open();
    const sourceRef = unique("shared-tail-source");
    const concurrentSource = unique("shared-tail-concurrent");
    const scopeBinding = unique("shared-tail-scope");
    const seeded = await registerVersion(port, sourceRef, "v1");
    const concurrent = await registerVersion(port, concurrentSource, "v1");
    await admitScope(port, scopeBinding, "auth-1");
    const generation = (
      await declareDesired(port, scopeBinding, [sourceRef], seeded, 1)
    ).generation;
    const concurrentGeneration = (
      await declareDesired(
        port,
        scopeBinding,
        [sourceRef, concurrentSource],
        concurrent,
        1
      )
    ).generation;
    const attempt = await startAttempt(port, sourceRef, generation);
    await stageAttempt(
      port,
      scopeBinding,
      sourceRef,
      attempt.guard,
      "extract-shared",
      [entityFact(seeded, UUIDS[0], "extract-shared", "Committed by the seam")]
    );

    // The outbox preparation is the seam's only await, so writes that land
    // while it is suspended must survive the commit rather than be replaced by
    // a snapshot taken before preparation.
    port.outbox.delayNextPreparation(60);
    const publishPromise = publish(port, scopeBinding, sourceRef, attempt.guard);
    await sleep(10);
    const relationNorm = "concurrent_relation";
    const identityWrite = port.identity.registerRelationAssertion({
      headEntityId: UUIDS[0],
      relationNorm,
      tailEntityId: UUIDS[1],
      validWindow: { from: null, until: null },
    });
    const workWrite = scheduleWork(
      { store: port.work, clock: port.clock },
      { actorId: ACTOR },
      publishRequest(concurrentSource, concurrentGeneration)
    );
    const grantWrite = port.evidence.setScopeRevisions(scopeBinding, {
      authorizationRevision: "auth-2",
    });
    const published = await publishPromise;
    expect(published).toMatchObject({ published: true });
    const [identityRecord, scheduledConcurrent, revisionRecord] =
      await Promise.all([identityWrite, workWrite, grantWrite]);

    expect(
      await port.identity.findRelationAssertion(identityRecord.assertionId)
    ).toMatchObject({ assertionId: identityRecord.assertionId });
    expect(
      await port.identity.findRelationAssertion(derivedAssertionId(relationNorm))
    ).not.toBeNull();
    const concurrentJob = requireScheduled(scheduledConcurrent);
    expect(
      await port.work.getJob(concurrentJob.jobKey)
    ).toMatchObject({
      sourceRef: concurrentSource,
      sourceGeneration: concurrentGeneration,
      status: "pending",
    });
    expect(revisionRecord.authorization_revision).toBe("auth-2");
    expect(revisionRecord.scope_binding).toBe(scopeBinding);

    const snapshot = await port.publication.readSnapshot({ scopeBinding });
    expect(currentIds(snapshot)).toContain(UUIDS[0]);
    expect(sourceRow(snapshot, sourceRef)?.published).toEqual({
      sourceVersion: "v1",
      extractionRevision: 1,
    });
    expect(snapshot.maintenance.sourcesInScope).toBe(2);
    const views = await withAuthorizedScope(
      port.authorizedContext({
        actorId: ACTOR,
        ownerScopeBinding: scopeBinding,
        readerBinding: "reader-1",
        authorizedSourceRefs: [sourceRef, concurrentSource],
        authorizationRevision: "auth-2",
        deadlineAt: port.farDeadline(),
      }),
      async (scope) =>
        scope.readMaintenanceInputs([sourceRef, concurrentSource])
    );
    expect(views.work.map((work) => work.jobKey)).toContain(concurrentJob.jobKey);
  });

  it("serves two disjoint reader subsets under one owner without duplicating owner state", async () => {
    const port = await open();
    const sourceA = unique("pair-source-a");
    const sourceB = unique("pair-source-b");
    const scopeBinding = unique("pair-scope");
    const a = await registerVersion(port, sourceA, "v1", "reader a payload");
    const b = await registerVersion(port, sourceB, "v1", "reader b payload");
    await admitScope(port, scopeBinding, "auth-1");
    const ownerRefs = [sourceA, sourceB];
    const generationA = (
      await declareDesired(port, scopeBinding, ownerRefs, a, 1)
    ).generation;
    const generationB = (
      await declareDesired(port, scopeBinding, ownerRefs, b, 1)
    ).generation;
    const publishedA = await publishOneEntity(
      port,
      scopeBinding,
      sourceA,
      a,
      generationA,
      UUIDS[0]
    );
    const publishedB = await publishOneEntity(
      port,
      scopeBinding,
      sourceB,
      b,
      generationB,
      UUIDS[1]
    );
    const owner = await port.publication.readSnapshot({ scopeBinding });
    const supportA = supportIdFor(owner, publishedA.resultId);
    const supportB = supportIdFor(owner, publishedB.resultId);

    const readerContext = (
      readerBinding: string,
      authorizedSourceRefs: readonly string[]
    ): AuthorizedScopeContext =>
      port.authorizedContext({
        actorId: ACTOR,
        ownerScopeBinding: scopeBinding,
        readerBinding,
        authorizedSourceRefs,
        authorizationRevision: "auth-1",
        deadlineAt: port.farDeadline(),
      });
    const readBoth = async (scope: ScopedInputView, refs: readonly string[]) => ({
      accepted: await scope.readAcceptedInputs(refs),
      maintenance: await scope.readMaintenanceInputs(refs),
    });

    const readerA = await withAuthorizedScope(
      readerContext("reader-a", [sourceA]),
      (scope) => readBoth(scope, [sourceA])
    );
    const readerB = await withAuthorizedScope(
      readerContext("reader-b", [sourceB]),
      (scope) => readBoth(scope, [sourceB])
    );

    expect(refsOf(readerA.accepted.sources)).toEqual([sourceA]);
    expect(refsOf(readerB.accepted.sources)).toEqual([sourceB]);
    expect(supportIdsOf(readerA.accepted.memberships)).toEqual([supportA]);
    expect(supportIdsOf(readerB.accepted.memberships)).toEqual([supportB]);
    expect(supportIdsOf(readerA.accepted.memberships)).not.toContain(supportB);
    expect(supportIdsOf(readerB.accepted.memberships)).not.toContain(supportA);
    expect(readerA.maintenance.work.map((work) => work.jobKey)).toEqual([
      publishedA.jobKey,
    ]);
    expect(readerB.maintenance.work.map((work) => work.jobKey)).toEqual([
      publishedB.jobKey,
    ]);
    expect(readerA.accepted.memberships.length).toBe(1);
    expect(readerB.accepted.memberships.length).toBe(1);

    expect(owner.sources.map((source) => source.sourceRef).sort()).toEqual(
      [...ownerRefs].sort()
    );
    expect(owner.maintenance.sourcesInScope).toBe(2);
    expect(owner.subjects).toHaveLength(2);
    expect(readerA.accepted.sources[0]?.generation).toBe(
      sourceRow(owner, sourceA)?.generation
    );

    // A reader binds to the live owner generation, never to a snapshot it
    // selected, so an unrelated owner change must be visible rather than
    // silently invalidated for the other reader's subset.
    const advancedA = (
      await declareDesired(port, scopeBinding, ownerRefs, a, 2, "extractor-v2")
    ).generation;
    expect(advancedA).toBe(generationA + 1);
    const reopenedB = await withAuthorizedScope(
      readerContext("reader-b", [sourceB]),
      (scope) => scope.readAcceptedInputs([sourceB])
    );
    const ownerAfterAdvance = await port.publication.readSnapshot({
      scopeBinding,
    });
    expect(reopenedB.sources).toEqual([
      expect.objectContaining({
        sourceRef: sourceB,
        generation: sourceRow(ownerAfterAdvance, sourceB)?.generation,
      }),
    ]);
    expect(sourceRow(ownerAfterAdvance, sourceB)?.generation).toBe(generationB);
    expect(sourceRow(ownerAfterAdvance, sourceA)?.generation).toBe(advancedA);
    expect(supportIdsOf(reopenedB.memberships)).toEqual([supportB]);
  });

  it("refuses a reader that selects another reader's subset inside the unit of work", async () => {
    const port = await open();
    const sourceA = unique("select-source-a");
    const sourceB = unique("select-source-b");
    const scopeBinding = unique("select-scope");
    const a = await registerVersion(port, sourceA, "v1", "select a payload");
    const b = await registerVersion(port, sourceB, "v1", "select b payload");
    await admitScope(port, scopeBinding, "auth-1");
    const ownerRefs = [sourceA, sourceB];
    const generationA = (
      await declareDesired(port, scopeBinding, ownerRefs, a, 1)
    ).generation;
    const generationB = (
      await declareDesired(port, scopeBinding, ownerRefs, b, 1)
    ).generation;
    await publishOneEntity(port, scopeBinding, sourceA, a, generationA, UUIDS[0]);
    await publishOneEntity(port, scopeBinding, sourceB, b, generationB, UUIDS[1]);
    const before = await port.publication.readSnapshot({ scopeBinding });
    const outboxBefore = await port.readOutboxCount(scopeBinding);

    let innerCode = "not_run";
    const outerCode = await codeOf(
      withAuthorizedScope(
        port.authorizedContext({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-a",
          authorizedSourceRefs: [sourceA],
          authorizationRevision: "auth-1",
          deadlineAt: port.farDeadline(),
        }),
        async (scope) => {
          try {
            await scope.readMaintenanceInputs([sourceB]);
          } catch (error) {
            innerCode = errorCodeOf(error);
            throw error;
          }
        }
      )
    );

    expect(innerCode).toBe("access_denied");
    expect(outerCode).toBe("access_denied");
    const after = await port.publication.readSnapshot({ scopeBinding });
    expect(after).toEqual(before);
    expect(await port.readOutboxCount(scopeBinding)).toBe(outboxBefore);
  });

  it("refuses a context that carries another scope's authorization revision", async () => {
    const port = await open();
    const sourceRef = unique("foreign-auth-source");
    const scopeBinding = unique("foreign-auth-scope");
    const otherScope = unique("other-auth-scope");
    const seeded = await registerVersion(port, sourceRef, "v1");
    await admitScope(port, scopeBinding, "auth-1");
    await admitScope(port, otherScope, "auth-9");
    await declareDesired(port, scopeBinding, [sourceRef], seeded, 1);
    const before = await port.publication.readSnapshot({ scopeBinding });
    let invoked = false;

    const code = await codeOf(
      withAuthorizedScope(
        port.authorizedContext({
          actorId: ACTOR,
          ownerScopeBinding: scopeBinding,
          readerBinding: "reader-1",
          authorizedSourceRefs: [sourceRef],
          authorizationRevision: "auth-9",
          deadlineAt: port.farDeadline(),
        }),
        async () => {
          invoked = true;
        }
      )
    );

    expect(code).toBe("access_denied");
    expect(invoked).toBe(false);
    expect(await port.publication.readSnapshot({ scopeBinding })).toEqual(before);
  });

  const workMutations = [
    "schedule",
    "claim",
    "heartbeat",
    "settle",
    "retry",
    "reclaim",
  ] as const;
  type WorkMutation = (typeof workMutations)[number];

  const expectedLedger: Record<
    WorkMutation,
    { status: MaintenanceJobRecord["status"]; attemptCount: number }
  > = {
    schedule: { status: "pending", attemptCount: 0 },
    claim: { status: "running", attemptCount: 1 },
    heartbeat: { status: "running", attemptCount: 1 },
    settle: { status: "failed", attemptCount: 1 },
    retry: { status: "pending", attemptCount: 1 },
    reclaim: { status: "pending", attemptCount: 1 },
  };

  it.each(workMutations)(
    "first owner assignment racing %s keeps one owner and its own ledger state",
    async (mutation) => {
      const port = await open();
      const sourceRef = unique(`race-${mutation}-source`);
      const scopeBinding = unique(`race-${mutation}-scope`);
      const otherScope = unique(`race-${mutation}-other`);
      const seeded = await registerVersion(port, sourceRef, "v1");
      await admitScope(port, scopeBinding, "auth-1");
      await admitScope(port, otherScope, "auth-1");
      const deps = { store: port.work, clock: port.clock };
      const dependencies: MaintenanceDependency[] = [
        {
          sourceRef,
          generation: 1,
          extractionRevision: null,
          relationBuckets: [],
        },
      ];
      const live: MaintenanceLiveInputs = {
        configRevision: "extractor-v1",
        dependencies,
      };

      // The job is scheduled by the standalone path while the source still has
      // no owner, which is exactly the state a first assignment must not orphan.
      const job = requireScheduled(
        await scheduleWork(
          deps,
          { actorId: ACTOR },
          publishRequest(sourceRef, 1, dependencies)
        )
      );
      let guard: MaintenanceAttemptGuard | null = null;
      // For the claim race the raced call is itself the first claim, so the job
      // has to stay pending until it runs against the incoming owner assignment.
      if (mutation !== "schedule" && mutation !== "claim") {
        guard = requireGuard((await claimNextWork(deps)).guard);
      }
      if (mutation === "retry") {
        expect(
          await settleWork(
            deps,
            requireGuard(guard),
            { status: "failed", failureCode: "invalid_input" },
            live
          )
        ).toMatchObject({ result: "settled" });
      }
      if (mutation === "reclaim") {
        port.clock.advance(WORK_LEASE_MS + 1);
      }

      const raced: Promise<unknown> = (async () => {
        switch (mutation) {
          case "schedule":
            return scheduleWork(
              deps,
              { actorId: ACTOR },
              publishRequest(sourceRef, 1, [
                ...dependencies,
                {
                  sourceRef: `${sourceRef}-dependency`,
                  generation: 1,
                  extractionRevision: null,
                  relationBuckets: [],
                },
              ])
            );
          case "claim":
            return claimNextWork(deps);
          case "heartbeat":
            return port.work.heartbeatWork(requireGuard(guard), port.clock());
          case "settle":
            return settleWork(
              deps,
              requireGuard(guard),
              { status: "failed", failureCode: "invalid_input" },
              live
            );
          case "retry":
            return retryWork(deps, job.jobKey);
          case "reclaim":
            return port.work.reclaimExpiredWork(port.clock());
        }
      })();
      const assignment = declareDesired(port, scopeBinding, [sourceRef], seeded, 1);
      const [assignmentCode, racedOutcome] = await Promise.all([
        codeOf(assignment),
        raced,
      ]);

      expect(assignmentCode).toBeUndefined();
      if (mutation === "heartbeat") expect(racedOutcome).toBe(true);
      if (mutation === "claim") {
        expect(
          (racedOutcome as { guard: MaintenanceAttemptGuard | null }).guard
        ).toMatchObject({ jobKey: job.jobKey, attemptNumber: 1 });
      }
      if (mutation === "settle") {
        expect(racedOutcome).toMatchObject({
          result: "settled",
          record: { status: "failed", lastFailureCode: "invalid_input" },
        });
      }
      if (mutation === "retry") {
        expect(racedOutcome).toMatchObject({ status: "pending" });
      }
      if (mutation === "reclaim") {
        expect(racedOutcome).toEqual([{ jobKey: job.jobKey, reclaimed: true }]);
      }

      const owned = await port.publication.readSnapshot({ scopeBinding });
      expect(sourceRow(owned, sourceRef)).toMatchObject({
        active: true,
        generation: 1,
        desired: { sourceVersion: "v1", extractionRevision: 1 },
        published: null,
      });
      expect(owned.subjects).toEqual([]);
      expect(await port.readOutboxCount(scopeBinding)).toBe(0);

      const ledger = await port.work.getJob(job.jobKey);
      expect(ledger).toMatchObject({
        jobKey: job.jobKey,
        sourceRef,
        sourceGeneration: 1,
        status: expectedLedger[mutation].status,
        attemptCount: expectedLedger[mutation].attemptCount,
      });

      const secondOwnerCode = await codeOf(
        port.publication.declareDesired({
          scopeBinding: otherScope,
          authorizedSourceRefs: [sourceRef],
          sourceRef,
          sourceVersion: seeded.record,
          locatorBindings: seeded.locatorBindings,
          desiredExtractionRevision: 1,
          configRevision: "extractor-v1",
        })
      );
      expect(secondOwnerCode).toBe("unsupported_source_binding");
      expect(
        (await port.publication.readSnapshot({ scopeBinding: otherScope }))
          .sources
      ).toEqual([]);
    }
  );

  it("keeps an already-running formerly unowned job publishable under its new single owner", async () => {
    const port = await open();
    const sourceRef = unique("running-owner-source");
    const scopeBinding = unique("running-owner-scope");
    const seeded = await registerVersion(port, sourceRef, "v1");
    await admitScope(port, scopeBinding, "auth-1");
    const deps = { store: port.work, clock: port.clock };
    const job = requireScheduled(
      await scheduleWork(deps, { actorId: ACTOR }, publishRequest(sourceRef, 1))
    );
    const guard = requireGuard((await claimNextWork(deps)).guard);
    expect(guard.jobKey).toBe(job.jobKey);

    // A standalone attempt cannot serve current state before anyone owns it.
    await expectFailure(
      port.publication.stageAttempt({
        scopeBinding,
        sourceRef,
        guard,
        extractionRef: "extract-orphan",
        accepted: [],
      }),
      "access_denied"
    );

    const generation = (
      await declareDesired(port, scopeBinding, [sourceRef], seeded, 1)
    ).generation;
    expect(generation).toBe(1);
    expect(await port.work.heartbeatWork(guard, port.clock())).toBe(true);
    expect(await port.work.getJob(job.jobKey)).toMatchObject({
      status: "running",
      attemptCount: 1,
    });

    await stageAttempt(port, scopeBinding, sourceRef, guard, "extract-owner", [
      entityFact(seeded, UUIDS[0], "extract-owner", "Owned entity"),
    ]);
    const published = await publish(port, scopeBinding, sourceRef, guard);
    expect(published).toMatchObject({ published: true });

    const snapshot = await port.publication.readSnapshot({ scopeBinding });
    expect(currentIds(snapshot)).toEqual([UUIDS[0]]);
    expect(sourceRow(snapshot, sourceRef)).toMatchObject({
      generation: 1,
      published: { sourceVersion: "v1", extractionRevision: 1 },
      status: "ready",
    });
    expect(await port.work.getJob(job.jobKey)).toMatchObject({
      status: "ready",
      attemptCount: 1,
    });
    expect(await port.work.listAttempts(job.jobKey)).toHaveLength(1);
    // One owner row for the one owned source: ownership is not replicated per
    // reader or per work path when a standalone job gains its first owner.
    expect(snapshot.sources.filter((row) => row.active)).toHaveLength(1);
    expect(new Set(snapshot.sources.map((row) => row.sourceRef)).size).toBe(
      snapshot.sources.length
    );
  });

  it("lets exactly one of two concurrent first assignments win without partial state", async () => {
    const port = await open();
    const sourceRef = unique("dual-owner-source");
    const scopeA = unique("dual-owner-a");
    const scopeB = unique("dual-owner-b");
    const seeded = await registerVersion(port, sourceRef, "v1");
    await admitScope(port, scopeA, "auth-1");
    await admitScope(port, scopeB, "auth-1");

    const [firstCode, secondCode] = await Promise.all([
      codeOf(declareDesired(port, scopeA, [sourceRef], seeded, 1)),
      codeOf(declareDesired(port, scopeB, [sourceRef], seeded, 1)),
    ]);

    expect(
      [firstCode, secondCode].filter((code) => code === undefined)
    ).toHaveLength(1);
    expect(
      [firstCode, secondCode].filter((code) => code !== undefined)
    ).toEqual(["unsupported_source_binding"]);
    const winner = firstCode === undefined ? scopeA : scopeB;
    const loser = firstCode === undefined ? scopeB : scopeA;
    const winnerSnapshot = await port.publication.readSnapshot({
      scopeBinding: winner,
    });
    const loserSnapshot = await port.publication.readSnapshot({
      scopeBinding: loser,
    });
    expect(sourceRow(winnerSnapshot, sourceRef)?.generation).toBe(1);
    expect(winnerSnapshot.subjects).toEqual([]);
    expect(loserSnapshot.sources).toEqual([]);
    expect(loserSnapshot.subjects).toEqual([]);
    expect(loserSnapshot.readRevision).toBe("0");
    expect(await port.readOutboxCount(loser)).toBe(0);

    const views = await withAuthorizedScope(
      port.authorizedContext({
        actorId: ACTOR,
        ownerScopeBinding: winner,
        readerBinding: "reader-1",
        authorizedSourceRefs: [sourceRef],
        authorizationRevision: "auth-1",
        deadlineAt: port.farDeadline(),
      }),
      async (scope) => scope.readAcceptedInputs([sourceRef])
    );
    expect(views.memberships).toEqual([]);
    expect(views.sources).toEqual([
      expect.objectContaining({ sourceRef, generation: 1, active: true }),
    ]);
  });

  it("publishes the same staged payload on the attempt after a refused one", async () => {
    const port = await open();
    const sourceRef = unique("restart-source");
    const scopeBinding = unique("restart-scope");
    const seeded = await registerVersion(port, sourceRef, "v1");
    await admitScope(port, scopeBinding, "auth-1");
    const generation = (
      await declareDesired(port, scopeBinding, [sourceRef], seeded, 1)
    ).generation;
    const attempt = await startAttempt(port, sourceRef, generation);
    await stageAttempt(port, scopeBinding, sourceRef, attempt.guard, "extract-restart", [
      entityFact(seeded, UUIDS[0], "extract-restart", "Restarted entity"),
    ]);
    port.outbox.failNextPreparation();
    const firstCode = await codeOf(
      publish(port, scopeBinding, sourceRef, attempt.guard)
    );
    expect(firstCode).toBe("backend_unavailable");
    const refusedState = await port.publication.readSnapshot({ scopeBinding });
    const outboxAfterRefusal = await port.readOutboxCount(scopeBinding);
    expect(currentIds(refusedState)).toEqual([]);

    const secondCode = await codeOf(
      publish(port, scopeBinding, sourceRef, attempt.guard)
    );

    expect(secondCode).toBeUndefined();
    const settled = await port.publication.readSnapshot({ scopeBinding });
    expect(settled.readRevision).not.toBe(refusedState.readRevision);
    expect(currentIds(settled)).toEqual([UUIDS[0]]);
    expect(await port.readOutboxCount(scopeBinding)).toBeGreaterThan(
      outboxAfterRefusal
    );
    expect(await port.work.getJob(attempt.guard.jobKey)).toMatchObject({
      status: "ready",
    });
  });
});
