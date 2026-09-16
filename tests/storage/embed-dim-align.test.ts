import { describe, expect, it } from "vitest";

import { alignEmbeddingDimensions } from "../../src/core/storage/embed-dim-align.js";

interface FakeClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}

function recordingClient(widths: { chunks?: string; entities?: string }): {
  client: FakeClient;
  sql: string[];
} {
  const sql: string[] = [];
  const client: FakeClient = {
    query: async (text, values) => {
      sql.push(text);
      if (/format_type\(atttypid,\s*atttypmod\)/i.test(text)) {
        const table = String(values?.[0] ?? "");
        const columnType =
          table === "chunks"
            ? widths.chunks
            : table === "entities"
              ? widths.entities
              : undefined;
        if (columnType === undefined) return { rows: [] };
        return { rows: [{ column_type: columnType }] };
      }
      return { rows: [] };
    },
  };
  return { client, sql };
}

function joined(sql: string[]): string {
  return sql.join("\n");
}

describe("alignEmbeddingDimensions", () => {
  it("drops the named ANN index and recreates embedding as vector(1536) when typmod is 8", async () => {
    const { client, sql } = recordingClient({
      chunks: "vector(8)",
      entities: "vector(8)",
    });

    await alignEmbeddingDimensions(client, 1536);

    const text = joined(sql);
    expect(text).toMatch(/DROP INDEX IF EXISTS chunks_embedding_idx/i);
    expect(text).toMatch(/ALTER TABLE chunks\s+DROP COLUMN embedding/i);
    expect(text).toMatch(
      /ALTER TABLE chunks\s+ADD COLUMN embedding vector\(1536\)/i
    );
    expect(text).toMatch(/ALTER TABLE entities\s+DROP COLUMN embedding/i);
    expect(text).toMatch(
      /ALTER TABLE entities\s+ADD COLUMN embedding vector\(1536\)/i
    );
    expect(text).not.toMatch(/DELETE\s+FROM\s+source_documents/i);
    expect(text).not.toMatch(/DELETE\s+FROM\s+triples/i);
  });

  it("is a no-op when the live width already matches the target", async () => {
    const { client, sql } = recordingClient({
      chunks: "vector(1536)",
      entities: "vector(1536)",
    });

    await alignEmbeddingDimensions(client, 1536);

    const text = joined(sql);
    expect(text).toMatch(/format_type\(atttypid,\s*atttypmod\)/i);
    expect(text).not.toMatch(/DROP INDEX/i);
    expect(text).not.toMatch(/DROP COLUMN/i);
    expect(text).not.toMatch(/ADD COLUMN/i);
  });

  it("is a no-op when the chunks table or embedding column is missing", async () => {
    const { client, sql } = recordingClient({});

    await alignEmbeddingDimensions(client, 1536);

    const text = joined(sql);
    expect(text).not.toMatch(/DROP COLUMN/i);
    expect(text).not.toMatch(/ADD COLUMN/i);
    expect(text).not.toMatch(/DELETE\s+FROM/i);
  });
});
