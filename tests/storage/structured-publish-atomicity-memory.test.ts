/**
 * T10 MP6 in memory — the same six named cases the PostgreSQL lane asserts, so
 * "one unit of work" is proven on the in-process store rather than assumed from
 * the SQL adapter.
 *
 * The memory switch has exactly one await (outbox intent preparation); every
 * commit after it is synchronous. The failure case therefore arms the outbox
 * preparation, which is the only reachable mid-switch interruption, and reads the
 * residue from the same registry the serving path reads.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { claimNextWork, scheduleWork } from "../../src/core/maintenance/service.js";
import type {
  MaintenanceAttemptGuard,
  MaintenanceDependency,
  MaintenanceWorkRequest,
  MaintenanceWorkStore,
} from "../../src/core/maintenance/types.js";
import type {
  PublicationFact,
  PublicationOutboxPort,
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
import type { ChunkRecord, EvidenceStore, NewSourceVersion } from "../../src/core/types.js";
import {
  createPublicationTestClock,
  outcomeCode,
  type PublicationTestClock,
} from "./publication-contract.js";

const DIMENSIONS = 8;
const SCOPE_BINDING = "scope-t10-publish-atomicity-memory";
const ACTOR = "t10-publish-atomicity-memory-owner";
const CONFIG_REVISION = "extractor-v1";
const NOW = new Date();

type IntegratedMemoryBackend = MemoryBackend & {
  readonly structuredPublication?: StructuredPublicationStorage;
  readonly structuredIdentityStore?: StructuredIdentityStore;
  readonly maintenanceWorkStore?: MaintenanceWorkStore;
};

interface CountingOutbox extends PublicationOutboxPort {
  failNextWrite(): void;
  count(scopeBinding: string): number;
}

function createCountingOutbox(): CountingOutbox {
  const committed = new Map<string, number>();
  let failNext = false;
  return {
    failNextWrite() {
      failNext = true;
    },
    count(scopeBinding) {
      return committed.get(scopeBinding) ?? 0;
    },
    async prepareIntents(scopeBinding, subjects) {
      if (failNext) {
        failNext = false;
        throw new Error("injected publication switch failure at outbox preparation");
      }
      const intentCount = subjects.length;
      return () => {
        committed.set(
          scopeBinding,
          (committed.get(scopeBinding) ?? 0) + intentCount
        );
      };
    },
  };
}

let serial = 0;
let entitySerial = 0;

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

function nextEntityId(): string {
  entitySerial += 1;
  return `00000000-0000-4000-9000-${entitySerial.toString().padStart(12, "0")}`;
}

function opaqueDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface MemoryPort {
  readonly publication: StructuredPublicationStorage;
  readonly evidence: EvidenceStore;
  readonly identity: StructuredIdentityStore;
  readonly work: MaintenanceWorkStore;
  readonly clock: PublicationTestClock;
  readonly outbox: CountingOutbox;
  seedGraphEntities(entityIds: readonly string[]): Promise<void>;
}

async function openPort(): Promise<MemoryPort> {
  const outbox = createCountingOutbox();
  const backend = new MemoryBackend(DIMENSIONS, {
    publicationOutbox: outbox,
  }) as IntegratedMemoryBackend;
  const publication = backend.structuredPublication;
  const identity = backend.structuredIdentityStore;
  const work = backend.maintenanceWorkStore;
  if (!publication || !identity || !work) {
    throw new Error(
      "MemoryBackend must expose the integrated publication, identity, and work stores"
    );
  }
  return {
    publication,
    evidence: backend,
    identity,
    work,
    clock: createPublicationTestClock(NOW),
    outbox,
    async seedGraphEntities(entityIds) {
      const chunks: ChunkRecord[] = entityIds.map((id) => ({
        id,
        content: `publication test entity ${id}`,
        embedding: new Array<number>(DIMENSIONS).fill(0),
        source_ref: "t10-publish-atomicity-memory",
        metadata: {},
        valid_from: NOW.toISOString(),
        valid_until: null,
        created_at: NOW.toISOString(),
      }));
      if (chunks.length > 0) await backend.upsert(chunks);
    },
  };
}

interface Seeded {
  readonly record: NewSourceVersion & { readonly source_version_id: string };
  readonly locator: { document_id: string; version: string; unit: number };
  readonly locatorBindings: readonly {
    source_version_id: string;
    document_id: string;
    version: string;
    unit: number;
  }[];
  readonly generation: number;
}

async function seedSource(
  port: MemoryPort,
  sourceRef: string,
  sourceVersion: string,
  authorizedSourceRefs: readonly string[] = [sourceRef]
): Promise<Seeded> {
  const { record } = await port.evidence.registerSourceVersion({
    source_ref: sourceRef,
    source_version: sourceVersion,
    content_digest: opaqueDigest(`${sourceRef}:${sourceVersion}`),
    origin_object_ref: `objects/${sourceRef}/${sourceVersion}.html`,
    parser_revision: "frozen-html-units-v1",
    unit_manifest: { units: 6, parser_revision: "frozen-html-units-v1" },
    created_at: port.clock().toISOString(),
    retired_at: null,
    payload_collected_at: null,
    obligations_stopped_at: null,
  });
  const locator = {
    document_id: `${sourceRef}-document`,
    version: `frozen-${sourceVersion}`,
    unit: 1,
  };
  const locatorBindings = [1, 2, 3, 4, 5, 6].map((unit) => ({
    source_version_id: record.source_version_id,
    ...locator,
    unit,
  }));
  for (const binding of locatorBindings) await port.evidence.bindSourceLocator(binding);
  const declared = await port.publication.declareDesired({
    scopeBinding: SCOPE_BINDING,
    authorizedSourceRefs: [...authorizedSourceRefs],
    sourceRef,
    sourceVersion: record,
    locatorBindings,
    desiredExtractionRevision: 1,
    configRevision: CONFIG_REVISION,
  });
  return { record, locator, locatorBindings, generation: declared.generation };
}

function dependencyOf(
  sourceRef: string,
  generation: number,
  extractionRevision: number | null = null
): MaintenanceDependency {
  return { sourceRef, generation, extractionRevision, relationBuckets: [] };
}

async function claimOwnJob(
  port: MemoryPort,
  sourceRef: string,
  sourceVersion: string,
  generation: number,
  dependencies: readonly MaintenanceDependency[],
  configRevision: string = CONFIG_REVISION
): Promise<MaintenanceAttemptGuard> {
  const request: MaintenanceWorkRequest = {
    workKind: "extract_publish",
    sourceRef,
    sourceVersion,
    sourceGeneration: generation,
    configRevision,
    dependencies,
  };
  const deps = { store: port.work, clock: () => port.clock() };
  const scheduled = await scheduleWork(deps, { actorId: ACTOR }, request);
  if ("refused" in scheduled) {
    throw new Error(`scheduleWork refused: ${scheduled.refused}`);
  }
  const claimed = await claimNextWork(deps);
  const guard = claimed.guard;
  if (!guard) throw new Error(`could not claim job ${scheduled.record.jobKey}`);
  if (guard.jobKey !== scheduled.record.jobKey) {
    throw new Error(
      `claimed ${guard.jobKey} while waiting for ${scheduled.record.jobKey}`
    );
  }
  return guard;
}

function entityFact(
  seeded: Seeded,
  entityId: string,
  extractionRef: string,
  canonicalName: string,
  unit: number
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
  seeded: Seeded,
  extractionRef: string,
  relationNorm: string,
  unit: number,
  headEntityId: string,
  tailEntityId: string
): { fact: PublicationFact; resultId: string } {
  const identity: RelationAssertionInput = {
    headEntityId,
    relationNorm,
    tailEntityId,
    validWindow: { from: null, until: null },
  };
  const resultId = deriveRelationAssertionId(normalizeRelationAssertion(identity));
  return {
    resultId,
    fact: {
      identity: { kind: "relation_assertion", input: identity },
      occurrence: {
        subject: "assertion",
        result_id: resultId,
        source_ref: seeded.record.source_ref,
        source_version: seeded.record.source_version,
        location: { ...seeded.locator, unit },
        extraction_ref: extractionRef,
        extractedAt: seeded.record.created_at,
      },
    },
  };
}

async function stageReal(
  port: MemoryPort,
  seeded: Seeded,
  guard: MaintenanceAttemptGuard,
  extractionRef: string,
  accepted: readonly PublicationFact[]
): Promise<void> {
  await port.seedGraphEntities(
    accepted.flatMap((fact) =>
      fact.identity.kind === "entity" ? [fact.identity.input.entityId] : []
    )
  );
  await port.publication.stageAttempt({
    scopeBinding: SCOPE_BINDING,
    sourceRef: seeded.record.source_ref,
    guard,
    extractionRef,
    accepted,
  });
}

async function publishReal(
  port: MemoryPort,
  seeded: Seeded,
  guard: MaintenanceAttemptGuard
): Promise<{ published: boolean; code?: string }> {
  try {
    await port.publication.publish({
      scopeBinding: SCOPE_BINDING,
      sourceRef: seeded.record.source_ref,
      guard,
      at: port.clock().toISOString(),
    });
    return { published: true };
  } catch (error) {
    return { published: false, code: outcomeCode(error) };
  }
}

interface ServedMember {
  readonly subject: string;
  readonly result_id: string;
  readonly support_id: string;
}

/**
 * The memory snapshot is scope-wide: one entry per subject listing every
 * supporting id. Per-source membership is therefore read as "the support ids
 * this source published", which the caller resolves against the ids it staged.
 */
async function readScopeMembers(
  port: MemoryPort
): Promise<readonly ServedMember[]> {
  const snapshot = await port.publication.readSnapshot({
    scopeBinding: SCOPE_BINDING,
  });
  return snapshot.subjects
    .flatMap((subject) =>
      subject.supportIds.map((supportId) => ({
        subject: subject.subject,
        result_id: subject.resultId,
        support_id: supportId,
      }))
    )
    .sort((left, right) => left.support_id.localeCompare(right.support_id));
}

interface DisplayRow {
  readonly canonicalName: string;
  readonly extractionRevision: number;
  readonly type: string;
}

async function readDisplay(
  port: MemoryPort
): Promise<ReadonlyMap<string, DisplayRow>> {
  const snapshot = await port.publication.readSnapshot({
    scopeBinding: SCOPE_BINDING,
  });
  return new Map(
    snapshot.subjects.map((subject) => [
      subject.resultId,
      {
        canonicalName: subject.displayValues[0]?.canonicalName ?? "",
        extractionRevision: subject.displayValues[0]?.extractionRevision ?? 0,
        type: subject.displayValues[0]?.type ?? "",
      },
    ])
  );
}

async function publishedThenRestaged(
  port: MemoryPort,
  label: string
): Promise<{
  readonly sourceRef: string;
  readonly seeded: Seeded;
  readonly guard: MaintenanceAttemptGuard;
  readonly retained: readonly string[];
  readonly omitted: string;
  readonly added: string;
  readonly sharedResultId: string;
  readonly v1SupportIds: ReadonlyMap<string, string>;
}> {
  const sourceRef = unique(label);
  const seeded = await seedSource(port, sourceRef, "v1");
  const generation1 = await claimOwnJob(
    port,
    sourceRef,
    "v1",
    seeded.generation,
    [dependencyOf(sourceRef, seeded.generation)]
  );
  const retainedA = nextEntityId();
  const retainedB = nextEntityId();
  const omitted = nextEntityId();
  const shared = assertionFact(seeded, "extract-v1", "mentions", 4, retainedA, retainedB);
  await stageReal(port, seeded, generation1, "extract-v1", [
    entityFact(seeded, retainedA, "extract-v1", "Retained A v1", 1),
    entityFact(seeded, retainedB, "extract-v1", "Retained B v1", 2),
    entityFact(seeded, omitted, "extract-v1", "Omitted v1", 3),
    shared.fact,
  ]);
  const first = await publishReal(port, seeded, generation1);
  expect(first).toEqual({ published: true });

  const served = await readScopeMembers(port);
  const v1SupportIds = new Map(served.map((row) => [row.result_id, row.support_id]));
  expect(v1SupportIds.size).toBe(4);

  const declared2 = await port.publication.declareDesired({
    scopeBinding: SCOPE_BINDING,
    authorizedSourceRefs: [sourceRef],
    sourceRef,
    sourceVersion: seeded.record,
    locatorBindings: seeded.locatorBindings,
    desiredExtractionRevision: 2,
    configRevision: "extractor-v2",
  });
  const guard2 = await claimOwnJob(
    port,
    sourceRef,
    "v1",
    declared2.generation,
    [dependencyOf(sourceRef, declared2.generation, 1)],
    "extractor-v2"
  );
  const added = nextEntityId();
  const replayedShared: PublicationFact = {
    ...shared.fact,
    occurrence: { ...shared.fact.occurrence, extraction_ref: "extract-v2" },
  };
  await stageReal(port, seeded, guard2, "extract-v2", [
    entityFact(seeded, retainedA, "extract-v2", "Retained A v2", 1),
    entityFact(seeded, retainedB, "extract-v2", "Retained B v2", 2),
    entityFact(seeded, added, "extract-v2", "Added v2", 5),
    replayedShared,
  ]);

  return {
    sourceRef,
    seeded,
    guard: guard2,
    retained: [retainedA, retainedB],
    omitted,
    added,
    sharedResultId: shared.resultId,
    v1SupportIds,
  };
}

describe("T10 the accepted source set is published atomically (memory)", () => {
  it("switches a completed desired pair to the current published pair in one unit", async () => {
    const port = await openPort();
    const fixture = await publishedThenRestaged(port, "switch-one-unit");

    expect(await publishReal(port, fixture.seeded, fixture.guard)).toEqual({
      published: true,
    });

    const snapshot = await port.publication.readSnapshot({
      scopeBinding: SCOPE_BINDING,
    });
    const source = snapshot.sources.find(
      (candidate) => candidate.sourceRef === fixture.sourceRef
    );
    expect(source?.published).toMatchObject({
      sourceVersion: "v1",
      extractionRevision: 2,
    });
    const served = await readScopeMembers(port);
    expect(served.map((row) => row.result_id).sort()).toEqual(
      [
        fixture.retained[0],
        fixture.retained[1],
        fixture.added,
        fixture.sharedResultId,
      ].sort()
    );
    // 4 subjects at revision 1 + 4 at revision 2 + 1 index-bucket intent the
    // declaration itself enqueues: 9 durable intents across the two switches.
    expect(port.outbox.count(SCOPE_BINDING)).toBe(9);
  });

  it("preserves the old pair exactly when a mid-switch write fails", async () => {
    const port = await openPort();
    const fixture = await publishedThenRestaged(port, "mid-switch-failure");
    const before = await port.publication.readSnapshot({
      scopeBinding: SCOPE_BINDING,
    });
    const outboxBefore = port.outbox.count(SCOPE_BINDING);

    port.outbox.failNextWrite();
    const outcome = await publishReal(port, fixture.seeded, fixture.guard);
    expect(outcome.published).toBe(false);
    // A driver fault is a backend failure, not a fence refusal: the switch
    // refused to continue and left the unit unwritten.
    expect(outcome.code).toBe("backend_unavailable");

    const after = await port.publication.readSnapshot({
      scopeBinding: SCOPE_BINDING,
    });
    expect(after).toEqual(before);
    expect(port.outbox.count(SCOPE_BINDING)).toBe(outboxBefore);
    const source = after.sources.find(
      (candidate) => candidate.sourceRef === fixture.sourceRef
    );
    expect(source?.published).toMatchObject({ extractionRevision: 1 });
  });

  it("retires only the omitted occurrences from that source", async () => {
    const port = await openPort();
    const fixture = await publishedThenRestaged(port, "retire-omitted");
    const otherRef = unique("retire-omitted-other");
    const other = await seedSource(port, otherRef, "v1", [otherRef, fixture.sourceRef]);
    // The other source independently supports the entity that this source is
    // about to omit, so the subject must survive with the other source's
    // support and lose only the support this source published.
    const otherGuard = await claimOwnJob(port, otherRef, "v1", other.generation, [
      dependencyOf(otherRef, other.generation),
    ]);
    await stageReal(port, other, otherGuard, "extract-other", [
      entityFact(other, fixture.omitted, "extract-other", "Also elsewhere", 1),
    ]);
    expect(await publishReal(port, other, otherGuard)).toEqual({ published: true });
    const omittedSupportFromThisSource = fixture.v1SupportIds.get(fixture.omitted)!;
    const beforeMembers = await readScopeMembers(port);
    const omittedSupportsBefore = beforeMembers.filter(
      (member) => member.result_id === fixture.omitted
    );
    expect(omittedSupportsBefore).toHaveLength(2);

    expect(await publishReal(port, fixture.seeded, fixture.guard)).toEqual({
      published: true,
    });

    const afterMembers = await readScopeMembers(port);
    const omittedSupportsAfter = afterMembers.filter(
      (member) => member.result_id === fixture.omitted
    );
    expect(omittedSupportsAfter).toHaveLength(1);
    expect(omittedSupportsAfter[0]?.support_id).not.toBe(omittedSupportFromThisSource);
    const retainedAfter = afterMembers.filter(
      (member) =>
        member.result_id === fixture.retained[0] ||
        member.result_id === fixture.retained[1] ||
        member.result_id === fixture.added ||
        member.result_id === fixture.sharedResultId
    );
    expect(retainedAfter).toHaveLength(4);
  });

  it("keeps exactly one result for a support shared by two sources", async () => {
    const port = await openPort();
    const sourceA = unique("shared-a");
    const sourceB = unique("shared-b");
    const seededA = await seedSource(port, sourceA, "v1", [sourceA, sourceB]);
    const seededB = await seedSource(port, sourceB, "v1", [sourceA, sourceB]);
    const head = nextEntityId();
    const tail = nextEntityId();
    const shared = assertionFact(seededA, "extract-shared", "co_founded", 1, head, tail);
    const mirrored: PublicationFact = {
      ...shared.fact,
      occurrence: {
        ...shared.fact.occurrence,
        source_ref: sourceB,
        source_version: "v1",
        location: { ...seededB.locator, unit: 1 },
        extraction_ref: "extract-shared-b",
      },
    };
    const guardA = await claimOwnJob(port, sourceA, "v1", seededA.generation, [
      dependencyOf(sourceA, seededA.generation),
    ]);
    await port.seedGraphEntities([head, tail]);
    await stageReal(port, seededA, guardA, "extract-shared", [shared.fact]);
    const guardB = await claimOwnJob(port, sourceB, "v1", seededB.generation, [
      dependencyOf(sourceB, seededB.generation),
    ]);
    await stageReal(port, seededB, guardB, "extract-shared-b", [mirrored]);

    expect(await publishReal(port, seededA, guardA)).toEqual({ published: true });
    expect(await publishReal(port, seededB, guardB)).toEqual({ published: true });

    const snapshot = await port.publication.readSnapshot({
      scopeBinding: SCOPE_BINDING,
    });
    const results = snapshot.subjects.filter(
      (subject) => subject.resultId === shared.resultId
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.supportIds).toHaveLength(2);
  });

  it("binds display to the accepted support and its extraction revision", async () => {
    const port = await openPort();
    const fixture = await publishedThenRestaged(port, "display-binding");

    const before = await readDisplay(port);
    expect(before.get(fixture.retained[0])).toMatchObject({
      canonicalName: "Retained A v1",
      extractionRevision: 1,
      type: "organization",
    });
    const retainedSupport = fixture.v1SupportIds.get(fixture.retained[0])!;

    expect(await publishReal(port, fixture.seeded, fixture.guard)).toEqual({
      published: true,
    });

    const after = await readDisplay(port);
    expect(after.get(fixture.retained[0])).toMatchObject({
      canonicalName: "Retained A v2",
      extractionRevision: 2,
      type: "organization",
    });
    expect(after.get(fixture.added)).toMatchObject({
      canonicalName: "Added v2",
      extractionRevision: 2,
    });
    const snapshot = await port.publication.readSnapshot({
      scopeBinding: SCOPE_BINDING,
    });
    const subject = snapshot.subjects.find(
      (candidate) => candidate.resultId === fixture.retained[0]
    );
    expect(subject?.supportIds).toEqual([retainedSupport]);
    const display = subject?.displayValues.find(
      (value) => value.supportId === retainedSupport
    );
    expect(display).toMatchObject({
      supportId: retainedSupport,
      extractionRevision: 2,
      canonicalName: "Retained A v2",
      type: "organization",
    });
  });

  it("lets exactly one of two concurrent publication attempts win", async () => {
    const port = await openPort();
    const sourceRef = unique("concurrent-publish");
    const seeded = await seedSource(port, sourceRef, "v1");
    const guard = await claimOwnJob(port, sourceRef, "v1", seeded.generation, [
      dependencyOf(sourceRef, seeded.generation),
    ]);
    const head = nextEntityId();
    await stageReal(port, seeded, guard, "extract-concurrent", [
      entityFact(seeded, head, "extract-concurrent", "Concurrent", 1),
    ]);

    const attempts = await Promise.all([
      publishReal(port, seeded, guard),
      publishReal(port, seeded, guard),
    ]);
    expect(attempts.filter((attempt) => attempt.published)).toHaveLength(1);
    const losers = attempts.filter((attempt) => !attempt.published);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.code).toBe("lease_lost");

    const snapshot = await port.publication.readSnapshot({
      scopeBinding: SCOPE_BINDING,
    });
    const source = snapshot.sources.find(
      (candidate) => candidate.sourceRef === sourceRef
    );
    expect(source?.published).toMatchObject({ extractionRevision: 1 });
    expect(await readScopeMembers(port)).toHaveLength(1);
    expect(port.outbox.count(SCOPE_BINDING)).toBe(1);
  });
});
