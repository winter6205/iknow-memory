import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { ConfigError } from "../../src/config.js";
import { upSchemaBootstrap } from "../../src/core/storage/schema-bootstrap.js";
import { SOURCE_DOC_STATUS } from "../../src/core/types.js";

function recordingClient(): { client: PoolClient; queries: string[] } {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    }),
  } as unknown as PoolClient;
  return { client, queries };
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
