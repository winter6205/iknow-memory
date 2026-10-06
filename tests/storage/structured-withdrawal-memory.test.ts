/**
 * T11 MP7 in memory — the same named cases the PostgreSQL lane asserts, so
 * "one or the last supporting source" is proven on the in-process store rather
 * than assumed from the SQL adapter.
 *
 * The memory withdrawal has exactly one await (outbox intent preparation); every
 * commit after it is synchronous. The failure case therefore arms the outbox
 * preparation, which is the only reachable mid-withdrawal interruption, and reads
 * the residue from the same maps the serving path reads. The staged payload has
 * no reader surface here, so the fingerprint covers the serving maps, revisions,
 * membership, outbox and immutable evidence rather than the staged row.
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
import { MemoryStructuredPublicationStorage } from "../../src/core/storage/publication-memory.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import {
  EVIDENCE_GRANT_KIND,
  EVIDENCE_SUBJECT_KIND,
  EVIDENCE_SUPPORT_ROLE,
  type ChunkRecord,
  type EvidenceStore,
  type NewSourceVersion,
} from "../../src/core/types.js";
import {
  createPublicationTestClock,
  outcomeCode,
  type PublicationTestClock,
} from "./publication-contract.js";

const DIMENSIONS = 8;
const SCOPE_BINDING = "scope-t11-withdrawal-memory";
const ACTOR = "t11-withdrawal-memory-owner";
const CONFIG_REVISION = "extractor-v1";
const AUTHORIZATION_REVISION = "auth-t11-m1";
const PURGE_REVISION = "purge-t11-m0";
const QUERIED_AT = "2026-01-05T00:00:00.000Z";
const GRANT_READ_AT = "2026-01-06T00:00:00.000Z";
const NOW = new Date();

type IntegratedMemoryBackend = MemoryBackend & {
  readonly structuredPublication?: StructuredPublicationStorage;
  readonly structuredIdentityStore?: StructuredIdentityStore;
  readonly maintenanceWorkStore?: MaintenanceWorkStore;
};

interface RecordingOutbox extends PublicationOutboxPort {
  failNextWrite(): void;
  intents(): readonly string[];
}

function createRecordingOutbox(): RecordingOutbox {
  const committed = new Set<string>();
  let failNext = false;
  return {
    failNextWrite() {
      failNext = true;
    },
    intents() {
      return [...committed].sort();
    },
    async prepareIntents(_scopeBinding, subjects) {
      if (failNext) {
        failNext = false;
        throw new Error("injected withdrawal failure at outbox preparation");
      }
      const prepared = [
        ...new Set(subjects.map((subject) => `${subject.kind}:${subject.id}`)),
      ];
      return () => {
        for (const intent of prepared) committed.add(intent);
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
  readonly authority: MemoryStructuredPublicationStorage;
  readonly evidence: EvidenceStore;
  readonly identity: StructuredIdentityStore;
  readonly work: MaintenanceWorkStore;
  readonly clock: PublicationTestClock;
  readonly outbox: RecordingOutbox;
  seedGraphEntities(entityIds: readonly string[]): Promise<void>;
}

async function openPort(): Promise<MemoryPort> {
  const outbox = createRecordingOutbox();
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
  const authority = publication as MemoryStructuredPublicationStorage;
  const evidence = backend as unknown as EvidenceStore;
  return {
    publication,
    authority,
    evidence,
    identity,
    work,
    clock: createPublicationTestClock(NOW),
    outbox,
    async seedGraphEntities(entityIds) {
      const chunks: ChunkRecord[] = entityIds.map((id) => ({
        id,
        content: `withdrawal test entity ${id}`,
        embedding: new Array<number>(DIMENSIONS).fill(0),
        source_ref: SCOPE_BINDING,
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
  readonly sourceRef: string;
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
  authorizedSourceRefs: readonly string[] = [sourceRef]
): Promise<Seeded> {
  const { record } = await port.evidence.registerSourceVersion({
    source_ref: sourceRef,
    source_version: "v1",
    content_digest: opaqueDigest(`${sourceRef}:v1`),
    origin_object_ref: `objects/${sourceRef}/v1.html`,
    parser_revision: "frozen-html-units-v1",
    unit_manifest: { units: 6, parser_revision: "frozen-html-units-v1" },
    created_at: port.clock().toISOString(),
    retired_at: null,
    payload_collected_at: null,
    obligations_stopped_at: null,
  });
  const locator = {
    document_id: `${sourceRef}-document`,
    version: "frozen-v1",
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
  return { sourceRef, record, locator, locatorBindings, generation: declared.generation };
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
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const claimed = await claimNextWork(deps);
    const guard = claimed.guard;
    if (guard === null) break;
    if (guard.jobKey === scheduled.record.jobKey) return guard;
    throw new Error(
      `claimed ${guard.jobKey} while waiting for ${scheduled.record.jobKey}`
    );
  }
  throw new Error(`could not claim job ${scheduled.record.jobKey} for this case`);
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
      source_ref: seeded.sourceRef,
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
        source_ref: seeded.sourceRef,
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
    sourceRef: seeded.sourceRef,
    guard,
    extractionRef,
    accepted,
  });
}

async function publishReal(
  port: MemoryPort,
  seeded: Seeded,
  guard: MaintenanceAttemptGuard
): Promise<{ published: boolean; code?: string; message?: string }> {
  try {
    await port.publication.publish({
      scopeBinding: SCOPE_BINDING,
      sourceRef: seeded.sourceRef,
      guard,
      at: port.clock().toISOString(),
    });
    return { published: true };
  } catch (error) {
    return {
      published: false,
      code: outcomeCode(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

interface WithdrawOutcome {
  readonly withdrawn: boolean;
  readonly generation?: number;
  readonly code?: string;
  readonly message?: string;
}

async function withdrawReal(
  port: MemoryPort,
  scopeBinding: string,
  sourceRef: string,
  expectedGeneration: number,
  patch: Record<string, unknown> = {}
): Promise<WithdrawOutcome> {
  try {
    const outcome = await port.publication.withdraw({
      scopeBinding,
      sourceRef,
      expectedGeneration,
      at: port.clock().toISOString(),
      ...patch,
    } as Parameters<StructuredPublicationStorage["withdraw"]>[0]);
    return { withdrawn: true, generation: outcome.generation };
  } catch (error) {
    return {
      withdrawn: false,
      code: outcomeCode(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readSnapshot(port: MemoryPort): Promise<PublicationSnapshot> {
  return port.publication.readSnapshot({ scopeBinding: SCOPE_BINDING });
}

function subjectsOf(
  snapshot: PublicationSnapshot,
  resultIds: readonly string[]
): readonly PublicationSnapshot["subjects"][number][] {
  return snapshot.subjects.filter((subject) => resultIds.includes(subject.resultId));
}

function sourcesOf(
  snapshot: PublicationSnapshot,
  sourceRefs: readonly string[]
): readonly PublicationSnapshot["sources"][number][] {
  return snapshot.sources.filter((source) => sourceRefs.includes(source.sourceRef));
}

interface TwoOrigins {
  readonly sourceA: Seeded;
  readonly sourceB: Seeded;
  readonly sharedResultId: string;
  readonly onlyAResultId: string;
  readonly onlyBResultId: string;
  readonly allResultIds: readonly string[];
  readonly supportA: string;
  readonly supportB: string;
}

/**
 * The maintenance contract's M3 fixture, built from its own words: two active
 * origins, one shared assertion and one result each origin serves alone.
 */
async function twoOrigins(port: MemoryPort, label: string): Promise<TwoOrigins> {
  const sourceA = unique(`${label}-a`);
  const sourceB = unique(`${label}-b`);
  const seededA = await seedSource(port, sourceA, [sourceA, sourceB]);
  const seededB = await seedSource(port, sourceB, [sourceA, sourceB]);
  const head = nextEntityId();
  const tail = nextEntityId();
  const onlyA = nextEntityId();
  const onlyB = nextEntityId();
  const sharedA = assertionFact(seededA, "extract-a", "co_founded", 1, head, tail);
  const sharedB: PublicationFact = {
    ...sharedA.fact,
    occurrence: {
      ...sharedA.fact.occurrence,
      source_ref: seededB.sourceRef,
      location: { ...seededB.locator, unit: 1 },
      extraction_ref: "extract-b",
    },
  } as PublicationFact;
  await port.seedGraphEntities([head, tail, onlyA, onlyB]);

  const guardA = await claimOwnJob(
    port,
    sourceA,
    "v1",
    seededA.generation,
    [dependencyOf(sourceA, seededA.generation)]
  );
  await stageReal(port, seededA, guardA, "extract-a", [
    sharedA.fact,
    entityFact(seededA, onlyA, "extract-a", "Only A", 2),
  ]);
  expect(await publishReal(port, seededA, guardA)).toEqual({ published: true });

  const guardB = await claimOwnJob(
    port,
    sourceB,
    "v1",
    seededB.generation,
    [dependencyOf(sourceB, seededB.generation)]
  );
  await stageReal(port, seededB, guardB, "extract-b", [
    sharedB,
    entityFact(seededB, onlyB, "extract-b", "Only B", 2),
  ]);
  expect(await publishReal(port, seededB, guardB)).toEqual({ published: true });

  const before = await readSnapshot(port);
  expect(subjectsOf(before, [sharedA.resultId])[0]?.supportIds).toHaveLength(2);
  const supportA = onlySupportOf(port, seededA.sourceRef, sharedA.resultId);
  const supportB = onlySupportOf(port, seededB.sourceRef, sharedA.resultId);
  return {
    sourceA: seededA,
    sourceB: seededB,
    sharedResultId: sharedA.resultId,
    onlyAResultId: onlyA,
    onlyBResultId: onlyB,
    allResultIds: [sharedA.resultId, onlyA, onlyB],
    supportA,
    supportB,
  };
}

function onlySupportOf(
  port: MemoryPort,
  sourceRef: string,
  resultId: string
): string {
  const rows = port.authority
    .scopedMembershipRows(SCOPE_BINDING, [sourceRef])
    .filter((row) => row.resultId === resultId);
  if (rows.length !== 1 || rows[0]!.supportIds.length !== 1) {
    throw new Error(
      `expected one support for ${sourceRef}/${resultId}, observed ${JSON.stringify(rows)}`
    );
  }
  return rows[0]!.supportIds[0]!;
}

interface Fingerprint {
  readonly sources: readonly unknown[];
  readonly revisions: unknown;
  readonly membership: readonly unknown[];
  readonly extractions: readonly unknown[];
  readonly subjects: readonly unknown[];
  readonly outbox: readonly string[];
  readonly supports: readonly unknown[];
}

/**
 * The memory residue read from the same maps the serving path reads, plus the
 * immutable evidence a withdrawal must not erase.
 */
async function readFingerprint(
  port: MemoryPort,
  sourceRefs: readonly string[],
  resultIds: readonly string[]
): Promise<Fingerprint> {
  const snapshot = await readSnapshot(port);
  const supports: unknown[] = [];
  for (const supportId of await supportIdsOf(port, sourceRefs)) {
    const support = await port.evidence.getSupport(supportId);
    supports.push({
      supportId,
      present: support !== null,
      sourceRef: support?.source_ref ?? null,
      extractions: await port.evidence.listSupportExtractions(supportId),
    });
  }
  return {
    sources: port.authority.scopedSourceRows(SCOPE_BINDING, sourceRefs),
    revisions: port.authority.scopeRevisions(SCOPE_BINDING),
    membership: port.authority.scopedMembershipRows(SCOPE_BINDING, sourceRefs),
    extractions: port.authority.scopedExtractionRows(SCOPE_BINDING, sourceRefs),
    subjects: subjectsOf(snapshot, resultIds),
    outbox: port.outbox.intents(),
    supports,
  };
}

async function supportIdsOf(
  port: MemoryPort,
  sourceRefs: readonly string[]
): Promise<readonly string[]> {
  const ids = new Set<string>();
  for (const sourceRef of sourceRefs) {
    for (const row of port.authority.scopedMembershipRows(SCOPE_BINDING, [
      sourceRef,
    ])) {
      for (const supportId of row.supportIds) ids.add(supportId);
    }
  }
  return [...ids].sort();
}

describe("T11 one or the last supporting source is withdrawn safely (memory)", () => {
  it("keeps a shared assertion current and visible when one of two origins is withdrawn", async () => {
    const port = await openPort();
    await port.evidence.setScopeRevisions(SCOPE_BINDING, {
      authorizationRevision: AUTHORIZATION_REVISION,
      purgeRevision: PURGE_REVISION,
    });
    const origins = await twoOrigins(port, "one-of-two");

    const outcome = await withdrawReal(
      port,
      SCOPE_BINDING,
      origins.sourceA.sourceRef,
      origins.sourceA.generation
    );
    expect(outcome).toEqual({
      withdrawn: true,
      generation: origins.sourceA.generation + 1,
    });

    const after = await readSnapshot(port);
    const shared = subjectsOf(after, [origins.sharedResultId]);
    expect(shared).toHaveLength(1);
    expect(shared[0]?.supportIds).toEqual([origins.supportB]);
    expect(subjectsOf(after, [origins.onlyAResultId])).toEqual([]);
    expect(subjectsOf(after, [origins.onlyBResultId])).toHaveLength(1);

    const withdrawn = sourcesOf(after, [origins.sourceA.sourceRef]);
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]?.active).toBe(false);
    expect(withdrawn[0]?.published).toBeNull();
    expect(withdrawn[0]?.generation).toBe(origins.sourceA.generation + 1);
    const survivor = sourcesOf(after, [origins.sourceB.sourceRef]);
    expect(survivor[0]?.active).toBe(true);
    expect(survivor[0]?.generation).toBe(origins.sourceB.generation);
    expect(survivor[0]?.published).toEqual({
      sourceVersion: "v1",
      extractionRevision: 1,
    });
  });

  it("removes the assertion from current reads when the last support is withdrawn and retains its authorized history", async () => {
    const port = await openPort();
    await port.evidence.setScopeRevisions(SCOPE_BINDING, {
      authorizationRevision: AUTHORIZATION_REVISION,
      purgeRevision: PURGE_REVISION,
    });
    const origins = await twoOrigins(port, "last-source");
    const grant = await port.evidence.issueGrant({
      kind: EVIDENCE_GRANT_KIND.ROW,
      subject: EVIDENCE_SUBJECT_KIND.ASSERTION,
      operation: "list",
      queryDigest: `${origins.sourceA.sourceRef}-query`,
      scopeBinding: SCOPE_BINDING,
      readRevision: "read-t11-m1",
      queriedAt: QUERIED_AT,
      context: { coverage: "stored_structured_subjects" },
      value: { assertion_id: origins.sharedResultId },
      supports: [
        { support_id: origins.supportA, role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE },
        { support_id: origins.supportB, role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE },
      ],
    } as Parameters<typeof port.evidence.issueGrant>[0]);

    expect(
      await withdrawReal(
        port,
        SCOPE_BINDING,
        origins.sourceA.sourceRef,
        origins.sourceA.generation
      )
    ).toEqual({ withdrawn: true, generation: origins.sourceA.generation + 1 });
    expect(subjectsOf(await readSnapshot(port), [origins.sharedResultId])).toHaveLength(1);

    expect(
      await withdrawReal(
        port,
        SCOPE_BINDING,
        origins.sourceB.sourceRef,
        origins.sourceB.generation
      )
    ).toEqual({ withdrawn: true, generation: origins.sourceB.generation + 1 });

    const after = await readSnapshot(port);
    expect(subjectsOf(after, origins.allResultIds)).toEqual([]);
    const sources = sourcesOf(after, [
      origins.sourceA.sourceRef,
      origins.sourceB.sourceRef,
    ]);
    expect(sources.map((source) => source.active)).toEqual([false, false]);
    expect(
      sources.filter((source) => source.active && source.published !== null)
    ).toHaveLength(0);

    const replay = await port.evidence.readGrant(grant.evidence_ref, GRANT_READ_AT);
    expect(replay.state).toBe("granted");
    if (replay.state !== "granted") return;
    expect(replay.grant.value).toEqual({ assertion_id: origins.sharedResultId });
    expect(
      replay.supports.map((support) => support.support_id).sort()
    ).toEqual([origins.supportA, origins.supportB].sort());
    expect(
      (
        await port.evidence.listGrantPinnedExtractions(grant.evidence_ref)
      ).map((entry) => entry.extraction_ref).sort()
    ).toEqual(["extract-a", "extract-b"]);
    expect(await port.evidence.getSupport(origins.supportA)).not.toBeNull();
    expect(await port.evidence.listSupportExtractions(origins.supportA)).toEqual([
      "extract-a",
    ]);
  });

  it("advances the source generation and both scope revisions in the withdrawal's own commit", async () => {
    const port = await openPort();
    const origins = await twoOrigins(port, "revisions");
    const sourceRefs = [origins.sourceA.sourceRef];
    const resultIds = [origins.sharedResultId, origins.onlyAResultId];
    const before = await readFingerprint(port, sourceRefs, resultIds);
    const scopeBefore = before.revisions as {
      readRevision: number;
      maintenanceRevision: number;
    };

    const outcome = await withdrawReal(
      port,
      SCOPE_BINDING,
      origins.sourceA.sourceRef,
      origins.sourceA.generation
    );
    expect(outcome.withdrawn).toBe(true);

    const after = await readFingerprint(port, sourceRefs, resultIds);
    const sourceAfter = after.sources[0] as { generation: number };
    const scopeAfter = after.revisions as {
      readRevision: number;
      maintenanceRevision: number;
    };
    expect(sourceAfter.generation).toBe(origins.sourceA.generation + 1);
    expect(outcome.generation).toBe(sourceAfter.generation);
    expect(scopeAfter.readRevision).toBe(scopeBefore.readRevision + 1);
    expect(scopeAfter.maintenanceRevision).toBe(scopeBefore.maintenanceRevision + 1);
    expect(after.membership).toHaveLength(0);
  });

  it("records one derived projection intent per withdrawn subject and never a duplicate", async () => {
    const port = await openPort();
    const origins = await twoOrigins(port, "outbox");
    expect(port.outbox.intents()).toEqual([
      `entity:${origins.onlyAResultId}`,
      `entity:${origins.onlyBResultId}`,
      `triple:${origins.sharedResultId}`,
    ]);

    const outcome = await withdrawReal(
      port,
      SCOPE_BINDING,
      origins.sourceA.sourceRef,
      origins.sourceA.generation
    );
    expect(outcome.withdrawn).toBe(true);

    expect(port.outbox.intents()).toEqual([
      `entity:${origins.onlyAResultId}`,
      `entity:${origins.onlyBResultId}`,
      `triple:${origins.sharedResultId}`,
    ]);
    expect(new Set(port.outbox.intents()).size).toBe(3);
  });

  it("refuses a stale, repeated, unauthorized and malformed withdrawal with a typed code and no state change", async () => {
    const port = await openPort();
    const origins = await twoOrigins(port, "refusals");
    const sourceRefs = [origins.sourceA.sourceRef];
    const resultIds = [origins.sharedResultId, origins.onlyAResultId];
    const untouched = await readFingerprint(port, sourceRefs, resultIds);

    const stale = await withdrawReal(
      port,
      SCOPE_BINDING,
      origins.sourceA.sourceRef,
      origins.sourceA.generation - 1
    );
    expect(stale.withdrawn).toBe(false);
    expect(stale.code).toBe("input_stale");
    expect(await readFingerprint(port, sourceRefs, resultIds)).toEqual(untouched);

    expect(
      await withdrawReal(
        port,
        SCOPE_BINDING,
        origins.sourceA.sourceRef,
        origins.sourceA.generation
      )
    ).toEqual({ withdrawn: true, generation: origins.sourceA.generation + 1 });
    const afterFirst = await readFingerprint(port, sourceRefs, resultIds);

    const repeated = await withdrawReal(
      port,
      SCOPE_BINDING,
      origins.sourceA.sourceRef,
      origins.sourceA.generation + 1
    );
    expect(repeated.withdrawn).toBe(false);
    expect(repeated.code).toBe("input_stale");
    expect(await readFingerprint(port, sourceRefs, resultIds)).toEqual(afterFirst);

    const unknownSource = await withdrawReal(
      port,
      SCOPE_BINDING,
      unique("not-declared"),
      0
    );
    expect(unknownSource.withdrawn).toBe(false);
    expect(unknownSource.code).toBe("access_denied");

    const unknownScope = await withdrawReal(
      port,
      "scope-t11-m-not-registered",
      origins.sourceB.sourceRef,
      origins.sourceB.generation
    );
    expect(unknownScope.withdrawn).toBe(false);
    expect(unknownScope.code).toBe("access_denied");

    for (const malformed of [
      { expectedGeneration: -1 },
      { at: "not-an-instant" },
      { scopeBinding: "" },
      { sourceRef: "" },
    ]) {
      const outcome = await withdrawReal(
        port,
        (malformed.scopeBinding as string | undefined) ?? SCOPE_BINDING,
        (malformed.sourceRef as string | undefined) ?? origins.sourceB.sourceRef,
        origins.sourceB.generation,
        malformed
      );
      expect(outcome.withdrawn, JSON.stringify(malformed)).toBe(false);
      expect(outcome.code, JSON.stringify(malformed)).toBe("invalid_input");
    }
    expect(await readFingerprint(port, sourceRefs, resultIds)).toEqual(afterFirst);
  });

  it("leaves the prior state exactly intact when the outbox preparation fails", async () => {
    const port = await openPort();
    const origins = await twoOrigins(port, "fault-outbox");
    const sourceRefs = [origins.sourceA.sourceRef];
    const resultIds = [origins.sharedResultId, origins.onlyAResultId];
    const before = await readFingerprint(port, sourceRefs, resultIds);
    expect(before.membership).toHaveLength(2);

    port.outbox.failNextWrite();
    const outcome = await withdrawReal(
      port,
      SCOPE_BINDING,
      origins.sourceA.sourceRef,
      origins.sourceA.generation
    );
    expect(outcome.withdrawn).toBe(false);
    // EXIT: a driver fault at the only reachable interruption must surface as
    // `backend_unavailable`, not as a stale-input verdict the withdrawal never
    // reached; the fingerprint below is the observable outcome.
    expect(outcome.code).toBe("backend_unavailable");
    expect(outcome.message).toContain(
      "injected withdrawal failure at outbox preparation"
    );

    const after = await readFingerprint(port, sourceRefs, resultIds);
    expect(after).toEqual(before);
    expect(subjectsOf(await readSnapshot(port), resultIds)).toHaveLength(2);
  });
});
