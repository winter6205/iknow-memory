/**
 * The ledger side of the projection: read Postgres entity/triple rows and
 * shape them into the `GraphNode` / `GraphEdge` contract.
 *
 * Shared by the T2 backfill CLI and (later) the T3 outbox drain so both send
 * Neo4j the same shape from the same query — one place decides what "live"
 * means and how a `tstzrange` becomes two ISO strings.
 *
 * Both scans are keyset-paginated on `id`: an initial backfill can be
 * arbitrarily large, and OFFSET pagination would both slow down and skip rows
 * when a concurrent extract run inserts underneath the cursor.
 */
import type { GraphEdge, GraphNode } from "./types.js";

/** Minimal query surface satisfied by `pg.Pool`, `pg.PoolClient` and fakes. */
export interface LedgerClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface ScanPage {
  /** Exclusive lower bound on `id`; the zero UUID starts a scan. */
  after: string;
  limit: number;
}

/** Sorts before every v4 UUID, so it is the natural first cursor. */
export const SCAN_START = "00000000-0000-0000-0000-000000000000";

/**
 * Live entities only: a retired row has been merged away, and projecting it
 * would give the graph arm a seed that resolves to nothing in the ledger.
 */
export async function scanEntities(
  client: LedgerClient,
  page: ScanPage
): Promise<GraphNode[]> {
  const { rows } = await client.query(
    `SELECT id, canonical_name, type
       FROM entities
      WHERE retired = false AND id > $1
      ORDER BY id
      LIMIT $2`,
    [page.after, page.limit]
  );
  return rows.map((row) => ({
    id: row.id as string,
    canonicalName: row.canonical_name as string,
    type: row.type as string,
  }));
}

/**
 * Triples whose BOTH endpoints are live. An edge to a retired entity has no
 * node to attach to, and `MERGE_EDGES` matches (never creates) its endpoints.
 *
 * `source_chunk_id` is read by no one here: chunks do not enter the graph
 * (ADR-0001) — the retrieve arm maps ranked entities back to chunks in
 * Postgres instead.
 */
export async function scanTriples(
  client: LedgerClient,
  page: ScanPage
): Promise<GraphEdge[]> {
  const { rows } = await client.query(
    `SELECT t.id, t.head_id, t.tail_id, t.relation_norm, t.confidence,
            lower(t.valid_window) AS valid_from,
            upper(t.valid_window) AS valid_until
       FROM triples t
       JOIN entities head ON head.id = t.head_id AND head.retired = false
       JOIN entities tail ON tail.id = t.tail_id AND tail.retired = false
      WHERE t.id > $1
      ORDER BY t.id
      LIMIT $2`,
    [page.after, page.limit]
  );
  return rows.map((row) => ({
    id: row.id as string,
    headId: row.head_id as string,
    tailId: row.tail_id as string,
    relationNorm: row.relation_norm as string,
    confidence: Number(row.confidence),
    validFrom: toIso(row.valid_from),
    validUntil: toIso(row.valid_until),
  }));
}

/**
 * `timestamptz` arrives as a JS Date from node-postgres; an unbounded range
 * bound arrives as null (forever). Normalized to ISO-8601 here so the graph
 * property is comparable across drivers and readable in the Neo4j browser.
 */
function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
