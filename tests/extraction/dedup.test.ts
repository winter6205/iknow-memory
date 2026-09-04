import { describe, it, expect } from "vitest";
import {
  upsertTriple,
  type Queryable,
} from "../../src/core/extraction/dedup.js";

/**
 * In-memory fake of the `triples` table for unit-testing the write-layer dedup.
 *
 * Mirrors the spec-1 DDL columns the dedup touches: id, head_id, tail_id,
 * relation_raw, relation_norm, confidence, source_chunk_id, evidence_span,
 * valid_window.
 * `valid_window` is stored as `{ start, end }` (end null = unbounded) and
 * overlap uses left-closed/right-open semantics (tstzrange).
 */
interface StoredTriple {
  id: string;
  head_id: string;
  tail_id: string;
  relation_raw: string;
  relation_norm: string;
  confidence: number;
  source_chunk_id: string | null;
  evidence_span: string | null;
  valid_window: { start: string; end: string | null };
}

interface FakeClient {
  client: Queryable;
  rows: StoredTriple[];
  calls: Array<{ text: string; values: unknown[] }>;
}

function overlaps(
  a: { start: string; end: string | null },
  b: { start: string; end: string | null }
): boolean {
  // tstzrange is left-closed, right-open: [a.start, a.end).
  const aEnd = a.end ?? "9999-12-31T23:59:59Z";
  const bEnd = b.end ?? "9999-12-31T23:59:59Z";
  return a.start < bEnd && b.start < aEnd;
}

function makeFakeClient(initial: StoredTriple[] = []): FakeClient {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const rows: StoredTriple[] = [...initial];
  return {
    rows,
    calls,
    client: {
      async query(text: string, values: unknown[]): Promise<{ rows: any[] }> {
        calls.push({ text, values });
        if (text.includes("SELECT id, confidence FROM triples")) {
          // Overlap lookup: same head/relation/tail with valid_window overlap.
          const [head_id, relation_norm, tail_id, start, end] = values as [
            string,
            string,
            string,
            string,
            string | null,
          ];
          const candidate = {
            start,
            end: end ?? null,
          };
          const hits = rows.filter(
            (r) =>
              r.head_id === head_id &&
              r.relation_norm === relation_norm &&
              r.tail_id === tail_id &&
              overlaps(r.valid_window, candidate)
          );
          return {
            rows: hits.map((r) => ({
              id: r.id,
              confidence: r.confidence,
            })),
          };
        }
        if (text.includes("UPDATE triples SET confidence")) {
          const [id, confidence] = values as [string, number];
          const row = rows.find((r) => r.id === id);
          if (row) row.confidence = confidence;
          return { rows: [] };
        }
        if (text.includes("INSERT INTO triples")) {
          const [
            id,
            head_id,
            tail_id,
            relation_raw,
            relation_norm,
            confidence,
            source_chunk_id,
            evidence_span,
            start,
            end,
          ] = values as [
            string,
            string,
            string,
            string,
            string,
            number,
            string | null,
            string | null,
            string,
            string | null,
          ];
          rows.push({
            id,
            head_id,
            tail_id,
            relation_raw,
            relation_norm,
            confidence,
            source_chunk_id,
            evidence_span,
            valid_window: { start, end: end ?? null },
          });
          return { rows: [{ id }] };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    },
  };
}

const baseTriple = {
  headId: "h1",
  tailId: "t1",
  relationRaw: "works at",
  relationNorm: "works_for",
  confidence: 0.9,
  sourceChunkId: "chunk-1",
  evidenceSpan: "Alice Smith works at Acme Corp",
  validWindow: { start: "2026-01-01T00:00:00Z", end: "2026-12-31T00:00:00Z" },
};

describe("upsertTriple", () => {
  it("no overlap → inserts a new row, merged:false", async () => {
    const f = makeFakeClient();
    const result = await upsertTriple(f.client, baseTriple);
    expect(result.merged).toBe(false);
    expect(result.tripleId).toBeTypeOf("string");
    expect(f.rows).toHaveLength(1);
  });

  it("overlap on same (head, relation_norm, tail) → merges, merged:true, no second row", async () => {
    const f = makeFakeClient([
      {
        id: "existing-1",
        head_id: "h1",
        tail_id: "t1",
        relation_raw: "works at",
        relation_norm: "works_for",
        confidence: 0.9,
        source_chunk_id: "chunk-1",
        evidence_span: "old surviving span",
        valid_window: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-12-31T00:00:00Z",
        },
      },
    ]);
    const result = await upsertTriple(f.client, baseTriple);
    expect(result.merged).toBe(true);
    expect(result.tripleId).toBe("existing-1");
    expect(f.rows).toHaveLength(1);
    // max(0.9, 0.9) stays 0.9.
    expect(f.rows[0]?.confidence).toBe(0.9);
  });

  it("confidence: existing 0.9 + new 0.4 → keeps 0.9", async () => {
    const f = makeFakeClient([
      {
        id: "existing-1",
        head_id: "h1",
        tail_id: "t1",
        relation_raw: "works at",
        relation_norm: "works_for",
        confidence: 0.9,
        source_chunk_id: "chunk-1",
        evidence_span: null,
        valid_window: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-12-31T00:00:00Z",
        },
      },
    ]);
    await upsertTriple(f.client, { ...baseTriple, confidence: 0.4 });
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]?.confidence).toBe(0.9);
  });

  it("confidence: existing 0.4 + new 0.9 → becomes 0.9", async () => {
    const f = makeFakeClient([
      {
        id: "existing-1",
        head_id: "h1",
        tail_id: "t1",
        relation_raw: "works at",
        relation_norm: "works_for",
        confidence: 0.4,
        source_chunk_id: "chunk-1",
        evidence_span: null,
        valid_window: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-12-31T00:00:00Z",
        },
      },
    ]);
    await upsertTriple(f.client, { ...baseTriple, confidence: 0.9 });
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]?.confidence).toBe(0.9);
  });

  it("different relation_norm (same head/tail) → no merge, two rows", async () => {
    const f = makeFakeClient([
      {
        id: "existing-1",
        head_id: "h1",
        tail_id: "t1",
        relation_raw: "works at",
        relation_norm: "works_for",
        confidence: 0.9,
        source_chunk_id: "chunk-1",
        evidence_span: null,
        valid_window: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-12-31T00:00:00Z",
        },
      },
    ]);
    const result = await upsertTriple(f.client, {
      ...baseTriple,
      relationNorm: "knows",
    });
    expect(result.merged).toBe(false);
    expect(f.rows).toHaveLength(2);
  });

  it("non-overlapping valid_window (same head/relation/tail) → insert, two rows", async () => {
    const f = makeFakeClient([
      {
        id: "existing-1",
        head_id: "h1",
        tail_id: "t1",
        relation_raw: "works at",
        relation_norm: "works_for",
        confidence: 0.9,
        source_chunk_id: "chunk-1",
        evidence_span: null,
        valid_window: {
          start: "2020-01-01T00:00:00Z",
          end: "2020-12-31T00:00:00Z",
        },
      },
    ]);
    const result = await upsertTriple(f.client, baseTriple);
    expect(result.merged).toBe(false);
    expect(f.rows).toHaveLength(2);
  });

  it("insert stores evidence_span on the fresh row", async () => {
    const f = makeFakeClient();
    await upsertTriple(f.client, baseTriple);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]?.evidence_span).toBe(baseTriple.evidenceSpan);
  });

  it("merge does not overwrite the survivor's evidence_span while confidence takes max (provenance rule)", async () => {
    const f = makeFakeClient([
      {
        id: "existing-1",
        head_id: "h1",
        tail_id: "t1",
        relation_raw: "works at",
        relation_norm: "works_for",
        confidence: 0.4,
        source_chunk_id: "chunk-1",
        evidence_span: "first chunk's surviving span",
        valid_window: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-12-31T00:00:00Z",
        },
      },
    ]);
    await upsertTriple(f.client, {
      ...baseTriple,
      confidence: 0.9,
      evidenceSpan: "second chunk's span",
    });
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]?.confidence).toBe(0.9);
    expect(f.rows[0]?.evidence_span).toBe("first chunk's surviving span");
  });
});
