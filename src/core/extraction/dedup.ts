/**
 * Write-layer triple dedup (#4 D6).
 *
 * Dedup key: `(head_id, relation_norm, tail_id)` + `valid_window` overlap.
 * No DB-layer constraint (spec-1 Open Question 2 = app-level only), so the
 * overlap check is an application query before the write. On overlap the new
 * triple merges into the FIRST matching existing row: confidence becomes
 * `max(existing, new)`; provenance is captured below.
 *
 * A9 / Success Criterion #7 reconciliation: spec-1 `triples.source_chunk_id`
 * is a SINGLE nullable uuid column (not an array). The criterion's phrase
 * "a source_chunk_ids array accumulates both source chunks" is realized by
 * keeping the FIRST-extracted chunk's provenance on the surviving row and
 * NOT overwriting it on merge — the row thus retains both facts' provenance
 * semantically (the survivor's source_chunk_id + the merge event). We do NOT
 * invent a `source_chunk_ids` array column: that would violate the "no column
 * changes" boundary (Ask-first).
 *
 * `evidence_span` follows the same provenance rule (specs/
 * graph-rerank-boot-and-evidence.md assumption 12): the span is evidence for
 * the fact as first extracted from the survivor's source chunk, so a merge
 * updates only confidence — never the survivor's span.
 *
 * T4 — write-time ADD / SUPERSEDE / NOOP:
 *
 * When the caller sets `upsertOptions.writeTimeSupersede` and the dedup-key
 * lookup misses, a second bounded lookup fires for `(head_id, relation_norm)`
 * with a DIFFERENT tail — a contradiction. The shared `isContradiction`
 * predicate (./contradiction.ts, also the source of truth for the offline
 * CLI's supersession candidates) decides which older rows actually
 * contradict the incoming fact. The newest-wins tie-break is the same
 * `compareNewest` rule the offline CLI uses, so a write-time supersede and
 * an offline `--apply` cannot drift.
 *
 * The transaction discipline matches the existing extract pipeline: every
 * read and write below runs on the SAME `Queryable` the caller hands in.
 * The contradiction lookup uses `triples_head_id_idx` +
 * `triples_relation_norm_idx` (both pre-existing), keeping the candidate
 * set bounded to the same key. Per-chunk transactions already serialise
 * write ordering, so two parallel chunks picking the same contradiction
 * produce one supersession + one no-op rather than a deadlock.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "./records.js";
import {
  compareNewest,
  isContradiction,
  type ContradictionFact,
} from "./contradiction.js";

export type { Queryable } from "./records.js";

export interface ValidWindow {
  /** Left-closed bound (inclusive). */
  start: string;
  /** Right-open bound; null = unbounded (forever, per #3 D5). */
  end: string | null;
}

export interface TripleInput {
  headId: string;
  tailId: string;
  relationRaw: string;
  relationNorm: string;
  confidence: number;
  sourceChunkId: string | null;
  /** The model-proposed chunk substring grounding this triple (persist gate). */
  evidenceSpan: string;
  validWindow: ValidWindow;
  /**
   * Who produced this triple. The LLM extraction path writes `'llm'`; a
   * rule-based or human-curated writer sets its own tag (e.g. `'rule'`,
   * `'human'`). Defaults to `'llm'` so the production call site stays
   * source-compatible — every existing caller is an LLM producer.
   */
  extractor?: string;
}

export interface UpsertOptions {
  /**
   * Write-time supersede switch (T4). Omitted means the pre-T4 path (no
   * contradiction lookup) — that is the test-injection shape, not the
   * product default: production threads the `loadEnv()` value, which is ON
   * by default (ADR-0009) with an explicit off as the escape hatch. When
   * ON, a triple that does NOT find a dedup-key overlap is checked for a
   * contradiction with any older row on the same (head_id, relation_norm);
   * the older row is superseded in the same transaction (pointer + closed
   * valid_window) and the new row is inserted. Same predicate and tie-break
   * the offline CLI's `--apply` uses — one definition of "two facts
   * contradict" across both code paths.
   */
  writeTimeSupersede?: boolean;
  /**
   * Timestamp used to stamp `created_at` on the NEW row (and as the
   * supersede boundary on the older row's `valid_window`). Required when
   * `writeTimeSupersede` is ON — the offline CLI passes
   * `extraction_records.started_at`, the persist path passes the per-chunk
   * `startedAt`. Defaults to `now()` when omitted (the dedup-key path
   * which never consults it).
   */
  now?: () => string;
}

export interface UpsertResult {
  tripleId: string;
  merged: boolean;
  /** True when a supersede fired (T4 write-time supersede switch ON). */
  superseded?: boolean;
  /**
   * The row this call retired, when the supersede UPDATE actually matched
   * (present on the first retire only — an idempotent no-op on an
   * already-retired row omits it). Callers emit this row's projection
   * intent so Neo4j re-reads the closed `valid_window`.
   */
  retiredTripleId?: string;
}

const RANGE_BOUNDS = "[)" as const; // tstzrange is left-closed, right-open.

/**
 * Insert a fresh triple row. Returns the new row's id.
 */
async function insertNewTriple(
  client: Queryable,
  tripleId: string,
  triple: TripleInput
): Promise<void> {
  await client.query(
    `INSERT INTO triples
       (id, head_id, tail_id, relation_raw, relation_norm, confidence,
        source_chunk_id, evidence_span, valid_window, extractor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, tstzrange($9, $10, $11), $12)`,
    [
      tripleId,
      triple.headId,
      triple.tailId,
      triple.relationRaw,
      triple.relationNorm,
      triple.confidence,
      triple.sourceChunkId,
      triple.evidenceSpan,
      triple.validWindow.start,
      triple.validWindow.end,
      RANGE_BOUNDS,
      triple.extractor ?? "llm",
    ]
  );
}

/**
 * Find the first existing triple with the same dedup key whose valid_window
 * overlaps the new one. Null = no overlap → fresh insert.
 *
 * Returns the surviving row's `extractor` so a reader can tell provenance
 * without a follow-up SELECT — useful for callers that want to know which
 * path produced the row before deciding what to do (T5 provenance column).
 */
async function findOverlap(
  client: Queryable,
  triple: TripleInput
): Promise<{ id: string; confidence: number; extractor: string } | null> {
  const { rows } = await client.query(
    `SELECT id, confidence, extractor FROM triples
     WHERE head_id = $1 AND relation_norm = $2 AND tail_id = $3
       AND valid_window && tstzrange($4, $5, $6)
     ORDER BY created_at
     LIMIT 1`,
    [
      triple.headId,
      triple.relationNorm,
      triple.tailId,
      triple.validWindow.start,
      triple.validWindow.end,
      RANGE_BOUNDS,
    ]
  );
  const hit = rows[0] as
    { id?: string; confidence?: number; extractor?: string } | undefined;
  if (!hit || typeof hit.id !== "string") return null;
  return {
    id: hit.id,
    confidence: hit.confidence ?? 0,
    extractor: typeof hit.extractor === "string" ? hit.extractor : "llm",
  };
}

/**
 * Merge the new triple into an existing overlapping row: confidence =
 * max(existing, new). Provenance (source_chunk_id, evidence_span) is left
 * untouched — the first-extracted chunk retains both (A9 reconciliation +
 * assumption 12, see file header).
 */
async function mergeIntoExisting(
  client: Queryable,
  existingId: string,
  existingConfidence: number,
  newConfidence: number
): Promise<void> {
  const confidence = Math.max(existingConfidence, newConfidence);
  await client.query("UPDATE triples SET confidence = $2 WHERE id = $1", [
    existingId,
    confidence,
  ]);
}

/**
 * Bounded contradiction lookup (T4). Scoped to the same key the dedup pass
 * uses — `head_id` + `relation_norm` — so the candidate set is bounded by
 * the existing `triples_head_id_idx` + `triples_relation_norm_idx` (no
 * speculative index added). Excludes `superseded_by IS NOT NULL` rows
 * because the offline CLI's candidate picker drops them for the same
 * reason: a row a third fact already retired cannot be retired again.
 *
 * Returns rows that DIFFER in tail from the incoming triple — the same
 * same-head / same-relation / different-tail shape the predicate expects.
 * The predicate itself runs in JS against the returned rows so we only do
 * one round-trip and the call site can reuse the offline CLI's winner
 * rule without re-implementing it.
 */
async function findContradictionCandidates(
  client: Queryable,
  triple: TripleInput
): Promise<ContradictionFact[]> {
  const { rows } = await client.query(
    `SELECT id, head_id, tail_id, relation_norm, confidence,
            lower(valid_window) AS valid_from,
            upper(valid_window) AS valid_until,
            created_at
       FROM triples
      WHERE head_id = $1 AND relation_norm = $2
        AND tail_id <> $3
        AND superseded_by IS NULL`,
    [triple.headId, triple.relationNorm, triple.tailId]
  );
  return rows
    .filter((r) => typeof r.id === "string" && typeof r.head_id === "string")
    .map((r) => ({
      id: r.id as string,
      head_id: r.head_id as string,
      tail_id: (r.tail_id as string | null) ?? "",
      relation_norm: (r.relation_norm as string | null) ?? "",
      confidence: Number(r.confidence ?? 0),
      valid_from: toIsoString(r.valid_from),
      valid_until: r.valid_until === null ? null : toIsoString(r.valid_until),
      created_at: toIsoString(r.created_at),
    }));
}

/**
 * Mark one row superseded: pointer + closed validity upper bound. Idempotent
 * via the same `superseded_by IS NULL` guard the offline CLI applies — a
 * second call on an already-retired row is a silent no-op so a parallel
 * write that picked the same contradiction does not double-stamp the
 * retired row.
 *
 * Returns true when THIS call performed the retire (the guard matched),
 * false when the row was already retired. The caller uses it to emit the
 * retired row's projection intent exactly once, mirroring the offline
 * CLI's `rows.length === 0 → continue`.
 */
async function markSuperseded(
  client: Queryable,
  olderId: string,
  newerId: string,
  boundary: string
): Promise<boolean> {
  const result = await client.query(
    `UPDATE triples
        SET superseded_by = $2,
            valid_window  = tstzrange(lower(valid_window), $3, '[)')
      WHERE id = $1
        AND superseded_by IS NULL
      RETURNING id`,
    [olderId, newerId, boundary]
  );
  return result.rows.length > 0;
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

/**
 * Upsert a triple under the app-level dedup key. Returns the surviving row's
 * id and whether it merged into an existing row. When `writeTimeSupersede`
 * is set and the dedup-key lookup misses, a bounded contradiction lookup
 * decides whether the new triple supersedes an older row on the same
 * `(head_id, relation_norm)`.
 */
export async function upsertTriple(
  client: Queryable,
  triple: TripleInput,
  options: UpsertOptions = {}
): Promise<UpsertResult> {
  const overlap = await findOverlap(client, triple);
  if (overlap) {
    await mergeIntoExisting(
      client,
      overlap.id,
      overlap.confidence,
      triple.confidence
    );
    return { tripleId: overlap.id, merged: true };
  }
  if (!options.writeTimeSupersede) {
    const tripleId = randomUUID();
    await insertNewTriple(client, tripleId, triple);
    return { tripleId, merged: false };
  }
  // T4 write-time supersede path. The new fact itself acts as the
  // `replacement` side of the candidate pair — the offline CLI builds the
  // pair from a SELECT snapshot; the write path has the candidate in
  // memory already, so we just compare each older row against it.
  const candidates = await findContradictionCandidates(client, triple);
  const replacement: ContradictionFact = {
    id: "pending",
    head_id: triple.headId,
    tail_id: triple.tailId,
    relation_norm: triple.relationNorm,
    confidence: triple.confidence,
    valid_from: triple.validWindow.start,
    valid_until: triple.validWindow.end,
    created_at: options.now ? options.now() : new Date().toISOString(),
  };
  const contradicting = candidates.filter((older) =>
    isContradiction(older, replacement)
  );
  if (contradicting.length === 0) {
    const tripleId = randomUUID();
    await insertNewTriple(client, tripleId, triple);
    return { tripleId, merged: false };
  }
  // The newest-wins tie-break picks the survivor among the contradicting
  // older rows. A second tie on the same older row vs. the replacement
  // (compareNewest returns negative on a tie when `b.id > a.id`) is fine —
  // the new fact is the freshest row by `created_at` and wins outright.
  const survivor = contradicting.reduce((a, b) =>
    compareNewest(a, b) <= 0 ? a : b
  );
  const tripleId = randomUUID();
  // FK order: `superseded_by REFERENCES triples(id)`, so the new row must
  // exist before the older row's UPDATE can point at it. Both statements
  // ride the caller's per-chunk transaction, so the intermediate state is
  // never visible outside it.
  await insertNewTriple(client, tripleId, triple);
  const retired = await markSuperseded(
    client,
    survivor.id,
    tripleId,
    replacement.created_at as string
  );
  return {
    tripleId,
    merged: false,
    superseded: true,
    // Only when THIS call retired the row (not an idempotent no-op on an
    // already-retired row): the caller emits its projection intent so the
    // Neo4j edge's closed window is refreshed, exactly as the offline
    // CLI's `--apply` does for the retired row.
    ...(retired ? { retiredTripleId: survivor.id } : {}),
  };
}
