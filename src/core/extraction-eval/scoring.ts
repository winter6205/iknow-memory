/**
 * Three-axis scoring for the extraction-eval capability
 * (specs/p0-eval.md SC4, SC5, SC6, SC7, A1, A4).
 *
 * - SC4: micro-F1 — exact match on the pinned match key (relation_norm
 *       + case-folded head/tail), no canonical merge.
 * - SC5: schema-compliance = fraction of triples whose relation_norm is
 *       a member of the extraction vocabulary (`ALLOWED`) and not the
 *       UNMAPPED sentinel.
 * - SC6: hallucination = fraction of triples whose evidence span is
 *       not a substring of the chunk text the LLM was given.
 * - SC7: every mis-prediction is classified as exactly one of five
 *       diagnostic types — spurious / wrong-relation / wrong-entity /
 *       incomplete / schema-violation. **Never** the gate.
 *
 * Pure CPU: no I/O, no clock, no live LLM. The scorer consumes triples
 * already shaped by the extract cascade; it does NOT call
 * `normalizeRelation` itself (the relation_norm field on every input
 * triple is presumed already resolved to a vocabulary term or the
 * UNMAPPED sentinel by the upstream pipeline or the gold loader).
 */
import { ALLOWED, UNMAPPED } from "../extraction/vocabulary.js";
import { foldEntity, tripleMatchKey } from "./match-key.js";

/**
 * Minimum triple shape the scorer needs. Mirrors `ExtractionOutput`
 * with one addition (`chunkId`) needed by the hallucination grounding
 * check. The same shape is what a gold triple lifts to — see
 * `liftGoldTriple` for the GoldTriple → ScoringTriple bridge.
 */
export interface ScoringTriple {
  head: string;
  relationNorm: string;
  tail: string;
  evidenceSpan: string;
  /** Chunk the LLM was given. Required for hallucination scoring; */
  /** absent entries are treated as hallucinated (no text to ground in). */
  chunkId?: string;
}

/** The five diagnostic mis-prediction types (SC7). */
export type ErrorType =
  | "spurious"
  | "wrong-relation"
  | "wrong-entity"
  | "incomplete"
  | "schema-violation";

export interface F1Result {
  precision: number;
  recall: number;
  f1: number;
}

/** Bundle the three axes plus the diagnostic map (E-T4 baseline record). */
export interface ScoreReport {
  f1: F1Result;
  schemaRate: number;
  hallucinationRate: number;
  /** Per-triple diagnostic classification, keyed by `pred:i` or `gold:i`. */
  errors: Map<string, ErrorType>;
}

/**
 * Micro-F1 (SC4, A1): exact match on the pinned match key. No canonical
 * merge on the eval path (A8): a head or tail that differs only by an
 * inner whitespace character does NOT count as a match, and that is
 * asserted by the test suite.
 *
 * - precision = matched_pred / |pred|
 * - recall    = matched_pred / |gold|
 * - f1        = 2PR / (P + R)
 *
 * Empty-input behaviour is the natural one (all three numerics are 0):
 * a run with no predictions and no gold is "no signal", not a perfect
 * 1.0 — the gate must read it as missing data and refuse to score.
 */
export function microF1(
  gold: readonly ScoringTriple[],
  pred: readonly ScoringTriple[]
): F1Result {
  const goldKeys = new Set<string>();
  for (const g of gold) {
    goldKeys.add(keyOf(g));
  }

  let matchedPred = 0;
  for (const p of pred) {
    if (goldKeys.has(keyOf(p))) {
      matchedPred += 1;
    }
  }

  const precision = pred.length === 0 ? 0 : matchedPred / pred.length;
  const recall = gold.length === 0 ? 0 : matchedPred / gold.length;
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

/**
 * SC5: fraction of triples whose relation_norm is in `ALLOWED` and is
 * not the UNMAPPED sentinel.
 *
 * `UNMAPPED` itself and any non-vocabulary string both count as
 * schema-violations (i.e., lower schema rate). An empty prediction
 * list resolves to 1 (vacuous truth) so a snapshot with no predicted
 * triples doesn't read as a malformed run.
 */
export function schemaRate(triples: readonly ScoringTriple[]): number {
  if (triples.length === 0) return 1;
  let compliant = 0;
  for (const t of triples) {
    if (isSchemaCompliant(t.relationNorm)) {
      compliant += 1;
    }
  }
  return compliant / triples.length;
}

/**
 * SC6: fraction of triples whose evidence span is NOT a substring of
 * the chunk text the LLM was given.
 *
 * A triple with no `chunkId`, or whose chunk id is not in the map, is
 * counted as hallucinated: a span the eval cannot ground is a span it
 * cannot trust.
 */
export function hallucinationRate(
  triples: readonly ScoringTriple[],
  chunkTextById: ReadonlyMap<string, string>
): number {
  if (triples.length === 0) return 0;
  let hallucinated = 0;
  for (const t of triples) {
    const text =
      t.chunkId === undefined ? undefined : chunkTextById.get(t.chunkId);
    if (text === undefined || !text.includes(t.evidenceSpan)) {
      hallucinated += 1;
    }
  }
  return hallucinated / triples.length;
}

/**
 * SC7: per-triple diagnostic classification. Each mis-prediction gets
 * exactly one of the five types. Matched triples are absent from the
 * map (no error to report).
 *
 * Per-pred-triple precedence:
 *   1. schema-violation: relation_norm is not in ALLOWED (incl. UNMAPPED).
 *   2. exact match on the pinned key → no error.
 *   3. head+tail match a gold but relation differs → wrong-relation.
 *   4. relation matches a gold but head or tail differs → wrong-entity.
 *   5. else → spurious.
 *
 * Gold side: every gold triple not exactly matched by any pred is
 * incomplete (or schema-violation if its relation is not in ALLOWED).
 *
 * Keys are `pred:${i}` for the prediction side and `gold:${i}` for the
 * gold side, so a pred and a gold with the same match key cannot
 * collide in the diagnostic map.
 */
export function errorTypes(
  gold: readonly ScoringTriple[],
  pred: readonly ScoringTriple[]
): Map<string, ErrorType> {
  const errors = new Map<string, ErrorType>();

  // Index gold by match key, by head+tail, and by relation so the
  // classifier does each lookup in O(1) instead of scanning.
  const goldByKey = new Map<string, number[]>();
  const goldByHeadTail = new Map<string, number[]>();
  const goldByRelation = new Map<string, number[]>();
  for (let i = 0; i < gold.length; i += 1) {
    const g = gold[i]!;
    appendIndex(goldByKey, keyOf(g), i);
    appendIndex(goldByHeadTail, headTailKey(g), i);
    appendIndex(goldByRelation, g.relationNorm, i);
  }

  const exactlyMatchedGold = new Set<number>();
  for (let i = 0; i < pred.length; i += 1) {
    const p = pred[i]!;

    if (!isSchemaCompliant(p.relationNorm)) {
      errors.set(`pred:${i}`, "schema-violation");
      continue;
    }

    const key = keyOf(p);
    const matched = goldByKey.get(key);
    if (matched !== undefined) {
      // Only the first gold index is "claimed" by this exact match —
      // duplicate exact-match keys in gold are a gold-side anomaly
      // out of scope for diagnostic classification.
      exactlyMatchedGold.add(matched[0]!);
      continue;
    }

    if (goldByHeadTail.has(headTailKey(p))) {
      errors.set(`pred:${i}`, "wrong-relation");
      continue;
    }

    if (goldByRelation.has(p.relationNorm)) {
      errors.set(`pred:${i}`, "wrong-entity");
      continue;
    }

    errors.set(`pred:${i}`, "spurious");
  }

  for (let i = 0; i < gold.length; i += 1) {
    if (exactlyMatchedGold.has(i)) continue;
    const g = gold[i]!;
    if (!isSchemaCompliant(g.relationNorm)) {
      errors.set(`gold:${i}`, "schema-violation");
      continue;
    }
    errors.set(`gold:${i}`, "incomplete");
  }

  return errors;
}

/** Convenience: bundle the three axes plus the diagnostic map. */
export function score(
  gold: readonly ScoringTriple[],
  pred: readonly ScoringTriple[],
  chunkTextById: ReadonlyMap<string, string>
): ScoreReport {
  return {
    f1: microF1(gold, pred),
    schemaRate: schemaRate(pred),
    hallucinationRate: hallucinationRate(pred, chunkTextById),
    errors: errorTypes(gold, pred),
  };
}

/* ------------------------------------------------------------------------ */
/* Internal helpers                                                          */
/* ------------------------------------------------------------------------ */

function keyOf(t: {
  head: string;
  relationNorm: string;
  tail: string;
}): string {
  return tripleMatchKey({
    head: t.head,
    relation_norm: t.relationNorm,
    tail: t.tail,
  });
}

function headTailKey(t: { head: string; tail: string }): string {
  return `${foldEntity(t.head)}${foldEntity(t.tail)}`;
}

function isSchemaCompliant(relation: string): boolean {
  return relation !== UNMAPPED && ALLOWED.includes(relation);
}

function appendIndex(
  map: Map<string, number[]>,
  key: string,
  index: number
): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [index]);
    return;
  }
  list.push(index);
}
