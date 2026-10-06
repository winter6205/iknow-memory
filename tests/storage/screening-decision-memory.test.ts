/**
 * The memory lane of the guarded screening decision contract.
 *
 * It drives the real MemoryBackend: the real shared scope authority, the real
 * durable-work ledger, the real publication adapter and the real screening
 * store. The decision store holds its conflict state in no private copy — it
 * reads the conflict from the screening store and the revisions from the
 * publication adapter inside the same exclusive slice — so a decision cannot
 * resolve a conflict against a state another writer has already moved.
 */
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  claimNextWork,
  scheduleWork,
  settleWork,
} from "../../src/core/maintenance/service.js";
import type {
  MaintenanceAttemptGuard,
  MaintenanceDependency,
  MaintenanceWorkKind,
  MaintenanceWorkStore,
} from "../../src/core/maintenance/types.js";
import type {
  PublicationFact,
  PublicationOutboxPort,
  StructuredPublicationStorage,
} from "../../src/core/maintenance/publication-types.js";
import type { ProjectionSubject } from "../../src/core/storage/projection-outbox.js";
import type { ScreeningConflictFacts } from "../../src/core/maintenance/screening-decision.js";
import {
  deriveRelationAssertionId,
  normalizeRelationAssertion,
} from "../../src/core/structured/identity.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { MemoryScreeningDecisionStorage } from "../../src/core/storage/screening-decision-memory.js";
import { MemoryScreeningStorage } from "../../src/core/storage/screening-memory.js";
import type {
  AuthorizedScopeContext,
  AuthorizedScopeUnitOfWork,
} from "../../src/core/storage/structured-scope-types.js";
import {
  createPublicationTestClock,
  type PublicationTestClock,
} from "./publication-contract.js";
import {
  describeScreeningDecisionContract,
  type ConflictSupport,
  type ScreeningDecisionTestPort,
} from "./screening-decision-contract.js";

const DIMENSIONS = 8;
const ACTOR = "screening-decision-trusted-owner";
const CONFIG_REVISION = "extractor-v1";
const AUTHORIZATION_REVISION = "auth-screening-decision-1";
const DRAIN_LIMIT = 32;
const RELATION = "has_chair";

const HEAD = "00000000-0000-4000-8000-000000000601";
const TAILS = [
  "00000000-0000-4000-8000-000000000701",
  "00000000-0000-4000-8000-000000000702",
] as const;

interface Bound {
  readonly from: string | null;
  readonly until: string | null;
}

let serial = 0;

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

function opaqueDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The outbox this lane drives, recording every intent it is asked to queue.
 *
 * It is the real port the publication adapter composes, so a decision's intents
 * go through the same preparation the publication path uses — a lane-private
 * recorder would not prove the seam commits them with the visibility rows.
 */
class RecordingOutbox implements PublicationOutboxPort {
  readonly queued: ProjectionSubject[] = [];

  async prepareIntents(
    scopeBinding: string,
    subjects: readonly ProjectionSubject[]
  ): Promise<() => void> {
    if (scopeBinding.trim() === "") {
      // EXIT: the seam asked this port to queue intents for no scope. It refuses
      // before recording anything, so a decision cannot report enqueued intents
      // that were attributed to no scope at all.
      throw new Error("projection intents were prepared without a scope binding");
    }
    return () => {
      this.queued.push(...subjects);
    };
  }
}

interface MemoryDecisionPort extends ScreeningDecisionTestPort {
  readonly clock: PublicationTestClock;
  readonly outbox: RecordingOutbox;
}

async function openMemoryDecisionPort(): Promise<MemoryDecisionPort> {
  const outbox = new RecordingOutbox();
  const backend = new MemoryBackend(DIMENSIONS, {
    publicationOutbox: outbox,
  }) as MemoryBackend & {
    structuredPublication?: StructuredPublicationStorage;
    maintenanceWorkStore?: MaintenanceWorkStore;
    structuredScopeUnitOfWork?: AuthorizedScopeUnitOfWork;
  };
  const composed = backend.structuredPublication as
    | (StructuredPublicationStorage & {
        scopeRevisions(
          scopeBinding: string
        ): { readonly readRevision: bigint; readonly maintenanceRevision: bigint } | null;
      })
    | undefined;
  const work = backend.maintenanceWorkStore;
  const authority = backend.structuredScopeUnitOfWork;
  if (!composed || !work || !authority) {
    // EXIT: the backend composition supplied no publication adapter, work
    // ledger or shared scope authority. The setup throws before any case runs,
    // so no case can decide through a storage surface composition does not own.
    throw new Error(
      "MemoryBackend composition must supply the shared scope authority, publication and work stores the decision memory lane drives"
    );
  }
  const publication: NonNullable<typeof composed> = composed;
  const screening = new MemoryScreeningStorage(authority);
  const decisions = new MemoryScreeningDecisionStorage(
    authority,
    {
      readConflict: (scopeBinding, candidateId) =>
        screening.readConflict(scopeBinding, candidateId),
      readRevisions: (scopeBinding) => {
        const revisions = publication.scopeRevisions(scopeBinding);
        if (revisions === null) {
          // EXIT: the decision's scope holds no revision row. The lane refuses
          // rather than reporting an effect at a revision that does not exist.
          throw new Error(`no scope revisions for ${scopeBinding}`);
        }
        return {
          read: Number(revisions.readRevision),
          maintenance: Number(revisions.maintenanceRevision),
        };
      },
      prepareCommit: () => {
        throw new Error(
          "the decision store writes through the shared seam, not a private commit queue"
        );
      },
    },
    outbox
  );
  const clock = createPublicationTestClock(new Date());
  const seededScopes = new Map<string, { readonly label: string }>();

  async function claimOwnAttempt(input: {
    readonly workKind: MaintenanceWorkKind;
    readonly sourceRef: string;
    readonly sourceVersion: string;
    readonly generation: number;
    readonly dependencies: readonly MaintenanceDependency[];
  }): Promise<MaintenanceAttemptGuard> {
    const deps = { store: work, clock: () => clock() };
    const scheduled = await scheduleWork(
      deps,
      { actorId: ACTOR },
      {
        workKind: input.workKind,
        sourceRef: input.sourceRef,
        sourceVersion: input.sourceVersion,
        sourceGeneration: input.generation,
        configRevision: CONFIG_REVISION,
        dependencies: input.dependencies,
      }
    );
    if ("refused" in scheduled) {
      throw new Error(`decision memory fixture schedule refused: ${scheduled.refused}`);
    }
    for (let attempt = 0; attempt < DRAIN_LIMIT; attempt += 1) {
      const claimed = await claimNextWork(deps);
      const guard = claimed.guard;
      if (guard === null) break;
      if (guard.jobKey === scheduled.record.jobKey) return guard;
      await settleWork(
        deps,
        guard,
        { status: "failed", failureCode: "input_stale" },
        { configRevision: CONFIG_REVISION, dependencies: input.dependencies }
      );
    }
    throw new Error("decision memory fixture could not claim its own job");
  }

  /**
   * Publish one real conflict through the lane's real screening store, then
   * report the exact facts a decision about it must present.
   */
  async function seedConflict(label: string): Promise<{
    readonly context: AuthorizedScopeContext;
    readonly facts: ScreeningConflictFacts;
    readonly supports: readonly ConflictSupport[];
    readonly scopeBinding: string;
  }> {
    const scopeBinding = unique(`decision-scope-${label}`);
    const sourceRef = unique(`${label}-source`);
    const extractionRef = `decision-extraction-${label}`;
    const intervals: readonly Bound[] = [
      { from: "2020-01-01T00:00:00.000Z", until: "2025-01-01T00:00:00.000Z" },
      { from: "2022-01-01T00:00:00.000Z", until: "2027-01-01T00:00:00.000Z" },
    ];
    const { record } = await backend.registerSourceVersion({
      source_ref: sourceRef,
      source_version: "v1",
      content_digest: opaqueDigest(`${sourceRef}:v1`),
      origin_object_ref: `objects/${sourceRef}/v1.html`,
      parser_revision: "frozen-html-units-v1",
      unit_manifest: { units: 2, parser_revision: "frozen-html-units-v1" },
      created_at: clock().toISOString(),
      retired_at: null,
      payload_collected_at: null,
      obligations_stopped_at: null,
    });
    const locatorBindings = [1, 2].map((unit) => ({
      source_version_id: record.source_version_id,
      document_id: `${sourceRef}-document`,
      version: "frozen-v1",
      unit,
    }));
    for (const binding of locatorBindings) await backend.bindSourceLocator(binding);
    await backend.setScopeRevisions(scopeBinding, {
      authorizationRevision: AUTHORIZATION_REVISION,
      purgeRevision: "purge-1",
    });
    const declared = await publication.declareDesired({
      scopeBinding,
      authorizedSourceRefs: [sourceRef],
      sourceRef,
      sourceVersion: record,
      locatorBindings,
      desiredExtractionRevision: 1,
      configRevision: CONFIG_REVISION,
    });
    const facts: PublicationFact[] = intervals.map((interval, index) => {
      const tailEntityId = TAILS[index]!;
      return {
        identity: {
          kind: "relation_assertion",
          input: {
            headEntityId: HEAD,
            relationNorm: RELATION,
            tailEntityId,
            validWindow: { from: interval.from, until: interval.until },
          },
        },
        occurrence: {
          subject: "assertion",
          result_id: derivedAssertionId({
            headEntityId: HEAD,
            relationNorm: RELATION,
            tailEntityId,
            interval,
          }),
          source_ref: sourceRef,
          source_version: "v1",
          location: {
            document_id: `${sourceRef}-document`,
            version: "frozen-v1",
            unit: index + 1,
          },
          extraction_ref: extractionRef,
          extractedAt: record.created_at,
        },
      } as PublicationFact;
    });
    const publishDependencies: MaintenanceDependency[] = [
      { sourceRef, generation: declared.generation, extractionRevision: null, relationBuckets: [] },
    ];
    const publishGuard = await claimOwnAttempt({
      workKind: "extract_publish",
      sourceRef,
      sourceVersion: "v1",
      generation: declared.generation,
      dependencies: publishDependencies,
    });
    await publication.stageAttempt({
      scopeBinding,
      sourceRef,
      guard: publishGuard,
      extractionRef,
      accepted: facts,
    });
    await publication.publish({
      scopeBinding,
      sourceRef,
      guard: publishGuard,
      at: clock().toISOString(),
    });
    await settleWork(
      { store: work, clock: () => clock() },
      publishGuard,
      { status: "ready" },
      { configRevision: CONFIG_REVISION, dependencies: publishDependencies }
    );
    const context = authority.createAuthorizedContext({
      actorId: ACTOR,
      ownerScopeBinding: scopeBinding,
      readerBinding: `${scopeBinding}-reader`,
      authorizedSourceRefs: [sourceRef],
      authorizationRevision: AUTHORIZATION_REVISION,
      deadlineAt: new Date(clock().getTime() + 10 * 60_000).toISOString(),
    });
    const guard = await claimOwnAttempt({
      workKind: "conflict_check",
      sourceRef,
      sourceVersion: "v1",
      generation: declared.generation,
      dependencies: [
        {
          sourceRef,
          generation: declared.generation,
          extractionRevision: 1,
          relationBuckets: [RELATION],
        },
      ],
    });
    const outcome = await screening.stageScreen({
      context,
      guard,
      relationBuckets: [RELATION],
      relationCatalogVersion: 0,
      relationCatalogEntries: [],
      acceptedAssertions: [
        {
          headEntityId: HEAD,
          relationNorm: RELATION,
          tailEntityId: TAILS[0]!,
          interval: { lower: intervals[0]!.from, upper: intervals[0]!.until },
          assertionId: derivedAssertionId({
            headEntityId: HEAD,
            relationNorm: RELATION,
            tailEntityId: TAILS[0]!,
            interval: intervals[0]!,
          }),
          supportIds: [supportIdFor(label, 1)],
          extractionRef,
          extractionRevision: 1,
          inputRevision: `input-revision-${label}`,
        },
        {
          headEntityId: HEAD,
          relationNorm: RELATION,
          tailEntityId: TAILS[1]!,
          interval: { lower: intervals[1]!.from, upper: intervals[1]!.until },
          assertionId: derivedAssertionId({
            headEntityId: HEAD,
            relationNorm: RELATION,
            tailEntityId: TAILS[1]!,
            interval: intervals[1]!,
          }),
          supportIds: [supportIdFor(label, 2)],
          extractionRef,
          extractionRevision: 1,
          inputRevision: `input-revision-${label}`,
        },
      ],
      liveSources: new Map([
        [
          sourceRef,
          {
            active: true,
            generation: declared.generation,
            publishedExtractionRevision: 1,
          },
        ],
      ]),
      liveConfigRevision: CONFIG_REVISION,
      guardFailure: (candidate, now) => work.publicationGuardFailure(candidate, now),
      scheduledDependencies: (candidate) =>
        work.publicationDependenciesForGuard(candidate),
      now: () => clock(),
    });
    const candidate = outcome.candidates[0];
    if (candidate === undefined) {
      // EXIT: the fixture's own screen published no conflict, so every decision
      // case would run against nothing. The setup throws before the case body.
      throw new Error(`decision memory fixture published no conflict for ${label}`);
    }
    const conflict = screening.readConflict(scopeBinding, candidate.candidateId);
    if (conflict === undefined) {
      // EXIT: the screening store published a candidate it cannot read back. The
      // setup refuses rather than deciding against a conflict the store does
      // not hold.
      throw new Error(`decision memory fixture cannot read back ${candidate.candidateId}`);
    }
    seededScopes.set(scopeBinding, { label });
    const revisions = publication.scopeRevisions(scopeBinding);
    return {
      context,
      facts: {
        scopeBinding,
        candidateId: candidate.candidateId,
        checkId: conflict.checkId,
        supportIds: conflict.supportIds,
        assertionIds: conflict.assertionIds,
        inputRevision: conflict.inputRevision,
        relationCatalogVersion: conflict.relationCatalogVersion,
        readRevision: Number(revisions?.readRevision ?? 0),
        maintenanceRevision: Number(revisions?.maintenanceRevision ?? 0),
      },
      supports: conflict.supportIds.map((supportId, index) => ({
        supportId,
        assertionId: conflict.assertionIds[index] ?? conflict.assertionIds[0]!,
      })),
      scopeBinding,
    };
  }

  const port: MemoryDecisionPort = {
    label: "memory",
    clock,
    outbox,
    seedConflict,
    applyDecision: (input) =>
      decisions.applyDecision({ ...input, now: () => clock() }),
    async readDecisions(scopeBinding, candidateId) {
      return decisions.readDecisions(scopeBinding, candidateId);
    },
    async readConflictResolution(scopeBinding, candidateId) {
      return decisions.readConflictResolution(scopeBinding, candidateId);
    },
    async readVisibility(scopeBinding, candidateId) {
      return decisions.readVisibility(scopeBinding, candidateId);
    },
    /**
     * A fingerprint of every authoritative store a decision can touch, read
     * from outside the unit of work that applied or refused it. Equality of two
     * fingerprints is the only proof a refusal changed nothing.
     */
    async fingerprint(scopeBinding) {
      const snapshot = await publication.readSnapshot({ scopeBinding });
      const revisions = publication.scopeRevisions(scopeBinding);
      return JSON.stringify({
        revisions: revisions === null
          ? null
          : [String(revisions.readRevision), String(revisions.maintenanceRevision)],
        sources: snapshot.sources
          .map((source) => [source.sourceRef, source.active, String(source.generation)])
          .sort(),
        subjects: snapshot.subjects
          .map((subject) => [
            subject.resultId,
            [...subject.supportIds].sort(),
          ])
          .sort(),
        candidates: screening.readCandidates(scopeBinding).map((candidate) => [
          candidate.candidateId,
          candidate.checkId,
          candidate.uncertaintyReason,
        ]),
        decisions: decisions.readDecisions(scopeBinding).map((decision) => [
          decision.decisionId,
          decision.outcome,
          decision.reason,
          decision.actorId,
          [...decision.retireSupportIds].sort(),
          [...decision.retainSupportIds].sort(),
          decision.contentDigest,
        ]),
        visibility: decisions.readScopeVisibility(scopeBinding).map((entry) => [
          entry.conflict ?? "",
          entry.supportId,
          entry.current,
          entry.resolvedBy,
        ]),
        intents: outbox.queued.map((subject) => `${subject.kind}:${subject.id}`),
      });
    },
    async readRevisions(scopeBinding) {
      const revisions = publication.scopeRevisions(scopeBinding);
      return revisions === null
        ? { read: 0, maintenance: 0 }
        : {
            read: Number(revisions.readRevision),
            maintenance: Number(revisions.maintenanceRevision),
          };
    },
    async readIntents() {
      return outbox.queued.map((subject) => subject.id);
    },
    close: () => backend.close(),
  };
  return port;
}

function supportIdFor(label: string, index: number): string {
  const serialForSupport = label.length.toString(16).padStart(4, "0").slice(-4);
  return `00000000-0000-4000-8000-1${serialForSupport}${String(index).padStart(2, "0")}`;
}

function derivedAssertionId(input: {
  readonly headEntityId: string;
  readonly relationNorm: string;
  readonly tailEntityId: string;
  readonly interval: Bound;
}): string {
  return deriveRelationAssertionId(
    normalizeRelationAssertion({
      headEntityId: input.headEntityId,
      relationNorm: input.relationNorm,
      tailEntityId: input.tailEntityId,
      validWindow: { from: input.interval.from, until: input.interval.until },
    })
  );
}

const openPorts: MemoryDecisionPort[] = [];

afterEach(async () => {
  for (const port of openPorts.splice(0)) {
    await port.close();
  }
});

async function openLane(): Promise<MemoryDecisionPort> {
  const port = await openMemoryDecisionPort();
  openPorts.push(port);
  return port;
}

describe("MemoryBackend screening decision wiring", () => {
  it("decides under the shared scope authority rather than a private queue", () => {
    const backend = new MemoryBackend(DIMENSIONS) as MemoryBackend & {
      structuredScopeUnitOfWork?: AuthorizedScopeUnitOfWork;
      structuredPublication?: StructuredPublicationStorage;
    };
    const screening = new MemoryScreeningStorage(backend.structuredScopeUnitOfWork!);
    const decisions = new MemoryScreeningDecisionStorage(
      backend.structuredScopeUnitOfWork!,
      {
        readConflict: (scopeBinding, candidateId) =>
          screening.readConflict(scopeBinding, candidateId),
        readRevisions: (scopeBinding) => {
          const revisions = (
            backend.structuredPublication as
              | (StructuredPublicationStorage & {
                  scopeRevisions(
                    binding: string
                  ): { readonly readRevision: bigint; readonly maintenanceRevision: bigint } | null;
                })
              | undefined
          )?.scopeRevisions(scopeBinding);
          return revisions === null || revisions === undefined
            ? { read: 0, maintenance: 0 }
            : {
                read: Number(revisions.readRevision),
                maintenance: Number(revisions.maintenanceRevision),
              };
        },
        prepareCommit: () => {
          throw new Error(
            "the decision store writes through the shared seam, not a private commit queue"
          );
        },
      }
    );
    expect(typeof decisions.applyDecision).toBe("function");
    expect(typeof decisions.readDecisions).toBe("function");
    // The store reads its conflict from the screening store and its revisions
    // from the publication adapter, so it holds no second copy of either.
    expect(backend.structuredScopeUnitOfWork).toBeDefined();
  });
});

describeScreeningDecisionContract(openLane);
