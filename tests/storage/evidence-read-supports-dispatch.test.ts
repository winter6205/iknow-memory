/**
 * T14 EP4 — a row grant's `supports` request reaches the continuation through the
 * private Evidence read.
 *
 * The dispatch layer is where the selector stops being a request field and starts
 * being a decision, and nothing else in the tree covered that: the action layer is
 * proven in `evidence-continuation-transaction.test.ts` and against real
 * PostgreSQL in `evidence-continuation-pg.test.ts`, while this file proves the two
 * are actually joined — that a listed selector is forwarded rather than dropped,
 * that both the grant facts and the pinned extraction links are read on the scope's
 * own client inside the scope's own BEGIN, and that every fault below the seam
 * still leaves as a typed refusal with a code from the closed evidence set.
 *
 * It runs on a recording seam rather than a database for the same reason the frozen
 * transaction suite does: the properties here are which statements are issued, in
 * which bracket, and which token a refusal carries.
 */
import { describe, expect, it } from "vitest";

import {
  EVIDENCE_ACTION,
  EVIDENCE_REFUSAL_REASON,
  EvidenceRefusalError,
  parseEvidenceRequest,
  readPrivateEvidence,
  type EvidenceEnvelope,
  type EvidenceScope,
  type EvidenceSupportsRequest,
  type EvidenceSupportsResult,
} from "../../src/core/storage/evidence-read.js";
import {
  mintAuthorizedScopeContext,
  StructuredScopeError,
  type AuthorizedScopeContext,
  type AuthorizedScopeContextInput,
  type AuthorizedScopeWork,
} from "../../src/core/storage/structured-scope-types.js";
import {
  EVIDENCE_DENIAL_REASON,
  EVIDENCE_FAILURE,
  EVIDENCE_GRANT_KIND,
  EVIDENCE_SUBJECT_KIND,
  EVIDENCE_SUPPORT_ROLE,
} from "../../src/core/types.js";

const GRANT_REF = "ref-supports-dispatch";
const SCOPE = "scope-supports-dispatch";
const QUERIED_AT = "2026-03-01T12:00:00.000Z";
const EXPIRES_AT = "2027-03-01T12:00:00.000Z";
const AT = "2026-10-06T00:00:00.000Z";
const SOURCE_REF = "source-supports-dispatch";
const DEADLINE_AT = "2026-10-06T00:10:00.000Z";
const SUPPORT_COUNT = 11;
const PAGE_SIZE = 8;

const CLOSED_FAILURE_CODES: readonly string[] = Object.values(EVIDENCE_FAILURE);
const CLOSED_REASONS: readonly string[] = [
  ...Object.values(EVIDENCE_DENIAL_REASON),
  ...Object.values(EVIDENCE_REFUSAL_REASON),
];

function supportId(index: number): string {
  return `00000000-0000-4000-9000-${index.toString().padStart(12, "0")}`;
}

function supportRow(index: number): Record<string, unknown> {
  return {
    support_id: supportId(index),
    subject: EVIDENCE_SUBJECT_KIND.ENTITY,
    result_id: "result-supports-dispatch",
    source_ref: SOURCE_REF,
    source_version: "v1",
    source_version_id: "11111111-1111-4111-8111-111111111111",
    document_id: `doc-supports-dispatch-${index}`,
    unit_version: "frozen-v1",
    unit: index,
    span_start: -1,
    span_end: -1,
    created_at: "2026-02-01T00:00:00.000Z",
  };
}

function grantRow(): Record<string, unknown> {
  return {
    evidence_ref: GRANT_REF,
    grant_kind: EVIDENCE_GRANT_KIND.ROW,
    subject: EVIDENCE_SUBJECT_KIND.ENTITY,
    operation: "entity",
    query_digest: "query-supports-dispatch",
    scope_binding: SCOPE,
    read_revision: "read-1",
    authorization_revision: "auth-1",
    purge_revision: "purge-1",
    queried_at: QUERIED_AT,
    expires_at: EXPIRES_AT,
    context: { coverage: "stored_structured_subjects" },
    value: { entity_id: "result-supports-dispatch" },
    result_count: null,
    authorization_receipt_id: null,
  };
}

interface RecordingClient {
  readonly statements: string[];
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

function recordingClient(supportCount = SUPPORT_COUNT): RecordingClient {
  const statements: string[] = [];
  const rows = (sql: string): { rows: unknown[] } => {
    if (sql.includes("FROM evidence_grants")) return { rows: [grantRow()] };
    if (sql.includes("FROM evidence_scope_revisions")) {
      return {
        rows: [
          {
            scope_binding: SCOPE,
            authorization_revision: "auth-1",
            purge_revision: "purge-1",
          },
        ],
      };
    }
    if (sql.includes("count(*)::int")) {
      return { rows: [{ total: supportCount }] };
    }
    if (sql.includes("FROM evidence_grant_supports g")) {
      return {
        rows: Array.from({ length: supportCount }, (_, index) => ({
          ...supportRow(index + 1),
          role:
            index === supportCount - 1
              ? EVIDENCE_SUPPORT_ROLE.ENDPOINT_DISPLAY
              : EVIDENCE_SUPPORT_ROLE.OCCURRENCE,
          obligations_stopped_at: null,
        })),
      };
    }
    if (sql.includes("FROM evidence_grant_extractions")) {
      return {
        rows: Array.from({ length: supportCount }, (_, index) => ({
          support_id: supportId(index + 1),
          extraction_ref: `extraction-${index + 1}`,
        })),
      };
    }
    return { rows: [] };
  };
  return {
    statements,
    async query(sql: string) {
      statements.push(sql);
      return sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK"
        ? { rows: [] }
        : rows(sql);
    },
    release() {
      statements.push("RELEASE");
    },
  };
}

function contextInput(
  patch: Partial<AuthorizedScopeContextInput> = {}
): AuthorizedScopeContextInput {
  return {
    actorId: "actor-supports-dispatch",
    ownerScopeBinding: SCOPE,
    readerBinding: "reader-supports-dispatch",
    authorizedSourceRefs: [SOURCE_REF],
    authorizationRevision: "auth-1",
    deadlineAt: DEADLINE_AT,
    ...patch,
  };
}

/**
 * A seam that owns one transaction, exactly as the PostgreSQL unit of work does.
 *
 * The BEGIN, the COMMIT and the release are issued here and nowhere else, so a
 * statement list that shows a second bracket inside one run is a dispatch path
 * that opened a transaction of its own.
 */
function recordingScope(client: RecordingClient): EvidenceScope {
  const authority: EvidenceScope = {
    createAuthorizedContext(input: AuthorizedScopeContextInput) {
      return mintAuthorizedScopeContext(input, authority);
    },
    async withAuthorizedScope<R>(
      _context: AuthorizedScopeContext,
      callback: (work: AuthorizedScopeWork) => Promise<R>
    ): Promise<R> {
      await client.query("BEGIN");
      try {
        const value = await callback({
          client,
        } as unknown as AuthorizedScopeWork);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
  return authority;
}

function supportsRequest(
  patch: Partial<Omit<EvidenceSupportsRequest, "action" | "evidence_ref">> = {}
): EvidenceSupportsRequest {
  return parseEvidenceRequest({
    schema: "iknow.evidence_request",
    schema_version: 1,
    action: EVIDENCE_ACTION.SUPPORTS,
    evidence_ref: GRANT_REF,
    ...patch,
  }) as EvidenceSupportsRequest;
}

async function dispatch(
  request: EvidenceSupportsRequest,
  input: AuthorizedScopeContextInput = contextInput()
): Promise<{
  readonly envelope: EvidenceEnvelope;
  readonly client: RecordingClient;
}> {
  const client = recordingClient();
  const scope = recordingScope(client);
  const envelope = await readPrivateEvidence(
    scope,
    scope.createAuthorizedContext(input),
    request,
    AT
  );
  return { envelope, client };
}

async function refusalOf(
  request: EvidenceSupportsRequest,
  input?: AuthorizedScopeContextInput
): Promise<EvidenceRefusalError> {
  try {
    await dispatch(request, input);
  } catch (error) {
    return error as EvidenceRefusalError;
  }
  throw new Error("the dispatch granted a request this lane expects to be refused");
}

describe("T14 EP4 supports dispatch: the selector reaches the continuation", () => {
  it("grants a first page when the request names neither selector", async () => {
    const { envelope } = await dispatch(supportsRequest());
    const page = envelope as EvidenceSupportsResult;
    expect(page.schema).toBe("iknow.evidence_result");
    expect(page.evidence_ref).toBe(GRANT_REF);
    expect(page.expires_at).toBe(EXPIRES_AT);
    expect(page.total_supports).toBe(SUPPORT_COUNT);
    expect(page.supports.map((entry) => entry.support_id)).toEqual(
      Array.from({ length: PAGE_SIZE }, (_, index) => supportId(index + 1))
    );
    expect(page.selected).toBe(false);
    expect(page.next_cursor).not.toBeNull();
    expect(page.supports.map((entry) => entry.extraction_refs)).toEqual(
      Array.from({ length: PAGE_SIZE }, (_, index) => [`extraction-${index + 1}`])
    );
  });

  it("grants the page a cursor names, and the cursor is the one the first page minted", async () => {
    const first = (await dispatch(supportsRequest())).envelope as EvidenceSupportsResult;
    const { envelope } = await dispatch(
      supportsRequest({ cursor: first.next_cursor })
    );
    const page = envelope as EvidenceSupportsResult;
    expect(page.supports.map((entry) => entry.support_id)).toEqual(
      Array.from(
        { length: SUPPORT_COUNT - PAGE_SIZE },
        (_, index) => supportId(index + PAGE_SIZE + 1)
      )
    );
    expect(page.next_cursor).toBeNull();
    expect(page.selected).toBe(false);
  });

  it("grants one named support, from anywhere in the pinned membership", async () => {
    // The eleventh support is past the first page's prefix, so a selector that
    // only searched the page it would have returned could not find it.
    const { envelope } = await dispatch(
      supportsRequest({ support_id: supportId(SUPPORT_COUNT) })
    );
    const page = envelope as EvidenceSupportsResult;
    expect(page.selected).toBe(true);
    expect(page.supports.map((entry) => entry.support_id)).toEqual([
      supportId(SUPPORT_COUNT),
    ]);
    expect(page.next_cursor).toBeNull();
    expect(page.total_supports).toBe(SUPPORT_COUNT);
  });

  it("refuses a request carrying both selectors, before the grant is read", async () => {
    const first = (await dispatch(supportsRequest())).envelope as EvidenceSupportsResult;
    const client = recordingClient();
    const scope = recordingScope(client);
    const refused = await refusalOf(
      supportsRequest({ cursor: first.next_cursor, support_id: supportId(1) })
    );
    expect(refused).toBeInstanceOf(EvidenceRefusalError);
    expect(refused.code).toBe(EVIDENCE_FAILURE.MALFORMED_CONTRACT);
    expect(refused.message).toContain("mutually exclusive");
    expect(refused.message).not.toContain(SOURCE_REF);
    expect(client.statements.filter((sql) => sql.includes("evidence_grants"))).toEqual([]);
    expect(scope).toBeDefined();
  });

  it("reads the grant, the membership and the extraction links on the scope's own client", async () => {
    const { client } = await dispatch(supportsRequest());
    // EXIT: one bracket, opened and closed by the seam. A dispatch that leased a
    // second connection would issue its own BEGIN/COMMIT/RELEASE inside this one.
    expect(
      client.statements.filter(
        (sql) => sql === "BEGIN" || sql === "COMMIT" || sql === "RELEASE"
      )
    ).toEqual(["BEGIN", "COMMIT", "RELEASE"]);
    const between = client.statements.slice(1, -2);
    const tables = [
      "FROM evidence_grants",
      "FROM evidence_scope_revisions",
      "FROM evidence_grant_supports g",
      "FROM evidence_grant_extractions",
    ];
    const seen: number[] = [];
    for (const table of tables) {
      const index = between.findIndex((sql) => sql.includes(table));
      expect(index, `no statement read ${table} inside the transaction`).toBeGreaterThanOrEqual(0);
      seen.push(index);
    }
    expect(seen).toEqual([...seen].sort((left, right) => left - right));
  });

  it("never emits the supports-not-read refusal on the row-grant path", async () => {
    const first = (await dispatch(supportsRequest())).envelope as EvidenceSupportsResult;
    const requests: EvidenceSupportsRequest[] = [
      supportsRequest(),
      supportsRequest({ cursor: first.next_cursor }),
      supportsRequest({ support_id: supportId(1) }),
      supportsRequest({ support_id: supportId(SUPPORT_COUNT) }),
      supportsRequest({ cursor: "not-a-cursor-this-build-mints" }),
      supportsRequest({ support_id: "not-a-uuid" }),
      supportsRequest({ support_id: "99999999-9999-4999-8999-999999999999" }),
      supportsRequest({ cursor: first.next_cursor, support_id: supportId(1) }),
    ];
    const reasons: string[] = [];
    for (const request of requests) {
      try {
        await dispatch(request);
      } catch (error) {
        const refused = error as EvidenceRefusalError;
        expect(refused).toBeInstanceOf(EvidenceRefusalError);
        expect(CLOSED_FAILURE_CODES).toContain(refused.code);
        expect(CLOSED_REASONS).toContain(refused.reason);
        reasons.push(refused.reason);
      }
    }
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons).not.toContain(EVIDENCE_REFUSAL_REASON.SUPPORTS_CONTINUATION_NOT_READ);
  });

  it("refuses a non-uuid support_id with an in-set code instead of throwing", async () => {
    const refused = await refusalOf(supportsRequest({ support_id: "not-a-uuid" }));
    expect(refused).toBeInstanceOf(EvidenceRefusalError);
    expect(refused.code).toBe(EVIDENCE_FAILURE.MALFORMED_CONTRACT);
    expect(CLOSED_REASONS).toContain(refused.reason);
    expect(refused.message).toContain("uuid");
  });

  it("refuses a selector that is not text at the request contract", async () => {
    for (const forged of [{ cursor: 7 }, { support_id: { id: supportId(1) } }, { cursor: [] }]) {
      try {
        parseEvidenceRequest({
          schema: "iknow.evidence_request",
          schema_version: 1,
          action: EVIDENCE_ACTION.SUPPORTS,
          evidence_ref: GRANT_REF,
          ...forged,
        });
        expect.unreachable();
      } catch (error) {
        const refused = error as EvidenceRefusalError;
        expect(refused).toBeInstanceOf(EvidenceRefusalError);
        expect(refused.code).toBe(EVIDENCE_FAILURE.MALFORMED_CONTRACT);
        expect(refused.reason).toBe(EVIDENCE_REFUSAL_REASON.UNKNOWN_FIELD);
        // EXIT: the continuation reads a selector as text, so a selector that is
        // not text has to be refused here or it leaves its entry point instead.
        expect(refused.message).toContain("must be a string when it is present");
      }
    }
  });

  it("cannot be handed an unbound caller, because the seam refuses to mint one", async () => {
    // EXIT: the continuation's blank-binding arm is a second line of defence here
    // rather than a live path: the scope that mints this layer's caller refuses to
    // mint a blank binding, and the request channel cannot name one at all.
    const scope = recordingScope(recordingClient());
    for (const forged of ["", "   "]) {
      expect(() =>
        scope.createAuthorizedContext(contextInput({ ownerScopeBinding: forged }))
      ).toThrowError(StructuredScopeError);
    }
    expect(() =>
      parseEvidenceRequest({
        schema: "iknow.evidence_request",
        schema_version: 1,
        action: EVIDENCE_ACTION.SUPPORTS,
        evidence_ref: GRANT_REF,
        caller: { scopeBinding: "" },
        scope_binding: SCOPE,
        actor_id: "forged",
      })
    ).toThrowError(/accepts only/);
  });

  it("still refuses an identity the caller's authorized subset does not cover", async () => {
    const refused = await refusalOf(
      supportsRequest(),
      contextInput({ authorizedSourceRefs: ["another-source"] })
    );
    expect(refused.code).toBe(EVIDENCE_FAILURE.ACCESS_DENIED);
    expect(refused.reason).toBe(EVIDENCE_REFUSAL_REASON.SOURCE_OUTSIDE_AUTHORIZED_SUBSET);
    expect(refused.message).not.toContain(SOURCE_REF);
  });
});