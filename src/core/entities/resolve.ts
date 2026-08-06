/**
 * Canonical-entity resolution — walks the `merged_into` soft-merge chain to
 * the root entity id (per #6 Q2, soft merge + rollback).
 *
 * `merged_into` is a nullable FK (ON DELETE SET NULL), so a normalised chain
 * may be truncated when a survivor is deleted; resolution must still terminate.
 */

import { createLogger } from "../../logging.js";
import { DEFAULT_MERGE_CONFIG, type MergeConfig } from "./types.js";

const logger = createLogger("info");

/** Graph-query contract accepted by both `pg.Pool` and `pg.PoolClient`. */
export interface Queryable {
  query: (text: string, values: unknown[]) => Promise<{ rows: any[] }>;
}

/**
 * Fired when the chain walk exceeds a hard safety cap. Distinct from the
 * graceful depth-limit return so callers (T8 defensive) can assert on the
 * exceedance rather than an infinite loop.
 */
export class ResolveCycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolveCycleError";
  }
}

/** Hard ceiling on visited nodes before we throw ResolveCycleError. */
const HARD_CAP = 64;

/**
 * Resolve an entity id to its canonical root id.
 *
 * Follows `merged_into` up to `config.maxChainDepth` hops. Cycle detection via
 * a visited set: a revisit is a broken invariant, so the chain is corrupt;
 * we return the input id gracefully (the caller keeps a usable id). Only
 * when the visited set balloons past HARD_CAP do we throw, to catch a
 * runaway walk that cycle detection alone would mask.
 */
export async function resolveCanonicalId(
  client: Queryable,
  id: string,
  config: MergeConfig = DEFAULT_MERGE_CONFIG
): Promise<string> {
  let current = id;
  const visited = new Set<string>([id]);
  for (let depth = 0; depth < config.maxChainDepth; depth += 1) {
    const { rows } = await client.query(
      "SELECT merged_into FROM entities WHERE id = $1",
      [current]
    );
    const next = rows[0]?.merged_into as string | null | undefined;
    if (!next) return current;
    if (visited.has(next)) {
      logger.warn("entity-resolve-cycle", { id, current, next });
      return id;
    }
    visited.add(next);
    current = next;
    if (visited.size > HARD_CAP) {
      throw new ResolveCycleError(
        `resolveCanonicalId: chain grew beyond ${HARD_CAP} nodes from ${id}`
      );
    }
  }
  logger.warn("entity-resolve-depth-limit", {
    id,
    current,
    maxDepth: config.maxChainDepth,
  });
  return current;
}
