/**
 * The memory twin lane for structured Query reads.
 *
 * This asserts the SAME cases as `tests/acceptance/structured-query-pg.test.ts`
 * against the SAME `assembleRead` the strict lane runs. It is not a look-alike of
 * the contract: if grouping, display selection, filtering, ordering or pagination
 * were wrong in a way the memory stores can express, this file fails too.
 *
 * It is a twin, not a substitute. The strict lane is the one that proves the SQL
 * keyset, the `REPEATABLE READ READ ONLY` snapshot and the column encodings.
 *
 * Every case drives the REAL stores: the real shared scope authority, the real
 * publication adapter, the real identity registry and the real immutable support
 * store. Nothing here stubs a membership or a tuple.
 */
import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  claimNextWork,
  scheduleWork,
  settleWork,
} from "../../src/core/maintenance/service.js";
import type { PublicationFact } from "../../src/core/maintenance/publication-types.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { buildStructuredQueryReader } from "../../src/index.js";
import {
  MemoryStructuredQueryStorage,
  STRUCTURED_QUERY_SUPPORT_ROLE,
  type StructuredQueryGrantPlan,
  type StructuredQueryRelationTuple,
  type StructuredQueryReadPlan,
  type StructuredQueryStorage,
  type StructuredQuerySupportFact,
  type StructuredQuerySupportReader,
  type StructuredQueryTupleReader,
  structuredQueryReadOutcome,
} from "../../src/core/storage/structured-query-reads.js";
import { StructuredQueryError } from "../../src/core/structured/errors.js";
import type { ValidatedStructuredQuery } from "../../src/core/structured/request.js";
import {
  buildStructuredResult,
  STRUCTURED_RESULT_EVIDENCE_REF_PLACEHOLDER,
  STRUCTURED_RESULT_MAX_BYTES,
  structuredResultEnvelopeBytes,
  type StructuredListRead,
  type StructuredRelationRowRecord,
} from "../../src/core/structured/result.js";
import type { InMemoryStructuredIdentityStore } from "../../src/core/structured/identity-store.js";
import {
  deriveRelationAssertionId,
  normalizeRelationAssertion,
} from "../../src/core/structured/identity.js";
import type {
  AuthorizedScopeRunOptions,
  AuthorizedScopeContext,
  AuthorizedScopeUnitOfWork,
  MaintenanceStatusInput,
  PreparedMemoryScopeWork,
  ScopeTransactionOwner,
} from "../../src/core/storage/structured-scope-types.js";
import type { QueryScopeIdentity } from "../../src/core/storage/structured-query-scope.js";

const DIMENSIONS = 8;
const ACTOR = "query-memory-trusted-owner";
const AUTHORIZATION_REVISION = "auth-query-memory-1";
const CONFIG_REVISION = "extractor-v1";
/**
 * The publication adapter fences its own writes against the wall clock, so the
 * lane clock starts at "now" rather than a fixed past instant: a fixed 2024
 * instant would expire every attempt lease before the first stage.
 */
const INSTANT = new Date();

const ANCHOR = "00000000-0000-4000-8000-00000000aaaa";
const OTHER = "00000000-0000-4000-8000-00000000bbbb";

let serial = 0;

/**
 * This lane's own cursor key.
 *
 * The tests drive cursors only through the reader, so they never need to sign
 * one — the negative-control cases build UNSIGNED cursors on purpose, and a
 * tampered cursor keeps the original signature so that the position check is
 * what rejects it.
 */
const CURSOR_KEY = randomBytes(32);

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

function opaqueDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** One isolated lane per case: its own backend, identity registry and clock. */
interface Lane {
  readonly backend: MemoryBackend;
  readonly storage: StructuredQueryStorage;
  readonly identityStore: InMemoryStructuredIdentityStore;
  readonly clock: () => Date;
}

function openLane(clock: () => Date = () => new Date(INSTANT)): Lane {
  const backend = new MemoryBackend(DIMENSIONS);
  return {
    backend,
    identityStore: backend.structuredIdentityStore,
    clock,
    storage: new MemoryStructuredQueryStorage(
      backend.structuredScopeUnitOfWork,
      tupleReaderOf(backend.structuredIdentityStore),
      supportReaderOf(backend),
      (scopeBinding) => backend.getScopeRevisions(scopeBinding),
      undefined,
      CURSOR_KEY,
      clock
    ),
  };
}

function advancePurgeDuringAcceptedRead(
  lane: Lane,
  scopeBinding: string
): () => void {
  const scope = lane.backend.structuredScopeUnitOfWork;
  const runAuthorized = scope.withAuthorizedScope.bind(scope);
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    scope,
    "withAuthorizedScope"
  );
  Object.defineProperty(scope, "withAuthorizedScope", {
    configurable: true,
    value: <R>(
      context: AuthorizedScopeContext,
      callback: (work: PreparedMemoryScopeWork) => Promise<R>,
      options?: AuthorizedScopeRunOptions
    ) =>
      runAuthorized(
        context,
        (work) => {
          const readAcceptedInputs = work.readAcceptedInputs.bind(work);
          const racingWork = new Proxy(work, {
            get(target, property, receiver) {
              if (property === "readAcceptedInputs") {
                return async (sourceRefs: readonly string[]) => {
                  const snapshot = await readAcceptedInputs(sourceRefs);
                  await lane.backend.setScopeRevisions(scopeBinding, {
                    purgeRevision: "purge-2",
                  });
                  return snapshot;
                };
              }
              const member = Reflect.get(target, property, receiver);
              return typeof member === "function"
                ? member.bind(target)
                : member;
            },
          });
          return callback(racingWork);
        },
        options
      ),
  });
  return () => {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(scope, "withAuthorizedScope");
    } else {
      Object.defineProperty(scope, "withAuthorizedScope", originalDescriptor);
    }
  };
}

/** A reader over the memory twin's own immutable support store. */
function supportReaderOf(backend: MemoryBackend): StructuredQuerySupportReader {
  return {
    async readSupports(supportIds) {
      const facts = new Map<string, StructuredQuerySupportFact>();
      for (const supportId of supportIds) {
        const support = await backend.getSupport(supportId);
        if (support === null) continue;
        facts.set(supportId, {
          supportId: support.support_id,
          sourceRef: support.source_ref,
          sourceVersion: support.source_version,
          // The store holds the wire's snake_case locator; this reader's port
          // declares the domain names, so they are mapped rather than spread.
          // Spreading them reads as a well-formed locator carrying no fields,
          // which only fails once the row is projected onto the wire.
          location: {
            documentId: support.location.document_id,
            version: support.location.version,
            unit: support.location.unit,
          },
          span:
            support.span === null
              ? null
              : { start: support.span.start, end: support.span.end },
          extractionRefs: await backend.listSupportExtractions(supportId),
        });
      }
      return facts;
    },
  };
}

/** A reader over the memory twin's own identity registry. */
function tupleReaderOf(
  identityStore: InMemoryStructuredIdentityStore
): StructuredQueryTupleReader {
  return {
    async readTuples(assertionIds) {
      const tuples = new Map<string, StructuredQueryRelationTuple>();
      for (const assertionId of assertionIds) {
        const assertion =
          await identityStore.findRelationAssertion(assertionId);
        if (assertion === null) continue;
        tuples.set(assertionId, {
          assertionId,
          headEntityId: assertion.headEntityId,
          relationNorm: assertion.relationNorm,
          tailEntityId: assertion.tailEntityId,
          validWindow: {
            from: assertion.validWindow.from,
            until: assertion.validWindow.until,
          },
        });
      }
      return tuples;
    },
  };
}

// ---------------------------------------------------------------------------
// Corpus seeding, through the real publication protocol
// ---------------------------------------------------------------------------

interface SeedSpec {
  readonly sourceRefs: readonly string[];
  readonly facts: readonly {
    readonly subject: "entity" | "assertion";
    readonly resultId: string;
    readonly name: string;
    readonly entityType: string;
    readonly sourceRef: string;
  }[];
  readonly relations?: readonly {
    readonly resultId: string;
    readonly head: string;
    readonly relationNorm: string;
    readonly tail: string;
    readonly sourceRef: string;
    readonly validFrom: string | null;
    readonly validUntil: string | null;
  }[];
}

interface Seeded {
  readonly context: AuthorizedScopeContext;
  readonly scopeBinding: string;
  readonly generations: ReadonlyMap<string, number>;
  readonly lane: Lane;
  /** The derived assertion id of each relation the spec declared, by index. */
  readonly assertionIds: readonly string[];
  /** The source refs this scope owns; each is scoped to this backend. */
  readonly sourceRefs: readonly string[];
  /** A source ref no scope owns yet, for a case that declares its own. */
  extraSourceRef(): string;
}

function relationId(seeded: Seeded, index: number): string {
  const id = seeded.assertionIds[index];
  if (id === undefined)
    throw new Error(`seeded corpus has no relation at ${index}`);
  return id;
}

async function seed(lane: Lane, spec: SeedSpec): Promise<Seeded> {
  const backend = lane.backend;
  const publication = backend.structuredPublication;
  const scopeBinding = unique("query-memory-scope");
  await backend.setScopeRevisions(scopeBinding, {
    authorizationRevision: AUTHORIZATION_REVISION,
    purgeRevision: "purge-1",
  });
  // A source may have only one authoritative publication scope, so every seed
  // scopes its own physical source refs; the declared names stay logical keys.
  const physical = new Map<string, string>();
  for (const declared of spec.sourceRefs)
    physical.set(declared, unique(declared));
  const generations = new Map<string, number>();
  const extractionRefs = new Map<string, string>();
  for (const sourceRef of spec.sourceRefs) {
    const { record } = await backend.registerSourceVersion({
      source_ref: physical.get(sourceRef)!,
      source_version: "v1",
      content_digest: opaqueDigest(`${sourceRef}:v1`),
      origin_object_ref: `objects/${sourceRef}/v1.html`,
      parser_revision: "frozen-html-units-v1",
      unit_manifest: { units: 20, parser_revision: "frozen-html-units-v1" },
      created_at: INSTANT.toISOString(),
    });
    const locatorBindings = Array.from({ length: 20 }, (_, index) => ({
      source_version_id: record.source_version_id,
      document_id: `${physical.get(sourceRef)!}-document`,
      version: "frozen-v1",
      unit: index + 1,
    }));
    for (const binding of locatorBindings)
      await backend.bindSourceLocator(binding);
    const declared = await publication.declareDesired({
      scopeBinding,
      authorizedSourceRefs: spec.sourceRefs.map((ref) => physical.get(ref)!),
      sourceRef: physical.get(sourceRef)!,
      sourceVersion: record,
      locatorBindings,
      desiredExtractionRevision: 1,
      configRevision: CONFIG_REVISION,
    });
    generations.set(sourceRef, declared.generation);
    extractionRefs.set(sourceRef, `${sourceRef}-extraction`);
  }
  const occurrencesFor = (sourceRef: string): number =>
    spec.facts.filter((fact) => fact.sourceRef === sourceRef).length +
    (spec.relations ?? []).filter(
      (relation) => relation.sourceRef === sourceRef
    ).length;
  const unitCursor = new Map<string, number>();
  const nextUnit = (sourceRef: string): number => {
    const current = unitCursor.get(sourceRef) ?? 0;
    unitCursor.set(sourceRef, current + 1);
    return current + 1;
  };
  const assertionIds: string[] = [];
  const published = new Map<string, PublicationFact[]>();
  for (const sourceRef of spec.sourceRefs) published.set(sourceRef, []);
  const addFact = (
    sourceRef: string,
    identity: PublicationFact["identity"],
    display: { canonicalName: string; type: string } | undefined
  ): void => {
    const unit = nextUnit(sourceRef);
    published.get(sourceRef)!.push({
      identity,
      occurrence: {
        subject: identity.kind === "entity" ? "entity" : "assertion",
        result_id: identity.kind === "entity" ? identity.input.entityId : "",
        source_ref: physical.get(sourceRef)!,
        source_version: "v1",
        location: {
          document_id: `${physical.get(sourceRef)!}-document`,
          version: "frozen-v1",
          unit,
        },
        span: { start: unit * 4, end: unit * 4 + 3 },
        // The staging extraction ref must equal every occurrence's, or the
        // publication service refuses the payload as unattributable.
        extraction_ref: extractionRefs.get(sourceRef)!,
        extractedAt: INSTANT.toISOString(),
      },
      ...(display === undefined ? {} : { display }),
    });
  };
  for (const fact of spec.facts) {
    addFact(
      fact.sourceRef,
      {
        kind: "entity",
        input: { entityId: fact.resultId, type: fact.entityType },
      },
      { canonicalName: fact.name, type: fact.entityType }
    );
  }
  for (const relation of spec.relations ?? []) {
    const input = {
      headEntityId: relation.head,
      relationNorm: relation.relationNorm,
      tailEntityId: relation.tail,
      validWindow: { from: relation.validFrom, until: relation.validUntil },
    };
    // The assertion id IS its exact tuple, so a fixture cannot choose one: the
    // reader is handed the same derived UUID the publication lane stored.
    const assertionId = deriveRelationAssertionId(
      normalizeRelationAssertion(input)
    );
    assertionIds.push(assertionId);
    await lane.identityStore.registerRelationAssertion(input);
    const identity: PublicationFact["identity"] = {
      kind: "relation_assertion",
      input,
    };
    const unit = nextUnit(relation.sourceRef);
    published.get(relation.sourceRef)!.push({
      identity,
      occurrence: {
        subject: "assertion",
        result_id: assertionId,
        source_ref: physical.get(relation.sourceRef)!,
        source_version: "v1",
        location: {
          document_id: `${physical.get(relation.sourceRef)!}-document`,
          version: "frozen-v1",
          unit,
        },
        span: { start: unit * 4, end: unit * 4 + 3 },
        extraction_ref: extractionRefs.get(relation.sourceRef)!,
        extractedAt: INSTANT.toISOString(),
      },
    });
  }
  for (const sourceRef of spec.sourceRefs) {
    const facts = published.get(sourceRef)!;
    if (facts.length === 0) continue;
    await publishOne(
      lane,
      scopeBinding,
      physical.get(sourceRef)!,
      generations.get(sourceRef)!,
      facts,
      extractionRefs.get(sourceRef)!
    );
  }
  void occurrencesFor;
  return {
    assertionIds,
    sourceRefs: spec.sourceRefs.map((ref) => physical.get(ref)!),
    extraSourceRef: () => unique("query-memory-extra"),
    context: backend.structuredScopeUnitOfWork.createAuthorizedContext({
      actorId: ACTOR,
      ownerScopeBinding: scopeBinding,
      readerBinding: scopeBinding,
      authorizedSourceRefs: spec.sourceRefs.map((ref) => physical.get(ref)!),
      authorizationRevision: AUTHORIZATION_REVISION,
      deadlineAt: new Date(lane.clock().getTime() + 60_000).toISOString(),
    }),
    scopeBinding,
    generations,
    lane,
  };
}

/**
 * Declare a NEW desired input version for a source this scope already owns.
 *
 * A second published version is a genuine DATA change: it advances the read
 * revision, which is what a cursor bound to one revision must refuse.
 */
async function declareSecondVersion(
  lane: Lane,
  seeded: Seeded,
  sourceRef: string,
  version: string,
  authorizedSourceRefs: readonly string[]
): Promise<number> {
  const backend = lane.backend;
  const { record } = await backend.registerSourceVersion({
    source_ref: sourceRef,
    source_version: version,
    content_digest: opaqueDigest(`${sourceRef}:${version}`),
    origin_object_ref: `objects/${sourceRef}/${version}.html`,
    parser_revision: "frozen-html-units-v1",
    unit_manifest: { units: 20, parser_revision: "frozen-html-units-v1" },
    created_at: INSTANT.toISOString(),
  });
  const locatorBindings = Array.from({ length: 20 }, (_, index) => ({
    source_version_id: record.source_version_id,
    document_id: `${sourceRef}-document`,
    version: `frozen-${version}`,
    unit: index + 1,
  }));
  for (const binding of locatorBindings)
    await backend.bindSourceLocator(binding);
  const declared = await backend.structuredPublication.declareDesired({
    scopeBinding: seeded.scopeBinding,
    authorizedSourceRefs,
    sourceRef,
    sourceVersion: record,
    locatorBindings,
    desiredExtractionRevision: 2,
    configRevision: CONFIG_REVISION,
  });
  return declared.generation;
}

/**
 * Advance maintenance progress WITHOUT touching the read revision.
 *
 * Scheduling and claiming a conflict check for a source that already published
 * moves the durable-work ledger, and the ledger is what the maintenance status
 * counts. This is progress, not data: the corpus rows are unchanged.
 */
async function advanceMaintenanceProgress(
  lane: Lane,
  sourceRef: string,
  generation: number,
  dependencies: readonly {
    sourceRef: string;
    generation: number;
    extractionRevision: number | null;
    relationBuckets: string[];
  }[]
): Promise<void> {
  const backend = lane.backend;
  await scheduleWork(
    { store: backend.maintenanceWorkStore, clock: lane.clock },
    { actorId: ACTOR },
    {
      workKind: "conflict_check",
      sourceRef,
      sourceVersion: "v1",
      sourceGeneration: generation,
      configRevision: CONFIG_REVISION,
      dependencies: dependencies as never,
    }
  );
  const claimed = await claimNextWork({
    store: backend.maintenanceWorkStore,
    clock: lane.clock,
  });
  if (claimed.guard === null) {
    throw new Error(
      "query memory fixture could not advance maintenance progress"
    );
  }
  await settleWork(
    { store: backend.maintenanceWorkStore, clock: lane.clock },
    claimed.guard,
    { status: "ready" },
    { configRevision: CONFIG_REVISION, dependencies: dependencies as never }
  );
}

async function publishOne(
  lane: Lane,
  scopeBinding: string,
  sourceRef: string,
  generation: number,
  facts: readonly PublicationFact[],
  extractionRef: string,
  sourceVersion = "v1",
  /** The live published extraction revision this attempt depends on. */
  dependencyExtractionRevision: number | null = null
): Promise<void> {
  const backend = lane.backend;
  const dependencies = [
    {
      sourceRef,
      generation,
      extractionRevision: dependencyExtractionRevision,
      relationBuckets: [],
    },
  ];
  const scheduled = await scheduleWork(
    { store: backend.maintenanceWorkStore, clock: lane.clock },
    { actorId: ACTOR },
    {
      workKind: "extract_publish",
      sourceRef,
      sourceVersion,
      sourceGeneration: generation,
      configRevision: CONFIG_REVISION,
      dependencies,
    }
  );
  if ("refused" in scheduled) {
    throw new Error(
      `query memory fixture schedule refused: ${scheduled.refused}`
    );
  }
  const claimed = await claimNextWork({
    store: backend.maintenanceWorkStore,
    clock: lane.clock,
  });
  if (claimed.guard === null)
    throw new Error("query memory fixture could not claim work");
  if (claimed.guard.jobKey !== scheduled.record.jobKey) {
    throw new Error(
      `query memory fixture claimed ${claimed.guard.jobKey} instead of its own ${scheduled.record.jobKey}`
    );
  }
  await backend.structuredPublication.stageAttempt({
    scopeBinding,
    sourceRef,
    guard: claimed.guard,
    extractionRef,
    accepted: facts,
  });
  await backend.structuredPublication.publish({
    scopeBinding,
    sourceRef,
    guard: claimed.guard,
    at: lane.clock().toISOString(),
  });
  const settled = await settleWork(
    { store: backend.maintenanceWorkStore, clock: lane.clock },
    claimed.guard,
    { status: "ready" },
    { configRevision: CONFIG_REVISION, dependencies }
  );
  if ("refused" in settled && settled.refused !== undefined) {
    throw new Error(`query memory fixture settle refused: ${settled.refused}`);
  }
}

function list(
  overrides: Partial<ValidatedStructuredQuery> = {}
): ValidatedStructuredQuery {
  return {
    subject: "entity",
    operation: "list",
    filters: [],
    limit: 20,
    ...overrides,
  } as ValidatedStructuredQuery;
}

async function expectRefusal(
  run: () => Promise<unknown>,
  code: string
): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(StructuredQueryError);
    expect((error as StructuredQueryError).code).toBe(code);
    return;
  }
  throw new Error(`expected refusal ${code}, but the read succeeded`);
}

function expectSyncRefusal(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(StructuredQueryError);
    expect((error as StructuredQueryError).code).toBe(code);
    return;
  }
  throw new Error(`expected refusal ${code}, but the call succeeded`);
}

/**
 * The payload text of a cursor, with any signature discarded.
 *
 * Signing is what the reader checks, so a FORGED cursor is one whose signature
 * does not cover the payload it now carries. These cases therefore rewrite the
 * body and keep the old signature — the honest shape of an attacker's edit, and
 * the case a cursor the server never minted arrives in.
 */
function cursorBody(raw: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(raw.split(".")[0]!, "base64url").toString("utf8")
  ) as Record<string, unknown>;
}

/**
 * A cursor whose payload the caller rewrote, keeping the original signature.
 *
 * This is the honest shape of an attacker's edit: the body changes, the MAC
 * still covers the body it was minted over. A reader that verifies before it
 * decodes refuses it; one that only re-checks fields applies the position raw.
 */
function tamperCursor(raw: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  const separator = raw.indexOf(".");
  return separator < 0 ? body : `${body}.${raw.slice(separator + 1)}`;
}

/** A cursor carrying exactly the payload a caller chose, and nothing else. */
function forgeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** The emitted byte count of the envelope this plan projects to. */
function envelopeBytes(
  request: ValidatedStructuredQuery,
  plan: Pick<
    StructuredQueryReadPlan,
    | "queryDigest"
    | "scopeBinding"
    | "readRevision"
    | "maintenance"
    | "rows"
    | "nextCursor"
  >,
  now: Date
): number {
  const outcome: StructuredListRead = {
    kind: "list",
    context: {
      queryDigest: plan.queryDigest,
      scopeBinding: plan.scopeBinding,
      readRevision: plan.readRevision,
      evidenceRef: "",
      maintenance: plan.maintenance,
    },
    rows: plan.rows.map((row) => ({
      ...row,
      evidenceRef: STRUCTURED_RESULT_EVIDENCE_REF_PLACEHOLDER,
    })) as StructuredRelationRowRecord[],
    nextCursor: plan.nextCursor,
  };
  return structuredResultEnvelopeBytes(request, outcome, now);
}

/** The envelope the producer ACTUALLY emits, through its own projection. */
function emittedEnvelope(
  request: ValidatedStructuredQuery,
  plan: StructuredQueryReadPlan,
  now: Date
): string {
  const issued = plan.rows.map(
    () => STRUCTURED_RESULT_EVIDENCE_REF_PLACEHOLDER
  );
  return JSON.stringify(
    buildStructuredResult(
      request,
      structuredQueryReadOutcome(plan, issued),
      now
    )
  );
}

/** A one-relation read outcome carrying the window a case is about. */
function relationRead(window: {
  readonly from: string | null;
  readonly until: string | null;
}): StructuredListRead {
  return {
    kind: "list",
    context: {
      queryDigest: "digest-window-ordering",
      scopeBinding: "scope-window-ordering",
      readRevision: "7",
      evidenceRef: "",
      maintenance: {
        maintenanceRevision: "m-1",
        sourcesInScope: 1,
        publishedSources: 1,
        desiredIndex: { pending: 0, running: 0, ready: 1, failed: 0, stale: 0 },
        conflictChecks: {
          pending: 0,
          running: 0,
          ready: 1,
          failed: 0,
          stale: 0,
        },
        rulesetRevision: "ruleset-1",
      },
    },
    rows: [
      {
        subject: "relation_assertion",
        id: ANCHOR,
        head: {
          id: ANCHOR,
          canonicalName: "Head",
          type: "organization",
          displaySupportId: OTHER,
          displayDisagreement: false,
        },
        relationNorm: "owns",
        tail: {
          id: OTHER,
          canonicalName: "Tail",
          type: "organization",
          displaySupportId: OTHER,
          displayDisagreement: false,
        },
        validWindow: window,
        evidenceRef: STRUCTURED_RESULT_EVIDENCE_REF_PLACEHOLDER,
        supports: [
          {
            supportId: OTHER,
            sourceRef: "s-a",
            sourceVersion: "v1",
            location: { documentId: "doc", version: "v1", unit: 1 },
            extractionRef: "extraction-1",
          },
        ],
      },
    ],
    nextCursor: null,
  };
}

/** Eighteen ids, one page is twenty rows: the fixture must span pages. */
function manyIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) =>
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
  );
}

// ---------------------------------------------------------------------------
// Cases, shared verbatim with the strict lane
// ---------------------------------------------------------------------------

describe("structured query memory twin", () => {
  it("captures an independent authorization and purge revision fence in the read plan", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Anchor",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
    });
    const plan = await lane.storage.readStructuredQuery(seeded.context, list());
    const expected = {
      scope_binding: seeded.scopeBinding,
      authorization_revision: AUTHORIZATION_REVISION,
      purge_revision: "purge-1",
    };
    const fence = plan.issuanceFence;

    expect(fence).toEqual(expected);
    expect(Object.isFrozen(fence)).toBe(true);

    await lane.backend.setScopeRevisions(seeded.scopeBinding, {
      authorizationRevision: unique("authorization-advanced"),
    });
    expect(fence).toEqual(expected);
  });

  it("captures the memory fence before inputs and refuses a purge advance during the read", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Anchor",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
    });
    const scope = lane.backend.structuredScopeUnitOfWork;
    const restoreScope = advancePurgeDuringAcceptedRead(
      lane,
      seeded.scopeBinding
    );

    try {
      const storage = new MemoryStructuredQueryStorage(
        scope,
        tupleReaderOf(lane.identityStore),
        supportReaderOf(lane.backend),
        (scopeBinding) => lane.backend.getScopeRevisions(scopeBinding),
        undefined,
        CURSOR_KEY,
        lane.clock
      );
      const authority = {
        createAuthorizedContext: scope.createAuthorizedContext.bind(scope),
        withAuthorizedScope: scope.withAuthorizedScope.bind(scope),
        runTransaction: async () => {
          throw new Error(
            "memory Query does not open a PostgreSQL transaction"
          );
        },
      } as unknown as AuthorizedScopeUnitOfWork & ScopeTransactionOwner;
      const identity: QueryScopeIdentity = {
        actorId: ACTOR,
        ownerScopeBinding: seeded.scopeBinding,
        readerBinding: seeded.scopeBinding,
        sourceRefs: seeded.sourceRefs.join(","),
        authorizationRevision: AUTHORIZATION_REVISION,
        deadlineAt: new Date(lane.clock().getTime() + 60_000).toISOString(),
      };
      const reader = buildStructuredQueryReader(
        authority,
        lane.backend,
        storage,
        identity
      );

      await expectRefusal(
        () => reader.readStructuredQuery(list()),
        "structured_search_unavailable"
      );
      expect(
        lane.backend.getScopeRevisions(seeded.scopeBinding)?.purge_revision
      ).toBe("purge-2");
    } finally {
      restoreScope();
    }
  });

  it("returns one row per authorized subject when two sources support it", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a", "s-b"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Widget",
          entityType: "organization",
          sourceRef: "s-a",
        },
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Widget",
          entityType: "organization",
          sourceRef: "s-b",
        },
      ],
    });
    const plan = await lane.storage.readStructuredQuery(seeded.context, list());
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]!.supports).toHaveLength(2);
  });

  it("orders rows ascending by UUID bytes", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: OTHER,
          name: "Beta",
          entityType: "organization",
          sourceRef: "s-a",
        },
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Alpha",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
    });
    const plan = await lane.storage.readStructuredQuery(seeded.context, list());
    expect(plan.rows.map((row) => row.id)).toEqual([ANCHOR, OTHER]);
  });

  it("continues a second page with no gap and no duplicate", async () => {
    const lane = openLane();
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ];
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: ids.map((id, index) => ({
        subject: "entity" as const,
        resultId: id,
        name: `E${index}`,
        entityType: "organization",
        sourceRef: "s-a",
      })),
    });
    const first = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ limit: 2 })
    );
    expect(first.rows.map((row) => row.id)).toEqual(ids.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();
    const second = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ limit: 2, cursor: first.nextCursor! })
    );
    expect(second.rows.map((row) => row.id)).toEqual(ids.slice(2));
    expect(second.nextCursor).toBeNull();
  });

  it("applies exact eq and in filters, AND-combined", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Alpha",
          entityType: "organization",
          sourceRef: "s-a",
        },
        {
          subject: "entity",
          resultId: OTHER,
          name: "Beta",
          entityType: "place",
          sourceRef: "s-a",
        },
      ],
    });
    const byName = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ filters: [{ field: "canonical_name", op: "eq", value: "Alpha" }] })
    );
    expect(byName.rows.map((row) => row.id)).toEqual([ANCHOR]);
    const byTypeIn = await lane.storage.readStructuredQuery(
      seeded.context,
      list({
        filters: [
          { field: "type", op: "in", values: ["organization", "place"] },
        ],
      })
    );
    expect(byTypeIn.rows).toHaveLength(2);
    const anded = await lane.storage.readStructuredQuery(
      seeded.context,
      list({
        filters: [
          { field: "type", op: "in", values: ["organization", "place"] },
          { field: "canonical_name", op: "eq", value: "Beta" },
        ],
      })
    );
    expect(anded.rows.map((row) => row.id)).toEqual([OTHER]);
  });

  it("returns directed one-hop outgoing and incoming assertions without traversing two hops", async () => {
    const lane = openLane();
    const far = "00000000-0000-4000-8000-00000000cccc";
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Anchor",
          entityType: "organization",
          sourceRef: "s-a",
        },
        {
          subject: "entity",
          resultId: OTHER,
          name: "Other",
          entityType: "organization",
          sourceRef: "s-a",
        },
        {
          subject: "entity",
          resultId: far,
          name: "Far",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
      relations: [
        {
          head: ANCHOR,
          relationNorm: "owns",
          tail: OTHER,
          sourceRef: "s-a",
          validFrom: null,
          validUntil: null,
        },
        {
          head: OTHER,
          relationNorm: "owns",
          tail: far,
          sourceRef: "s-a",
          validFrom: null,
          validUntil: null,
        },
      ],
    });
    const outgoing = await lane.storage.readStructuredQuery(
      seeded.context,
      list({
        subject: "relation_assertion",
        relationship: { anchorEntityId: ANCHOR, direction: "outgoing" },
      })
    );
    expect(outgoing.rows.map((row) => row.id)).toEqual([relationId(seeded, 0)]);
    const incoming = await lane.storage.readStructuredQuery(
      seeded.context,
      list({
        subject: "relation_assertion",
        relationship: { anchorEntityId: far, direction: "incoming" },
      })
    );
    expect(incoming.rows.map((row) => row.id)).toEqual([relationId(seeded, 1)]);
  });

  it("keeps past and future validity windows visible and countable", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Anchor",
          entityType: "organization",
          sourceRef: "s-a",
        },
        {
          subject: "entity",
          resultId: OTHER,
          name: "Other",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
      relations: [
        {
          head: ANCHOR,
          relationNorm: "past_only",
          tail: OTHER,
          sourceRef: "s-a",
          validFrom: "1999-01-01T00:00:00Z",
          validUntil: "2000-01-01T00:00:00Z",
        },
        {
          head: ANCHOR,
          relationNorm: "future_only",
          tail: OTHER,
          sourceRef: "s-a",
          validFrom: "2999-01-01T00:00:00Z",
          validUntil: null,
        },
      ],
    });
    const plan = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ subject: "relation_assertion" })
    );
    expect(plan.rows).toHaveLength(2);
    const counted = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ subject: "relation_assertion", operation: "count" })
    );
    expect(counted.count).toBe(2);
  });

  it("does not multiply relation rows or count by source multiplicity", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Anchor",
          entityType: "organization",
          sourceRef: "s-a",
        },
        {
          subject: "entity",
          resultId: OTHER,
          name: "Other",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
      relations: [
        {
          head: ANCHOR,
          relationNorm: "owns",
          tail: OTHER,
          sourceRef: "s-a",
          validFrom: null,
          validUntil: null,
        },
      ],
    });
    const rows = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ subject: "relation_assertion" })
    );
    const counted = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ subject: "relation_assertion", operation: "count" })
    );
    expect(rows.rows).toHaveLength(1);
    expect(counted.count).toBe(1);
  });

  it("keeps the attributed display invariant to source arrival order", async () => {
    // Two supports of ONE result carrying different display values, listed in
    // opposite orders across two reads of one lane. Arrival order differs; the
    // chosen pair must not, because the choice is a byte-order comparison over
    // (canonical_name, entity_type) and not a first-wins.
    const lane = openLane();
    const forward = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Zeta",
          entityType: "organization",
          sourceRef: "s-a",
        },
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Alpha",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
    });
    const backward = await seed(openLane(), {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Alpha",
          entityType: "organization",
          sourceRef: "s-a",
        },
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Zeta",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
    });
    const displayOf = (plan: {
      rows: readonly {
        id: string;
        canonicalName: string;
        type: string;
        displaySupportId: string;
        displayDisagreement: boolean;
      }[];
    }) => ({
      id: plan.rows[0]!.id,
      canonicalName: plan.rows[0]!.canonicalName,
      type: plan.rows[0]!.type,
      displayDisagreement: plan.rows[0]!.displayDisagreement,
      // The chosen support must be one of the row's own current supports, and it
      // must be the support whose display value is the pair that won.
      supportIsCurrent: plan.rows[0]!.supports.some(
        (support) => support.supportId === plan.rows[0]!.displaySupportId
      ),
    });
    const firstPlan = await lane.storage.readStructuredQuery(
      forward.context,
      list()
    );
    const secondPlan = await backward.lane.storage.readStructuredQuery(
      backward.context,
      list()
    );
    // Both orders show the byte-order-smallest pair, and both declare the
    // disagreement the two distinct values represent.
    expect(firstPlan.rows[0]!.canonicalName).toBe("Alpha");
    expect(secondPlan.rows[0]!.canonicalName).toBe("Alpha");
    expect(displayOf(firstPlan)).toEqual(displayOf(secondPlan));
    expect(firstPlan.rows[0]!.displayDisagreement).toBe(true);
    // The exact-filter predicate sees the same chosen pair in both orders.
    const byName = async (seeded: Seeded) => {
      const plan = await seeded.lane.storage.readStructuredQuery(
        seeded.context,
        list({
          filters: [{ field: "canonical_name", op: "eq", value: "Zeta" }],
        })
      );
      return plan.rows.length;
    };
    expect(await byName(forward)).toBe(0);
    expect(await byName(backward)).toBe(0);
  });

  it("gives a different authorized support set only its own values and exact matches", async () => {
    const lane = openLane();
    const narrow = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Alpha",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
    });
    const wide = await seed(openLane(), {
      sourceRefs: ["s-a", "s-b"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Alpha",
          entityType: "organization",
          sourceRef: "s-a",
        },
        {
          subject: "entity",
          resultId: OTHER,
          name: "Beta",
          entityType: "place",
          sourceRef: "s-b",
        },
      ],
    });
    const narrowPlan = await narrow.lane.storage.readStructuredQuery(
      narrow.context,
      list({ filters: [{ field: "canonical_name", op: "eq", value: "Beta" }] })
    );
    expect(narrowPlan.rows).toHaveLength(0);
    const widePlan = await wide.lane.storage.readStructuredQuery(
      wide.context,
      list({ filters: [{ field: "canonical_name", op: "eq", value: "Beta" }] })
    );
    expect(widePlan.rows.map((row) => row.id)).toEqual([OTHER]);
  });

  it("counts the complete distinct set, including zero and more than one page", async () => {
    const lane = openLane();
    const empty = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Alpha",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
    });
    const noMatch = await lane.storage.readStructuredQuery(
      empty.context,
      list({
        operation: "count",
        filters: [{ field: "canonical_name", op: "eq", value: "Nope" }],
      })
    );
    expect(noMatch.count).toBe(0);
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ];
    const wide = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: ids.map((id, index) => ({
        subject: "entity" as const,
        resultId: id,
        name: `E${index}`,
        entityType: "organization",
        sourceRef: "s-a",
      })),
    });
    const counted = await wide.lane.storage.readStructuredQuery(
      wide.context,
      list({ operation: "count" })
    );
    expect(counted.count).toBe(3);
    const paged = await wide.lane.storage.readStructuredQuery(
      wide.context,
      list({ limit: 1 })
    );
    expect(paged.rows).toHaveLength(1);
    expect(paged.nextCursor).not.toBeNull();
  });

  it("refuses a cursor whose read revision moved", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Alpha",
          entityType: "organization",
          sourceRef: "s-a",
        },
        {
          subject: "entity",
          resultId: OTHER,
          name: "Beta",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
    });
    const first = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ limit: 1 })
    );
    // Publishing a second desired version is a DATA change: the row set a cursor
    // was walking is no longer the set this revision holds.
    const generation = await declareSecondVersion(
      lane,
      seeded,
      seeded.sourceRefs[0]!,
      "v2",
      seeded.sourceRefs
    );
    await publishOne(
      lane,
      seeded.scopeBinding,
      seeded.sourceRefs[0]!,
      generation,
      [
        {
          identity: {
            kind: "entity",
            input: { entityId: ANCHOR, type: "organization" },
          },
          occurrence: {
            subject: "entity",
            result_id: ANCHOR,
            source_ref: seeded.sourceRefs[0]!,
            source_version: "v2",
            location: {
              document_id: `${seeded.sourceRefs[0]!}-document`,
              version: "frozen-v2",
              unit: 19,
            },
            span: { start: 76, end: 79 },
            extraction_ref: "s-a-extraction-v2",
            extractedAt: INSTANT.toISOString(),
          },
          display: { canonicalName: "Alpha", type: "organization" },
        },
      ],
      "s-a-extraction-v2",
      "v2",
      1
    );
    await expectRefusal(
      () =>
        lane.storage.readStructuredQuery(
          seeded.context,
          list({ limit: 1, cursor: first.nextCursor! })
        ),
      "cursor_revision_mismatch"
    );
  });

  it("refuses a cursor issued for a different query", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Alpha",
          entityType: "organization",
          sourceRef: "s-a",
        },
        {
          subject: "entity",
          resultId: OTHER,
          name: "Beta",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
    });
    const first = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ limit: 1 })
    );
    await expectRefusal(
      () =>
        lane.storage.readStructuredQuery(
          seeded.context,
          list({
            limit: 1,
            cursor: first.nextCursor!,
            filters: [{ field: "canonical_name", op: "eq", value: "Beta" }],
          })
        ),
      "cursor_revision_mismatch"
    );
  });

  it("keeps a live cursor usable across a maintenance-only revision change", async () => {
    const lane = openLane();
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: ids.map((id, index) => ({
        subject: "entity" as const,
        resultId: id,
        name: `E${index}`,
        entityType: "organization",
        sourceRef: "s-a",
      })),
    });
    const first = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ limit: 1 })
    );
    // Scheduling and settling a conflict check moves the durable-work ledger the
    // status counts, and touches no corpus row. That is PROGRESS: the read
    // revision stands, so a live cursor stays live.
    await advanceMaintenanceProgress(
      lane,
      seeded.sourceRefs[0]!,
      seeded.generations.get("s-a")!,
      [
        {
          sourceRef: seeded.sourceRefs[0]!,
          generation: seeded.generations.get("s-a")!,
          extractionRevision: 1,
          relationBuckets: [],
        },
      ]
    );
    const second = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ limit: 1, cursor: first.nextCursor! })
    );
    expect(second.rows.map((row) => row.id)).toEqual(ids.slice(1));
    expect(second.maintenance.maintenanceRevision).not.toBe(
      first.maintenance.maintenanceRevision
    );
    expect(second.readRevision).toBe(first.readRevision);
    // Q9: the status counts stay same-scope and complete after the change.
    expect(second.maintenance.sourcesInScope).toBe(1);
    expect(second.maintenance.publishedSources).toBe(1);
  });

  it("refuses a malformed cursor and an expired one by name", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Alpha",
          entityType: "organization",
          sourceRef: "s-a",
        },
        {
          subject: "entity",
          resultId: OTHER,
          name: "Beta",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
    });
    await expectRefusal(
      () =>
        lane.storage.readStructuredQuery(
          seeded.context,
          list({ cursor: "not-a-cursor!!" })
        ),
      "invalid_cursor"
    );
    const first = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ limit: 1 })
    );
    // The SAME authority over the same scope, read on a clock eleven minutes
    // later. Only the instant differs, so the refusal observed is the expiry and
    // not a foreign context or a moved revision.
    const laterClock = () => new Date(INSTANT.getTime() + 11 * 60_000);
    const laterContext =
      lane.backend.structuredScopeUnitOfWork.createAuthorizedContext({
        actorId: ACTOR,
        ownerScopeBinding: seeded.scopeBinding,
        readerBinding: seeded.scopeBinding,
        authorizedSourceRefs: seeded.sourceRefs,
        authorizationRevision: AUTHORIZATION_REVISION,
        deadlineAt: new Date(laterClock().getTime() + 60_000).toISOString(),
      });
    const laterReader = new MemoryStructuredQueryStorage(
      lane.backend.structuredScopeUnitOfWork,
      tupleReaderOf(lane.identityStore),
      supportReaderOf(lane.backend),
      (scopeBinding) => lane.backend.getScopeRevisions(scopeBinding),
      undefined,
      CURSOR_KEY,
      laterClock
    );
    await expectRefusal(
      () =>
        laterReader.readStructuredQuery(
          laterContext,
          list({ limit: 1, cursor: first.nextCursor! })
        ),
      "cursor_expired"
    );
  });

  it("refuses when the maintenance status is unavailable", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Alpha",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
    });
    // Two persisted check records in one scope that disagree on the ruleset are
    // exactly what an unreadable status row looks like to this reader: there is
    // no single status describing both.
    const disagreeing = new MemoryStructuredQueryStorage(
      lane.backend.structuredScopeUnitOfWork,
      tupleReaderOf(lane.identityStore),
      supportReaderOf(lane.backend),
      (scopeBinding) => lane.backend.getScopeRevisions(scopeBinding),
      {
        readScreeningStatus: (_scopeBinding, sourceRefs) =>
          sourceRefs.flatMap((sourceRef) => [
            {
              sourceRef,
              rulesetRevision: "ruleset-a",
              coverage: "coverage-a",
              retiredSupports: 0,
            },
            {
              sourceRef,
              rulesetRevision: "ruleset-b",
              coverage: "coverage-b",
              retiredSupports: 0,
            },
          ]),
      },
      CURSOR_KEY,
      lane.clock
    );
    await expectRefusal(
      () => disagreeing.readStructuredQuery(seeded.context, list()),
      "maintenance_status_unavailable"
    );
  });

  it("refuses when a mandatory row cannot fit the envelope", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "x".repeat(64 * 1024),
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
    });
    await expectRefusal(
      () => lane.storage.readStructuredQuery(seeded.context, list()),
      "result_too_large"
    );
  });

  it("refuses a context not minted by this composition before opening a scope", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Alpha",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
    });
    // Both the reader's own guard and the unit-of-work guard refuse an unminted
    // context with the SAME code, and the reader's rethrows the unit-of-work's own
    // message, so neither the code nor the text can say which one refused. What
    // does separate them is the reader's stated contract — refuse "before any
    // connection is leased" — so this counts scope openings instead of guessing.
    let scopesOpened = 0;
    const countingScope = new Proxy(lane.backend.structuredScopeUnitOfWork, {
      get(target, property, receiver) {
        if (property !== "withAuthorizedScope") {
          return Reflect.get(target, property, receiver);
        }
        return (...args: unknown[]) => {
          scopesOpened += 1;
          return Reflect.apply(
            (target as { withAuthorizedScope: (...a: unknown[]) => unknown })
              .withAuthorizedScope,
            target,
            args
          );
        };
      },
    });
    const storage = new MemoryStructuredQueryStorage(
      countingScope,
      tupleReaderOf(lane.backend.structuredIdentityStore),
      supportReaderOf(lane.backend),
      (scopeBinding) => lane.backend.getScopeRevisions(scopeBinding),
      undefined,
      CURSOR_KEY,
      lane.clock
    );
    const forged = { ...seeded.context } as AuthorizedScopeContext;
    await expectRefusal(
      () => storage.readStructuredQuery(forged, list()),
      "authorization_denied"
    );
    expect(scopesOpened).toBe(0);
  });

  it("names endpoint display supports with their own grant role", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Anchor",
          entityType: "organization",
          sourceRef: "s-a",
        },
        {
          subject: "entity",
          resultId: OTHER,
          name: "Other",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
      relations: [
        {
          head: ANCHOR,
          relationNorm: "owns",
          tail: OTHER,
          sourceRef: "s-a",
          validFrom: null,
          validUntil: null,
        },
      ],
    });
    const plan = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ subject: "relation_assertion" })
    );
    const roles = new Set(plan.grants[0]!.supports.map((ref) => ref.role));
    expect(roles.has(STRUCTURED_QUERY_SUPPORT_ROLE.OCCURRENCE)).toBe(true);
    expect(roles.has(STRUCTURED_QUERY_SUPPORT_ROLE.ENDPOINT_DISPLAY)).toBe(
      true
    );
  });

  it("refuses to project a row with no issued evidence reference", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Alpha",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
    });
    const plan = await lane.storage.readStructuredQuery(seeded.context, list());
    await expectRefusal(
      async () => structuredQueryReadOutcome(plan, []),
      "structured_search_unavailable"
    );
  });

  it("carries one row grant per row and exactly one count grant", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Alpha",
          entityType: "organization",
          sourceRef: "s-a",
        },
        {
          subject: "entity",
          resultId: OTHER,
          name: "Beta",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
    });
    const listPlan = await lane.storage.readStructuredQuery(
      seeded.context,
      list()
    );
    expect(listPlan.grants).toHaveLength(2);
    const countPlan = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ operation: "count" })
    );
    expect(countPlan.grants).toHaveLength(1);
    const grant = countPlan.grants[0] as StructuredQueryGrantPlan;
    expect(grant.kind).toBe("count");
    expect(grant.count).toBe(2);
    expect(grant.supports).toHaveLength(0);
    expect(grant.value).toMatchObject({
      subject: "entity",
      count: 2,
      coverage: "stored_structured_subjects",
    });
  });

  // -------------------------------------------------------------------------
  // Envelope bound at row boundaries
  // -------------------------------------------------------------------------

  it("bounds a collectively oversized page to a resumable prefix at row boundaries", async () => {
    const lane = openLane();
    // Eight sources behind every one of twenty rows: the page is collectively far
    // over the envelope, and only a row-boundary cut keeps the remainder
    // reachable. A single oversized row would be `result_too_large` instead.
    const ids = manyIds(20);
    const sourceRefs = ["s-1", "s-2", "s-3", "s-4", "s-5", "s-6", "s-7", "s-8"];
    const seeded = await seed(lane, {
      sourceRefs,
      facts: ids.flatMap((resultId) =>
        sourceRefs.map((sourceRef) => ({
          subject: "entity" as const,
          resultId,
          name: "Widget",
          entityType: "organization",
          sourceRef,
        }))
      ),
    });

    const first = await lane.storage.readStructuredQuery(
      seeded.context,
      list()
    );
    // The reduction ran, and it ran at a row boundary: the page is a strict
    // prefix of the matched set, not the whole of it and not nothing.
    expect(first.rows.length).toBeGreaterThan(0);
    expect(first.rows.length).toBeLessThan(ids.length);
    expect(first.rows.map((row) => row.id)).toEqual(
      ids.slice(0, first.rows.length)
    );
    expect(first.nextCursor).not.toBeNull();

    // What the producer ACTUALLY emits is inside the bound.
    const emitted = emittedEnvelope(list(), first, lane.clock());
    expect(Buffer.byteLength(emitted, "utf8")).toBeLessThanOrEqual(
      STRUCTURED_RESULT_MAX_BYTES
    );

    // Resuming from the cursor the page returned yields the remaining rows:
    // no gap, no duplicate, and the union is the whole matched set.
    const walked = [...first.rows];
    const second = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ cursor: first.nextCursor! })
    );
    expect(second.rows.length).toBeGreaterThan(0);
    walked.push(...second.rows);
    expect(walked.map((row) => row.id)).toEqual(ids);
    expect(new Set(walked.map((row) => row.id)).size).toBe(ids.length);

    // The cut is the minimum one: one row more would NOT have fitted. This is
    // the check an approximation fails — a page measured by the wrong shape
    // reports more rows as fitting than actually do.
    // The cut is the minimum one: one row more would NOT have fitted. Measured
    // with the cursor a 14-row page would actually CARRY — a probe read that
    // stops after one row mints exactly that cursor, which a page measured as
    // `next_cursor: null` would under-count by the whole cursor.
    const probe = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ limit: 1, cursor: first.nextCursor! })
    );
    expect(probe.rows[0]!.id).toBe(ids[first.rows.length]);
    const oneMore = {
      ...first,
      rows: [...first.rows, probe.rows[0]!],
      nextCursor: probe.nextCursor,
    };
    expect(envelopeBytes(list(), oneMore, lane.clock())).toBeGreaterThan(
      STRUCTURED_RESULT_MAX_BYTES
    );
  });

  // -------------------------------------------------------------------------
  // Cursor authenticity
  // -------------------------------------------------------------------------

  it("refuses a hand-built cursor and a rewritten position, but continues a real one", async () => {
    const lane = openLane();
    const ids = manyIds(3);
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: ids.map((id, index) => ({
        subject: "entity" as const,
        resultId: id,
        name: `E${index}`,
        entityType: "organization",
        sourceRef: "s-a",
      })),
    });
    const first = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ limit: 1 })
    );
    const real = first.nextCursor!;
    const payload = cursorBody(real);

    // A hand-built cursor whose every field is correct. Nothing here is wrong
    // except that this build never signed it.

    // The same edit an attacker makes: decode, move the position onto a row in
    // the middle of the set, re-encode. Every field the transaction can check
    // still agrees; only the position was rewritten.

    // A position that is not even an id. Unverified, this sorts AFTER every real
    // row, so the read would resume past the whole set and answer a successful
    // EMPTY page — indistinguishable from a genuinely empty result.
    await expectRefusal(
      () =>
        lane.storage.readStructuredQuery(
          seeded.context,
          list({
            limit: 1,
            cursor: tamperCursor(real, { ...payload, aft: "garbage" }),
          })
        ),
      "invalid_cursor"
    );

    // NEGATIVE CONTROL: the untouched cursor still continues, so the three
    // refusals above cannot be passing because every cursor is refused.
    const second = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ limit: 1, cursor: real })
    );
    expect(second.rows.map((row) => row.id)).toEqual(ids.slice(1, 2));
  });

  it("carries the first page's expiry onto every later page's cursor", async () => {
    const lane = openLane();
    const ids = manyIds(3);
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: ids.map((id, index) => ({
        subject: "entity" as const,
        resultId: id,
        name: `E${index}`,
        entityType: "organization",
        sourceRef: "s-a",
      })),
    });
    const first = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ limit: 1 })
    );
    const second = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ limit: 1, cursor: first.nextCursor! })
    );
    expect(second.rows.map((row) => row.id)).toEqual(ids.slice(1, 2));
    // Carried forward, not re-opened: a renewed expiry would make the fixed
    // ten-minute window a rolling one that no test reading page one would see.
    expect(cursorBody(second.nextCursor!).exp).toBe(
      cursorBody(first.nextCursor!).exp
    );
  });

  // -------------------------------------------------------------------------
  // Count over more than one page
  // -------------------------------------------------------------------------

  it("counts every distinct id walking all pages yields, not one page's rows", async () => {
    const lane = openLane();
    const ids = manyIds(25);
    const seeded = await seed(lane, {
      sourceRefs: ["s-a", "s-b"],
      facts: ids.map((id, index) => ({
        subject: "entity" as const,
        resultId: id,
        name: `E${index}`,
        entityType: "organization",
        sourceRef: index % 2 === 0 ? "s-a" : "s-b",
      })),
    });
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const read: StructuredQueryReadPlan =
        await lane.storage.readStructuredQuery(
          seeded.context,
          list(cursor === null ? {} : { cursor })
        );
      walked.push(...read.rows.map((row) => row.id));
      cursor = read.nextCursor;
      if (cursor === null) break;
    }
    // The union of every page is duplicate-free and IS the count.
    expect(new Set(walked).size).toBe(walked.length);
    expect(walked.length).toBeGreaterThan(20);
    const counted = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ operation: "count" })
    );
    expect(counted.count).toBe(walked.length);
    expect(counted.count).toBe(new Set(walked).size);
  });

  // -------------------------------------------------------------------------
  // Reader lease
  // -------------------------------------------------------------------------

  it("refuses a read whose clock has passed the execution lease, and answers one inside it", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Alpha",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
    });
    const start = lane.clock().getTime();
    // The reader stamps its start and its page from the SAME injected clock, so
    // a clock that advances past the lease between the two readings is the whole
    // condition. The scope authority keeps its own clock, so nothing else here
    // expires: only the reader's lease can fire.
    const late = new MemoryStructuredQueryStorage(
      lane.backend.structuredScopeUnitOfWork,
      tupleReaderOf(lane.identityStore),
      supportReaderOf(lane.backend),
      (scopeBinding) => lane.backend.getScopeRevisions(scopeBinding),
      undefined,
      CURSOR_KEY,
      (() => {
        let reading = 0;
        return () => new Date(start + (reading++ === 0 ? 0 : 61_000));
      })()
    );
    await expectRefusal(
      () => late.readStructuredQuery(seeded.context, list()),
      "query_timeout"
    );
    // NEGATIVE CONTROL: the same read on a clock that does not pass the lease.
    const inside = await lane.storage.readStructuredQuery(
      seeded.context,
      list()
    );
    expect(inside.rows.map((row) => row.id)).toEqual([ANCHOR]);
  });

  // -------------------------------------------------------------------------
  // Authorization narrowing seam
  // -------------------------------------------------------------------------

  it("narrows a read to a requested subset and refuses a subset it does not own", async () => {
    const lane = await openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a", "s-b"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Alpha",
          entityType: "organization",
          sourceRef: "s-a",
        },
        {
          subject: "entity",
          resultId: OTHER,
          name: "Beta",
          entityType: "organization",
          sourceRef: "s-b",
        },
      ],
    });
    const whole = await lane.storage.readStructuredQuery(
      seeded.context,
      list()
    );
    expect(whole.rows.map((row) => row.id)).toEqual([ANCHOR, OTHER]);

    // Narrowing is allowed and is what the authorized subset means.
    const narrowed = await lane.storage.readStructuredQuery(
      seeded.context,
      list(),
      [seeded.sourceRefs[1]!]
    );
    expect(narrowed.rows.map((row) => row.id)).toEqual([OTHER]);

    // Widening is not, and the guard is reachable precisely because the
    // requested set is a caller's second argument rather than the context's.
    await expectRefusal(
      () =>
        lane.storage.readStructuredQuery(seeded.context, list(), [
          "never-authorized",
        ]),
      "authorization_denied"
    );
  });

  it("refuses to compose a reader whose cursor key cannot authenticate", async () => {
    const lane = openLane();
    // A short key HMACs perfectly well and is reproducible by anyone, which is
    // the failure the signature exists to prevent — so it is refused at
    // composition rather than shipped as a cursor anyone can forge.
    expect(
      () =>
        new MemoryStructuredQueryStorage(
          lane.backend.structuredScopeUnitOfWork,
          tupleReaderOf(lane.identityStore),
          supportReaderOf(lane.backend),
          (scopeBinding) => lane.backend.getScopeRevisions(scopeBinding),
          undefined,
          Buffer.alloc(8),
          lane.clock
        )
    ).toThrow(/cursor key/);
    // NEGATIVE CONTROL: this lane's own full-width key composes and reads.
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        {
          subject: "entity",
          resultId: ANCHOR,
          name: "Alpha",
          entityType: "organization",
          sourceRef: "s-a",
        },
      ],
    });
    const read = await lane.storage.readStructuredQuery(seeded.context, list());
    expect(read.rows.map((row) => row.id)).toEqual([ANCHOR]);
  });

  // -------------------------------------------------------------------------
  // Window ordering at the producer
  // -------------------------------------------------------------------------

  it("refuses a valid_window that does not order, and emits one that does", () => {
    const request = list({ subject: "relation_assertion" });
    const instant = new Date("2024-01-01T00:00:00Z");
    // NEGATIVE CONTROL: an ordered window projects.
    expect(
      buildStructuredResult(
        request,
        relationRead({
          from: "2020-01-01T00:00:00Z",
          until: "2021-01-01T00:00:00Z",
        }),
        instant
      ).schema
    ).toBe("iknow.structured_result");
    // A reversed window describes no instant, and the consumer refuses it as an
    // opaque contract violation — the producer must name it in its own code.
    expectSyncRefusal(
      () =>
        buildStructuredResult(
          request,
          relationRead({
            from: "2021-01-01T00:00:00Z",
            until: "2020-01-01T00:00:00Z",
          }),
          instant
        ),
      "structured_search_unavailable"
    );
    // A zero-length window is the same fact: `start >= end`.
    expectSyncRefusal(
      () =>
        buildStructuredResult(
          request,
          relationRead({
            from: "2020-01-01T00:00:00Z",
            until: "2020-01-01T00:00:00Z",
          }),
          instant
        ),
      "structured_search_unavailable"
    );
  });
});

void (0 as unknown as MaintenanceStatusInput);
