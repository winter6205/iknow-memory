import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { ConfigError } from "../../src/config.js";
import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import {
  SOURCE_DOC_STATUS,
  COMMUNITY_INDEX_STATUS,
  EMBED_ROTATE_MODES,
  INDEX_JOB_STATUS,
} from "../../src/core/types.js";

function recordingClient(): {
  client: PoolClient;
  queries: string[];
  records: { sql: string; values?: unknown[] }[];
} {
  const queries: string[] = [];
  const records: { sql: string; values?: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push(sql);
      records.push({ sql, values });
      return { rows: [] };
    }),
  } as unknown as PoolClient;
  return { client, queries, records };
}

describe("upSchemaBootstrap community summary index", () => {
  it("rejects dimensions above the configured ANN limit instead of skipping HNSW", async () => {
    const { client, queries } = recordingClient();

    await expect(upSchemaBootstrap(client, 2048, 2000)).rejects.toBeInstanceOf(
      ConfigError
    );

    expect(
      queries.some((query) => /community_summaries_embedding_idx/.test(query))
    ).toBe(false);
  });

  it("keeps the HNSW index for dimensions supported by pgvector", async () => {
    const { client, queries } = recordingClient();

    await upSchemaBootstrap(client, 1536, 2000);

    expect(
      queries.some((query) => /community_summaries_embedding_idx/.test(query))
    ).toBe(true);
  });
});

describe("upSchemaBootstrap triples extractor provenance column (T5)", () => {
  it("declares extractor text NOT NULL DEFAULT 'llm' on the triples CREATE TABLE", async () => {
    const { client, queries } = recordingClient();
    await upSchemaBootstrap(client, 1536, 2000);
    const createTriples = queries.find(
      (q) =>
        /CREATE TABLE IF NOT EXISTS triples/.test(q) &&
        !/entity_aliases|extraction_records|community/.test(q)
    );
    expect(createTriples).toBeDefined();
    expect(createTriples).toMatch(
      /extractor\s+text\s+NOT NULL\s+DEFAULT 'llm'/
    );
  });

  it("emits a forward-compat ALTER TABLE for pre-existing triples tables without the column", async () => {
    const { client, queries } = recordingClient();
    await upSchemaBootstrap(client, 1536, 2000);
    const alters = queries.filter((q) =>
      /ALTER TABLE triples\s+ADD COLUMN IF NOT EXISTS extractor/i.test(q)
    );
    expect(alters).toHaveLength(1);
    expect(alters[0]).toMatch(/NOT NULL DEFAULT 'llm'/);
  });

  it("matches the same forward-compat shape as superseded_by and evidence_span", async () => {
    // The brief pins the column to the existing supersession/evidence_span
    // forward-compat pattern (schema-bootstrap.ts :102-111): each is an
    // `ALTER TABLE triples ADD COLUMN IF NOT EXISTS <col>` block. Adding a
    // diverging shape here would break the convention and make the column
    // hard to reason about for a future operator running bootstrap.
    const { client, queries } = recordingClient();
    await upSchemaBootstrap(client, 1536, 2000);
    const alters = queries.filter((q) =>
      /ALTER TABLE triples\s+ADD COLUMN IF NOT EXISTS/i.test(q)
    );
    const cols = alters.map((q) => {
      const m = /ADD COLUMN IF NOT EXISTS (\w+)/.exec(q);
      return m ? m[1] : null;
    });
    expect(cols).toEqual(
      expect.arrayContaining(["superseded_by", "evidence_span", "extractor"])
    );
    expect(cols).toHaveLength(3);
  });
});

describe("upSchemaBootstrap source_documents ledger (operator-console T1)", () => {
  it("creates source_documents with the prose-SoR columns", async () => {
    const { client, queries } = recordingClient();
    await upSchemaBootstrap(client, 1536, 2000);

    const createSourceDocuments = queries.find(
      (query) =>
        /CREATE TABLE IF NOT EXISTS source_documents/i.test(query) &&
        /source_ref/.test(query) &&
        /content/.test(query)
    );
    expect(
      createSourceDocuments,
      "source_documents CREATE TABLE not emitted"
    ).toBeDefined();
  });

  it("forward-compat ALTERs chunks with source_doc_id + ordinal back-pointers", async () => {
    const { client, queries } = recordingClient();
    await upSchemaBootstrap(client, 1536, 2000);

    const alters = queries.filter(
      (query) =>
        /ALTER TABLE chunks/i.test(query) &&
        /ADD COLUMN IF NOT EXISTS/i.test(query)
    );
    const altersAsString = alters.join("\n");
    expect(alters.length).toBeGreaterThanOrEqual(2);
    expect(altersAsString).toMatch(/source_doc_id/);
    expect(altersAsString).toMatch(/ordinal/);
  });

  it("binds the status CHECK to SOURCE_DOC_STATUS, not a second copy", async () => {
    const { client, queries } = recordingClient();
    await upSchemaBootstrap(client, 1536, 2000);

    const check = queries.find((query) =>
      /ADD CONSTRAINT source_documents_status_check/i.test(query)
    );
    expect(check, "status CHECK not emitted").toBeDefined();
    for (const value of Object.values(SOURCE_DOC_STATUS)) {
      expect(check).toContain(`'${value}'`);
    }
    const addColumn = queries.find((query) =>
      /ADD COLUMN IF NOT EXISTS status/i.test(query)
    );
    expect(addColumn).toContain(`DEFAULT '${SOURCE_DOC_STATUS.IN_PROGRESS}'`);
  });

  it("renders the status DEFAULT through the same literal escaper as the CHECK", async () => {
    const { client, queries } = recordingClient();
    await upSchemaBootstrap(client, 1536, 2000);

    const addColumn = queries.find((query) =>
      /ADD COLUMN IF NOT EXISTS status/i.test(query)
    );
    expect(addColumn, "status ADD COLUMN not emitted").toBeDefined();
    const check = queries.find((query) =>
      /ADD CONSTRAINT source_documents_status_check/i.test(query)
    );
    expect(check, "status CHECK not emitted").toBeDefined();

    expect(addColumn).toContain(`DEFAULT 'in_progress'`);
    expect(check).toContain(`'in_progress'`);
    expect(addColumn).not.toMatch(/DEFAULT\s+''\s/);
  });
});

// embedding generation rotate T1: the generation pointer singleton. One row
// (CHECK id = 1) shared by all three vector classes; the rotate_mode CHECK
// derives its literal list from EMBED_ROTATE_MODES (types.ts), same
// constant-side doctrine as the source_documents CHECKs above.
describe("upSchemaBootstrap embedding_generation (T1 generation ledger)", () => {
  it("creates the singleton with slot/model/dimensions + rotate_mode CHECK", async () => {
    const { client, queries } = recordingClient();
    await upSchemaBootstrap(client, 1536, 2000);

    const create = queries.find((query) =>
      /CREATE TABLE IF NOT EXISTS embedding_generation/i.test(query)
    );
    expect(
      create,
      "embedding_generation CREATE TABLE not emitted"
    ).toBeDefined();
    expect(create).toMatch(/CHECK \(id = 1\)/);
    expect(create).toMatch(/active_slot\s+text NOT NULL/i);
    expect(create).toMatch(/active_model\s+text NULL/i);
    expect(create).toMatch(/active_dimensions\s+integer NOT NULL/i);
    expect(create).toMatch(/incoming_slot\s+text NULL/i);
    expect(create).toMatch(/incoming_model\s+text NULL/i);
    expect(create).toMatch(/incoming_dimensions\s+integer NULL/i);
    expect(create).toMatch(/rotate_mode\s+text NULL/i);
    for (const mode of EMBED_ROTATE_MODES) {
      expect(create, `rotate_mode CHECK misses '${mode}'`).toContain(
        `'${mode}'`
      );
    }
    expect(create).toMatch(
      /updated_at\s+timestamptz NOT NULL DEFAULT now\(\)/i
    );
  });

  it("names embedding_generation in the readiness probe so deployed DBs get it", async () => {
    // Same lockstep doctrine as community_index_state above: the probe is
    // the only mechanism that adds a new bootstrap table to an existing
    // database, because a "ready" answer short-circuits the whole DDL.
    const records: { sql: string; values?: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        records.push({ sql, values });
        if (/AS ready/.test(sql)) return { rows: [{ ready: true }] };
        if (/current_schema\(\)/.test(sql)) {
          return { rows: [{ schema_name: "public" }] };
        }
        return { rows: [] };
      }),
    } as unknown as PoolClient;
    await upSchemaBootstrap(client, 1536, 2000);

    const probe = records.find(({ sql }) => /AS ready/.test(sql));
    expect(probe, "readiness probe not emitted").toBeDefined();
    expect(probe!.values?.[0]).toContain("embedding_generation");
  });
});

// graph-index-standard-fast T5: the persisted C-ready (就绪) state the
// community-summary CLI maintains beside the ledger swap. The table carries
// EXACTLY ONE row (id = 1) — a corpus-level fact, not a per-community one.
describe("upSchemaBootstrap community_index_state (T5 C-ready ledger)", () => {
  it("creates the singleton state table with a constant-derived status CHECK", async () => {
    const { client, queries } = recordingClient();
    await upSchemaBootstrap(client, 1536, 2000);

    const create = queries.find((query) =>
      /CREATE TABLE IF NOT EXISTS community_index_state/i.test(query)
    );
    expect(
      create,
      "community_index_state CREATE TABLE not emitted"
    ).toBeDefined();
    expect(create).toMatch(/CHECK \(id = 1\)/);
    expect(create).toMatch(/failure_code text NULL/);
    for (const value of Object.values(COMMUNITY_INDEX_STATUS)) {
      expect(create, `CHECK misses '${value}'`).toContain(`'${value}'`);
    }
  });

  it("the readiness probe names community_index_state so deployed DBs get it", async () => {
    // The probe short-circuits the whole DDL when every BOOTSTRAP_TABLES
    // entry exists; a table missing from that list would never be added to
    // a deployed database (same lockstep doctrine as bootstrap-columns).
    // The mock must answer `current_schema()` with a row, or
    // acquireSchemaBootstrapLock returns "not ready" BEFORE emitting the
    // probe (schema-lock.ts:98-101) and the probe is never observable.
    const records: { sql: string; values?: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        records.push({ sql, values });
        if (/AS ready/.test(sql)) return { rows: [{ ready: true }] };
        if (/current_schema\(\)/.test(sql)) {
          return { rows: [{ schema_name: "public" }] };
        }
        return { rows: [] };
      }),
    } as unknown as PoolClient;
    await upSchemaBootstrap(client, 1536, 2000);

    const probe = records.find(({ sql }) => /AS ready/.test(sql));
    expect(probe, "readiness probe not emitted").toBeDefined();
    expect(probe!.values?.[0]).toContain("community_index_state");
    // ready: true must also short-circuit the DDL (probe ordering pin).
    expect(
      records.some(({ sql }) => /CREATE TABLE IF NOT EXISTS entities/.test(sql))
    ).toBe(false);
  });
});

// community-level T1: product-scale `level` (larger integer = finer
// community) must be NOT NULL on fresh AND upgraded stores, so an INSERT
// without it fails on both (specs/community-level.md SC1).
describe("upSchemaBootstrap community_summaries.level (community-level T1)", () => {
  it("declares level integer NOT NULL on the fresh CREATE TABLE", async () => {
    const { client, queries } = recordingClient();
    await upSchemaBootstrap(client, 1536, 2000);
    const create = queries.find((query) =>
      /CREATE TABLE IF NOT EXISTS community_summaries/i.test(query)
    );
    expect(
      create,
      "community_summaries CREATE TABLE not emitted"
    ).toBeDefined();
    expect(create).toMatch(/level\s+integer NOT NULL/i);
  });

  it("wipes level-less legacy rows on an existing store, then SET NOT NULL, audited", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (/SELECT 1 FROM community_summaries WHERE level IS NULL/.test(sql)) {
          return { rows: [{ "?column?": 1 }] };
        }
        if (/DELETE FROM community_summaries WHERE level IS NULL/.test(sql)) {
          return { rows: [{ id: "legacy-1" }, { id: "legacy-2" }] };
        }
        return { rows: [] };
      }),
    } as unknown as PoolClient;
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      await upSchemaBootstrap(client, 1536, 2000);
      expect(
        queries.some((query) =>
          /ALTER TABLE community_summaries\s+ADD COLUMN IF NOT EXISTS level/i.test(
            query
          )
        ),
        "forward-compat ADD COLUMN level not emitted"
      ).toBe(true);
      const wipe = queries.find((query) =>
        /DELETE FROM community_summaries WHERE level IS NULL/i.test(query)
      );
      expect(
        wipe,
        "legacy level-less rows must be wiped before SET NOT NULL (spec assumption 2: wipe/rebuild)"
      ).toBeDefined();
      expect(wipe).toContain("RETURNING id");
      expect(
        queries.some((query) =>
          /ALTER TABLE community_summaries ALTER COLUMN level SET NOT NULL/i.test(
            query
          )
        ),
        "SET NOT NULL not emitted"
      ).toBe(true);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(
          "community_summaries level upgrade wiped level-less legacy rows=2"
        )
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("emits no data-level write when no level-less rows exist (dry-run contract)", async () => {
    const { client, queries } = recordingClient();
    await upSchemaBootstrap(client, 1536, 2000);
    expect(
      queries.filter((query) =>
        /^\s*DELETE FROM community_summaries/i.test(query)
      )
    ).toEqual([]);
  });

  it("names community_summaries.level in the readiness probe", async () => {
    const records: { sql: string; values?: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        records.push({ sql, values });
        if (/AS ready/.test(sql)) return { rows: [{ ready: true }] };
        if (/current_schema\(\)/.test(sql)) {
          return { rows: [{ schema_name: "public" }] };
        }
        return { rows: [] };
      }),
    } as unknown as PoolClient;
    await upSchemaBootstrap(client, 1536, 2000);

    const probe = records.find(({ sql }) => /AS ready/.test(sql));
    expect(probe, "readiness probe not emitted").toBeDefined();
    expect(probe!.values?.[2]).toContain("community_summaries");
    expect(probe!.values?.[3]).toContain("level");
  });
});

// corpus-index-job T2: the durable index-job ledger + the source_documents
// content-identity column the (source_ref, content_identity) pair keys on.
describe("upSchemaBootstrap index_jobs + content_identity (corpus-index-job T2)", () => {
  it("forward-compat ALTERs source_documents with content_identity", async () => {
    const { client, queries } = recordingClient();
    await upSchemaBootstrap(client, 1536, 2000);
    const alters = queries.filter((query) =>
      /ALTER TABLE source_documents\s+ADD COLUMN IF NOT EXISTS content_identity/i.test(
        query
      )
    );
    expect(alters).toHaveLength(1);
    expect(alters[0]).toMatch(/content_identity\s+text\s+NULL/i);
  });

  it("creates the UNIQUE (source_ref, content_identity) pair index", async () => {
    const { client, queries } = recordingClient();
    await upSchemaBootstrap(client, 1536, 2000);
    expect(
      queries.some(
        (query) =>
          /CREATE UNIQUE INDEX IF NOT EXISTS source_documents_source_ref_content_identity_idx/i.test(
            query
          ) &&
          /ON source_documents \(source_ref, content_identity\)/i.test(query)
      ),
      "pair index not emitted"
    ).toBe(true);
  });

  it("creates the index_jobs table with the submit-identity columns", async () => {
    const { client, queries } = recordingClient();
    await upSchemaBootstrap(client, 1536, 2000);
    const create = queries.find((query) =>
      /CREATE TABLE IF NOT EXISTS index_jobs/i.test(query)
    );
    expect(create, "index_jobs CREATE TABLE not emitted").toBeDefined();
    expect(create).toMatch(/job_id\s+text PRIMARY KEY/i);
    expect(create).toMatch(/source_ref\s+text NOT NULL/i);
    expect(create).toMatch(/content_identity\s+text NOT NULL/i);
    expect(create).toMatch(/status\s+text NOT NULL/i);
    expect(create).toMatch(/failure_code\s+text NULL/i);
    expect(create).toMatch(
      /created_at\s+timestamptz NOT NULL DEFAULT now\(\)/i
    );
    expect(create).toMatch(/started_at\s+timestamptz NULL/i);
    expect(create).toMatch(/finished_at\s+timestamptz NULL/i);
  });

  it("binds the index_jobs status CHECK to INDEX_JOB_STATUS via a named constraint", async () => {
    const { client, queries } = recordingClient();
    await upSchemaBootstrap(client, 1536, 2000);
    const check = queries.find((query) =>
      /ADD CONSTRAINT index_jobs_status_check/i.test(query)
    );
    expect(check, "index_jobs status CHECK not emitted").toBeDefined();
    for (const value of Object.values(INDEX_JOB_STATUS)) {
      expect(check, `CHECK misses '${value}'`).toContain(`'${value}'`);
    }
    // Guard the duplicate-object path so a replayed bootstrap stays idempotent.
    expect(check).toMatch(/WHEN duplicate_object THEN NULL/);
  });

  it("creates the (source_ref, status) index for the active-job lookup", async () => {
    const { client, queries } = recordingClient();
    await upSchemaBootstrap(client, 1536, 2000);
    expect(
      queries.some(
        (query) =>
          /CREATE INDEX IF NOT EXISTS index_jobs_source_ref_status_idx/i.test(
            query
          ) && /ON index_jobs \(source_ref, status\)/i.test(query)
      ),
      "active-job lookup index not emitted"
    ).toBe(true);
  });

  it("creates the partial UNIQUE index keeping one active job per source", async () => {
    const { client, queries } = recordingClient();
    await upSchemaBootstrap(client, 1536, 2000);
    const partial = queries.find((query) =>
      /CREATE UNIQUE INDEX IF NOT EXISTS index_jobs_one_active_per_source_idx/i.test(
        query
      )
    );
    expect(partial, "one-active-per-source index not emitted").toBeDefined();
    expect(partial).toMatch(/ON index_jobs \(source_ref\)/i);
    // The predicate must bind to the vocabulary constant, exactly like the
    // status CHECK — a drift here would police the wrong state word.
    expect(partial).toMatch(
      new RegExp(`WHERE status = '${INDEX_JOB_STATUS.IN_PROGRESS}'`, "i")
    );
  });

  it("names index_jobs, its index, and content_identity in the readiness probe", async () => {
    const records: { sql: string; values?: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        records.push({ sql, values });
        if (/AS ready/.test(sql)) return { rows: [{ ready: true }] };
        if (/current_schema\(\)/.test(sql)) {
          return { rows: [{ schema_name: "public" }] };
        }
        return { rows: [] };
      }),
    } as unknown as PoolClient;
    await upSchemaBootstrap(client, 1536, 2000);

    const probe = records.find(({ sql }) => /AS ready/.test(sql));
    expect(probe, "readiness probe not emitted").toBeDefined();
    expect(probe!.values?.[0]).toContain("index_jobs");
    expect(probe!.values?.[1]).toContain("index_jobs_source_ref_status_idx");
    // A forward-compat index must be IN the probe, or an old-schema database
    // would read as ready without the one-active-per-source constraint.
    expect(probe!.values?.[1]).toContain(
      "index_jobs_one_active_per_source_idx"
    );
    expect(probe!.values?.[1]).toContain(
      "source_documents_source_ref_content_identity_idx"
    );
    expect(probe!.values?.[2]).toContain("source_documents");
    expect(probe!.values?.[3]).toContain("content_identity");
  });
});

describe("upgradeEntitiesTypeCheck destructive-leg audit (review M3)", () => {
  function upgradingClient(
    deletedTriples: number,
    deletedEntities: number
  ): {
    client: PoolClient;
    queries: string[];
  } {
    const queries: string[] = [];
    const ids = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ id: `row-${i}` }));
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (/k\.conname/.test(sql)) {
          return { rows: [{ conname: "entities_type_check" }] };
        }
        if (/DELETE FROM triples/.test(sql)) {
          return { rows: ids(deletedTriples) };
        }
        if (/DELETE FROM entities/.test(sql)) {
          return { rows: ids(deletedEntities) };
        }
        if (/AS ready/.test(sql)) return { rows: [{ ready: false }] };
        if (/AS schema_name/.test(sql)) {
          return { rows: [{ schema_name: "public" }] };
        }
        return { rows: [] };
      }),
    } as unknown as PoolClient;
    return { client, queries };
  }

  it("audits deleted row counts to stderr after the destructive upgrade", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const { client, queries } = upgradingClient(3, 2);
      await upSchemaBootstrap(client, 1536, 2000);
      // RETURNING keeps the counts real, not inferred.
      expect(queries.find((q) => /DELETE FROM entities/.test(q))).toContain(
        "RETURNING id"
      );
      expect(queries.find((q) => /DELETE FROM triples/.test(q))).toContain(
        "RETURNING id"
      );
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(
          "entities-type-closed-check upgrade deleted triples=3 entities=2"
        )
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("stays silent when the upgrade deleted nothing", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const { client } = upgradingClient(0, 0);
      await upSchemaBootstrap(client, 1536, 2000);
      expect(stderr).not.toHaveBeenCalledWith(
        expect.stringContaining("upgrade deleted")
      );
    } finally {
      stderr.mockRestore();
    }
  });
});
