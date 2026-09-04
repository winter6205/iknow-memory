/**
 * Eval filter — the unique hard rule in the LLM-gold pipeline
 * (specs/p0-eval.md SC10, A4).
 *
 * The eval CLI composes three pieces — a gold-model LLM, this code
 * filter, and an audit-model LLM. Per A4, the filter is the only one of
 * the three that is not an LLM: it is a pure function over the triple
 * plus the chunk text, with no I/O, no clock, no randomness. That makes
 * it the only piece whose verdict a regression in extractor behaviour
 * can never silently flip — and the only piece whose reject taxonomy
 * has to be enumerated here, in source, in tests.
 *
 * Reject taxonomy (every `accept: false` carries exactly one of these):
 *   - no-grounding            — evidence span is missing or not a substring of chunkText.
 *   - relation-not-norm       — relationNorm is not a vocabulary term (and not UNMAPPED).
 *   - entity-not-normalized   — head or tail is blank, or would change under normalizeAlias.
 *   - negated                 — description or evidence span carries a negation cue.
 *
 * Check order is part of the contract: no-grounding runs first so a
 * fabricated evidence span surfaces as hallucination, not as a later
 * vocabulary concern. entity-not-normalized runs before negated so the
 * caller sees the most actionable reason when a triple is malformed
 * along multiple axes.
 *
 * `ALLOWED` and `UNMAPPED` are imported (not re-declared) so gold,
 * filter, and extract always answer to the same closed relation set.
 * Re-importing `normalizeAlias` from `entities/merge.ts` does the same
 * for the entity form: a filter that invented its own normalizer would
 * silently disagree with the merge layer about what counts as
 * "the same entity".
 *
 * Negation cue list is configurable so the audit LLM and the filter can
 * be re-tuned against each other without a code change to extract.
 * The default list — `\bnot\b`, `\bno\b`, `\bnever\b`, `\bn't\b` — is
 * the small, defensible set A4 calls a heuristic.
 */
import { normalizeAlias } from "../entities/merge.js";
import { ALLOWED, UNMAPPED } from "../extraction/vocabulary.js";
import type { ExtractionOutput } from "../extraction/types.js";
import { FilterError } from "./errors.js";

/** The four reject reasons SC10 enumerates. */
export type RejectReason =
  "no-grounding" | "relation-not-norm" | "entity-not-normalized" | "negated";

/** A typed filter outcome: either accept, or one of the four reject reasons. */
export type FilterResult =
  { accept: true } | { accept: false; reason: RejectReason };

/** Optional knobs the caller can pass to `filterTriple`. */
export interface FilterContext {
  /**
   * Regex set scanned against the triple's description and evidence span.
   * Match any cue ⇒ negated. Default: the SC10 default list below.
   */
  negationCues?: readonly RegExp[];
}

/**
 * Word-boundary regex set for English negation cues. Word boundaries
 * keep cues from matching inside entity names (e.g. "Note" must not
 * trip `\bno\b`), and the contracted form `n't\b` catches "doesn't",
 * "isn't", "hasn't" without a manual list. The `n't` cue uses a
 * trailing-only boundary because the leading character of `n't` is
 * another letter (`o` in "doesn't") — no word boundary sits there.
 *
 * Documented inline: spec A4 calls this list a heuristic, so the
 * burden is on the implementer to keep it small and defensible.
 */
export const DEFAULT_NEGATION_CUES: readonly RegExp[] = [
  /\bnot\b/,
  /\bno\b/,
  /\bnever\b/,
  /n't\b/,
];

/**
 * Decide whether one triple the gold model proposed should be admitted
 * into the gold set.
 *
 * Pure: no I/O, no clock, no randomness, no LLM. Throws `FilterError`
 * only on input shape violations a verdict cannot describe (e.g.
 * `relationNorm` not a string); every well-formed triple returns either
 * `{ accept: true }` or `{ accept: false, reason }`.
 */
export function filterTriple(
  triple: ExtractionOutput,
  chunkText: string,
  ctx: FilterContext = {}
): FilterResult {
  assertTripleShape(triple);

  if (!isGrounded(triple, chunkText)) {
    return { accept: false, reason: "no-grounding" };
  }
  if (!isRelationNorm(triple.relationNorm)) {
    return { accept: false, reason: "relation-not-norm" };
  }
  if (!isEntityNormalized(triple.head, triple.tail)) {
    return { accept: false, reason: "entity-not-normalized" };
  }
  if (isNegated(triple, ctx.negationCues ?? DEFAULT_NEGATION_CUES)) {
    return { accept: false, reason: "negated" };
  }
  return { accept: true };
}

// ---- internal helpers ----

/**
 * Throw `FilterError` if any field `filterTriple` must read is missing or
 * of the wrong runtime type. The four reject reasons only describe
 * triples the filter can reason about; a `relationNorm: 42` belongs to
 * a different failure mode (bad input shape) and must surface as a
 * thrown, typed error so the caller can decide whether to fail the
 * batch or mark-and-continue.
 */
function assertTripleShape(triple: ExtractionOutput): void {
  const stringFields: Array<keyof ExtractionOutput> = [
    "head",
    "headType",
    "relationRaw",
    "relationNorm",
    "tail",
    "tailType",
    "description",
    "evidenceSpan",
  ];
  for (const field of stringFields) {
    const value = triple[field];
    if (typeof value !== "string") {
      throw new FilterError(
        `eval filter: triple.${field} must be a string, got ${typeof value}`,
        "FILTER_TRIPLE_INVALID"
      );
    }
  }
  if (
    typeof triple.confidence !== "number" ||
    !Number.isFinite(triple.confidence)
  ) {
    throw new FilterError(
      `eval filter: triple.confidence must be a finite number, got ${String(
        triple.confidence
      )}`,
      "FILTER_TRIPLE_CONFIDENCE_INVALID"
    );
  }
}

/**
 * Grounding: the evidence span must be a substring of the chunk text.
 * Empty chunk text ⇒ every triple is ungrounded (the no-grounding
 * branch covers it explicitly so a chunk text of "" does not need a
 * separate code path on the caller side).
 *
 * Exported — not a private eval helper — because production persist
 * (`src/cli/extract.ts`) applies the same predicate as its insert gate
 * (specs/graph-rerank-boot-and-evidence.md assumption 10): there must be
 * exactly one substring algorithm, or eval and persist would disagree
 * about what counts as a grounded triple.
 */
export function isGrounded(
  triple: ExtractionOutput,
  chunkText: string
): boolean {
  if (triple.evidenceSpan.length === 0) return false;
  if (chunkText.length === 0) return false;
  return chunkText.includes(triple.evidenceSpan);
}

/**
 * Relation normality: must be a vocabulary term (ALLOWED) or the
 * UNMAPPED sentinel. Anything else — including the empty string — is a
 * rejection.
 */
function isRelationNorm(relationNorm: string): boolean {
  if (relationNorm === UNMAPPED) return false;
  return ALLOWED.includes(relationNorm);
}

/**
 * Entity normalization rule:
 *   - head and tail must be non-blank,
 *   - and must already equal `normalizeAlias(...)` of themselves.
 *
 * The second clause is the load-bearing one: a gold model that emits
 * `"  Alice  Chen  "` fails because normalizeAlias would fold it to
 * `"alice chen"`. That keeps the filter aligned with the merge layer's
 * view of "the same entity" without re-implementing normalization.
 */
function isEntityNormalized(head: string, tail: string): boolean {
  if (head.trim() === "" || tail.trim() === "") return false;
  return normalizeAlias(head) === head && normalizeAlias(tail) === tail;
}

/**
 * Negation heuristic: scan the description and the evidence span with
 * the (configurable) cue list. Cues match as a regex, with word
 * boundaries on the defaults, so a cue embedded inside an entity name
 * (e.g. "Note") does not trip the rule.
 */
function isNegated(triple: ExtractionOutput, cues: readonly RegExp[]): boolean {
  const haystack = `${triple.description}\n${triple.evidenceSpan}`;
  for (const cue of cues) {
    if (cue.test(haystack)) return true;
  }
  return false;
}
