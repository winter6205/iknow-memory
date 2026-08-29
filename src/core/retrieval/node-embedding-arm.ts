/**
 * Optional direct entity-embedding retrieval.
 *
 * Entity vectors remain Postgres ledger data. This arm only asks the ledger
 * for nearest entity seeds and maps those ranked entities back to chunks; it
 * never creates or queries a Neo4j vector index.
 */
import type {
  ArmHit,
  ArmResult,
  EntityChunkRow,
  EntityEmbeddingStorage,
  RetrieveConfig,
} from "./types.js";
import { supportsEntityEmbedding } from "../storage/backend.js";
import type { StorageBackend } from "../types.js";

export interface NodeEmbeddingArmDeps {
  storage: EntityEmbeddingStorage;
  config: RetrieveConfig;
}

/** Resolve the optional direct entity-embedding path. */
export function getNodeEmbeddingArm(
  config: RetrieveConfig | undefined,
  storage: StorageBackend
): NodeEmbeddingArmDeps | undefined {
  if (config?.nodeEmbeddingEnabled !== true) return undefined;
  if (!supportsEntityEmbedding(storage)) return undefined;
  return { storage: storage.entityEmbedding, config };
}

/** Start the node-embedding arm only when its gate resolved to an adapter. */
export function startNodeEmbeddingArm(
  queryEmbedding: number[],
  deps: NodeEmbeddingArmDeps | undefined,
  validAt: string
): Promise<ArmResult> | undefined {
  return deps === undefined
    ? undefined
    : runNodeEmbeddingSafe(queryEmbedding, deps, validAt);
}

export async function runNodeEmbeddingArm(
  queryEmbedding: number[],
  deps: NodeEmbeddingArmDeps,
  validAt: string
): Promise<ArmResult> {
  const seeds = await deps.storage.seedEntitiesByEmbedding(
    queryEmbedding,
    deps.config.entityLinkTopK
  );
  if (seeds.length === 0) {
    return { arm: "node-embedding", hits: [], belowFloor: false };
  }

  const rows = await deps.storage.chunksByEntityIds(
    seeds.map((seed) => seed.id),
    validAt,
    deps.config.candidateCap
  );
  const seedPositions = new Map(
    seeds.map((seed, position) => [
      seed.id,
      { position, score: seed.score ?? 1 / (position + 1) },
    ])
  );
  return {
    arm: "node-embedding",
    hits: rankChunks(rows, seedPositions),
    belowFloor: false,
  };
}

/** Run node embedding fail-open so the pre-embedding ranking survives. */
async function runNodeEmbeddingSafe(
  queryEmbedding: number[],
  deps: NodeEmbeddingArmDeps,
  validAt: string
): Promise<ArmResult> {
  try {
    return await runNodeEmbeddingArm(queryEmbedding, deps, validAt);
  } catch (err) {
    // EXIT: degraded:true + failureReason 上行 envelope，调用方可见
    return {
      arm: "node-embedding",
      hits: [],
      belowFloor: true,
      failureReason: err instanceof Error ? err.message : String(err),
    };
  }
}

function rankChunks(
  rows: readonly EntityChunkRow[],
  seedPositions: ReadonlyMap<string, { position: number; score: number }>
): ArmHit[] {
  const best = new Map<
    string,
    { row: EntityChunkRow; position: number; score: number }
  >();
  for (const row of rows) {
    const seed = seedPositions.get(row.entity_id);
    if (seed === undefined) continue;
    const previous = best.get(row.id);
    if (previous !== undefined && previous.position <= seed.position) continue;
    best.set(row.id, { row, ...seed });
  }
  return [...best.values()]
    .sort(
      (a, b) =>
        a.position - b.position ||
        b.score - a.score ||
        (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0)
    )
    .map(({ row, score }, rank) => ({
      id: row.id,
      arm: "node-embedding",
      rank: rank + 1,
      score,
      content: row.content,
      source_ref: row.source_ref,
      valid_window: [row.valid_from, row.valid_until],
    }));
}
