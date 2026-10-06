/**
 * The strict PostgreSQL lane of the structured Query read contract.
 *
 * Every case runs against the real database: the real shared scope unit of work,
 * the real publication adapter, the real identity registry and the real
 * `assertion_supports` store. The strict driver never skips — an absent marker,
 * an absent DSN and an unreachable database are each named non-zero failures.
 *
 * It asserts the SAME cases as `tests/storage/structured-query-memory.test.ts`,
 * over the SAME `assembleRead`. What only this lane can prove is that the strict
 * side holds: one `REPEATABLE READ READ ONLY` snapshot, the column-level support
 * and tuple reads, and UUID byte order coming back out of PostgreSQL.
 */
import { createHash } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

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
import {
  deriveRelationAssertionId,
  normalizeRelationAssertion,
} from "../../src/core/structured/identity.js";
import { StructuredQueryError } from "../../src/core/structured/errors.js";
import type { ValidatedStructuredQuery } from "../../src/core/structured/request.js";
import {
  PgStructuredQueryStorage,
  STRUCTURED_QUERY_SUPPORT_ROLE,
  type StructuredQueryGrantPlan,
  type StructuredQueryStorage,
  structuredQueryReadOutcome,
} from "../../src/core/storage/structured-query-reads.js";
import { PgMaintenanceWorkStore } from "../../src/core/storage/maintenance-work-pg.js";
import {
  upSchemaScreening,
  upSchemaScreeningDecisions,
} from "../../src/core/storage/schema-screening.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import type {
  AuthorizedScopeContext,
  AuthorizedScopeUnitOfWork,
  ScopeTransactionOwner,
} from "../../src/core/storage/structured-scope-types.js";
import { createPublicationTestClock } from "../storage/publication-contract.js";
import { openStrictPgDriver, requireFullyRunnable } from "./strict-pg-driver.js";

const EXPECTED_COMMAND =
  "STRUCTURED_QUERY_PG=1 GRAPHRAG_MEMORY_DB_URL=<isolated-development-dsn> npx vitest run tests/acceptance/structured-query-pg.test.ts";
const SCHEMA_PREFIX = "structured_query";
const DIMENSIONS = 8;
const ACTOR = "query-pg-trusted-owner";
const AUTHORIZATION_REVISION = "auth-query-pg-1";
const PURGE_REVISION = "purge-1";
const CONFIG_REVISION = "extractor-v1";
const UNITS = 20;

const ANCHOR = "00000000-0000-4000-8000-00000000a001";
const OTHER = "00000000-0000-4000-8000-00000000a002";
const FAR = "00000000-0000-4000-8000-00000000a003";
const PAGE_IDS = [
  "00000000-0000-4000-8000-00000000b001",
  "00000000-0000-4000-8000-00000000b002",
  "00000000-0000-4000-8000-00000000b003",
] as const;

const driver = await openStrictPgDriver({
  envName: "STRUCTURED_QUERY_PG",
  testPath: "tests/acceptance/structured-query-pg.test.ts",
  expectedCommand: EXPECTED_COMMAND,
  label: "structured-query-pg",
  schemaPrefix: SCHEMA_PREFIX,
  dependency: "real PostgreSQL with pgvector",
});

const SCHEMA_URL = driver.schemaConnectionString;

let admin: pg.Client;
let backend: PgvectorBackend;
let pool: pg.Pool;
let publication: StructuredPublicationStorage;
let work: MaintenanceWorkStore;
let authority: AuthorizedScopeUnitOfWork & ScopeTransactionOwner;
let storage: StructuredQueryStorage;
let clock: ReturnType<typeof createPublicationTestClock>;
let serial = 0;

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

function opaqueDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

admin = driver.harness.createClient(SCHEMA_URL);
await admin.connect();
await driver.harness.resetSchema(admin);
backend = new PgvectorBackend(SCHEMA_URL, DIMENSIONS, { annMaxDimensions: 2000 });
await backend.initialize();
pool = new pg.Pool({ connectionString: SCHEMA_URL, max: 6 });
clock = createPublicationTestClock(new Date());
// The maintenance status is read from the persisted screening checks, so those
// tables are part of what this lane must have to answer a query at all.
await upSchemaScreening(pool);
await upSchemaScreeningDecisions(pool);
const composed = backend as PgvectorBackend & {
  structuredPublication?: StructuredPublicationStorage;
  structuredScopeUnitOfWork?: AuthorizedScopeUnitOfWork & ScopeTransactionOwner;
};
if (!composed.structuredPublication || !composed.structuredScopeUnitOfWork) {
  // EXIT: backend composition supplies neither the publication adapter nor the
  // shared scope authority. The module load throws before any suite can report,
  // so no case can publish through a surface composition does not own.
  throw new Error(
    "PgvectorBackend composition must supply the structured publication storage and the shared scope unit of work this lane drives"
  );
}
publication = composed.structuredPublication;
authority = composed.structuredScopeUnitOfWork;
work = new PgMaintenanceWorkStore(pool);
storage = new PgStructuredQueryStorage(authority, () => clock());

afterAll(async () => {
  await pool.end();
  await driver.dropOwnSchema(admin);
  await admin.end();
});

// ---------------------------------------------------------------------------
// Seeding through the real publication protocol
// ---------------------------------------------------------------------------

async function seedGraphEntities(entityIds: readonly string[]): Promise<void> {
  for (const entityId of entityIds) {
    await pool.query(
      `INSERT INTO entities (id, canonical_name, type, embedding, metadata, retired)
         VALUES ($1, $2, 'organization', NULL, '{}'::jsonb, false)
       ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type`,
      [entityId, `query fixture entity ${entityId}`]
    );
  }
}

async function registerVersion(
  sourceRef: string,
  sourceVersion: string,
  units: number
): Promise<{ readonly record: any; readonly locators: readonly any[] }> {
  const { record } = await backend.registerSourceVersion({
    source_ref: sourceRef,
    source_version: sourceVersion,
    content_digest: opaqueDigest(`${sourceRef}:${sourceVersion}`),
    origin_object_ref: `objects/${sourceRef}/${sourceVersion}.html`,
    parser_revision: "frozen-html-units-v1",
    unit_manifest: { units, parser_revision: "frozen-html-units-v1" },
    created_at: clock().toISOString(),
  });
  const locators = Array.from({ length: units }, (_, index) => ({
    source_version_id: record.source_version_id,
    document_id: `${sourceRef}-document`,
    version: `frozen-${sourceVersion}`,
    unit: index + 1,
  }));
  for (const locator of locators) await backend.bindSourceLocator(locator);
  return { record, locators };
}

async function declare(
  scopeBinding: string,
  sourceRef: string,
  sourceVersion: string,
  authorizedSourceRefs: readonly string[],
  units: number,
  extractionRevision = 1
): Promise<number> {
  const { record, locators } = await registerVersion(sourceRef, sourceVersion, units);
  const declared = await publication.declareDesired({
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

function contextFor(
  scopeBinding: string,
  authorizedSourceRefs: readonly string[]
): AuthorizedScopeContext {
  return authority.createAuthorizedContext({
    actorId: ACTOR,
    ownerScopeBinding: scopeBinding,
    readerBinding: scopeBinding,
    authorizedSourceRefs,
    authorizationRevision: AUTHORIZATION_REVISION,
    deadlineAt: new Date(clock().getTime() + 60_000).toISOString(),
  });
}

function extractDependencies(
  sourceRef: string,
  generation: number,
  extractionRevision: number | null = null
): readonly MaintenanceDependency[] {
  return [{ sourceRef, generation, extractionRevision, relationBuckets: [] }];
}

async function claimOwnAttempt(input: {
  readonly workKind: MaintenanceWorkKind;
  readonly sourceRef: string;
  readonly sourceVersion?: string;
  readonly generation: number;
  readonly dependencies: readonly MaintenanceDependency[];
}): Promise<MaintenanceAttemptGuard> {
  const scheduled = await scheduleWork(
    { store: work, clock },
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
    throw new Error(`query pg fixture schedule refused: ${scheduled.refused}`);
  }
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const claimed = await claimNextWork({ store: work, clock });
    if (claimed.guard === null) break;
    if (claimed.guard.jobKey === scheduled.record.jobKey) return claimed.guard;
    // EXIT: the queue offered a foreign job and this lane cannot release it. The
    // fixture throws rather than settling a job the case did not arrange.
    throw new Error(
      `query pg fixture claimed a foreign job first: ${claimed.guard.jobKey} instead of ${scheduled.record.jobKey}`
    );
  }
  throw new Error("query pg fixture could not claim its own job");
}

async function publishOne(input: {
  readonly scopeBinding: string;
  readonly sourceRef: string;
  readonly sourceVersion?: string;
  readonly generation: number;
  readonly accepted: readonly PublicationFact[];
  readonly extractionRef: string;
  readonly dependencyExtractionRevision?: number | null;
}): Promise<void> {
  const dependencies = extractDependencies(
    input.sourceRef,
    input.generation,
    input.dependencyExtractionRevision ?? null
  );
  const guard = await claimOwnAttempt({
    workKind: "extract_publish",
    sourceRef: input.sourceRef,
    sourceVersion: input.sourceVersion,
    generation: input.generation,
    dependencies,
  });
  await publication.stageAttempt({
    scopeBinding: input.scopeBinding,
    sourceRef: input.sourceRef,
    guard,
    extractionRef: input.extractionRef,
    accepted: input.accepted,
  });
  await publication.publish({
    scopeBinding: input.scopeBinding,
    sourceRef: input.sourceRef,
    guard,
    at: clock().toISOString(),
  });
  const settled = await settleWork(
    { store: work, clock },
    guard,
    { status: "ready" },
    { configRevision: CONFIG_REVISION, dependencies }
  );
  if ("refused" in settled && settled.refused !== undefined) {
    throw new Error(`query pg fixture settle refused: ${settled.refused}`);
  }
}

interface SeedSpec {
  readonly label: string;
  readonly facts: readonly {
    readonly resultId: string;
    readonly name: string;
    readonly entityType: string;
    readonly sourceRef: string;
  }[];
  readonly relations?: readonly {
    readonly head: string;
    readonly relationNorm: string;
    readonly tail: string;
    readonly sourceRef: string;
    readonly validFrom: string | null;
    readonly validUntil: string | null;
  }[];
}

interface Seeded {
  readonly scopeBinding: string;
  readonly context: AuthorizedScopeContext;
  readonly sourceRefs: readonly string[];
  readonly generations: ReadonlyMap<string, number>;
  readonly assertionIds: readonly string[];
  extraSourceRef(): string;
}

async function seed(spec: SeedSpec): Promise<Seeded> {
  await seedGraphEntities([
    ANCHOR,
    OTHER,
    FAR,
    ...PAGE_IDS,
    ...spec.facts.map((fact) => fact.resultId),
  ]);
  const scopeBinding = unique(`query-pg-scope-${spec.label}`);
  await backend.setScopeRevisions(scopeBinding, {
    authorizationRevision: AUTHORIZATION_REVISION,
    purgeRevision: PURGE_REVISION,
  });
  // The durable-work ledger is one shared queue whose claims cannot be released,
  // so a job a previous case left pending would be claimed by this one.
  await pool.query("DELETE FROM maintenance_jobs");
  const sourceRefs = [...new Set([
    ...spec.facts.map((fact) => fact.sourceRef),
    ...(spec.relations ?? []).map((relation) => relation.sourceRef),
  ])];
  const generations = new Map<string, number>();
  const extractionRefs = new Map<string, string>();
  for (const sourceRef of sourceRefs) {
    generations.set(
      sourceRef,
      await declare(scopeBinding, sourceRef, "v1", sourceRefs, UNITS)
    );
    extractionRefs.set(sourceRef, `${sourceRef}-extraction`);
  }
  const unitCursor = new Map<string, number>();
  const nextUnit = (sourceRef: string): number => {
    const current = unitCursor.get(sourceRef) ?? 0;
    unitCursor.set(sourceRef, current + 1);
    return current + 1;
  };
  const assertionIds: string[] = [];
  const bySource = new Map<string, PublicationFact[]>();
  for (const sourceRef of sourceRefs) bySource.set(sourceRef, []);
  for (const fact of spec.facts) {
    const unit = nextUnit(fact.sourceRef);
    bySource.get(fact.sourceRef)!.push({
      identity: { kind: "entity", input: { entityId: fact.resultId, type: fact.entityType } },
      occurrence: {
        subject: "entity",
        result_id: fact.resultId,
        source_ref: fact.sourceRef,
        source_version: "v1",
        location: {
          document_id: `${fact.sourceRef}-document`,
          version: "frozen-v1",
          unit,
        },
        span: { start: unit * 4, end: unit * 4 + 3 },
        extraction_ref: extractionRefs.get(fact.sourceRef)!,
        extractedAt: clock().toISOString(),
      },
      display: { canonicalName: fact.name, type: fact.entityType },
    });
  }
  for (const relation of spec.relations ?? []) {
    const input = {
      headEntityId: relation.head,
      relationNorm: relation.relationNorm,
      tailEntityId: relation.tail,
      validWindow: { from: relation.validFrom, until: relation.validUntil },
    };
    // The assertion id IS its exact tuple, so the reader is handed the same
    // derived UUID the publication lane stored.
    const assertionId = deriveRelationAssertionId(normalizeRelationAssertion(input));
    assertionIds.push(assertionId);
    const unit = nextUnit(relation.sourceRef);
    bySource.get(relation.sourceRef)!.push({
      identity: { kind: "relation_assertion", input },
      occurrence: {
        subject: "assertion",
        result_id: assertionId,
        source_ref: relation.sourceRef,
        source_version: "v1",
        location: {
          document_id: `${relation.sourceRef}-document`,
          version: "frozen-v1",
          unit,
        },
        span: { start: unit * 4, end: unit * 4 + 3 },
        extraction_ref: extractionRefs.get(relation.sourceRef)!,
        extractedAt: clock().toISOString(),
      },
    });
  }
  for (const sourceRef of sourceRefs) {
    const accepted = bySource.get(sourceRef)!;
    if (accepted.length === 0) continue;
    await publishOne({
      scopeBinding,
      sourceRef,
      generation: generations.get(sourceRef)!,
      accepted,
      extractionRef: extractionRefs.get(sourceRef)!,
    });
  }
  return {
    scopeBinding,
    context: contextFor(scopeBinding, sourceRefs),
    sourceRefs,
    generations,
    assertionIds,
    extraSourceRef: () => unique("query-pg-extra"),
  };
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
    if ((error as StructuredQueryError).code !== code) {
      throw new Error(
        `refusal detail: ${(error as StructuredQueryError).message}`
      );
    }
    expect((error as StructuredQueryError).code).toBe(code);
    return;
  }
  throw new Error(`expected refusal ${code}, but the read succeeded`);
}

// ---------------------------------------------------------------------------
// Cases, shared verbatim with the memory lane
// ---------------------------------------------------------------------------

describe("structured query strict PostgreSQL", () => {
  it("returns one row per authorized subject when two sources support it", async () => {
    const seeded = await seed({
      label: "one-row",
      facts: [
        { resultId: ANCHOR, name: "Widget", entityType: "organization", sourceRef: unique("multi-a") },
        { resultId: ANCHOR, name: "Widget", entityType: "organization", sourceRef: unique("multi-b") },
      ],
    });
    const plan = await storage.readStructuredQuery(seeded.context, list());
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]!.supports).toHaveLength(2);
  });

  it("orders rows ascending by UUID bytes", async () => {
    const sourceRef = unique("order");
    const seeded = await seed({
      label: "order",
      facts: [
        { resultId: OTHER, name: "Beta", entityType: "organization", sourceRef },
        { resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef },
      ],
    });
    const plan = await storage.readStructuredQuery(seeded.context, list());
    expect(plan.rows.map((row) => row.id)).toEqual([ANCHOR, OTHER]);
  });

  it("continues a second page with no gap and no duplicate", async () => {
    const sourceRef = unique("paging");
    const seeded = await seed({
      label: "paging",
      facts: PAGE_IDS.map((id, index) => ({
        resultId: id,
        name: `E${index}`,
        entityType: "organization",
        sourceRef,
      })),
    });
    const first = await storage.readStructuredQuery(seeded.context, list({ limit: 2 }));
    expect(first.rows.map((row) => row.id)).toEqual(PAGE_IDS.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();
    const second = await storage.readStructuredQuery(
      seeded.context,
      list({ limit: 2, cursor: first.nextCursor! })
    );
    expect(second.rows.map((row) => row.id)).toEqual(PAGE_IDS.slice(2));
    expect(second.nextCursor).toBeNull();
  });

  it("applies exact eq and in filters, AND-combined", async () => {
    const sourceRef = unique("filters");
    const seeded = await seed({
      label: "filters",
      facts: [
        { resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef },
        { resultId: OTHER, name: "Beta", entityType: "place", sourceRef },
      ],
    });
    const byName = await storage.readStructuredQuery(
      seeded.context,
      list({ filters: [{ field: "canonical_name", op: "eq", value: "Alpha" }] })
    );
    expect(byName.rows.map((row) => row.id)).toEqual([ANCHOR]);
    const byTypeIn = await storage.readStructuredQuery(
      seeded.context,
      list({ filters: [{ field: "type", op: "in", values: ["organization", "place"] }] })
    );
    expect(byTypeIn.rows).toHaveLength(2);
    const anded = await storage.readStructuredQuery(
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
    const sourceRef = unique("one-hop");
    const seeded = await seed({
      label: "one-hop",
      facts: [
        { resultId: ANCHOR, name: "Anchor", entityType: "organization", sourceRef },
        { resultId: OTHER, name: "Other", entityType: "organization", sourceRef },
        { resultId: FAR, name: "Far", entityType: "organization", sourceRef },
      ],
      relations: [
        { head: ANCHOR, relationNorm: "owns", tail: OTHER, sourceRef, validFrom: null, validUntil: null },
        { head: OTHER, relationNorm: "owns", tail: FAR, sourceRef, validFrom: null, validUntil: null },
      ],
    });
    const outgoing = await storage.readStructuredQuery(
      seeded.context,
      list({
        subject: "relation_assertion",
        relationship: { anchorEntityId: ANCHOR, direction: "outgoing" },
      })
    );
    expect(outgoing.rows.map((row) => row.id)).toEqual([seeded.assertionIds[0]]);
    const incoming = await storage.readStructuredQuery(
      seeded.context,
      list({
        subject: "relation_assertion",
        relationship: { anchorEntityId: FAR, direction: "incoming" },
      })
    );
    expect(incoming.rows.map((row) => row.id)).toEqual([seeded.assertionIds[1]]);
  });

  it("keeps past and future validity windows visible and countable", async () => {
    const sourceRef = unique("windows");
    const seeded = await seed({
      label: "windows",
      facts: [
        { resultId: ANCHOR, name: "Anchor", entityType: "organization", sourceRef },
        { resultId: OTHER, name: "Other", entityType: "organization", sourceRef },
      ],
      relations: [
        {
          head: ANCHOR,
          relationNorm: "past_only",
          tail: OTHER,
          sourceRef,
          validFrom: "1999-01-01T00:00:00.000Z",
          validUntil: "2000-01-01T00:00:00.000Z",
        },
        {
          head: ANCHOR,
          relationNorm: "future_only",
          tail: OTHER,
          sourceRef,
          validFrom: "2999-01-01T00:00:00.000Z",
          validUntil: null,
        },
      ],
    });
    const plan = await storage.readStructuredQuery(
      seeded.context,
      list({ subject: "relation_assertion" })
    );
    expect(plan.rows).toHaveLength(2);
    const counted = await storage.readStructuredQuery(
      seeded.context,
      list({ subject: "relation_assertion", operation: "count" })
    );
    expect(counted.count).toBe(2);
  });

  it("does not multiply relation rows or count by source multiplicity", async () => {
    const sourceRef = unique("relation-multiplicity");
    const seeded = await seed({
      label: "relation-multiplicity",
      facts: [
        { resultId: ANCHOR, name: "Anchor", entityType: "organization", sourceRef },
        { resultId: OTHER, name: "Other", entityType: "organization", sourceRef },
      ],
      relations: [
        { head: ANCHOR, relationNorm: "owns", tail: OTHER, sourceRef, validFrom: null, validUntil: null },
      ],
    });
    const rows = await storage.readStructuredQuery(
      seeded.context,
      list({ subject: "relation_assertion" })
    );
    const counted = await storage.readStructuredQuery(
      seeded.context,
      list({ subject: "relation_assertion", operation: "count" })
    );
    expect(rows.rows).toHaveLength(1);
    expect(counted.count).toBe(1);
  });

  it("keeps the attributed display invariant to source arrival order", async () => {
    const forwardRef = unique("arrival-forward");
    const backwardRef = unique("arrival-backward");
    const forward = await seed({
      label: "arrival-forward",
      facts: [
        { resultId: ANCHOR, name: "Zeta", entityType: "organization", sourceRef: forwardRef },
        { resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: forwardRef },
      ],
    });
    const backward = await seed({
      label: "arrival-backward",
      facts: [
        { resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: backwardRef },
        { resultId: ANCHOR, name: "Zeta", entityType: "organization", sourceRef: backwardRef },
      ],
    });
    const firstPlan = await storage.readStructuredQuery(forward.context, list());
    const secondPlan = await storage.readStructuredQuery(backward.context, list());
    expect(firstPlan.rows[0]!.canonicalName).toBe("Alpha");
    expect(secondPlan.rows[0]!.canonicalName).toBe("Alpha");
    // The chosen support must be one of the row's own current supports, and the
    // disagreement two distinct display values represent must be declared.
    expect(
      firstPlan.rows[0]!.supports.some(
        (support) => support.supportId === firstPlan.rows[0]!.displaySupportId
      )
    ).toBe(true);
    expect(firstPlan.rows[0]!.displayDisagreement).toBe(true);
    expect(secondPlan.rows[0]!.displayDisagreement).toBe(true);
    // The exact-filter predicate sees the same chosen pair in both orders.
    const byName = await storage.readStructuredQuery(
      forward.context,
      list({ filters: [{ field: "canonical_name", op: "eq", value: "Zeta" }] })
    );
    expect(byName.rows).toHaveLength(0);
  });

  it("gives a different authorized support set only its own values and exact matches", async () => {
    const narrowRef = unique("scope-narrow");
    const wideA = unique("scope-wide-a");
    const wideB = unique("scope-wide-b");
    const narrow = await seed({
      label: "scope-narrow",
      facts: [{ resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: narrowRef }],
    });
    const wide = await seed({
      label: "scope-wide",
      facts: [
        { resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: wideA },
        { resultId: OTHER, name: "Beta", entityType: "place", sourceRef: wideB },
      ],
    });
    const narrowPlan = await storage.readStructuredQuery(
      narrow.context,
      list({ filters: [{ field: "canonical_name", op: "eq", value: "Beta" }] })
    );
    expect(narrowPlan.rows).toHaveLength(0);
    const widePlan = await storage.readStructuredQuery(
      wide.context,
      list({ filters: [{ field: "canonical_name", op: "eq", value: "Beta" }] })
    );
    expect(widePlan.rows.map((row) => row.id)).toEqual([OTHER]);
  });

  it("counts the complete distinct set, including zero and more than one page", async () => {
    const sourceRef = unique("count");
    const seeded = await seed({
      label: "count",
      facts: PAGE_IDS.map((id, index) => ({
        resultId: id,
        name: `E${index}`,
        entityType: "organization",
        sourceRef,
      })),
    });
    const noMatch = await storage.readStructuredQuery(
      seeded.context,
      list({
        operation: "count",
        filters: [{ field: "canonical_name", op: "eq", value: "Nope" }],
      })
    );
    expect(noMatch.count).toBe(0);
    const counted = await storage.readStructuredQuery(
      seeded.context,
      list({ operation: "count" })
    );
    expect(counted.count).toBe(PAGE_IDS.length);
    const paged = await storage.readStructuredQuery(seeded.context, list({ limit: 1 }));
    expect(paged.rows).toHaveLength(1);
    expect(paged.nextCursor).not.toBeNull();
  });

  it("refuses a cursor whose read revision moved", async () => {
    const sourceRef = unique("cursor-revision");
    const seeded = await seed({
      label: "cursor-revision",
      facts: [
        { resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef },
        { resultId: OTHER, name: "Beta", entityType: "organization", sourceRef },
      ],
    });
    const first = await storage.readStructuredQuery(seeded.context, list({ limit: 1 }));
    // Publishing a second desired version is a DATA change: the row set the
    // cursor was walking is no longer the set this revision holds.
    const generation = await declare(
      seeded.scopeBinding,
      sourceRef,
      "v2",
      seeded.sourceRefs,
      UNITS,
      2
    );
    await publishOne({
      scopeBinding: seeded.scopeBinding,
      sourceRef,
      sourceVersion: "v2",
      generation,
      extractionRef: `${sourceRef}-extraction-v2`,
      dependencyExtractionRevision: 1,
      accepted: [
        {
          identity: { kind: "entity", input: { entityId: OTHER, type: "organization" } },
          occurrence: {
            subject: "entity",
            result_id: OTHER,
            source_ref: sourceRef,
            source_version: "v2",
            location: {
              document_id: `${sourceRef}-document`,
              version: "frozen-v2",
              unit: UNITS,
            },
            span: { start: 76, end: 79 },
            extraction_ref: `${sourceRef}-extraction-v2`,
            extractedAt: clock().toISOString(),
          },
          display: { canonicalName: "Beta", type: "organization" },
        },
      ],
    });
    await expectRefusal(
      () =>
        storage.readStructuredQuery(
          seeded.context,
          list({ limit: 1, cursor: first.nextCursor! })
        ),
      "cursor_revision_mismatch"
    );
  });

  it("refuses a cursor issued for a different query", async () => {
    const sourceRef = unique("cursor-query");
    const seeded = await seed({
      label: "cursor-query",
      facts: [
        { resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef },
        { resultId: OTHER, name: "Beta", entityType: "organization", sourceRef },
      ],
    });
    const first = await storage.readStructuredQuery(seeded.context, list({ limit: 1 }));
    await expectRefusal(
      () =>
        storage.readStructuredQuery(
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
    const sourceRef = unique("cursor-progress");
    const ids = PAGE_IDS.slice(0, 2);
    const seeded = await seed({
      label: "cursor-progress",
      facts: ids.map((id, index) => ({
        resultId: id,
        name: `E${index}`,
        entityType: "organization",
        sourceRef,
      })),
    });
    const first = await storage.readStructuredQuery(seeded.context, list({ limit: 1 }));
    // A conflict-check job moves the durable-work ledger the status counts and
    // touches no corpus row. That is PROGRESS, so the read revision stands.
    const dependencies = extractDependencies(
      sourceRef,
      seeded.generations.get(sourceRef)!,
      1
    );
    await claimOwnAttempt({
      workKind: "conflict_check",
      sourceRef,
      generation: seeded.generations.get(sourceRef)!,
      dependencies,
    });
    const second = await storage.readStructuredQuery(
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
    const sourceRef = unique("cursor-refusal");
    const seeded = await seed({
      label: "cursor-refusal",
      facts: [
        { resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef },
        { resultId: OTHER, name: "Beta", entityType: "organization", sourceRef },
      ],
    });
    await expectRefusal(
      () => storage.readStructuredQuery(seeded.context, list({ cursor: "not-a-cursor!!" })),
      "invalid_cursor"
    );
    const first = await storage.readStructuredQuery(seeded.context, list({ limit: 1 }));
    // The same scope and authority, read eleven minutes later. Only the instant
    // differs, so the refusal observed is the expiry.
    clock.advance(11 * 60_000);
    await expectRefusal(
      () =>
        storage.readStructuredQuery(seeded.context, list({ limit: 1, cursor: first.nextCursor! })),
      "cursor_expired"
    );
  });

  it("refuses when the maintenance status is unavailable", async () => {
    const sourceRef = unique("status-unavailable");
    const seeded = await seed({
      label: "status-unavailable",
      facts: [{ resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef }],
    });
    // Two persisted check records in one scope that disagree on the ruleset are
    // exactly what an unreadable status row looks like to this reader.
    await pool.query(
      `INSERT INTO structured_screening_checks
         (check_id, scope_binding, job_key, source_ref, ruleset_revision, coverage,
          relation_catalog_version, relation_buckets, input_revision,
          assertion_count, candidate_count, published_at)
       VALUES (gen_random_uuid(), $1, 'job-a', $2, 'ruleset-a', 'coverage-a',
               0, '[]'::jsonb, 'rev-a', 0, 0, now()),
              (gen_random_uuid(), $1, 'job-b', $2, 'ruleset-b', 'coverage-b',
               0, '[]'::jsonb, 'rev-b', 0, 0, now())`,
      [seeded.scopeBinding, sourceRef]
    );
    await expectRefusal(
      () => storage.readStructuredQuery(seeded.context, list()),
      "maintenance_status_unavailable"
    );
  });

  it("refuses when a mandatory row cannot fit the envelope", async () => {
    const sourceRef = unique("too-large");
    const seeded = await seed({
      label: "too-large",
      facts: [
        { resultId: ANCHOR, name: "x".repeat(64 * 1024), entityType: "organization", sourceRef },
      ],
    });
    await expectRefusal(
      () => storage.readStructuredQuery(seeded.context, list()),
      "result_too_large"
    );
  });

  it("refuses a context not minted by this composition", async () => {
    const sourceRef = unique("foreign-context");
    const seeded = await seed({
      label: "foreign-context",
      facts: [{ resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef }],
    });
    // The same context text, assembled structurally rather than minted here.
    const forged = { ...seeded.context } as AuthorizedScopeContext;
    await expectRefusal(
      () => storage.readStructuredQuery(forged, list()),
      "authorization_denied"
    );
  });

  it("names endpoint display supports with their own grant role", async () => {
    const sourceRef = unique("grant-roles");
    const seeded = await seed({
      label: "grant-roles",
      facts: [
        { resultId: ANCHOR, name: "Anchor", entityType: "organization", sourceRef },
        { resultId: OTHER, name: "Other", entityType: "organization", sourceRef },
      ],
      relations: [
        { head: ANCHOR, relationNorm: "owns", tail: OTHER, sourceRef, validFrom: null, validUntil: null },
      ],
    });
    const plan = await storage.readStructuredQuery(
      seeded.context,
      list({ subject: "relation_assertion" })
    );
    const roles = new Set(plan.grants[0]!.supports.map((ref) => ref.role));
    expect(roles.has(STRUCTURED_QUERY_SUPPORT_ROLE.OCCURRENCE)).toBe(true);
    expect(roles.has(STRUCTURED_QUERY_SUPPORT_ROLE.ENDPOINT_DISPLAY)).toBe(true);
  });

  it("reads rows and count from one snapshot without advancing a revision", async () => {
    const sourceRef = unique("one-snapshot");
    const seeded = await seed({
      label: "one-snapshot",
      facts: [
        { resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef },
        { resultId: OTHER, name: "Beta", entityType: "organization", sourceRef },
      ],
    });
    const before = await readScopeRevisions(seeded.scopeBinding);
    const rows = await storage.readStructuredQuery(seeded.context, list());
    const counted = await storage.readStructuredQuery(seeded.context, list({ operation: "count" }));
    // The read is READ ONLY: it must leave the scope's own revisions alone, which
    // is exactly what the free `withAuthorizedScope` would have broken.
    expect(await readScopeRevisions(seeded.scopeBinding)).toEqual(before);
    expect(rows.readRevision).toBe(counted.readRevision);
    expect(rows.readRevision).toBe(before.read_revision);
    expect(counted.count).toBe(rows.rows.length);
    expect(rows.maintenance.maintenanceRevision).toBe(counted.maintenance.maintenanceRevision);
  });

  it("refuses to project a row with no issued evidence reference", async () => {
    const sourceRef = unique("unissued");
    const seeded = await seed({
      label: "unissued",
      facts: [{ resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef }],
    });
    const plan = await storage.readStructuredQuery(seeded.context, list());
    await expectRefusal(
      async () => structuredQueryReadOutcome(plan, []),
      "structured_search_unavailable"
    );
  });

  it("carries one row grant per row and exactly one count grant", async () => {
    const sourceRef = unique("grant-shape");
    const seeded = await seed({
      label: "grant-shape",
      facts: [
        { resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef },
        { resultId: OTHER, name: "Beta", entityType: "organization", sourceRef },
      ],
    });
    const listPlan = await storage.readStructuredQuery(seeded.context, list());
    expect(listPlan.grants).toHaveLength(2);
    const countPlan = await storage.readStructuredQuery(
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

async function readScopeRevisions(scopeBinding: string): Promise<{
  readonly read_revision: string;
  readonly maintenance_revision: string;
}> {
  const { rows } = await pool.query(
    `SELECT read_revision, maintenance_revision
       FROM structured_publication_scopes WHERE scope_binding = $1`,
    [scopeBinding]
  );
  return rows[0] as { read_revision: string; maintenance_revision: string };
}

requireFullyRunnable({
  caseId: "structured-query-pg",
  expectedCommand: EXPECTED_COMMAND,
  owner: "T-query-read",
  entries: [],
});