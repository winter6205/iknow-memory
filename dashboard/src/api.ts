/** HTTP client pinned to T2–T4 dashboard-api JSON envelopes. */

export type ErrorBody = { error: { code: string; message: string } };

export type StatsBody = {
  chunks: number;
  entities: number;
  invalidations: number;
};

export type QueryChunk = {
  id: string;
  content: string;
  source_ref: string;
  valid_window: [string, string | null];
  score: number;
};

export type QueryBody = {
  chunks: QueryChunk[];
  degraded?: boolean;
  degraded_reasons?: string[];
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

export type NeighborhoodBody = {
  entity: GraphNode;
  inbound: GraphEdge[];
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
  return data.inbound.length === 0;
}
