/**
 * Post-ranking windowed permutation for temporary LLM rerank
 * (specs/retrieve-rerank-llm.md).
 *
 * The orchestrator calls this AFTER graph-priority (or vector-only) ranking
 * and BEFORE the Host `limit` cut when a reranker is actually wired.
 * Missing credentials are a skip at the gate, not this helper.
 */
import type { ChunkReranker, FusedHit, RetrieveConfig } from "./types.js";

export interface ApplyRerankArgs {
  query: string;
  limit: number;
  window: number;
  reranker: ChunkReranker;
}

export interface RerankOutcome {
  hits: FusedHit[];
  degraded: true | undefined;
}

/**
 * Prefix width W: at least Host `limit`, and at least `candidateCap` when
 * that cap is larger — so rerank permutes a prefix then cuts `limit`.
 * When the Host asks for more than `candidateCap`, W follows `limit`
 * rather than shrinking the envelope.
 */
export function rerankWindowSize(limit: number, candidateCap: number): number {
  if (limit <= 0 || candidateCap <= 0) return 0;
  return Math.max(limit, candidateCap);
}

function isPermutation(
  original: readonly string[],
  returned: readonly string[]
): boolean {
  if (returned.length !== original.length) return false;
  const remaining = new Set(original);
  for (const id of returned) {
    if (!remaining.delete(id)) return false;
  }
  return remaining.size === 0;
}

function cut(hits: readonly FusedHit[], limit: number): FusedHit[] {
  if (limit <= 0) return [];
  return hits.slice(0, limit);
}

/**
 * Reorder a ranked prefix, then cut to Host `limit`.
 *
 * Throw / unparseable / non-permutation → pre-rerank order + degraded.
 */
export async function applyRerank(
  hits: readonly FusedHit[],
  args: ApplyRerankArgs
): Promise<RerankOutcome> {
  if (hits.length === 0 || args.limit <= 0) {
    return { hits: [], degraded: undefined };
  }
  const prefixLen = Math.min(args.window, hits.length);
  if (prefixLen <= 0) {
    return { hits: cut(hits, args.limit), degraded: undefined };
  }
  const prefix = hits.slice(0, prefixLen);
  const rest = hits.slice(prefixLen);
  try {
    const ids = await args.reranker.permute(
      args.query,
      prefix.map((h) => ({ id: h.id, content: h.content }))
    );
    if (
      !isPermutation(
        prefix.map((h) => h.id),
        ids
      )
    ) {
      // EXIT: fail-open — non-permutation, pre-rerank order, degraded:true
      return { hits: cut(hits, args.limit), degraded: true };
    }
    const byId = new Map(prefix.map((h) => [h.id, h]));
    const reordered: FusedHit[] = [];
    for (const id of ids) {
      const hit = byId.get(id);
      if (hit === undefined) {
        // EXIT: fail-open — permutation check and map disagreed
        return { hits: cut(hits, args.limit), degraded: true };
      }
      reordered.push(hit);
    }
    return {
      hits: cut([...reordered, ...rest], args.limit),
      degraded: undefined,
    };
  } catch {
    // EXIT: fail-open — pre-rerank order, envelope degraded:true
    return { hits: cut(hits, args.limit), degraded: true };
  }
}

/**
 * Gate: off or unwired reranker → identity cut, no degraded from this step.
 */
export async function maybeRerank(
  hits: readonly FusedHit[],
  args: { query: string; limit: number },
  cfg: RetrieveConfig | undefined,
  reranker: ChunkReranker | undefined
): Promise<RerankOutcome> {
  if (cfg?.rerankEnabled !== true || reranker === undefined) {
    return { hits: cut(hits, args.limit), degraded: undefined };
  }
  return applyRerank(hits, {
    query: args.query,
    limit: args.limit,
    window: rerankWindowSize(args.limit, cfg.candidateCap),
    reranker,
  });
}
