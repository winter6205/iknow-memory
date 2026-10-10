/**
 * Pure Reciprocal Rank Fusion (RRF).
 *
 * Formula: score = w_arm / (k + rank) per (Cormack et al., 2009), with
 * k=60 as the default.
 * When the same chunk.id surfaces in more than one arm the scores sum —
 * cross-arm agreement is signal, so the double-count is intentional.
 *
 * The function takes a LIST of arms rather than a fixed pair: production
 * fuses vector + BM25, and the SQL graph arm is archived off
 * that path yet still fusable when a caller injects it. Adding an
 * arm is a new `ArmName` plus a weight, not a signature change.
 *
 * Ordering is fully deterministic regardless of arm or hit input order:
 * rrfScore descending, then the arm that first contributed the hit in
 * ARM_ORDER, then chunk.id ascending.
 */
import type {
  ArmHit,
  ArmName,
  ArmResult,
  EntitySeedCandidate,
  FusedHit,
  RetrieveConfig,
} from "./types.js";

/**
 * The RRF denominator constant. Exported because the graph-priority
 * assembler scores its lead segment on the same curve — a second literal
 * there would let the two drift apart.
 */
export const RRF_K = 60;

/** Resolve the configured denominator while keeping legacy callers at k=60. */
export function resolveRrfK(cfg: Pick<RetrieveConfig, "rrfK">): number {
  return cfg.rrfK ?? RRF_K;
}

/** Per-arm weight lookup. Exhaustive over ArmName by construction. */
const ARM_WEIGHT: Record<ArmName, (cfg: RetrieveConfig) => number> = {
  vector: (cfg) => cfg.w_vec,
  bm25: (cfg) => cfg.w_bm25,
  graph: (cfg) => cfg.w_graph,
  // Node embedding is a graph-priority lead in the orchestrator. Keeping a
  // weight here makes the ArmResult total and safe if it is ever fused.
  "node-embedding": (cfg) => cfg.w_graph,
  "community-summary": () => 0,
};

/**
 * Tie-break priority when two hits score identically. Vector leads because
 * it is the arm that always runs; graph trails because it is archived.
 */
const ARM_ORDER: readonly ArmName[] = [
  "vector",
  "bm25",
  "graph",
  "node-embedding",
  "community-summary",
];

function armRank(arm: ArmName | undefined): number {
  const i = arm === undefined ? -1 : ARM_ORDER.indexOf(arm);
  return i === -1 ? ARM_ORDER.length : i;
}

function addHit(
  acc: Map<string, FusedHit>,
  hit: ArmHit,
  weight: number,
  k: number
): void {
  if (hit.rank < 1) return;
  const score = weight / (k + hit.rank);
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
    ...(hit.metadata !== undefined ? { metadata: hit.metadata } : {}),
  });
}

function compareFusedHits(a: FusedHit, b: FusedHit): number {
  if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
  const byArm = armRank(a.arms[0]) - armRank(b.arms[0]);
  if (byArm !== 0) return byArm;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Fuse any number of arms into a single ranked list, truncated to `limit`.
 * A non-positive limit yields `[]` rather than an unbounded list.
 */
export function rrfFuse(
  arms: readonly ArmResult[],
  cfg: RetrieveConfig,
  limit: number
): FusedHit[] {
  if (limit <= 0) return [];
  const acc = new Map<string, FusedHit>();
  const k = resolveRrfK(cfg);
  // Iterate in ARM_ORDER, not caller order, so `arms[0].arms[0]` — the
  // tie-break key — does not depend on how the orchestrator happened to
  // assemble the array.
  const ordered = [...arms].sort((x, y) => armRank(x.arm) - armRank(y.arm));
  for (const arm of ordered) {
    const weight = ARM_WEIGHT[arm.arm](cfg);
    for (const hit of arm.hits) addHit(acc, hit, weight, k);
  }
  return [...acc.values()].sort(compareFusedHits).slice(0, limit);
}

/**
 * Fuse entity candidates with the same rank-only algorithm used for chunks.
 *
 * Entity candidates are projected into the existing `ArmHit` shape only for
 * the duration of the call; no entity becomes a chunk result. Keeping this
 * adapter here makes the entity-finding RRF use the same k and tie-breaking
 * rules as Host fallback RRF while preserving the two granularities.
 */
export function rrfFuseEntitySeeds(
  vector: readonly EntitySeedCandidate[],
  lexical: readonly EntitySeedCandidate[],
  cfg: RetrieveConfig,
  limit: number
): EntitySeedCandidate[] {
  if (limit <= 0) return [];
  const arms: ArmResult[] = [
    toEntityArmResult("vector", vector),
    toEntityArmResult("bm25", lexical),
  ];
  return rrfFuse(arms, cfg, limit).map((hit) => ({
    id: hit.id,
    canonical_name: hit.content,
  }));
}

function toEntityArmResult(
  arm: "vector" | "bm25",
  candidates: readonly EntitySeedCandidate[]
): ArmResult {
  return {
    arm,
    hits: candidates.map((candidate, index) => ({
      id: candidate.id,
      arm,
      rank: index + 1,
      score: candidate.score ?? 0,
      content: candidate.canonical_name,
      source_ref: "__entity__",
      valid_window: ["1970-01-01T00:00:00.000Z", null],
    })),
    belowFloor: false,
  };
}
