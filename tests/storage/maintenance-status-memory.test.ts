/**
 * The memory lane of the same-snapshot M-STATUS contract.
 *
 * It drives the real MemoryBackend: the real shared scope authority, the real
 * durable-work ledger and the real publication adapter. Every component of every
 * status is read inside one authorized unit of work, so a status can never mix
 * a pre-write source row with a post-write ledger row.
 *
 * Each scenario builds its own backend. The durable-work ledger is one shared
 * queue whose claims cannot be released, so a job a scenario deliberately leaves
 * `pending` would otherwise be claimed by the next scenario and every later
 * bucket would describe the wrong source.
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
  MaintenanceWorkKind,
  MaintenanceWorkStore,
} from "../../src/core/maintenance/types.js";
import type {
  PublicationFact,
  StructuredPublicationStorage,
} from "../../src/core/maintenance/publication-types.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { MemoryMaintenanceStatusStorage } from "../../src/core/storage/structured-status-reads.js";
import { MemoryStructuredScopeUnitOfWork } from "../../src/core/storage/structured-scope-uow.js";
import type { AuthorizedScopeContext } from "../../src/core/storage/structured-scope-types.js";
import { createPublicationTestClock } from "./publication-contract.js";
import {
  describeMaintenanceStatusContract,
  type MaintenanceStatusScope,
  type MaintenanceStatusTestPort,
} from "./maintenance-status-contract.js";

const DIMENSIONS = 8;
const ACTOR = "status-memory-trusted-owner";
const AUTHORIZATION_REVISION = "auth-status-memory-1";
const CONFIG_REVISION = "extractor-v1";
const PURGE_REVISION = "purge-1";
const RELATION = "has_chair";

/** One isolated lane per scenario: its own ledger, publication store and clock. */
interface Scenario {
  readonly backend: MemoryBackend;
  readonly clock: ReturnType<typeof createPublicationTestClock>;
  readonly work: MaintenanceWorkStore;
  readonly publication: StructuredPublicationStorage;
  readonly authority: MemoryStructuredScopeUnitOfWork;
  readonly status: MemoryMaintenanceStatusStorage;
  readonly deps: {
    readonly store: MaintenanceWorkStore;
    readonly clock: () => Date;
  };
}

const scenarios = new Map<string, Scenario>();

function scenarioFor(scopeBinding: string): Scenario {
  const held = scenarios.get(scopeBinding);
  if (held === undefined) {
    // EXIT: a case drives a scope this lane never built. The fixture throws
    // rather than falling back to a shared backend, which would let one case's
    // ledger entries be claimed by the next.
    throw new Error(`status memory lane has no scenario for ${scopeBinding}`);
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
    authority,
    status: new MemoryMaintenanceStatusStorage(authority),
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
  authorizedSourceRefs: readonly string[]
): AuthorizedScopeContext {
  return scenario.authority.createAuthorizedContext({
    actorId: ACTOR,
    ownerScopeBinding: scopeBinding,
    readerBinding: scopeBinding,
    authorizedSourceRefs,
    authorizationRevision: AUTHORIZATION_REVISION,
    deadlineAt: new Date(scenario.clock().getTime() + 60_000).toISOString(),
  });
}

async function registerVersion(
  scenario: Scenario,
  sourceRef: string,
  version: string
): Promise<{ readonly record: any; readonly locators: readonly any[] }> {
  const { record } = await scenario.backend.registerSourceVersion({
    source_ref: sourceRef,
    source_version: version,
    content_digest: opaqueDigest(`${sourceRef}:${version}`),
    origin_object_ref: `objects/${sourceRef}/${version}.html`,
    parser_revision: "frozen-html-units-v1",
    unit_manifest: { units: 1, parser_revision: "frozen-html-units-v1" },
    created_at: scenario.clock().toISOString(),
    retired_at: null,
    payload_collected_at: null,
    obligations_stopped_at: null,
  });
  const locatorBindings = [
    {
      source_version_id: record.source_version_id,
      document_id: `${sourceRef}-document`,
      version: `frozen-${version}`,
      unit: 1,
    },
  ];
  for (const binding of locatorBindings) {
    await scenario.backend.bindSourceLocator(binding);
  }
  return { record, locators: locatorBindings };
}

/**
 * Declare one desired input.
 *
 * The authorized set travels with the call because a declaration deactivates
 * every active source the set does not name, so declaring a second source in the
 * same scope would otherwise withdraw the first.
 */
async function declare(
  scenario: Scenario,
  scopeBinding: string,
  sourceRef: string,
  version: string,
  authorizedSourceRefs: readonly string[]
): Promise<number> {
  const { record, locators } = await registerVersion(scenario, sourceRef, version);
  const declared = await scenario.publication.declareDesired({
    scopeBinding,
    authorizedSourceRefs,
    sourceRef,
    sourceVersion: record,
    locatorBindings: locators,
    desiredExtractionRevision: 1,
    configRevision: CONFIG_REVISION,
  });
  return declared.generation;
}

async function newScope(
  label: string,
  sourceRefs: readonly string[]
): Promise<{
  readonly scope: MaintenanceStatusScope;
  readonly scenario: Scenario;
  readonly generations: Map<string, number>;
}> {
  const scenario = createScenario();
  const scopeBinding = unique(`status-scope-${label}`);
  await scenario.backend.setScopeRevisions(scopeBinding, {
    authorizationRevision: AUTHORIZATION_REVISION,
    purgeRevision: PURGE_REVISION,
  });
  scenarios.set(scopeBinding, scenario);
  const generations = new Map<string, number>();
  for (const sourceRef of sourceRefs) {
    generations.set(
      sourceRef,
      await declare(scenario, scopeBinding, sourceRef, "v1", sourceRefs)
    );
  }
  return {
    scope: {
      scopeBinding,
      authorizedSourceRefs: sourceRefs,
      context: contextFor(scenario, scopeBinding, sourceRefs),
    },
    scenario,
    generations,
  };
}

function extractDependencies(
  sourceRef: string,
  generation: number
): readonly MaintenanceDependency[] {
  return [
    { sourceRef, generation, extractionRevision: null, relationBuckets: [] },
  ];
}

function checkDependencies(
  sourceRef: string,
  generation: number
): readonly MaintenanceDependency[] {
  return [
    {
      sourceRef,
      generation,
      extractionRevision: 1,
      relationBuckets: [RELATION],
    },
  ];
}

/**
 * Schedule one attempt and claim it.
 *
 * The claim queue is first-pending-first and offers no release, so a foreign job
 * claimed on the way cannot be put back. Every fixture therefore claims its own
 * job immediately after scheduling it, and the one job that must stay `pending`
 * is scheduled last, which keeps every earlier job out of the queue.
 */
async function claimOwnAttempt(
  scenario: Scenario,
  input: {
    readonly workKind: MaintenanceWorkKind;
    readonly sourceRef: string;
    readonly sourceVersion?: string;
    readonly generation: number;
    readonly dependencies: readonly MaintenanceDependency[];
  }
): Promise<MaintenanceAttemptGuard> {
  const scheduled = await scheduleWork(
    scenario.deps,
    { actorId: ACTOR },
    {
      workKind: input.workKind,
      sourceRef: input.sourceRef,
      sourceVersion: input.sourceVersion ?? "v1",
      sourceGeneration: input.generation,
      configRevision: CONFIG_REVISION,
      dependencies: input.dependencies,
    }
  );
  if ("refused" in scheduled) {
    // EXIT: the fixture could not schedule the attempt a case needs. It throws
    // naming the refusal, so a case never runs on an unscheduled job and reads
    // its absence from the ledger as a pending bucket it did not arrange.
    throw new Error(
      `status memory fixture schedule refused: ${scheduled.refused}`
    );
  }
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const claimed = await claimNextWork(scenario.deps);
    if (claimed.guard === null) break;
    if (claimed.guard.jobKey === scheduled.record.jobKey) return claimed.guard;
    // EXIT: the claim queue offered a foreign job, which this lane cannot
    // release back to pending. The fixture throws rather than settling the
    // foreign job into a state the case did not arrange.
    throw new Error(
      `status memory fixture claimed a foreign job first: ${claimed.guard.jobKey} instead of ${scheduled.record.jobKey}`
    );
  }
  // EXIT: the queue drained without ever offering the scheduled job. The fixture
  // throws, so no case proceeds on a job that was never claimed.
  throw new Error("status memory fixture could not claim its own job");
}

async function settle(
  scenario: Scenario,
  guard: MaintenanceAttemptGuard,
  outcome: "ready" | "failed",
  dependencies: readonly MaintenanceDependency[]
): Promise<void> {
  const settled = await settleWork(
    scenario.deps,
    guard,
    outcome === "ready"
      ? { status: "ready" }
      : { status: "failed", failureCode: "input_stale" },
    { configRevision: CONFIG_REVISION, dependencies }
  );
  if ("refused" in settled && settled.refused !== undefined) {
    // EXIT: settling a fixture attempt was refused. The fixture throws, so the
    // case cannot proceed believing the ledger holds an outcome it does not.
    throw new Error(`status memory fixture settle refused: ${settled.refused}`);
  }
}

async function publishVersion(
  scenario: Scenario,
  input: {
    readonly scopeBinding: string;
    readonly sourceRef: string;
    readonly sourceVersion?: string;
    readonly generation: number;
    readonly accepted: readonly PublicationFact[];
    /**
     * The dependency vector to schedule with. A source that already holds a
     * published version is republished against that live extraction revision,
     * because the publication fence compares the scheduled vector against the
     * live one.
     */
    readonly dependencies?: readonly MaintenanceDependency[];
    readonly extractionRef?: string;
  }
): Promise<MaintenanceAttemptGuard> {
  const guard = await claimOwnAttempt(scenario, {
    workKind: "extract_publish",
    sourceRef: input.sourceRef,
    sourceVersion: input.sourceVersion,
    generation: input.generation,
    dependencies:
      input.dependencies ??
      extractDependencies(input.sourceRef, input.generation),
  });
  await scenario.publication.stageAttempt({
    scopeBinding: input.scopeBinding,
    sourceRef: input.sourceRef,
    guard,
    extractionRef: input.extractionRef ?? `${input.sourceRef}-extraction`,
    accepted: input.accepted,
  });
  await scenario.publication.publish({
    scopeBinding: input.scopeBinding,
    sourceRef: input.sourceRef,
    guard,
    at: scenario.clock().toISOString(),
  });
  await settle(
    scenario,
    guard,
    "ready",
    input.dependencies ?? extractDependencies(input.sourceRef, input.generation)
  );
  return guard;
}

async function seedFullMatrix(
  label: string
): Promise<MaintenanceStatusScope> {
  const notReady = {
    running: unique("status-desired-running"),
    failed: unique("status-desired-failed"),
    stale: unique("status-desired-stale"),
    pending: unique("status-desired-pending"),
  };
  const conflict = {
    running: unique("status-conflict-running"),
    ready: unique("status-conflict-ready"),
    failed: unique("status-conflict-failed"),
    stale: unique("status-conflict-stale"),
  };
  const superseded = unique("status-desired-superseded");
  const refs = [...Object.values(notReady), superseded, ...Object.values(conflict)];
  const { scope, scenario, generations } = await newScope(label, refs);
  const generationOf = (sourceRef: string): number => generations.get(sourceRef)!;

  // desired_index = running: claimed and never settled.
  await claimOwnAttempt(scenario, {
    workKind: "extract_publish",
    sourceRef: notReady.running,
    generation: generationOf(notReady.running),
    dependencies: extractDependencies(
      notReady.running,
      generationOf(notReady.running)
    ),
  });
  // desired_index = failed: claimed, then settled failed.
  const failedGuard = await claimOwnAttempt(scenario, {
    workKind: "extract_publish",
    sourceRef: notReady.failed,
    generation: generationOf(notReady.failed),
    dependencies: extractDependencies(
      notReady.failed,
      generationOf(notReady.failed)
    ),
  });
  await settle(
    scenario,
    failedGuard,
    "failed",
    extractDependencies(notReady.failed, generationOf(notReady.failed))
  );
  // desired_index = stale: v1 published and settled ready, then v2 declared with
  // nothing scheduled, so the ready v1 record no longer describes v2.
  await publishVersion(scenario, {
    scopeBinding: scope.scopeBinding,
    sourceRef: notReady.stale,
    generation: generationOf(notReady.stale),
    accepted: [],
  });
  generations.set(
    notReady.stale,
    await declare(scenario, scope.scopeBinding, notReady.stale, "v2", refs)
  );
  // A second source with an old settled-ready record and a CURRENT running
  // attempt: the older record must not answer for the current desired pair.
  await publishVersion(scenario, {
    scopeBinding: scope.scopeBinding,
    sourceRef: superseded,
    generation: generationOf(superseded),
    accepted: [],
  });
  const supersededMoved = await declare(
    scenario,
    scope.scopeBinding,
    superseded,
    "v2",
    refs
  );
  generations.set(superseded, supersededMoved);
  await claimOwnAttempt(scenario, {
    workKind: "extract_publish",
    sourceRef: superseded,
    sourceVersion: "v2",
    generation: supersededMoved,
    dependencies: [
      {
        sourceRef: superseded,
        generation: supersededMoved,
        extractionRevision: 1,
        relationBuckets: [],
      },
    ],
  });
  // conflict_checks = running: a check claimed against the published pair.
  await publishVersion(scenario, {
    scopeBinding: scope.scopeBinding,
    sourceRef: conflict.running,
    generation: generationOf(conflict.running),
    accepted: [],
  });
  await claimOwnAttempt(scenario, {
    workKind: "conflict_check",
    sourceRef: conflict.running,
    generation: generationOf(conflict.running),
    dependencies: checkDependencies(
      conflict.running,
      generationOf(conflict.running)
    ),
  });
  // conflict_checks = ready: a check settled ready against the published pair.
  await publishVersion(scenario, {
    scopeBinding: scope.scopeBinding,
    sourceRef: conflict.ready,
    generation: generationOf(conflict.ready),
    accepted: [],
  });
  const readyCheck = await claimOwnAttempt(scenario, {
    workKind: "conflict_check",
    sourceRef: conflict.ready,
    generation: generationOf(conflict.ready),
    dependencies: checkDependencies(
      conflict.ready,
      generationOf(conflict.ready)
    ),
  });
  await settle(
    scenario,
    readyCheck,
    "ready",
    checkDependencies(conflict.ready, generationOf(conflict.ready))
  );
  // conflict_checks = failed: a check settled failed against the published pair.
  await publishVersion(scenario, {
    scopeBinding: scope.scopeBinding,
    sourceRef: conflict.failed,
    generation: generationOf(conflict.failed),
    accepted: [],
  });
  const failedCheck = await claimOwnAttempt(scenario, {
    workKind: "conflict_check",
    sourceRef: conflict.failed,
    generation: generationOf(conflict.failed),
    dependencies: checkDependencies(
      conflict.failed,
      generationOf(conflict.failed)
    ),
  });
  await settle(
    scenario,
    failedCheck,
    "failed",
    checkDependencies(conflict.failed, generationOf(conflict.failed))
  );
  // conflict_checks = stale: a check claimed against v1, then v2 published so
  // the v1 check no longer targets the current published pair.
  await publishVersion(scenario, {
    scopeBinding: scope.scopeBinding,
    sourceRef: conflict.stale,
    generation: generationOf(conflict.stale),
    accepted: [],
  });
  await claimOwnAttempt(scenario, {
    workKind: "conflict_check",
    sourceRef: conflict.stale,
    generation: generationOf(conflict.stale),
    dependencies: checkDependencies(
      conflict.stale,
      generationOf(conflict.stale)
    ),
  });
  const moved = await declare(
    scenario,
    scope.scopeBinding,
    conflict.stale,
    "v2",
    refs
  );
  generations.set(conflict.stale, moved);
  await publishVersion(scenario, {
    scopeBinding: scope.scopeBinding,
    sourceRef: conflict.stale,
    sourceVersion: "v2",
    generation: moved,
    dependencies: [
      {
        sourceRef: conflict.stale,
        generation: moved,
        extractionRevision: 1,
        relationBuckets: [],
      },
    ],
    accepted: [],
    extractionRef: `${conflict.stale}-extraction-v2`,
  });

  // desired_index = pending: the one job left in the queue, scheduled last so no
  // other claim can reach it.
  await scheduleWork(
    scenario.deps,
    { actorId: ACTOR },
    {
      workKind: "extract_publish",
      sourceRef: notReady.pending,
      sourceVersion: "v1",
      sourceGeneration: generationOf(notReady.pending),
      configRevision: CONFIG_REVISION,
      dependencies: extractDependencies(
        notReady.pending,
        generationOf(notReady.pending)
      ),
    }
  );

  return {
    ...scope,
    authorizedSourceRefs: refs,
    context: contextFor(scenario, scope.scopeBinding, refs),
  };
}

async function seedZeroHitAndUnpublished(
  label: string
): Promise<MaintenanceStatusScope> {
  const zeroHit = unique("status-zero-hit");
  const unpublished = unique("status-unpublished");
  const refs = [zeroHit, unpublished];
  const { scope, scenario, generations } = await newScope(label, refs);
  await publishVersion(scenario, {
    scopeBinding: scope.scopeBinding,
    sourceRef: zeroHit,
    generation: generations.get(zeroHit)!,
    accepted: [],
  });
  return scope;
}

async function seedHiddenSource(
  label: string
): Promise<{ readonly scope: MaintenanceStatusScope; readonly hidden: string }> {
  const visible = unique("status-visible");
  const hidden = unique("status-hidden");
  const { scope, scenario, generations } = await newScope(label, [visible]);
  await publishVersion(scenario, {
    scopeBinding: scope.scopeBinding,
    sourceRef: visible,
    generation: generations.get(visible)!,
    accepted: [],
  });
  const hiddenGeneration = await declare(
    scenario,
    scope.scopeBinding,
    hidden,
    "v1",
    [visible, hidden]
  );
  await publishVersion(scenario, {
    scopeBinding: scope.scopeBinding,
    sourceRef: hidden,
    generation: hiddenGeneration,
    accepted: [],
  });
  return { scope, hidden };
}

async function seedPendingOverOldReady(
  label: string
): Promise<MaintenanceStatusScope> {
  const sourceRef = unique("status-old-ready");
  const { scope, scenario, generations } = await newScope(label, [sourceRef]);
  const generation = generations.get(sourceRef)!;
  await publishVersion(scenario, {
    scopeBinding: scope.scopeBinding,
    sourceRef,
    generation,
    accepted: [],
  });
  const checkGuard = await claimOwnAttempt(scenario, {
    workKind: "conflict_check",
    sourceRef,
    generation,
    dependencies: checkDependencies(sourceRef, generation),
  });
  await settle(
    scenario,
    checkGuard,
    "ready",
    checkDependencies(sourceRef, generation)
  );
  await declare(scenario, scope.scopeBinding, sourceRef, "v2", [
    sourceRef,
  ]);
  return scope;
}

async function seedMissingRequiredState(
  label: string
): Promise<MaintenanceStatusScope> {
  const sourceRef = unique("status-missing");
  const { scope, scenario, generations } = await newScope(label, [sourceRef]);
  await publishVersion(scenario, {
    scopeBinding: scope.scopeBinding,
    sourceRef,
    generation: generations.get(sourceRef)!,
    accepted: [],
  });
  const scopes = (
    scenario.backend.structuredPublication as unknown as {
      readonly scopes: Map<
        string,
        { readonly sources: Map<string, { desired: unknown }> }
      >;
    }
  ).scopes;
  const held = scopes.get(scope.scopeBinding)?.sources.get(sourceRef);
  if (held === undefined) {
    // EXIT: the memory publication store did not hold the seeded source row this
    // lane erases the desired input from. The fixture throws, so the
    // missing-state case cannot run against a row that was never changed and
    // pass for the wrong reason.
    throw new Error(
      "memory publication store does not hold the seeded source row"
    );
  }
  held.desired = null;
  return scope;
}

async function seedUnlandedPublication(
  label: string
): Promise<MaintenanceStatusScope> {
  const sourceRef = unique("status-unlanded");
  const { scope, scenario, generations } = await newScope(label, [sourceRef]);
  const generation = generations.get(sourceRef)!;
  await publishVersion(scenario, {
    scopeBinding: scope.scopeBinding,
    sourceRef,
    generation,
    accepted: [],
  });
  // The current desired pair is a second version whose extract attempt settled
  // ready without the publication switch ever running. The source still holds
  // the older usable publication, so readiness has to be judged against the
  // current desired pair rather than against anything published at all.
  const moved = await declare(
    scenario,
    scope.scopeBinding,
    sourceRef,
    "v2",
    [sourceRef]
  );
  const dependencies = [
    {
      sourceRef,
      generation: moved,
      extractionRevision: 1,
      relationBuckets: [],
    },
  ];
  const guard = await claimOwnAttempt(scenario, {
    workKind: "extract_publish",
    sourceRef,
    sourceVersion: "v2",
    generation: moved,
    dependencies,
  });
  await scenario.publication.stageAttempt({
    scopeBinding: scope.scopeBinding,
    sourceRef,
    guard,
    extractionRef: `${sourceRef}-extraction-v2`,
    accepted: [],
  });
  await settle(scenario, guard, "ready", dependencies);
  return scope;
}

async function seedMovedAuthorization(
  label: string
): Promise<MaintenanceStatusScope> {
  const sourceRef = unique("status-moved-auth");
  const { scope, scenario, generations } = await newScope(label, [sourceRef]);
  await publishVersion(scenario, {
    scopeBinding: scope.scopeBinding,
    sourceRef,
    generation: generations.get(sourceRef)!,
    accepted: [],
  });
  await scenario.backend.setScopeRevisions(scope.scopeBinding, {
    authorizationRevision: `${AUTHORIZATION_REVISION}-moved`,
    purgeRevision: PURGE_REVISION,
  });
  return scope;
}

const port: MaintenanceStatusTestPort = {
  label: "memory",
  seedFullMatrix,
  seedZeroHitAndUnpublished,
  seedHiddenSource,
  seedPendingOverOldReady,
  seedMissingRequiredState,
  seedUnlandedPublication,
  seedMovedAuthorization,
  async readStatus(scope) {
    return scenarioFor(scope.scopeBinding).status.readMaintenanceStatus(
      scope.context,
      scope.authorizedSourceRefs
    );
  },
  async advanceProgressOnly(scope) {
    const scenario = scenarioFor(scope.scopeBinding);
    await scenario.authority.withAuthorizedScope(
      scope.context,
      async (view) => {
        view.bumpRevisions({ read: false, maintenance: true });
      },
      { additionalSourceRefs: [] }
    );
  },
  async advanceVisibility(scope) {
    const scenario = scenarioFor(scope.scopeBinding);
    await scenario.authority.withAuthorizedScope(
      scope.context,
      async (view) => {
        view.bumpRevisions({ read: true, maintenance: false });
      },
      { additionalSourceRefs: [] }
    );
  },
};

describeMaintenanceStatusContract(async () => port);

describe("memory status reporting contract", () => {
  it("reports every bucket name for a scope that fills all ten", async () => {
    const scope = await seedFullMatrix("memory-single-read");
    const observed = await port.readStatus(scope);
    expect(observed.sourcesInScope).toBe(9);
    expect(Object.keys(observed.desiredIndex).sort()).toEqual([
      "failed",
      "pending",
      "ready",
      "running",
      "stale",
    ]);
    expect(Object.keys(observed.conflictChecks).sort()).toEqual([
      "failed",
      "pending",
      "ready",
      "running",
      "stale",
    ]);
  });
});