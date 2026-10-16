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
import { GraphragError } from "../errors.js";
import { createLogger } from "../../logging.js";
import {
  DEFAULT_MERGE_CONFIG,
  type GrayZoneJudge,
  type GrayZoneLog,
  type GrayZoneVerdict,
  type MergeConfig,
  type MergeDecision,
} from "./types.js";
import { computeEntityEmbeddingText } from "./embedding.js";
import { MergeBudgetError } from "./merge-budget.js";

export type {
  MergeConfig,
  MergeDecision,
  GrayZoneLog,
  GrayZoneJudge,
  GrayZoneJudgeInput,
  GrayZoneVerdict,
} from "./types.js";

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
  /**
   * Optional three-level judge consulted ONLY after an L3 gray-zone reject
   * would be logged. Absent → the gate behaves exactly as before (the
   * reject stands).
   */
  judgeGrayZone?: GrayZoneJudge;
}

export type MergeOutcome = {
  canonicalId: string;
  decision: MergeDecision | "created-new";
};

/**
 * Fired when a caller passes `candidateSet: "all"`.
 *
 * The `"all" | CandidateEntity[]` shape stays reserved (#6 Q6), but the
 * blocking-subset loader behind `"all"` is not wired in P0. Treating it as an
 * empty candidate set would silently answer `created-new` for every call —
 * a duplicate entity per extraction — so the call is refused instead.
 */
export class CandidateSetNotWiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateSetNotWiredError";
  }
}

/** Lowercase + trim + collapse internal whitespace (used by L0). */
export function normalizeAlias(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Merge the incoming entity against the candidate set.
 *
 * The caller owns persistence and UUID generation: when no gate merges, the
 * function returns `{ decision: "created-new" }` and the orchestrator writes
 * a fresh row with a new UUID. `candidateSet` accepts an explicit array (the
 * caller fetches the candidates) or `"all"` — the reserved blocking-subset
 * shape (#6 Q6), which throws `CandidateSetNotWiredError` in P0.
 */
export async function mergeEntitiesWithGating(
  incoming: IncomingEntity,
  candidateSet: "all" | CandidateEntity[],
  ctx: MergeContext
): Promise<MergeOutcome> {
  if (candidateSet === "all") {
    throw new CandidateSetNotWiredError(
      'mergeEntitiesWithGating: candidateSet "all" needs the blocking-subset ' +
        "loader, which is not wired in P0 — pass an explicit candidate array."
    );
  }
  const config = ctx.config ?? DEFAULT_MERGE_CONFIG;
  const candidates = candidateSet.map((c) => ({ ...c }));
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
 *
 * The incoming entity is embedded once for the whole comparison batch and
 * each candidate contributes its stored `embedding` when it has one, so a
 * batch costs one embed plus one per candidate that lacks a persisted vector.
 */
async function l3NameDescGate(
  incoming: IncomingEntity,
  candidates: CandidateEntity[],
  ctx: MergeContext,
  config: MergeConfig,
  log: GrayLogFn
): Promise<GateOutcome | null> {
  const incomingVector = await embedOne(
    ctx.embedder,
    computeEntityEmbeddingText(incoming.canonicalName, incoming.description)
  );
  let lastGray: GrayPair | null = null;
  for (const c of candidates) {
    const observed = await l3Cosine(ctx.embedder, c, incomingVector);
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
    lastGray = { candidate: c, observedCosine: observed, reason: gray };
  }
  if (!lastGray) return null;
  // The judge guards the gray-zone REJECT PATH, not individual below-floor
  // pairs: it is consulted once the gate has actually settled on a reject,
  // so a pair it would have merged is never judged.
  if (ctx.judgeGrayZone) {
    const judged = await judgeGrayPair(ctx.judgeGrayZone, log, incoming, lastGray);
    if (judged) return { id: lastGray.candidate.id, decision: judged };
  }
  return grayRejectOutcome(lastGray);
}

/** The pair an L3 pass ended on when no candidate cleared the floor. */
interface GrayPair {
  candidate: CandidateEntity;
  observedCosine: number;
  reason: string;
}

function grayRejectOutcome(pair: GrayPair): GateOutcome {
  return {
    id: pair.candidate.id,
    decision: {
      kind: "reject",
      reason: pair.reason,
      level: "L3",
      observedCosine: pair.observedCosine,
    },
  };
}

/**
 * Ask the three-level judge about the pair the L3 gate rejected into the
 * gray zone. A `merge` / `human` verdict upgrades that reject into an L3
 * merge or an operator hold; a `reject` verdict — or a judge that is down
 * (ANY thrown error) — returns null so the gray-zone reject stands. The
 * gray-zone log is emitted by the caller BEFORE this call, and a judge-down
 * adds its own `judge-down` entry so an outage is auditable rather than
 * indistinguishable from a `reject` verdict.
 */
async function judgeGrayPair(
  judge: GrayZoneJudge,
  log: GrayLogFn,
  incoming: IncomingEntity,
  pair: GrayPair
): Promise<MergeDecision | null> {
  let verdict: GrayZoneVerdict;
  try {
    verdict = await judge({
      incoming: {
        name: incoming.canonicalName,
        type: incoming.type,
        description: incoming.description,
      },
      candidate: {
        name: pair.candidate.canonicalName,
        type: pair.candidate.type,
        description: pair.candidate.description,
      },
      observedCosine: pair.observedCosine,
    });
  } catch {
    // Judge-down == no opinion: the standing gray reject is the answer,
    // but the outage itself must leave a trace.
    log({ level: "L3", observedCosine: pair.observedCosine, reason: JUDGE_DOWN_REASON });
    return null;
  }
  if (verdict === "merge") {
    return {
      kind: "merge",
      into: pair.candidate.id,
      via: "L3",
      observedCosine: pair.observedCosine,
    };
  }
  if (verdict === "human") {
    return { kind: "hold", level: "L3", observedCosine: pair.observedCosine };
  }
  return null;
}

/**
 * The two failure classes the gates can read as "this cosine is unprovable":
 * every production embedder failure leg throws `GraphragError`, and
 * `cosineSimilarity` throws `RangeError` on a dimension mismatch. Anything
 * else is an unexpected fault, and a skipped candidate would hide it behind a
 * plausible-looking `created-new`, so it propagates to the caller instead.
 *
 * A budget refusal is explicitly NOT an embed failure (ADR-0013): swallowing it
 * would report a cost refusal as a skipped candidate and run the lifecycle to
 * the end with the cap already spent.
 */
function isUnprovableEmbed(err: unknown): boolean {
  if (err instanceof MergeBudgetError) return false;
  return err instanceof GraphragError;
}

function isDimensionMismatch(err: unknown): boolean {
  return err instanceof RangeError;
}

/**
 * Cosine between one candidate and the already-embedded incoming entity.
 *
 * Reuses `candidate.embedding` when the loader supplied one; otherwise embeds
 * the candidate's `name | description` text. Returns `null` whenever the
 * cosine cannot be proven — the incoming embed failed, the candidate embed
 * failed, or a stored vector's dimension disagrees with the live embedder —
 * so the caller skips that candidate exactly as it does for an embed failure.
 */
async function l3Cosine(
  embedder: Embedder,
  candidate: CandidateEntity,
  incomingVector: number[] | null
): Promise<number | null> {
  if (incomingVector === null) return null;
  const candidateVector =
    candidate.embedding ??
    (await embedOne(
      embedder,
      computeEntityEmbeddingText(candidate.canonicalName, candidate.description)
    ));
  if (candidateVector === null) return null;
  try {
    return cosineSimilarity(candidateVector, incomingVector);
  } catch (err) {
    if (isDimensionMismatch(err)) return null;
    throw err;
  }
}

/**
 * Embed a single text, or `null` when the embedder reports an embedding
 * failure or returns nothing. Any other error class propagates.
 */
async function embedOne(
  embedder: Embedder,
  text: string
): Promise<number[] | null> {
  try {
    const [vector] = await embedder.embed([text]);
    return vector ?? null;
  } catch (err) {
    if (isUnprovableEmbed(err)) return null;
    throw err;
  }
}

/** Gray-zone reason logged when the embedder throws (boundary-class fix). */
const EMBED_FAILURE_REASON = "embed-failure";

/** Gray-zone reason logged when the gray-zone judge itself is down. */
const JUDGE_DOWN_REASON = "judge-down";

/**
 * Embed two texts and return their cosine similarity, or `null` when the
 * embedder reports an embedding failure or the two vectors disagree on
 * dimension.
 *
 * T8 boundary-class fix: a failing embedder must not abort merge evaluation;
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
  } catch (err) {
    if (isUnprovableEmbed(err) || isDimensionMismatch(err)) return null;
    throw err;
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
