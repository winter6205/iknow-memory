/**
 * The memory lane of the MP15 collection-delete contract.
 *
 * It drives the real `MemoryBackend`: the one serialization tail every accepted
 * memory write queues on, the same revision counters MP14's marks bump, and the
 * same evidence maps a grant read walks. That is the whole reason this lane
 * exists — the pure plan decides, but only a real tail can prove that a delete
 * commits its phases, its mark withdrawal and its revision advance as one
 * visible step, and that a retry rejoining committed phases cannot resurrect a
 * row.
 *
 * The PG lane shares every verdict with this one, so a disagreement between the
 * lanes can only be about persistence and ordering, never about what the answer
 * should have been.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  COLLECTION_DAY_MS,
  decideCollectionEligibility,
} from "../../src/core/maintenance/collector-eligibility.js";
import type {
  CollectionCandidate,
  CollectionEligibility,
  CollectionPayloadClass,
  CollectionReadFacts,
} from "../../src/core/maintenance/collector-types.js";
import {
  remainingDeletePhases,
} from "../../src/core/maintenance/collection-delete.js";
import {
  InMemoryCollectionDeleteStore,
  type InMemoryCollectionDeleteSeed,
} from "../../src/core/storage/collection-delete-memory.js";
import { InMemoryCollectionMarkStorage } from "../../src/core/storage/collection-mark-memory.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import type {
  AuthorizedScopeContext,
  AuthorizedScopeUnitOfWork,
} from "../../src/core/storage/structured-scope-types.js";
import {
  EVIDENCE_GRANT_KIND,
  EVIDENCE_SUBJECT_KIND,
  EVIDENCE_SUPPORT_ROLE,
} from "../../src/core/types.js";
import { createPublicationTestClock } from "./publication-contract.js";

const DIMENSIONS = 8;
const ACTOR = "collection-delete-trusted-owner";
const AUTHORIZATION_REVISION = "auth-collection-delete-1";
const CONFIG_REVISION = "extractor-v1";
const PAYLOAD_REF = "s1";
const SOURCE_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_VERSION_2_ID = "44444444-4444-4444-8444-444444444444";
const PURGE_REVISION = "purge-1";

/** Seven days, the grace between a candidate and the earliest deletion instant. */
const GRACE_MS = 7 * COLLECTION_DAY_MS;
/** A deadline far beyond any instant these cases reach. */
const SCOPE_DEADLINE_MS = 3650 * COLLECTION_DAY_MS;

const DAY0 = new Date("2026-01-01T00:00:00.000Z");
const atDay = (count: number): Date =>
  new Date(DAY0.getTime() + count * COLLECTION_DAY_MS);

const cleanFacts: CollectionReadFacts = {
  bindingResolved: true,
  payloadCollected: false,
  targetRetired: true,
  currentDependencies: [],
  validLeases: [],
  rowReferences: [],
  countOnlyGrants: [],
};

const candidate = (
  payloadClass: CollectionPayloadClass
): CollectionCandidate => ({
  payloadClass,
  payloadRef: PAYLOAD_REF,
  source:
    payloadClass === "expired_snapshot"
      ? null
      : { sourceRef: PAYLOAD_REF, sourceVersion: "v1", sourceGeneration: 1 },
  anchorAt: DAY0.toISOString(),
});

/** Eligibility as MP13 decided it. MP14 takes it as given and never recomputes. */
function eligibilityFor(
  payloadClass: CollectionPayloadClass
): CollectionEligibility {
  const outcome = decideCollectionEligibility(
    candidate(payloadClass),
    cleanFacts,
    atDay(90)
  );
  if (outcome.refused) throw new Error(`${outcome.code}: ${outcome.detail}`);
  return outcome.eligibility;
}

function opaqueDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface Lane {
  readonly authority: AuthorizedScopeUnitOfWork;
  readonly context: AuthorizedScopeContext;
  readonly backend: MemoryBackend;
  readonly marks: InMemoryCollectionMarkStorage;
  readonly deletes: InMemoryCollectionDeleteStore;
  readonly clock: ReturnType<typeof createPublicationTestClock>;
  readonly identity: { readonly payloadClass: CollectionPayloadClass; readonly payloadRef: string };
  readonly maintenanceRevision: () => Promise<number>;
}

/**
 * One isolated lane per case: its own backend, scope and clock, seeded with the
 * full payload shape MP15 removes — one marked source version, two frozen
 * units, two supports with one extraction each, one grant pinning both — so the
 * counts a case asserts are the phases' own work and not a fixture accident.
 */
async function lane(
  label: string,
  options: {
    readonly payloadCollectedAt?: string | null;
    readonly seedSecondVersion?: boolean;
  } = {}
): Promise<Lane> {
  const backend = new MemoryBackend(DIMENSIONS) as MemoryBackend & {
    readonly structuredScopeUnitOfWork?: AuthorizedScopeUnitOfWork;
  };
  const authority = backend.structuredScopeUnitOfWork;
  if (authority === undefined) {
    // EXIT: the composition supplied no shared scope authority. The setup throws
    // before any assertion runs, so no case can pass without the real tail.
    throw new Error(
      "MemoryBackend composition must supply the shared scope authority the collection-delete memory lane drives"
    );
  }
  const clock = createPublicationTestClock(DAY0);
  const scopeBinding = `collection-delete-scope-${label}`;
  const sourceRef = `${label}-source`;

  const { record } = await backend.registerSourceVersion({
    source_version_id: SOURCE_VERSION_ID,
    source_ref: sourceRef,
    source_version: "v1",
    content_digest: opaqueDigest(`${sourceRef}:v1`),
    origin_object_ref: `objects/${sourceRef}/v1.html`,
    parser_revision: "frozen-html-units-v1",
    unit_manifest: { units: 2, parser_revision: "frozen-html-units-v1" },
    created_at: DAY0.toISOString(),
    retired_at: null,
    payload_collected_at: null,
    obligations_stopped_at: null,
  });
  if (record.source_version_id !== SOURCE_VERSION_ID) {
    throw new Error(
      `fixture expected deterministic source version id ${SOURCE_VERSION_ID}, got ${record.source_version_id}`
    );
  }
  await backend.markSourceVersionRetired(
    SOURCE_VERSION_ID,
    atDay(80).toISOString()
  );
  // The shared-object fixture: a second logical source whose version names the
  // SAME digest and object ref, so the store's exact live-reference counts have
  // something real to count (plan §Shared-object key — reported, never gating).
  if (options.seedSecondVersion) {
    await backend.registerSourceVersion({
      source_ref: `${sourceRef}-other`,
      source_version: "v1",
      content_digest: opaqueDigest(`${sourceRef}:v1`),
      origin_object_ref: `objects/${sourceRef}/v1.html`,
      parser_revision: "frozen-html-units-v1",
      unit_manifest: { units: 1, parser_revision: "frozen-html-units-v1" },
      created_at: DAY0.toISOString(),
      retired_at: null,
      payload_collected_at: null,
      obligations_stopped_at: null,
    });
  }
  const locatorBindings = [1, 2].map((unit) => ({
    source_version_id: SOURCE_VERSION_ID,
    document_id: `${sourceRef}-document`,
    version: "frozen-v1",
    unit,
  }));
  for (const binding of locatorBindings) await backend.bindSourceLocator(binding);
  await backend.setScopeRevisions(scopeBinding, {
    authorizationRevision: AUTHORIZATION_REVISION,
    purgeRevision: PURGE_REVISION,
  });
  await backend.structuredPublication.declareDesired({
    scopeBinding,
    authorizedSourceRefs: [sourceRef],
    sourceRef,
    sourceVersion: record,
    locatorBindings,
    desiredExtractionRevision: 1,
    configRevision: CONFIG_REVISION,
  });

  const context = authority.createAuthorizedContext({
    actorId: ACTOR,
    ownerScopeBinding: scopeBinding,
    readerBinding: `${scopeBinding}-reader`,
    authorizedSourceRefs: [sourceRef],
    authorizationRevision: AUTHORIZATION_REVISION,
    deadlineAt: new Date(DAY0.getTime() + SCOPE_DEADLINE_MS).toISOString(),
  });

  // The payload shape MP15 removes: two supports with one extraction link each,
  // recorded through the backend so the phase counts are its own work.
  const supportRefs = [];
  for (const unit of [1, 2]) {
    const { support } = await backend.recordSupport({
      subject: EVIDENCE_SUBJECT_KIND.ENTITY,
      result_id: `${sourceRef}-result`,
      source_ref: sourceRef,
      source_version: "v1",
      location: {
        document_id: `${sourceRef}-document`,
        version: "frozen-v1",
        unit,
      },
      span: null,
      extraction_ref: `${sourceRef}-extraction-${unit}`,
      extractedAt: atDay(10).toISOString(),
    });
    supportRefs.push({
      support_id: support.support_id,
      role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE,
    });
  }
  // One row grant holding both supports. Its queriedAt is far in the past, so
  // the grant is EXPIRED long before the deletion day — the phase-1 counts come
  // from its pins without the grant refusing the delete as a live reference.
  await backend.issueGrant({
    kind: EVIDENCE_GRANT_KIND.ROW,
    subject: EVIDENCE_SUBJECT_KIND.ENTITY,
    operation: "list",
    queryDigest: `${sourceRef}-query`,
    scopeBinding,
    readRevision: "read-1",
    queriedAt: atDay(-300).toISOString(),
    context: { coverage: "stored_structured_subjects" },
    value: { entity_id: `${sourceRef}-entity`, name: "某公司" },
    supports: supportRefs,
    consumerId: `${sourceRef}-consumer`,
  });

  if (options.payloadCollectedAt != null) {
    await backend.collectSourceVersionPayload(
      SOURCE_VERSION_ID,
      options.payloadCollectedAt
    );
  }

  // Both stores share the backend's stores: the marks storage must hold the
  // version row the mark's obligations stamp lands on, and the delete store's
  // deps are the same objects a resumed instance would receive — which is what
  // makes the resume case below a property of the composition, not a seed.
  const marks = new InMemoryCollectionMarkStorage(
    authority,
    {
      sourceVersions: [
        {
          sourceVersionId: SOURCE_VERSION_ID,
          obligationsStoppedAt: null,
          payloadCollectedAt: null,
        },
      ],
    },
    () => clock()
  );
  const deletes = new InMemoryCollectionDeleteStore(
    {
      serialization: backend.structuredScopeUnitOfWork,
      marks,
      evidence: backend,
      publication: backend.structuredPublicationScopeAuthority,
    },
    () => clock()
  );

  return {
    authority,
    context,
    backend,
    marks,
    deletes,
    clock,
    identity: { payloadClass: "retired_unreferenced", payloadRef: PAYLOAD_REF },
    maintenanceRevision: async () =>
      authority.withAuthorizedScope(context, async (work) =>
        (await work.readMaintenanceInputs([])).maintenanceRevision
      ),
  };
}

/** A source-bound mark, with the lane's clock parked on the candidate day. */
async function marked(target: Lane) {
  target.clock.set(atDay(90));
  const outcome = await target.marks.markCollectionCandidate({
    context: target.context,
    scopeBinding: target.context.ownerScopeBinding,
    payloadClass: "retired_unreferenced",
    payloadRef: PAYLOAD_REF,
    sourceVersionId: SOURCE_VERSION_ID,
    eligibility: eligibilityFor("retired_unreferenced"),
  });
  if (outcome.refused) throw new Error(`${outcome.code}: ${outcome.detail}`);
  return outcome.plan;
}

/** The delete request one lane's payload produces. */
function deleteRequest(target: Lane) {
  return {
    context: target.context,
    scopeBinding: target.context.ownerScopeBinding,
    identity: target.identity,
    purgeRevision: PURGE_REVISION,
  };
}

describe("collection deletion in memory", () => {
  it("runs every phase, withdraws the mark, stamps collection and advances the scope once", async () => {
    const target = await lane("full-run");
    const plan = await marked(target);
    const revisionAfterMark = await target.maintenanceRevision();
    target.clock.set(atDay(98));

    const outcome = await target.deletes.deleteCollectionPayload(
      deleteRequest(target)
    );

    expect(outcome.refused).toBe(false);
    if (outcome.refused) return;
    expect(outcome.outcome.deleted).toBe(true);
    expect(outcome.outcome.purgeRevision).toBe(PURGE_REVISION);
    expect(outcome.outcome.phasesRun).toEqual([...remainingDeletePhases([])]);
    expect(outcome.outcome.collectedAt).toBe(atDay(98).toISOString());
    // The mark row is gone with the payload: the identity record that survives is
    // `payload_collected_at` on the version, not the mark (plan's terminal row).
    expect(await target.marks.readCollectionMark(target.identity)).toBeNull();
    expect(await target.deletes.readPayloadCollectedAt(SOURCE_VERSION_ID)).toBe(
      atDay(98).toISOString()
    );
    // The mark stops obligations; the scope moved for the mark and once more for
    // the deletion.
    expect(await target.maintenanceRevision()).toBe(revisionAfterMark + 1);

    // The plan carried the deadline the mark recorded, not a recomputed one.
    expect(outcome.outcome.deadlineAt).toBe(plan.mark.deadlineAt);
  });

  it("reports the exact live-reference counts and never gates on them", async () => {
    const target = await lane("shared-counts", { seedSecondVersion: true });
    await marked(target);
    target.clock.set(atDay(98));

    const outcome = await target.deletes.deleteCollectionPayload(
      deleteRequest(target)
    );
    expect(outcome.refused).toBe(false);
    if (outcome.refused) return;
    // The second seeded version names the SAME digest and object ref, so both
    // counts are 1 other row, and the deletion proceeded anyway — reported, not
    // gating (plan §Shared-object key).
    expect(outcome.outcome.sharedReferences).toEqual({
      contentDigestReferences: 1,
      originObjectReferences: 1,
    });
    expect(await target.deletes.readPayloadCollectedAt(SOURCE_VERSION_ID)).toBe(
      atDay(98).toISOString()
    );
  });

  it("refuses a retired payload whose deadline has not passed, before any write", async () => {
    const target = await lane("before-deadline");
    await marked(target);
    const revision = await target.maintenanceRevision();
    target.clock.set(atDay(96));

    const outcome = await target.deletes.deleteCollectionPayload(
      deleteRequest(target)
    );

    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("input_stale");
    // The refusal is a value and changes nothing: the mark stands, the payload
    // rows stand, the revision did not move.
    expect(
      (await target.marks.readCollectionMark(target.identity))?.state
    ).toBe("marked");
    expect(await target.deletes.readPayloadCollectedAt(SOURCE_VERSION_ID)).toBeNull();
    expect(await target.maintenanceRevision()).toBe(revision);
  });

  it("refuses a scope the context does not own", async () => {
    const target = await lane("foreign-scope");
    await marked(target);
    target.clock.set(atDay(98));

    const outcome = await target.deletes.deleteCollectionPayload({
      context: target.context,
      scopeBinding: "a-different-scope",
      identity: target.identity,
      purgeRevision: PURGE_REVISION,
    });

    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("access_denied");
    expect(await target.marks.readCollectionMark(target.identity)).not.toBeNull();
  });

  it("refuses an already-collected payload", async () => {
    const target = await lane("already-collected", {
      payloadCollectedAt: atDay(80).toISOString(),
    });
    await marked(target);
    target.clock.set(atDay(98));

    const outcome = await target.deletes.deleteCollectionPayload(
      deleteRequest(target)
    );

    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("input_stale");
    expect(await target.marks.readCollectionMark(target.identity)).not.toBeNull();
  });

  it("refuses a payload that was never marked, and leaves no phantom progress row", async () => {
    const target = await lane("never-marked");
    const revision = await target.maintenanceRevision();
    target.clock.set(atDay(98));

    const outcome = await target.deletes.deleteCollectionPayload(
      deleteRequest(target)
    );

    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("input_stale");
    expect(
      await target.deletes.readCommittedPhases(SOURCE_VERSION_ID, PURGE_REVISION)
    ).toEqual([]);
    expect(await target.maintenanceRevision()).toBe(revision);
  });

  it("refuses a non-retired payload class before any mark is consulted", async () => {
    const target = await lane("wrong-class");
    const revision = await target.maintenanceRevision();
    target.clock.set(atDay(98));

    const outcome = await target.deletes.deleteCollectionPayload({
      ...deleteRequest(target),
      identity: {
        payloadClass: "expired_snapshot",
        payloadRef: PAYLOAD_REF,
      },
    });

    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("invalid_input");
    expect(await target.maintenanceRevision()).toBe(revision);
  });
});

describe("MP15 memory lane — the resumable retry", () => {
  it("completes a payload whose phases partially committed, deleting each row set once", async () => {
    const target = await lane("resume");
    await marked(target);
    target.clock.set(atDay(98));

    // Simulate the M16 crash: the first two phases recorded, nothing else. The
    // seed is the progress row a crashed attempt left behind.
    const crashSeed: InMemoryCollectionDeleteSeed = {
      progress: [
        {
          sourceVersionId: SOURCE_VERSION_ID,
          purgeRevision: PURGE_REVISION,
          committedPhases: ["dependent_supports", "extraction_payloads"],
          collected: false,
        },
      ],
    };
    const resumed = new InMemoryCollectionDeleteStore(
      {
        serialization: target.backend.structuredScopeUnitOfWork,
        marks: target.marks,
        evidence: target.backend,
        publication: target.backend.structuredPublicationScopeAuthority,
      },
      () => target.clock(),
      crashSeed
    );

    const outcome = await resumed.deleteCollectionPayload(deleteRequest(target));

    expect(outcome.refused).toBe(false);
    if (outcome.refused) return;
    // Exactly the tail ran.
    expect(outcome.outcome.phasesRun).toEqual(
      remainingDeletePhases(["dependent_supports", "extraction_payloads"])
    );
    expect(outcome.outcome.deleted).toBe(true);
    // Each surviving row set is deleted exactly once — the counts a fresh run
    // would report for these sets, not doubled.
    expect(outcome.outcome.phaseCounts).toEqual({
      dependent_supports: 0,
      extraction_payloads: 0,
      assertion_supports: 2,
      frozen_units: 2,
      superseded_caches: 0,
    });
    expect(await target.deletes.readPayloadCollectedAt(SOURCE_VERSION_ID)).toBe(
      atDay(98).toISOString()
    );
    expect(await target.marks.readCollectionMark(target.identity)).toBeNull();
  });

  it("reports a retry after full completion without re-running a phase", async () => {
    const target = await lane("retry-after-done");
    await marked(target);
    target.clock.set(atDay(98));
    const first = await target.deletes.deleteCollectionPayload(
      deleteRequest(target)
    );
    expect(first.refused).toBe(false);

    // The retry arrives after the payload was collected: refused as stale, which
    // is the ADR 0099 §2.1 monotonic answer — not a second deletion.
    const second = await target.deletes.deleteCollectionPayload(
      deleteRequest(target)
    );
    expect(second.refused).toBe(true);
    if (!second.refused) return;
    expect(second.code).toBe("input_stale");
    expect(await target.deletes.readPayloadCollectedAt(SOURCE_VERSION_ID)).toBe(
      atDay(98).toISOString()
    );
  });
});
