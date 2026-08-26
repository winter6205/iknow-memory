/**
 * The ledger side of the projection: read Postgres entity/triple rows and
 * shape them into the `GraphNode` / `GraphEdge` contract.
 *
 * Shared by the T2 backfill CLI and the T3 outbox drain so both send Neo4j the
 * same shape from the same query — one place decides what "live" means and how
 * a `tstzrange` becomes two ISO strings. The backfill sweeps the whole ledger
 * in pages; the drain asks for the handful of ids its claimed intents name.
 * Same WHERE clauses, same row mapping, so the two paths cannot disagree about
 * what belongs in the graph.
 *
 * The scans are keyset-paginated on `id`: an initial backfill can be
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
const ENTITY_SOURCE = `SELECT id, canonical_name, type
       FROM entities
      WHERE retired = false`;

/**
 * Triples whose BOTH endpoints are live. An edge to a retired entity has no
 * node to attach to, and `MERGE_EDGES` matches (never creates) its endpoints.
 *
 * `source_chunk_id` is read by no one here: chunks do not enter the graph
 * (ADR-0001) — the retrieve arm maps ranked entities back to chunks in
 * Postgres instead.
 */
const TRIPLE_SOURCE = `SELECT t.id, t.head_id, t.tail_id, t.relation_norm,
            t.confidence,
            lower(t.valid_window) AS valid_from,
            upper(t.valid_window) AS valid_until
       FROM triples t
       JOIN entities head ON head.id = t.head_id AND head.retired = false
       JOIN entities tail ON tail.id = t.tail_id AND tail.retired = false`;

/** One page of the backfill's entity sweep. */
export async function scanEntities(
  client: LedgerClient,
  page: ScanPage
): Promise<GraphNode[]> {
  const { rows } = await client.query(
    `${ENTITY_SOURCE} AND id > $1
      ORDER BY id
      LIMIT $2`,
    [page.after, page.limit]
  );
  return rows.map(toNode);
}

/** One page of the backfill's triple sweep. */
export async function scanTriples(
  client: LedgerClient,
  page: ScanPage
): Promise<GraphEdge[]> {
  const { rows } = await client.query(
    `${TRIPLE_SOURCE}
      WHERE t.id > $1
      ORDER BY t.id
      LIMIT $2`,
    [page.after, page.limit]
  );
  return rows.map(toEdge);
}

/**
 * The drain's entity read: the live rows behind a claimed batch of intents.
 *
 * An id the ledger no longer answers for — deleted, or retired since the
 * intent was emitted — is simply absent from the result. The caller sees a
 * shorter array than it asked for and decides what that means; this module
 * only reports what is live.
 */
export async function loadEntitiesByIds(
  client: LedgerClient,
  ids: readonly string[]
): Promise<GraphNode[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query(
    `${ENTITY_SOURCE} AND id = ANY($1::uuid[])
      ORDER BY id`,
    [[...ids]]
  );
  return rows.map(toNode);
}

/** The drain's triple read; same live-endpoint rule as the sweep above. */
export async function loadTriplesByIds(
  client: LedgerClient,
  ids: readonly string[]
): Promise<GraphEdge[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query(
    `${TRIPLE_SOURCE}
      WHERE t.id = ANY($1::uuid[])
      ORDER BY t.id`,
    [[...ids]]
  );
  return rows.map(toEdge);
}

function toNode(row: any): GraphNode {
  return {
    id: row.id as string,
    canonicalName: row.canonical_name as string,
    type: row.type as string,
  };
}

function toEdge(row: any): GraphEdge {
  return {
    id: row.id as string,
    headId: row.head_id as string,
    tailId: row.tail_id as string,
    relationNorm: row.relation_norm as string,
    confidence: Number(row.confidence),
    validFrom: toIso(row.valid_from),
    validUntil: toIso(row.valid_until),
  };
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
