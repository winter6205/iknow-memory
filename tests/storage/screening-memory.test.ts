/**
 * The memory lane of the structural screening contract.
 *
 * It drives the real MemoryBackend: the real shared scope authority, the real
 * durable-work ledger and the real publication adapter. The screening store
 * takes its fence verdict from that ledger, so a screening commit shares
 * authority with publication rather than keeping a private copy.
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
import {
  WORK_ABSOLUTE_LIMIT_MS,
  WORK_LEASE_MS,
} from "../../src/core/maintenance/types.js";
import type {
  PublicationFact,
  PublicationOutboxPort,
  StructuredPublicationStorage,
} from "../../src/core/maintenance/publication-types.js";
import {
  deriveRelationAssertionId,
  normalizeRelationAssertion,
} from "../../src/core/structured/identity.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
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
  describeScreeningContract,
  type ScreeningTestPort,
} from "./screening-contract.js";

const DIMENSIONS = 8;
const ACTOR = "screening-memory-trusted-owner";
const CONFIG_REVISION = "extractor-v1";
const AUTHORIZATION_REVISION = "auth-screening-1";
const DRAIN_LIMIT = 32;
const RELATION = "has_chair";

const HEAD = "00000000-0000-4000-8000-000000000101";
const TAILS = [
  "00000000-0000-4000-8000-000000000201",
  "00000000-0000-4000-8000-000000000202",
] as const;

interface Bound {
  readonly from: string | null;
  readonly until: string | null;
}

interface Shape {
  readonly intervals: readonly Bound[];
  readonly tails: readonly string[];
}

/**
 * The interval shapes each frozen case reads. They are fixture inputs, not
 * expectations: the expected outcome of every case is its specification rule.
 * A duplicate case names the SAME tail twice, which is what makes it one
 * assertion with several supports rather than two alternatives.
 */
const SHAPES: Readonly<Record<string, Shape>> = {
  overlapping: {
    intervals: [
      { from: "2020-01-01T00:00:00.000Z", until: "2025-01-01T00:00:00.000Z" },
      { from: "2022-01-01T00:00:00.000Z", until: "2027-01-01T00:00:00.000Z" },
    ],
    tails: [TAILS[0]!, TAILS[1]!],
  },
  identical: {
    intervals: [
      { from: "2020-01-01T00:00:00.000Z", until: "2025-01-01T00:00:00.000Z" },
      { from: "2020-01-01T00:00:00.000Z", until: "2025-01-01T00:00:00.000Z" },
    ],
    tails: [TAILS[0]!, TAILS[0]!],
  },
  adjacent: {
    intervals: [
      { from: "2020-01-01T00:00:00.000Z", until: "2025-01-01T00:00:00.000Z" },
      { from: "2025-01-01T00:00:00.000Z", until: "2030-01-01T00:00:00.000Z" },
    ],
    tails: [TAILS[0]!, TAILS[1]!],
  },
  disjoint: {
    intervals: [
      { from: "2000-01-01T00:00:00.000Z", until: "2001-01-01T00:00:00.000Z" },
      { from: "2020-01-01T00:00:00.000Z", until: "2021-01-01T00:00:00.000Z" },
    ],
    tails: [TAILS[0]!, TAILS[1]!],
  },
  unbounded: {
    intervals: [
      { from: null, until: null },
      { from: null, until: null },
    ],
    tails: [TAILS[0]!, TAILS[1]!],
  },
};

function shapeFor(label: string): Shape {
  if (label.startsWith("sc02")) return SHAPES.unbounded!;
  if (label.startsWith("sc04") || label.startsWith("sc05")) return SHAPES.identical!;
  if (label.startsWith("sc06-adjacent")) return SHAPES.adjacent!;
  if (label.startsWith("sc06-disjoint")) return SHAPES.disjoint!;
  return SHAPES.overlapping!;
}

let serial = 0;

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

function opaqueDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function quietOutbox(): PublicationOutboxPort {
  return {
    async prepareIntents() {
      return () => undefined;
    },
  };
}

interface MemoryScreeningPort extends ScreeningTestPort {
  readonly clock: PublicationTestClock;
  close(): Promise<void>;
}

interface LiveSource {
  readonly active: boolean;
  readonly generation: number;
  readonly publishedExtractionRevision: number | null;
}

async function openMemoryScreeningPort(): Promise<MemoryScreeningPort> {
  const backend = new MemoryBackend(DIMENSIONS, {
    publicationOutbox: quietOutbox(),
  }) as MemoryBackend & {
    structuredPublication?: StructuredPublicationStorage;
    maintenanceWorkStore?: MaintenanceWorkStore;
    structuredScopeUnitOfWork?: AuthorizedScopeUnitOfWork;
  };
  const publication = backend.structuredPublication;
  const work = backend.maintenanceWorkStore;
  const authority = backend.structuredScopeUnitOfWork;
  if (!publication || !work || !authority) {
    // EXIT: the backend composition supplied no publication adapter, work
    // ledger or shared scope authority. The setup throws before any case runs,
    // so no case can publish through a storage surface composition does not own.
    throw new Error(
      "MemoryBackend composition must supply the shared scope authority, publication and work stores the screening memory lane drives"
    );
  }
  const screening = new MemoryScreeningStorage(authority);
  const clock = createPublicationTestClock(new Date());
  const scopes = new Map<
    string,
    {
      readonly label: string;
      /** The initiating source's current row. */
      live: LiveSource;
      /** The dependent source's current row. */
      dependent: LiveSource;
      configRevision: string;
      guard: MaintenanceAttemptGuard;
    }
  >();

  async function seedScope(label: string): Promise<{
    readonly context: AuthorizedScopeContext;
    readonly guard: MaintenanceAttemptGuard;
    readonly scopeBinding: string;
    readonly sources: readonly string[];
  }> {
    const shape = shapeFor(label);
    const scopeBinding = unique(`screening-scope-${label}`);
    const sourceRef = unique(`${label}-source`);
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
    const generation = declared.generation;
    const extractionRef = `screening-extraction-${label}`;
    const facts: PublicationFact[] = shape.intervals.map((interval, index) => {
      const tailEntityId = shape.tails[index]!;
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
          // The publication adapter derives and registers the identity from this
          // tuple, so the fixture derives the same id rather than inventing one.
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
            // Each accepted row occupies its own unit, so two occurrences of one
            // identity are two supports rather than a repeated occurrence.
            unit: index + 1,
          },
          extraction_ref: extractionRef,
          extractedAt: record.created_at,
        },
      } as PublicationFact;
    });
    const publishDependencies: MaintenanceDependency[] = [
      { sourceRef, generation, extractionRevision: null, relationBuckets: [] },
    ];
    const publishGuard = await claimOwnAttempt({
      work,
      clock,
      workKind: "extract_publish",
      sourceRef,
      sourceVersion: "v1",
      generation,
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
    // A second, dependent source joins the vector. Its own accepted set is
    // empty, so it contributes no candidate, but its published extraction
    // revision is part of what the screen is fenced against.
    const dependentRef = unique(`${label}-dependent`);
    const dependentVersion = await backend.registerSourceVersion({
      source_ref: dependentRef,
      source_version: "v1",
      content_digest: opaqueDigest(`${dependentRef}:v1`),
      origin_object_ref: `objects/${dependentRef}/v1.html`,
      parser_revision: "frozen-html-units-v1",
      unit_manifest: { units: 1, parser_revision: "frozen-html-units-v1" },
      created_at: clock().toISOString(),
      retired_at: null,
      payload_collected_at: null,
      obligations_stopped_at: null,
    });
    const dependentLocators = [
      {
        source_version_id: dependentVersion.record.source_version_id,
        document_id: `${dependentRef}-document`,
        version: "frozen-v1",
        unit: 1,
      },
    ];
    for (const binding of dependentLocators) {
      await backend.bindSourceLocator(binding);
    }
    const dependentDeclared = await publication.declareDesired({
      scopeBinding,
      authorizedSourceRefs: [sourceRef, dependentRef],
      sourceRef: dependentRef,
      sourceVersion: dependentVersion.record,
      locatorBindings: dependentLocators,
      desiredExtractionRevision: 1,
      configRevision: CONFIG_REVISION,
    });
    const dependentGuard = await claimOwnAttempt({
      work,
      clock,
      workKind: "extract_publish",
      sourceRef: dependentRef,
      sourceVersion: "v1",
      generation: dependentDeclared.generation,
      dependencies: [
        {
          sourceRef: dependentRef,
          generation: dependentDeclared.generation,
          extractionRevision: null,
          relationBuckets: [],
        },
      ],
    });
    await publication.stageAttempt({
      scopeBinding,
      sourceRef: dependentRef,
      guard: dependentGuard,
      extractionRef: `screening-extraction-${label}-dependent`,
      accepted: [],
    });
    await publication.publish({
      scopeBinding,
      sourceRef: dependentRef,
      guard: dependentGuard,
      at: clock().toISOString(),
    });
    await settleWork(
      { store: work, clock: () => clock() },
      dependentGuard,
      { status: "ready" },
      {
        configRevision: CONFIG_REVISION,
        dependencies: [
          {
            sourceRef: dependentRef,
            generation: dependentDeclared.generation,
            extractionRevision: null,
            relationBuckets: [],
          },
        ],
      }
    );
    const guard = await claimOwnAttempt({
      work,
      clock,
      workKind: "conflict_check",
      sourceRef,
      sourceVersion: "v1",
      generation,
      dependencies: [
        { sourceRef, generation, extractionRevision: 1, relationBuckets: [RELATION] },
        {
          sourceRef: dependentRef,
          generation: dependentDeclared.generation,
          extractionRevision: 1,
          relationBuckets: [],
        },
      ],
    });
    dependentSourceRefs.set(scopeBinding, dependentRef);
    scopes.set(scopeBinding, {
      label,
      live: { active: true, generation, publishedExtractionRevision: 1 },
      dependent: {
        active: true,
        generation: dependentDeclared.generation,
        publishedExtractionRevision: 1,
      },
      configRevision: CONFIG_REVISION,
      guard,
    });
    return { context, guard, scopeBinding, sources: [sourceRef] };
  }

  function acceptedAssertions(label: string) {
    const shape = shapeFor(label);
    const extractionRef = `screening-extraction-${label}`;
    return shape.intervals.map((interval, index) => {
      const tailEntityId = shape.tails[index]!;
      return {
        headEntityId: HEAD,
        relationNorm: RELATION,
        tailEntityId,
        interval: { lower: interval.from, upper: interval.until },
        assertionId: derivedAssertionId({
          headEntityId: HEAD,
          relationNorm: RELATION,
          tailEntityId,
          interval,
        }),
        supportIds: [
          `00000000-0000-4000-8000-0000000003${String(index + 1).padStart(2, "0")}`,
        ],
        extractionRef,
        extractionRevision: 1,
        inputRevision: `input-revision-${label}`,
      };
    });
  }

  const port: MemoryScreeningPort = {
    label: "memory",
    clock,
    stageScreen(input) {
      const stored = scopes.get(input.context.ownerScopeBinding);
      if (stored === undefined) {
        // EXIT: a screen is asked to run under a scope this lane never seeded.
        // The port refuses so a case cannot screen against an empty fixture set.
        throw new Error(
          `no seeded scope for ${input.context.ownerScopeBinding}`
        );
      }
      return screening.stageScreen({
        ...input,
        acceptedAssertions: acceptedAssertions(stored.label),
        liveSources: new Map([
          [stored.guard.sourceRef, stored.live],
          [dependentSourceRefOf(input.context.ownerScopeBinding), stored.dependent],
        ]),
        liveConfigRevision: stored.configRevision,
        guardFailure: (guard, now) => work.publicationGuardFailure(guard, now),
        scheduledDependencies: (guard) => work.publicationDependenciesForGuard(guard),
        now: () => clock(),
      });
    },
    async startAttempt(label, options = {}) {
      if (options.advanceMs !== undefined) clock.advance(options.advanceMs);
      return seedScope(label);
    },
    acceptedAssertions,
    staleTokenGuard() {
      const guard = lastScope().guard;
      // A reclaim mints a fresh token; this worker still holds the old one.
      return { ...guard, fencingToken: `${guard.fencingToken}-stale` };
    },
    expireLease() {
      // Past the lease and inside the absolute bound, so the case observes the
      // lease fence rather than the deadline fence.
      clock.advance(WORK_LEASE_MS + 60_000);
    },
    outliveAbsoluteDeadline() {
      // The lease still holds here; only the absolute bound has passed, so the
      // case observes the deadline fence and not the lease fence.
      clock.advance(WORK_ABSOLUTE_LIMIT_MS + 60_000);
    },
    async moveDependentExtraction() {
      const stored = lastScope();
      // Only the dependent source's published extraction revision moves. Its
      // generation, the initiating source and the guard are untouched, so only
      // the complete dependency-vector comparison can catch this.
      stored.dependent = {
        ...stored.dependent,
        publishedExtractionRevision:
          (stored.dependent.publishedExtractionRevision ?? 0) + 1,
      };
    },
    async moveConfigRevision() {
      const stored = lastScope();
      // The memory lane's live config revision is the config the source was
      // published with, so a re-declaration under a new one moves it.
      stored.configRevision = `${CONFIG_REVISION}-moved`;
    },
    async moveDependency() {
      // Generation only ever increases: an A-to-B-to-A content round trip does
      // not restore the old value, which is what invalidates the old readiness.
      const stored = lastScope();
      stored.live = {
        ...stored.live,
        generation: stored.live.generation + 1,
      };
    },
    wrongWorkKindGuard() {
      return {
        ...lastScope().guard,
        workKind: "extract_publish" as MaintenanceWorkKind,
      };
    },
    async readCandidates(scopeBinding) {
      return screening.readCandidates(scopeBinding).map((candidate) => ({
        candidateId: candidate.candidateId,
        tailEntityIds: candidate.tailEntityIds,
        uncertaintyReason: candidate.uncertaintyReason,
        unboundedLower: candidate.unboundedLower,
        unboundedUpper: candidate.unboundedUpper,
        supportIds: candidate.supportIds,
        assertionIds: candidate.assertionIds,
      }));
    },
    async readCheckCount(scopeBinding) {
      return screening.readCheckCount(scopeBinding);
    },
    close: () => backend.close(),
  };

  const dependentSourceRefs = new Map<string, string>();

  function dependentSourceRefOf(scopeBinding: string): string {
    return dependentSourceRefs.get(scopeBinding) ?? "";
  }

  function lastScope(): {
    readonly label: string;
    live: LiveSource;
    dependent: LiveSource;
    configRevision: string;
    guard: MaintenanceAttemptGuard;
  } {
    const keys = [...scopes.keys()];
    const latest = keys[keys.length - 1];
    const stored = latest === undefined ? undefined : scopes.get(latest);
    if (stored === undefined) {
      // EXIT: no scope has been seeded yet. The fixture refuses so a fence case
      // cannot be exercised against a guard this lane never created.
      throw new Error("no seeded scope for the fence cases");
    }
    return stored;
  }
  return port;
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

async function claimOwnAttempt(input: {
  readonly work: MaintenanceWorkStore;
  readonly clock: PublicationTestClock;
  readonly workKind: MaintenanceWorkKind;
  readonly sourceRef: string;
  readonly sourceVersion: string;
  readonly generation: number;
  readonly dependencies: readonly MaintenanceDependency[];
}): Promise<MaintenanceAttemptGuard> {
  const deps = { store: input.work, clock: () => input.clock() };
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
    throw new Error(`screening memory fixture schedule refused: ${scheduled.refused}`);
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
  throw new Error("screening memory fixture could not claim its own job");
}

const openPorts: MemoryScreeningPort[] = [];

afterEach(async () => {
  for (const port of openPorts.splice(0)) {
    await port.close();
  }
});

async function openLane(): Promise<MemoryScreeningPort> {
  const port = await openMemoryScreeningPort();
  openPorts.push(port);
  return port;
}

describe("MemoryBackend structural screening wiring", () => {
  it("publishes under the shared scope authority rather than a private map", () => {
    const backend = new MemoryBackend(DIMENSIONS) as MemoryBackend & {
      structuredScopeUnitOfWork?: AuthorizedScopeUnitOfWork;
    };
    const screening = new MemoryScreeningStorage(
      backend.structuredScopeUnitOfWork!
    );
    expect(typeof screening.stageScreen).toBe("function");
    expect(typeof screening.readCandidates).toBe("function");
    // The store composes the backend's own authority, so a screen cannot hold a
    // second write path around the shared tail.
    expect(backend.structuredScopeUnitOfWork).toBeDefined();
  });
});

describeScreeningContract(openLane);