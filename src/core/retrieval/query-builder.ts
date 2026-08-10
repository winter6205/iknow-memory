/**
 * Pure SQL string composition for the graph arm (spec-3 p0-integration T3).
 *
 * No live DB here — these functions only assemble parameterized SQL with
 * `$1..$N` placeholders; the pg driver binds real values. The one-hop query
 * is a hard single-hop traversal (Success Criterion #8): exactly one
 * `JOIN chunks`, no recursive CTE, no second hop / UNION.
 */

/**
 * SELECT the top `topK` surviving entities by cosine similarity to an
 * embedding vector. Soft-merge survivor-only (Success Criterion #13):
 * `merged_into IS NULL AND retired = false` keeps only live entities.
 *
 * `dimensions` is reserved for a future `::vector(n)` type annotation; the
 * pgvector operator `<=>` already infers the dimension from the bound value.
 */
export function buildSeedEntitiesSql(_dimensions: number): {
  sql: string;
  paramCount: number;
} {
  return {
    sql:
      "SELECT id, canonical_name FROM entities " +
      "WHERE embedding IS NOT NULL AND merged_into IS NULL AND retired = false " +
      "ORDER BY embedding <=> $1::vector LIMIT $2",
    paramCount: 2,
  };
}

/**
 * One-hop traversal: drive from `triples t`, join `chunks c ON
 * t.source_chunk_id = c.id`. Filtering on triples (head/tail in seed set,
 * confidence-ordered) first then joining keeps the row count bounded by
 * candidate-cap at planner cost.
 *
 * Literal "JOIN chunks" appears exactly once (single-hop hard limit,
 * Success Criterion #8). No recursive CTE, no UNION. The seed array is
 * bound as `ANY($1::uuid[])`; `$2` = validAt, `$3` = candidateCap. Both
 * sides are filtered by `valid_window @> $validAt` (two-sided temporal
 * filter, success criteria #2 / #3).
 *
 * `seedCount` is preserved for a future expansion to per-seed placeholders;
 * the current shape uses a single array bind and is independent of it.
 */
export function buildOneHopChunksSql(_seedCount: number): {
  sql: string;
  paramCount: number;
} {
  const sql = [
    "SELECT c.id, c.content, c.source_ref, c.valid_from, c.valid_until",
    "FROM triples t",
    "JOIN chunks c ON t.source_chunk_id = c.id",
    "WHERE (t.head_id = ANY($1::uuid[]) OR t.tail_id = ANY($1::uuid[]))",
    "AND t.valid_window @> $2::timestamptz",
    "AND c.valid_window @> $2::timestamptz",
    "ORDER BY t.confidence DESC",
    "LIMIT $3",
  ].join(" ");
  assertSingleHop(sql);
  return { sql, paramCount: 3 };
}

/**
 * Enforce the single-hop hard limit and ban recursive/multi-hop shapes.
 * Throws on a generated SQL that would traverse more than one hop.
 */
function assertSingleHop(sql: string): asserts sql is string {
  const joinChunksCount = sql.toUpperCase().split("JOIN CHUNKS").length - 1;
  if (joinChunksCount !== 1) {
    throw new Error(
      `one-hop hard limit violated: expected exactly 1 JOIN chunks, got ${joinChunksCount}`
    );
  }
  if (/WITH RECURSIVE/i.test(sql)) {
    throw new Error("recursive CTE forbidden in one-hop query");
  }
  if (/\bUNION\b/i.test(sql)) {
    throw new Error("second hop (UNION) forbidden in one-hop query");
  }
}
