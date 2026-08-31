/**
 * Graph-priority assembly — production Host ranking for `retrieve`
 * (specs/retrieve-graph-priority.md SC1–SC3).
 *
 * The Neo4j graph arm is not a third RRF voter. When it returns chunks,
 * ITS order occupies the front of the list; vector + BM25 `rrfFuse` (k=60)
 * only fills whatever `limit` slots are left, deduped by chunk id. When it
 * returns nothing — no seeds, empty PPR, no mapped chunk, or a failure the
 * orchestrator already turned into `degraded` — the list is exactly the
 * vector+BM25 fusion, with no empty graph arm voting in it.
 *
 * The graph arm is identified by the RESULT OBJECT the orchestrator hands
 * in, never by the arm name "graph": the archived SQL one-hop arm answers
 * to the same name (#58) and must keep voting at `w_graph` rather than
 * inheriting a lead it was never granted.
 */
import { resolveRrfK, rrfFuse } from "./rrf.js";
import type { ArmHit, ArmResult, FusedHit, RetrieveConfig } from "./types.js";

/**
 * Rank the Host-visible list.
 *
 * `graph` is the Neo4j arm's result, or `undefined` when that arm did not
 * run at all. `remainder` carries every arm that still fuses by weight —
 * vector, BM25 and the archived SQL arm when a caller injected it.
 */
export function assembleGraphPriority(
  graph: ArmResult | undefined,
  remainder: readonly ArmResult[],
  cfg: RetrieveConfig,
  limit: number
): FusedHit[] {
  if (limit <= 0) return [];
  const lead = (graph?.hits ?? []).slice(0, limit);
  if (lead.length === 0) return rrfFuse(remainder, cfg, limit);
  const fill = fillRemainingSlots(remainder, cfg, limit, lead);
  const k = resolveRrfK(cfg);
  return [...lead.map((hit, i) => toLeadHit(hit, i, fill, k)), ...fill];
}

/**
 * Fuse vector + BM25 for the slots the graph left, dropping chunks the
 * graph already placed.
 *
 * The fusion draws `limit + lead.length` rather than the slot count: up to
 * `lead.length` of the fused list can be chunks the graph already placed,
 * and dropping those must not leave the answer short of `limit`.
 */
function fillRemainingSlots(
  remainder: readonly ArmResult[],
  cfg: RetrieveConfig,
  limit: number,
  lead: readonly ArmHit[]
): FusedHit[] {
  const slots = limit - lead.length;
  if (slots <= 0) return [];
  const placed = new Set(lead.map((hit) => hit.id));
  return rrfFuse(remainder, cfg, limit + lead.length)
    .filter((hit) => !placed.has(hit.id))
    .slice(0, slots);
}

/**
 * Project a graph hit into the envelope's fused shape.
 *
 * `chunks[]` order is the ranking contract, but a Host is free to re-sort
 * by `score`, so the lead segment is lifted above the whole fused
 * remainder instead of being left on a scale that could interleave with
 * it. Within the segment the score still follows the RRF k=60 curve, so
 * the graph's own order survives that re-sort.
 */
function toLeadHit(
  hit: ArmHit,
  i: number,
  fill: readonly FusedHit[],
  k: number
): FusedHit {
  const top = fill[0]?.rrfScore ?? 0;
  return {
    id: hit.id,
    content: hit.content,
    source_ref: hit.source_ref,
    valid_window: hit.valid_window,
    rrfScore: top + 1 / (k + i + 1),
    arms: [hit.arm],
  };
}
