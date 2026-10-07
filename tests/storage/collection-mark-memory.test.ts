/**
 * The memory lane of the MP14 collection-mark contract.
 *
 * It drives the real `MemoryBackend`: the real shared scope authority and the one
 * serialization tail every accepted memory write queues on. That is the whole
 * reason this lane exists. PostgreSQL can prove a mark and its obligations stamp
 * commit together; only a real tail can prove that a mark racing a reactivation
 * ends with exactly one authoritative outcome, because only here is the two
 * actions' read-to-commit window genuinely concurrent.
 *
 * Every verdict is reached by the same pure decisions the PG lane calls, so a
 * disagreement between the lanes can only ever be about persistence and ordering.
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
  InMemoryCollectionMarkStorage,
  type InMemoryCollectionMarkSeed,
} from "../../src/core/storage/collection-mark-memory.js";import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import type {
  AuthorizedScopeContext,
  AuthorizedScopeUnitOfWork,
} from "../../src/core/storage/structured-scope-types.js";
import { createPublicationTestClock } from "./publication-contract.js";

const DIMENSIONS = 8;
const ACTOR = "collection-mark-memory-trusted-owner";
const AUTHORIZATION_REVISION = "auth-collection-mark-1";
const CONFIG_REVISION = "extractor-v1";
const PAYLOAD_REF = "s1";
const SOURCE_VERSION_ID = "33333333-3333-4333-8333-333333333333";

/** Seven days, the grace between a candidate and the earliest deletion instant. */
const GRACE_MS = 7 * COLLECTION_DAY_MS;
/** A deadline far beyond any instant these cases reach, so no case fails a scope
 *  deadline instead of the rule it is asserting. */
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
  // A refusal here would be a fixture error rather than a rule under test, so it
  // is raised here instead of being asserted.
  if (outcome.refused) throw new Error(`${outcome.code}: ${outcome.detail}`);
  return outcome.eligibility;
}

function opaqueDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface Lane {
  readonly authority: AuthorizedScopeUnitOfWork;
  readonly context: AuthorizedScopeContext;
  readonly marks: InMemoryCollectionMarkStorage;
  /** The seed this lane's store was built from, so a case driving the same rows
   *  through a differently-wrapped authority reuses them rather than a copy. */
  readonly seed: InMemoryCollectionMarkSeed;
  readonly clock: ReturnType<typeof createPublicationTestClock>;
  readonly maintenanceRevision: () => Promise<number>;
  readonly identity: { readonly payloadClass: CollectionPayloadClass; readonly payloadRef: string };
}

/**
 * One isolated lane per case: its own backend, scope and clock.
 *
 * A fresh backend each time is not tidiness. The authority's routing loop retries
 * a discarded attempt against live scope state, so a case that inherited another
 * case's revision counter would be asserting against a revision it never read.
 */
async function lane(
  label: string,
  options: {
    readonly obligationsStoppedAt?: string | null;
    readonly payloadCollectedAt?: string | null;
    readonly seedSourceVersion?: boolean;
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
      "MemoryBackend composition must supply the shared scope authority the collection-mark memory lane drives"
    );
  }
  const clock = createPublicationTestClock(DAY0);
  const scopeBinding = `collection-mark-scope-${label}`;
  const sourceRef = `${label}-source`;

  const { record } = await backend.registerSourceVersion({
    source_ref: sourceRef,
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
  const locatorBindings = [
    {
      source_version_id: record.source_version_id,
      document_id: `${sourceRef}-document`,
      version: "frozen-v1",
      unit: 1,
    },
  ];
  for (const binding of locatorBindings) await backend.bindSourceLocator(binding);
  await backend.setScopeRevisions(scopeBinding, {
    authorizationRevision: AUTHORIZATION_REVISION,
    purgeRevision: "purge-1",
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

  const seed: InMemoryCollectionMarkSeed =
    options.seedSourceVersion === false
      ? {}
      : {
          sourceVersions: [
            {
              sourceVersionId: SOURCE_VERSION_ID,
              obligationsStoppedAt: options.obligationsStoppedAt ?? null,
              payloadCollectedAt: options.payloadCollectedAt ?? null,
            },
          ],
        };
  const marks = new InMemoryCollectionMarkStorage(authority, seed, () => clock());

  return {
    authority,
    context,
    marks,
    seed,
    clock,
    identity: { payloadClass: "retired_unreferenced", payloadRef: PAYLOAD_REF },
    maintenanceRevision: async () =>
      authority.withAuthorizedScope(context, async (work) =>
        (await work.readMaintenanceInputs([])).maintenanceRevision
      ),
  };
}

/** A source-bound mark, with the lane's clock parked on the candidate day. */
async function marked(
  target: Lane,
  payloadClass: CollectionPayloadClass = "retired_unreferenced"
) {
  target.clock.set(atDay(90));
  const outcome = await target.marks.markCollectionCandidate({
    context: target.context,
    scopeBinding: target.context.ownerScopeBinding,
    payloadClass,
    payloadRef: PAYLOAD_REF,
    sourceVersionId:
      payloadClass === "expired_snapshot" ? null : SOURCE_VERSION_ID,
    eligibility: eligibilityFor(payloadClass),
  });
  if (outcome.refused) throw new Error(`${outcome.code}: ${outcome.detail}`);
  return outcome.plan;
}

describe("collection marks in memory", () => {
  it("persists the mark at the revision it holds at its own commit, with the grace deadline", async () => {
    const target = await lane("commit-revision");
    const observedBefore = await target.maintenanceRevision();

    const plan = await marked(target);
    const persisted = await target.marks.readCollectionMark(target.identity);

    // The recorded revision is the post-bump value. A mark that recorded what it
    // observed would be stale against itself on its own first recheck.
    expect(plan.mark.expectedLifecycleRevision).toBe(String(observedBefore + 1));
    expect(persisted?.expectedLifecycleRevision).toBe(
      String(observedBefore + 1)
    );
    // The scope really did move to the revision the mark recorded.
    expect(await target.maintenanceRevision()).toBe(observedBefore + 1);

    expect(persisted?.state).toBe("marked");
    expect(persisted?.markedAt).toBe(atDay(90).toISOString());
    expect(persisted?.deadlineAt).toBe(atDay(97).toISOString());
    // The deadline is candidate time plus the seven-day grace, and it is MP13's
    // value carried through rather than recomputed here.
    const eligibility = eligibilityFor("retired_unreferenced");
    expect(persisted?.deadlineAt).toBe(eligibility.physicalPurgeNotBefore);
    expect(
      new Date(persisted?.deadlineAt ?? 0).getTime() -
        new Date(eligibility.earliestCandidateAt).getTime()
    ).toBe(GRACE_MS);
  });

  it("stops obligations for a source-bound mark and for no object-scoped one", async () => {
    const bound = await lane("stops-source-bound");
    const boundPlan = await marked(bound, "retired_unreferenced");
    expect(boundPlan.stopsObligations).toBe(true);
    expect(await bound.marks.readObligationsStoppedAt(SOURCE_VERSION_ID)).toBe(
      boundPlan.mark.markedAt
    );

    const objectScoped = await lane("object-scoped", { seedSourceVersion: false });
    const objectPlan = await marked(objectScoped, "expired_snapshot");
    expect(objectPlan.stopsObligations).toBe(false);
    expect(objectPlan.mark.sourceVersionId).toBeNull();
    // An object-scoped candidate has no source version to stamp, and the mark
    // still persists.
    expect(
      (await objectScoped.marks.readCollectionMark({
        payloadClass: "expired_snapshot",
        payloadRef: PAYLOAD_REF,
      }))?.state
    ).toBe("marked");
  });

  it("cancels the mark and resumes the obligations on reactivation", async () => {
    const target = await lane("reactivate");
    const plan = await marked(target);
    const afterMark = await target.maintenanceRevision();

    target.clock.set(atDay(93));
    const outcome = await target.marks.reactivateCollectionCandidate({
      context: target.context,
      scopeBinding: target.context.ownerScopeBinding,
      payloadClass: "retired_unreferenced",
      payloadRef: PAYLOAD_REF,
      sourceVersionId: SOURCE_VERSION_ID,
      // What the caller read: the revision the mark committed at.
      expectedLifecycleRevision: plan.mark.expectedLifecycleRevision,
    });

    expect(outcome.refused).toBe(false);
    if (outcome.refused) return;
    expect(outcome.plan.resumedObligations).toBe(true);
    expect(outcome.plan.cancelledAt).toBe(atDay(93).toISOString());
    expect(
      (await target.marks.readCollectionMark(target.identity))?.state
    ).toBe("cancelled");
    expect(await target.marks.readObligationsStoppedAt(SOURCE_VERSION_ID)).toBeNull();
    // Resuming obligations moves the scope as much as stopping them did.
    expect(await target.maintenanceRevision()).toBe(afterMark + 1);
  });

  it("refuses to reactivate a collected payload and leaves the mark standing", async () => {
    const target = await lane("collected", { payloadCollectedAt: atDay(80).toISOString() });
    const plan = await marked(target);
    const revision = await target.maintenanceRevision();

    const outcome = await target.marks.reactivateCollectionCandidate({
      context: target.context,
      scopeBinding: target.context.ownerScopeBinding,
      payloadClass: "retired_unreferenced",
      payloadRef: PAYLOAD_REF,
      sourceVersionId: SOURCE_VERSION_ID,
      expectedLifecycleRevision: plan.mark.expectedLifecycleRevision,
    });

    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("input_stale");
    // A refusal is a value and it changes nothing: the mark stands and the
    // obligations stay stopped.
    expect((await target.marks.readCollectionMark(target.identity))?.state).toBe(
      "marked"
    );
    expect(await target.marks.readObligationsStoppedAt(SOURCE_VERSION_ID)).toBe(
      plan.mark.markedAt
    );
    expect(await target.maintenanceRevision()).toBe(revision);
  });

  it("refuses a reactivation whose revision moved since the caller read it", async () => {
    const target = await lane("moved-revision");
    const plan = await marked(target);
    const revision = await target.maintenanceRevision();

    const outcome = await target.marks.reactivateCollectionCandidate({
      context: target.context,
      scopeBinding: target.context.ownerScopeBinding,
      payloadClass: "retired_unreferenced",
      payloadRef: PAYLOAD_REF,
      sourceVersionId: SOURCE_VERSION_ID,
      // One revision behind what the scope now holds.
      expectedLifecycleRevision: String(Number(plan.mark.expectedLifecycleRevision) - 1),
    });

    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("input_stale");
    expect(outcome.detail).toContain("revision moved");
    expect((await target.marks.readCollectionMark(target.identity))?.state).toBe(
      "marked"
    );
    expect(await target.marks.readObligationsStoppedAt(SOURCE_VERSION_ID)).toBe(
      plan.mark.markedAt
    );
    expect(await target.maintenanceRevision()).toBe(revision);
  });

  it("reports stale on a moved revision and the deadline independently of it", async () => {
    const target = await lane("recheck");
    const plan = await marked(target);

    // On time, unmoved: the deadline is reached and the mark is not stale.
    target.clock.set(atDay(97));
    const onTime = await target.marks.recheckCollectionCandidate({
      context: target.context,
      payloadClass: "retired_unreferenced",
      payloadRef: PAYLOAD_REF,
      now: target.clock(),
    });
    expect(onTime.refused).toBe(false);
    if (onTime.refused) return;
    expect(onTime.recheck.deadlineReached).toBe(true);
    expect(onTime.recheck.stale).toBe(false);

    // Move the scope without moving the clock, by marking a second payload in it.
    target.clock.set(atDay(97));
    await target.marks.markCollectionCandidate({
      context: target.context,
      scopeBinding: target.context.ownerScopeBinding,
      payloadClass: "retired_unreferenced",
      payloadRef: `${PAYLOAD_REF}-other`,
      sourceVersionId: SOURCE_VERSION_ID,
      eligibility: eligibilityFor("retired_unreferenced"),
    });

    const moved = await target.marks.recheckCollectionCandidate({
      context: target.context,
      payloadClass: "retired_unreferenced",
      payloadRef: PAYLOAD_REF,
      now: target.clock(),
    });
    expect(moved.refused).toBe(false);
    if (moved.refused) return;
    expect(moved.recheck.stale).toBe(true);
    expect(moved.recheck.observedLifecycleRevision).toBe(
      String(Number(plan.mark.expectedLifecycleRevision) + 1)
    );
    // The two verdicts do not collapse into one: a mark can be stale while its
    // deadline is still unreached, which is the case a "ready to delete" boolean
    // would get wrong.
    expect(moved.recheck.deadlineReached).toBe(true);

    const movedBeforeDeadline = await target.marks.recheckCollectionCandidate({
      context: target.context,
      payloadClass: "retired_unreferenced",
      payloadRef: PAYLOAD_REF,
      now: atDay(90),
    });
    expect(movedBeforeDeadline.refused).toBe(false);
    if (movedBeforeDeadline.refused) return;
    expect(movedBeforeDeadline.recheck.stale).toBe(true);
    expect(movedBeforeDeadline.recheck.deadlineReached).toBe(false);
  });

  it("leaves neither the mark nor the stamp when the obligations cannot be stopped", async () => {
    // A source-bound class whose source version this scope does not hold: the
    // mark row and the obligations stamp are one outcome, so a store that cannot
    // apply the effect must not record the mark either.
    const target = await lane("no-stamp-target", { seedSourceVersion: false });

    const outcome = await target.marks.markCollectionCandidate({
      context: target.context,
      scopeBinding: target.context.ownerScopeBinding,
      payloadClass: "retired_unreferenced",
      payloadRef: PAYLOAD_REF,
      sourceVersionId: SOURCE_VERSION_ID,
      eligibility: eligibilityFor("retired_unreferenced"),
    });

    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("invalid_input");
    expect(await target.marks.readCollectionMark(target.identity)).toBeNull();
    expect(await target.marks.readObligationsStoppedAt(SOURCE_VERSION_ID)).toBeNull();
  });
});

/**
 * The A3 obligation: one authoritative outcome when a mark races a reactivation.
 *
 * Both actions are released from the same barrier and each genuinely overlaps the
 * other — the read of the scope revision, the decision and the commit are
 * separate awaits inside the authority, so neither action holds the tail for its
 * whole body and their read-to-commit windows intersect.
 *
 * Repeated rounds rather than one, because a single round proves a sequence and
 * an invariant is a claim about every interleaving. The losing action is expected
 * to lose by being REFUSED, never by being silently dropped: a reactivation that
 * reports success while a live mark stands is the two-winner state the revision
 * fence exists to prevent, and it is the one outcome this asserts against.
 */
describe("MP14 A3 — a mark racing a reactivation", () => {
  const ROUNDS = 24;

  it("admits exactly one authoritative outcome, and never two winners", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const target = await lane(`a3-${round}`);
      // What a reactivation caller would have read before the race began.
      const expectedBefore = String(await target.maintenanceRevision());
      target.clock.set(atDay(90));

      let openBarrier: () => void = () => {};
      const barrier = new Promise<void>((resolve) => {
        openBarrier = resolve;
      });

      const markRun = (async () => {
        await barrier;
        return target.marks.markCollectionCandidate({
          context: target.context,
          scopeBinding: target.context.ownerScopeBinding,
          payloadClass: "retired_unreferenced",
          payloadRef: PAYLOAD_REF,
          sourceVersionId: SOURCE_VERSION_ID,
          eligibility: eligibilityFor("retired_unreferenced"),
        });
      })();
      const reactivationRun = (async () => {
        await barrier;
        return target.marks.reactivateCollectionCandidate({
          context: target.context,
          scopeBinding: target.context.ownerScopeBinding,
          payloadClass: "retired_unreferenced",
          payloadRef: PAYLOAD_REF,
          sourceVersionId: SOURCE_VERSION_ID,
          expectedLifecycleRevision: expectedBefore,
        });
      })();

      openBarrier();
      const [markOutcome, reactivateOutcome] = await Promise.all([
        markRun,
        reactivationRun,
      ]);
      const finalMark = await target.marks.readCollectionMark(target.identity);
      const stamp = await target.marks.readObligationsStoppedAt(SOURCE_VERSION_ID);

      const markStands = markOutcome.refused === false;
      const reactivationRefused = reactivateOutcome.refused === true;
      const reactivationStands = reactivateOutcome.refused === false;
      const markCancelled = markOutcome.refused === true || finalMark?.state === "cancelled";

      // Either the mark stands and the reactivation is refused, or the
      // reactivation stands and the mark is cancelled. Never both at once.
      expect(
        (markStands && reactivationRefused) || (reactivationStands && markCancelled)
      ).toBe(true);
      // The two-winner state, stated directly so a failure names it: a
      // reactivation that reports a completed cancellation while a live mark
      // still stands is a payload protected and deleted at the same time.
      expect(reactivationStands && finalMark?.state === "marked").toBe(false);
      // A mark and the obligations it stops are one outcome, so the stamp is
      // present exactly when a live mark claims it.
      expect(stamp !== null).toBe(finalMark?.state === "marked");
    }
  });
});

/**
 * The A3 obligation, restated as a test that can actually fail.
 *
 * P3-I3 requires a test that goes red when all serialization is removed. The race
 * above does not meet that bar, and the reason is worth writing down: in a
 * single-threaded runtime the event loop already admits one writer at a time, so
 * deleting the tail changes nothing the race can observe unless the two actions are
 * forced into an overlapping read-to-commit window in the first place.
 *
 * So this test injects that window instead of hoping for it. `readMaintenanceInputs`
 * is wrapped so that every action yields to the event loop immediately AFTER its
 * read and BEFORE it decides — the exact gap a lost update needs. That wrapper is
 * test-side only; the store is untouched.
 *
 * With the tail, the second action is still queued at `exclusive` when the first
 * yields, so the yield buys nothing and the ordering stays deterministic: one
 * action wins and the other is refused. With the tail removed, both actions read
 * the same revision, both decide against it, and both report success — which the
 * two-winner assertion below names directly.
 */
describe("MP14 A3 — the race is forced, not awaited", () => {
  /** Yields to the macrotask queue, so an unsuspended competing action runs. */
  const yieldToCompetingAction = (): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

  /**
   * Wraps the authority so each action yields after its read and before it
   * decides. Methods are bound through a proxy so nothing the store relies on
   * (including prototype methods) is lost to the spread.
   */
  const gated = (
    authority: AuthorizedScopeUnitOfWork
  ): MemoryCollectionMarkAuthority => ({
    withAuthorizedScope: (context, callback, options) =>
      authority.withAuthorizedScope(
        context,
        async (work) =>
          callback(
            new Proxy(work, {
              get(target, property) {
                if (property === "readMaintenanceInputs") {
                  return async (refs: readonly string[]) => {
                    const snapshot = await target.readMaintenanceInputs(refs);
                    await yieldToCompetingAction();
                    return snapshot;
                  };
                }
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            })
          ),
        options
      ),
  });

  it("refuses one of two winners, and reports both succeeding when the gate is open", async () => {
    for (let round = 0; round < 24; round += 1) {
      const target = await lane(`a3-gated-${round}`);
      const gatedAuthority = gated(target.authority);
      const marks = new InMemoryCollectionMarkStorage(
        gatedAuthority,
        { sourceVersions: target.seed.sourceVersions },
        () => target.clock()
      );
      const expectedBefore = String(await target.maintenanceRevision());
      target.clock.set(atDay(90));

      let openBarrier: () => void = () => {};
      const barrier = new Promise<void>((resolve) => {
        openBarrier = resolve;
      });

      const markRun = (async () => {
        await barrier;
        return marks.markCollectionCandidate({
          context: target.context,
          scopeBinding: target.context.ownerScopeBinding,
          payloadClass: "retired_unreferenced",
          payloadRef: PAYLOAD_REF,
          sourceVersionId: SOURCE_VERSION_ID,
          eligibility: eligibilityFor("retired_unreferenced"),
        });
      })();
      const reactivateRun = (async () => {
        await barrier;
        return marks.reactivateCollectionCandidate({
          context: target.context,
          scopeBinding: target.context.ownerScopeBinding,
          payloadClass: "retired_unreferenced",
          payloadRef: PAYLOAD_REF,
          sourceVersionId: SOURCE_VERSION_ID,
          expectedLifecycleRevision: expectedBefore,
        });
      })();

      openBarrier();
      const [markOutcome, reactivateOutcome] = await Promise.all([
        markRun,
        reactivateRun,
      ]);

      const markStands = markOutcome.refused === false;
      const reactivationStands = reactivateOutcome.refused === false;

      // The invariant, stated as the failure it prevents: one authoritative state
      // wins. Two actions both reporting success means the payload was marked and
      // un-marked by writers that never saw each other.
      expect(
        markStands && reactivationStands,
        `round ${round}: a mark and a reactivation both reported success against revision ${expectedBefore}`
      ).toBe(false);
    }
  });
});

/**
 * A stale recheck has to leave something behind.
 *
 * `recheckCollectionMark` reporting `stale` is only half of spec:307. Without a
 * recorded cancellation the verdict has no consequence and the stale mark is still
 * sitting in the table for the next scan to find — so this pins the reason, the
 * timestamp, and the fence that stops a stale verdict cancelling a mark that has
 * since moved on.
 */
describe("MP14 memory lane — cancelling a stale mark", () => {
  it("records the stale reason and the instant, distinct from a reactivation", async () => {
    const target = await lane("stale-cancel");
    await marked(target);
    const revision = String(await target.maintenanceRevision());
    target.clock.set(atDay(97));

    const outcome = await target.marks.cancelStaleCollectionMark({
      context: target.context,
      scopeBinding: target.context.ownerScopeBinding,
      payloadClass: "retired_unreferenced",
      payloadRef: PAYLOAD_REF,
      observedLifecycleRevision: revision,
    });
    expect(outcome.refused).toBe(false);

    const mark = await target.marks.readCollectionMark(target.identity);
    expect(mark?.state).toBe("cancelled");
    expect(mark?.cancelledReason).toBe("lifecycle_revision_changed");
    expect(mark?.cancelledAt).toBe(atDay(97).toISOString());
  });

  it("refuses to cancel against a revision the recheck did not observe", async () => {
    const target = await lane("stale-fence");
    await marked(target);
    target.clock.set(atDay(97));

    const outcome = await target.marks.cancelStaleCollectionMark({
      context: target.context,
      scopeBinding: target.context.ownerScopeBinding,
      payloadClass: "retired_unreferenced",
      payloadRef: PAYLOAD_REF,
      // The recheck read this before the mark landed and advanced the scope.
      observedLifecycleRevision: "0",
    });
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("input_stale");

    // The refusal must leave the mark standing: a stale verdict aimed at the wrong
    // revision is not evidence that this mark is stale.
    const mark = await target.marks.readCollectionMark(target.identity);
    expect(mark?.state).toBe("marked");
  });

  it("refuses a scope the context does not own", async () => {
    const target = await lane("stale-ownership");
    await marked(target);
    const revision = String(await target.maintenanceRevision());

    const outcome = await target.marks.cancelStaleCollectionMark({
      context: target.context,
      scopeBinding: "a-different-scope",
      payloadClass: "retired_unreferenced",
      payloadRef: PAYLOAD_REF,
      observedLifecycleRevision: revision,
    });
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) return;
    expect(outcome.code).toBe("access_denied");
  });
});
