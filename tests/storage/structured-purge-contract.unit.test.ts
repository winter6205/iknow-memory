/**
 * The purge transaction's pure and seam-level contracts.
 *
 * What belongs here is everything whose correctness does NOT depend on
 * PostgreSQL: the request refusal vocabulary, the two literals the purge writes
 * against vocabularies owned elsewhere, the emitted DDL, and the shape of the one
 * function a read path is allowed to use for its lease.
 *
 * What deliberately does NOT belong here is any assertion about a lease being
 * visible to another transaction. That is the property the whole design exists
 * for, and only `tests/acceptance/structured-purge-pg.test.ts` can prove it —
 * a fake client has no MVCC, so a unit test here would pass on an implementation
 * that a real purge could never wait on.
 */
import { describe, expect, it, vi } from "vitest";

import {
  MAINTENANCE_WORK_FAILURE_CODES,
  MAINTENANCE_WORK_STATUS,
} from "../../src/core/maintenance/types.js";
import { upSchemaStructuredPurge } from "../../src/core/storage/schema-structured-purge.js";
import {
  PgStructuredPurgeStore,
  PURGE_FENCED_ATTEMPT_FAILURE,
  PURGE_FENCED_WORK_STATUS,
  validateStructuredPurgeRequest,
  withStructuredReadLease,
  type StructuredPurgeLease,
  type StructuredPurgePool,
} from "../../src/core/storage/structured-purge-pg.js";
import type {
  ScopeTransactionClient,
  ScopeTransactionOwner,
} from "../../src/core/storage/structured-scope-types.js";
import type { SchemaBootstrapClient } from "../../src/core/storage/schema-sql.js";

interface RecordedQuery {
  readonly sql: string;
  readonly values?: unknown[];
}

/** A statement-recording client shaped like `pg`'s. */
function recordingSchemaClient(): {
  readonly client: SchemaBootstrapClient;
  readonly queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    client: {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        return { rows: [] };
      }),
    },
  };
}

const VALID = {
  scopeBinding: "scope-a",
  sourceRef: "src-1",
  purgeRevision: "purge-1",
};

describe("a purge request is refused before anything is written", () => {
  it("accepts a complete request and trims each field", () => {
    expect(
      validateStructuredPurgeRequest({
        scopeBinding: "  scope-a  ",
        sourceRef: " src-1 ",
        purgeRevision: " purge-1 ",
      })
    ).toEqual(VALID);
  });

  for (const field of ["scopeBinding", "sourceRef", "purgeRevision"] as const) {
    it(`refuses a blank ${field} as invalid_input`, () => {
      // The tombstone is keyed on exactly these three values, so a blank one
      // reaching the transaction would key a real purge on an empty identity.
      expect(() =>
        validateStructuredPurgeRequest({ ...VALID, [field]: "   " })
      ).toThrowError(/required/);
      try {
        validateStructuredPurgeRequest({ ...VALID, [field]: "" });
        throw new Error("expected a refusal");
      } catch (error) {
        expect((error as { code?: string }).code).toBe("invalid_input");
      }
    });

    it(`refuses a non-string ${field} as invalid_input`, () => {
      expect(() =>
        validateStructuredPurgeRequest({ ...VALID, [field]: 42 })
      ).toThrowError(/required/);
    });
  }

  it("refuses an absent request rather than reading a field off nothing", () => {
    for (const input of [undefined, null, {}, "purge", 7]) {
      expect(() => validateStructuredPurgeRequest(input)).toThrowError(
        /required/
      );
    }
  });
});

describe("the literals the purge writes are members of their vocabularies", () => {
  it("fences work into a status the ledger's own vocabulary declares", () => {
    // A literal here is a copy of `MAINTENANCE_WORK_STATUS`. The copy is what a
    // vocabulary change has to break, and this is the assertion that breaks it.
    expect(MAINTENANCE_WORK_STATUS).toContain(PURGE_FENCED_WORK_STATUS);
  });

  it("closes the fenced attempt with a declared failure code", () => {
    expect(MAINTENANCE_WORK_FAILURE_CODES).toContain(
      PURGE_FENCED_ATTEMPT_FAILURE
    );
  });
});

describe("the emitted DDL", () => {
  it("creates the lease table with the expiry and reader-kind constraints", async () => {
    const { client, queries } = recordingSchemaClient();
    await upSchemaStructuredPurge(client);
    const ddl = queries.map((query) => query.sql).join("\n");

    expect(ddl).toMatch(
      /CREATE TABLE IF NOT EXISTS structured_read_leases/i
    );
    expect(ddl).toMatch(
      /CREATE TABLE IF NOT EXISTS structured_purge_tombstones/i
    );
    // `expires_at > acquired_at` is a CHECK rather than a convention: a lease
    // that expires at or before it was taken is one the purge would treat as
    // already absent, while its reader is still running.
    expect(ddl).toMatch(/CHECK \(expires_at > acquired_at\)/);
    expect(ddl).toMatch(/reader_kind IN \('query', 'evidence'\)/);
    // One read covers many sources, so one lease id spans many rows. A key of
    // `lease_id` alone would collide inside the single multi-source INSERT.
    expect(ddl).toMatch(/PRIMARY KEY \(lease_id, source_ref\)/);
    expect(ddl).not.toMatch(/lease_id\s+uuid PRIMARY KEY/);
    // The tombstone key is the idempotency mechanism, so it is the assertion.
    expect(ddl).toMatch(
      /PRIMARY KEY \(scope_binding, source_ref, purge_revision\)/
    );
  });

  it("keeps expiry a query-time filter, never an index predicate", async () => {
    // PostgreSQL REJECTS a partial index predicate over `now()` because it is not
    // IMMUTABLE. A predicate here would fail the bootstrap on a fresh database
    // and pass every other test in this file.
    const { client, queries } = recordingSchemaClient();
    await upSchemaStructuredPurge(client);
    for (const query of queries) {
      const statement = query.sql;
      if (!/CREATE\s+INDEX/i.test(statement)) continue;
      const predicate = statement.split(/WHERE/i)[1];
      expect(predicate ?? "").not.toMatch(/\bnow\(\)/i);
    }
    expect(
      queries.some((query) =>
        /structured_read_leases_active_idx[\s\S]*\(scope_binding, source_ref, expires_at\)/i.test(
          query.sql
        )
      )
    ).toBe(true);
  });

  it("is idempotent: every statement is CREATE ... IF NOT EXISTS", async () => {
    const { client, queries } = recordingSchemaClient();
    await upSchemaStructuredPurge(client);
    for (const query of queries) {
      expect(query.sql).toMatch(/IF NOT EXISTS/i);
      expect(query.values).toBeUndefined();
    }
  });
});

/** A leased client that answers the lease statements from a script. */
function scriptedLease(
  answers: readonly Record<string, Record<string, unknown>[]>
): { readonly lease: StructuredPurgeLease; readonly queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const lease = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      for (const [fragment, rows] of Object.entries(answers)) {
        if (sql.includes(fragment)) return { rows };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { lease: lease as unknown as StructuredPurgeLease, queries };
}

/** An owner that runs the body against one scripted client, one transaction each. */
function ownerOf(
  lease: StructuredPurgeLease
): ScopeTransactionOwner & { released: number } {
  const owner = {
    released: 0,
    runTransaction: async <R>(
      body: (client: ScopeTransactionClient) => Promise<R>
    ): Promise<R> =>
      body(lease as unknown as ScopeTransactionClient),
  };
  return owner;
}

describe("lease acquisition and row insertion cannot be separated", () => {
  it("inserts one row per source before the body runs, and deletes it after", async () => {
    const { lease, queries } = scriptedLease({
      evidence_scope_revisions: [{ purge_revision: "purge-1" }],
      "INSERT INTO structured_read_leases": [{ lease_id: "x" }, { lease_id: "x" }],
    });
    const owner = ownerOf(lease);
    const body = vi.fn(async () => "answered");

    const answer = await withStructuredReadLease(
      owner,
      {
        scopeBinding: "scope-a",
        sourceRefs: ["src-2", "src-1"],
        readerKind: "query",
        ttlMs: 60_000,
      },
      body
    );

    expect(answer).toBe("answered");
    // The INSERT precedes the body and the DELETE follows it: a read that is
    // registered after it starts, or released before it ends, is the invisible
    // reader the bounded wait would hang on.
    const insert = queries.findIndex((q) =>
      q.sql.includes("INSERT INTO structured_read_leases")
    );
    const remove = queries.findIndex((q) =>
      q.sql.includes("DELETE FROM structured_read_leases")
    );
    expect(insert).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThan(insert);
    expect(body).toHaveBeenCalledTimes(1);
  });

  it("passes the reader's own execution bound as the lease lifetime", async () => {
    const { lease, queries } = scriptedLease({
      evidence_scope_revisions: [{ purge_revision: "purge-1" }],
      "INSERT INTO structured_read_leases": [{ lease_id: "x" }],
    });
    await withStructuredReadLease(
      ownerOf(lease),
      {
        scopeBinding: "scope-a",
        sourceRefs: ["src-1"],
        readerKind: "query",
        ttlMs: 60_000,
      },
      async () => "answered"
    );
    const insert = queries.find((q) =>
      q.sql.includes("INSERT INTO structured_read_leases")
    );
    // Values are [leaseId, scope, kind, purgeRevision, ttlMs, refs]; the fifth
    // is the bound, bound as a parameter rather than interpolated.
    expect(insert?.values?.[4]).toBe(60_000);
  });

  it("refuses a registration that inserted fewer rows than sources", async () => {
    // A lease held with no row is exactly the invisible reader: the purge would
    // wait on a reader it cannot see, and no expiry could ever end that wait.
    const { lease } = scriptedLease({
      evidence_scope_revisions: [{ purge_revision: "purge-1" }],
      "INSERT INTO structured_read_leases": [{ lease_id: "x" }],
    });
    await expect(
      withStructuredReadLease(
        ownerOf(lease),
        {
          scopeBinding: "scope-a",
          sourceRefs: ["src-1", "src-2"],
          readerKind: "query",
          ttlMs: 60_000,
        },
        async () => "never reached"
      )
    ).rejects.toMatchObject({ code: "backend_unavailable" });
  });

  it("refuses to register against a scope with no recorded purge revision", async () => {
    const { lease } = scriptedLease({ evidence_scope_revisions: [] });
    await expect(
      withStructuredReadLease(
        ownerOf(lease),
        {
          scopeBinding: "scope-a",
          sourceRefs: ["src-1"],
          readerKind: "query",
          ttlMs: 60_000,
        },
        async () => "never reached"
      )
    ).rejects.toMatchObject({ code: "access_denied" });
  });

  it("keeps the read's own failure when the release also fails", async () => {
    // The caller branches on the read's typed refusal. Losing it to a lease-cleanup
    // fault would replace `query_timeout` with an unrelated storage failure.
    let call = 0;
    const lease = {
      query: vi.fn(async (sql: string) => {
        call += 1;
        if (sql.includes("evidence_scope_revisions")) {
          return { rows: [{ purge_revision: "purge-1" }] };
        }
        if (sql.includes("DELETE FROM")) {
          throw new Error("lease release failed");
        }
        return { rows: [{ lease_id: "x" }] };
      }),
      release: vi.fn(),
    };
    const failure = Object.assign(new Error("structured read timed out"), {
      code: "query_timeout",
    });
    await expect(
      withStructuredReadLease(
        ownerOf(lease as unknown as StructuredPurgeLease),
        {
          scopeBinding: "scope-a",
          sourceRefs: ["src-1"],
          readerKind: "query",
          ttlMs: 60_000,
        },
        async () => {
          throw failure;
        }
      )
    ).rejects.toBe(failure);
    expect(call).toBeGreaterThan(0);
  });
});

describe("the bounded wait", () => {
  it("returns zero immediately when no source names a live reader", async () => {
    const { lease } = scriptedLease({});
    const store = new PgStructuredPurgeStore({
      connect: async () => lease,
    } as unknown as StructuredPurgePool);
    expect(
      await store.awaitActiveReads({
        scopeBinding: "scope-a",
        sourceRefs: [],
      })
    ).toBe(0);
  });

  it("re-scans until the observed leases are gone, and reports what it saw", async () => {
    // The loop must re-scan rather than trust one empty read: a reader that
    // starts mid-wait is waited for too. Termination comes from the TTL — the
    // window reports `wait_ms: 0` twice, then the row is gone.
    const windows = [
      { active: 2, wait_ms: 0 },
      { active: 1, wait_ms: 0 },
      { active: 0, wait_ms: 0 },
    ];
    let poll = 0;
    const lease = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("structured_read_leases")) {
          const window = windows[Math.min(poll, windows.length - 1)]!;
          poll += 1;
          return { rows: [window] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    } as unknown as StructuredPurgeLease;
    const store = new PgStructuredPurgeStore({
      connect: async () => lease,
    } as unknown as StructuredPurgePool);

    expect(
      await store.awaitActiveReads({
        scopeBinding: "scope-a",
        sourceRefs: ["src-1"],
      })
    ).toBe(1);
    expect(poll).toBe(3);
  });

  it("refuses an unreadable lease count rather than treating it as none", async () => {
    // `NaN` from an unreadable bigint must not read as "no readers": that is a
    // purge proceeding while a reader it cannot see is still running.
    const lease = {
      query: vi.fn(async () => ({ rows: [{ active: "not-a-number", wait_ms: 0 }] })),
      release: vi.fn(),
    } as unknown as StructuredPurgeLease;
    const store = new PgStructuredPurgeStore({
      connect: async () => lease,
    } as unknown as StructuredPurgePool);
    await expect(
      store.awaitActiveReads({
        scopeBinding: "scope-a",
        sourceRefs: ["src-1"],
      })
    ).rejects.toMatchObject({
      code: "maintenance_status_unavailable",
    });
  });
});