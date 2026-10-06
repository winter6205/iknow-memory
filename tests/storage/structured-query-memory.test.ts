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
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  claimNextWork,
  scheduleWork,
  settleWork,
} from "../../src/core/maintenance/service.js";
import type { PublicationFact } from "../../src/core/maintenance/publication-types.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import {
  MemoryStructuredQueryStorage,
  STRUCTURED_QUERY_SUPPORT_ROLE,
  type StructuredQueryGrantPlan,
  type StructuredQueryRelationTuple,
  type StructuredQueryStorage,
  type StructuredQuerySupportFact,
  type StructuredQuerySupportReader,
  type StructuredQueryTupleReader,
  structuredQueryReadOutcome,
} from "../../src/core/storage/structured-query-reads.js";
import { StructuredQueryError } from "../../src/core/structured/errors.js";
import type { ValidatedStructuredQuery } from "../../src/core/structured/request.js";
import type { InMemoryStructuredIdentityStore } from "../../src/core/structured/identity-store.js";
import {
  deriveRelationAssertionId,
  normalizeRelationAssertion,
} from "../../src/core/structured/identity.js";
import type {
  AuthorizedScopeContext,
  MaintenanceStatusInput,
} from "../../src/core/storage/structured-scope-types.js";

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
      undefined,
      clock
    ),
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
          location: { ...support.location },
          span: support.span === null ? null : { start: support.span.start, end: support.span.end },
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
        const assertion = await identityStore.findRelationAssertion(assertionId);
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
  if (id === undefined) throw new Error(`seeded corpus has no relation at ${index}`);
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
  for (const declared of spec.sourceRefs) physical.set(declared, unique(declared));
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
    for (const binding of locatorBindings) await backend.bindSourceLocator(binding);
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
    (spec.relations ?? []).filter((relation) => relation.sourceRef === sourceRef).length;
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
        result_id:
          identity.kind === "entity" ? identity.input.entityId : "",
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
    const assertionId = deriveRelationAssertionId(normalizeRelationAssertion(input));
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
  for (const binding of locatorBindings) await backend.bindSourceLocator(binding);
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
  dependencies: readonly { sourceRef: string; generation: number; extractionRevision: number | null; relationBuckets: string[] }[]
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
    throw new Error("query memory fixture could not advance maintenance progress");
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
    { sourceRef, generation, extractionRevision: dependencyExtractionRevision, relationBuckets: [] },
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
    throw new Error(`query memory fixture schedule refused: ${scheduled.refused}`);
  }
  const claimed = await claimNextWork({
    store: backend.maintenanceWorkStore,
    clock: lane.clock,
  });
  if (claimed.guard === null) throw new Error("query memory fixture could not claim work");
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

function list(overrides: Partial<ValidatedStructuredQuery> = {}): ValidatedStructuredQuery {
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

// ---------------------------------------------------------------------------
// Cases, shared verbatim with the strict lane
// ---------------------------------------------------------------------------

describe("structured query memory twin", () => {
  it("returns one row per authorized subject when two sources support it", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a", "s-b"],
      facts: [
        { subject: "entity", resultId: ANCHOR, name: "Widget", entityType: "organization", sourceRef: "s-a" },
        { subject: "entity", resultId: ANCHOR, name: "Widget", entityType: "organization", sourceRef: "s-b" },
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
        { subject: "entity", resultId: OTHER, name: "Beta", entityType: "organization", sourceRef: "s-a" },
        { subject: "entity", resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: "s-a" },
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
    const first = await lane.storage.readStructuredQuery(seeded.context, list({ limit: 2 }));
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
        { subject: "entity", resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: "s-a" },
        { subject: "entity", resultId: OTHER, name: "Beta", entityType: "place", sourceRef: "s-a" },
      ],
    });
    const byName = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ filters: [{ field: "canonical_name", op: "eq", value: "Alpha" }] })
    );
    expect(byName.rows.map((row) => row.id)).toEqual([ANCHOR]);
    const byTypeIn = await lane.storage.readStructuredQuery(
      seeded.context,
      list({ filters: [{ field: "type", op: "in", values: ["organization", "place"] }] })
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
        { subject: "entity", resultId: ANCHOR, name: "Anchor", entityType: "organization", sourceRef: "s-a" },
        { subject: "entity", resultId: OTHER, name: "Other", entityType: "organization", sourceRef: "s-a" },
        { subject: "entity", resultId: far, name: "Far", entityType: "organization", sourceRef: "s-a" },
      ],
      relations: [
        { head: ANCHOR, relationNorm: "owns", tail: OTHER, sourceRef: "s-a", validFrom: null, validUntil: null },
        { head: OTHER, relationNorm: "owns", tail: far, sourceRef: "s-a", validFrom: null, validUntil: null },
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
        { subject: "entity", resultId: ANCHOR, name: "Anchor", entityType: "organization", sourceRef: "s-a" },
        { subject: "entity", resultId: OTHER, name: "Other", entityType: "organization", sourceRef: "s-a" },
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
        { subject: "entity", resultId: ANCHOR, name: "Anchor", entityType: "organization", sourceRef: "s-a" },
        { subject: "entity", resultId: OTHER, name: "Other", entityType: "organization", sourceRef: "s-a" },
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
        { subject: "entity", resultId: ANCHOR, name: "Zeta", entityType: "organization", sourceRef: "s-a" },
        { subject: "entity", resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: "s-a" },
      ],
    });
    const backward = await seed(openLane(), {
      sourceRefs: ["s-a"],
      facts: [
        { subject: "entity", resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: "s-a" },
        { subject: "entity", resultId: ANCHOR, name: "Zeta", entityType: "organization", sourceRef: "s-a" },
      ],
    });
    const displayOf = (plan: { rows: readonly { id: string; canonicalName: string; type: string; displaySupportId: string; displayDisagreement: boolean }[] }) => ({
      id: plan.rows[0]!.id,
      canonicalName: plan.rows[0]!.canonicalName,
      type: plan.rows[0]!.type,
      displayDisagreement: plan.rows[0]!.displayDisagreement,
      // The chosen support must be one of the row's own current supports, and it
      // must be the support whose display value is the pair that won.
      supportIsCurrent:
        plan.rows[0]!.supports.some((support) => support.supportId === plan.rows[0]!.displaySupportId),
    });
    const firstPlan = await lane.storage.readStructuredQuery(forward.context, list());
    const secondPlan = await backward.lane.storage.readStructuredQuery(backward.context, list());
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
        list({ filters: [{ field: "canonical_name", op: "eq", value: "Zeta" }] })
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
        { subject: "entity", resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: "s-a" },
      ],
    });
    const wide = await seed(openLane(), {
      sourceRefs: ["s-a", "s-b"],
      facts: [
        { subject: "entity", resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: "s-a" },
        { subject: "entity", resultId: OTHER, name: "Beta", entityType: "place", sourceRef: "s-b" },
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
        { subject: "entity", resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: "s-a" },
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
        { subject: "entity", resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: "s-a" },
        { subject: "entity", resultId: OTHER, name: "Beta", entityType: "organization", sourceRef: "s-a" },
      ],
    });
    const first = await lane.storage.readStructuredQuery(seeded.context, list({ limit: 1 }));
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
          identity: { kind: "entity", input: { entityId: ANCHOR, type: "organization" } },
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
        { subject: "entity", resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: "s-a" },
        { subject: "entity", resultId: OTHER, name: "Beta", entityType: "organization", sourceRef: "s-a" },
      ],
    });
    const first = await lane.storage.readStructuredQuery(seeded.context, list({ limit: 1 }));
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
    const first = await lane.storage.readStructuredQuery(seeded.context, list({ limit: 1 }));
    // Scheduling and settling a conflict check moves the durable-work ledger the
    // status counts, and touches no corpus row. That is PROGRESS: the read
    // revision stands, so a live cursor stays live.
    await advanceMaintenanceProgress(lane, seeded.sourceRefs[0]!, seeded.generations.get("s-a")!, [
      {
        sourceRef: seeded.sourceRefs[0]!,
        generation: seeded.generations.get("s-a")!,
        extractionRevision: 1,
        relationBuckets: [],
      },
    ]);
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
        { subject: "entity", resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: "s-a" },
        { subject: "entity", resultId: OTHER, name: "Beta", entityType: "organization", sourceRef: "s-a" },
      ],
    });
    await expectRefusal(
      () =>
        lane.storage.readStructuredQuery(seeded.context, list({ cursor: "not-a-cursor!!" })),
      "invalid_cursor"
    );
    const first = await lane.storage.readStructuredQuery(seeded.context, list({ limit: 1 }));
    // The SAME authority over the same scope, read on a clock eleven minutes
    // later. Only the instant differs, so the refusal observed is the expiry and
    // not a foreign context or a moved revision.
    const laterClock = () => new Date(INSTANT.getTime() + 11 * 60_000);
    const laterContext = lane.backend.structuredScopeUnitOfWork.createAuthorizedContext({
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
      undefined,
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
        { subject: "entity", resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: "s-a" },
      ],
    });
    // Two persisted check records in one scope that disagree on the ruleset are
    // exactly what an unreadable status row looks like to this reader: there is
    // no single status describing both.
    const disagreeing = new MemoryStructuredQueryStorage(
      lane.backend.structuredScopeUnitOfWork,
      tupleReaderOf(lane.identityStore),
      supportReaderOf(lane.backend),
      {
        readScreeningStatus: (_scopeBinding, sourceRefs) => sourceRefs.flatMap((sourceRef) => [
          { sourceRef, rulesetRevision: "ruleset-a", coverage: "coverage-a", retiredSupports: 0 },
          { sourceRef, rulesetRevision: "ruleset-b", coverage: "coverage-b", retiredSupports: 0 },
        ]),
      },
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

  it("refuses a context not minted by this composition", async () => {
    const lane = openLane();
    const other = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        { subject: "entity", resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: "s-a" },
      ],
    });
    await expectRefusal(
      () => other.storage.readStructuredQuery(seeded.context, list()),
      "authorization_denied"
    );
  });

  it("names endpoint display supports with their own grant role", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        { subject: "entity", resultId: ANCHOR, name: "Anchor", entityType: "organization", sourceRef: "s-a" },
        { subject: "entity", resultId: OTHER, name: "Other", entityType: "organization", sourceRef: "s-a" },
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
    expect(roles.has(STRUCTURED_QUERY_SUPPORT_ROLE.ENDPOINT_DISPLAY)).toBe(true);
  });

  it("refuses to project a row with no issued evidence reference", async () => {
    const lane = openLane();
    const seeded = await seed(lane, {
      sourceRefs: ["s-a"],
      facts: [
        { subject: "entity", resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: "s-a" },
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
        { subject: "entity", resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: "s-a" },
        { subject: "entity", resultId: OTHER, name: "Beta", entityType: "organization", sourceRef: "s-a" },
      ],
    });
    const listPlan = await lane.storage.readStructuredQuery(seeded.context, list());
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
});

void (0 as unknown as MaintenanceStatusInput);