/**
 * Core storage reads — pagination, typed id lookup, timeline projection,
 * and the pg SQL used by PgvectorBackend.
 *
 * Dashboard HTTP must call StorageReadPort; this file is the SQL SSOT.
 */
import { GraphragError } from "../errors.js";
import type {
  StorageChunkView,
  StorageEntityView,
  StorageListOptions,
  StoragePage,
  StorageReadResult,
  StorageTimelineEvent,
} from "../types.js";
import {
  STORAGE_LIST_LIMIT_DEFAULT,
  STORAGE_LIST_LIMIT_MAX,
} from "../types.js";
import { readContentInvalidations } from "./backend.js";

export const CHUNK_COUNT_SQL = "SELECT count(*)::bigint AS total FROM chunks";

export const CHUNK_LIST_SQL = `SELECT id, content, source_ref, valid_from, valid_until, metadata
   FROM chunks
  ORDER BY created_at, id
  LIMIT $1 OFFSET $2`;

export const CHUNK_BY_ID_SQL = `SELECT id, content, source_ref, valid_from, valid_until, metadata
   FROM chunks WHERE id = $1`;

export const ENTITY_LIVE_COUNT_SQL =
  "SELECT count(*)::bigint AS total FROM entities WHERE retired = false AND merged_into IS NULL";

export const ENTITY_LIST_SQL = `SELECT e.id, e.canonical_name, e.type, e.retired,
         coalesce(array_agg(a.alias) FILTER (WHERE a.alias IS NOT NULL), ARRAY[]::text[]) AS aliases
    FROM entities e
    LEFT JOIN entity_aliases a ON a.entity_id = e.id
   WHERE e.retired = false AND e.merged_into IS NULL
   GROUP BY e.id, e.canonical_name, e.type, e.retired
   ORDER BY e.id
   LIMIT $1 OFFSET $2`;

export const ENTITY_BY_ID_SQL = `SELECT e.id, e.canonical_name, e.type, e.retired,
         coalesce(array_agg(a.alias) FILTER (WHERE a.alias IS NOT NULL), ARRAY[]::text[]) AS aliases
    FROM entities e
    LEFT JOIN entity_aliases a ON a.entity_id = e.id
   WHERE e.id = $1
   GROUP BY e.id, e.canonical_name, e.type, e.retired`;

export const TIMELINE_CHUNKS_SQL = `SELECT id, source_ref, valid_from, valid_until, metadata
   FROM chunks
  ORDER BY created_at, id`;

export function normalizeStorageListOptions(
  opts: StorageListOptions | undefined
): { limit: number; offset: number } {
  const limit = opts?.limit ?? STORAGE_LIST_LIMIT_DEFAULT;
  const offset = opts?.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > STORAGE_LIST_LIMIT_MAX) {
    throw new GraphragError(
      `storage read: limit must be an integer in 1..${STORAGE_LIST_LIMIT_MAX}`,
      "INVALID_INPUT"
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new GraphragError(
      "storage read: offset must be a non-negative integer",
      "INVALID_INPUT"
    );
  }
  return { limit, offset };
}

export function lookupReadId(id: string): StorageReadResult<string> {
  if (typeof id !== "string" || id.trim() === "") {
    return { ok: false, code: "INVALID_INPUT" };
  }
  return { ok: true, value: id.trim() };
}

export function paginateItems<T>(
  items: readonly T[],
  limit: number,
  offset: number
): StoragePage<T> {
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    limit,
    offset,
  };
}

export function readSqlCount(rows: Array<Record<string, unknown>>): number {
  return Number(rows[0]?.["total"] ?? 0);
}

export function asIsoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  throw new GraphragError(
    `storage read: expected timestamp, got ${typeof value}`,
    "STORAGE_ERROR"
  );
}

export interface StorageChunkRow {
  id: string;
  content: string;
  source_ref: string;
  valid_from: unknown;
  valid_until: unknown;
  metadata: Record<string, unknown> | null;
}

export interface StorageEntityRow {
  id: string;
  canonical_name: string;
  type: string;
  retired: boolean;
  aliases: string[] | null;
}

export function toChunkView(row: StorageChunkRow): StorageChunkView {
  return {
    id: row.id,
    content: row.content,
    source_ref: row.source_ref,
    valid_from: asIsoTimestamp(row.valid_from),
    valid_until:
      row.valid_until === null ? null : asIsoTimestamp(row.valid_until),
    metadata: row.metadata ?? {},
  };
}

export function toEntityView(row: StorageEntityRow): StorageEntityView {
  return {
    id: row.id,
    canonical_name: row.canonical_name,
    type: row.type,
    retired: row.retired,
    aliases: row.aliases ?? [],
  };
}

export function projectTimelineEvents(
  chunks: readonly StorageChunkView[]
): StorageTimelineEvent[] {
  const events: StorageTimelineEvent[] = [];
  for (const chunk of chunks) {
    events.push({
      kind: "chunk_valid_from",
      at: chunk.valid_from,
      chunk_id: chunk.id,
      source_ref: chunk.source_ref,
    });
    if (chunk.valid_until !== null) {
      events.push({
        kind: "chunk_valid_until",
        at: chunk.valid_until,
        chunk_id: chunk.id,
        source_ref: chunk.source_ref,
      });
    }
    for (const record of readContentInvalidations(chunk.metadata)) {
      events.push({
        kind: "invalidation",
        at: record.invalidated_at,
        chunk_id: record.chunk_id,
        source_ref: chunk.source_ref,
        triggered_by: record.triggered_by,
      });
    }
  }
  return events.sort((a, b) => {
    const time = a.at.localeCompare(b.at);
    if (time !== 0) return time;
    const kind = a.kind.localeCompare(b.kind);
    if (kind !== 0) return kind;
    return a.chunk_id.localeCompare(b.chunk_id);
  });
}

export async function wrapPgRead<T>(
  method: string,
  run: () => Promise<T>,
  recover?: (err: unknown) => T | undefined
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const recovered = recover?.(err);
    if (recovered !== undefined) return recovered;
    if (err instanceof GraphragError) throw err;
    throw new GraphragError(
      `PgvectorBackend.${method} failed: ${(err as Error).message}`,
      "STORAGE_ERROR"
    );
  }
}

export function isPgInvalidTextRepresentation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "22P02"
  );
}
