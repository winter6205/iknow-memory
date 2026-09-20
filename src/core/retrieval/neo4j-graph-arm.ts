/**
 * Neo4j graph arm — the production graph recall path (specs/neo4j-graph-arm.md
 * T4; #70).
 *
 * Three steps, two stores:
 *   1. **seed** — top-K entities nearest the query embedding, from Postgres.
 *      The embedding is supplied by the orchestrator, which embeds once for
 *      every arm; this module never embeds.
 *   2. **rank** — Personalized PageRank anchored on those seeds, from the
 *      Neo4j projection. This is the multi-hop step the archived SQL arm
 *      never had: a one-hop JOIN over `triples` could only ever return the
 *      seeds' immediate neighbourhood (`docs/runbooks/sql-graph-arm-archived.md`).
 *   3. **map** — ranked entities back to chunks through
 *      `triples.source_chunk_id`, from Postgres. Chunks do not enter the
 *      graph (ADR-0001), so the ranking is re-attached here rather than read
 *      off a graph node.
 *
 * Fail-open by design: any step that throws yields an empty `ArmResult`
 * carrying `belowFloor: true` and a `failureReason`, and the orchestrator
 * turns that into `degraded: true` on the envelope while the other arms
 * still answer (SC8). A step that legitimately finds nothing — no entities
 * in the ledger, nothing reachable in the graph, no chunk behind the ranked
 * entities — yields an empty NON-degraded result: a sparse graph is a thin
 * answer, not a broken one.
 *
 * Unlike the archived arm this one carries no `graphArmFloor`. The floor
 * exists to say "the one-hop JOIN returned too little to be worth fusing";
 * applied here it would flag every retrieve on a graph that is still
 * filling up, which would make `degraded` mean nothing on the wire.
 */
import type {
  ArmHit,
  ArmResult,
  CapabilityObservation,
  EntityChunkRow,
  EntityLexicalStorage,
  EntitySeedCandidate,
  GraphRanker,
  Neo4jArmStorage,
  RankedEntity,
  RetrieveConfig,
} from "./types.js";
import type { EntityType } from "../extraction/entity-type.js";
import { redactDiagnostic, writeStderr } from "../../logging.js";
import { rrfFuseEntitySeeds } from "./rrf.js";

/** Runtime deps injected by the retrieve orchestrator. */
export interface Neo4jGraphArmDeps {
  /** Postgres side: entity seeds and the entity → chunk mapping. */
  storage: Neo4jArmStorage;
  /** Graph side: PPR over the read-only projection. */
  ranker: GraphRanker;
  config: RetrieveConfig;
  /** Optional ES entity index used during entity finding. */
  entityLexical?: EntityLexicalStorage;
  /**
   * Resolved `filters.entity_type` seed restriction
   * (plans/entity-type-and-filter.md T3); absent = all types. BOTH the
   * vector and the lexical seed halves honor it so a filtered seed set
   * stays closed under RRF fusion.
   */
  entityType?: EntityType;
}

/** An empty contribution that is explicitly NOT a degradation. */
const NOTHING_TO_ADD: ArmResult = {
  arm: "graph",
  hits: [],
  belowFloor: false,
};

/**
 * Run the graph arm for an already-embedded query. Never rejects: every
 * failure comes back as a degraded `ArmResult`.
 */
export async function runNeo4jGraphArm(
  queryEmbedding: number[],
  deps: Neo4jGraphArmDeps,
  validAt: string,
  query?: string
): Promise<ArmResult> {
  try {
    return await recall(queryEmbedding, deps, validAt, query);
  } catch (err) {
    // EXIT: degraded ArmResult 上行 orchestrator → envelope degraded:true
    return degraded(err);
  }
}

/** The happy path; every throw inside is caught by `runNeo4jGraphArm`. */
async function recall(
  queryEmbedding: number[],
  deps: Neo4jGraphArmDeps,
  validAt: string,
  query: string | undefined
): Promise<ArmResult> {
  const seedResult = await getSeedEntities(deps, queryEmbedding, query);
  const seeds = seedResult.seeds;
  // No seed entity means the ledger holds nothing the query can anchor on.
  // Skipping the graph round trip here is also what keeps an unanchored
  // (global, non-personalized) PageRank from ever being asked for.
  if (seeds.length === 0) return withSeedStatus(NOTHING_TO_ADD, seedResult);

  const ranked = await deps.ranker.rankEntities(
    seeds.map((seed) => seed.id),
    deps.config.candidateCap
  );
  if (ranked.length === 0) return withSeedStatus(NOTHING_TO_ADD, seedResult);

  const rows = await deps.storage.chunksByEntityIds(
    ranked.map((entity) => entity.id),
    validAt,
    deps.config.candidateCap
  );
  const hits = rankChunks(rows, ranked).slice(0, deps.config.candidateCap);
  return withSeedStatus({ arm: "graph", hits, belowFloor: false }, seedResult);
}

interface SeedResult {
  seeds: EntitySeedCandidate[];
  observations: CapabilityObservation[];
  failureReason?: string;
}

/**
 * The entity-finding stage is the only place where the lexical entity index
 * participates. A failed lexical lookup releases the vector seed list and
 * records a named observation; it never prevents the graph from answering.
 */
async function getSeedEntities(
  deps: Neo4jGraphArmDeps,
  embedding: number[],
  query: string | undefined
): Promise<SeedResult> {
  const vectorPromise = deps.storage.seedEntitiesByEmbedding(
    embedding,
    deps.config.entityLinkTopK,
    deps.entityType
  );
  if (query === undefined || deps.entityLexical === undefined) {
    return { seeds: await vectorPromise, observations: [] };
  }

  const lexicalPromise = deps.entityLexical.searchEntities(
    query,
    deps.config.entityLinkTopK,
    precisionOptions(deps.config),
    deps.entityType
  );
  const [vector, lexical] = await Promise.allSettled([
    vectorPromise,
    lexicalPromise,
  ]);
  if (vector.status === "rejected" && lexical.status === "rejected") {
    throw vector.reason;
  }
  if (vector.status === "rejected") {
    return {
      seeds: lexical.status === "fulfilled" ? lexical.value : [],
      observations: [],
    };
  }
  if (lexical.status === "rejected") {
    return {
      seeds: vector.value,
      observations: [
        { capability: "keyword_bm25", state: "attempted-and-failed" },
      ],
      failureReason: redactDiagnostic(lexical.reason),
    };
  }
  return {
    seeds: rrfFuseEntitySeeds(
      vector.value,
      lexical.value,
      deps.config,
      deps.config.entityLinkTopK
    ),
    observations: [],
  };
}

function precisionOptions(config: RetrieveConfig): {
  k1?: number;
  b?: number;
  cjkSegmentation?: boolean;
  phrase?: boolean;
  fieldBoost?: boolean;
  fieldBoosts?: Record<string, number>;
} {
  return {
    ...(config.k1 !== undefined ? { k1: config.k1 } : {}),
    ...(config.b !== undefined ? { b: config.b } : {}),
    ...(config.cjkSegmentationEnabled !== undefined
      ? { cjkSegmentation: config.cjkSegmentationEnabled }
      : {}),
    ...(config.phraseEnabled !== undefined
      ? { phrase: config.phraseEnabled }
      : {}),
    ...(config.fieldBoostEnabled !== undefined
      ? { fieldBoost: config.fieldBoostEnabled }
      : {}),
    ...(config.fieldBoosts !== undefined
      ? { fieldBoosts: config.fieldBoosts }
      : {}),
  };
}

function withSeedStatus(result: ArmResult, seed: SeedResult): ArmResult {
  if (seed.observations.length === 0 && seed.failureReason === undefined) {
    return result;
  }
  return {
    ...result,
    observations: seed.observations,
    ...(seed.failureReason !== undefined
      ? { failureReason: seed.failureReason }
      : {}),
  };
}

/**
 * Order the chunk rows by the graph's ranking and flatten them into hits.
 *
 * A chunk usually hangs off several entities, so it inherits the position
 * of the BEST-ranked entity that reaches it: being adjacent to the most
 * relevant entity is the signal, and the runners-up must not dilute it.
 * Ties break on chunk id so two calls over the same data rank identically.
 * A row whose entity the ranking never named cannot be placed and is
 * dropped — the storage seam is allowed to be more generous than asked.
 */
function rankChunks(
  rows: readonly EntityChunkRow[],
  ranked: readonly RankedEntity[]
): ArmHit[] {
  const positions = new Map(ranked.map((entity, i) => [entity.id, i]));
  const best = new Map<string, { row: EntityChunkRow; position: number }>();
  for (const row of rows) {
    const position = positions.get(row.entity_id);
    if (position === undefined) continue;
    const previous = best.get(row.id);
    if (previous !== undefined && previous.position <= position) continue;
    best.set(row.id, { row, position });
  }
  return [...best.values()]
    .sort((a, b) => a.position - b.position || compareIds(a.row.id, b.row.id))
    .map((entry, i) => toHit(entry.row, ranked[entry.position]!.score, i));
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toHit(row: EntityChunkRow, score: number, i: number): ArmHit {
  return {
    id: row.id,
    arm: "graph",
    rank: i + 1,
    score,
    content: row.content,
    source_ref: row.source_ref,
    valid_window: [row.valid_from, row.valid_until],
  };
}

/** Degrade to an empty result carrying the failure reason. */
function degraded(err: unknown): ArmResult {
  const message = redactDiagnostic(err instanceof Error ? err.message : err);
  // Log at warn; the envelope's `degraded` flag is what the caller sees.
  writeStderr(`neo4j-graph-arm degraded: ${message}\n`);
  return {
    arm: "graph",
    hits: [],
    belowFloor: true,
    failureReason: message,
  };
}
