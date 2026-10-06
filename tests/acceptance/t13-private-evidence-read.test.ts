import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  isScopeFailureCode,
  readTrustedIdentityBinding,
  resolveEvidenceScopeContext,
  TRUSTED_BINDING_ENV_VARS,
} from "../../src/core/storage/evidence-binding.js";
import {
  EVIDENCE_ACTION,
  EVIDENCE_REFUSAL_REASON,
  parseEvidenceRequest,
  readPrivateEvidence,
  type EvidenceReadResult,
  type EvidenceRefusalReason,
} from "../../src/core/storage/evidence-read.js";
import {
  createEvidenceDispatcher,
  supportsEvidenceScopeAuthority,
} from "../../src/core/storage/evidence-dispatch.js";
import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import { createEvidenceTables } from "../../src/core/storage/schema-evidence.js";
import { upSchemaMaintenanceWork } from "../../src/core/storage/schema-maintenance-work.js";
import { upSchemaPublication } from "../../src/core/storage/schema-publication.js";
import {
  PgStructuredScopeUnitOfWork,
  type ScopeTransactionClient,
} from "../../src/core/storage/structured-scope-uow.js";
import {
  STRUCTURED_SCOPE_FAILURE_CODES,
  StructuredScopeError,
  type AuthorizedScopeContext,
} from "../../src/core/storage/structured-scope-types.js";
import { EVIDENCE_FAILURE } from "../../src/core/types.js";
import {
  openStrictPgDriver,
  type NotRunCase,
} from "./strict-pg-driver.js";

const EXPECTED_COMMAND =
  "STRUCTURED_EVIDENCE_T13_ACCEPTANCE=1 GRAPHRAG_MEMORY_DB_URL=... npx vitest run tests/acceptance/t13-private-evidence-read.test.ts";
const SCHEMA_PREFIX = "t13_ep3_ik";
const DIMENSIONS = 8;
const TEST_PATH = "tests/acceptance/t13-private-evidence-read.test.ts";
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

if (!process.env["GRAPHRAG_MEMORY_DB_URL"]) {
  // EXIT: the DSN is absent. The module load throws before the strict driver,
  // the harness, the schema or the pool exists, so the lane exits non-zero
  // naming the absent variable instead of falling back to a default endpoint.
  throw new Error(
    [
      "GRAPHRAG_MEMORY_DB_URL is required to run this acceptance driver.",
      "Validation:",
      `- Not run: ${TEST_PATH}`,
      `- Expected command: ${EXPECTED_COMMAND}`,
      "- Blocking issue: GRAPHRAG_MEMORY_DB_URL is absent, so no Evidence read",
      "  could be observed against real PostgreSQL 16.15 with pgvector 0.8.6.",
      "- This driver deliberately has no skip path and no default endpoint.",
    ].join("\n")
  );
}

const BUILD_ENTRY = `${REPO_ROOT}dist/index.js`;
try {
  readFileSync(BUILD_ENTRY);
} catch {
  // EXIT: the iknow build is missing. The Fin lane drives this exact artifact
  // as a child process, so a lane that passes in process while its build is
  // stale would let the two sides drift apart unnoticed.
  throw new Error(
    [
      `The iknow build is missing at ${BUILD_ENTRY}.`,
      "Validation:",
      `- Not run: ${TEST_PATH}`,
      `- Expected command: ${EXPECTED_COMMAND}`,
      "- Blocking issue: `npm run build` has not produced dist/index.js, so the",
      "  built artifact the Fin private-session lane drives cannot be verified",
      "  against this source.",
      "- This driver deliberately has no skip path.",
    ].join("\n")
  );
}

const driver = await openStrictPgDriver({
  envName: "STRUCTURED_EVIDENCE_T13_ACCEPTANCE",
  testPath: TEST_PATH,
  expectedCommand: EXPECTED_COMMAND,
  label: "t13-private-evidence-read-pg",
  schemaPrefix: SCHEMA_PREFIX,
  dependency: "real PostgreSQL with pgvector",
});

const SCHEMA_URL = driver.schemaConnectionString;
const AT = "2026-05-01T00:00:00.000Z";
// EXIT: the deadline must be live in real time. The seam refuses an elapsed
// deadline before it leases a connection, so a fixed past instant would make
// every read in this lane refuse for the wrong reason and prove nothing.
const DEADLINE = new Date(Date.now() + 600_000).toISOString();

const SCOPE_A = "t13-owner-scope-a";
const SCOPE_B = "t13-owner-scope-b";
const SOURCE_A1 = "t13-source-a1";
const SOURCE_A2 = "t13-source-a2";
const SOURCE_B1 = "t13-source-b1";
const AUTH_REV = "t13-auth-rev-1";
const AUTH_REV_MOVED = "t13-auth-rev-2";
const PURGE_REV = "t13-purge-rev-0";

const ROW_REF = "11111111-1111-4111-8111-111111111111";
const COUNT_REF = "22222222-2222-4222-8222-222222222222";
const EXPIRED_REF = "33333333-3333-4333-8333-333333333333";
const STOPPED_REF = "55555555-5555-4555-8555-555555555555";
const UNRESOLVED_REF = "66666666-6666-4666-8666-666666666666";
const REVOKED_REF = "77777777-7777-4777-8777-777777777777";

const SUPPORT_A1 = "a1000000-0000-4000-8000-000000000001";
const SUPPORT_A2 = "a2000000-0000-4000-8000-000000000002";
const SUPPORT_STOPPED = "a3000000-0000-4000-8000-000000000003";
const SUPPORT_UNRESOLVED = "a4000000-0000-4000-8000-000000000004";
const VERSION_A1 = "b1000000-0000-4000-8000-000000000001";
const VERSION_A2 = "b2000000-0000-4000-8000-000000000002";
const VERSION_STOPPED = "b3000000-0000-4000-8000-000000000003";
const VERSION_B1 = "b4000000-0000-4000-8000-000000000004";
const RECEIPT_ID = "c1000000-0000-4000-8000-000000000001";

const ROW_VALUE: Record<string, unknown> = {
  entity: {
    ref: "fin-t13-entity-alpha",
    name: "Alpha Corp",
    kind: "ORG",
    attributes: { founded: "1998", region: "emea" },
  },
  assertions: [{ predicate: "has_office", object_ref: "fin-t13-office-berlin" }],
};
const ROW_CONTEXT: Record<string, unknown> = {
  schema: "iknow.evidence_context",
  schema_version: 1,
  operation: "entity.get",
};
const COUNT_NUMBER = 7;
const COUNT_VALUE: Record<string, unknown> = {
  counted: "fin-t13-entity-alpha",
  receipt_only: true,
};
const COUNT_CONTEXT: Record<string, unknown> = {
  schema: "iknow.evidence_context",
  schema_version: 1,
  operation: "entity.count",
};

const CLEANUP_CONTRACT =
  "one unique schema per run created by this lane's own resetSchema and dropped CASCADE by this run's afterAll behind the schemaPrefix assertion; no object outside that schema is created or removed";

interface FrozenCase {
  readonly id: string;
  readonly owner: string;
  readonly scenario: string;
  readonly scenarioSource: string;
  readonly boundary: string;
  readonly expectedSource: string;
  readonly cleanup: string;
  readonly notRun: NotRunCase;
}

function frozenCase(entry: Omit<FrozenCase, "notRun"> & {
  readonly notRun: readonly {
    readonly claim: string;
    readonly owner: string;
    readonly reason: string;
  }[];
}): FrozenCase {
  return {
    ...entry,
    notRun: {
      caseId: entry.id,
      expectedCommand: EXPECTED_COMMAND,
      owner: entry.owner,
      entries: entry.notRun,
    },
  };
}

const CASES: readonly FrozenCase[] = [
  frozenCase({
    id: "R1",
    owner: "T13",
    scenario:
      "an unexpired row grant returns the exact stored row, and no query runs",
    scenarioSource:
      "specs/structured-corpus-evidence.md Internal evidence capability: read returns the exact retained value rather than running a query",
    boundary:
      "real PostgreSQL: the private read on a recording authorized-scope seam, where every statement it issues is captured",
    expectedSource:
      "the retained value literal declared in this file from the spec's value field, never an observed backend output",
    cleanup: CLEANUP_CONTRACT,
    notRun: [],
  }),
  frozenCase({
    id: "R2",
    owner: "T13",
    scenario: "a count grant returns the exact stored count and refuses supports",
    scenarioSource:
      "specs/structured-corpus-evidence.md: a count grant is receipt-only and nonrenewing, and has no membership",
    boundary: "real PostgreSQL: the private read on the same persistent seam",
    expectedSource: "the frozen count literal declared in this file",
    cleanup: CLEANUP_CONTRACT,
    notRun: [
      {
        claim: "expiry extension under load",
        owner: "EP3 hardening",
        reason:
          "nonrenewing is proved by reading twice and re-reading the stored column, not by a concurrency stress run",
      },
    ],
  }),
  frozenCase({
    id: "R3",
    owner: "T13",
    scenario:
      "expiry, purge, revocation and both obligation refusals each withhold the whole grant",
    scenarioSource:
      "specs/structured-corpus-evidence.md replay and failure order, with the refusal tokens fixed by failureForReason",
    boundary:
      "real PostgreSQL: the fence runs inside the same transaction that read the grant facts",
    expectedSource:
      "the failureForReason mapping in evidence-store.ts plus the denial reason literals in EVIDENCE_DENIAL_REASON, both read from source, not from a run",
    cleanup: CLEANUP_CONTRACT,
    notRun: [],
  }),
  frozenCase({
    id: "R4",
    owner: "T13",
    scenario:
      "an absent or unresolved trusted binding refuses, and two identities receive different authorized subsets",
    scenarioSource:
      "the B1 decision record: resolved at session initialisation through the existing withAuthorizedScope seam, with an in-set typed code and no default scope",
    boundary:
      "real PostgreSQL for the two-identity case; the absent-binding refusal is decided before any connection is leased",
    expectedSource:
      "STRUCTURED_SCOPE_FAILURE_CODES as declared in structured-scope-types.ts, never an observed code",
    cleanup: CLEANUP_CONTRACT,
    notRun: [],
  }),
];

let backend: PgvectorBackend;
let pool: pg.Pool;
let authority: PgStructuredScopeUnitOfWork;
let admin: pg.Client;
const statements: string[] = [];
let recording = false;

function bindingEnv(
  scope: string,
  sourceRefs: readonly string[],
  revision: string
): Record<string, string> {
  return {
    [TRUSTED_BINDING_ENV_VARS.version]: "1",
    [TRUSTED_BINDING_ENV_VARS.actorId]: `t13-actor-${scope}`,
    [TRUSTED_BINDING_ENV_VARS.ownerScopeBinding]: scope,
    [TRUSTED_BINDING_ENV_VARS.readerBinding]: `t13-reader-${scope}`,
    [TRUSTED_BINDING_ENV_VARS.sourceRefs]: sourceRefs.join(","),
    [TRUSTED_BINDING_ENV_VARS.authorizationRevision]: revision,
    [TRUSTED_BINDING_ENV_VARS.deadlineAt]: DEADLINE,
  };
}

function contextFor(
  scope: string,
  sourceRefs: readonly string[],
  revision: string
): AuthorizedScopeContext {
  return resolveEvidenceScopeContext(
    authority,
    bindingEnv(scope, sourceRefs, revision)
  );
}

// EXIT: every seeded statement names this run's schema outright. The shared
// endpoint also holds a `public` schema that other suites populate, so an
// unqualified name would resolve there and this run would seed rows it does not
// own. Qualification is what makes the teardown claim true.
const Q = (table: string): string => `"${driver.schema}"."${table}"`;

async function seed(client: pg.Client): Promise<void> {
  // EXIT: the read instant is AT, so every live grant expires strictly after it.
  // A grant expiring exactly at the read instant would be refused as expired and
  // the row case would prove nothing.
  const live = "2026-05-01T01:00:00.000Z";
  const expired = "2026-04-01T00:00:00.000Z";
  for (const scope of [SCOPE_A, SCOPE_B]) {
    await client.query(
      `INSERT INTO ${Q("structured_publication_scopes")} (scope_binding, read_revision, maintenance_revision) VALUES ($1, 0, 0)`,
      [scope]
    );
  }
  for (const [scope, ref] of [
    [SCOPE_A, SOURCE_A1],
    [SCOPE_A, SOURCE_A2],
    [SCOPE_B, SOURCE_B1],
  ] as const) {
    await client.query(
      `INSERT INTO ${Q("structured_publication_sources")} (scope_binding, source_ref, active) VALUES ($1, $2, true)`,
      [scope, ref]
    );
  }
  await client.query(
    `INSERT INTO ${Q("evidence_scope_revisions")} (scope_binding, authorization_revision, purge_revision) VALUES ($1, $2, $3), ($4, $5, $6)`,
    [SCOPE_A, AUTH_REV, PURGE_REV, SCOPE_B, AUTH_REV, PURGE_REV]
  );
  await client.query(
    `INSERT INTO ${Q("evidence_authorization_receipts")} (receipt_id, scope_binding, authorization_revision, purge_revision, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [RECEIPT_ID, SCOPE_A, AUTH_REV, PURGE_REV, AT]
  );
  for (const [id, ref, version] of [
    [VERSION_A1, SOURCE_A1, "v1"],
    [VERSION_A2, SOURCE_A2, "v1"],
    [VERSION_STOPPED, SOURCE_A2, "v2"],
    [VERSION_B1, SOURCE_B1, "v1"],
  ] as const) {
    await client.query(
      `INSERT INTO ${Q("source_versions")} (source_version_id, source_ref, source_version, content_digest, origin_object_ref, parser_revision, unit_manifest, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [id, ref, version, `digest-${id}`, `object-${id}`, "t13-parser-1", JSON.stringify({ units: [1] }), AT]
    );
  }
  for (const [supportId, ref, versionId, resultId, version] of [
    [SUPPORT_A1, SOURCE_A1, VERSION_A1, "fin-t13-entity-alpha", "v1"],
    [SUPPORT_A2, SOURCE_A2, VERSION_A2, "fin-t13-entity-alpha", "v1"],
    [SUPPORT_STOPPED, SOURCE_A2, VERSION_STOPPED, "fin-t13-entity-alpha", "v2"],
    [SUPPORT_UNRESOLVED, SOURCE_A2, VERSION_A2, "fin-t13-entity-alpha", "v1"],
  ] as const) {
    await client.query(
      `INSERT INTO ${Q("assertion_supports")} (support_id, subject, result_id, source_ref, source_version, source_version_id, document_id, unit_version, unit, span_start, span_end, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [supportId, "entity", resultId, ref, version, versionId, `doc-${supportId}`, "1", 1, 0, 12, AT]
    );
    await client.query(
      `INSERT INTO ${Q("support_extractions")} (support_id, extraction_ref, created_at) VALUES ($1, $2, $3)`,
      [supportId, `t13-extraction-${supportId}`, AT]
    );
  }
  await client.query(
    `UPDATE ${Q("source_versions")} SET obligations_stopped_at = $1 WHERE source_version_id = $2`,
    [AT, VERSION_STOPPED]
  );
  const grant = async (
    ref: string,
    kind: string,
    expiresAt: string,
    context: Record<string, unknown>,
    value: Record<string, unknown>,
    count: number | null,
    receipt: string | null,
    authRev: string
  ): Promise<void> => {
    await client.query(
      `INSERT INTO ${Q("evidence_grants")} (evidence_ref, grant_kind, subject, operation, query_digest, scope_binding, read_revision, authorization_revision, purge_revision, queried_at, expires_at, context, value, result_count, authorization_receipt_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15)`,
      [ref, kind, "entity", kind === "count" ? "count" : "entity", "t13-digest", SCOPE_A, "0", authRev, PURGE_REV, AT, expiresAt, JSON.stringify(context), JSON.stringify(value), count, receipt]
    );
  };
  const pin = async (ref: string, supportIds: readonly string[]): Promise<void> => {
    for (const supportId of supportIds) {
      await client.query(
        `INSERT INTO ${Q("evidence_grant_supports")} (evidence_ref, support_id, role) VALUES ($1, $2, $3)`,
        [ref, supportId, "occurrence"]
      );
      await client.query(
        `INSERT INTO ${Q("evidence_grant_extractions")} (evidence_ref, support_id, extraction_ref) VALUES ($1, $2, $3)`,
        [ref, supportId, `t13-extraction-${supportId}`]
      );
    }
  };
  await grant(ROW_REF, "row", live, ROW_CONTEXT, ROW_VALUE, null, null, AUTH_REV);
  await pin(ROW_REF, [SUPPORT_A1, SUPPORT_A2]);
  await grant(COUNT_REF, "count", live, COUNT_CONTEXT, COUNT_VALUE, COUNT_NUMBER, RECEIPT_ID, AUTH_REV);
  await grant(EXPIRED_REF, "row", expired, ROW_CONTEXT, ROW_VALUE, null, null, AUTH_REV);
  await pin(EXPIRED_REF, [SUPPORT_A1]);
  await grant(STOPPED_REF, "row", live, ROW_CONTEXT, ROW_VALUE, null, null, AUTH_REV);
  await pin(STOPPED_REF, [SUPPORT_STOPPED]);
  await grant(UNRESOLVED_REF, "row", live, ROW_CONTEXT, ROW_VALUE, null, null, AUTH_REV);
  await pin(UNRESOLVED_REF, [SUPPORT_UNRESOLVED]);
  await grant(REVOKED_REF, "row", live, ROW_CONTEXT, ROW_VALUE, null, null, AUTH_REV_MOVED);
  await pin(REVOKED_REF, [SUPPORT_A1]);
  await client.query("SET LOCAL session_replication_role = replica");
  await client.query(`DELETE FROM ${Q("assertion_supports")} WHERE support_id = $1`, [
    SUPPORT_UNRESOLVED,
  ]);
  await client.query("SET LOCAL session_replication_role = origin");
}

beforeAll(async () => {
  admin = driver.harness.createClient();
  await admin.connect();
  await driver.harness.resetSchema(admin);
  backend = new PgvectorBackend(SCHEMA_URL, DIMENSIONS, {
    maxConnections: 4,
  });
  pool = new pg.Pool({ connectionString: SCHEMA_URL, max: 4 });
  authority = new PgStructuredScopeUnitOfWork(async () => {
    const client = await pool.connect();
    const original = client.query.bind(client);
    client.query = ((text: unknown, ...rest: readonly unknown[]) => {
      if (recording && typeof text === "string") statements.push(text);
      return (original as (...args: unknown[]) => unknown)(text, ...rest);
    }) as typeof client.query;
    return client as unknown as ScopeTransactionClient;
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // EXIT: the tables come from iknow's own bootstrap, schema-qualified. This
    // lane does not re-declare the DDL: if the production schema moves, this
    // lane follows it or fails here rather than testing against a copy.
    await client.query(`SET LOCAL search_path TO "${driver.schema}"`);
    await createEvidenceTables(client);
    await upSchemaMaintenanceWork(client);
    await upSchemaPublication(client);
    await client.query(`SET LOCAL search_path TO "${driver.schema}", public`);
    await seed(client);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
  await driver.dropOwnSchema(admin);
  admin.end();
});

const EXECUTOR_MODULES = [
  "sql-query-executor",
  "business-query",
  "structured-query",
  "query-executor",
] as const;

describe("T13 private Evidence read", () => {
  it("R1 returns the exact stored row and runs no query", async () => {
    const context = contextFor(SCOPE_A, [SOURCE_A1, SOURCE_A2], AUTH_REV);
    statements.length = 0;
    recording = true;
    const envelope = await readPrivateEvidence(
      authority,
      context,
      parseEvidenceRequest({
        schema: "iknow.evidence_request",
        schema_version: 1,
        action: EVIDENCE_ACTION.READ,
        evidence_ref: ROW_REF,
      }),
      AT
    );
    recording = false;
    const result = envelope as EvidenceReadResult;
    expect(result.value).toEqual(ROW_VALUE);
    expect(result.context).toEqual(ROW_CONTEXT);
    expect(result.kind).toBe("row");
    expect(result.result_count).toBeNull();

    // EXIT: every statement a read issues is checked against the evidence and
    // scope statements alone. A structured-query executor would show up here as
    // a statement naming its own tables, so "no query executor is on the path"
    // is observed rather than asserted.
    // EXIT: the set of tables a read touches is derived from the statements it
    // actually issued, so "no query executor is on the path" is observed rather
    // than asserted. A structured-read executor would have to name its own
    // tables here to run a query.
    const touched = new Set<string>();
    for (const text of statements) {
      for (const match of text.matchAll(
        /(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)/gi
      )) {
        touched.add(match[1].toLowerCase());
      }
    }
    // `unnest` is a set-returning function the source set is expanded with, not
    // a table; `maintenance_jobs` is the ledger the publication trigger writes.
    // Both are named here so the allowlist stays a reading of the fence rather
    // than a whitelist that hides an unexpected name.
    const allowed = new Set(
      `structured_publication_scopes
structured_publication_sources
structured_maintenance_work
structured_maintenance_work_revisions
maintenance_jobs
unnest
evidence_grants
evidence_grant_supports
evidence_grant_extractions
evidence_scope_revisions
evidence_authorization_receipts
assertion_supports
support_extractions
source_versions`
        .split("\n")
        .map((name) => name.trim())
    );
    expect([...touched].filter((table) => !allowed.has(table)).sort()).toEqual([]);
    // EXIT: the read did real work. An empty statement list would make the
    // table-set assertion vacuously true, so it is checked for content.
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.some((text) => text.includes("evidence_grants"))).toBe(true);

    // EXIT: the module graph is checked statically as well, so the claim does
    // not rest on one run's statement list. Only import specifiers are examined,
    // so a comment that mentions an executor cannot pass or fail this.
    for (const file of [
      "src/core/storage/evidence-read.ts",
      "src/core/storage/evidence-binding.ts",
      "src/core/storage/evidence-dispatch.ts",
    ]) {
      const specifiers = [
        ...readFileSync(`${REPO_ROOT}${file}`, "utf8").matchAll(
          /from\s+"(\.[^"]+)"/g
        ),
      ].map((match) => match[1]);
      for (const specifier of specifiers) {
        for (const forbidden of EXECUTOR_MODULES) {
          expect(specifier).not.toContain(forbidden);
        }
      }
    }
  });

  it("R2 returns the exact stored count and refuses a supports read", async () => {
    const context = contextFor(SCOPE_A, [SOURCE_A1, SOURCE_A2], AUTH_REV);
    const first = (await readPrivateEvidence(
      authority,
      context,
      parseEvidenceRequest({
        schema: "iknow.evidence_request",
        schema_version: 1,
        action: EVIDENCE_ACTION.READ,
        evidence_ref: COUNT_REF,
      }),
      AT
    )) as EvidenceReadResult;
    expect(first.kind).toBe("count");
    expect(first.result_count).toBe(COUNT_NUMBER);
    expect(first.value).toEqual(COUNT_VALUE);

    const second = (await readPrivateEvidence(
      authority,
      context,
      parseEvidenceRequest({
        schema: "iknow.evidence_request",
        schema_version: 1,
        action: EVIDENCE_ACTION.READ,
        evidence_ref: COUNT_REF,
      }),
      AT
    )) as EvidenceReadResult;
    expect(second.expires_at).toBe(first.expires_at);
    const stored = await pool.query(
      `SELECT expires_at FROM ${Q("evidence_grants")} WHERE evidence_ref = $1`,
      [COUNT_REF]
    );
    expect(
      new Date(stored.rows[0].expires_at as string).getTime()
    ).toBe(new Date(first.expires_at).getTime());

    await expect(
      readPrivateEvidence(
        authority,
        context,
        parseEvidenceRequest({
          schema: "iknow.evidence_request",
          schema_version: 1,
          action: EVIDENCE_ACTION.SUPPORTS,
          evidence_ref: COUNT_REF,
        }),
        AT
      )
    ).rejects.toMatchObject({
      code: EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      reason: EVIDENCE_REFUSAL_REASON.COUNT_GRANT_HAS_NO_SUPPORTS,
    });
  });

  it("R3 refuses expiry, revocation and both obligation denials wholly", async () => {
    const context = contextFor(SCOPE_A, [SOURCE_A1, SOURCE_A2], AUTH_REV);
    const read = (evidenceRef: string) =>
      readPrivateEvidence(
        authority,
        context,
        parseEvidenceRequest({
          schema: "iknow.evidence_request",
          schema_version: 1,
          action: EVIDENCE_ACTION.READ,
          evidence_ref: evidenceRef,
        }),
        AT
      );

    await expect(read(EXPIRED_REF)).rejects.toMatchObject({
      code: EVIDENCE_FAILURE.EXPIRED,
      reason: "expired",
    });
    await expect(read(REVOKED_REF)).rejects.toMatchObject({
      code: EVIDENCE_FAILURE.ACCESS_DENIED,
      reason: "authorization_revoked",
    });
    await expect(read(STOPPED_REF)).rejects.toMatchObject({
      code: EVIDENCE_FAILURE.UNAVAILABLE,
      reason: "obligations_stopped",
    });
    await expect(read(UNRESOLVED_REF)).rejects.toMatchObject({
      code: EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING,
      reason: "dependency_unresolved",
    });
    await expect(read("99999999-9999-4999-8999-999999999999")).rejects.toMatchObject({
      code: EVIDENCE_FAILURE.UNAVAILABLE,
      reason: "unknown_reference",
    });
  });

  it("R4 refuses an absent binding with an in-set code and no default", () => {
    expect(() => readTrustedIdentityBinding({})).toThrowError(
      /No default scope is substituted/
    );
    try {
      readTrustedIdentityBinding({});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredScopeError);
      const scopeError = error as StructuredScopeError;
      expect(scopeError.code).toBe("access_denied");
      expect(isScopeFailureCode(scopeError.code)).toBe(true);
      expect(STRUCTURED_SCOPE_FAILURE_CODES).toContain(scopeError.code);
    }
    expect(() =>
      readTrustedIdentityBinding({ [TRUSTED_BINDING_ENV_VARS.version]: "1" })
    ).toThrowError(/incomplete/);
    expect(() =>
      readTrustedIdentityBinding({
        ...bindingEnv(SCOPE_A, [SOURCE_A1], AUTH_REV),
        [TRUSTED_BINDING_ENV_VARS.version]: "99",
      })
    ).toThrowError(/unresolved binding is refused/);
    expect(() =>
      readTrustedIdentityBinding(
        bindingEnv(SCOPE_A, [SOURCE_A1], AUTH_REV)
      )
    ).not.toThrow();
  });

  it("R4 gives two identities different authorized subsets", async () => {
    const a = contextFor(SCOPE_A, [SOURCE_A1, SOURCE_A2], AUTH_REV);
    const b = contextFor(SCOPE_B, [SOURCE_B1], AUTH_REV);
    expect(a.authorizedSourceRefs).toEqual([SOURCE_A1, SOURCE_A2]);
    expect(b.authorizedSourceRefs).toEqual([SOURCE_B1]);
    expect(a.ownerScopeBinding).not.toBe(b.ownerScopeBinding);

    // EXIT: B holds a real granted identity and still cannot read A's subject.
    // The refusal is a thrown typed error here and an envelope on the wire; the
    // two halves are asserted on their own lanes and the pair is what the host
    // composition sees.
    await expect(
      readPrivateEvidence(
        authority,
        b,
        parseEvidenceRequest({
          schema: "iknow.evidence_request",
          schema_version: 1,
          action: EVIDENCE_ACTION.READ,
          evidence_ref: ROW_REF,
        }),
        AT
      )
    ).rejects.toMatchObject({
      code: EVIDENCE_FAILURE.ACCESS_DENIED,
      reason: EVIDENCE_REFUSAL_REASON.SCOPE_NOT_AUTHORIZED,
    });
  });

  it("R4 refuses a narrower subset on the right scope and names no source", async () => {
    // The row grant pins one support on SOURCE_A1 and one on SOURCE_A2. An
    // identity on the *right* scope holding only SOURCE_A1 therefore passes the
    // owner-scope check and is refused by the subset check alone, which is the
    // only thing that makes this case different from the scope case above.
    const broad = contextFor(SCOPE_A, [SOURCE_A1, SOURCE_A2], AUTH_REV);
    const broadEnvelope = await readPrivateEvidence(
      authority,
      broad,
      parseEvidenceRequest({
        schema: "iknow.evidence_request",
        schema_version: 1,
        action: EVIDENCE_ACTION.READ,
        evidence_ref: ROW_REF,
      }),
      AT
    );
    const granted = broadEnvelope as EvidenceReadResult;
    expect(granted.value).toEqual(ROW_VALUE);
    expect(granted.kind).toBe("row");

    const narrow = contextFor(SCOPE_A, [SOURCE_A1], AUTH_REV);
    let caught: unknown;
    try {
      await readPrivateEvidence(
        authority,
        narrow,
        parseEvidenceRequest({
          schema: "iknow.evidence_request",
          schema_version: 1,
          action: EVIDENCE_ACTION.READ,
          evidence_ref: ROW_REF,
        }),
        AT
      );
    } catch (error) {
      caught = error;
    }
    expect(caught, "the narrower identity must be refused").toBeInstanceOf(Error);
    expect(caught).toMatchObject({
      code: EVIDENCE_FAILURE.ACCESS_DENIED,
      reason: EVIDENCE_REFUSAL_REASON.SOURCE_OUTSIDE_AUTHORIZED_SUBSET,
    });

    // EXIT: a source ref is a citation, so the refusal must not name the one
    // that is outside the subset. This is the whole point of the arm, and it is
    // the arm the review found naming `t13-source-a2` to the very caller it was
    // withholding from.
    const message = (caught as { message: string }).message;
    expect(message).not.toContain(SOURCE_A2);
    expect(message).not.toContain(SOURCE_A1);
    expect(message).toContain("outside this identity's authorized subset");
    for (const fragment of [granted.value, granted.context]) {
      expect(message).not.toContain(JSON.stringify(fragment));
    }
  });

  it("R4 refuses a context this composition did not mint", async () => {
    const forged = {
      actorId: "t13-forged",
      ownerScopeBinding: SCOPE_A,
      readerBinding: "t13-forged",
      authorizedSourceRefs: [SOURCE_A1, SOURCE_A2],
      authorizationRevision: AUTH_REV,
      deadlineAt: DEADLINE,
    } as unknown as AuthorizedScopeContext;
    await expect(
      readPrivateEvidence(
        authority,
        forged,
        parseEvidenceRequest({
          schema: "iknow.evidence_request",
          schema_version: 1,
          action: EVIDENCE_ACTION.READ,
          evidence_ref: ROW_REF,
        }),
        AT
      )
    // EXIT: the refusal is the seam's own, not this ticket's guard. scopeAuthorityOf
    // refuses anything it did not mint before the read begins, which is the
    // stronger statement: a hand-assembled context never reaches the store.
    ).rejects.toMatchObject({
      name: "StructuredScopeError",
      code: "access_denied",
      message: "the authorized scope context was not minted by trusted composition",
    });
  });

  it("refuses an identity asserted on the request channel", () => {
    for (const forged of ["actor_id", "scope_binding", "trusted_consumer"]) {
      try {
        parseEvidenceRequest({
          schema: "iknow.evidence_request",
          schema_version: 1,
          action: EVIDENCE_ACTION.READ,
          evidence_ref: ROW_REF,
          [forged]: "t13-forged",
        });
        expect.unreachable();
      } catch (error) {
        const refused = error as {
          code: string;
          reason: EvidenceRefusalReason;
          message: string;
        };
        expect(refused.code).toBe(EVIDENCE_FAILURE.MALFORMED_CONTRACT);
        expect(refused.reason).toBe(EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD);
        expect(refused.message).toContain(forged);
      }
    }
  });

  it("dispatches an unbound session to a refusal and never to a default", async () => {
    const dispatcher = createEvidenceDispatcher({
      authority,
      binding: {},
      now: () => AT,
    });
    expect(dispatcher.bound).toBe(false);
    const envelope = await dispatcher.handle({
      schema: "iknow.evidence_request",
      schema_version: 1,
      action: EVIDENCE_ACTION.READ,
      evidence_ref: ROW_REF,
    });
    expect(envelope).toMatchObject({
      error: {
        code: "access_denied",
        reason: EVIDENCE_REFUSAL_REASON.TRUSTED_BINDING_UNRESOLVED,
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("Alpha Corp");
  });

  it("narrowing finds the seam on the backend and nothing else", () => {
    expect(supportsEvidenceScopeAuthority(backend)).toBe(
      backend.structuredScopeUnitOfWork
    );
    expect(supportsEvidenceScopeAuthority({})).toBeUndefined();
    expect(supportsEvidenceScopeAuthority(undefined)).toBeUndefined();
    expect(supportsEvidenceScopeAuthority(null)).toBeUndefined();
  });

  it("publishes every frozen case with its not-run register", () => {
    for (const entry of CASES) {
      expect(entry.scenario.length).toBeGreaterThan(0);
      expect(entry.scenarioSource.length).toBeGreaterThan(0);
      expect(entry.boundary.length).toBeGreaterThan(0);
      expect(entry.expectedSource.length).toBeGreaterThan(0);
      expect(entry.cleanup).toBe(CLEANUP_CONTRACT);
      expect(entry.notRun.caseId).toBe(entry.id);
    }
  });
});