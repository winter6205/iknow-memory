/**
 * Graph-arm pure orchestration (spec-3 p0-integration T3).
 *
 * **ARCHIVED off the production path (#58 / #62).** The default server
 * wiring supplies no `graphConfig`, so `assembleRetrievalResult` never
 * reaches this module: nothing here runs for an operator on the stock
 * server. It is kept compiling, and kept reachable from tests that inject
 * `graphConfig` explicitly, rather than deleted — a one-hop SQL JOIN over
 * `triples` was never a real graph arm, and a native graph engine is the
 * future home for one. See `docs/runbooks/sql-graph-arm-archived.md` for
 * the rationale and the successor.
 *
 * Runs the graph retrieval pipeline: top-K seed entities → one-hop triples →
 * chunks. The query embedding is supplied by the T5 orchestrator, which
 * embeds once for both arms (G5 lever (a), spec p0-wiring-closure A12) — the
 * arm never embeds. Honors `entityLinkTopK` / `candidateCap` and the
 * `graphArmFloor` under-floor gate. Fail-open by design: any storage error
 * degrades to `belowFloor=true` with a `failureReason`, never a throw; the
 * T5 orchestrator decides whether the whole retrieve call degrades.
 */
import type {
  ArmHit,
  ArmResult,
  GraphArmStorage,
  RetrieveConfig,
} from "./types.js";
import type { EntityType } from "../extraction/entity-type.js";
import { redactDiagnostic, writeStderr } from "../../logging.js";

/** Runtime deps injected by the retrieve orchestrator (T5). */
export interface GraphArmDeps {
  storage: GraphArmStorage;
  config: RetrieveConfig;
  /**
   * Resolved `filters.entity_type` seed restriction
   * (plans/entity-type-and-filter.md T3); absent = all types.
   */
  entityType?: EntityType;
}

/**
 * Run the graph arm for an already-embedded query. Returns an `ArmResult`;
 * storage failures are swallowed into a degraded `ArmResult` per the
 * fail-open contract.
 */
export async function runGraphArm(
  queryEmbedding: number[],
  deps: GraphArmDeps,
  now: Date
): Promise<ArmResult> {
  let seeds: Array<{ id: string; canonical_name: string }>;
  try {
    seeds = await getSeedEntities(deps, queryEmbedding);
  } catch (err) {
    // EXIT: degraded ArmResult 上行 orchestrator → envelope degraded:true
    return armResultWithError(err);
  }
  // Short-circuit: an empty seed set has no reachable one-hop path. The
  // floor (which counts chunks) would also fail on 0 rows, but skipping the
  // round-trip avoids an empty-uuid-array bind against the storage layer.
  if (seeds.length === 0) {
    return {
      arm: "graph",
      hits: [],
      belowFloor: true,
      failureReason: "graph arm yielded 0 seed entities",
    };
  }
  let rows;
  try {
    rows = await storageOneHop(deps, seeds, now);
  } catch (err) {
    // EXIT: degraded ArmResult 上行 orchestrator → envelope degraded:true
    return armResultWithError(err);
  }
  // Floor counts chunks (per spec §Boundaries: "if chunksByOneHopFromEntities
  // returns < graphArmFloor hits, set degraded: true"), not seed entities.
  // E.g. seeds=3 + oneHopRows=[g1] (floor=3) MUST be belowFloor=true, because
  // 1 < 3. Seeds are an upstream cap, not a correctness signal.
  if (shouldFlagBelowFloor(rows.length, deps.config.graphArmFloor)) {
    return {
      arm: "graph",
      hits: [],
      belowFloor: true,
      failureReason: `graph arm yielded ${rows.length} chunk(s) < floor ${deps.config.graphArmFloor}`,
    };
  }
  return { arm: "graph", hits: mapChunksToHits(rows), belowFloor: false };
}

/** Top-K seed entities by embedding similarity (soft-merge survivors). */
async function getSeedEntities(
  deps: GraphArmDeps,
  embedding: number[]
): Promise<Array<{ id: string; canonical_name: string }>> {
  return deps.storage.seedEntitiesByEmbedding(
    embedding,
    deps.config.entityLinkTopK,
    deps.entityType
  );
}

/** One-hop chunks reachable from the surviving seed ids. */
async function storageOneHop(
  deps: GraphArmDeps,
  seeds: Array<{ id: string; canonical_name: string }>,
  now: Date
): Promise<
  Array<{
    id: string;
    content: string;
    source_ref: string;
    valid_from: string;
    valid_until: string | null;
  }>
> {
  return deps.storage.chunksByOneHopFromEntities(
    seeds.map((s) => s.id),
    now.toISOString(),
    deps.config.candidateCap
  );
}

/** True when the one-hop chunk count does not reach the graph-arm floor. */
function shouldFlagBelowFloor(chunkCount: number, floor: number): boolean {
  return chunkCount < floor;
}

/** Map storage rows to `ArmHit`s with deterministic 1-based ranking. */
function mapChunksToHits(
  rows: Array<{
    id: string;
    content: string;
    source_ref: string;
    valid_from: string;
    valid_until: string | null;
  }>
): ArmHit[] {
  return rows.map((r, i) => ({
    id: r.id,
    arm: "graph" as const,
    rank: i + 1,
    // No cosine from storage; fall back to a monotone graph relevance score.
    score: 1 / (1 + i),
    content: r.content,
    source_ref: r.source_ref,
    valid_window: [r.valid_from, r.valid_until],
  }));
}

/** Degrade to an empty under-floor result carrying the failure reason. */
function armResultWithError(err: unknown): ArmResult {
  const message = redactDiagnostic(err instanceof Error ? err.message : err);
  // Log at warn; the T5 envelope makes the failure observable to the caller.
  writeStderr(`graph-arm degraded: ${message}\n`);
  return { arm: "graph", hits: [], belowFloor: true, failureReason: message };
}
