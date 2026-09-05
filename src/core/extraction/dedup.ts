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
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "./records.js";

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
}

export interface UpsertResult {
  tripleId: string;
  merged: boolean;
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
        source_chunk_id, evidence_span, valid_window)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, tstzrange($9, $10, $11))`,
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
    ]
  );
}

/**
 * Find the first existing triple with the same dedup key whose valid_window
 * overlaps the new one. Null = no overlap → fresh insert.
 */
async function findOverlap(
  client: Queryable,
  triple: TripleInput
): Promise<{ id: string; confidence: number } | null> {
  const { rows } = await client.query(
    `SELECT id, confidence FROM triples
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
  const hit = rows[0] as { id?: string; confidence?: number } | undefined;
  if (!hit || typeof hit.id !== "string") return null;
  return { id: hit.id, confidence: hit.confidence ?? 0 };
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
 * Upsert a triple under the app-level dedup key. Returns the surviving row's
 * id and whether it merged into an existing row.
 */
export async function upsertTriple(
  client: Queryable,
  triple: TripleInput
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
  const tripleId = randomUUID();
  await insertNewTriple(client, tripleId, triple);
  return { tripleId, merged: false };
}
