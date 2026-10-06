import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { claimNextWork, scheduleWork } from "../../src/core/maintenance/service.js";
import {
  MAX_AUTO_ATTEMPTS,
  WORK_ABSOLUTE_LIMIT_MS,
  WORK_LEASE_MS,
} from "../../src/core/maintenance/types.js";
import type {
  MaintenanceAttemptGuard,
  MaintenanceDependency,
  MaintenanceWorkRequest,
  MaintenanceWorkStore,
} from "../../src/core/maintenance/types.js";
import type {
  PublicationFact,
  StructuredPublicationStorage,
} from "../../src/core/maintenance/publication-types.js";
import type { EntityIdentityInput } from "../../src/core/structured/identity-store.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import type { ChunkRecord } from "../../src/core/types.js";
import {
  createPublicationTestClock,
  type PublicationTestClock,
} from "./publication-contract.js";

const DIMENSIONS = 8;
const ACTOR = "t09-stage-fence-memory-owner";
const CONFIG_REVISION = "extractor-v1";
const AUTHORIZATION_REVISION = "auth-r1";
const SCOPE_BINDING = "scope-t09-stage-fence-memory";
const DRAIN_LIMIT = 64;

let backend: MemoryBackend;
let publication: StructuredPublicationStorage;
let work: MaintenanceWorkStore;
let clock: PublicationTestClock;
let serial = 0;

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function dependencyOf(
  sourceRef: string,
  generation: number,
  extractionRevision: number | null = null
): MaintenanceDependency {
  return { sourceRef, generation, extractionRevision, relationBuckets: [] };
}

function publishRequest(
  sourceRef: string,
  sourceVersion: string,
  generation: number,
  dependencies: readonly MaintenanceDependency[]
): MaintenanceWorkRequest {
  return {
    workKind: "extract_publish",
    sourceRef,
    sourceVersion,
    sourceGeneration: generation,
    configRevision: CONFIG_REVISION,
    dependencies,
  };
}

async function seedGraphEntities(entityIds: readonly string[]): Promise<void> {
  const chunks: ChunkRecord[] = entityIds.map((id) => ({
    id,
    content: `t09 memory stage fence entity ${id}`,
    embedding: new Array<number>(DIMENSIONS).fill(0),
    source_ref: "t09-stage-fence-memory-fixture",
    metadata: {},
    valid_from: clock().toISOString(),
    valid_until: null,
    created_at: clock().toISOString(),
  }));
  if (chunks.length > 0) await backend.upsert(chunks);
}

interface Seeded {
  readonly record: { source_ref: string; source_version: string; created_at: string };
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
  sourceRef: string,
  sourceVersion: string,
  authorizedSourceRefs: readonly string[] = [sourceRef]
): Promise<Seeded> {
  const { record } = await backend.registerSourceVersion({
    source_ref: sourceRef,
    source_version: sourceVersion,
    content_digest: digest(`${sourceRef}:${sourceVersion}`),
    origin_object_ref: `objects/${sourceRef}/${sourceVersion}.html`,
    parser_revision: "frozen-html-units-v1",
    unit_manifest: { units: 3, parser_revision: "frozen-html-units-v1" },
    created_at: clock().toISOString(),
    retired_at: null,
    payload_collected_at: null,
    obligations_stopped_at: null,
  });
  const locator = {
    document_id: `${sourceRef}-document`,
    version: `frozen-${sourceVersion}`,
    unit: 1,
  };
  const locatorBindings = [1, 2, 3].map((unit) => ({
    source_version_id: record.source_version_id,
    ...locator,
    unit,
  }));
  for (const binding of locatorBindings) await backend.bindSourceLocator(binding);
  const declared = await publication.declareDesired({
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

// EXIT: claiming through a back-dated clock writes the real lease and absolute
// deadline stamps the store later compares, so a lease or deadline case ages
// committed state instead of sleeping.
async function claimOwnJobAt(
  sourceRef: string,
  sourceVersion: string,
  generation: number,
  dependencies: readonly MaintenanceDependency[],
  claimedAt: Date
): Promise<MaintenanceAttemptGuard> {
  clock.set(claimedAt);
  const deps = { store: work, clock: () => clock() };
  const scheduled = await scheduleWork(
    deps,
    { actorId: ACTOR },
    publishRequest(sourceRef, sourceVersion, generation, dependencies)
  );
  if ("refused" in scheduled) {
    throw new Error(`scheduleWork refused: ${scheduled.refused}`);
  }
  for (let attempt = 0; attempt < DRAIN_LIMIT; attempt += 1) {
    const claimed = await claimNextWork(deps);
    const guard = claimed.guard;
    if (guard === null) break;
    if (guard.jobKey === scheduled.record.jobKey) return guard;
    await work.settleWork(
      guard,
      { status: "failed", failureCode: "input_stale" },
      { configRevision: CONFIG_REVISION, dependencies },
      clock()
    );
  }
  throw new Error(`could not claim job ${scheduled.record.jobKey} for this case`);
}

async function claimOwnJob(
  sourceRef: string,
  sourceVersion: string,
  generation: number,
  dependencies: readonly MaintenanceDependency[]
): Promise<MaintenanceAttemptGuard> {
  return claimOwnJobAt(
    sourceRef,
    sourceVersion,
    generation,
    dependencies,
    new Date()
  );
}

let entitySerial = 0;

function nextEntityId(): string {
  entitySerial += 1;
  return `00000000-0000-4000-8000-${entitySerial.toString().padStart(12, "0")}`;
}

function entityFact(
  seeded: Seeded,
  entityId: string,
  extractionRef: string
): PublicationFact {
  const identityInput: EntityIdentityInput = { entityId, type: "organization" };
  return {
    identity: { kind: "entity", input: identityInput },
    occurrence: {
      subject: "entity",
      result_id: entityId,
      source_ref: seeded.record.source_ref,
      source_version: seeded.record.source_version,
      location: { ...seeded.locator, unit: 1 },
      extraction_ref: extractionRef,
      extractedAt: seeded.record.created_at,
    },
    display: { canonicalName: `Served ${entityId.slice(-4)}`, type: "organization" },
  };
}

interface StageOutcome {
  readonly staged: boolean;
  readonly code?: string;
}

// EXIT: the real production entry point. Every case below drives
// `publication.stageAttempt` itself, so a refusal here is the store's own fence
// and not a test-only helper.
async function stageReal(
  sourceRef: string,
  seeded: Seeded,
  guard: MaintenanceAttemptGuard,
  entityId = nextEntityId()
): Promise<StageOutcome> {
  const extractionRef = `extract-${entityId.slice(-4)}`;
  await seedGraphEntities([entityId]);
  try {
    await publication.stageAttempt({
      scopeBinding: SCOPE_BINDING,
      sourceRef,
      guard,
      extractionRef,
      accepted: [entityFact(seeded, entityId, extractionRef)],
    });
    return { staged: true };
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    return { staged: false, code: typeof code === "string" ? code : undefined };
  }
}

// EXIT: the memory snapshot exposes no staged payload, so a staged row is proven
// through the public terminal mutation instead: publishing consumes exactly the
// payload the attempt staged.
async function publishReal(
  sourceRef: string,
  guard: MaintenanceAttemptGuard
): Promise<{ readonly published: boolean; readonly code?: string }> {
  try {
    await publication.publish({
      scopeBinding: SCOPE_BINDING,
      sourceRef,
      guard,
      at: new Date().toISOString(),
    });
    return { published: true };
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    return { published: false, code: typeof code === "string" ? code : undefined };
  }
}

async function servingMembership(): Promise<
  readonly { subject: string; resultId: string }[]
> {
  const snapshot = await publication.readSnapshot({ scopeBinding: SCOPE_BINDING });
  return snapshot.subjects.map((row) => ({
    subject: row.subject,
    resultId: row.resultId,
  }));
}

async function publishedPair(
  sourceRef: string
): Promise<{ sourceVersion: string | null; extractionRevision: number | null }> {
  const snapshot = await publication.readSnapshot({ scopeBinding: SCOPE_BINDING });
  const row = snapshot.sources.find((entry) => entry.sourceRef === sourceRef);
  return {
    sourceVersion: row?.published?.sourceVersion ?? null,
    extractionRevision: row?.published?.extractionRevision ?? null,
  };
}

describe("T09 stage fences on the real production path (memory)", () => {
  afterEach(async () => {
    await backend?.close();
  });

  async function openBackend(): Promise<void> {
    const composed = new MemoryBackend(DIMENSIONS) as MemoryBackend & {
      structuredPublication?: StructuredPublicationStorage;
      maintenanceWorkStore?: MaintenanceWorkStore;
    };
    const publicationStore = composed.structuredPublication;
    const workStore = composed.maintenanceWorkStore;
    if (!publicationStore || !workStore) {
      throw new Error(
        "MemoryBackend composition must supply the publication and work stores"
      );
    }
    backend = composed;
    publication = publicationStore;
    work = workStore;
    clock = createPublicationTestClock(new Date());
    await backend.setScopeRevisions(SCOPE_BINDING, {
      authorizationRevision: AUTHORIZATION_REVISION,
      purgeRevision: `purge-${AUTHORIZATION_REVISION}`,
    });
  }

  it("a live attempt stages its payload and can publish it", async () => {
    await openBackend();
    const sourceRef = unique("memory-live");
    const seeded = await seedSource(sourceRef, "v1");
    const guard = await claimOwnJob(sourceRef, "v1", seeded.generation, [
      dependencyOf(sourceRef, seeded.generation),
    ]);
    const entityId = nextEntityId();

    expect(await stageReal(sourceRef, seeded, guard, entityId)).toEqual({
      staged: true,
    });
    expect(await servingMembership()).toEqual([]);
    expect(await publishedPair(sourceRef)).toEqual({
      sourceVersion: null,
      extractionRevision: null,
    });

    const published = await publishReal(sourceRef, guard);
    expect(published).toEqual({ published: true });
    expect(await servingMembership()).toEqual([
      { subject: "entity", resultId: entityId },
    ]);
    expect(await publishedPair(sourceRef)).toEqual({
      sourceVersion: "v1",
      extractionRevision: 1,
    });
  });

  it("a reclaimed attempt's stale token cannot stage", async () => {
    await openBackend();
    const sourceRef = unique("memory-stale-token");
    const seeded = await seedSource(sourceRef, "v1");
    const dependencies = [dependencyOf(sourceRef, seeded.generation)];
    const stale = await claimOwnJobAt(
      sourceRef,
      "v1",
      seeded.generation,
      dependencies,
      new Date(Date.now() - WORK_LEASE_MS - 1_000)
    );

    clock.set(new Date());
    const reclaimed = await claimNextWork({ store: work, clock: () => clock() });
    if (reclaimed.guard === null) throw new Error("reclaim produced no guard");
    expect(reclaimed.guard.fencingToken).not.toBe(stale.fencingToken);

    const outcome = await stageReal(sourceRef, seeded, stale);
    expect(outcome.staged).toBe(false);
    expect(outcome.code).toBe("lease_lost");
    expect((await publishReal(sourceRef, stale)).published).toBe(false);
  });

  it("an expired lease cannot stage", async () => {
    await openBackend();
    const sourceRef = unique("memory-lease-expiry");
    const seeded = await seedSource(sourceRef, "v1");
    const guard = await claimOwnJobAt(
      sourceRef,
      "v1",
      seeded.generation,
      [dependencyOf(sourceRef, seeded.generation)],
      new Date(Date.now() - WORK_LEASE_MS - 1_000)
    );

    const outcome = await stageReal(sourceRef, seeded, guard);
    expect(outcome.staged).toBe(false);
    expect(outcome.code).toBe("lease_lost");
    expect((await publishReal(sourceRef, guard)).published).toBe(false);
    expect(await servingMembership()).toEqual([]);
    expect(await publishedPair(sourceRef)).toEqual({
      sourceVersion: null,
      extractionRevision: null,
    });
  });

  it("an absolute-deadline breach cannot stage", async () => {
    await openBackend();
    const sourceRef = unique("memory-deadline");
    const seeded = await seedSource(sourceRef, "v1");
    const guard = await claimOwnJobAt(
      sourceRef,
      "v1",
      seeded.generation,
      [dependencyOf(sourceRef, seeded.generation)],
      new Date(Date.now() - WORK_ABSOLUTE_LIMIT_MS - 1_000)
    );

    const outcome = await stageReal(sourceRef, seeded, guard);
    expect(outcome.staged).toBe(false);
    expect(outcome.code).toBe("execution_timeout");
    expect((await publishReal(sourceRef, guard)).published).toBe(false);
  });

  it("a moved dependency generation cannot stage", async () => {
    await openBackend();
    const sourceRef = unique("memory-dep-move");
    const dependencyRef = unique("memory-dep-source");
    const dependency = await seedSource(dependencyRef, "v1");
    const seeded = await seedSource(sourceRef, "v1", [dependencyRef, sourceRef]);
    const guard = await claimOwnJob(sourceRef, "v1", seeded.generation, [
      dependencyOf(dependencyRef, dependency.generation),
      dependencyOf(sourceRef, seeded.generation),
    ]);

    const moved = await seedSource(dependencyRef, "v2", [dependencyRef, sourceRef]);
    expect(moved.generation).toBeGreaterThan(dependency.generation);

    const outcome = await stageReal(sourceRef, seeded, guard);
    expect(outcome.staged).toBe(false);
    expect(outcome.code).toBe("input_stale");
    expect((await publishReal(sourceRef, guard)).published).toBe(false);
  });

  it("a generation that moved cannot stage or revert the source", async () => {
    await openBackend();
    const sourceRef = unique("memory-aba");
    const first = await seedSource(sourceRef, "vA");
    const guardA = await claimOwnJob(sourceRef, "vA", first.generation, [
      dependencyOf(sourceRef, first.generation),
    ]);

    const b = await seedSource(sourceRef, "vB");
    const a = await seedSource(sourceRef, "vA");
    expect(a.generation).toBeGreaterThan(b.generation);

    const outcome = await stageReal(sourceRef, a, guardA);
    expect(outcome.staged).toBe(false);
    expect(outcome.code).toBe("input_stale");
    expect((await publishReal(sourceRef, guardA)).published).toBe(false);
    const snapshot = await publication.readSnapshot({ scopeBinding: SCOPE_BINDING });
    const row = snapshot.sources.find((entry) => entry.sourceRef === sourceRef);
    expect(row?.generation).toBe(a.generation);
    expect(await publishedPair(sourceRef)).toEqual({
      sourceVersion: null,
      extractionRevision: null,
    });
  });

  it("a settled attempt cannot stage", async () => {
    await openBackend();
    const sourceRef = unique("memory-settled");
    const seeded = await seedSource(sourceRef, "v1");
    const dependencies = [dependencyOf(sourceRef, seeded.generation)];
    const guard = await claimOwnJob(sourceRef, "v1", seeded.generation, dependencies);

    clock.set(new Date());
    await work.settleWork(
      guard,
      { status: "failed", failureCode: "backend_unavailable" },
      { configRevision: CONFIG_REVISION, dependencies },
      clock()
    );

    const outcome = await stageReal(sourceRef, seeded, guard);
    expect(outcome.staged).toBe(false);
    expect(outcome.code).toBe("lease_lost");
    expect(await servingMembership()).toEqual([]);
  });

  it("a withdrawn source cannot stage", async () => {
    await openBackend();
    const sourceRef = unique("memory-withdrawn");
    const seeded = await seedSource(sourceRef, "v1");
    const guard = await claimOwnJob(sourceRef, "v1", seeded.generation, [
      dependencyOf(sourceRef, seeded.generation),
    ]);

    await publication.withdraw({
      scopeBinding: SCOPE_BINDING,
      sourceRef,
      expectedGeneration: seeded.generation,
      at: clock().toISOString(),
    });

    const outcome = await stageReal(sourceRef, seeded, guard);
    expect(outcome.staged).toBe(false);
    expect(outcome.code).toBe("input_stale");
    expect((await publishReal(sourceRef, guard)).published).toBe(false);
  });

  it("the last permitted automatic attempt may still stage", async () => {
    await openBackend();
    const sourceRef = unique("memory-last-attempt");
    const seeded = await seedSource(sourceRef, "v1");
    const dependencies = [dependencyOf(sourceRef, seeded.generation)];
    const deps = { store: work, clock: () => clock() };
    const scheduled = await scheduleWork(
      deps,
      { actorId: ACTOR },
      publishRequest(sourceRef, "v1", seeded.generation, dependencies)
    );
    if ("refused" in scheduled) {
      throw new Error(`scheduleWork refused: ${scheduled.refused}`);
    }

    let finalGuard: MaintenanceAttemptGuard | null = null;
    for (let round = 0; round < MAX_AUTO_ATTEMPTS; round += 1) {
      clock.set(new Date(Date.now() + round * 60_000));
      let mine: MaintenanceAttemptGuard | null = null;
      for (let attempt = 0; attempt < DRAIN_LIMIT; attempt += 1) {
        const candidate = (await claimNextWork(deps)).guard;
        if (candidate === null) break;
        if (candidate.jobKey === scheduled.record.jobKey) {
          mine = candidate;
          break;
        }
        await work.settleWork(
          candidate,
          { status: "failed", failureCode: "input_stale" },
          { configRevision: CONFIG_REVISION, dependencies },
          clock()
        );
      }
      if (mine === null) throw new Error(`round ${round} could not claim the job`);
      finalGuard = mine;
      const record = await work.getJob(mine.jobKey);
      expect(record?.autoAttemptCount).toBe(round + 1);
      if (round + 1 < MAX_AUTO_ATTEMPTS) {
        await work.settleWork(
          mine,
          { status: "failed", failureCode: "backend_unavailable" },
          { configRevision: CONFIG_REVISION, dependencies },
          clock()
        );
      }
    }
    if (finalGuard === null) throw new Error("no attempt was ever claimed");
    const live = await work.getJob(finalGuard.jobKey);
    expect(live?.autoAttemptCount).toBe(MAX_AUTO_ATTEMPTS);
    expect(live?.status).toBe("running");

    // EXIT: the automatic budget is spent exactly on the final permitted
    // attempt, which is still `running` and must still be able to stage. A
    // fence reading `auto_attempt_count >= max_attempts` would refuse this
    // legitimate write.
    expect(await stageReal(sourceRef, seeded, finalGuard)).toEqual({ staged: true });
    expect(await publishReal(sourceRef, finalGuard)).toEqual({ published: true });
  });

  it("a refused replacement leaves the prior publication intact", async () => {
    await openBackend();
    const sourceRef = unique("memory-failed-replacement");
    const seeded = await seedSource(sourceRef, "v1");
    const firstAttempt = await claimOwnJob(sourceRef, "v1", seeded.generation, [
      dependencyOf(sourceRef, seeded.generation),
    ]);
    const entityId = nextEntityId();
    expect(await stageReal(sourceRef, seeded, firstAttempt, entityId)).toEqual({
      staged: true,
    });
    clock.set(new Date());
    expect(await publishReal(sourceRef, firstAttempt)).toEqual({ published: true });
    const servingBefore = await servingMembership();
    const pairBefore = await publishedPair(sourceRef);
    expect(servingBefore).toEqual([{ subject: "entity", resultId: entityId }]);
    expect(pairBefore).toEqual({ sourceVersion: "v1", extractionRevision: 1 });

    const replacement = await seedSource(sourceRef, "v2");
    const secondAttempt = await claimOwnJobAt(
      sourceRef,
      "v2",
      replacement.generation,
      [dependencyOf(sourceRef, replacement.generation, 1)],
      new Date(Date.now() - WORK_LEASE_MS - 1_000)
    );
    const refused = await stageReal(sourceRef, replacement, secondAttempt);
    expect(refused.staged).toBe(false);
    expect(refused.code).toBe("lease_lost");

    expect(await servingMembership()).toEqual(servingBefore);
    expect(await publishedPair(sourceRef)).toEqual(pairBefore);
    expect((await publishReal(sourceRef, secondAttempt)).published).toBe(false);
  });
});