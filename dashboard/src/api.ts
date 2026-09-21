import {
  SOURCE_DOC_STATUS,
  type SourceDocStatus,
} from "../../src/core/types.js";

/** HTTP client pinned to T2–T4 dashboard-api JSON envelopes. */

export type ErrorBody = { error: { code: string; message: string } };

export type StatsBody = {
  chunks: number;
  entities: number;
  invalidations: number;
};

export type PageBody<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};

export type ChunkListItem = {
  id: string;
  content: string;
  source_ref?: string;
};

/**
 * 资料 页状态 vocabulary (corpus-ready retrieve T3). Persisted by push on
 * the server; the SPA only maps it to a label. Not inferred from
 * `valid_until` — a push that failed records 失败 even with no chunk rows.
 */
export type SourceStatus = SourceDocStatus;

/**
 * Re-exported so the SPA's status-keyed maps (SOURCE_STATUS_LABEL, and
 * SourcesPage's ink classes) spell the vocabulary off the server constant
 * instead of restating literals.
 */
export { SOURCE_DOC_STATUS };

export const SOURCE_STATUS_LABEL: Record<SourceStatus, string> = {
  [SOURCE_DOC_STATUS.IN_PROGRESS]: "进行中",
  [SOURCE_DOC_STATUS.READY]: "就绪",
  [SOURCE_DOC_STATUS.FAILED]: "失败",
};

/**
 * 资料 list-row summary (operator-console T6, four fields T3). Title is
 * nullable — empty title displays source_ref on the board (see
 * SourcesPage). Body is not present; the dashboard list is on-demand.
 * `chunk_count` is the derived successful-chunk count, `collection` the
 * single process-wide 资料集合 name.
 */
export type SourceSummary = {
  id: string;
  source_ref: string;
  title: string | null;
  created_at: string;
  valid_until: string | null;
  collection: string;
  status: SourceStatus;
  failure_code: string | null;
  chunk_count: number;
};

/** 资料 full body — fetched on open (operator-console T6, four fields T3). */
export type SourceDetail = {
  id: string;
  source_ref: string;
  title: string | null;
  content: string;
  created_at: string;
  valid_until: string | null;
  collection: string;
  status: SourceStatus;
  failure_code: string | null;
  chunk_count: number;
};

export type EntityListItem = {
  id: string;
  canonical_name: string;
  type?: string;
};

export type TimelineItem = {
  kind: string;
  at: string;
  chunk_id?: string;
  source_ref?: string;
  triggered_by?: string;
};

export type GraphNode = { id: string; name?: string; type?: string };
export type GraphEdge = { from: string; to: string; type?: string };
export type GraphBody = { nodes: GraphNode[]; edges: GraphEdge[] };

export type ChunkDetail = {
  id: string;
  content: string;
  source_ref: string;
  valid_from: string;
  valid_until: string | null;
  metadata?: Record<string, unknown>;
};

export type EntityDetail = {
  id: string;
  canonical_name: string;
  type?: string;
  retired?: boolean;
  aliases?: string[];
};

/**
 * One failed extraction on the maintenance lane (extract-verify T3) — the
 * review fields of an `extraction_records` row as GET /api/maintenance/failed
 * sends them. The held proposal never travels; `has_proposal` says whether
 * promote can advance this row.
 */
export type FailedRecordItem = {
  id: string;
  batch_id: string | null;
  chunk_id: string | null;
  error_code: string | null;
  error_msg: string | null;
  has_proposal: boolean;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  source_ref: string | null;
  source_doc_id: string | null;
};

export type FailedListBody = { items: FailedRecordItem[] };

export type NeighborhoodNeighbor = {
  id: string;
  name: string;
  type?: string;
  relation?: string;
};

export type NeighborhoodBody = {
  entity: GraphNode;
  inbound: NeighborhoodNeighbor[];
  outbound: NeighborhoodNeighbor[];
};

export type FetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: { code: string; message: string } };

export function readErrorEnvelope(body: unknown): {
  code: string;
  message: string;
} {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return { code: "INTERNAL", message: "unreadable error envelope" };
  }
  const err = (body as ErrorBody).error;
  if (typeof err !== "object" || err === null) {
    return { code: "INTERNAL", message: "unreadable error envelope" };
  }
  return {
    code: typeof err.code === "string" ? err.code : "INTERNAL",
    message: typeof err.message === "string" ? err.message : "",
  };
}

export async function fetchJson<T>(path: string): Promise<FetchResult<T>> {
  const res = await fetch(path);
  const body: unknown = await res.json();
  if (!res.ok) {
    return { ok: false, status: res.status, error: readErrorEnvelope(body) };
  }
  return { ok: true, data: body as T };
}

/** POST JSON for 资料 chrome thin writes (same /api/writes/* runners as MCP). */
export async function postJson<T>(
  path: string,
  body?: unknown
): Promise<FetchResult<T>> {
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  let parsed: unknown = {};
  try {
    parsed = await res.json();
  } catch {
    parsed = {};
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: readErrorEnvelope(parsed) };
  }
  return { ok: true, data: parsed as T };
}

export function sourcesTotal(data: PageBody<unknown>): number {
  return typeof data.total === "number" ? data.total : 0;
}

export function isEmptyStats(data: StatsBody): boolean {
  return data.chunks === 0 && data.entities === 0 && data.invalidations === 0;
}

export function isEmptyPage<T>(data: PageBody<T>): boolean {
  return data.total === 0 && data.items.length === 0;
}

export function isEmptyGraph(data: GraphBody): boolean {
  return data.nodes.length === 0 && data.edges.length === 0;
}

export function isEmptyNeighborhood(data: NeighborhoodBody): boolean {
  return data.inbound.length === 0 && data.outbound.length === 0;
}
