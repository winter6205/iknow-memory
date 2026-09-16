/**
 * Align live pgvector embedding column widths to the configured dimension.
 *
 * `CREATE TABLE IF NOT EXISTS` never rewrites an existing `vector(8)` column.
 * Existing 8-d rows also cannot CAST to `vector(N)`. This helper drops the
 * named ANN index (if any), drops the column, and adds a nullable
 * `vector(N)` so leftover rows keep their non-embedding data. Upsert /
 * re-ingest refill embeddings.
 */
export interface EmbedDimAlignClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

const CHUNK_EMBEDDING_INDEX = "chunks_embedding_idx";

function parseVectorWidth(columnType: unknown): number | undefined {
  if (typeof columnType !== "string") return undefined;
  const match = /^vector\((\d+)\)$/.exec(columnType);
  if (match === null) return undefined;
  return Number(match[1]);
}

async function readEmbeddingWidth(
  client: EmbedDimAlignClient,
  table: "chunks" | "entities"
): Promise<number | undefined> {
  const result = await client.query(
    `SELECT format_type(atttypid, atttypmod) AS column_type
       FROM pg_attribute
       JOIN pg_class ON pg_class.oid = pg_attribute.attrelid
       JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
      WHERE pg_class.relname = $1
        AND pg_attribute.attname = 'embedding'
        AND NOT pg_attribute.attisdropped
        AND pg_namespace.nspname = current_schema()`,
    [table]
  );
  const row = result.rows[0] as { column_type?: unknown } | undefined;
  return parseVectorWidth(row?.column_type);
}

async function realignEmbeddingColumn(
  client: EmbedDimAlignClient,
  table: "chunks" | "entities",
  dimensions: number,
  indexNames: readonly string[]
): Promise<void> {
  const current = await readEmbeddingWidth(client, table);
  if (current === undefined || current === dimensions) return;
  for (const indexName of indexNames) {
    await client.query(`DROP INDEX IF EXISTS ${indexName}`);
  }
  await client.query(`ALTER TABLE ${table} DROP COLUMN embedding`);
  await client.query(
    `ALTER TABLE ${table} ADD COLUMN embedding vector(${dimensions})`
  );
}

export async function alignEmbeddingDimensions(
  client: EmbedDimAlignClient,
  dimensions: number
): Promise<void> {
  await realignEmbeddingColumn(client, "chunks", dimensions, [
    CHUNK_EMBEDDING_INDEX,
  ]);
  await realignEmbeddingColumn(client, "entities", dimensions, []);
}
