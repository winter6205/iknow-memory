/**
 * T14 EP4 — the support continuation decides and emits inside one transaction.
 *
 * The whole-grant withholding rule is only credible if the recheck and the page
 * share one BEGIN/COMMIT, so this suite records every statement the continuation
 * issues and pins the bracket around it. It runs on a recording client rather
 * than a database because the property under test is the order of the
 * statements, not their results; the real-PostgreSQL proof of the same
 * continuation, including the per-obligation refusals, is
 * `tests/storage/evidence-continuation-pg.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  EVIDENCE_CONTINUATION_CURSOR_VERSION,
  decideSupportContinuation,
  readGrantSupportContinuation,
  type SupportContinuationRequest,
} from "../../src/core/storage/evidence-continuation.js";
import {
  readGrantFacts,
  readGrantPinnedExtractionsForSupports,
} from "../../src/core/storage/evidence-pg.js";
import {
  EVIDENCE_DENIAL_REASON,
  EVIDENCE_FAILURE,
  EVIDENCE_GRANT_KIND,
  EVIDENCE_SUBJECT_KIND,
  EVIDENCE_SUPPORT_ROLE,
} from "../../src/core/types.js";
import type { EvidenceLeasedClient } from "../../src/core/storage/evidence-store.js";

const GRANT_REF = "ref-continuation-transaction";
const SCOPE = "scope-continuation-transaction";
const QUERIED_AT = "2026-03-01T12:00:00.000Z";
const EXPIRES_AT = "2027-03-01T12:00:00.000Z";
const AT = "2026-10-06T00:00:00.000Z";
const SOURCE_REF = "source-continuation-transaction";

interface Recorded {
  readonly statements: string[];
  readonly client: EvidenceLeasedClient;
}

function supportId(index: number): string {
  return `00000000-0000-4000-9000-${index.toString().padStart(12, "0")}`;
}

function supportRow(index: number): Record<string, unknown> {
  return {
    support_id: supportId(index),
    subject: EVIDENCE_SUBJECT_KIND.ENTITY,
    result_id: "result-continuation-transaction",
    source_ref: SOURCE_REF,
    source_version: "v1",
    source_version_id: "11111111-1111-4111-8111-111111111111",
    document_id: "doc-continuation-transaction",
    unit_version: "frozen-v1",
    unit: index,
    span_start: -1,
    span_end: -1,
    created_at: "2026-02-01T00:00:00.000Z",
  };
}

function grantRow(kind: string): Record<string, unknown> {
  return {
    evidence_ref: GRANT_REF,
    grant_kind: kind,
    subject: EVIDENCE_SUBJECT_KIND.ENTITY,
    operation: "list",
    query_digest: "query-continuation-transaction",
    scope_binding: SCOPE,
    read_revision: "read-1",
    authorization_revision: "auth-1",
    purge_revision: "purge-1",
    queried_at: QUERIED_AT,
    expires_at: EXPIRES_AT,
    context: { coverage: "stored_structured_subjects" },
    value: { entity_id: "result-continuation-transaction" },
    result_count: null,
    authorization_receipt_id: null,
  };
}

function scopeRow(): Record<string, unknown> {
  return {
    scope_binding: SCOPE,
    authorization_revision: "auth-1",
    purge_revision: "purge-1",
  };
}

interface HarnessOptions {
  readonly supportCount: number;
  readonly pinnedCount?: number;
  readonly grantKind?: string;
  readonly expiresAt?: string;
  readonly authorizationRevision?: string;
  readonly stopped?: boolean;
}

function recordingClient(options: HarnessOptions): Recorded {
  const statements: string[] = [];
  const supportCount = options.supportCount;
  const pinnedCount = options.pinnedCount ?? supportCount;
  const rows = (sql: string): { rows: unknown[] } => {
    if (sql.includes("FROM evidence_grants")) {
      return { rows: [grantRow(options.grantKind ?? EVIDENCE_GRANT_KIND.ROW)] };
    }
    if (sql.includes("FROM evidence_scope_revisions")) return { rows: [scopeRow()] };
    if (sql.includes("count(*)::int")) return { rows: [{ total: pinnedCount }] };
    if (sql.includes("FROM evidence_grant_supports g")) {
      return {
        rows: Array.from({ length: supportCount }, (_, index) => ({
          ...supportRow(index + 1),
          role:
            index === supportCount - 1
              ? EVIDENCE_SUPPORT_ROLE.ENDPOINT_DISPLAY
              : EVIDENCE_SUPPORT_ROLE.OCCURRENCE,
          obligations_stopped_at: options.stopped === true ? "2026-09-01T00:00:00.000Z" : null,
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
    client: {
      async query(sql: string) {
        statements.push(sql);
        return sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK"
          ? { rows: [] }
          : rows(sql);
      },
      release() {
        statements.push("RELEASE");
      },
    },
  };
}

function requestFor(
  patch: Partial<SupportContinuationRequest> = {}
): SupportContinuationRequest {
  return {
    evidenceRef: GRANT_REF,
    at: AT,
    caller: { scopeBinding: SCOPE, authorizedSourceRefs: [SOURCE_REF] },
    ...patch,
  };
}

async function run(
  options: HarnessOptions,
  request: SupportContinuationRequest = requestFor()
): Promise<{ outcome: Awaited<ReturnType<typeof readGrantSupportContinuation>>; recorded: Recorded }> {
  const recorded = recordingClient(options);
  const outcome = await readGrantSupportContinuation(async () => recorded.client, request);
  return { outcome, recorded };
}

describe("T14 EP4 support continuation: one transaction and one fence", () => {
  it("brackets the grant, the obligations, the page and the extraction links between one BEGIN and one COMMIT", async () => {
    const { outcome, recorded } = await run({ supportCount: 11 });
    expect(outcome.state).toBe("granted");
    expect(recorded.statements[0]).toBe("BEGIN");
    expect(recorded.statements.at(-2)).toBe("COMMIT");
    expect(recorded.statements.at(-1)).toBe("RELEASE");
    const between = recorded.statements.slice(1, -2);
    const tables = [
      "FROM evidence_grants",
      "FROM evidence_scope_revisions",
      "count(*)::int",
      "FROM evidence_grant_supports g",
      "FROM evidence_grant_extractions",
    ];
    const seen: string[] = [];
    for (const table of tables) {
      const index = between.findIndex((sql) => sql.includes(table));
      expect(index, `no statement read ${table} inside the transaction`).toBeGreaterThanOrEqual(0);
      seen.push(String(index));
    }
    expect([...seen].sort((left, right) => Number(left) - Number(right))).toEqual(seen);
  });

  it("reads no payload at all when the grant itself is withheld", async () => {
    const { outcome, recorded } = await run(
      { supportCount: 11 },
      requestFor({ at: "2027-03-01T12:00:00.000Z" })
    );
    expect(outcome).toMatchObject({
      state: "denied",
      failure: EVIDENCE_FAILURE.EXPIRED,
      reason: EVIDENCE_DENIAL_REASON.EXPIRED,
    });
    expect(outcome).not.toHaveProperty("supports");
    expect(recorded.statements.some((sql) => sql.includes("evidence_grant_extractions"))).toBe(
      false
    );
  });

  it("withholds the whole grant when a single pinned support's obligations stopped", async () => {
    const { outcome } = await run({ supportCount: 11, stopped: true });
    expect(outcome).toMatchObject({
      state: "denied",
      failure: EVIDENCE_FAILURE.UNAVAILABLE,
      reason: EVIDENCE_DENIAL_REASON.OBLIGATIONS_STOPPED,
    });
    expect(outcome).not.toHaveProperty("supports");
  });

  it("withholds the whole grant when its pinned membership no longer resolves whole", async () => {
    const { outcome } = await run({ supportCount: 10, pinnedCount: 11 });
    expect(outcome).toMatchObject({
      state: "denied",
      failure: EVIDENCE_FAILURE.UNSUPPORTED_SOURCE_BINDING,
      reason: EVIDENCE_DENIAL_REASON.DEPENDENCY_UNRESOLVED,
    });
    expect(outcome).not.toHaveProperty("supports");
  });

  it("withholds the whole grant when the trusted caller's authorized subset excludes a pinned source", async () => {
    const { outcome } = await run(
      { supportCount: 11 },
      requestFor({
        caller: { scopeBinding: SCOPE, authorizedSourceRefs: ["another-source"] },
      })
    );
    expect(outcome).toMatchObject({
      state: "denied",
      failure: EVIDENCE_FAILURE.ACCESS_DENIED,
      reason: EVIDENCE_DENIAL_REASON.AUTHORIZATION_REVOKED,
    });
    expect(outcome).not.toHaveProperty("supports");
  });

  it("refuses a count grant's supports read instead of returning an empty page", async () => {
    const { outcome } = await run({ supportCount: 0, grantKind: EVIDENCE_GRANT_KIND.COUNT });
    expect(outcome).toMatchObject({
      state: "denied",
      failure: EVIDENCE_FAILURE.MALFORMED_CONTRACT,
      reason: "contract_violation",
    });
  });

  it("runs on a client the caller supplies, so the authorized-scope seam keeps one transaction", async () => {
    const recorded = recordingClient({ supportCount: 11 });
    const decision = await decideSupportContinuation(
      await readGrantFacts(recorded.client, GRANT_REF),
      {
        evidenceRef: GRANT_REF,
        at: AT,
        caller: { scopeBinding: SCOPE, authorizedSourceRefs: [SOURCE_REF] },
      },
      async (evidenceRef, supportIds) =>
        readGrantPinnedExtractionsForSupports(recorded.client, evidenceRef, supportIds)
    );
    expect(decision.state).toBe("granted");
    expect(recorded.statements).not.toContain("BEGIN");
    expect(recorded.statements).not.toContain("COMMIT");
    expect(recorded.statements).not.toContain("RELEASE");
  });

  it("mints a cursor whose version this build accepts and whose position is a pinned support", async () => {
    const { outcome } = await run({ supportCount: 11 });
    expect(outcome.state).toBe("granted");
    if (outcome.state !== "granted") return;
    expect(outcome.next_cursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from(String(outcome.next_cursor), "base64url").toString("utf8")
    ) as Record<string, string>;
    expect(Object.keys(decoded).sort()).toEqual(["after", "exp", "ref", "scope", "v"]);
    expect(decoded["v"]).toBe(EVIDENCE_CONTINUATION_CURSOR_VERSION);
    expect(decoded["exp"]).toBe(EXPIRES_AT);
    const second = await run(
      { supportCount: 11 },
      requestFor({ cursor: outcome.next_cursor })
    );
    expect(second.outcome.state).toBe("granted");
    if (second.outcome.state !== "granted") return;
    expect(second.outcome.supports.map((entry) => entry.support_id)).toEqual(
      Array.from({ length: 3 }, (_, index) => supportId(index + 9))
    );
  });
});
