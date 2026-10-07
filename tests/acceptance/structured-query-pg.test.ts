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
import { createHash, randomBytes } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

import { buildStructuredQueryReader } from "../../src/index.js";

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
import {
  QUERY_SCOPE_ENV_VARS,
  queryScopeIdentityFromEnv,
  type QueryScopeIdentity,
} from "../../src/core/storage/structured-query-scope.js";
import {
  buildStructuredResult,
  STRUCTURED_RESULT_COUNT_COVERAGE,
  STRUCTURED_RESULT_EVIDENCE_REF_PLACEHOLDER,
  STRUCTURED_RESULT_MAX_BYTES,
  structuredResultEnvelopeBytes,
  type StructuredListRead,
  type StructuredMaintenanceRecord,
  type StructuredQueryReader,
  type StructuredRelationRowRecord,
} from "../../src/core/structured/result.js";
import {
  EVIDENCE_DENIAL_REASON,
  EVIDENCE_GRANT_KIND,
  type EvidenceGrantRead,
} from "../../src/core/types.js";
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

/** This lane's own cursor key; the cases below only ever present cursors to the reader. */
const CURSOR_KEY = randomBytes(32);

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

function opaqueDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Constructed inline rather than through the shared harness so the CI
// exclude guard, which recognises a postgres lane by `new pg.Client(`, can see
// this file. A lane the guard cannot see is a lane `test-fast` would run
// without a database, and this one refuses rather than skips.
admin = new pg.Client({ connectionString: SCHEMA_URL });
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
storage = new PgStructuredQueryStorage(authority, CURSOR_KEY, () => clock());

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
 * The payload text of a cursor, with any signature discarded. Signing is what the
 * reader checks, so a FORGED cursor is one whose signature does not cover the
 * payload it now carries.
 */
function cursorBody(raw: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(raw.split(".")[0]!, "base64url").toString("utf8")
  ) as Record<string, unknown>;
}

/**
 * A cursor whose payload the caller rewrote, keeping the original signature:
 * the honest shape of an attacker's edit.
 */
function tamperCursor(raw: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const separator = raw.indexOf(".");
  return separator < 0 ? body : `${body}.${raw.slice(separator + 1)}`;
}

/** A cursor carrying exactly the payload a caller chose, and nothing else. */
function forgeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function envelopeBytes(
  request: ValidatedStructuredQuery,
  plan: {
    readonly queryDigest: string;
    readonly scopeBinding: string;
    readonly readRevision: string;
    readonly maintenance: StructuredMaintenanceRecord;
    readonly rows: readonly Record<string, unknown>[];
    readonly nextCursor: string | null;
  },
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
  plan: Awaited<ReturnType<StructuredQueryStorage["readStructuredQuery"]>>,
  now: Date
): string {
  const issued = plan.rows.map(() => STRUCTURED_RESULT_EVIDENCE_REF_PLACEHOLDER);
  return JSON.stringify(
    buildStructuredResult(request, structuredQueryReadOutcome(plan, issued), now)
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
        conflictChecks: { pending: 0, running: 0, ready: 1, failed: 0, stale: 0 },
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

/** One page is twenty rows: the fixtures that must span pages need more ids. */
function manyIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) =>
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
  );
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

  // -------------------------------------------------------------------------
  // Envelope bound at row boundaries
  // -------------------------------------------------------------------------

  it("bounds a collectively oversized page to a resumable prefix at row boundaries", async () => {
    // Eight sources behind every one of twenty rows: the page is collectively far
    // over the envelope, and only a row-boundary cut keeps the remainder
    // reachable. A single oversized row would be `result_too_large` instead.
    const ids = manyIds(20);
    const sourceRefs = ["sq-fat-1", "sq-fat-2", "sq-fat-3", "sq-fat-4", "sq-fat-5", "sq-fat-6", "sq-fat-7", "sq-fat-8"];
    const seeded = await seed({
      label: "envelope-bound",
      facts: ids.flatMap((resultId) =>
        sourceRefs.map((sourceRef) => ({ resultId, name: "Widget", entityType: "organization", sourceRef }))
      ),
    });

    const first = await storage.readStructuredQuery(seeded.context, list());
    expect(first.rows.length).toBeGreaterThan(0);
    expect(first.rows.length).toBeLessThan(ids.length);
    expect(first.rows.map((row) => row.id)).toEqual(ids.slice(0, first.rows.length));
    expect(first.nextCursor).not.toBeNull();

    const emitted = emittedEnvelope(list(), first, clock());
    expect(Buffer.byteLength(emitted, "utf8")).toBeLessThanOrEqual(STRUCTURED_RESULT_MAX_BYTES);

    const second = await storage.readStructuredQuery(
      seeded.context,
      list({ cursor: first.nextCursor! })
    );
    expect(second.rows.length).toBeGreaterThan(0);
    const walked = [...first.rows, ...second.rows];
    expect(walked.map((row) => row.id)).toEqual(ids);
    expect(new Set(walked.map((row) => row.id)).size).toBe(ids.length);

    // The cut is the minimum one, measured with the cursor a 14-row page would
    // actually CARRY — a probe read stopping after one row mints exactly that.
    const probe = await storage.readStructuredQuery(
      seeded.context,
      list({ limit: 1, cursor: first.nextCursor! })
    );
    expect(probe.rows[0]!.id).toBe(ids[first.rows.length]);
    const oneMore = {
      ...first,
      rows: [...first.rows, probe.rows[0]!],
      nextCursor: probe.nextCursor,
    };
    expect(envelopeBytes(list(), oneMore, clock())).toBeGreaterThan(STRUCTURED_RESULT_MAX_BYTES);
  });

  // -------------------------------------------------------------------------
  // Cursor authenticity
  // -------------------------------------------------------------------------

  it("refuses a hand-built cursor and a rewritten position, but continues a real one", async () => {
    const sourceRef = unique("cursor-auth");
    const ids = manyIds(3);
    const seeded = await seed({
      label: "cursor-auth",
      facts: ids.map((resultId, index) => ({
        resultId,
        name: `E${index}`,
        entityType: "organization",
        sourceRef,
      })),
    });
    const first = await storage.readStructuredQuery(seeded.context, list({ limit: 1 }));
    const real = first.nextCursor!;
    const payload = cursorBody(real);

    // A hand-built cursor whose every field is correct; nothing is wrong with it
    // except that this build never signed it.
    await expectRefusal(
      () => storage.readStructuredQuery(seeded.context, list({ limit: 1, cursor: forgeCursor(payload) })),
      "invalid_cursor"
    );

    // The same edit an attacker makes: decode, move the position onto a row in
    // the middle of the set, re-encode. Every field the transaction checks still
    // agrees; only the position was rewritten.
    await expectRefusal(
      () => storage.readStructuredQuery(seeded.context, list({ limit: 1, cursor: tamperCursor(real, { ...payload, aft: ids[1]! }) })),
      "invalid_cursor"
    );

    // A position that is not even an id. Unverified it sorts AFTER every real
    // row, so the read resumes past the whole set and answers a successful EMPTY
    // page — indistinguishable from a genuinely empty result.
    await expectRefusal(
      () => storage.readStructuredQuery(seeded.context, list({ limit: 1, cursor: tamperCursor(real, { ...payload, aft: "garbage" }) })),
      "invalid_cursor"
    );

    // NEGATIVE CONTROL: the untouched cursor still continues, so the three
    // refusals above cannot be passing because every cursor is refused.
    const second = await storage.readStructuredQuery(seeded.context, list({ limit: 1, cursor: real }));
    expect(second.rows.map((row) => row.id)).toEqual(ids.slice(1, 2));
  });

  it("carries the first page's expiry onto every later page's cursor", async () => {
    const sourceRef = unique("cursor-expiry");
    const ids = manyIds(3);
    const seeded = await seed({
      label: "cursor-expiry",
      facts: ids.map((resultId, index) => ({
        resultId,
        name: `E${index}`,
        entityType: "organization",
        sourceRef,
      })),
    });
    const first = await storage.readStructuredQuery(seeded.context, list({ limit: 1 }));
    const second = await storage.readStructuredQuery(
      seeded.context,
      list({ limit: 1, cursor: first.nextCursor! })
    );
    expect(second.rows.map((row) => row.id)).toEqual(ids.slice(1, 2));
    // Carried forward, not re-opened: a renewed expiry would make the fixed
    // ten-minute window a rolling one that no test reading page one would see.
    expect(cursorBody(second.nextCursor!).exp).toBe(cursorBody(first.nextCursor!).exp);
  });

  // -------------------------------------------------------------------------
  // Count over more than one page
  // -------------------------------------------------------------------------

  it("counts every distinct id walking all pages yields, not one page's rows", async () => {
    const sourceRefs = ["sq-count-a", "sq-count-b"];
    const ids = manyIds(25);
    const seeded = await seed({
      label: "count-across-pages",
      facts: ids.map((resultId, index) => ({
        resultId,
        name: `E${index}`,
        entityType: "organization",
        sourceRef: index % 2 === 0 ? sourceRefs[0]! : sourceRefs[1]!,
      })),
    });
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const read = await storage.readStructuredQuery(
        seeded.context,
        list(cursor === null ? {} : { cursor })
      );
      walked.push(...read.rows.map((row) => row.id));
      cursor = read.nextCursor;
      if (cursor === null) break;
    }
    expect(new Set(walked).size).toBe(walked.length);
    expect(walked.length).toBeGreaterThan(20);
    const counted = await storage.readStructuredQuery(seeded.context, list({ operation: "count" }));
    expect(counted.count).toBe(walked.length);
    expect(counted.count).toBe(new Set(walked).size);
  });

  // -------------------------------------------------------------------------
  // Reader lease
  // -------------------------------------------------------------------------

  it("refuses a read whose clock has passed the execution lease, and answers one inside it", async () => {
    const sourceRef = unique("lease");
    const seeded = await seed({
      label: "lease",
      facts: [{ resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef }],
    });
    // The reader stamps its start and its page from the SAME injected clock, so a
    // clock that advances past the lease between the two readings is the whole
    // condition. The shared authority keeps its own clock, so only the reader's
    // lease can fire.
    const start = clock().getTime();
    const late = new PgStructuredQueryStorage(authority, CURSOR_KEY, (() => {
      let reading = 0;
      return () => new Date(start + (reading++ === 0 ? 0 : 61_000));
    })());
    await expectRefusal(() => late.readStructuredQuery(seeded.context, list()), "query_timeout");
    // NEGATIVE CONTROL: the same read on a clock that does not pass the lease.
    const inside = await storage.readStructuredQuery(seeded.context, list());
    expect(inside.rows.map((row) => row.id)).toEqual([ANCHOR]);
  });

  // -------------------------------------------------------------------------
  // Authorization narrowing seam
  // -------------------------------------------------------------------------

  it("narrows a read to a requested subset and refuses a subset it does not own", async () => {
    const sourceRefs = ["sq-narrow-a", "sq-narrow-b"];
    const seeded = await seed({
      label: "narrowing",
      facts: [
        { resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef: sourceRefs[0]! },
        { resultId: OTHER, name: "Beta", entityType: "organization", sourceRef: sourceRefs[1]! },
      ],
    });
    const whole = await storage.readStructuredQuery(seeded.context, list());
    expect(whole.rows.map((row) => row.id)).toEqual([ANCHOR, OTHER]);

    // Narrowing is allowed, and is what the authorized subset means.
    const narrowed = await storage.readStructuredQuery(seeded.context, list(), [sourceRefs[1]!]);
    expect(narrowed.rows.map((row) => row.id)).toEqual([OTHER]);

    // Widening is not, and the guard is reachable precisely because the requested
    // set is a caller's second argument rather than the context's own array.
    await expectRefusal(
      () => storage.readStructuredQuery(seeded.context, list(), ["sq-never-authorized"]),
      "authorization_denied"
    );
  });

  it("refuses to compose a reader whose cursor key cannot authenticate", () => {
    // A short key HMACs perfectly well and is reproducible by anyone, which is
    // the failure the signature exists to prevent — so it is refused at
    // composition rather than shipped as a cursor anyone can forge.
    expect(() => new PgStructuredQueryStorage(authority, Buffer.alloc(8), () => clock())).toThrow(
      /cursor key/
    );
    // NEGATIVE CONTROL: this lane's own full-width key composes and is in use.
    expect(CURSOR_KEY.length).toBeGreaterThanOrEqual(32);
    expect(storage).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Window ordering at the producer
  // -------------------------------------------------------------------------

  it("refuses a valid_window that does not order, and emits one that does", () => {
    const request = list({ subject: "relation_assertion" });
    const instant = clock();
    // NEGATIVE CONTROL: an ordered window projects.
    expect(
      buildStructuredResult(
        request,
        relationRead({ from: "2020-01-01T00:00:00Z", until: "2021-01-01T00:00:00Z" }),
        instant
      ).schema
    ).toBe("iknow.structured_result");
    // A reversed window describes no instant, and the consumer refuses it as an
    // opaque contract violation — the producer must name it in its own code.
    expectSyncRefusal(
      () =>
        buildStructuredResult(
          request,
          relationRead({ from: "2021-01-01T00:00:00Z", until: "2020-01-01T00:00:00Z" }),
          instant
        ),
      "structured_search_unavailable"
    );
    // A zero-length window is the same fact: `start >= end`.
    expectSyncRefusal(
      () =>
        buildStructuredResult(
          request,
          relationRead({ from: "2020-01-01T00:00:00Z", until: "2020-01-01T00:00:00Z" }),
          instant
        ),
      "structured_search_unavailable"
    );
  });
});

// ---------------------------------------------------------------------------
// The seam's references, resolved through the real evidence read path
// ---------------------------------------------------------------------------
//
// Everything above drives the storage read plan directly, so a reference is only
// ever a string the projection was handed. What is left unproved — and what the
// merged base could not do at all — is that the reference a row is CITED by is
// one the evidence store actually minted, and that resolving it returns the row
// the query returned. So the cases below run the real `buildStructuredQueryReader`
// over this lane's real capabilities, then take the reference out of the returned
// page and read it back through the backend's own evidence read surface.

/**
 * Every reference this section minted, and every scope it minted one for.
 *
 * The lane's own `afterAll` drops the whole schema, but a grant is the first row
 * these cases create that no case above it creates, so they are removed by name
 * instead of being left to the drop. The two lists are also what the closing
 * assertions are checked against: a reference minted here and forgotten in this
 * list is a reference neither the cleanup nor the leak check can see, which is
 * exactly the state the leak check is there to catch.
 */
const seamReferences: string[] = [];
const seamScopes: string[] = [];

/**
 * Record every reference one seam read minted, so the cleanup below and the leak
 * check in it see the whole read rather than only the row a case goes on to make
 * a claim about. A page mints one grant per row, so a case that tracked just the
 * row it asserted on would leave the rest live — which is exactly what the leak
 * check caught the first time this section ran.
 */
function trackSeamRead(
  outcome: Awaited<ReturnType<StructuredQueryReader["readStructuredQuery"]>>
): void {
  if (outcome.kind === "count") {
    seamReferences.push(outcome.context.evidenceRef);
    return;
  }
  for (const row of outcome.rows) seamReferences.push(row.evidenceRef);
}

/**
 * The identity this lane's connection is bound to, read the way the host reads
 * it.
 *
 * `queryScopeIdentityFromEnv` is the production channel — `buildDeps` calls it on
 * the session's own environment at composition — so building the binding through
 * it here means this lane exercises the same path a served session does rather
 * than a hand-assembled record that could drift from it.
 */
function seamIdentity(seeded: Seeded): QueryScopeIdentity {
  return queryScopeIdentityFromEnv({
    [QUERY_SCOPE_ENV_VARS.actorId]: ACTOR,
    [QUERY_SCOPE_ENV_VARS.ownerScopeBinding]: seeded.scopeBinding,
    [QUERY_SCOPE_ENV_VARS.readerBinding]: seeded.scopeBinding,
    [QUERY_SCOPE_ENV_VARS.sourceRefs]: seeded.sourceRefs.join(","),
    [QUERY_SCOPE_ENV_VARS.authorizationRevision]: AUTHORIZATION_REVISION,
    // A deployment lease, not a case deadline. The shared authority checks it
    // against the wall clock, so it has to be live for the whole lane run; the
    // reader's own sixty-second execution lease is separate and is the case
    // clock, which is what the existing lease case drives.
    [QUERY_SCOPE_ENV_VARS.deadlineAt]: "2099-01-01T00:00:00.000Z",
  });
}

/**
 * The real seam over this lane's real capabilities, with nothing stood in for:
 * the shared scope authority it mints a context with, this lane's own
 * `PgStructuredQueryStorage` for the read, and the backend's own `issueGrants`
 * for the references. That is the composition `buildRetrieveDeps` performs in
 * `src/index.ts` — the same four objects a served process would use — so a
 * reference resolved below was minted by the same issuance path and stored in
 * the same table a citation would later be replayed from.
 */
function realSeam(seeded: Seeded): StructuredQueryReader {
  return buildStructuredQueryReader(
    authority,
    backend,
    storage,
    seamIdentity(seeded)
  );
}

/**
 * Replay one reference at the case clock and require it to be granted.
 *
 * The refusal arm is turned into a named failure rather than an `expect` on a
 * field that only the denied arm carries, so a reference that does NOT resolve
 * reports which reason denied it instead of reading as a missing property.
 */
async function replayGranted(
  evidenceRef: string,
  label: string
): Promise<Extract<EvidenceGrantRead, { readonly state: "granted" }>> {
  const read = await backend.readGrant(evidenceRef, clock().toISOString());
  if (read.state !== "granted") {
    throw new Error(
      `${label} reference ${evidenceRef} did not resolve: ${read.reason}`
    );
  }
  return read;
}

/** Object keys in a fixed order, so two values can be compared as bytes. */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, member]) => [key, canonicalValue(member)])
  );
}

/**
 * The value as BYTES, both sides canonicalized first.
 *
 * A grant's `value` is stored in `jsonb`, which reorders object keys on the way
 * in, so comparing the raw serializations would compare PostgreSQL's key order
 * against the reader's. Sorting on both sides keeps the comparison a byte
 * comparison of the same canonical form, which still fails on any field added,
 * dropped, renamed or re-valued — and on any reordering of a list, which is
 * NOT sorted, because array order is part of what the value says.
 */
function canonicalBytes(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

/** The row as the query returned it, minus the reference that cites it. */
function withoutHandle(row: Record<string, unknown>): Record<string, unknown> {
  const { evidenceRef: _handle, ...rest } = row;
  return rest;
}

describe("structured query strict PostgreSQL — issued references resolve", () => {
  afterAll(async () => {
    // The pins cascade to both pin tables, so one statement removes the grant
    // and everything it held. The receipt is a shared row that a count grant
    // joins rather than copies, so it is removed only once no grant still
    // points at it — a receipt another section's grant needs is left alone.
    await pool.query(
      "DELETE FROM evidence_grants WHERE evidence_ref = ANY($1::text[])",
      [seamReferences]
    );
    await pool.query(
      `DELETE FROM evidence_authorization_receipts r
        WHERE r.scope_binding = ANY($1::text[])
          AND NOT EXISTS (
            SELECT 1 FROM evidence_grants g
             WHERE g.authorization_receipt_id = r.receipt_id)`,
      [seamScopes]
    );
    // The leak check, and the reason the lists above are recorded: nothing this
    // section minted may survive it. A reference minted and not recorded shows
    // up here as a live row, so the check fails rather than passing by
    // inspecting only what the cleanup already removed.
    const grants = await pool.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM evidence_grants WHERE scope_binding = ANY($1::text[])",
      [seamScopes]
    );
    expect(grants.rows[0]!.total).toBe(0);
    const receipts = await pool.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM evidence_authorization_receipts WHERE scope_binding = ANY($1::text[])",
      [seamScopes]
    );
    expect(receipts.rows[0]!.total).toBe(0);
    const pins = await pool.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM evidence_grant_supports WHERE evidence_ref = ANY($1::text[])",
      [seamReferences]
    );
    expect(pins.rows[0]!.total).toBe(0);
  });

  it("cites a row with a reference the real evidence store minted, holding that exact row", async () => {
    const sourceRef = unique("cite-row");
    const seeded = await seed({
      label: "cite-row",
      facts: [
        { resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef },
        { resultId: OTHER, name: "Beta", entityType: "organization", sourceRef },
      ],
    });
    seamScopes.push(seeded.scopeBinding);
    const page = await realSeam(seeded).readStructuredQuery(list());
    if (page.kind !== "list") throw new Error("expected a list page from the seam");
    trackSeamRead(page);
    expect(page.rows).toHaveLength(2);

    // The reference the page CITES the first row by, taken from the page rather
    // than from a plan, so this reads the reference a caller would receive.
    const rowRef = page.rows[0]!.evidenceRef;
    const replayed = await replayGranted(rowRef, "row");
    const grant = replayed.grant;

    // The reference is the store's own handle, and what it names is a row grant:
    // a receipt wearing a row's name would carry a count, and this one carries
    // none, so the two arms cannot be confused by a caller that reads either.
    expect(grant.evidence_ref).toBe(rowRef);
    expect(grant.kind).toBe(EVIDENCE_GRANT_KIND.ROW);
    expect(grant.result_count).toBeNull();
    expect(replayed.authorization).toBeNull();

    // The value the reference resolves to IS the value the query returned, byte
    // for byte: once against the page the seam handed the caller, with only the
    // citing handle removed, and once against what the query lane itself planned
    // for the same request. The first is the end-to-end claim; the second is
    // what makes it a claim about the QUERY rather than about the projection.
    const plan = await storage.readStructuredQuery(seeded.context, list());
    expect(canonicalBytes(withoutHandle(page.rows[0] as unknown as Record<string, unknown>))).toBe(
      canonicalBytes(grant.value)
    );
    expect(canonicalBytes(grant.value)).toBe(canonicalBytes(plan.rows[0]));

    // The comparison above is only worth anything if it can fail, so the one
    // member this case is really about is checked against a changed value too.
    const tampered = { ...(withoutHandle(page.rows[0] as unknown as Record<string, unknown>)), canonicalName: "Renamed" };
    expect(canonicalBytes(tampered)).not.toBe(canonicalBytes(grant.value));

    // The grant is bound to the read that minted it: a reference that resolved
    // to a real row of some OTHER read would satisfy every assertion above and
    // still be the wrong citation.
    expect(grant.query_digest).toBe(plan.queryDigest);
    expect(grant.scope_binding).toBe(seeded.scopeBinding);
    expect(grant.read_revision).toBe(plan.readRevision);

    // A row grant with no retained dependencies would replay as an empty
    // provenance, so the support set the page showed is the set it holds.
    const shown = new Set(plan.rows[0]!.supports.map((support) => support.supportId));
    expect(shown.size).toBeGreaterThan(0);
    expect(new Set(replayed.supports.map((support) => support.support_id))).toEqual(shown);

    // NEGATIVE CONTROL: a reference shaped like a real one but never issued is
    // refused by name. Without this the case could not tell a store that
    // resolved a grant apart from one that answered anything it was asked.
    const forged = await backend.readGrant(`${rowRef}-never-issued`, clock().toISOString());
    if (forged.state !== "denied") {
      throw new Error("a reference that was never issued resolved as granted");
    }
    expect(forged.reason).toBe(EVIDENCE_DENIAL_REASON.UNKNOWN_REFERENCE);
  });

  it("cites a count receipt with its own reference, holding the measured count", async () => {
    const sourceRef = unique("cite-count");
    const seeded = await seed({
      label: "cite-count",
      facts: [
        { resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef },
        { resultId: OTHER, name: "Beta", entityType: "organization", sourceRef },
        { resultId: FAR, name: "Gamma", entityType: "organization", sourceRef },
      ],
    });
    seamScopes.push(seeded.scopeBinding);
    const reader = realSeam(seeded);
    const counted = await reader.readStructuredQuery(list({ operation: "count" }));
    if (counted.kind !== "count") throw new Error("expected a count outcome from the seam");
    trackSeamRead(counted);
    expect(counted.count).toBe(3);

    // The reference the RECEIPT carries, which is the context's own rather than
    // any row's: a count answers about a number, so there is no row to cite.
    const countRef = counted.context.evidenceRef;
    const replayed = await replayGranted(countRef, "count");
    const grant = replayed.grant;

    expect(grant.evidence_ref).toBe(countRef);
    expect(grant.kind).toBe(EVIDENCE_GRANT_KIND.COUNT);
    // The number is held twice — as the count the read measured and inside the
    // receipt's own value — and both must be the number the caller was told.
    expect(grant.result_count).toBe(counted.count);
    expect(canonicalBytes(grant.value)).toBe(
      canonicalBytes({
        subject: "entity",
        count: counted.count,
        coverage: STRUCTURED_RESULT_COUNT_COVERAGE,
      })
    );
    // A count grant is a receipt and its admission, never a membership: the
    // supports it holds are empty and it joins the shared authorization receipt.
    expect(replayed.supports).toHaveLength(0);
    expect(replayed.authorization).not.toBeNull();
    expect(replayed.authorization!.scope_binding).toBe(seeded.scopeBinding);
    expect(grant.authorization_receipt_id).toBe(replayed.authorization!.receipt_id);

    // The count the receipt holds is the count the LIST measured, so a receipt
    // cannot be resolved into a number the page contradicts.
    const page = await reader.readStructuredQuery(list());
    if (page.kind !== "list") throw new Error("expected a list page from the seam");
    trackSeamRead(page);
    const rowRef = page.rows[0]!.evidenceRef;
    expect(grant.result_count).toBe(page.rows.length);
    // Two references, not one handle used twice: the row's citation and the
    // receipt's citation are minted separately, so resolving one can never be
    // mistaken for resolving the other.
    expect(countRef).not.toBe(rowRef);
    const rowReplay = await replayGranted(rowRef, "row");
    expect(rowReplay.grant.kind).toBe(EVIDENCE_GRANT_KIND.ROW);
    expect(rowReplay.grant.result_count).toBeNull();
  });

  it("rolls the whole page back when one request in the middle cannot be issued", async () => {
    // The real store's half of the all-or-nothing claim. The seam suite proves
    // the seam issues a page as ONE write; this proves the store honours that by
    // committing none of it, so a refusal cannot leave a caller holding
    // dependencies pinned for a reference it never received.
    //
    // The failure is a support that does not resolve, which
    // `readPinnableDependencies` refuses at the write — the same refusal the
    // memory twin's `requireGrantable` raises, reached here against the cluster.
    const sourceRef = unique("cite-atomic");
    const seeded = await seed({
      label: "cite-atomic",
      facts: [
        { resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef },
        { resultId: OTHER, name: "Beta", entityType: "organization", sourceRef },
        { resultId: FAR, name: "Gamma", entityType: "organization", sourceRef },
      ],
    });
    seamScopes.push(seeded.scopeBinding);
    const plan = await storage.readStructuredQuery(seeded.context, list());
    expect(plan.grants.length).toBe(3);
    const ABSENT_SUPPORT = "00000000-0000-4000-8000-00000000dead";
    // Built as grant REQUESTS rather than passed as plans: the plan carries both
    // arms on every grant, and `normalizeGrantRequest` refuses a row grant that
    // still names a count — which is the arm-exclusivity the seam's
    // `grantRequestOf` enforces and this case has to honour too.
    const requests = plan.grants.map(({ count: _count, ...grant }, index) =>
      index === 1
        ? {
            ...grant,
            supports: [
              { support_id: ABSENT_SUPPORT, role: grant.supports[0]!.role },
            ],
          }
        : grant
    );

    const issued = await backend
      .issueGrants(requests)
      .then(() => null, (caught) => caught as { failureToken?: string });
    expect(issued?.failureToken).toBe("unsupported_source_binding");

    // The decisive assertion: neither neighbour committed. A per-grant
    // transaction would have left rows 0 and 2 granted here, each pinning
    // dependencies for 365 days behind a refusal the caller never sees.
    const refs = await pool.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM evidence_grants WHERE scope_binding = $1",
      [seeded.scopeBinding]
    );
    expect(refs.rows[0]!.total).toBe(0);
  });

  it("mints a fresh reference for each read of one unchanged row", async () => {
    const sourceRef = unique("cite-fresh");
    const seeded = await seed({
      label: "cite-fresh",
      facts: [
        { resultId: ANCHOR, name: "Alpha", entityType: "organization", sourceRef },
        { resultId: OTHER, name: "Beta", entityType: "organization", sourceRef },
      ],
    });
    seamScopes.push(seeded.scopeBinding);
    const reader = realSeam(seeded);
    const first = await reader.readStructuredQuery(list());
    const second = await reader.readStructuredQuery(list());
    if (first.kind !== "list" || second.kind !== "list") {
      throw new Error("expected list pages from the seam");
    }
    trackSeamRead(first);
    trackSeamRead(second);
    // The same row, from the same snapshot, on both reads — so any difference
    // between the two references is the issuance and not the corpus.
    expect(second.rows[0]!.id).toBe(first.rows[0]!.id);
    expect(second.rows[0]!.canonicalName).toBe(first.rows[0]!.canonicalName);
    const firstRef = first.rows[0]!.evidenceRef;
    const secondRef = second.rows[0]!.evidenceRef;
    expect(secondRef).not.toBe(firstRef);

    // BOTH still resolve, and to the same value: a reference is the receipt of
    // ONE read rather than a handle onto the row, so it is not renewable and
    // not stable, while what it attests to has not moved.
    const firstReplay = await replayGranted(firstRef, "first");
    const secondReplay = await replayGranted(secondRef, "second");
    expect(firstReplay.grant.kind).toBe(EVIDENCE_GRANT_KIND.ROW);
    expect(secondReplay.grant.kind).toBe(EVIDENCE_GRANT_KIND.ROW);
    expect(canonicalBytes(secondReplay.grant.value)).toBe(
      canonicalBytes(firstReplay.grant.value)
    );
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