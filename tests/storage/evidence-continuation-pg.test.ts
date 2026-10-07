/**
 * T14 EP4 — a caller continues or selects a row grant's frozen supports, and
 * the grant does not change.
 *
 * Everything here is real storage: a bootstrapped PostgreSQL schema, the
 * `PgvectorBackend` evidence store that mints support ids under the namespace
 * T12 froze, and continuations that lease a client from a pool and decide inside
 * one transaction. The expectations are derived from the ticket and the
 * Evidence spec, never from what a continuation returned.
 *
 * EXIT: this driver never skips. The opt-in marker and the DSN must both be
 * present or the module refuses at load, and an absent or unreachable database
 * is a named non-zero failure rather than a skip.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CONTRACT_VIOLATION,
  MAX_EVIDENCE_SUPPORTS_PER_PAGE,
  readGrantSupportContinuation,
  type EvidenceSupportRead,
  type SupportContinuationRequest,
} from "../../src/core/storage/evidence-continuation.js";
import {
  canonicalJson,
  contentDigestOf,
} from "../../src/core/storage/evidence-source.js";
import { MAX_EVIDENCE_BYTES } from "../../src/core/storage/evidence-store.js";
import { supportsEvidenceStore } from "../../src/core/storage/backend.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import {
  EVIDENCE_DENIAL_REASON,
  EVIDENCE_FAILURE,
  EVIDENCE_GRANT_KIND,
  EVIDENCE_SUBJECT_KIND,
  EVIDENCE_SUPPORT_ROLE,
  type EvidenceStore,
  type EvidenceSupportRef,
  type GrantRequest,
} from "../../src/core/types.js";
import {
  createPgIntegrationHarness,
  probePostgres,
  type PgIntegrationHarness,
} from "../integration/pg-test-harness.js";

// EXIT: this driver never skips. The opt-in marker and the DSN must both be
// present or the module refuses at load, and an absent or unreachable database
// is a named non-zero failure rather than a skip.
const OPT_IN = process.env.IK_STRUCTURED_T14_EP4_PG;
if (OPT_IN !== "1") {
  throw new Error(
    "evidence-continuation-pg.test.ts requires IK_STRUCTURED_T14_EP4_PG=1; it never skips"
  );
}
const DSN = process.env.GRAPHRAG_MEMORY_DB_URL;
if (typeof DSN !== "string" || DSN.trim() === "") {
  throw new Error(
    "evidence-continuation-pg.test.ts requires GRAPHRAG_MEMORY_DB_URL to be set; it never skips"
  );
}

const DIMENSIONS = 8;
const QUERIED_AT = "2026-03-01T12:00:00.000Z";
const EXTRACTED_AT = "2026-02-01T00:00:00.000Z";
const READ_AT = "2026-10-06T00:00:00.000Z";
const EXPIRED_AT = "2027-03-01T12:00:00.000Z";
const EXPIRES_AT_TEXT = "2027-03-01T12:00:00.000Z";
const PINNED_UNITS = 11;

const harness: PgIntegrationHarness = await createPgIntegrationHarness({
  schemaPrefix: "t14_ep4_continuation",
  defaultConnectionString: DSN,
  requiresVector: true,
  testPath: "tests/storage/evidence-continuation-pg.test.ts",
  label: "T14 EP4 support continuation",
  expectedCommand:
    "IK_STRUCTURED_T14_EP4_PG=1 GRAPHRAG_MEMORY_DB_URL=<dsn> npx vitest run tests/storage/evidence-continuation-pg.test.ts",
});

const reachability = await probePostgres(DSN, true);
if (!reachability.available) {
  throw new Error(
    "evidence-continuation-pg.test.ts requires a reachable PostgreSQL with pgvector " +
      "at the configured DSN; it reports an unreachable database as this failure " +
      "rather than skipping"
  );
}

let admin: pg.Client;
let pool: pg.Pool;
let backend: PgvectorBackend;
let store: EvidenceStore;
let caseSerial = 0;
let faultSerial = 0;

beforeAll(async () => {
  admin = harness.createClient(harness.schemaConnectionString);
  await admin.connect();
  await harness.resetSchema(admin);
  backend = new PgvectorBackend(harness.schemaConnectionString, DIMENSIONS, {
    annMaxDimensions: 2000,
  });
  await backend.initialize();
  if (!supportsEvidenceStore(backend)) {
    throw new Error("PgvectorBackend does not expose the evidence capability");
  }
  store = backend;
  pool = new pg.Pool({
    connectionString: harness.schemaConnectionString,
    max: 4,
  });
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
  if (backend !== undefined) await backend.close();
  if (admin !== undefined) {
    await harness.dropSchema(admin);
    await admin.end();
  }
});

/** Each case gets its own scope, source and grants, so nothing can cross-talk. */
function nextCaseId(): string {
  caseSerial += 1;
  return `t14c${caseSerial}`;
}

interface SeededCase {
  readonly caseId: string;
  readonly scope: string;
  readonly sourceRef: string;
  readonly sourceVersionId: string;
  readonly units: number;
}

async function seedCase(
  units: number,
  sourceRefSuffix = ""
): Promise<SeededCase> {
  const caseId = nextCaseId();
  const sourceRef = `${caseId}-source${sourceRefSuffix}`;
  const { record } = await store.registerSourceVersion({
    source_ref: sourceRef,
    source_version: "v1",
    content_digest: contentDigestOf(`${caseId}-content`),
    origin_object_ref: `objects/${caseId}/original.pdf`,
    parser_revision: "parser-v1",
    unit_manifest: { units },
    created_at: EXTRACTED_AT,
  });
  for (let unit = 1; unit <= units; unit += 1) {
    await store.bindSourceLocator({
      source_version_id: record.source_version_id,
      document_id: `${caseId}-doc`,
      version: "frozen-v1",
      unit,
    });
  }
  await store.setScopeRevisions(`${caseId}-scope`, {
    authorizationRevision: "auth-1",
    purgeRevision: "purge-1",
  });
  return {
    caseId,
    scope: `${caseId}-scope`,
    sourceRef,
    sourceVersionId: record.source_version_id,
    units,
  };
}

async function recordUnits(
  seeded: SeededCase,
  count: number,
  options: {
    readonly firstUnit?: number;
    readonly extractionRef?: (unit: number) => string;
  } = {}
): Promise<readonly EvidenceSupportRef[]> {
  const firstUnit = options.firstUnit ?? 1;
  const extractionRef =
    options.extractionRef ?? (() => `${seeded.caseId}-extraction-1`);
  const refs: EvidenceSupportRef[] = [];
  for (let unit = firstUnit; unit < firstUnit + count; unit += 1) {
    const { support } = await store.recordSupport({
      subject: EVIDENCE_SUBJECT_KIND.ENTITY,
      result_id: `${seeded.caseId}-result`,
      source_ref: seeded.sourceRef,
      source_version: "v1",
      location: {
        document_id: `${seeded.caseId}-doc`,
        version: "frozen-v1",
        unit,
      },
      span: null,
      extraction_ref: extractionRef(unit),
      extractedAt: EXTRACTED_AT,
    });
    refs.push({
      support_id: support.support_id,
      role: EVIDENCE_SUPPORT_ROLE.OCCURRENCE,
    });
  }
  return refs;
}

function rowGrantFor(
  seeded: SeededCase,
  supports: readonly EvidenceSupportRef[]
): GrantRequest {
  return {
    kind: EVIDENCE_GRANT_KIND.ROW,
    subject: EVIDENCE_SUBJECT_KIND.ENTITY,
    operation: "list",
    queryDigest: `${seeded.caseId}-query`,
    scopeBinding: seeded.scope,
    readRevision: "read-1",
    queriedAt: QUERIED_AT,
    context: { coverage: "stored_structured_subjects" },
    value: { entity_id: `${seeded.caseId}-result`, name: "某公司" },
    supports,
    consumerId: `${seeded.caseId}-consumer`,
  } as GrantRequest;
}

async function lease(): Promise<pg.PoolClient> {
  return pool.connect();
}

function requestFor(
  seeded: SeededCase,
  evidenceRef: string,
  patch: Partial<SupportContinuationRequest> = {}
): SupportContinuationRequest {
  return {
    evidenceRef,
    at: READ_AT,
    caller: {
      scopeBinding: seeded.scope,
      authorizedSourceRefs: [seeded.sourceRef],
    },
    ...patch,
  };
}

function continue_(
  seeded: SeededCase,
  evidenceRef: string,
  patch: Partial<SupportContinuationRequest> = {}
): Promise<EvidenceSupportRead> {
  return readGrantSupportContinuation(
    lease,
    requestFor(seeded, evidenceRef, patch)
  );
}

function expectGranted(
  outcome: EvidenceSupportRead
): Extract<EvidenceSupportRead, { state: "granted" }> {
  expect(outcome.state, JSON.stringify(outcome)).toBe("granted");
  if (outcome.state !== "granted") throw new Error("unreachable");
  return outcome;
}

function expectWithheld(
  outcome: EvidenceSupportRead,
  failure: string,
  reason: string
): void {
  expect(outcome.state).toBe("denied");
  expect(outcome).toMatchObject({ state: "denied", failure, reason });
  expect(outcome).not.toHaveProperty("supports");
  expect(outcome).not.toHaveProperty("next_cursor");
}

async function fingerprintGrants(): Promise<Record<string, unknown>> {
  const observer = new pg.Client({
    connectionString: harness.schemaConnectionString,
  });
  await observer.connect();
  try {
    const grants = await observer.query<Record<string, unknown>>(
      `SELECT evidence_ref, grant_kind, scope_binding, authorization_revision,
              purge_revision, queried_at::text AS queried_at,
              expires_at::text AS expires_at, result_count, context::text AS context,
              value::text AS value
         FROM evidence_grants ORDER BY evidence_ref`
    );
    const memberships = await observer.query<Record<string, unknown>>(
      `SELECT evidence_ref, support_id::text AS support_id, role
         FROM evidence_grant_supports ORDER BY evidence_ref, support_id`
    );
    const pinned = await observer.query<Record<string, unknown>>(
      `SELECT evidence_ref, support_id::text AS support_id, extraction_ref
         FROM evidence_grant_extractions ORDER BY evidence_ref, support_id, extraction_ref`
    );
    const revisions = await observer.query<Record<string, unknown>>(
      `SELECT scope_binding, authorization_revision, purge_revision
         FROM evidence_scope_revisions ORDER BY scope_binding`
    );
    const receipts = await observer.query<Record<string, unknown>>(
      `SELECT receipt_id::text AS receipt_id, scope_binding
         FROM evidence_authorization_receipts ORDER BY receipt_id`
    );
    return {
      grants: grants.rows,
      memberships: memberships.rows,
      pinned,
      revisions: revisions.rows,
      receipts: receipts.rows,
    };
  } finally {
    await observer.end();
  }
}

function decodedCursor(cursor: string): Record<string, string> {
  return JSON.parse(
    Buffer.from(cursor, "base64url").toString("utf8")
  ) as Record<string, string>;
}

function encodeCursor(payload: Record<string, string>): string {
  return Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
}

async function armWriteFault(table: string): Promise<string> {
  faultSerial += 1;
  const suffix = `t14_fault_${faultSerial}`;
  const sequence = `${harness.schema}.${suffix}_sequence`;
  await pool.query(`CREATE SEQUENCE "${harness.schema}"."${suffix}_sequence"`);
  await pool.query(`
    CREATE FUNCTION "${harness.schema}"."${suffix}_function"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $t14_fault$
    BEGIN
      IF nextval('${sequence}'::regclass) = 1 THEN
        RAISE EXCEPTION 'injected continuation write at ${table}'
          USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END;
    $t14_fault$`);
  await pool.query(`
    CREATE TRIGGER "${suffix}_trigger"
    BEFORE INSERT OR UPDATE OR DELETE ON "${harness.schema}"."${table}"
    FOR EACH ROW EXECUTE FUNCTION "${harness.schema}"."${suffix}_function"()`);
  return suffix;
}

async function disarmWriteFault(suffix: string, table: string): Promise<void> {
  await pool.query(
    `DROP TRIGGER IF EXISTS "${suffix}_trigger" ON "${harness.schema}"."${table}"`
  );
}

describe("T14 EP4 support continuation over real PostgreSQL", () => {
  it("pages the frozen supports in stable UUID order, eight at a time, inside the 32 KiB envelope", async () => {
    const seeded = await seedCase(PINNED_UNITS);
    const refs = await recordUnits(seeded, PINNED_UNITS);
    const { evidence_ref: evidenceRef } = await store.issueGrant(
      rowGrantFor(seeded, refs)
    );
    const ascending = [...refs]
      .map((ref) => ref.support_id)
      .sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));

    const first = expectGranted(await continue_(seeded, evidenceRef));
    expect(first.supports).toHaveLength(MAX_EVIDENCE_SUPPORTS_PER_PAGE);
    expect(first.supports.map((entry) => entry.support_id)).toEqual(
      ascending.slice(0, 8)
    );
    expect(first.total_supports).toBe(PINNED_UNITS);
    expect(first.next_cursor).not.toBeNull();
    expect(first.expires_at).toBe(EXPIRES_AT_TEXT);
    const firstBytes = Buffer.byteLength(JSON.stringify(first), "utf8");
    expect(firstBytes).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES);

    const second = expectGranted(
      await continue_(seeded, evidenceRef, { cursor: first.next_cursor })
    );
    expect(second.supports.map((entry) => entry.support_id)).toEqual(
      ascending.slice(8)
    );
    expect(second.next_cursor).toBeNull();
    const secondBytes = Buffer.byteLength(JSON.stringify(second), "utf8");
    expect(secondBytes).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES);
    expect([
      ...first.supports.map((entry) => entry.support_id),
      ...second.supports.map((entry) => entry.support_id),
    ]).toEqual(ascending);

    // EXIT: the page-by-page sequence and the two observed envelope sizes are
    // the ticket's "at most eight and within 32 KiB" clause as measured.
    console.log(
      `T14 page 1 (${first.supports.length} ids, ${firstBytes} bytes): ${first.supports
        .map((entry) => entry.support_id)
        .join(",")}`
    );
    console.log(
      `T14 page 2 (${second.supports.length} ids, ${secondBytes} bytes): ${second.supports
        .map((entry) => entry.support_id)
        .join(",")}`
    );
  });

  it("refuses a request carrying both a continuation cursor and a selected support id", async () => {
    const seeded = await seedCase(PINNED_UNITS);
    const refs = await recordUnits(seeded, PINNED_UNITS);
    const { evidence_ref: evidenceRef } = await store.issueGrant(
      rowGrantFor(seeded, refs)
    );
    const first = expectGranted(await continue_(seeded, evidenceRef));
    expectWithheld(
      await continue_(seeded, evidenceRef, {
        cursor: first.next_cursor,
        supportId: refs[0]!.support_id,
      }),
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "contract_violation"
    );
  });

  it("refuses a selected support outside the grant and resolves a relationship-endpoint display support beyond the inline prefix", async () => {
    const seeded = await seedCase(PINNED_UNITS);
    const refs = await recordUnits(seeded, PINNED_UNITS);
    const ascending = [...refs]
      .map((ref) => ref.support_id)
      .sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
    const endpointSupportId = ascending[ascending.length - 1]!;
    const endpointRefs = refs.map((ref) =>
      ref.support_id === endpointSupportId
        ? {
            support_id: ref.support_id,
            role: EVIDENCE_SUPPORT_ROLE.ENDPOINT_DISPLAY,
          }
        : ref
    );
    const { evidence_ref: evidenceRef } = await store.issueGrant(
      rowGrantFor(seeded, endpointRefs)
    );
    const other = await seedCase(2);
    const otherRefs = await recordUnits(other, 2);
    const foreign = otherRefs[0]!.support_id;

    const first = expectGranted(await continue_(seeded, evidenceRef));
    expect(first.supports.map((entry) => entry.support_id)).not.toContain(
      endpointSupportId
    );

    const selected = expectGranted(
      await continue_(seeded, evidenceRef, { supportId: endpointSupportId })
    );
    expect(selected.selected).toBe(true);
    expect(selected.supports).toHaveLength(1);
    expect(selected.supports[0]!.support_id).toBe(endpointSupportId);
    expect(selected.supports[0]!.role).toBe(
      EVIDENCE_SUPPORT_ROLE.ENDPOINT_DISPLAY
    );
    expect(selected.next_cursor).toBeNull();

    expectWithheld(
      await continue_(seeded, evidenceRef, { supportId: foreign }),
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "contract_violation"
    );
    expectWithheld(
      await continue_(seeded, evidenceRef, { supportId: randomUUID() }),
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "contract_violation"
    );
  });

  it("refuses any supports read of a count grant", async () => {
    const seeded = await seedCase(1);
    await recordUnits(seeded, 1);
    const { evidence_ref: evidenceRef } = await store.issueGrant({
      kind: EVIDENCE_GRANT_KIND.COUNT,
      subject: EVIDENCE_SUBJECT_KIND.ASSERTION,
      operation: "count",
      queryDigest: `${seeded.caseId}-query`,
      scopeBinding: seeded.scope,
      readRevision: "read-1",
      queriedAt: QUERIED_AT,
      context: { coverage: "stored_structured_subjects" },
      value: { count: 1, operation: "count" },
      count: 1,
      consumerId: `${seeded.caseId}-consumer`,
    } as GrantRequest);
    expectWithheld(
      await continue_(seeded, evidenceRef),
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "contract_violation"
    );
  });

  it("withholds the whole grant when the trusted caller's scope is another scope", async () => {
    const seeded = await seedCase(PINNED_UNITS);
    const refs = await recordUnits(seeded, PINNED_UNITS);
    const { evidence_ref: evidenceRef } = await store.issueGrant(
      rowGrantFor(seeded, refs)
    );
    expectWithheld(
      await readGrantSupportContinuation(lease, {
        evidenceRef,
        at: READ_AT,
        caller: {
          scopeBinding: `${seeded.scope}-other`,
          authorizedSourceRefs: [seeded.sourceRef],
        },
      }),
      EVIDENCE_FAILURE.ACCESS_DENIED,
      EVIDENCE_DENIAL_REASON.AUTHORIZATION_REVOKED
    );
  });

  it("withholds the whole grant when the trusted caller's authorized subset excludes a pinned source", async () => {
    const seeded = await seedCase(PINNED_UNITS);
    const refs = await recordUnits(seeded, PINNED_UNITS);
    const { evidence_ref: evidenceRef } = await store.issueGrant(
      rowGrantFor(seeded, refs)
    );
    expectWithheld(
      await readGrantSupportContinuation(lease, {
        evidenceRef,
        at: READ_AT,
        caller: {
          scopeBinding: seeded.scope,
          authorizedSourceRefs: ["a-source-it-cannot-read"],
        },
      }),
      EVIDENCE_FAILURE.ACCESS_DENIED,
      EVIDENCE_DENIAL_REASON.AUTHORIZATION_REVOKED
    );
  });

  it("withholds the whole grant when the fixed lifetime has ended", async () => {
    const seeded = await seedCase(PINNED_UNITS);
    const refs = await recordUnits(seeded, PINNED_UNITS);
    const { evidence_ref: evidenceRef } = await store.issueGrant(
      rowGrantFor(seeded, refs)
    );
    const first = expectGranted(await continue_(seeded, evidenceRef));
    expect(first.next_cursor).not.toBeNull();
    expectWithheld(
      await continue_(seeded, evidenceRef, {
        at: EXPIRED_AT,
        cursor: first.next_cursor,
      }),
      EVIDENCE_FAILURE.EXPIRED,
      EVIDENCE_DENIAL_REASON.EXPIRED
    );
  });

  it("withholds the whole grant when the scope's purge revision advanced", async () => {
    const seeded = await seedCase(PINNED_UNITS);
    const refs = await recordUnits(seeded, PINNED_UNITS);
    const { evidence_ref: evidenceRef } = await store.issueGrant(
      rowGrantFor(seeded, refs)
    );
    const first = expectGranted(await continue_(seeded, evidenceRef));
    await store.setScopeRevisions(seeded.scope, { purgeRevision: "purge-2" });
    expectWithheld(
      await continue_(seeded, evidenceRef, { cursor: first.next_cursor }),
      EVIDENCE_FAILURE.UNAVAILABLE,
      EVIDENCE_DENIAL_REASON.PURGED
    );
    expectWithheld(
      await continue_(seeded, evidenceRef),
      EVIDENCE_FAILURE.UNAVAILABLE,
      EVIDENCE_DENIAL_REASON.PURGED
    );
  });

  it("withholds the whole grant when the scope's authorization revision advanced", async () => {
    const seeded = await seedCase(PINNED_UNITS);
    const refs = await recordUnits(seeded, PINNED_UNITS);
    const { evidence_ref: evidenceRef } = await store.issueGrant(
      rowGrantFor(seeded, refs)
    );
    const first = expectGranted(await continue_(seeded, evidenceRef));
    await store.setScopeRevisions(seeded.scope, {
      authorizationRevision: "auth-2",
    });
    expectWithheld(
      await continue_(seeded, evidenceRef, { cursor: first.next_cursor }),
      EVIDENCE_FAILURE.ACCESS_DENIED,
      EVIDENCE_DENIAL_REASON.AUTHORIZATION_REVOKED
    );
    expectWithheld(
      await continue_(seeded, evidenceRef),
      EVIDENCE_FAILURE.ACCESS_DENIED,
      EVIDENCE_DENIAL_REASON.AUTHORIZATION_REVOKED
    );
  });

  it("withholds the whole grant when one pinned source version stopped accepting obligations", async () => {
    const seeded = await seedCase(PINNED_UNITS);
    const refs = await recordUnits(seeded, PINNED_UNITS);
    const { evidence_ref: evidenceRef } = await store.issueGrant(
      rowGrantFor(seeded, refs)
    );
    const first = expectGranted(await continue_(seeded, evidenceRef));
    await store.stopAcceptingObligations(
      seeded.sourceVersionId,
      "2026-09-01T00:00:00.000Z"
    );
    expectWithheld(
      await continue_(seeded, evidenceRef, { cursor: first.next_cursor }),
      EVIDENCE_FAILURE.UNAVAILABLE,
      EVIDENCE_DENIAL_REASON.OBLIGATIONS_STOPPED
    );
    expectWithheld(
      await continue_(seeded, evidenceRef),
      EVIDENCE_FAILURE.UNAVAILABLE,
      EVIDENCE_DENIAL_REASON.OBLIGATIONS_STOPPED
    );
    expectWithheld(
      await continue_(seeded, evidenceRef, { supportId: refs[0]!.support_id }),
      EVIDENCE_FAILURE.UNAVAILABLE,
      EVIDENCE_DENIAL_REASON.OBLIGATIONS_STOPPED
    );
  });

  it("mints a cursor bound to one reference, one caller and one expiry, and refuses every other combination", async () => {
    const seeded = await seedCase(PINNED_UNITS);
    const refs = await recordUnits(seeded, PINNED_UNITS);
    const { evidence_ref: evidenceRef } = await store.issueGrant(
      rowGrantFor(seeded, refs)
    );
    const siblingRefs = refs.slice(0, PINNED_UNITS - 3);
    const { evidence_ref: siblingRef } = await store.issueGrant({
      ...rowGrantFor(seeded, siblingRefs),
      queryDigest: `${seeded.caseId}-query-sibling`,
    } as GrantRequest);
    const first = expectGranted(await continue_(seeded, evidenceRef));
    const cursor = String(first.next_cursor);
    const payload = decodedCursor(cursor);
    expect(Object.keys(payload).sort()).toEqual([
      "after",
      "exp",
      "ref",
      "scope",
      "v",
    ]);
    expect(payload["ref"]).toBe(evidenceRef);
    expect(payload["scope"]).toBe(seeded.scope);
    expect(payload["exp"]).toBe(EXPIRES_AT_TEXT);

    expectWithheld(
      await continue_(seeded, siblingRef, { cursor }),
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "contract_violation"
    );
    expectWithheld(
      await readGrantSupportContinuation(lease, {
        evidenceRef,
        at: READ_AT,
        cursor,
        caller: {
          scopeBinding: `${seeded.scope}-other`,
          authorizedSourceRefs: [seeded.sourceRef],
        },
      }),
      EVIDENCE_FAILURE.ACCESS_DENIED,
      EVIDENCE_DENIAL_REASON.AUTHORIZATION_REVOKED
    );

    const tampered = Buffer.from(
      JSON.stringify({ ...payload, exp: "2030-01-01T00:00:00.000Z" }),
      "utf8"
    ).toString("base64url");
    expectWithheld(
      await continue_(seeded, evidenceRef, { cursor: tampered }),
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "contract_violation"
    );

    const retargeted = Buffer.from(
      JSON.stringify({ ...payload, ref: siblingRef }),
      "utf8"
    ).toString("base64url");
    expectWithheld(
      await continue_(seeded, evidenceRef, { cursor: retargeted }),
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "contract_violation"
    );

    const foreignPosition = Buffer.from(
      JSON.stringify({ ...payload, after: randomUUID() }),
      "utf8"
    ).toString("base64url");
    expectWithheld(
      await continue_(seeded, evidenceRef, { cursor: foreignPosition }),
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "contract_violation"
    );

    const wrongVersion = Buffer.from(
      JSON.stringify({ ...payload, v: "0" }),
      "utf8"
    ).toString("base64url");
    expectWithheld(
      await continue_(seeded, evidenceRef, { cursor: wrongVersion }),
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "contract_violation"
    );

    expectWithheld(
      await continue_(seeded, evidenceRef, { cursor: "not-a-cursor" }),
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      "contract_violation"
    );

    expectWithheld(
      await continue_(seeded, evidenceRef, {
        cursor: "A".repeat(MAX_EVIDENCE_BYTES + 1),
      }),
      EVIDENCE_FAILURE.TOO_LARGE,
      "contract_violation"
    );
  });

  it("refuses a page that cannot fit the bounded envelope instead of dropping a descriptor", async () => {
    const padding = "x".repeat(5500);
    const seeded = await seedCase(8, `-${padding}`);
    const refs = await recordUnits(seeded, 8);
    const { evidence_ref: evidenceRef } = await store.issueGrant(
      rowGrantFor(seeded, refs)
    );
    expectWithheld(
      await continue_(seeded, evidenceRef),
      EVIDENCE_FAILURE.TOO_LARGE,
      "contract_violation"
    );
  });

  it("does not requery current supports, mint no grant and leave the expiry byte-identical", async () => {
    const seeded = await seedCase(PINNED_UNITS + 4);
    const refs = await recordUnits(seeded, PINNED_UNITS);
    const { evidence_ref: evidenceRef } = await store.issueGrant(
      rowGrantFor(seeded, refs)
    );
    const stamp = async (): Promise<Record<string, unknown>> => {
      const observer = new pg.Client({
        connectionString: harness.schemaConnectionString,
      });
      await observer.connect();
      try {
        const grant = await observer.query<Record<string, unknown>>(
          `SELECT queried_at::text AS queried_at, expires_at::text AS expires_at,
                  scope_binding, authorization_revision, purge_revision
             FROM evidence_grants WHERE evidence_ref = $1`,
          [evidenceRef]
        );
        const count = await observer.query<{ total: number }>(
          `SELECT count(*)::int AS total FROM evidence_grants WHERE scope_binding = $1`,
          [seeded.scope]
        );
        return {
          grant: grant.rows[0],
          grants_under_scope: count.rows[0]?.total,
        };
      } finally {
        await observer.end();
      }
    };
    const before = await fingerprintGrants();
    const beforeStamp = await stamp();
    const first = expectGranted(await continue_(seeded, evidenceRef));
    expect(first.expires_at).toBe(EXPIRES_AT_TEXT);

    const later = await recordUnits(seeded, 3, {
      firstUnit: PINNED_UNITS + 1,
      extractionRef: () => `${seeded.caseId}-extraction-2`,
    });
    expect(later).toHaveLength(3);
    const newSupportIds = later.map((ref) => ref.support_id);
    await store.recordSupport({
      subject: EVIDENCE_SUBJECT_KIND.ENTITY,
      result_id: `${seeded.caseId}-result`,
      source_ref: seeded.sourceRef,
      source_version: "v1",
      location: {
        document_id: `${seeded.caseId}-doc`,
        version: "frozen-v1",
        unit: 1,
      },
      span: null,
      extraction_ref: `${seeded.caseId}-extraction-3`,
      extractedAt: EXTRACTED_AT,
    });

    const after = await fingerprintGrants();
    expect(after, "a continuation minted or changed a grant row").toEqual(
      before
    );

    const second = expectGranted(
      await continue_(seeded, evidenceRef, { cursor: first.next_cursor })
    );
    const sequence = [...first.supports, ...second.supports].map(
      (entry) => entry.support_id
    );
    const pinnedAscending = [...refs]
      .map((ref) => ref.support_id)
      .sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
    expect(sequence).toEqual(pinnedAscending);
    for (const id of newSupportIds) expect(sequence).not.toContain(id);
    expect(second.expires_at).toBe(first.expires_at);
    for (const entry of [...first.supports, ...second.supports]) {
      expect(entry.extraction_refs).toEqual([`${seeded.caseId}-extraction-1`]);
    }

    const afterStamp = await stamp();
    expect(afterStamp.grant?.["queried_at"]).toBe(
      beforeStamp.grant?.["queried_at"]
    );
    expect(afterStamp.grant?.["expires_at"]).toBe(
      beforeStamp.grant?.["expires_at"]
    );
    expect(afterStamp.grants_under_scope).toBe(1);
    expect(beforeStamp.grant?.["queried_at"]).toBe("2026-03-01 12:00:00+00");
    expect(beforeStamp.grant?.["expires_at"]).toBe("2027-03-01 12:00:00+00");
  });

  it("writes nothing: a fault armed on every evidence table still lets both pages through", async () => {
    const seeded = await seedCase(PINNED_UNITS);
    const refs = await recordUnits(seeded, PINNED_UNITS);
    const { evidence_ref: evidenceRef } = await store.issueGrant(
      rowGrantFor(seeded, refs)
    );
    const tables = [
      "evidence_grants",
      "evidence_grant_supports",
      "evidence_grant_extractions",
      "evidence_scope_revisions",
    ];
    const armed: Array<{ suffix: string; table: string }> = [];
    for (const table of tables) {
      armed.push({ suffix: await armWriteFault(table), table });
    }
    try {
      const first = expectGranted(await continue_(seeded, evidenceRef));
      const second = expectGranted(
        await continue_(seeded, evidenceRef, { cursor: first.next_cursor })
      );
      expect(first.supports.length + second.supports.length).toBe(PINNED_UNITS);
    } finally {
      for (const entry of armed)
        await disarmWriteFault(entry.suffix, entry.table);
    }
  });

  it("reports a backend failure on its own connection as a typed store failure, not an empty page", async () => {
    const seeded = await seedCase(PINNED_UNITS);
    const refs = await recordUnits(seeded, PINNED_UNITS);
    const { evidence_ref: evidenceRef } = await store.issueGrant(
      rowGrantFor(seeded, refs)
    );
    const dead = new pg.Client({
      connectionString: harness.schemaConnectionString,
    });
    await dead.connect();
    await dead.end();
    const broken = {
      query: (text: string, values?: unknown[]) => dead.query(text, values),
      release: () => undefined,
    };
    let caught: unknown;
    try {
      await readGrantSupportContinuation(
        async () => broken,
        requestFor(seeded, evidenceRef)
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, "expected a typed store failure").toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe("STORAGE_ERROR");
  });

  it("withholds the whole grant when a pinned support no longer resolves", async () => {
    const seeded = await seedCase(PINNED_UNITS);
    const refs = await recordUnits(seeded, PINNED_UNITS);
    const { evidence_ref: evidenceRef } = await store.issueGrant(
      rowGrantFor(seeded, refs)
    );
    const first = expectGranted(await continue_(seeded, evidenceRef));
    for (const table of [
      "evidence_grant_supports",
      "evidence_grant_extractions",
    ]) {
      const constraints = await admin.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = $1::regclass AND contype = 'f'`,
        [`${harness.schema}.${table}`]
      );
      for (const constraint of constraints.rows) {
        await admin.query(
          `ALTER TABLE "${harness.schema}"."${table}" DROP CONSTRAINT "${constraint.conname}"`
        );
      }
    }
    await admin.query(
      `DELETE FROM "${harness.schema}".assertion_supports WHERE support_id = $1`,
      [refs[0]!.support_id]
    );
    expectWithheld(
      await continue_(seeded, evidenceRef, { cursor: first.next_cursor }),
      EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING,
      EVIDENCE_DENIAL_REASON.DEPENDENCY_UNRESOLVED
    );
    expectWithheld(
      await continue_(seeded, evidenceRef),
      EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING,
      EVIDENCE_DENIAL_REASON.DEPENDENCY_UNRESOLVED
    );
  });

  it("refuses a position past the end of the pinned membership instead of an empty page", async () => {
    const seeded = await seedCase(PINNED_UNITS);
    const refs = await recordUnits(seeded, PINNED_UNITS);
    const { evidence_ref: evidenceRef } = await store.issueGrant(
      rowGrantFor(seeded, refs)
    );
    const first = expectGranted(await continue_(seeded, evidenceRef));
    const ascending = [...refs]
      .map((ref) => ref.support_id)
      .sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
    const last = ascending[ascending.length - 1]!;

    // EXIT: the last support's own cursor is never minted, so a caller cannot
    // hold one. Forcing the position past the end therefore has to be refused
    // by the page builder, which is the branch this case exists to pin.
    // Selecting that same support by id must still be granted — a cursor past
    // the end and a named member are different reads.
    expect(ascending.slice(0, 8)).not.toContain(last);
    const forged = encodeCursor({
      ...decodedCursor(first.next_cursor!),
      after: last,
    });
    expectWithheld(
      await continue_(seeded, evidenceRef, { cursor: forged }),
      EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      CONTRACT_VIOLATION
    );
    const selected = expectGranted(
      await continue_(seeded, evidenceRef, { supportId: last })
    );
    expect(selected.supports.map((entry) => entry.support_id)).toEqual([last]);
    expect(selected.selected).toBe(true);
    expect(selected.next_cursor).toBeNull();
  });

  it("answers every caller-supplied input fault with a refusal rather than an exception", async () => {
    const seeded = await seedCase(PINNED_UNITS);
    const refs = await recordUnits(seeded, PINNED_UNITS);
    const { evidence_ref: evidenceRef } = await store.issueGrant(
      rowGrantFor(seeded, refs)
    );
    const first = expectGranted(await continue_(seeded, evidenceRef));

    const malformed = [
      { label: "non-uuid support_id", patch: { supportId: "not-a-uuid" } },
      {
        label: "uppercase-braced support_id",
        patch: { supportId: `{${randomUUID()}}` },
      },
      { label: "blank evidence_ref", patch: { evidenceRef: "   " } },
      { label: "non-instant at", patch: { at: "yesterday" } },
      { label: "date-only at", patch: { at: "2026-10-06" } },
    ];
    for (const { label, patch } of malformed) {
      expectWithheld(
        await continue_(seeded, evidenceRef, patch),
        EVIDENCE_FAILURE.MALFORMED_CONTRACT,
        CONTRACT_VIOLATION
      );
      expect(label).toBeTruthy();
    }

    // EXIT: an absent identity and a mismatched one are the same token but not the
    // same fact, so the detail is what tells them apart. The authorized subset
    // here is deliberately complete, so the refusal can only be the binding's.
    const unbound: Array<[string, unknown, string]> = [
      ["no caller at all", null, "carries no trusted caller binding"],
      ["an undefined caller", undefined, "carries no trusted caller binding"],
      [
        "a blank scope binding",
        { scopeBinding: "", authorizedSourceRefs: [seeded.sourceRef] },
        "carries no scope binding",
      ],
      [
        "a whitespace scope binding",
        { scopeBinding: "   ", authorizedSourceRefs: [seeded.sourceRef] },
        "carries no scope binding",
      ],
    ];
    for (const [label, caller, fragment] of unbound) {
      const outcome = await continue_(seeded, evidenceRef, {
        caller: caller as never,
      });
      expectWithheld(
        outcome,
        EVIDENCE_FAILURE.ACCESS_DENIED,
        EVIDENCE_DENIAL_REASON.AUTHORIZATION_REVOKED
      );
      if (outcome.state === "denied") {
        expect(outcome.detail, label).toContain(fragment);
      }
    }
    const mismatched = await continue_(seeded, evidenceRef, {
      caller: {
        scopeBinding: "some-other-scope",
        authorizedSourceRefs: [seeded.sourceRef],
      },
    });
    expectWithheld(
      mismatched,
      EVIDENCE_FAILURE.ACCESS_DENIED,
      EVIDENCE_DENIAL_REASON.AUTHORIZATION_REVOKED
    );
    if (mismatched.state === "denied") {
      expect(mismatched.detail).toContain(
        "is not the scope this grant was admitted under"
      );
    }

    expectWithheld(
      await continue_(seeded, evidenceRef, {
        caller: { scopeBinding: seeded.scope, authorizedSourceRefs: [] },
      }),
      EVIDENCE_FAILURE.ACCESS_DENIED,
      EVIDENCE_DENIAL_REASON.AUTHORIZATION_REVOKED
    );

    // EXIT: an absent, null and empty selector all mean the absence of that
    // selector, so the first page is answered rather than a refusal.
    const absent = expectGranted(await continue_(seeded, evidenceRef));
    expect(absent.supports.map((entry) => entry.support_id)).toEqual(
      first.supports.map((entry) => entry.support_id)
    );
    for (const patch of [
      { cursor: null },
      { cursor: "" },
      { supportId: "" },
      { supportId: null },
    ]) {
      const outcome = expectGranted(
        await continue_(seeded, evidenceRef, patch)
      );
      expect(outcome.supports.map((entry) => entry.support_id)).toEqual(
        first.supports.map((entry) => entry.support_id)
      );
    }
  });
});
