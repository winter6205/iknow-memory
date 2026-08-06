/**
 * Canonical entity merge — hierarchical gates L0/L1/L2/L3 (per #6 Q2/Q3).
 *
 * Rule + embedding hybrid: L0 is a pure rule (normalized-name + type exact),
 * L1 a type gate, L2/L3 embedding comparisons. The four gates are sequential
 * branches, not nested ifs (spec Code Style), each delegated to a named
 * helper so the file stays within the complexity envelope.
 *
 * Every rejection at L1/L2/L3 emits a structured gray-zone log entry (per
 * #6 Q5) — auditability of a "no-merge" is as important as the merge itself.
 */

import { cosineSimilarity } from "../cosine.js";
import type { EmbeddingClient } from "../embedder.js";
import { createLogger } from "../../logging.js";
import {
  DEFAULT_MERGE_CONFIG,
  type GrayZoneLog,
  type MergeConfig,
  type MergeDecision,
} from "./types.js";
import { computeEntityEmbeddingText } from "./embedding.js";

export type { MergeConfig, MergeDecision, GrayZoneLog } from "./types.js";

/** Alias the spec's `Embedder` name onto the existing embedding contract. */
export type Embedder = EmbeddingClient;

export interface IncomingEntity {
  canonicalName: string;
  type: string;
  description: string;
}

export interface CandidateEntity {
  id: string;
  canonicalName: string;
  type: string;
  description: string;
  embedding?: number[];
}

export interface MergeContext {
  embedder: Embedder;
  config?: MergeConfig;
  /** Structured gray-zone sink; defaults to the project logger (stderr). */
  logGrayZone?: (entry: GrayZoneLog) => void;
}

export type MergeOutcome = {
  canonicalId: string;
  decision: MergeDecision | "created-new";
};

/** Lowercase + trim + collapse internal whitespace (used by L0). */
export function normalizeAlias(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Merge the incoming entity against the candidate set.
 *
 * The caller owns persistence and UUID generation: when no gate merges, the
 * function returns `{ decision: "created-new" }` and the orchestrator writes
 * a fresh row with a new UUID. `candidateSet` accepts `"all"` (the caller
 * fetches the full entity table) or an explicit array (reserved blocking
 * subset, #6 Q6).
 */
export async function mergeEntitiesWithGating(
  incoming: IncomingEntity,
  candidateSet: "all" | CandidateEntity[],
  ctx: MergeContext
): Promise<MergeOutcome> {
  const config = ctx.config ?? DEFAULT_MERGE_CONFIG;
  const candidates =
    candidateSet === "all" ? [] : candidateSet.map((c) => ({ ...c }));
  const log = ctx.logGrayZone ?? defaultGrayLog;

  const l0 = l0Match(incoming, candidates);
  if (l0) return { canonicalId: l0.id, decision: l0.decision };

  const l1 = l1TypeReject(incoming, candidates, log);
  if (l1) return { canonicalId: l1.id, decision: l1.decision };

  // L2/L3 operate on same-type candidates that L0's exact-name rule missed
  // (name variants). L0 already merged exact name+type, so any remaining
  // same-type candidate is a fuzzy-name candidate for the embedding gates.
  const sameType = candidates.filter((c) => c.type === incoming.type);
  if (sameType.length === 0) {
    return { canonicalId: "", decision: "created-new" };
  }

  const l2 = await l2DescGate(incoming, sameType, ctx, config, log);
  if (l2) return { canonicalId: l2.id, decision: l2.decision };

  const l3 = await l3NameDescGate(incoming, sameType, ctx, config, log);
  if (l3) return { canonicalId: l3.id, decision: l3.decision };

  return { canonicalId: "", decision: "created-new" };
}

interface GateOutcome {
  id: string;
  decision: MergeDecision;
}

function l0Match(
  incoming: IncomingEntity,
  candidates: CandidateEntity[]
): GateOutcome | null {
  const name = normalizeAlias(incoming.canonicalName);
  const hit = candidates.find(
    (c) => normalizeAlias(c.canonicalName) === name && c.type === incoming.type
  );
  if (!hit) return null;
  return {
    id: hit.id,
    // L0 is a rule-exact match on name + type; cosine is definitionally 1.
    decision: { kind: "merge", into: hit.id, via: "L0", observedCosine: 1.0 },
  };
}

/**
 * L1: same normalized name, different type → reject ALL such candidates.
 * A single incoming entity cannot be two types; the type gate is a hard no.
 */
function l1TypeReject(
  incoming: IncomingEntity,
  candidates: CandidateEntity[],
  log: GrayLogFn
): GateOutcome | null {
  const name = normalizeAlias(incoming.canonicalName);
  const conflicts = candidates.filter(
    (c) => normalizeAlias(c.canonicalName) === name && c.type !== incoming.type
  );
  if (conflicts.length === 0) return null;
  for (const c of conflicts) {
    log({ level: "L1", reason: "type-mismatch" });
    void c;
  }
  return {
    id: conflicts[0]!.id,
    decision: { kind: "reject", reason: "type-mismatch", level: "L1" },
  };
}

type GrayLogFn = (entry: GrayZoneLog) => void;

/**
 * L2: description-cosine floor. A candidate or incoming description shorter
 * than `minDescriptionLength` skips L2 (insufficient description signal) and
 * proceeds straight to L3 (per T1 resolution #3).
 */
async function l2DescGate(
  incoming: IncomingEntity,
  candidates: CandidateEntity[],
  ctx: MergeContext,
  config: MergeConfig,
  log: GrayLogFn
): Promise<GateOutcome | null> {
  for (const c of candidates) {
    if (c.description.length < config.minDescriptionLength) continue;
    if (incoming.description.length < config.minDescriptionLength) continue;
    const observed = await embedCosine(
      ctx.embedder,
      c.description,
      incoming.description
    );
    if (observed === null) {
      // T8 boundary-class fix: cannot prove merge → skip candidate, do not
      // synthesize a false cosine.
      log({ level: "L2", reason: EMBED_FAILURE_REASON });
      continue;
    }
    if (observed < config.l2DescLowThreshold) {
      log({
        level: "L2",
        observedCosine: observed,
        reason: "desc-below-floor",
      });
      return {
        id: c.id,
        decision: {
          kind: "reject",
          reason: "desc-below-floor",
          level: "L2",
          observedCosine: observed,
        },
      };
    }
  }
  return null;
}

/**
 * L3: name+description cosine against the mid threshold. Single-floor mode
 * (default) merges at/above the high threshold and rejects (gray zone) below;
 * band mode also rejects below the low threshold, leaving the middle band as
 * the gray zone. First candidate at/above threshold wins the merge.
 */
async function l3NameDescGate(
  incoming: IncomingEntity,
  candidates: CandidateEntity[],
  ctx: MergeContext,
  config: MergeConfig,
  log: GrayLogFn
): Promise<GateOutcome | null> {
  let lastReject: GateOutcome | null = null;
  for (const c of candidates) {
    const observed = await embedCosine(
      ctx.embedder,
      computeEntityEmbeddingText(c.canonicalName, c.description),
      computeEntityEmbeddingText(incoming.canonicalName, incoming.description)
    );
    if (observed === null) {
      // T8 boundary-class fix: cannot prove merge → skip candidate.
      log({ level: "L3", reason: EMBED_FAILURE_REASON });
      continue;
    }
    if (observed >= config.l3NameDescHighThreshold) {
      return {
        id: c.id,
        decision: {
          kind: "merge",
          into: c.id,
          via: "L3",
          observedCosine: observed,
        },
      };
    }
    const gray =
      config.bandMode && observed < config.l3NameDescLowThreshold
        ? "below-low-band"
        : "gray-zone-below-mid";
    log({ level: "L3", observedCosine: observed, reason: gray });
    lastReject = {
      id: c.id,
      decision: {
        kind: "reject",
        reason: gray,
        level: "L3",
        observedCosine: observed,
      },
    };
  }
  return lastReject;
}

/** Gray-zone reason logged when the embedder throws (boundary-class fix). */
const EMBED_FAILURE_REASON = "embed-failure";

/**
 * Embed two texts and return their cosine similarity, or `null` when the
 * embedder throws.
 *
 * T8 boundary-class fix: a throwing embedder must not abort merge evaluation;
 * inability to compute cosine → no merge proof → the gate skips that candidate
 * rather than rejecting/merging on a fabricated value. If every candidate is
 * skipped, the merge loop falls through to `created-new`. The failure is
 * logged as a gray-zone entry by the caller.
 */
async function embedCosine(
  embedder: Embedder,
  a: string,
  b: string
): Promise<number | null> {
  try {
    const [va, vb] = await embedder.embed([a, b]);
    return cosineSimilarity(va, vb);
  } catch {
    return null;
  }
}

/** Default gray-zone sink: project logger to stderr. */
const defaultGrayLog: GrayLogFn = (entry) => {
  createLogger("info").warn("entity-merge-gray-zone", {
    level: entry.level,
    reason: entry.reason,
    observedCosine: entry.observedCosine,
  });
};
