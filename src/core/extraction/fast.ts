/**
 * Fast extract method (graph-index-standard-fast T4) — pure NLP, zero LLM.
 *
 * The three steps the joint spec names for the Fast leg
 * (specs/graph-index-standard-fast.md assumptions 4–6; ADR 0076/0077/0073):
 *
 *   1. Mixed Chinese/English noun-phrase regex (ADR-0076): Chinese CJK runs
 *      split on function-word characters, English Latin letter/digit tokens
 *      (hyphenated technical forms kept whole); both sides drop stopwords,
 *      normalize through `normalizeAlias`, and pair by first occurrence.
 *      The product default is NOT English-only — Chinese-only 资料 must
 *      yield terms too (SC4), and a Chinese chunk whose fast graph ends up
 *      empty is a typed job fail (`FAST_EMPTY_GRAPH`), never a silent zero.
 *   2. Child co-occurrence (ADR-0077): the pushed chunk row IS one in-window
 *      child (a fin cut slice, CONTEXT "chunk"); every distinct term pair
 *      sharing that child forms one edge. No second token slide or
 *      50–100-token re-cut is invented here (ADR-0004). The edge weight
 *      starts as the co-occurrence COUNT: the number of the child's
 *      sentences carrying both terms (0 = they only share the child);
 *      sentences exist to weight and evidence an edge already keyed by the
 *      child, not to replace the child key.
 *   3. Prune before Leiden, fast only (ADR-0073): the PMI-style score
 *      log2(w·S / (s_head·s_tail)) over the child's sentence statistics
 *      ranks chance pairs of frequent terms below pairs that actually
 *      travel together; `pruneFastEdges` drops edges strictly under the
 *      weakPercentile (default 40th) of THIS edge set, then removes
 *      endpoints below minDegree to a fixed point. Thresholds are
 *      index-job config (`FastPruneOptions`), not frozen product
 *      constants, and the standard leg never calls this module.
 *
 * Determinism: every function is pure over its text input — no clock, no
 * randomness, no network — and the module takes no LLM client at all, so
 * the fast dispatch leg in method.ts cannot dial a model even by accident.
 *
 * Confidence mapping: `weight / (weight + 1)` keeps the [0,1] contract of
 * `ExtractionOutput.confidence` while the count stays monotone in it.
 * Triples persisted from these outputs carry `extractor: "fast"` so the
 * ledger records which method produced the edge (persist.ts threads the tag
 * into `triples.extractor`).
 */
import { normalizeAlias } from "../entities/merge.js";
import { EMPTY_CHUNK_CODE, type ChunkInput, type ExtractionOutcome } from "./extract.js";
import type { ExtractionOutput } from "./types.js";

/** Typed job-fail code: empty Fast graph on Chinese 资料 (spec SC4). */
export const FAST_EMPTY_GRAPH_CODE = "FAST_EMPTY_GRAPH";
/** Raw relation spelling for every co-occurrence edge (audit trail). */
export const FAST_RELATION_RAW = "co_occurs_with";
/** Vocabulary-normalized relation; a frozen ALLOWED member. */
export const FAST_RELATION_NORM = "related_to";
/** Provenance tag written into `triples.extractor` by the fast path. */
export const FAST_EXTRACTOR_TAG = "fast";
/** ADR-0073 default: weak = below the 40th percentile of the edge set. */
export const FAST_DEFAULT_WEAK_PERCENTILE = 40;
/** Endpoints below this degree are rare specks; 1 keeps every survivor. */
export const FAST_DEFAULT_MIN_DEGREE = 1;
/** Entity type for fast nodes: unclassified surface terms are concepts. */
const FAST_ENTITY_TYPE = "concept";

/** One co-occurrence edge candidate keyed by the shared child (ADR-0077). */
export interface FastCooccurrenceEdge {
  /** Normalized term that occurred first in the child. */
  head: string;
  /** Normalized term that occurred later in the child. */
  tail: string;
  /** Sentences of the child containing BOTH terms (0 = child-only share). */
  weight: number;
  /** Sentences of the child containing `head` (PMI marginal). */
  headCount: number;
  /** Sentences of the child containing `tail` (PMI marginal). */
  tailCount: number;
  /** Sentences scanned in the child (PMI window). */
  window: number;
  /** Grounded substring evidencing the edge: first joint sentence, else child. */
  evidence: string;
}

/** Prune thresholds — index-job config per ADR-0073. */
export interface FastPruneOptions {
  /** Drop edges under this percentile of the set's PMI scores [0,100]. */
  weakPercentile?: number;
  /** Drop edges whose endpoints fall below this degree (fixed point). */
  minDegree?: number;
}

/** One normalized term with its in-child occurrence count. */
export interface FastTerm {
  term: string;
  occurrences: number;
}

// ─── term regex (ADR-0076) ─────────────────────────────────────────────────

/** CJK ideograph runs (Unified + Ext-A): the Chinese side of a mixed chunk. */
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]+/gu;
/** Latin tokens: letters leading, digits/hyphen/underscore inside. */
const LATIN_TOKEN_RE = /[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*/g;
/** A term is at least this long (single letters and function words die). */
const MIN_TERM_LENGTH = 2;
/** Longer unsegmented Chinese runs are clause noise, not noun phrases. */
const MAX_CJK_TERM_LENGTH = 8;

/** Conservative Chinese function-word chars: run separators, never terms. */
const CJK_STOP_CHARS = new Set([
  "的", "了", "和", "与", "是", "在", "等", "及", "或", "被", "把", "于",
  "对", "从", "至", "也", "都", "而", "所", "以", "将", "给", "让", "向",
  "由", "之", "其", "啊", "吗", "呢", "吧",
]);

/** Small, defensible English stopword set (v1 heuristic, like the CJK one). */
const ENGLISH_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "by", "for",
  "with", "from", "as", "that", "this", "these", "those", "it", "its", "is",
  "are", "was", "were", "be", "been", "being", "has", "have", "had", "do",
  "does", "did", "will", "would", "shall", "should", "can", "could", "may",
  "might", "must", "not", "no", "but", "if", "then", "than", "there", "here",
  "they", "them", "their", "we", "our", "you", "your", "he", "she", "his",
  "her", "him", "my", "me", "which", "who", "whom", "whose", "where", "when",
  "how", "what", "why", "all", "any", "both", "each", "few", "more", "most",
  "other", "some", "such", "too", "very", "just", "now", "also", "so",
]);

/** True when the text carries any CJK ideograph (Chinese 资料 detector). */
export function containsCjk(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff]/u.test(text);
}

/**
 * Mixed zh/en noun-phrase terms of one child, normalized and ordered by
 * first occurrence. `occurrences` counts every match of the term.
 */
export function extractFastTerms(text: string): FastTerm[] {
  const hits = new Map<string, { occurrences: number; firstIndex: number }>();
  const record = (raw: string, index: number): void => {
    const term = normalizeAlias(raw);
    const hit = hits.get(term);
    if (hit) hit.occurrences += 1;
    else hits.set(term, { occurrences: 1, firstIndex: index });
  };
  for (const match of text.matchAll(LATIN_TOKEN_RE)) {
    const token = match[0];
    if (token.length < MIN_TERM_LENGTH) continue;
    if (ENGLISH_STOPWORDS.has(token.toLowerCase())) continue;
    record(token, match.index);
  }
  for (const match of text.matchAll(CJK_RUN_RE)) {
    const run = match[0];
    for (const { segment, offset } of segmentCjkRun(run)) {
      if (segment.length < MIN_TERM_LENGTH) continue;
      if (segment.length > MAX_CJK_TERM_LENGTH) continue;
      record(segment, match.index + offset);
    }
  }
  return [...hits.entries()]
    .sort((a, b) => a[1].firstIndex - b[1].firstIndex)
    .map(([term, hit]) => ({ term, occurrences: hit.occurrences }));
}

/** Split one CJK run on stop chars, keeping each segment's run offset. */
function segmentCjkRun(
  run: string
): Array<{ segment: string; offset: number }> {
  const segments: Array<{ segment: string; offset: number }> = [];
  let start = 0;
  for (let i = 0; i < run.length; i += 1) {
    if (!CJK_STOP_CHARS.has(run[i]!)) continue;
    if (i > start) segments.push({ segment: run.slice(start, i), offset: start });
    start = i + 1;
  }
  if (start < run.length) {
    segments.push({ segment: run.slice(start), offset: start });
  }
  return segments;
}

// ─── child co-occurrence (ADR-0077) ───────────────────────────────────────

/**
 * Sentence separators inside one child. ASCII "." is NOT a separator:
 * "Corp." / version strings would shred; the child stays the edge key, so
 * this split only weights and evidences edges (see file header).
 */
const SENTENCE_SEPARATOR_RE = /[。！？；!?;\n]+/;

/** All unordered distinct-term pairs of the child, weighted by joint count. */
export function buildCoOccurrenceEdges(
  text: string
): FastCooccurrenceEdge[] {
  const terms = extractFastTerms(text);
  if (terms.length < 2) return [];
  const sentences = splitSentences(text);
  const lowered = sentences.map((s) => s.toLowerCase());
  const wholeChild = text.trim();
  const edges: FastCooccurrenceEdge[] = [];
  for (let i = 0; i < terms.length; i += 1) {
    for (let j = i + 1; j < terms.length; j += 1) {
      const head = terms[i]!.term;
      const tail = terms[j]!.term;
      let weight = 0;
      let evidence = "";
      for (let s = 0; s < lowered.length; s += 1) {
        const sentence = lowered[s]!;
        if (!termInSentence(sentence, head)) continue;
        if (!termInSentence(sentence, tail)) continue;
        weight += 1;
        if (evidence.length === 0) evidence = sentences[s]!;
      }
      edges.push({
        head,
        tail,
        weight,
        headCount: countSentences(lowered, head),
        tailCount: countSentences(lowered, tail),
        window: Math.max(1, sentences.length),
        // Pairs that only share the child are still edges (ADR-0077); the
        // whole child is then their only grounded evidence.
        evidence: evidence.length > 0 ? evidence : wholeChild,
      });
    }
  }
  return edges;
}

/** Sentence pieces of a child: trimmed, non-empty, separator order kept. */
function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_SEPARATOR_RE)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Whole-token membership of a normalized Latin term inside a lowercased
 * sentence; CJK terms match by substring (no word boundaries exist there).
 * Without the guard, "carbon" would count as a "car" sighting and fake
 * joint weights.
 */
function termInSentence(sentence: string, term: string): boolean {
  if (/^[a-z0-9][a-z0-9_-]*$/.test(term)) {
    const re = new RegExp(
      `(^|[^a-z0-9_-])${escapeRegExp(term)}([^a-z0-9_-]|$)`
    );
    return re.test(sentence);
  }
  return sentence.includes(term);
}

function countSentences(loweredSentences: string[], term: string): number {
  let count = 0;
  for (const sentence of loweredSentences) {
    if (termInSentence(sentence, term)) count += 1;
  }
  return count;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── PMI score + prune (ADR-0073, fast only) ──────────────────────────────

/** An edge plus its PMI-style score over the given edge set. */
export type FastScoredEdge = FastCooccurrenceEdge & { pmi: number };

/**
 * log2(P(head,tail) / (P(head)·P(tail))) in sentence-frequency space of the
 * child: chance pairs of frequent terms rank below rare pairs that actually
 * travel together. A never-traveled pair (weight 0) scores negative
 * infinity — below every finite edge, and tied with its own family.
 */
export function scoreFastEdges(
  edges: readonly FastCooccurrenceEdge[]
): FastScoredEdge[] {
  return edges.map((edge) => {
    if (edge.weight <= 0) return { ...edge, pmi: Number.NEGATIVE_INFINITY };
    const pmi = Math.log2(
      (edge.weight * edge.window) /
        (Math.max(1, edge.headCount) * Math.max(1, edge.tailCount))
    );
    return { ...edge, pmi };
  });
}

/**
 * The fast-only prune (the standard leg never calls this): drop edges
 * strictly under the weakPercentile (rank = floor(q/100·n) of the
 * ascending PMI scores, so ties at the threshold survive), then remove
 * low-degree endpoints to a fixed point.
 */
export function pruneFastEdges(
  edges: readonly FastCooccurrenceEdge[],
  opts: FastPruneOptions = {}
): FastCooccurrenceEdge[] {
  if (edges.length === 0) return [];
  const percentile = clamp(opts.weakPercentile ?? FAST_DEFAULT_WEAK_PERCENTILE, 0, 100);
  const minDegree = Math.max(1, Math.trunc(opts.minDegree ?? FAST_DEFAULT_MIN_DEGREE));
  const scored = scoreFastEdges(edges);
  const sorted = scored.map((edge) => edge.pmi).sort((a, b) => a - b);
  const rank = Math.min(
    sorted.length - 1,
    Math.floor((percentile / 100) * sorted.length)
  );
  const threshold = sorted[rank]!;
  let kept = scored.filter((edge) => edge.pmi >= threshold);
  kept = dropRareNodes(kept, minDegree);
  return kept.map(unscored);
}

/** Remove edges touching a node below `minDegree`, repeatedly (fixed point). */
function dropRareNodes(
  edges: FastScoredEdge[],
  minDegree: number
): FastScoredEdge[] {
  if (minDegree <= 1) return edges;
  let kept = edges;
  for (;;) {
    const degree = new Map<string, number>();
    for (const edge of kept) {
      degree.set(edge.head, (degree.get(edge.head) ?? 0) + 1);
      degree.set(edge.tail, (degree.get(edge.tail) ?? 0) + 1);
    }
    const next = kept.filter(
      (edge) =>
        (degree.get(edge.head) ?? 0) >= minDegree &&
        (degree.get(edge.tail) ?? 0) >= minDegree
    );
    if (next.length === kept.length) return next;
    kept = next;
  }
}

/** Strip the score back down to the persisted-edge shape. */
function unscored(edge: FastScoredEdge): FastCooccurrenceEdge {
  return {
    head: edge.head,
    tail: edge.tail,
    weight: edge.weight,
    headCount: edge.headCount,
    tailCount: edge.tailCount,
    window: edge.window,
    evidence: edge.evidence,
  };
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return value < 0 ? lo : hi;
  return Math.min(hi, Math.max(lo, value));
}

// ─── chunk outcome (the sealed union the seam consumes) ───────────────────

/** One pruned fast edge as a canonical `ExtractionOutput` triple. */
export function fastEdgeToOutput(edge: FastCooccurrenceEdge): ExtractionOutput {
  return {
    head: edge.head,
    headType: FAST_ENTITY_TYPE,
    relationRaw: FAST_RELATION_RAW,
    relationNorm: FAST_RELATION_NORM,
    tail: edge.tail,
    tailType: FAST_ENTITY_TYPE,
    description: edge.evidence,
    // The evidence is a sentence of (or the whole) child, so persist's
    // isGrounded substring gate passes by construction.
    evidenceSpan: edge.evidence,
    confidence: edge.weight / (edge.weight + 1),
    extractor: FAST_EXTRACTOR_TAG,
  };
}

/**
 * Extract one child chunk with the fast method. Sealed-union contract like
 * `extractChunk`: never throws, every failure is a `{kind:"failed"}` —
 * `EMPTY_CHUNK` pre-flight, then `FAST_EMPTY_GRAPH` when Chinese content
 * produced no (pruned) edges. Non-Chinese content yielding nothing stays a
 * normal zero-output chunk: the typed fail is the Chinese-corpus rule.
 */
export function extractFastChunk(
  chunk: ChunkInput,
  opts: FastPruneOptions = {}
): ExtractionOutcome {
  if (chunk.content.trim().length === 0) {
    return {
      kind: "failed",
      errorCode: EMPTY_CHUNK_CODE,
      errorMsg: `chunk ${chunk.id} has empty content`,
    };
  }
  const edges = pruneFastEdges(
    buildCoOccurrenceEdges(chunk.content),
    opts
  );
  if (edges.length === 0 && containsCjk(chunk.content)) {
    return {
      kind: "failed",
      errorCode: FAST_EMPTY_GRAPH_CODE,
      errorMsg:
        `fast extraction on chunk ${chunk.id} produced an empty graph from ` +
        "Chinese content; the mixed zh/en default must not silently index nothing",
    };
  }
  return { kind: "ok", outputs: edges.map(fastEdgeToOutput) };
}
