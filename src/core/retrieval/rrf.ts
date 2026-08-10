/**
 * Pure Reciprocal Rank Fusion (RRF) — spec-3 p0-integration T2.
 *
 * Formula: score = w / (k + rank) per (Cormack et al., 2009). k=60, w_vec
 * and w_graph default to 1.0. When the same chunk.id appears in both arms,
 * the score is the sum (double-counting is intentional and required for the
 * "soft-merge" success criterion #13). Tie-break is vec-first then graph;
 * within an arm, ties are broken by chunk.id ascending so the output is
 * deterministic regardless of insertion order.
 */
import type { ArmHit, ArmResult, FusedHit, RetrieveConfig } from "./types.js";

const K = 60;

function addHit(acc: Map<string, FusedHit>, hit: ArmHit, weight: number): void {
  if (hit.rank < 1) return;
  const score = weight / (K + hit.rank);
  const previous = acc.get(hit.id);
  if (previous) {
    previous.rrfScore += score;
    if (!previous.arms.includes(hit.arm)) previous.arms.push(hit.arm);
    return;
  }
  acc.set(hit.id, {
    id: hit.id,
    content: hit.content,
    source_ref: hit.source_ref,
    valid_window: hit.valid_window,
    rrfScore: score,
    arms: [hit.arm],
  });
}

function compareFusedHits(a: FusedHit, b: FusedHit): number {
  if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
  const aVectorFirst = a.arms[0] === "vector" ? 0 : 1;
  const bVectorFirst = b.arms[0] === "vector" ? 0 : 1;
  if (aVectorFirst !== bVectorFirst) return aVectorFirst - bVectorFirst;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function rrfFuse(
  vector: ArmResult,
  graph: ArmResult,
  cfg: RetrieveConfig,
  limit: number
): FusedHit[] {
  if (limit <= 0) return [];
  const acc = new Map<string, FusedHit>();
  for (const hit of vector.hits) addHit(acc, hit, cfg.w_vec);
  for (const hit of graph.hits) addHit(acc, hit, cfg.w_graph);
  return [...acc.values()].sort(compareFusedHits).slice(0, limit);
}

export const __RRF_K = K;
