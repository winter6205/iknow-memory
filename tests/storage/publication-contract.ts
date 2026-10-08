/**
 * Behaviour shared by the memory and PostgreSQL publication capabilities.
 * The test port is deliberately thin: its adapters expose the real backend
 * stores and map only owner context / test clock setup into the production API.
 */
import { createHash } from "node:crypto";

import { afterEach, describe as vitestDescribe, expect, it } from "vitest";

import { failureTokenOf, GraphragError } from "../../src/core/errors.js";
import type { Clock } from "../../src/core/clock.js";
import type {
  EntityIdentityInput,
  StructuredIdentityStore,
} from "../../src/core/structured/identity-store.js";
import {
  deriveRelationAssertionId,
  normalizeRelationAssertion,
  type RelationAssertionInput,
} from "../../src/core/structured/identity.js";
import type {
  EvidenceStore,
  NewSourceVersion,
  SourceLocatorBinding,
  SourceVersionRecord,
  SupportOccurrence,
  SupportRecord,
} from "../../src/core/types.js";
import {
  claimNextWork,
  scheduleWork,
  settleWork,
} from "../../src/core/maintenance/service.js";
import type {
  MaintenanceAttemptGuard,
  MaintenanceDependency,
  MaintenanceLiveInputs,
  MaintenanceWorkStore,
} from "../../src/core/maintenance/types.js";
import { WORK_LEASE_MS } from "../../src/core/maintenance/types.js";
import type {
  PublicationFact,
  PublicationSnapshot,
  StructuredPublicationStorage,
} from "../../src/core/maintenance/publication-types.js";

const INITIAL_TIME = new Date();
const UUIDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
] as const;

export type PublicationTestClock = Clock & {
  set(value: Date): void;
  advance(milliseconds: number): void;
};

export function createPublicationTestClock(
  initial = INITIAL_TIME
): PublicationTestClock {
  let instant = new Date(initial);
  const read = (() => new Date(instant)) as PublicationTestClock;
  read.set = (value) => {
    instant = new Date(value);
  };
  read.advance = (milliseconds) => {
    instant = new Date(instant.getTime() + milliseconds);
  };
  return read;
}

/**
 * Same-process readers over the exact identity/evidence/work state composed
 * into publication. PostgreSQL readers may use a second pool in the same
 * isolated schema; the memory adapter must return the backend's shared maps.
 */
export interface PublicationTestPort {
  readonly publication: StructuredPublicationStorage;
  readonly evidence: EvidenceStore;
  readonly identity: StructuredIdentityStore;
  readonly work: MaintenanceWorkStore;
  readonly clock: PublicationTestClock;
  /** Create backing graph entities for PG identity-registry foreign keys. */
  seedGraphEntities(entityIds: readonly string[]): Promise<void>;
  /** Fail the next real publication outbox write, without failing other SQL. */
  failNextOutboxWrite(): Promise<void>;
  /** Delay the next outbox write so a live lease can expire mid-commit. */
  delayNextOutboxWrite(milliseconds: number): Promise<void>;
  readOutboxCount(scopeBinding: string): Promise<number>;
  close(): Promise<void>;
}

export interface SeededVersion {
  readonly record: SourceVersionRecord;
  readonly locator: { document_id: string; version: string; unit: number };
  readonly locatorBindings: readonly SourceLocatorBinding[];
}

export interface Attempt {
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

export function outcomeCode(value: unknown): string | undefined {
  if (value instanceof GraphragError) {
    const failureToken = failureTokenOf(value);
    if (failureToken !== undefined) return failureToken;
  }
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.failureCode === "string") return candidate.failureCode;
  if (typeof candidate.code === "string") return candidate.code;
  if (typeof candidate.failureToken === "string") return candidate.failureToken;
  if (typeof candidate.refused === "string") return candidate.refused;
  return undefined;
}

export async function expectFailure(
  action: Promise<unknown>,
  expectedCode: string
): Promise<void> {
  let result: unknown;
  try {
    result = await action;
  } catch (error) {
    expect(outcomeCode(error)).toBe(expectedCode);
    return;
  }
  expect(outcomeCode(result)).toBe(expectedCode);
}

function sourceInput(
  sourceRef: string,
  sourceVersion: string,
  content = `${sourceRef}:${sourceVersion}:original`
): NewSourceVersion {
  return {
    source_ref: sourceRef,
    source_version: sourceVersion,
    content_digest: opaqueDigest(content),
    origin_object_ref: `objects/${sourceRef}/${sourceVersion}.html`,
    parser_revision: "frozen-html-units-v1",
    unit_manifest: { units: 5, parser_revision: "frozen-html-units-v1" },
    created_at: INITIAL_TIME.toISOString(),
  };
}

async function registerVersion(
  port: PublicationTestPort,
  sourceRef: string,
  sourceVersion: string,
  content?: string
): Promise<SeededVersion> {
  const { record } = await port.evidence.registerSourceVersion(
    sourceInput(sourceRef, sourceVersion, content)
  );
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
  port: PublicationTestPort,
  scopeBinding: string,
  authorizedSourceRefs: readonly string[],
  seeded: SeededVersion,
  extractionRevision: number,
  configRevision = "extractor-v1"
): Promise<number> {
  const result = await port.publication.declareDesired({
    scopeBinding,
    authorizedSourceRefs,
    sourceRef: seeded.record.source_ref,
    sourceVersion: seeded.record,
    locatorBindings: seeded.locatorBindings,
    desiredExtractionRevision: extractionRevision,
    configRevision,
  });
  const generation = (result as { generation?: unknown } | undefined)
    ?.generation;
  expect(generation).toEqual(expect.any(Number));
  return generation as number;
}

export async function startAttempt(
  port: PublicationTestPort,
  sourceRef: string,
  sourceVersion: string,
  sourceGeneration: number,
  configRevision = "extractor-v1",
  priorExtractionRevision: number | null = null,
  dependencies: readonly MaintenanceDependency[] = [
    {
      sourceRef,
      generation: sourceGeneration,
      extractionRevision: priorExtractionRevision,
      relationBuckets: [],
    },
  ]
): Promise<Attempt> {
  const live: MaintenanceLiveInputs = { configRevision, dependencies };
  const scheduled = await scheduleWork(
    { store: port.work, clock: port.clock },
    { actorId: "publication-test-owner" },
    {
      workKind: "extract_publish",
      sourceRef,
      sourceVersion,
      sourceGeneration,
      configRevision,
      dependencies,
    }
  );
  if ("refused" in scheduled) {
    throw new Error(`test setup schedule refused: ${scheduled.refused}`);
  }
  const claimed = await claimNextWork({ store: port.work, clock: port.clock });
  if (claimed.guard === null)
    throw new Error("test setup could not claim work");
  expect(claimed.guard.jobKey).toBe(scheduled.record.jobKey);
  return { guard: claimed.guard, live };
}

export async function stage(
  port: PublicationTestPort,
  scopeBinding: string,
  sourceRef: string,
  attempt: Attempt,
  extractionRef: string,
  accepted: readonly PublicationFact[]
): Promise<unknown> {
  const entityIds = accepted.flatMap((fact) =>
    fact.identity.kind === "entity" ? [fact.identity.input.entityId] : []
  );
  await port.seedGraphEntities(entityIds);
  return port.publication.stageAttempt({
    scopeBinding,
    sourceRef,
    guard: attempt.guard,
    extractionRef,
    accepted,
  });
}

async function publish(
  port: PublicationTestPort,
  scopeBinding: string,
  sourceRef: string,
  attempt: Attempt
): Promise<unknown> {
  return publishAt(
    port,
    scopeBinding,
    sourceRef,
    attempt,
    port.clock().toISOString()
  );
}

async function publishAt(
  port: PublicationTestPort,
  scopeBinding: string,
  sourceRef: string,
  attempt: Attempt,
  at: string
): Promise<unknown> {
  return port.publication.publish({
    scopeBinding,
    sourceRef,
    guard: attempt.guard,
    at,
  });
}

function setWorkerClockNearLeaseExpiry(
  port: PublicationTestPort,
  remainingLeaseMs: number
): void {
  port.clock.set(new Date(Date.now() - WORK_LEASE_MS + remainingLeaseMs));
}

async function waitForLeaseExpiry(
  guard: MaintenanceAttemptGuard
): Promise<void> {
  const expiry = new Date(guard.leaseExpiresAt).getTime() + 25;
  const remaining = expiry - Date.now();
  if (remaining > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  }
}

export interface NearExpiryPublication {
  readonly sourceRef: string;
  readonly scopeBinding: string;
  readonly version: SeededVersion;
  readonly attempt: Attempt;
  readonly eventAt: string;
  readonly leaseExpiresAt: number;
  readonly fact: PublicationFact;
}

export async function prepareNearExpiryAttempt(
  port: PublicationTestPort,
  label: string,
  remainingLeaseMs: number
): Promise<NearExpiryPublication> {
  const sourceRef = unique(`${label}-source`);
  const scopeBinding = unique(`${label}-scope`);
  const version = await registerVersion(port, sourceRef, "v1");
  const generation = await declareDesired(
    port,
    scopeBinding,
    [sourceRef],
    version,
    1
  );
  setWorkerClockNearLeaseExpiry(port, remainingLeaseMs);
  const attempt = await startAttempt(port, sourceRef, "v1", generation);
  const eventAt = port.clock().toISOString();
  const leaseExpiresAt = new Date(attempt.guard.leaseExpiresAt).getTime();
  expect(new Date(eventAt).getTime()).toBeLessThan(leaseExpiresAt);
  expect(Date.now()).toBeLessThan(leaseExpiresAt);
  const fact = entityFact(
    version,
    UUIDS[0],
    "extract-v1",
    "Lease-bound entity"
  );
  return {
    sourceRef,
    scopeBinding,
    version,
    attempt,
    eventAt,
    leaseExpiresAt,
    fact,
  };
}

async function prepareNearExpiryPublication(
  port: PublicationTestPort,
  label: string,
  remainingLeaseMs: number
): Promise<NearExpiryPublication> {
  const fixture = await prepareNearExpiryAttempt(port, label, remainingLeaseMs);
  await stage(
    port,
    fixture.scopeBinding,
    fixture.sourceRef,
    fixture.attempt,
    "extract-v1",
    [fixture.fact]
  );
  const leaseExpiresAt = fixture.leaseExpiresAt;
  expect(Date.now()).toBeLessThan(leaseExpiresAt);
  return fixture;
}

async function expectPublicationUnchangedAfterLeaseRefusal(
  port: PublicationTestPort,
  fixture: NearExpiryPublication,
  before: PublicationSnapshot,
  outboxCount: number
): Promise<void> {
  const after = await port.publication.readSnapshot({
    scopeBinding: fixture.scopeBinding,
  });
  expect(currentIds(after)).toEqual(currentIds(before));
  expect(after.readRevision).toBe(before.readRevision);
  expect(after.maintenanceRevision).toBe(before.maintenanceRevision);
  expect(sourceView(after, fixture.sourceRef)?.published).toBeNull();
  expect(await port.work.getJob(fixture.attempt.guard.jobKey)).toMatchObject({
    status: "running",
  });
  expect(await port.readOutboxCount(fixture.scopeBinding)).toBe(outboxCount);
}

async function failAttempt(
  port: PublicationTestPort,
  attempt: Attempt
): Promise<void> {
  const outcome = await settleWork(
    { store: port.work, clock: port.clock },
    attempt.guard,
    { status: "failed", failureCode: "invalid_input" },
    attempt.live
  );
  expect(outcome).toMatchObject({
    result: "settled",
    record: { status: "failed" },
  });
}

function entityFact(
  seeded: SeededVersion,
  entityId: string,
  extractionRef: string,
  canonicalName: string,
  unit = 1
): PublicationFact {
  const type = "organization";
  const identity: EntityIdentityInput = { entityId, type };
  const occurrence: SupportOccurrence = {
    subject: "entity",
    result_id: entityId,
    source_ref: seeded.record.source_ref,
    source_version: seeded.record.source_version,
    location: { ...seeded.locator, unit },
    extraction_ref: extractionRef,
    extractedAt: INITIAL_TIME.toISOString(),
  };
  return {
    identity: { kind: "entity", input: identity },
    occurrence,
    display: { canonicalName, type },
  };
}

function assertionFact(
  seeded: SeededVersion,
  extractionRef: string,
  relationNorm: string,
  unit = 1,
  tailEntityId = UUIDS[1]
): PublicationFact {
  const identity: RelationAssertionInput = {
    headEntityId: UUIDS[0],
    relationNorm,
    tailEntityId,
    validWindow: { from: null, until: null },
  };
  const normalized = normalizeRelationAssertion(identity);
  const resultId = deriveRelationAssertionId(normalized);
  const occurrence: SupportOccurrence = {
    subject: "assertion",
    result_id: resultId,
    source_ref: seeded.record.source_ref,
    source_version: seeded.record.source_version,
    location: { ...seeded.locator, unit },
    extraction_ref: extractionRef,
    extractedAt: INITIAL_TIME.toISOString(),
  };
  return {
    identity: { kind: "relation_assertion", input: identity },
    occurrence,
  };
}

function currentIds(snapshot: PublicationSnapshot): string[] {
  return snapshot.subjects
    .map((subject) => subject.resultId)
    .sort((left, right) => left.localeCompare(right));
}

function sourceView(snapshot: PublicationSnapshot, sourceRef: string) {
  return snapshot.sources.find((source) => source.sourceRef === sourceRef);
}

function revision(snapshot: PublicationSnapshot): string {
  return snapshot.readRevision;
}

function expectOnlyOldOrNew(
  snapshots: readonly PublicationSnapshot[],
  oldIds: readonly string[],
  newIds: readonly string[]
): void {
  for (const snapshot of snapshots) {
    const observed = currentIds(snapshot);
    expect(
      (observed.length === oldIds.length &&
        oldIds.every((id) => observed.includes(id))) ||
        (observed.length === newIds.length &&
          newIds.every((id) => observed.includes(id)))
    ).toBe(true);
  }
}

function describeContract(
  label: string,
  open: () => Promise<PublicationTestPort>,
  describeSuite:
    typeof vitestDescribe | typeof vitestDescribe.skip = vitestDescribe
): void {
  describeSuite(`${label}: accepted structured publication`, () => {
    const openPorts: PublicationTestPort[] = [];
    const openForTest = async (): Promise<PublicationTestPort> => {
      const port = await open();
      openPorts.push(port);
      return port;
    };

    afterEach(async () => {
      await Promise.all(openPorts.splice(0).map((port) => port.close()));
    });

    it("serves v1 unchanged while v2 is pending and after its extraction fails", async () => {
      const port = await openForTest();
      const sourceRef = unique("source-v1-v2");
      const scopeBinding = unique("scope-v1-v2");
      const v1 = await registerVersion(port, sourceRef, "v1");
      const v1Generation = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        v1,
        1
      );
      const v1Attempt = await startAttempt(port, sourceRef, "v1", v1Generation);
      const v1Fact = entityFact(v1, UUIDS[0], "extract-v1", "Original name");
      await stage(port, scopeBinding, sourceRef, v1Attempt, "extract-v1", [
        v1Fact,
      ]);
      await port.publication.publish({
        scopeBinding,
        sourceRef,
        guard: v1Attempt.guard,
        at: port.clock().toISOString(),
      });
      const acceptedV1 = await port.publication.readSnapshot({ scopeBinding });
      const originalRevision = revision(acceptedV1);
      expect(currentIds(acceptedV1)).toEqual([UUIDS[0]]);
      expect(sourceView(acceptedV1, sourceRef)).toMatchObject({
        generation: v1Generation,
        desired: { sourceVersion: "v1", extractionRevision: 1 },
        published: { sourceVersion: "v1", extractionRevision: 1 },
      });

      const v2 = await registerVersion(port, sourceRef, "v2");
      const v2Generation = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        v2,
        2
      );
      const v2Attempt = await startAttempt(
        port,
        sourceRef,
        "v2",
        v2Generation,
        "extractor-v1",
        1
      );
      const pending = await port.publication.readSnapshot({ scopeBinding });
      expect(currentIds(pending)).toEqual([UUIDS[0]]);
      expect(revision(pending)).toBe(originalRevision);
      expect(sourceView(pending, sourceRef)).toMatchObject({
        desired: { sourceVersion: "v2", extractionRevision: 2 },
        published: { sourceVersion: "v1", extractionRevision: 1 },
        status: "running",
      });

      const v2Fact = entityFact(v2, UUIDS[1], "extract-v2", "Replacement");
      await stage(port, scopeBinding, sourceRef, v2Attempt, "extract-v2", [
        v2Fact,
      ]);
      const beforeFailure = await port.publication.readSnapshot({
        scopeBinding,
      });
      await failAttempt(port, v2Attempt);
      const failed = await port.publication.readSnapshot({ scopeBinding });
      expect(currentIds(failed)).toEqual([UUIDS[0]]);
      expect(revision(failed)).toBe(originalRevision);
      expect(failed.maintenanceRevision).not.toBe(
        beforeFailure.maintenanceRevision
      );
      expect(sourceView(failed, sourceRef)).toMatchObject({
        desired: { sourceVersion: "v2", extractionRevision: 2 },
        published: { sourceVersion: "v1", extractionRevision: 1 },
        status: "failed",
      });
    });

    it("switches the exact serving set and pointer in one publication", async () => {
      const port = await openForTest();
      const sourceRef = unique("atomic-switch");
      const scopeBinding = unique("atomic-scope");
      const v1 = await registerVersion(port, sourceRef, "v1");
      const generation1 = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        v1,
        1
      );
      const first = await startAttempt(port, sourceRef, "v1", generation1);
      await stage(port, scopeBinding, sourceRef, first, "extract-v1", [
        entityFact(v1, UUIDS[0], "extract-v1", "v1 entity"),
      ]);
      await publish(port, scopeBinding, sourceRef, first);
      const before = await port.publication.readSnapshot({ scopeBinding });
      const oldRevision = revision(before);

      const v2 = await registerVersion(port, sourceRef, "v2");
      const generation2 = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        v2,
        2,
        "extractor-v2"
      );
      const second = await startAttempt(
        port,
        sourceRef,
        "v2",
        generation2,
        "extractor-v2",
        1
      );
      await stage(port, scopeBinding, sourceRef, second, "extract-v2", [
        entityFact(v2, UUIDS[1], "extract-v2", "v2 entity"),
      ]);
      const accepted = await publish(port, scopeBinding, sourceRef, second);
      expect(outcomeCode(accepted)).toBeUndefined();

      const after = await port.publication.readSnapshot({ scopeBinding });
      expect(currentIds(after)).toEqual([UUIDS[1]]);
      expect(revision(after)).not.toBe(oldRevision);
      expect(sourceView(after, sourceRef)).toMatchObject({
        generation: generation2,
        desired: { sourceVersion: "v2", extractionRevision: 2 },
        published: { sourceVersion: "v2", extractionRevision: 2 },
        status: "ready",
      });
    });

    it("restores the exact historical display when a published revision is replayed", async () => {
      const port = await openForTest();
      const sourceRef = unique("historical-display");
      const scopeBinding = unique("historical-display-scope");
      const version = await registerVersion(port, sourceRef, "v1");
      const generation1 = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        version,
        1,
        "extractor-v1"
      );
      const first = await startAttempt(port, sourceRef, "v1", generation1);
      const originalFact = entityFact(
        version,
        UUIDS[0],
        "historical-extract-v1",
        "Historical name"
      );
      await stage(
        port,
        scopeBinding,
        sourceRef,
        first,
        "historical-extract-v1",
        [originalFact]
      );
      await publish(port, scopeBinding, sourceRef, first);
      const firstSnapshot = await port.publication.readSnapshot({
        scopeBinding,
      });
      const supportId = firstSnapshot.subjects.find(
        (subject) => subject.resultId === UUIDS[0]
      )?.supportIds[0];
      expect(supportId).toEqual(expect.any(String));

      const generation2 = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        version,
        2,
        "extractor-v2"
      );
      const second = await startAttempt(
        port,
        sourceRef,
        "v1",
        generation2,
        "extractor-v2",
        1
      );
      await stage(
        port,
        scopeBinding,
        sourceRef,
        second,
        "historical-extract-v2",
        [entityFact(version, UUIDS[0], "historical-extract-v2", "Current name")]
      );
      await publish(port, scopeBinding, sourceRef, second);
      const secondSnapshot = await port.publication.readSnapshot({
        scopeBinding,
      });
      expect(
        secondSnapshot.subjects.find((subject) => subject.resultId === UUIDS[0])
          ?.displayValues
      ).toContainEqual(
        expect.objectContaining({
          extractionRevision: 2,
          canonicalName: "Current name",
        })
      );

      const generation3 = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        version,
        1,
        "extractor-v1"
      );
      const replay = await startAttempt(
        port,
        sourceRef,
        "v1",
        generation3,
        "extractor-v1",
        2
      );
      await stage(
        port,
        scopeBinding,
        sourceRef,
        replay,
        "historical-extract-v1",
        [originalFact]
      );
      await publish(port, scopeBinding, sourceRef, replay);

      const replayed = await port.publication.readSnapshot({ scopeBinding });
      const replayedSubject = replayed.subjects.find(
        (subject) => subject.resultId === UUIDS[0]
      );
      expect(replayedSubject?.supportIds).toContain(supportId);
      expect(replayedSubject?.displayValues).toContainEqual(
        expect.objectContaining({
          extractionRevision: 1,
          canonicalName: "Historical name",
          type: "organization",
        })
      );
      expect(await port.evidence.listSupportExtractions(supportId!)).toEqual([
        "historical-extract-v1",
        "historical-extract-v2",
      ]);
      expect(await port.evidence.getSupport(supportId!)).toMatchObject({
        source_version: "v1",
        result_id: UUIDS[0],
      } satisfies Partial<SupportRecord>);
    });

    it.each([
      "config revision",
      "extraction reference",
      "accepted fact payload",
    ])(
      "refuses a conflicting immutable publication pair: %s",
      async (conflict) => {
        const port = await openForTest();
        const sourceRef = unique("immutable-pair");
        const scopeBinding = unique("immutable-pair-scope");
        const version = await registerVersion(port, sourceRef, "v1");
        const generation1 = await declareDesired(
          port,
          scopeBinding,
          [sourceRef],
          version,
          1,
          "extractor-v1"
        );
        const first = await startAttempt(port, sourceRef, "v1", generation1);
        const originalFact = entityFact(
          version,
          UUIDS[0],
          "immutable-extract-v1",
          "Immutable name"
        );
        await stage(
          port,
          scopeBinding,
          sourceRef,
          first,
          "immutable-extract-v1",
          [originalFact]
        );
        await publish(port, scopeBinding, sourceRef, first);
        const published = await port.publication.readSnapshot({ scopeBinding });
        const publishedSubject = published.subjects.find(
          (subject) => subject.resultId === UUIDS[0]
        );
        const supportId = publishedSubject?.supportIds[0];
        expect(supportId).toEqual(expect.any(String));

        const configRevision =
          conflict === "config revision"
            ? "extractor-conflict"
            : "extractor-v1";
        const generation2 = await declareDesired(
          port,
          scopeBinding,
          [sourceRef],
          version,
          1,
          configRevision
        );
        const second = await startAttempt(
          port,
          sourceRef,
          "v1",
          generation2,
          configRevision,
          1
        );
        const extractionRef =
          conflict === "extraction reference"
            ? "immutable-extract-conflict"
            : "immutable-extract-v1";
        const displayName =
          conflict === "accepted fact payload"
            ? "Conflicting name"
            : "Immutable name";
        await stage(port, scopeBinding, sourceRef, second, extractionRef, [
          entityFact(version, UUIDS[0], extractionRef, displayName),
        ]);
        const beforeRefusal = await port.publication.readSnapshot({
          scopeBinding,
        });
        const outboxBefore = await port.readOutboxCount(scopeBinding);

        await expectFailure(
          publish(port, scopeBinding, sourceRef, second),
          "input_stale"
        );

        const afterRefusal = await port.publication.readSnapshot({
          scopeBinding,
        });
        expect(currentIds(afterRefusal)).toEqual(currentIds(published));
        expect(afterRefusal.readRevision).toBe(beforeRefusal.readRevision);
        expect(afterRefusal.maintenanceRevision).toBe(
          beforeRefusal.maintenanceRevision
        );
        expect(sourceView(afterRefusal, sourceRef)?.published).toEqual({
          sourceVersion: "v1",
          extractionRevision: 1,
        });
        expect(
          afterRefusal.subjects.find((subject) => subject.resultId === UUIDS[0])
            ?.displayValues
        ).toContainEqual(
          expect.objectContaining({
            extractionRevision: 1,
            canonicalName: "Immutable name",
          })
        );
        expect(await port.evidence.listSupportExtractions(supportId!)).toEqual([
          "immutable-extract-v1",
        ]);
        expect(await port.work.getJob(second.guard.jobKey)).toMatchObject({
          status: "running",
        });
        expect(await port.readOutboxCount(scopeBinding)).toBe(outboxBefore);
      }
    );

    it("retires only omitted occurrences and keeps a shared support id across extraction revisions", async () => {
      const port = await openForTest();
      const sourceRef = unique("reextract");
      const scopeBinding = unique("reextract-scope");
      const v1 = await registerVersion(port, sourceRef, "v1");
      const generation1 = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        v1,
        1
      );
      const first = await startAttempt(port, sourceRef, "v1", generation1);
      const shared = assertionFact(v1, "extract-v1", "maintains", 1);
      const omitted = assertionFact(v1, "extract-v1", "documents", 2, UUIDS[2]);
      await stage(port, scopeBinding, sourceRef, first, "extract-v1", [
        entityFact(v1, UUIDS[0], "extract-v1", "Example Org", 3),
        entityFact(v1, UUIDS[1], "extract-v1", "Head", 4),
        entityFact(v1, UUIDS[2], "extract-v1", "Tail", 5),
        shared,
        omitted,
      ]);
      await publish(port, scopeBinding, sourceRef, first);
      const before = await port.publication.readSnapshot({ scopeBinding });
      const sharedBefore = before.subjects.find(
        (subject) => subject.resultId === shared.occurrence.result_id
      );
      const entityBefore = before.subjects.find(
        (subject) => subject.resultId === UUIDS[0]
      );
      expect(sharedBefore).toBeDefined();
      expect(entityBefore?.displayValues).toContainEqual(
        expect.objectContaining({
          extractionRevision: 1,
          canonicalName: "Example Org",
          type: "organization",
        })
      );
      expect(
        before.subjects.some(
          (subject) => subject.resultId === omitted.occurrence.result_id
        )
      ).toBe(true);
      const sharedSupportId = sharedBefore!.supportIds[0];
      const oldRevision = revision(before);

      const generation2 = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        v1,
        2,
        "extractor-v2"
      );
      const second = await startAttempt(
        port,
        sourceRef,
        "v1",
        generation2,
        "extractor-v2",
        1
      );
      const sharedAgain = {
        ...shared,
        occurrence: { ...shared.occurrence, extraction_ref: "extract-v2" },
      };
      await stage(port, scopeBinding, sourceRef, second, "extract-v2", [
        entityFact(v1, UUIDS[0], "extract-v2", "Example Org v2", 3),
        entityFact(v1, UUIDS[1], "extract-v2", "Head", 4),
        entityFact(v1, UUIDS[2], "extract-v2", "Tail", 5),
        sharedAgain,
      ]);
      await publish(port, scopeBinding, sourceRef, second);

      const after = await port.publication.readSnapshot({ scopeBinding });
      const sharedAfter = after.subjects.find(
        (subject) => subject.resultId === shared.occurrence.result_id
      );
      const entityAfter = after.subjects.find(
        (subject) => subject.resultId === UUIDS[0]
      );
      expect(sharedAfter?.supportIds).toContain(sharedSupportId);
      expect(entityAfter?.displayValues).toContainEqual(
        expect.objectContaining({
          extractionRevision: 2,
          canonicalName: "Example Org v2",
          type: "organization",
        })
      );
      expect(entityAfter?.displayValues).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ extractionRevision: 1 }),
        ])
      );
      expect(
        after.subjects.some(
          (subject) => subject.resultId === omitted.occurrence.result_id
        )
      ).toBe(false);
      expect(revision(after)).not.toBe(oldRevision);
      expect(
        await port.evidence.listSupportExtractions(sharedSupportId)
      ).toEqual(["extract-v1", "extract-v2"]);
      expect(await port.evidence.getSupport(sharedSupportId)).toMatchObject({
        result_id: shared.occurrence.result_id,
        source_version: "v1",
      } satisfies Partial<SupportRecord>);
    });

    it("withdraws origins independently and removes a subject only after its last support", async () => {
      const port = await openForTest();
      const scopeBinding = unique("multi-origin-scope");
      const sourceA = unique("origin-a");
      const sourceB = unique("origin-b");
      const a = await registerVersion(port, sourceA, "v1", "same fact from A");
      const b = await registerVersion(port, sourceB, "v1", "same fact from B");
      const generationA = await declareDesired(
        port,
        scopeBinding,
        [sourceA],
        a,
        1
      );
      const attemptA = await startAttempt(port, sourceA, "v1", generationA);
      const assertionA = assertionFact(a, "extract-a", "member_of");
      await stage(port, scopeBinding, sourceA, attemptA, "extract-a", [
        entityFact(a, UUIDS[0], "extract-a", "Shared Org"),
        entityFact(a, UUIDS[1], "extract-a", "Member"),
        assertionA,
      ]);
      await publish(port, scopeBinding, sourceA, attemptA);

      const generationB = await declareDesired(
        port,
        scopeBinding,
        [sourceA, sourceB],
        b,
        1
      );
      const attemptB = await startAttempt(port, sourceB, "v1", generationB);
      const assertionB = assertionFact(b, "extract-b", "member_of");
      await stage(port, scopeBinding, sourceB, attemptB, "extract-b", [
        entityFact(b, UUIDS[0], "extract-b", "Shared Org"),
        entityFact(b, UUIDS[1], "extract-b", "Member"),
        assertionB,
      ]);
      await publish(port, scopeBinding, sourceB, attemptB);

      const beforeWithdraw = await port.publication.readSnapshot({
        scopeBinding,
      });
      const joined = beforeWithdraw.subjects.find(
        (subject) => subject.resultId === assertionA.occurrence.result_id
      );
      expect(joined?.supportIds).toHaveLength(2);
      const joinedSupports = await Promise.all(
        joined!.supportIds.map((supportId) =>
          port.evidence.getSupport(supportId)
        )
      );
      const supportFromA = joinedSupports.find(
        (support) => support?.source_ref === sourceA
      );
      const supportFromB = joinedSupports.find(
        (support) => support?.source_ref === sourceB
      );
      expect(supportFromA).toBeDefined();
      expect(supportFromB).toBeDefined();

      const withdrawnA = await port.publication.withdraw({
        scopeBinding,
        sourceRef: sourceA,
        expectedGeneration: generationA,
        at: port.clock().toISOString(),
      });
      expect(outcomeCode(withdrawnA)).toBeUndefined();
      expect(withdrawnA).toMatchObject({ generation: generationA + 1 });
      const afterA = await port.publication.readSnapshot({ scopeBinding });
      const remaining = afterA.subjects.find(
        (subject) => subject.resultId === assertionA.occurrence.result_id
      );
      expect(remaining?.supportIds).toHaveLength(1);
      expect(
        await port.evidence.getSupport(supportFromB!.support_id)
      ).not.toBeNull();

      const withdrawnB = await port.publication.withdraw({
        scopeBinding,
        sourceRef: sourceB,
        expectedGeneration: generationB,
        at: port.clock().toISOString(),
      });
      expect(outcomeCode(withdrawnB)).toBeUndefined();
      expect(withdrawnB).toMatchObject({ generation: generationB + 1 });
      const afterB = await port.publication.readSnapshot({ scopeBinding });
      expect(
        afterB.subjects.some(
          (subject) => subject.resultId === assertionA.occurrence.result_id
        )
      ).toBe(false);
      expect(
        await port.evidence.getSupport(supportFromA!.support_id)
      ).not.toBeNull();
    });

    it("fences an A-to-B-to-A attempt before intermediate stage writes", async () => {
      const port = await openForTest();
      const sourceRef = unique("aba-source");
      const scopeBinding = unique("aba-scope");
      const versionA = await registerVersion(
        port,
        sourceRef,
        "A",
        "original A"
      );
      const versionB = await registerVersion(port, sourceRef, "B", "version B");
      const generationA1 = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        versionA,
        1
      );
      const staleAttempt = await startAttempt(
        port,
        sourceRef,
        "A",
        generationA1
      );
      await stage(
        port,
        scopeBinding,
        sourceRef,
        staleAttempt,
        "extract-A-old",
        [entityFact(versionA, UUIDS[0], "extract-A-old", "stale staged entity")]
      );

      const generationB = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        versionB,
        1
      );
      const generationA2 = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        versionA,
        2,
        "extractor-v2"
      );
      expect(generationB).toBe(generationA1 + 1);
      expect(generationA2).toBe(generationB + 1);

      const currentAttempt = await startAttempt(
        port,
        sourceRef,
        "A",
        generationA2,
        "extractor-v2"
      );
      expect(await port.work.getJob(currentAttempt.guard.jobKey)).toMatchObject(
        { status: "running" }
      );

      await expectFailure(
        stage(
          port,
          scopeBinding,
          sourceRef,
          staleAttempt,
          "extract-A-stale-write",
          [
            entityFact(
              versionA,
              UUIDS[1],
              "extract-A-stale-write",
              "must not append"
            ),
          ]
        ),
        "input_stale"
      );
      const generationView = await port.publication.readSnapshot({
        scopeBinding,
      });
      expect(sourceView(generationView, sourceRef)).toMatchObject({
        generation: generationA2,
        desired: { sourceVersion: "A", extractionRevision: 2 },
      });
      expect(currentIds(generationView)).toEqual([]);
      expect(await port.work.getJob(currentAttempt.guard.jobKey)).toMatchObject(
        { status: "running" }
      );
      await stage(
        port,
        scopeBinding,
        sourceRef,
        currentAttempt,
        "extract-A-current",
        [entityFact(versionA, UUIDS[2], "extract-A-current", "current entity")]
      );
      await publish(port, scopeBinding, sourceRef, currentAttempt);
      const after = await port.publication.readSnapshot({ scopeBinding });
      expect(currentIds(after)).toEqual([UUIDS[2]]);
      expect(
        after.subjects.some((subject) => subject.resultId === UUIDS[1])
      ).toBe(false);
      const job = await port.work.getJob(currentAttempt.guard.jobKey);
      expect(job?.status).toBe("ready");
      const supersededSettlement = await settleWork(
        { store: port.work, clock: port.clock },
        staleAttempt.guard,
        { status: "ready" },
        {
          configRevision: "extractor-v2",
          dependencies: [
            {
              sourceRef,
              generation: generationA2,
              extractionRevision: null,
              relationBuckets: [],
            },
          ],
        }
      );
      expect(supersededSettlement).toMatchObject({ result: "stale" });
    });

    it("rejects writes from an expired token after the work is reclaimed", async () => {
      const port = await openForTest();
      const sourceRef = unique("expired-source");
      const scopeBinding = unique("expired-scope");
      const v1 = await registerVersion(port, sourceRef, "v1");
      const generation = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        v1,
        1
      );
      const oldAttempt = await startAttempt(port, sourceRef, "v1", generation);
      await stage(
        port,
        scopeBinding,
        sourceRef,
        oldAttempt,
        "expired-extraction",
        [
          entityFact(
            v1,
            UUIDS[0],
            "expired-extraction",
            "Expired staged entity"
          ),
        ]
      );
      port.clock.advance(5 * 60_000 + 1);
      const replacement = await claimNextWork({
        store: port.work,
        clock: port.clock,
      });
      expect(
        replacement.reclaimed.some(
          (item) => item.jobKey === oldAttempt.guard.jobKey
        )
      ).toBe(true);
      expect(replacement.guard?.jobKey).toBe(oldAttempt.guard.jobKey);
      expect(replacement.guard?.attemptNumber).toBe(
        oldAttempt.guard.attemptNumber + 1
      );
      expect(await port.work.getJob(oldAttempt.guard.jobKey)).toMatchObject({
        status: "running",
        attemptCount: replacement.guard?.attemptNumber,
      });

      await expectFailure(
        stage(port, scopeBinding, sourceRef, oldAttempt, "expired-extraction", [
          entityFact(v1, UUIDS[0], "expired-extraction", "must not write"),
        ]),
        "lease_lost"
      );
      expect(await port.work.getJob(oldAttempt.guard.jobKey)).toMatchObject({
        status: "running",
        attemptCount: replacement.guard?.attemptNumber,
      });
      await expectFailure(
        publish(port, scopeBinding, sourceRef, oldAttempt),
        "lease_lost"
      );
      const job = await port.work.getJob(oldAttempt.guard.jobKey);
      expect(job?.status).toBe("running");
      expect(job?.attemptCount).toBe(replacement.guard?.attemptNumber);
      expect(
        currentIds(await port.publication.readSnapshot({ scopeBinding }))
      ).toEqual([]);
    });

    it("rejects a backdated publication timestamp after the live lease expires", async () => {
      const port = await openForTest();
      const fixture = await prepareNearExpiryPublication(
        port,
        "publish-expired-backdated",
        2_500
      );
      const before = await port.publication.readSnapshot({
        scopeBinding: fixture.scopeBinding,
      });
      const outboxCount = await port.readOutboxCount(fixture.scopeBinding);

      await waitForLeaseExpiry(fixture.attempt.guard);
      expect(Date.now()).toBeGreaterThanOrEqual(fixture.leaseExpiresAt);
      expect(new Date(fixture.eventAt).getTime()).toBeLessThan(
        fixture.leaseExpiresAt
      );
      await expectFailure(
        publishAt(
          port,
          fixture.scopeBinding,
          fixture.sourceRef,
          fixture.attempt,
          fixture.eventAt
        ),
        "lease_lost"
      );

      await expectPublicationUnchangedAfterLeaseRefusal(
        port,
        fixture,
        before,
        outboxCount
      );
    });

    it("rechecks the live lease after outbox preparation crosses its deadline", async () => {
      const port = await openForTest();
      const fixture = await prepareNearExpiryPublication(
        port,
        "publish-expired-during-outbox",
        2_500
      );
      const before = await port.publication.readSnapshot({
        scopeBinding: fixture.scopeBinding,
      });
      const outboxCount = await port.readOutboxCount(fixture.scopeBinding);
      const delayMs = 3_000;
      expect(Date.now() + delayMs).toBeGreaterThan(fixture.leaseExpiresAt);
      await port.delayNextOutboxWrite(delayMs);

      await expectFailure(
        publishAt(
          port,
          fixture.scopeBinding,
          fixture.sourceRef,
          fixture.attempt,
          fixture.eventAt
        ),
        "lease_lost"
      );
      expect(Date.now()).toBeGreaterThanOrEqual(fixture.leaseExpiresAt);
      await expectPublicationUnchangedAfterLeaseRefusal(
        port,
        fixture,
        before,
        outboxCount
      );
    });

    it("counts pending and zero-hit sources while excluding a different trusted scope", async () => {
      const port = await openForTest();
      const pendingSource = unique("pending-source");
      const zeroHitSource = unique("zero-hit-source");
      const hiddenSource = unique("hidden-source");
      const visibleScope = unique("visible-scope");
      const hiddenScope = unique("hidden-scope");
      const pending = await registerVersion(port, pendingSource, "v1");
      const zeroHit = await registerVersion(port, zeroHitSource, "v1");
      const hidden = await registerVersion(port, hiddenSource, "v1");
      const visibleSourceRefs = [pendingSource, zeroHitSource];
      const pendingGeneration = await declareDesired(
        port,
        visibleScope,
        visibleSourceRefs,
        pending,
        1
      );
      const zeroHitGeneration = await declareDesired(
        port,
        visibleScope,
        visibleSourceRefs,
        zeroHit,
        1
      );
      const hiddenGeneration = await declareDesired(
        port,
        hiddenScope,
        [hiddenSource],
        hidden,
        1
      );
      const pendingAttempt = await startAttempt(
        port,
        pendingSource,
        "v1",
        pendingGeneration
      );
      const zeroHitAttempt = await startAttempt(
        port,
        zeroHitSource,
        "v1",
        zeroHitGeneration
      );
      const hiddenAttempt = await startAttempt(
        port,
        hiddenSource,
        "v1",
        hiddenGeneration
      );
      expect(pendingAttempt.guard.sourceGeneration).toBe(pendingGeneration);
      await stage(
        port,
        hiddenScope,
        hiddenSource,
        hiddenAttempt,
        "hidden-extract",
        [entityFact(hidden, UUIDS[0], "hidden-extract", "Hidden entity")]
      );
      await publish(port, hiddenScope, hiddenSource, hiddenAttempt);

      await stage(
        port,
        visibleScope,
        zeroHitSource,
        zeroHitAttempt,
        "zero-hit-extract",
        []
      );
      await publish(port, visibleScope, zeroHitSource, zeroHitAttempt);
      const visibleStatus = await port.publication.readSnapshot({
        scopeBinding: visibleScope,
      });
      expect(visibleStatus.sources).toHaveLength(2);
      expect(visibleStatus.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceRef: pendingSource,
            generation: pendingGeneration,
            published: null,
            status: "running",
          }),
          expect.objectContaining({
            sourceRef: zeroHitSource,
            generation: zeroHitGeneration,
            published: { sourceVersion: "v1", extractionRevision: 1 },
            status: "ready",
          }),
        ])
      );
      expect(visibleStatus.maintenance).toEqual({
        sourcesInScope: 2,
        publishedSources: 1,
      });
      expect(visibleStatus.subjects).toEqual([]);
      expect(currentIds(visibleStatus)).not.toContain(UUIDS[0]);
      expect(
        visibleStatus.sources.some(
          (source) => source.sourceRef === hiddenSource
        )
      ).toBe(false);
      const hiddenSnapshot = await port.publication.readSnapshot({
        scopeBinding: hiddenScope,
      });
      expect(hiddenSnapshot.subjects).toHaveLength(1);
      expect(hiddenSnapshot.maintenance).toEqual({
        sourcesInScope: 1,
        publishedSources: 1,
      });
    });

    it("keeps one owner scope per source and refuses a second-scope declaration", async () => {
      const port = await openForTest();
      const sourceRef = unique("single-owner-source");
      const scopeA = unique("owner-scope-a");
      const scopeB = unique("owner-scope-b");
      const version = await registerVersion(port, sourceRef, "v1");
      const generation = await declareDesired(
        port,
        scopeA,
        [sourceRef],
        version,
        1
      );
      const attempt = await startAttempt(port, sourceRef, "v1", generation);
      await stage(port, scopeA, sourceRef, attempt, "extract-v1", [
        entityFact(version, UUIDS[0], "extract-v1", "Owner-scoped entity"),
      ]);
      await publish(port, scopeA, sourceRef, attempt);
      const beforeA = await port.publication.readSnapshot({
        scopeBinding: scopeA,
      });

      await expectFailure(
        port.publication.declareDesired({
          scopeBinding: scopeB,
          authorizedSourceRefs: [sourceRef],
          sourceRef,
          sourceVersion: version.record,
          locatorBindings: version.locatorBindings,
          desiredExtractionRevision: 1,
          configRevision: "extractor-v1",
        }),
        "unsupported_source_binding"
      );

      const afterA = await port.publication.readSnapshot({
        scopeBinding: scopeA,
      });
      const afterB = await port.publication.readSnapshot({
        scopeBinding: scopeB,
      });
      expect(afterA).toEqual(beforeA);
      expect(afterB.sources).toEqual([]);
      expect(afterB.subjects).toEqual([]);
    });

    it("advances maintenance progress separately from current-data revision", async () => {
      const port = await openForTest();
      const sourceRef = unique("revision-source");
      const scopeBinding = unique("revision-scope");
      const v1 = await registerVersion(port, sourceRef, "v1");
      const generation = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        v1,
        1
      );
      const initial = await port.publication.readSnapshot({ scopeBinding });
      const attempt = await startAttempt(port, sourceRef, "v1", generation);
      const running = await port.publication.readSnapshot({ scopeBinding });
      expect(running.readRevision).toBe(initial.readRevision);
      expect(running.maintenanceRevision).not.toBe(initial.maintenanceRevision);
      expect(sourceView(running, sourceRef)?.status).toBe("running");

      await stage(port, scopeBinding, sourceRef, attempt, "extract-v1", [
        entityFact(v1, UUIDS[0], "extract-v1", "Example"),
      ]);
      const staged = await port.publication.readSnapshot({ scopeBinding });
      expect(staged.readRevision).toBe(initial.readRevision);
      expect(staged.maintenanceRevision).not.toBe(running.maintenanceRevision);
      expect(staged.subjects).toEqual([]);
    });

    it("never exposes a mixed set while readers race a successful replacement", async () => {
      const port = await openForTest();
      const sourceRef = unique("reader-race");
      const scopeBinding = unique("reader-race-scope");
      const v1 = await registerVersion(port, sourceRef, "v1");
      const generation1 = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        v1,
        1
      );
      const first = await startAttempt(port, sourceRef, "v1", generation1);
      const oldFacts = [
        entityFact(v1, UUIDS[0], "extract-v1", "old A"),
        entityFact(v1, UUIDS[1], "extract-v1", "old B"),
      ];
      await stage(port, scopeBinding, sourceRef, first, "extract-v1", oldFacts);
      await publish(port, scopeBinding, sourceRef, first);

      const v2 = await registerVersion(port, sourceRef, "v2");
      const generation2 = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        v2,
        2,
        "extractor-v2"
      );
      const second = await startAttempt(
        port,
        sourceRef,
        "v2",
        generation2,
        "extractor-v2",
        1
      );
      const newFacts = [
        entityFact(v2, UUIDS[2], "extract-v2", "new A"),
        entityFact(v2, UUIDS[3], "extract-v2", "new B"),
      ];
      await stage(
        port,
        scopeBinding,
        sourceRef,
        second,
        "extract-v2",
        newFacts
      );
      const readers = Array.from({ length: 8 }, () =>
        port.publication.readSnapshot({ scopeBinding })
      );
      const commit = publish(port, scopeBinding, sourceRef, second);
      const snapshots = await Promise.all([
        ...readers,
        commit.then(() => port.publication.readSnapshot({ scopeBinding })),
      ]);
      expectOnlyOldOrNew(snapshots, [UUIDS[0], UUIDS[1]], [UUIDS[2], UUIDS[3]]);
    });

    it("withdrawal racing a worker prevents that worker from resurrecting the source", async () => {
      const port = await openForTest();
      const sourceRef = unique("withdraw-race");
      const scopeBinding = unique("withdraw-race-scope");
      const v1 = await registerVersion(port, sourceRef, "v1");
      const generation = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        v1,
        1
      );
      const attempt = await startAttempt(port, sourceRef, "v1", generation);
      await stage(port, scopeBinding, sourceRef, attempt, "extract-v1", [
        entityFact(v1, UUIDS[0], "extract-v1", "Withdrawn entity"),
      ]);
      const [withdrawalResult, publicationResult] = await Promise.allSettled([
        port.publication.withdraw({
          scopeBinding,
          sourceRef,
          expectedGeneration: generation,
          at: port.clock().toISOString(),
        }),
        publish(port, scopeBinding, sourceRef, attempt),
      ]);
      expect(withdrawalResult.status).toBe("fulfilled");
      const withdrawn =
        withdrawalResult.status === "fulfilled"
          ? withdrawalResult.value
          : undefined;
      expect(outcomeCode(withdrawn)).toBeUndefined();
      const snapshot = await port.publication.readSnapshot({ scopeBinding });
      expect(currentIds(snapshot)).toEqual([]);
      expect(sourceView(snapshot, sourceRef)?.generation).toBe(generation + 1);
      const publication =
        publicationResult.status === "fulfilled"
          ? publicationResult.value
          : publicationResult.reason;
      expect(
        outcomeCode(publication) === undefined ||
          outcomeCode(publication) === "input_stale"
      ).toBe(true);
    });

    it("rolls identity, evidence, work, membership, revision, and outbox back on projection failure", async () => {
      const port = await openForTest();
      const sourceRef = unique("outbox-fault");
      const scopeBinding = unique("outbox-fault-scope");
      const v1 = await registerVersion(port, sourceRef, "v1");
      const generation1 = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        v1,
        1
      );
      const first = await startAttempt(port, sourceRef, "v1", generation1);
      const shared = assertionFact(
        v1,
        "extract-fault-v1",
        "stable_fault_subject"
      );
      await stage(port, scopeBinding, sourceRef, first, "extract-fault-v1", [
        entityFact(v1, UUIDS[0], "extract-fault-v1", "Stable head", 2),
        entityFact(v1, UUIDS[1], "extract-fault-v1", "Stable tail", 3),
        shared,
      ]);
      await publish(port, scopeBinding, sourceRef, first);
      const before = await port.publication.readSnapshot({ scopeBinding });
      const sharedCurrent = before.subjects.find(
        (subject) => subject.resultId === shared.occurrence.result_id
      );
      expect(sharedCurrent).toBeDefined();
      const sharedSupportId = sharedCurrent!.supportIds[0]!;
      const oldExtractionLinks =
        await port.evidence.listSupportExtractions(sharedSupportId);
      expect(oldExtractionLinks).toEqual(["extract-fault-v1"]);

      const generation2 = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        v1,
        2,
        "extractor-v2"
      );
      const attempt = await startAttempt(
        port,
        sourceRef,
        "v1",
        generation2,
        "extractor-v2",
        1
      );
      const replayedShared = {
        ...shared,
        occurrence: {
          ...shared.occurrence,
          extraction_ref: "extract-fault-v2",
        },
      };
      const newAssertion = assertionFact(
        v1,
        "extract-fault-v2",
        unique("fault_relation")
      );
      await stage(port, scopeBinding, sourceRef, attempt, "extract-fault-v2", [
        entityFact(v1, UUIDS[0], "extract-fault-v2", "Stable head v2", 2),
        entityFact(v1, UUIDS[1], "extract-fault-v2", "Stable tail v2", 3),
        entityFact(v1, UUIDS[2], "extract-fault-v2", "New entity", 4),
        replayedShared,
        newAssertion,
      ]);
      const prePublish = await port.publication.readSnapshot({ scopeBinding });
      const baseOutbox = await port.readOutboxCount(scopeBinding);
      const assertionIdentity = normalizeRelationAssertion(
        (
          newAssertion.identity as {
            kind: "relation_assertion";
            input: RelationAssertionInput;
          }
        ).input
      );
      const assertionId = deriveRelationAssertionId(assertionIdentity);
      expect(await port.identity.findRelationAssertion(assertionId)).toBeNull();
      await port.failNextOutboxWrite();
      await expectFailure(
        publish(port, scopeBinding, sourceRef, attempt),
        "backend_unavailable"
      );

      const after = await port.publication.readSnapshot({ scopeBinding });
      expect(currentIds(after)).toEqual(currentIds(prePublish));
      expect(after.readRevision).toBe(prePublish.readRevision);
      expect(after.maintenanceRevision).toBe(prePublish.maintenanceRevision);
      expect(sourceView(after, sourceRef)).toMatchObject({
        desired: { sourceVersion: "v1", extractionRevision: 2 },
        published: { sourceVersion: "v1", extractionRevision: 1 },
      });
      expect(await port.identity.findRelationAssertion(assertionId)).toBeNull();
      expect(
        await port.evidence.listSupportExtractions(sharedSupportId)
      ).toEqual(oldExtractionLinks);
      expect(await port.evidence.getSupport(sharedSupportId)).not.toBeNull();
      const stagedJob = await port.work.getJob(attempt.guard.jobKey);
      expect(stagedJob?.status).toBe("running");
      expect(await port.readOutboxCount(scopeBinding)).toBe(baseOutbox);
    });

    it.each([
      ["empty source", { sourceRef: "" }, "invalid_input"],
      ["empty scope binding", { scopeBinding: "" }, "invalid_input"],
      [
        "negative extraction revision",
        { desiredExtractionRevision: -1 },
        "invalid_input",
      ],
      [
        "unsafe extraction revision",
        { desiredExtractionRevision: Number.MAX_SAFE_INTEGER + 1 },
        "invalid_input",
      ],
      ["missing config revision", { configRevision: "" }, "invalid_input"],
      ["unauthorized source", { authorizedSourceRefs: [] }, "invalid_input"],
    ] as const)(
      "refuses %s without creating desired or serving state",
      async (_label, overrides, code) => {
        const port = await openForTest();
        const sourceRef = unique("invalid-source");
        const scopeBinding = unique("invalid-scope");
        const v1 = await registerVersion(port, sourceRef, "v1");
        const input = {
          scopeBinding,
          authorizedSourceRefs: [sourceRef],
          sourceRef,
          sourceVersion: v1.record,
          locatorBindings: [...v1.locatorBindings],
          desiredExtractionRevision: 1,
          configRevision: "extractor-v1",
          ...overrides,
        };
        await expectFailure(port.publication.declareDesired(input), code);
        const result = await port.publication.readSnapshot({ scopeBinding });
        expect(
          result.sources.some((source) => source.sourceRef === sourceRef)
        ).toBe(false);
        expect(result.subjects).toEqual([]);
      }
    );

    it("refuses a source version declared for a different source", async () => {
      const port = await openForTest();
      const sourceRef = unique("mismatched-source");
      const scopeBinding = unique("mismatched-source-scope");
      const version = await registerVersion(port, sourceRef, "v1");
      await expectFailure(
        port.publication.declareDesired({
          scopeBinding,
          authorizedSourceRefs: [sourceRef],
          sourceRef,
          sourceVersion: {
            ...version.record,
            source_ref: unique("other-source"),
          },
          locatorBindings: [...version.locatorBindings],
          desiredExtractionRevision: 1,
          configRevision: "extractor-v1",
        }),
        "invalid_input"
      );
      const snapshot = await port.publication.readSnapshot({ scopeBinding });
      expect(snapshot.sources).toEqual([]);
      expect(snapshot.subjects).toEqual([]);
    });

    it("refuses invalid stage, publish, withdrawal, and status inputs without mutation", async () => {
      const port = await openForTest();
      const sourceRef = unique("entry-input-source");
      const scopeBinding = unique("entry-input-scope");
      const version = await registerVersion(port, sourceRef, "v1");
      const generation = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        version,
        1
      );
      const attempt = await startAttempt(port, sourceRef, "v1", generation);
      const beforeInvalidStage = await port.publication.readSnapshot({
        scopeBinding,
      });

      await expectFailure(
        port.publication.stageAttempt({
          scopeBinding,
          sourceRef,
          guard: attempt.guard,
          extractionRef: "",
          accepted: [],
        }),
        "invalid_input"
      );
      const validSpanFact = entityFact(
        version,
        UUIDS[0],
        "invalid-span",
        "Invalid span"
      );
      const invalidSpanFact: PublicationFact = {
        ...validSpanFact,
        occurrence: {
          ...validSpanFact.occurrence,
          span: { start: -1, end: 2 },
        },
      };
      await port.seedGraphEntities([UUIDS[0]]);
      await expectFailure(
        port.publication.stageAttempt({
          scopeBinding,
          sourceRef,
          guard: attempt.guard,
          extractionRef: "invalid-span",
          accepted: [invalidSpanFact],
        }),
        "invalid_input"
      );
      expect(
        (await port.publication.readSnapshot({ scopeBinding }))
          .maintenanceRevision
      ).toBe(beforeInvalidStage.maintenanceRevision);

      await stage(
        port,
        scopeBinding,
        sourceRef,
        attempt,
        "empty-extraction",
        []
      );
      const beforeInvalidPublish = await port.publication.readSnapshot({
        scopeBinding,
      });
      await expectFailure(
        port.publication.publish({
          scopeBinding,
          sourceRef,
          guard: attempt.guard,
          at: "not-a-timestamp",
        }),
        "invalid_input"
      );
      const afterInvalidPublish = await port.publication.readSnapshot({
        scopeBinding,
      });
      expect(afterInvalidPublish.readRevision).toBe(
        beforeInvalidPublish.readRevision
      );
      expect(afterInvalidPublish.maintenanceRevision).toBe(
        beforeInvalidPublish.maintenanceRevision
      );
      expect(sourceView(afterInvalidPublish, sourceRef)).toMatchObject({
        status: "running",
        published: null,
      });

      await publish(port, scopeBinding, sourceRef, attempt);
      const served = await port.publication.readSnapshot({ scopeBinding });
      await expectFailure(
        port.publication.withdraw({
          scopeBinding,
          sourceRef,
          expectedGeneration: -1,
          at: port.clock().toISOString(),
        }),
        "invalid_input"
      );
      await expectFailure(
        port.publication.withdraw({
          scopeBinding,
          sourceRef,
          expectedGeneration: generation,
          at: "not-a-timestamp",
        }),
        "invalid_input"
      );
      await expectFailure(
        port.publication.readSnapshot({ scopeBinding: "" }),
        "invalid_input"
      );
      const afterInvalidWithdrawal = await port.publication.readSnapshot({
        scopeBinding,
      });
      expect(afterInvalidWithdrawal.readRevision).toBe(served.readRevision);
      expect(afterInvalidWithdrawal.maintenanceRevision).toBe(
        served.maintenanceRevision
      );
      expect(currentIds(afterInvalidWithdrawal)).toEqual(currentIds(served));
      expect(sourceView(afterInvalidWithdrawal, sourceRef)).toMatchObject({
        status: "ready",
        published: { sourceVersion: "v1", extractionRevision: 1 },
      });
    });

    it("accepts a valid empty extraction as a published zero-hit source", async () => {
      const port = await openForTest();
      const sourceRef = unique("empty-extraction");
      const scopeBinding = unique("empty-extraction-scope");
      const v1 = await registerVersion(port, sourceRef, "v1");
      const generation = await declareDesired(
        port,
        scopeBinding,
        [sourceRef],
        v1,
        1
      );
      const attempt = await startAttempt(port, sourceRef, "v1", generation);
      await stage(port, scopeBinding, sourceRef, attempt, "empty-extract", []);
      await publish(port, scopeBinding, sourceRef, attempt);
      const snapshot = await port.publication.readSnapshot({ scopeBinding });
      expect(snapshot.subjects).toEqual([]);
      expect(sourceView(snapshot, sourceRef)).toMatchObject({
        desired: { sourceVersion: "v1", extractionRevision: 1 },
        published: { sourceVersion: "v1", extractionRevision: 1 },
        status: "ready",
      });
    });
  });
}

export { describeContract };
