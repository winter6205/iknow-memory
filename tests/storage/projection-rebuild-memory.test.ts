/**
 * The memory lane of the MP11 projection-rebuild contract.
 *
 * It drives the real MemoryBackend: the real shared scope authority, the real
 * durable-work ledger, the real publication adapter and the real projection
 * outbox port. Each scenario builds its own backend because the durable-work
 * ledger is one shared queue whose claims cannot be released.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  claimNextWork,
  scheduleWork,
  settleWork,
} from "../../src/core/maintenance/service.js";
import type {
  MaintenanceAttemptGuard,
  MaintenanceDependency,
  MaintenanceWorkStore,
} from "../../src/core/maintenance/types.js";
import type {
  PublicationFact,
  StructuredPublicationStorage,
} from "../../src/core/maintenance/publication-types.js";
import {
  deriveRelationAssertionId,
  normalizeRelationAssertion,
} from "../../src/core/structured/identity.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { MemoryStructuredScopeUnitOfWork } from "../../src/core/storage/structured-scope-uow.js";
import type { AuthorizedScopeContext } from "../../src/core/storage/structured-scope-types.js";
import { createPublicationTestClock } from "./publication-contract.js";
import {
  describeProjectionRebuildContract,
  type DerivedProjectionObservation,
  type ProjectionRebuildScope,
  type StableHistoryFingerprint,
} from "./projection-rebuild-contract.js";

const DIMENSIONS = 8;
const ACTOR = "rebuild-memory-trusted-owner";
const AUTHORIZATION_REVISION = "auth-rebuild-memory-1";
const PURGE_REVISION = "purge-1";
const CONFIG_REVISION = "extractor-v1";
const RELATION = "has_chair";
const HEAD = "00000000-0000-4000-8000-000000000901";
const TAILS = [
  "00000000-0000-4000-8000-000000000911",
  "00000000-0000-4000-8000-000000000912",
] as const;

interface Scenario {
  readonly backend: MemoryBackend;
  readonly clock: ReturnType<typeof createPublicationTestClock>;
  readonly work: MaintenanceWorkStore;
  readonly publication: StructuredPublicationStorage;
  readonly rebuild: MemoryBackend["projectionRebuild"];
  readonly authority: MemoryStructuredScopeUnitOfWork;
  readonly deps: {
    readonly store: MaintenanceWorkStore;
    readonly clock: () => Date;
  };
}

const scenarios = new Map<string, Scenario>();

/**
 * Rebuild attempts a case has claimed but not settled, per scope.
 *
 * The durable-work ledger releases no claim back to `pending`, so a repeat
 * attempt in one scope is only reachable by settling the previous one.
 */
const settled = new Map<
  string,
  Array<{
    readonly guard: MaintenanceAttemptGuard;
    readonly dependencies: readonly MaintenanceDependency[];
  }>
>();

function scenarioFor(scopeBinding: string): Scenario {
  const held = scenarios.get(scopeBinding);
  if (held === undefined) {
    // EXIT: a case drives a scope this lane never built. The fixture throws
    // rather than falling back to a shared backend, which would let one case's
    // ledger entries be claimed by the next.
    throw new Error(`rebuild memory lane has no scenario for ${scopeBinding}`);
  }
  return held;
}

function createScenario(): Scenario {
  const backend = new MemoryBackend(DIMENSIONS);
  const clock = createPublicationTestClock(new Date());
  const authority: MemoryStructuredScopeUnitOfWork =
    backend.structuredScopeUnitOfWork;
  return {
    backend,
    clock,
    work: backend.maintenanceWorkStore,
    publication: backend.structuredPublication,
    rebuild: backend.projectionRebuild,
    authority,
    deps: { store: backend.maintenanceWorkStore, clock: () => clock() },
  };
}

let serial = 0;

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

function opaqueDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function contextFor(
  scenario: Scenario,
  scopeBinding: string,
  sourceRefs: readonly string[]
): AuthorizedScopeContext {
  return scenario.authority.createAuthorizedContext({
    actorId: ACTOR,
    ownerScopeBinding: scopeBinding,
    readerBinding: `${scopeBinding}-reader`,
    authorizedSourceRefs: sourceRefs,
    authorizationRevision: AUTHORIZATION_REVISION,
    deadlineAt: new Date(scenario.clock().getTime() + 10 * 60_000).toISOString(),
  });
}

async function registerVersion(
  scenario: Scenario,
  sourceRef: string,
  version: string,
  units: number
): Promise<{ readonly record: any; readonly locators: readonly any[] }> {
  const { record } = await scenario.backend.registerSourceVersion({
    source_ref: sourceRef,
    source_version: version,
    content_digest: opaqueDigest(`${sourceRef}:${version}`),
    origin_object_ref: `objects/${sourceRef}/${version}.html`,
    parser_revision: "frozen-html-units-v1",
    unit_manifest: { units, parser_revision: "frozen-html-units-v1" },
    created_at: scenario.clock().toISOString(),
    retired_at: null,
    payload_collected_at: null,
    obligations_stopped_at: null,
  });
  const locatorBindings = Array.from({ length: units }, (_, index) => ({
    source_version_id: record.source_version_id,
    document_id: `${sourceRef}-document`,
    version: `frozen-${version}`,
    unit: index + 1,
  }));
  for (const binding of locatorBindings) scenario.backend.bindSourceLocator(binding);
  return { record, locators: locatorBindings };
}

async function declare(
  scenario: Scenario,
  scopeBinding: string,
  sourceRef: string,
  version: string,
  authorizedSourceRefs: readonly string[],
  extractionRevision: number,
  units: number = 1
): Promise<number> {
  const { record, locators } = await registerVersion(
    scenario,
    sourceRef,
    version,
    units
  );
  const declared = await scenario.publication.declareDesired({
    scopeBinding,
    authorizedSourceRefs,
    sourceRef,
    sourceVersion: record,
    locatorBindings: locators,
    desiredExtractionRevision: extractionRevision,
    configRevision: CONFIG_REVISION,
  });
  return declared.generation;
}

function publishedDependencies(
  sourceRef: string,
  generation: number,
  extractionRevision: number | null
): readonly MaintenanceDependency[] {
  return [
    {
      sourceRef,
      generation,
      extractionRevision,
      relationBuckets: [],
    },
  ];
}

async function claimOwnAttempt(
  scenario: Scenario,
  input: {
    readonly workKind: "extract_publish" | "projection_rebuild";
    readonly sourceRef: string;
    readonly generation: number;
    readonly sourceVersion: string;
    /**
     * The LIVE published extraction revision at schedule time. An extract attempt
     * is scheduled before its own publication lands, so its live revision is
     * still null; a rebuild attempt is scheduled against what is already
     * published, so it names that revision.
     */
    readonly extractionRevision: number | null;
  }
): Promise<MaintenanceAttemptGuard> {
  const dependencies = publishedDependencies(
    input.sourceRef,
    input.generation,
    input.extractionRevision
  );
  const deps = { store: scenario.work, clock: () => scenario.clock() };
  const scheduled = await scheduleWork(
    deps,
    { actorId: ACTOR },
    {
      workKind: input.workKind,
      sourceRef: input.sourceRef,
      sourceVersion: input.sourceVersion,
      sourceGeneration: input.generation,
      configRevision: CONFIG_REVISION,
      dependencies,
    }
  );
  if ("refused" in scheduled) {
    // EXIT: the fixture could not schedule the rebuild attempt a case needs. It
    // throws naming the refusal, so no case runs on an unscheduled job.
    throw new Error(`rebuild memory fixture schedule refused: ${scheduled.refused}`);
  }
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const claimed = await claimNextWork(deps);
    if (claimed.guard === null) break;
    if (claimed.guard.jobKey === scheduled.record.jobKey) return claimed.guard;
    // EXIT: the claim queue offered a foreign job first, which this lane cannot
    // release back to pending. The fixture throws instead of settling a foreign
    // job into a state the case did not arrange.
    throw new Error(
      `rebuild memory fixture claimed a foreign job first: ${claimed.guard.jobKey}`
    );
  }
  // EXIT: the durable-work queue drained without ever offering the job this
  // fixture scheduled, so no case would run against an attempt nobody claimed.
  throw new Error("rebuild memory fixture could not claim its own job");
}

function relationFacts(
  scenario: Scenario,
  sourceRef: string,
  extractionRef: string,
  version: string
): PublicationFact[] {
  const intervals = [
    { from: "2020-01-01T00:00:00.000Z", until: "2025-01-01T00:00:00.000Z" },
    { from: "2022-01-01T00:00:00.000Z", until: "2027-01-01T00:00:00.000Z" },
  ];
  return intervals.map((interval, index) => ({
    identity: {
      kind: "relation_assertion",
      input: {
        headEntityId: HEAD,
        relationNorm: RELATION,
        tailEntityId: TAILS[index]!,
        validWindow: { from: interval.from, until: interval.until },
      },
    },
    occurrence: {
      subject: "assertion",
      result_id: deriveRelationAssertionId(
        normalizeRelationAssertion({
          headEntityId: HEAD,
          relationNorm: RELATION,
          tailEntityId: TAILS[index]!,
          validWindow: { from: interval.from, until: interval.until },
        })
      ),
      source_ref: sourceRef,
      source_version: version,
      location: {
        document_id: `${sourceRef}-document`,
        version: `frozen-${version}`,
        unit: index + 1,
      },
      extraction_ref: extractionRef,
      extractedAt: scenario.clock().toISOString(),
    },
  })) as unknown as PublicationFact[];
}

async function publishVersion(
  scenario: Scenario,
  scopeBinding: string,
  sourceRef: string,
  version: string,
  generation: number,
  extractionRevision: number,
  accepted: readonly PublicationFact[]
): Promise<void> {
  // The extract attempt is scheduled against the LIVE published revision at
  // schedule time: null for a first publication, and the previous revision when
  // the same version is re-extracted.
  const snapshot = await scenario.publication.readSnapshot({
    scopeBinding,
  });
  const liveRevision =
    snapshot.sources.find((source) => source.sourceRef === sourceRef)?.published
      ?.extractionRevision ?? null;
  const guard = await claimOwnAttempt(scenario, {
    workKind: "extract_publish",
    sourceRef,
    generation,
    sourceVersion: version,
    extractionRevision: liveRevision,
  });
  await scenario.publication.stageAttempt({
    scopeBinding,
    sourceRef,
    guard,
    extractionRef: `${sourceRef}-extraction-${version}-${extractionRevision}`,
    accepted,
  });
  await scenario.publication.publish({
    scopeBinding,
    sourceRef,
    guard,
    at: scenario.clock().toISOString(),
  });
  // The publication switch finished the attempt's writes; the ledger row is
  // settled here so the same job key can be scheduled again for a re-extraction.
  const settledOutcome = await settleWork(
    { store: scenario.work, clock: () => scenario.clock() },
    guard,
    { status: "ready" },
    {
      configRevision: CONFIG_REVISION,
      dependencies: publishedDependencies(
        sourceRef,
        generation,
        liveRevision
      ),
    }
  );
  if ("refused" in settledOutcome && settledOutcome.refused !== undefined) {
    // EXIT: settling the publication attempt was refused, so the ledger state a
    // later claim depends on is not what this fixture arranged.
    throw new Error(`rebuild memory fixture publish settle refused: ${settledOutcome.refused}`);
  }
}

async function newScope(
  label: string
): Promise<ProjectionRebuildScope> {
  const scenario = createScenario();
  const scopeBinding = unique(`rebuild-memory-${label}`);
  const sourceRef = unique(`rebuild-memory-src-${label}`);
  scenarios.set(scopeBinding, scenario);
  scenario.backend.setScopeRevisions(scopeBinding, {
    authorizationRevision: AUTHORIZATION_REVISION,
    purgeRevision: PURGE_REVISION,
  });
  const generation = await declare(
    scenario,
    scopeBinding,
    sourceRef,
    "v1",
    [sourceRef],
    1,
    2
  );
  await publishVersion(
    scenario,
    scopeBinding,
    sourceRef,
    "v1",
    generation,
    1,
    relationFacts(scenario, sourceRef, `${sourceRef}-extraction-v1-1`, "v1")
  );
  return {
    context: contextFor(scenario, scopeBinding, [sourceRef]),
    scopeBinding,
    sourceRef,
    generation,
    dependencies: publishedDependencies(sourceRef, generation, 1),
  };
}

describeProjectionRebuildContract(async () => ({
  label: "memory",

  async seedPublishedSource(label: string) {
    return newScope(label);
  },

  async seedUnpublishedDependency(label: string) {
    const scenario = createScenario();
    const scopeBinding = unique(`rebuild-memory-${label}`);
    const sourceRef = unique(`rebuild-memory-src-${label}`);
    scenarios.set(scopeBinding, scenario);
    scenario.backend.setScopeRevisions(scopeBinding, {
      authorizationRevision: AUTHORIZATION_REVISION,
      purgeRevision: PURGE_REVISION,
    });
    // Declared and authorized but NEVER published: the dependency resolves to an
    // active source whose accepted extraction does not exist yet.
    const generation = await declare(
      scenario,
      scopeBinding,
      sourceRef,
      "v1",
      [sourceRef],
      1,
      2
    );
    return {
      context: contextFor(scenario, scopeBinding, [sourceRef]),
      scopeBinding,
      sourceRef,
      generation,
      dependencies: publishedDependencies(sourceRef, generation, null),
    };
  },

  async moveSourceDesired(scope: ProjectionRebuildScope) {
    const scenario = scenarioFor(scope.scopeBinding);
    const generation = await declare(
      scenario,
      scope.scopeBinding,
      scope.sourceRef,
      "v2",
      [scope.sourceRef],
      2,
      2
    );
    return {
      ...scope,
      context: contextFor(scenario, scope.scopeBinding, [scope.sourceRef]),
      generation,
      dependencies: publishedDependencies(scope.sourceRef, generation, 2),
    };
  },

  async withdrawPublishedSource(scope: ProjectionRebuildScope) {
    const scenario = scenarioFor(scope.scopeBinding);
    await scenario.publication.withdraw({
      scopeBinding: scope.scopeBinding,
      sourceRef: scope.sourceRef,
      expectedGeneration: scope.generation,
      at: scenario.clock().toISOString(),
    });
  },

  desynchronizedGuard(
    scope: ProjectionRebuildScope,
    guard: MaintenanceAttemptGuard
  ) {
    // A well-formed digest that is simply not the one the ledger issued. No
    // production row is touched: this is the guard a hostile or buggy caller
    // would present.
    return {
      ...guard,
      inputRevision: createHash("sha256")
        .update(`desynchronized:${scope.sourceRef}`, "utf8")
        .digest("hex"),
    };
  },

  async republishWithNewExtraction(scope: ProjectionRebuildScope) {
    const scenario = scenarioFor(scope.scopeBinding);
    // An explicit re-extraction: the SAME source version republished under a new
    // extraction revision. Declaring it advances the generation, which is
    // exactly the stable-history movement a rebuild must not produce.
    const generation = await declare(
      scenario,
      scope.scopeBinding,
      scope.sourceRef,
      "v1",
      [scope.sourceRef],
      2,
      2
    );
    await publishVersion(
      scenario,
      scope.scopeBinding,
      scope.sourceRef,
      "v1",
      generation,
      2,
      relationFacts(scenario, scope.sourceRef, `${scope.sourceRef}-extraction-v1-2`, "v1")
    );
    return {
      ...scope,
      context: contextFor(scenario, scope.scopeBinding, [scope.sourceRef]),
      generation,
      dependencies: publishedDependencies(scope.sourceRef, generation, 2),
    };
  },

  async claimRebuildAttempt(scope: ProjectionRebuildScope) {
    const scenario = scenarioFor(scope.scopeBinding);
    // A real worker settles its attempt before another can claim the job, so a
    // second attempt in one scope is only reachable by settling the first.
    for (const prior of settled.get(scope.scopeBinding) ?? []) {
      const settledOutcome = await settleWork(
        { store: scenario.work, clock: () => scenario.clock() },
        prior.guard,
        { status: "ready" },
        {
          configRevision: CONFIG_REVISION,
          dependencies: prior.dependencies,
        }
      );
      if ("refused" in settledOutcome && settledOutcome.refused !== undefined) {
        // EXIT: settling a prior rebuild attempt was refused, so the queue state
        // the next claim depends on is not what the fixture arranged.
        throw new Error(
          `rebuild memory fixture settle refused: ${settledOutcome.refused}`
        );
      }
    }
    settled.delete(scope.scopeBinding);
    const guard = await claimOwnAttempt(scenario, {
      workKind: "projection_rebuild",
      sourceRef: scope.sourceRef,
      generation: scope.generation,
      sourceVersion: "v1",
      extractionRevision: scope.dependencies[0]!.extractionRevision,
    });
    const pending = settled.get(scope.scopeBinding) ?? [];
    pending.push({ guard, dependencies: scope.dependencies });
    settled.set(scope.scopeBinding, pending);
    return guard;
  },

  async rebuild(scope: ProjectionRebuildScope, guard: MaintenanceAttemptGuard) {
    const scenario = scenarioFor(scope.scopeBinding);
    return scenario.rebuild.rebuildProjections({
      context: scope.context,
      guard,
      at: scenario.clock().toISOString(),
    });
  },

  async observeDerived(scope: ProjectionRebuildScope) {
    const scenario = scenarioFor(scope.scopeBinding);
    let observed;
    try {
      observed = await scenario.rebuild.readProjectionGeneration(
        scope.context,
        [scope.sourceRef]
      );
    } catch (error: unknown) {
      if (
        (error as { code?: unknown }).code ===
        "maintenance_status_unavailable"
      ) {
        // No generation has ever been recorded for this scope. That is an
        // observation, not a failure: a scope where every rebuild was refused
        // has none, and the residue case must be able to see that.
        return null;
      }
      // EXIT: the generation read failed for a reason other than "none
      // recorded", which would be a real fault rather than an absent row.
      throw error;
    }
    return {
      subjects: observed.subjects.map(
        (subject) => `${subject.kind}:${subject.id}`
      ),
      dependencyRevision: observed.dependencyRevision,
      dependencies: observed.dependencies,
      publicationRevision: observed.publicationRevision,
      // Read the outbox's OWN queue rather than recomputing the subject set, so
      // this observation is independent of the code that produced the intents.
      pendingIntents: pendingIntents(scenario),
    } satisfies DerivedProjectionObservation;
  },

  async fingerprint(scope: ProjectionRebuildScope) {
    const scenario = scenarioFor(scope.scopeBinding);
    const accepted = await scenario.authority.withAuthorizedScope(
      scope.context,
      async (work) => work.readAcceptedInputs([scope.sourceRef]),
      { additionalSourceRefs: [scope.sourceRef] }
    );
    const snapshot = await scenario.publication.readSnapshot({
      scopeBinding: scope.scopeBinding,
    });
    const source = accepted.sources[0]!;
    const supportIds = [
      ...new Set(accepted.memberships.flatMap((m) => m.supportIds)),
    ].sort();
    return {
      sourceVersionIds: source.sourceVersion === null ? [] : [source.sourceVersion],
      sourceVersionNames:
        source.sourceVersion === null ? [] : [source.sourceVersion],
      sourceGenerations: accepted.sources.map((entry) => entry.generation),
      identityIds: [HEAD, ...TAILS],
      assertionIds: [
        ...new Set(accepted.memberships.map((m) => m.resultId)),
      ].sort(),
      supportIds,
      // Every extraction ref the current membership still attributes, not just
      // the latest binding: a rebuild that dropped an extraction would show up
      // here, and so would one that invented one.
      extractionIds: [
        ...new Set(
          accepted.memberships.flatMap((membership) => membership.extractionRefs)
        ),
      ].sort(),
      extractionRevisions: snapshot.sources.flatMap((entry) =>
        entry.published === null ? [] : [entry.published.extractionRevision]
      ),
      membershipSupportIds: supportIds,
    } satisfies StableHistoryFingerprint;
  },

  async liveGeneration(scope: ProjectionRebuildScope) {
    const scenario = scenarioFor(scope.scopeBinding);
    const snapshot = await scenario.publication.readSnapshot({
      scopeBinding: scope.scopeBinding,
    });
    return (
      snapshot.sources.find((source) => source.sourceRef === scope.sourceRef)
        ?.generation ?? null
    );
  },
}));

/**
 * The memory outbox's own pending queue.
 *
 * When composition injected a failing double instead of the default outbox, the
 * queue is not readable, so the helper names that instead of reporting an empty
 * queue a case would misread as "the rebuild emitted nothing".
 */
function pendingIntents(scenario: Scenario): readonly string[] {
  const outbox = scenario.backend.publicationOutbox;
  if (
    typeof (outbox as { pendingIntents?: unknown }).pendingIntents !== "function"
  ) {
    // EXIT: composition injected an outbox double with no readable queue, so no
    // case could observe the intents a rebuild produced.
    throw new Error("rebuild memory lane outbox exposes no pending queue");
  }
  return (
    outbox as unknown as { pendingIntents(): readonly string[] }
  ).pendingIntents();
}

describe("MP11 memory rebuild fences", () => {
  it("refuses a rebuild whose attempt never claimed the job", async () => {
    const scope = await newScope("unclaimed-attempt");
    const scenario = scenarioFor(scope.scopeBinding);
    const guard = await claimOwnAttempt(scenario, {
      workKind: "projection_rebuild",
      sourceRef: scope.sourceRef,
      generation: scope.generation,
      sourceVersion: "v1",
      extractionRevision: 1,
    });
    // A second claim cannot happen — the job is running — so the fixture mints
    // a guard with a token the ledger never issued.
    let code: string | undefined;
    try {
      await scenario.rebuild.rebuildProjections({
        context: scope.context,
        guard: { ...guard, fencingToken: "00000000-0000-0000-0000-0000000000ff" },
        at: scenario.clock().toISOString(),
      });
    } catch (error: unknown) {
      code = (error as { code?: unknown }).code as string | undefined;
    }
    expect(code, "a forged fencing token was accepted").toBe("lease_lost");
  });

  it("refuses a rebuild that names a scope the attempt was not authorized for", async () => {
    const scope = await newScope("unauthorized-scope");
    const scenario = scenarioFor(scope.scopeBinding);
    const guard = await claimOwnAttempt(scenario, {
      workKind: "projection_rebuild",
      sourceRef: scope.sourceRef,
      generation: scope.generation,
      sourceVersion: "v1",
      extractionRevision: 1,
    });
    const foreign = contextFor(scenario, scope.scopeBinding, [
      `${scope.sourceRef}-not-authorized`,
    ]);
    let code: string | undefined;
    let detail = "";
    try {
      await scenario.rebuild.rebuildProjections({
        context: foreign,
        guard,
        at: scenario.clock().toISOString(),
      });
    } catch (error: unknown) {
      code = (error as { code?: unknown }).code as string | undefined;
      detail = error instanceof Error ? error.message : String(error);
    }
    // The shared seam refuses a context naming a source outside its own trusted
    // set as `access_denied`. The point of the case is that the verdict survives
    // the publication error mapping instead of degrading to `backend_unavailable`.
    expect(
      code,
      `a rebuild outside the attempt's authorized source set was accepted; detail: ${detail}`
    ).toBe("access_denied");
  });
});