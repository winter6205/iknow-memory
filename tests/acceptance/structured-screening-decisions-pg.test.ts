/**
 * The strict PostgreSQL lane of the guarded screening decision contract.
 *
 * Every case runs against the real database: the real shared scope unit of
 * work, the real durable-work ledger, the real publication adapter, the real
 * screening store and the decision tables this lane's own DDL creates. The
 * driver never skips — an absent marker, an absent DSN and an unreachable
 * database are each named non-zero failures — and every refusal is proven from
 * a separate connection, so no partial commit can hide behind the transaction
 * that refused.
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
import type { ScreeningConflictFacts } from "../../src/core/maintenance/screening-decision.js";
import {
  deriveRelationAssertionId,
  normalizeRelationAssertion,
} from "../../src/core/structured/identity.js";
import { PgMaintenanceWorkStore } from "../../src/core/storage/maintenance-work-pg.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { PgScreeningDecisionStorage } from "../../src/core/storage/screening-decision-pg.js";
import { PgScreeningStorage } from "../../src/core/storage/screening-pg.js";
import {
  upSchemaScreening,
  upSchemaScreeningDecisions,
} from "../../src/core/storage/schema-screening.js";
import type {
  AuthorizedScopeContext,
  AuthorizedScopeUnitOfWork,
} from "../../src/core/storage/structured-scope-types.js";
import {
  createPublicationTestClock,
  type PublicationTestClock,
} from "../storage/publication-contract.js";
import {
  describeScreeningDecisionContract,
  type ConflictSupport,
  type ScreeningDecisionTestPort,
} from "../storage/screening-decision-contract.js";
import {
  openStrictPgDriver,
  requireFullyRunnable,
  type NotRunCase,
} from "./strict-pg-driver.js";

const EXPECTED_COMMAND =
  "STRUCTURED_SCREENING_DECISIONS_PG=1 GRAPHRAG_MEMORY_DB_URL=<isolated-development-dsn> npx vitest run tests/acceptance/structured-screening-decisions-pg.test.ts";
const SCHEMA_PREFIX = "structured_screening_decisions";
const DIMENSIONS = 8;
const ACTOR = "screening-decisions-trusted-owner";
const CONFIG_REVISION = "extractor-v1";
const AUTHORIZATION_REVISION = "auth-screening-decisions-pg-1";
const DRAIN_LIMIT = 64;

const HEAD = "00000000-0000-4000-8000-000000000801";
const TAILS = [
  "00000000-0000-4000-8000-000000000901",
  "00000000-0000-4000-8000-000000000902",
] as const;

const driver = await openStrictPgDriver({
  envName: "STRUCTURED_SCREENING_DECISIONS_PG",
  testPath: "tests/acceptance/structured-screening-decisions-pg.test.ts",
  expectedCommand: EXPECTED_COMMAND,
  label: "structured-screening-decisions-pg",
  schemaPrefix: SCHEMA_PREFIX,
  dependency: "real PostgreSQL with pgvector",
});

const SCHEMA_URL = driver.schemaConnectionString;

let admin: pg.Client;
let backend: PgvectorBackend;
let pool: pg.Pool;
let publication: StructuredPublicationStorage;
let work: MaintenanceWorkStore;
let screening: PgScreeningStorage;
let decisions: PgScreeningDecisionStorage;
let authority: AuthorizedScopeUnitOfWork;
let clock: PublicationTestClock;
let serial = 0;

function unique(label: string): string {
  serial += 1;
  return `${label}-${serial}`;
}

function opaqueDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type Bound = string | null;

const INTERVALS: readonly { readonly from: Bound; readonly until: Bound }[] = [
  { from: "2020-01-01T00:00:00.000Z", until: "2025-01-01T00:00:00.000Z" },
  { from: "2022-01-01T00:00:00.000Z", until: "2027-01-01T00:00:00.000Z" },
];

/**
 * Relation-assertion identities reference `entities`, so the canonical entity
 * rows are seeded directly: a decision fixture needs the identity to exist, not
 * a vector index over it.
 */
async function seedGraphEntities(entityIds: readonly string[]): Promise<void> {
  for (const entityId of entityIds) {
    await pool.query(
      `INSERT INTO entities (id, canonical_name, type, embedding, metadata, retired)
         VALUES ($1, $2, 'organization', NULL, '{}'::jsonb, false)
       ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type`,
      [entityId, `screening decision fixture entity ${entityId}`]
    );
  }
}

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
    throw new Error(
      `screening decision pg fixture schedule refused: ${scheduled.refused}`
    );
  }
  for (let attempt = 0; attempt < DRAIN_LIMIT; attempt += 1) {
    const claimed = await claimNextWork(deps);
    const guard = claimed.guard;
    if (guard === null) break;
    if (guard.jobKey === scheduled.record.jobKey) return guard;
    await settleWork(deps, guard, { status: "failed", failureCode: "input_stale" }, {
      configRevision: CONFIG_REVISION,
      dependencies: input.dependencies,
    });
  }
  throw new Error("screening decision pg fixture could not claim its own job");
}

/** A second connection, so a refusal is never read through the transaction that refused. */
async function withObserver<R>(
  action: (observer: pg.Client) => Promise<R>
): Promise<R> {
  const observer = new pg.Client({ connectionString: SCHEMA_URL });
  await observer.connect();
  try {
    return await action(observer);
  } finally {
    await observer.end();
  }
}

/**
 * The mutations this lane can be run under, read from the environment so the
 * state under test is reached by running the lane rather than by editing it.
 *
 * `locks` removes every row and advisory lock the decision transaction takes —
 * the mutation the ticket records as still letting two racing decisions both
 * apply. `guard` removes that lock set AND the decision's conflict-identity
 * guard, which is what shows the case below is deciding on the guard and not on
 * its own timing. The case asserts the same correct outcome under all three, so
 * a mutation fails the lane instead of changing what the lane claims.
 */
const DECISION_MUTATION = process.env.STRUCTURED_SCREENING_DECISION_MUTATION ?? "";
const MUTATED_LOCKS = DECISION_MUTATION === "locks" || DECISION_MUTATION === "guard";
const MUTATED_GUARD = DECISION_MUTATION === "guard";
const CONFLICT_UNIQUE_INDEX = "structured_screening_decisions_conflict_uniq";

const ADVISORY_XACT_LOCK = /pg_(?:try_)?advisory_xact_lock\s*\(/i;
const ROW_LOCK = /\bFOR\s+UPDATE\b/i;
const CONFLICT_IDENTITY_GUARD =
  /\s*ON\s+CONFLICT\s*\(\s*scope_binding\s*,\s*candidate_id\s*\)\s*DO NOTHING\s*RETURNING\s*decision_id/i;

type QueryFn = (
  text: string,
  values?: readonly unknown[]
) => Promise<{ rows: unknown[] }>;

/**
 * The mutation reaches every client this lane's transactions lease.
 *
 * The advisory, scope and source locks are taken by the shared scope unit of
 * work on its own client, which never reaches the decision callback, so
 * rewriting only the callback's client would leave three of the four in place
 * and the case would pass for the wrong reason. Every leased connection is an
 * instance of the one class below, so that is where the statements are rewritten.
 * The lock mutation removes only the locking clause: every read the decision
 * makes still happens and only the serialization disappears.
 */
function neutralizingQueries(): () => void {
  const prototype = pg.Client.prototype as unknown as { query: QueryFn };
  const original = prototype.query;
  prototype.query = function (
    this: unknown,
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: unknown[] }> {
    if (ADVISORY_XACT_LOCK.test(text)) {
      return Promise.resolve({ rows: [{ acquired: true }] });
    }
    let rewritten = text;
    if (MUTATED_LOCKS) rewritten = rewritten.replace(ROW_LOCK, "");
    if (MUTATED_GUARD) rewritten = rewritten.replace(CONFLICT_IDENTITY_GUARD, "");
    return original.call(this, rewritten, values);
  };
  return () => {
    prototype.query = original;
  };
}

async function seedConflict(label: string): Promise<{
  readonly context: AuthorizedScopeContext;
  readonly facts: ScreeningConflictFacts;
  readonly supports: readonly ConflictSupport[];
  readonly scopeBinding: string;
}> {
  const scopeBinding = unique(`decision-pg-scope-${label}`);
  const sourceRef = unique(`${label}-source`);
  const extractionRef = `decision-extraction-${label}`;
  await seedGraphEntities([HEAD, ...TAILS]);
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
  const facts: PublicationFact[] = INTERVALS.map((interval, index) => {
    const tailEntityId = TAILS[index]!;
    return {
      identity: {
        kind: "relation_assertion",
        input: {
          headEntityId: HEAD,
          relationNorm: "has_chair",
          tailEntityId,
          validWindow: { from: interval.from, until: interval.until },
        },
      },
      occurrence: {
        subject: "assertion",
        result_id: deriveRelationAssertionId(
          normalizeRelationAssertion({
            headEntityId: HEAD,
            relationNorm: "has_chair",
            tailEntityId,
            validWindow: { from: interval.from, until: interval.until },
          })
        ),
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
    {
      sourceRef,
      generation: declared.generation,
      extractionRevision: null,
      relationBuckets: [],
    },
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
        relationBuckets: ["has_chair"],
      },
    ],
  });
  const outcome = await screening.stageScreen({
    context,
    guard,
    relationBuckets: ["has_chair"],
    relationCatalogVersion: 0,
    relationCatalogEntries: [],
  });
  const candidate = outcome.candidates[0];
  if (candidate === undefined) {
    // EXIT: the fixture's own screen published no conflict, so every decision
    // case would run against nothing. The setup throws before the case body.
    throw new Error(`decision pg fixture published no conflict for ${label}`);
  }
  const read = await withObserver(async (observer) => {
    const { rows } = await observer.query(
      `SELECT check_id, support_ids, assertion_ids, input_revision,
              relation_catalog_version
         FROM structured_screening_candidates
        WHERE candidate_id = $1 AND scope_binding = $2`,
      [candidate.candidateId, scopeBinding]
    );
    return rows[0] as
      | {
          check_id?: string;
          support_ids?: string[];
          assertion_ids?: string[];
          input_revision?: string;
          relation_catalog_version?: number;
        }
      | undefined;
  });
  if (read === undefined) {
    // EXIT: the screening store published a candidate a separate connection
    // cannot read back. The setup refuses rather than deciding against a
    // conflict the authoritative store does not hold.
    throw new Error(
      `decision pg fixture cannot read back ${candidate.candidateId}`
    );
  }
  const revisions = await withObserver(async (observer) => {
    const { rows } = await observer.query(
      `SELECT read_revision, maintenance_revision
         FROM structured_publication_scopes WHERE scope_binding = $1`,
      [scopeBinding]
    );
    return rows[0] as
      | { read_revision?: string; maintenance_revision?: string }
      | undefined;
  });
  return {
    context,
    facts: {
      scopeBinding,
      candidateId: candidate.candidateId,
      checkId: read.check_id ?? "",
      supportIds: read.support_ids ?? [],
      assertionIds: read.assertion_ids ?? [],
      inputRevision: read.input_revision ?? "",
      relationCatalogVersion: read.relation_catalog_version ?? 0,
      readRevision: Number(revisions?.read_revision ?? 0),
      maintenanceRevision: Number(revisions?.maintenance_revision ?? 0),
    },
    supports: (read.support_ids ?? []).map((supportId, index) => ({
      supportId,
      assertionId:
        (read.assertion_ids ?? [])[index] ?? (read.assertion_ids ?? [])[0] ?? "",
    })),
    scopeBinding,
  };
}

const port: ScreeningDecisionTestPort = {
  label: "strict-pg",
  seedConflict,
  applyDecision: (input) => decisions.applyDecision({ ...input }),
  async readDecisions(scopeBinding, candidateId) {
    return withObserver(async (observer) => {
      const { rows } = await observer.query(
        `SELECT decision_id, scope_binding, candidate_id, check_id::text AS check_id,
                outcome, reason, actor_id, retire_support_ids, retain_support_ids,
                assertion_ids, expected_input_revision,
                expected_relation_catalog_version, content_digest, decided_at
           FROM structured_screening_decisions
          WHERE scope_binding = $1
            AND ($2::text IS NULL OR candidate_id = $2)
          ORDER BY decided_at, decision_id`,
        [scopeBinding, candidateId ?? null]
      );
      return rows.map((row) => {
        const decision = row as {
          decision_id: string;
          scope_binding: string;
          candidate_id: string;
          check_id: string;
          outcome: string;
          reason: string;
          actor_id: string;
          retire_support_ids: string[];
          retain_support_ids: string[];
          assertion_ids: string[];
          expected_input_revision: string;
          expected_relation_catalog_version: number;
          content_digest: string;
          decided_at: Date;
        };
        return {
          decisionId: decision.decision_id,
          scopeBinding: decision.scope_binding,
          candidateId: decision.candidate_id,
          checkId: decision.check_id,
          outcome: decision.outcome as "keep_both",
          reason: decision.reason,
          actorId: decision.actor_id,
          retireSupportIds: decision.retire_support_ids,
          retainSupportIds: decision.retain_support_ids,
          assertionIds: decision.assertion_ids,
          expectedInputRevision: decision.expected_input_revision,
          expectedRelationCatalogVersion:
            decision.expected_relation_catalog_version,
          decidedAt: decision.decided_at.toISOString(),
          contentDigest: decision.content_digest,
        };
      });
    });
  },
  async readConflictResolution(scopeBinding, candidateId) {
    return withObserver(async (observer) => {
      const { rows } = await observer.query(
        `SELECT count(*)::bigint AS total
           FROM structured_screening_decisions
          WHERE scope_binding = $1 AND candidate_id = $2`,
        [scopeBinding, candidateId]
      );
      return Number((rows[0] as { total: string }).total) > 0;
    });
  },
  async readVisibility(scopeBinding, candidateId) {
    return withObserver(async (observer) => {
      const { rows } = await observer.query(
        `SELECT support_id::text AS support_id, current
           FROM structured_screening_conflict_visibility
          WHERE scope_binding = $1 AND candidate_id = $2
          ORDER BY support_id`,
        [scopeBinding, candidateId]
      );
      return rows.map((row) => {
        const visibility = row as { support_id: string; current: boolean };
        return { supportId: visibility.support_id, current: visibility.current };
      });
    });
  },
  /**
   * A fingerprint of every authoritative store a decision can touch, taken from
   * a fresh connection each time. Equal fingerprints before and after a refusal
   * are the only proof it changed nothing.
   */
  async fingerprint(scopeBinding) {
    return withObserver(async (observer) => {
      const scopes = await observer.query(
        `SELECT read_revision, maintenance_revision
           FROM structured_publication_scopes WHERE scope_binding = $1`,
        [scopeBinding]
      );
      const candidates = await observer.query(
        `SELECT candidate_id, check_id::text AS check_id, uncertainty_reason
           FROM structured_screening_candidates WHERE scope_binding = $1
          ORDER BY candidate_id`,
        [scopeBinding]
      );
      const visibility = await observer.query(
        `SELECT candidate_id, support_id::text AS support_id, assertion_id::text AS assertion_id,
                current, resolved_by, outcome
           FROM structured_screening_conflict_visibility WHERE scope_binding = $1
          ORDER BY candidate_id, support_id`,
        [scopeBinding]
      );
      const decisionRows = await observer.query(
        `SELECT decision_id, candidate_id, outcome, reason, actor_id,
                retire_support_ids, retain_support_ids, assertion_ids,
                content_digest
           FROM structured_screening_decisions WHERE scope_binding = $1
          ORDER BY decision_id`,
        [scopeBinding]
      );
      const membership = await observer.query(
        `SELECT source_ref, support_id::text AS support_id, result_id, subject
           FROM structured_publication_membership WHERE scope_binding = $1
          ORDER BY source_ref, support_id`,
        [scopeBinding]
      );
      const intents = await observer.query(
        `SELECT subject_kind, subject_id::text AS subject_id, status
           FROM projection_outbox ORDER BY subject_kind, subject_id`
      );
      return JSON.stringify({
        scope: scopes.rows,
        candidates: candidates.rows,
        visibility: visibility.rows,
        decisions: decisionRows.rows,
        membership: membership.rows,
        intents: intents.rows,
      });
    });
  },
  async readRevisions(scopeBinding) {
    return withObserver(async (observer) => {
      const { rows } = await observer.query(
        `SELECT read_revision, maintenance_revision
           FROM structured_publication_scopes WHERE scope_binding = $1`,
        [scopeBinding]
      );
      const row = rows[0] as
        | { read_revision?: string; maintenance_revision?: string }
        | undefined;
      return {
        read: Number(row?.read_revision ?? 0),
        maintenance: Number(row?.maintenance_revision ?? 0),
      };
    });
  },
  async readIntents() {
    return withObserver(async (observer) => {
      const { rows } = await observer.query(
        `SELECT subject_id::text AS subject_id FROM projection_outbox
          WHERE subject_kind = 'triple' ORDER BY subject_id`
      );
      return rows.map((row) => (row as { subject_id: string }).subject_id);
    });
  },
  async close() {
    // The lane's schema, pool and backend are released by the reporting
    // contract's own teardown, which runs once for the whole file.
  },
};

// EXIT: the backend composition supplies neither the publication adapter nor the
// shared scope authority. The module load throws before any harness or schema
// exists, so no case can decide through a storage surface composition does not
// own.
admin = driver.harness.createClient(SCHEMA_URL);
await admin.connect();
await driver.harness.resetSchema(admin);
backend = new PgvectorBackend(SCHEMA_URL, DIMENSIONS, { annMaxDimensions: 2000 });
await backend.initialize();
pool = new pg.Pool({ connectionString: SCHEMA_URL, max: 8 });
clock = createPublicationTestClock(new Date());
await upSchemaScreening(pool);
await upSchemaScreeningDecisions(pool);
const composed = backend as PgvectorBackend & {
  structuredPublication?: StructuredPublicationStorage;
  structuredScopeUnitOfWork?: AuthorizedScopeUnitOfWork;
};
if (!composed.structuredPublication || !composed.structuredScopeUnitOfWork) {
  throw new Error(
    "PgvectorBackend composition must supply the structured publication storage and the shared scope unit of work this lane drives"
  );
}
publication = composed.structuredPublication;
authority = composed.structuredScopeUnitOfWork;
screening = new PgScreeningStorage(composed.structuredScopeUnitOfWork);
decisions = new PgScreeningDecisionStorage(composed.structuredScopeUnitOfWork);
work = new PgMaintenanceWorkStore(pool);

const NOT_RUN: NotRunCase = {
  caseId: "screening-decisions-pg",
  expectedCommand: EXPECTED_COMMAND,
  owner: "T16",
  entries: [],
};

describe("screening decision persistence — strict PostgreSQL lane", () => {
  it("reached the real PostgreSQL lane", () => {
    expect(pool.totalCount).toBeGreaterThan(0);
  });
});

describeScreeningDecisionContract(async () => port);

describe("screening decision transaction property", () => {
  it("commits the decision, its visibility and its intent together", async () => {
    const seeded = await seedConflict("atomic-commit");
    const applied = await decisions.applyDecision({
      request: {
        decisionId: unique("t16-atomic"),
        context: seeded.context,
        candidateId: seeded.facts.candidateId,
        outcome: "retire_support",
        reason: "one source is authoritative; the other is a stale mirror",
        retireSupportIds: [seeded.supports[0]!.supportId],
        retainSupportIds: [],
        assertionIds: seeded.facts.assertionIds,
        expectedInputRevision: seeded.facts.inputRevision,
        expectedRelationCatalogVersion: seeded.facts.relationCatalogVersion,
      },
      facts: seeded.facts,
    });
    expect(applied.effect.visibilityChanged).toBe(true);
    // A fresh connection sees the decision, the visibility it applied and the
    // intent it enqueued, which is only possible if one transaction wrote them.
    const observed = await withObserver(async (observer) => {
      const decisionsSeen = await observer.query(
        `SELECT count(*)::bigint AS total FROM structured_screening_decisions
          WHERE scope_binding = $1`,
        [seeded.scopeBinding]
      );
      const visibility = await observer.query(
        `SELECT count(*)::bigint AS total FROM structured_screening_conflict_visibility
          WHERE scope_binding = $1`,
        [seeded.scopeBinding]
      );
      const intents = await observer.query(
        `SELECT count(*)::bigint AS total FROM projection_outbox
          WHERE subject_kind = 'triple'`
      );
      return {
        decisions: Number((decisionsSeen.rows[0] as { total: string }).total),
        visibility: Number((visibility.rows[0] as { total: string }).total),
        intents: Number((intents.rows[0] as { total: string }).total),
      };
    });
    expect(observed.decisions).toBe(1);
    expect(observed.visibility).toBe(seeded.facts.supportIds.length);
    expect(observed.intents).toBeGreaterThan(0);
  });

  it("SD-18-PG two decisions that genuinely overlap in time cannot both apply", async () => {
    const seeded = await seedConflict("overlap");
    // The first decision is held open inside its own transaction, so the second
    // is presented while the first is genuinely in flight rather than after it.
    // Without this the two calls would serialize on the pool and the case would
    // prove nothing about a race.
    await withObserver(async (observer) => {
      await observer.query(`CREATE SEQUENCE "${driver.schema}".overlap_seq`);
      await observer.query(`
        CREATE FUNCTION "${driver.schema}".overlap_delay()
        RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN
          PERFORM pg_sleep(0.4);
          RETURN NEW;
        END; $f$`);
      await observer.query(`
        CREATE TRIGGER overlap_delay_trg BEFORE INSERT ON structured_screening_decisions
        FOR EACH ROW EXECUTE FUNCTION "${driver.schema}".overlap_delay()`);
    });
    const mk = (outcome: "keep_both" | "retire_support") => ({
      decisionId: unique(`t16-overlap-${outcome}`),
      context: seeded.context,
      candidateId: seeded.facts.candidateId,
      outcome,
      reason: "two decisions presented while the first is still open",
      retireSupportIds: outcome === "keep_both" ? [] : [seeded.supports[0]!.supportId],
      retainSupportIds: [] as readonly string[],
      assertionIds: seeded.facts.assertionIds,
      expectedInputRevision: seeded.facts.inputRevision,
      expectedRelationCatalogVersion: seeded.facts.relationCatalogVersion,
    });
    const results = await Promise.allSettled([
      decisions.applyDecision({ request: mk("retire_support"), facts: seeded.facts }),
      decisions.applyDecision({ request: mk("keep_both"), facts: seeded.facts }),
    ]);
    await withObserver(async (observer) => {
      await observer.query(
        `DROP TRIGGER IF EXISTS overlap_delay_trg ON structured_screening_decisions`
      );
      await observer.query(`DROP FUNCTION IF EXISTS "${driver.schema}".overlap_delay()`);
      await observer.query(`DROP SEQUENCE IF EXISTS "${driver.schema}".overlap_seq`);
    });
    const applied = results.filter((r) => r.status === "fulfilled").length;
    const codes = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => (r.reason as { code?: string }).code);
    // The refusal is the stale verdict rather than a unique-violation error, so
    // the loser learned it was stale by reading the winner's decision rather
    // than by colliding with it.
    expect(applied).toBe(1);
    expect(codes).toEqual(["input_stale"]);
    const recorded = await port.readDecisions(
      seeded.scopeBinding,
      seeded.facts.candidateId
    );
    expect(recorded).toHaveLength(1);
  });

  it("SD-18-PG-M one conflict identity decides once with every in-transaction lock removed", async () => {
    const seeded = await seedConflict("guard-identity");
    // Both transactions must read the conflict before either writes it, or the
    // case passes because the second decision simply arrived late rather than
    // because anything stopped it. The first arrival at the trigger holds until
    // the second one has reached it, which is a fact about the run rather than a
    // sleep long enough to be usually true. The wait is bounded so a run where
    // the second decision is held up elsewhere still finishes.
    await withObserver(async (observer) => {
      await observer.query(`CREATE SEQUENCE "${driver.schema}".guard_overlap_seq`);
      await observer.query(`
        CREATE FUNCTION "${driver.schema}".guard_overlap_delay()
        RETURNS trigger LANGUAGE plpgsql AS $f$
        DECLARE
          arrival integer;
          waited integer := 0;
        BEGIN
          arrival := nextval('"${driver.schema}".guard_overlap_seq'::regclass);
          IF arrival = 1 THEN
            WHILE (SELECT last_value FROM "${driver.schema}".guard_overlap_seq) < 2
              AND waited < 100 LOOP
              PERFORM pg_sleep(0.01);
              waited := waited + 1;
            END LOOP;
          END IF;
          RETURN NEW;
        END; $f$`);
      await observer.query(`
        CREATE TRIGGER guard_overlap_delay_trg BEFORE INSERT ON structured_screening_decisions
        FOR EACH ROW EXECUTE FUNCTION "${driver.schema}".guard_overlap_delay()`);
    });
    if (MUTATED_GUARD) {
      await withObserver((observer) =>
        observer.query(`DROP INDEX IF EXISTS ${CONFLICT_UNIQUE_INDEX}`)
      );
    }
    const mk = (outcome: "keep_both" | "retire_support") => ({
      decisionId: unique(`t16-guard-${outcome}`),
      context: seeded.context,
      candidateId: seeded.facts.candidateId,
      outcome,
      reason: "two decisions presented with no lock left between them",
      retireSupportIds: outcome === "keep_both" ? [] : [seeded.supports[0]!.supportId],
      retainSupportIds: [] as readonly string[],
      assertionIds: seeded.facts.assertionIds,
      expectedInputRevision: seeded.facts.inputRevision,
      expectedRelationCatalogVersion: seeded.facts.relationCatalogVersion,
    });
    const restore = neutralizingQueries();
    try {
      const results = await Promise.allSettled([
        decisions.applyDecision({ request: mk("retire_support"), facts: seeded.facts }),
        decisions.applyDecision({ request: mk("keep_both"), facts: seeded.facts }),
      ]);
      const applied = results.filter((r) => r.status === "fulfilled").length;
      const codes = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => (r.reason as { code?: string }).code);
      // Under `STRUCTURED_SCREENING_DECISION_MUTATION=locks` the advisory and row
      // locks this transaction normally takes are gone, and one decision still
      // resolves the conflict once. Nothing here holds a lock to do it with, so
      // what holds is the conflict identity the decision row is keyed by.
      expect(applied).toBe(1);
      expect(codes).toEqual(["input_stale"]);
      const recorded = await port.readDecisions(
        seeded.scopeBinding,
        seeded.facts.candidateId
      );
      expect(recorded).toHaveLength(1);
      // The conflict identity is restored only once the case has passed. A
      // mutated run that really did record two decisions for one conflict
      // leaves a table this index refuses, and that refusal is this case's own
      // failure rather than something the cleanup reports in its place.
      if (MUTATED_GUARD) {
        await withObserver((observer) =>
          observer.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS ${CONFLICT_UNIQUE_INDEX}
               ON structured_screening_decisions (scope_binding, candidate_id)`
          )
        );
      }
    } finally {
      restore();
      await withObserver(async (observer) => {
        await observer.query(
          `DROP TRIGGER IF EXISTS guard_overlap_delay_trg ON structured_screening_decisions`
        );
        await observer.query(`DROP FUNCTION IF EXISTS "${driver.schema}".guard_overlap_delay()`);
        await observer.query(`DROP SEQUENCE IF EXISTS "${driver.schema}".guard_overlap_seq`);
      });
    }
  });

  it("leaves no decision, no visibility row and no intent when the outbox refuses", async () => {
    const seeded = await seedConflict("atomic-refusal");
    const before = await port.fingerprint(seeded.scopeBinding);
    await withObserver(async (observer) => {
      await observer.query(`
        CREATE OR REPLACE FUNCTION "${driver.schema}".decision_outbox_fault()
        RETURNS trigger LANGUAGE plpgsql AS $fault$
        BEGIN
          IF nextval('${driver.schema}.decision_outbox_fault_seq'::regclass) = 1 THEN
            RAISE EXCEPTION 'injected decision outbox failure';
          END IF;
          RETURN NEW;
        END;
        $fault$`);
      await observer.query(
        `CREATE SEQUENCE "${driver.schema}".decision_outbox_fault_seq`
      );
      await observer.query(`
        CREATE TRIGGER decision_outbox_fault_trg
          BEFORE INSERT ON projection_outbox
          FOR EACH ROW
          EXECUTE FUNCTION "${driver.schema}".decision_outbox_fault()`);
    });
    try {
      // The visibility rows and the decision row are written before the intent,
      // so only a real rollback can leave the store as it was: the proof that
      // these are one transaction rather than three writes that happen to
      // succeed together.
      await expect(
        decisions.applyDecision({
          request: {
            decisionId: unique("t16-outbox-fault"),
            context: seeded.context,
            candidateId: seeded.facts.candidateId,
            outcome: "retire_support",
            reason: "the outbox refuses, so the whole decision must refuse",
            retireSupportIds: [seeded.supports[0]!.supportId],
            retainSupportIds: [],
            assertionIds: seeded.facts.assertionIds,
            expectedInputRevision: seeded.facts.inputRevision,
            expectedRelationCatalogVersion: seeded.facts.relationCatalogVersion,
          },
          facts: seeded.facts,
        })
      ).rejects.toMatchObject({ code: "backend_unavailable" });
      expect(await port.fingerprint(seeded.scopeBinding)).toBe(before);
    } finally {
      await withObserver(async (observer) => {
        await observer.query(
          `DROP TRIGGER IF EXISTS decision_outbox_fault_trg ON projection_outbox`
        );
        await observer.query(
          `DROP FUNCTION IF EXISTS "${driver.schema}".decision_outbox_fault()`
        );
        await observer.query(
          `DROP SEQUENCE IF EXISTS "${driver.schema}".decision_outbox_fault_seq`
        );
      });
    }
  });
});

describe("strict PostgreSQL reporting contract", () => {
  afterAll(async () => {
    try {
      if (!driver.schema.startsWith(`${SCHEMA_PREFIX}_`)) {
        // EXIT: the teardown reached a schema this run's own prefix does not
        // name. It refuses and the schema survives, so a schema this run never
        // created is never dropped as if it had.
        throw new Error(
          `refusing to drop a schema outside this run's prefix: ${driver.schema}`
        );
      }
      await driver.dropOwnSchema(admin);
    } finally {
      await pool?.end();
      await backend?.close();
      await admin?.end();
    }
  });

  it("names no absent claim: every lane case ran against the real database", () => {
    requireFullyRunnable(NOT_RUN);
    expect(NOT_RUN.entries).toEqual([]);
  });
});
