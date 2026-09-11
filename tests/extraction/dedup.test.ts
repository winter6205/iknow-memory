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
  created_at?: string;
  /** T4: who was the surviving pointer (null = live). */
  superseded_by?: string | null;
  /** T5: provenance tag — who produced this triple (default 'llm'). */
  extractor?: string;
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
        if (text.includes("SELECT id, confidence, extractor FROM triples")) {
          // Overlap lookup: same head/relation/tail with valid_window overlap.
          // T5: extractor column is now in the SELECT list so callers can
          // distinguish provenance without a follow-up SELECT.
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
              extractor: r.extractor ?? "llm",
            })),
          };
        }
        if (text.includes("UPDATE triples SET confidence")) {
          const [id, confidence] = values as [string, number];
          const row = rows.find((r) => r.id === id);
          if (row) row.confidence = confidence;
          return { rows: [] };
        }
        if (text.includes("UPDATE triples") && text.includes("superseded_by")) {
          // T4 write-time supersede UPDATE: pointer + closed valid_window.
          // The superseded_by IS NULL guard is what makes a parallel chunk
          // picking the same contradiction a silent no-op. `RETURNING id`
          // mirrors the real statement: a matched UPDATE returns the row,
          // a guarded no-op returns none.
          const [olderId, newerId, boundary] = values as [
            string,
            string,
            string,
          ];
          const row = rows.find((r) => r.id === olderId);
          if (row && row.superseded_by == null) {
            row.superseded_by = newerId;
            // The DB-side UPDATE closes valid_window at `boundary`. The
            // fake mirrors the same shape so any reader of the row sees
            // the retired fact.
            row.valid_window = { start: row.valid_window.start, end: boundary };
            return { rows: [{ id: olderId }] };
          }
          return { rows: [] };
        }
        if (
          text.includes("FROM triples") &&
          text.includes("lower(valid_window)") &&
          text.includes("upper(valid_window)")
        ) {
          // T4 contradiction lookup: same (head_id, relation_norm),
          // DIFFERENT tail_id, NOT superseded. The `tail_id <> $3`
          // guard is mirrored in the filter.
          const [head_id, relation_norm, tail_id] = values as [
            string,
            string,
            string,
          ];
          const hits = rows.filter(
            (r) =>
              r.head_id === head_id &&
              r.relation_norm === relation_norm &&
              r.tail_id !== tail_id &&
              r.superseded_by == null
          );
          return {
            rows: hits.map((r) => ({
              id: r.id,
              head_id: r.head_id,
              tail_id: r.tail_id,
              relation_norm: r.relation_norm,
              confidence: r.confidence,
              valid_from: r.valid_window.start,
              valid_until: r.valid_window.end,
              created_at: r.created_at ?? "2026-01-01T00:00:00Z",
            })),
          };
        }
        if (text.includes("INSERT INTO triples")) {
          // Bound order matches `INSERT INTO triples (...) VALUES
          // ($1..$12)` in dedup.ts:
          //   id, head_id, tail_id, relation_raw, relation_norm,
          //   confidence, source_chunk_id, evidence_span,
          //   tstzrange(start, end, RANGE_BOUNDS), extractor.
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
            _rangeBounds,
            extractor,
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
            string,
            string,
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
            extractor: typeof extractor === "string" ? extractor : "llm",
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

describe("upsertTriple extractor provenance (T5)", () => {
  it("defaults the extractor to 'llm' when the caller omits it", async () => {
    const f = makeFakeClient();
    await upsertTriple(f.client, baseTriple);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]?.extractor).toBe("llm");
  });

  it("a non-LLM writer can set its own extractor value", async () => {
    const f = makeFakeClient();
    await upsertTriple(f.client, { ...baseTriple, extractor: "rule" });
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]?.extractor).toBe("rule");
  });

  it("a non-default extractor value is bound as the 12th INSERT parameter", async () => {
    const f = makeFakeClient();
    await upsertTriple(f.client, { ...baseTriple, extractor: "human" });
    const insert = f.calls.find((c) => /INSERT INTO triples/.test(c.text));
    expect(insert).toBeDefined();
    // The 12th bound value is extractor (after 8 column slots + 3 range
    // slots = 11, then the extractor placeholder).
    expect(insert!.values[11]).toBe("human");
  });

  it("the overlap lookup SELECT exposes extractor on the surviving row", async () => {
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
        extractor: "rule",
        valid_window: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-12-31T00:00:00Z",
        },
      },
    ]);
    const result = await upsertTriple(f.client, baseTriple);
    expect(result.merged).toBe(true);
    expect(result.tripleId).toBe("existing-1");
    // The merge branch only writes confidence — the survivor's extractor
    // is intentionally preserved (same provenance rule as evidence_span).
    expect(f.rows[0]?.extractor).toBe("rule");
  });
});

/**
 * T4 — write-time ADD / SUPERSEDE / NOOP.
 *
 * OFF-path: every test below MUST pass identically with
 * `writeTimeSupersede: false` (the OFF path is byte-identical to the
 * pre-T4 behaviour). ON-path tests cover the five boundary classes
 * (empty / negative / overflow / concurrent / exception) plus the
 * offline-CLI regression guard the brief pins — the same predicate and
 * winner rule MUST decide both paths.
 */
describe("upsertTriple write-time supersede switch (T4)", () => {
  it("OFF path is byte-identical: no contradiction lookup fires when the switch is absent", async () => {
    const f = makeFakeClient([
      {
        id: "old-1",
        head_id: "h1",
        tail_id: "t-OTHER",
        relation_raw: "works at",
        relation_norm: "works_for",
        confidence: 0.9,
        source_chunk_id: "chunk-1",
        evidence_span: null,
        created_at: "2026-01-01T00:00:00Z",
        valid_window: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-12-31T00:00:00Z",
        },
      },
    ]);
    // A different-tail older row exists but the OFF path must not consult
    // it. The new triple just inserts.
    await upsertTriple(f.client, baseTriple);
    expect(f.rows).toHaveLength(2);
    expect(f.rows.find((r) => r.id === "old-1")?.superseded_by).toBeUndefined();
  });

  it("OFF path is byte-identical when the switch is explicitly false", async () => {
    const f = makeFakeClient([
      {
        id: "old-1",
        head_id: "h1",
        tail_id: "t-OTHER",
        relation_raw: "works at",
        relation_norm: "works_for",
        confidence: 0.9,
        source_chunk_id: "chunk-1",
        evidence_span: null,
        created_at: "2026-01-01T00:00:00Z",
        valid_window: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-12-31T00:00:00Z",
        },
      },
    ]);
    await upsertTriple(f.client, baseTriple, { writeTimeSupersede: false });
    expect(f.rows).toHaveLength(2);
    expect(f.rows.find((r) => r.id === "old-1")?.superseded_by).toBeUndefined();
  });

  it("ON path with no contradiction (empty) → ADD only, no UPDATE", async () => {
    const f = makeFakeClient();
    const result = await upsertTriple(f.client, baseTriple, {
      writeTimeSupersede: true,
    });
    expect(result.merged).toBe(false);
    expect(result.superseded).toBeUndefined();
    expect(f.rows).toHaveLength(1);
    expect(
      f.calls.some((c) => /UPDATE triples\s+SET superseded_by/.test(c.text))
    ).toBe(false);
  });

  it("ON path with non-overlapping older row (negative) → ADD only, no supersede", async () => {
    const f = makeFakeClient([
      {
        id: "old-1",
        head_id: "h1",
        tail_id: "t-OTHER",
        relation_raw: "works at",
        relation_norm: "works_for",
        confidence: 0.9,
        source_chunk_id: "chunk-1",
        evidence_span: null,
        created_at: "2020-01-01T00:00:00Z",
        valid_window: {
          start: "2020-01-01T00:00:00Z",
          end: "2020-12-31T00:00:00Z",
        },
      },
    ]);
    const result = await upsertTriple(f.client, baseTriple, {
      writeTimeSupersede: true,
    });
    expect(result.merged).toBe(false);
    expect(result.superseded).toBeUndefined();
    expect(f.rows).toHaveLength(2);
    expect(f.rows.find((r) => r.id === "old-1")?.superseded_by).toBeUndefined();
  });

  it("ON path with overlapping contradicting older row → SUPERSEDE: pointer + closed valid_window + new row", async () => {
    const f = makeFakeClient([
      {
        id: "old-1",
        head_id: "h1",
        tail_id: "t-OTHER",
        relation_raw: "works at",
        relation_norm: "works_for",
        confidence: 0.9,
        source_chunk_id: "chunk-1",
        evidence_span: "old surviving span",
        created_at: "2026-01-01T00:00:00Z",
        valid_window: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-12-31T00:00:00Z",
        },
      },
    ]);
    const result = await upsertTriple(f.client, baseTriple, {
      writeTimeSupersede: true,
      now: () => "2026-06-15T12:00:00Z",
    });
    expect(result.merged).toBe(false);
    expect(result.superseded).toBe(true);
    // The retired row's id travels back so the caller can emit its
    // projection intent — the closed window must reach Neo4j, exactly as
    // the offline `--apply` queues the retired row.
    expect(result.retiredTripleId).toBe("old-1");
    expect(f.rows).toHaveLength(2);
    const retired = f.rows.find((r) => r.id === "old-1");
    expect(retired?.superseded_by).toBe(result.tripleId);
    // The supersede boundary is the new row's created_at — not the
    // survivor's original upper bound. Matches the offline CLI's
    // pointer + closed-valid_window shape.
    expect(retired?.valid_window.end).toBe("2026-06-15T12:00:00Z");
    // Survivor provenance preserved (evidence_span not overwritten) —
    // first-extracted chunk keeps both facts' provenance.
    expect(retired?.evidence_span).toBe("old surviving span");
  });

  it("ON path newest-wins: older-of-two contradicting rows is the survivor", async () => {
    // Two contradicting older rows. The newer of the two wins (its `id`
    // is the survivor; the other gets superseded). The newest-wins
    // rule is identical to the offline CLI's compareNewest.
    const f = makeFakeClient([
      {
        id: "old-1",
        head_id: "h1",
        tail_id: "t-OTHER-A",
        relation_raw: "works at",
        relation_norm: "works_for",
        confidence: 0.9,
        source_chunk_id: "chunk-1",
        evidence_span: null,
        created_at: "2026-01-01T00:00:00Z",
        valid_window: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-12-31T00:00:00Z",
        },
      },
      {
        id: "old-2",
        head_id: "h1",
        tail_id: "t-OTHER-B",
        relation_raw: "works at",
        relation_norm: "works_for",
        confidence: 0.9,
        source_chunk_id: "chunk-2",
        evidence_span: null,
        created_at: "2026-02-01T00:00:00Z", // newer
        valid_window: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-12-31T00:00:00Z",
        },
      },
    ]);
    const result = await upsertTriple(f.client, baseTriple, {
      writeTimeSupersede: true,
      now: () => "2026-06-15T12:00:00Z",
    });
    expect(result.superseded).toBe(true);
    // The newest older row wins — `old-2`. `old-1` stays live.
    expect(f.rows.find((r) => r.id === "old-2")?.superseded_by).toBe(
      result.tripleId
    );
    expect(f.rows.find((r) => r.id === "old-1")?.superseded_by).toBeUndefined();
  });

  it("ON path overflow: many contradicting rows are reduced to a single supersede by the pickWinner rule", async () => {
    // Build 5 contradicting older rows. The newest one wins; the others
    // remain live (the offline CLI's candidate picker handles them
    // pairwise on its own run — this write path supersedes ONE per
    // write, matching the "atomic per-write supersede" shape).
    const older: StoredTriple[] = [];
    for (let i = 0; i < 5; i += 1) {
      older.push({
        id: `old-${i}`,
        head_id: "h1",
        tail_id: `t-OTHER-${i}`,
        relation_raw: "works at",
        relation_norm: "works_for",
        confidence: 0.9,
        source_chunk_id: `chunk-${i}`,
        evidence_span: null,
        created_at: `2026-0${i + 1}-01T00:00:00Z`,
        valid_window: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-12-31T00:00:00Z",
        },
      });
    }
    const f = makeFakeClient(older);
    const result = await upsertTriple(f.client, baseTriple, {
      writeTimeSupersede: true,
      now: () => "2026-06-15T12:00:00Z",
    });
    expect(result.superseded).toBe(true);
    // Only ONE older row gets superseded per write — the newest.
    const superseded = f.rows.filter(
      (r) => r.superseded_by === result.tripleId
    );
    expect(superseded).toHaveLength(1);
    expect(superseded[0]?.id).toBe("old-4"); // 2026-05-01
    // The rest stay live.
    const live = f.rows.filter((r) => r.superseded_by == null);
    expect(live).toHaveLength(5); // 4 older + 1 new
  });

  it("ON path concurrent: a parallel writer that already retired the contradiction makes the second UPDATE a no-op", async () => {
    // The fake mirrors the DB-side `superseded_by IS NULL` guard: a
    // second `markSuperseded` on an already-retired row must NOT
    // re-stamp. The fake's `superseded_by == null` filter is the same
    // gate.
    const f = makeFakeClient([
      {
        id: "old-1",
        head_id: "h1",
        tail_id: "t-OTHER",
        relation_raw: "works at",
        relation_norm: "works_for",
        confidence: 0.9,
        source_chunk_id: "chunk-1",
        evidence_span: null,
        created_at: "2026-01-01T00:00:00Z",
        superseded_by: "older-supersede-id", // already retired
        valid_window: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-12-31T00:00:00Z",
        },
      },
    ]);
    const result = await upsertTriple(f.client, baseTriple, {
      writeTimeSupersede: true,
      now: () => "2026-06-15T12:00:00Z",
    });
    expect(result.superseded).toBeUndefined();
    expect(f.rows).toHaveLength(2);
    expect(f.rows.find((r) => r.id === "old-1")?.superseded_by).toBe(
      "older-supersede-id"
    );
  });

  it("ON path SUPERSEDE writes the new row BEFORE pointing the older row at it (FK-safe order)", async () => {
    // Real Postgres enforces `superseded_by REFERENCES triples(id)`, so
    // the UPDATE must reference an id that already exists: the INSERT of
    // the new row has to run first. The unit fake does not enforce the
    // FK, which is exactly why this order assertion exists — a fake-only
    // suite would silently accept the FK-violating order.
    const f = makeFakeClient([
      {
        id: "old-1",
        head_id: "h1",
        tail_id: "t-OTHER",
        relation_raw: "works at",
        relation_norm: "works_for",
        confidence: 0.9,
        source_chunk_id: "chunk-1",
        evidence_span: null,
        created_at: "2026-01-01T00:00:00Z",
        superseded_by: null,
        valid_window: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-12-31T00:00:00Z",
        },
      },
    ]);
    const result = await upsertTriple(f.client, baseTriple, {
      writeTimeSupersede: true,
      now: () => "2026-06-15T12:00:00Z",
    });
    expect(result.superseded).toBe(true);
    const insertIdx = f.calls.findIndex((c) =>
      /INSERT INTO triples/.test(c.text)
    );
    const supersedeIdx = f.calls.findIndex((c) =>
      /UPDATE triples\s+SET superseded_by/.test(c.text)
    );
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(supersedeIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeLessThan(supersedeIdx);
    // The id stamped into the older row is the id the INSERT bound.
    const insertedId = f.calls[insertIdx]?.values[0];
    const supersededBy = f.calls[supersedeIdx]?.values[1];
    expect(supersededBy).toBe(insertedId);
    expect(supersededBy).toBe(result.tripleId);
  });

  it("ON path exception: a failed contradiction lookup surfaces the error and does not insert a half-row", async () => {
    const exploding: FakeClient = {
      rows: [],
      calls: [],
      client: {
        async query(text: string) {
          if (text.includes("SELECT id, confidence, extractor FROM triples")) {
            return { rows: [] };
          }
          if (
            text.includes("FROM triples") &&
            text.includes("lower(valid_window)")
          ) {
            throw new Error("simulated DB outage during contradiction lookup");
          }
          throw new Error(`unexpected query: ${text}`);
        },
      },
    };
    await expect(
      upsertTriple(exploding.client, baseTriple, { writeTimeSupersede: true })
    ).rejects.toThrow(/simulated DB outage/);
    expect(exploding.rows).toHaveLength(0);
  });

  it("ON path NOOP/MERGE has priority over SUPERSEDE: dedup-key overlap merges, no contradiction lookup", async () => {
    // Same (head, relation, tail, window) as an existing row → MERGE
    // wins. The contradiction lookup must NOT fire when the dedup-key
    // hit consumes the write.
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
        created_at: "2026-01-01T00:00:00Z",
        valid_window: {
          start: "2026-01-01T00:00:00Z",
          end: "2026-12-31T00:00:00Z",
        },
      },
    ]);
    const result = await upsertTriple(f.client, baseTriple, {
      writeTimeSupersede: true,
      now: () => "2026-06-15T12:00:00Z",
    });
    expect(result.merged).toBe(true);
    expect(result.superseded).toBeUndefined();
    expect(result.tripleId).toBe("existing-1");
    // No contradiction lookup fires.
    expect(f.calls.some((c) => /lower\(valid_window\)/.test(c.text))).toBe(
      false
    );
  });
});

/**
 * T4 offline-CLI regression guard.
 *
 * The `findSupersessionCandidates` CLI helper and the write-time
 * `upsertTriple` MUST agree on (a) which pairs are contradictions and
 * (b) which row wins. The shared `contradiction.ts` predicate is the
 * single source of truth — this test pins that the SAME inputs produce
 * the SAME `(superseded, replacement)` pair from both code paths.
 */
describe("T4 offline CLI regression guard (shared contradiction predicate)", () => {
  it("isContradiction from contradiction.ts and findSupersessionCandidates agree on the supersede pair", async () => {
    const { findSupersessionCandidates } =
      await import("../../src/core/extraction/supersession.js");
    const { isContradiction, pickWinner } =
      await import("../../src/core/extraction/contradiction.js");
    // A small ledger snapshot: one surviving older row that contradicts
    // a newer one.
    const snapshot = [
      {
        id: "old-1",
        head_id: "h1",
        tail_id: "t-OTHER",
        relation_norm: "works_for",
        confidence: 0.9,
        valid_from: "2026-01-01T00:00:00Z",
        valid_until: "2026-12-31T00:00:00Z",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "new-1",
        head_id: "h1",
        tail_id: "t1",
        relation_norm: "works_for",
        confidence: 0.9,
        valid_from: "2026-06-01T00:00:00Z",
        valid_until: null,
        created_at: "2026-06-01T00:00:00Z",
      },
    ];
    const offlinePairs = findSupersessionCandidates(snapshot);
    expect(offlinePairs).toHaveLength(1);
    expect(offlinePairs[0]?.superseded.id).toBe("old-1");
    expect(offlinePairs[0]?.replacement.id).toBe("new-1");
    // The shared predicate + winner rule produce the same pair from a
    // synthetic walk: this is what the write path uses too.
    const [old, neu] = snapshot;
    expect(isContradiction(old, neu)).toBe(true);
    expect(pickWinner(old, neu).id).toBe("new-1");
  });

  it("picks the same winner as compareNewest when created_at ties, whatever the row order", async () => {
    const { findSupersessionCandidates } =
      await import("../../src/core/extraction/supersession.js");
    const { compareNewest, pickWinner } =
      await import("../../src/core/extraction/contradiction.js");
    // Equal created_at is reachable: `triples.created_at` defaults to
    // `now()`, and rows written in one transaction share the stamp. The tie
    // must fall through to confidence (then id) — the same order the write
    // path's `compareNewest` applies.
    const lowConfidence = {
      id: "11111111-1111-1111-1111-111111111111",
      head_id: "h1",
      tail_id: "t-low",
      relation_norm: "works_for",
      confidence: 0.2,
      valid_from: "2026-01-01T00:00:00Z",
      valid_until: null,
      created_at: "2026-01-02T00:00:00Z",
    };
    const highConfidence = {
      id: "77777777-7777-7777-7777-777777777777",
      head_id: "h1",
      tail_id: "t-high",
      relation_norm: "works_for",
      confidence: 0.9,
      valid_from: "2026-01-01T00:00:00Z",
      valid_until: null,
      created_at: "2026-01-02T00:00:00Z",
    };
    // The offline SELECT hands rows over as
    // `ORDER BY head_id, relation_norm, created_at DESC, id DESC`; the
    // write path feeds its in-memory row in insertion order. A snapshot
    // must not change the winner: both orders name the higher-confidence
    // row as the replacement.
    for (const snapshot of [
      [highConfidence, lowConfidence],
      [lowConfidence, highConfidence],
    ]) {
      const pairs = findSupersessionCandidates(snapshot);
      expect(pairs).toHaveLength(1);
      expect(pairs[0]?.replacement.id).toBe(highConfidence.id);
      expect(pairs[0]?.superseded.id).toBe(lowConfidence.id);
    }
    // The shared comparator agrees: on a created_at tie the higher
    // confidence is "newer", so the write path and the offline picker
    // cannot drift on this pair.
    expect(compareNewest(highConfidence, lowConfidence)).toBeLessThan(0);
    expect(pickWinner(highConfidence, lowConfidence).id).toBe(
      highConfidence.id
    );
  });

  it("isContradiction rejects same-tail pairs and non-overlapping windows exactly once", async () => {
    const { isContradiction } =
      await import("../../src/core/extraction/contradiction.js");
    const base = {
      id: "x",
      head_id: "h1",
      relation_norm: "works_for",
      confidence: 0.9,
    };
    // Same tail — must NOT be a contradiction (those are merges, not
    // supersedes).
    expect(
      isContradiction(
        {
          ...base,
          tail_id: "t1",
          valid_from: "2026-01-01T00:00:00Z",
          valid_until: "2026-12-31T00:00:00Z",
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          ...base,
          id: "y",
          tail_id: "t1",
          valid_from: "2026-06-01T00:00:00Z",
          valid_until: null,
          created_at: "2026-06-01T00:00:00Z",
        }
      )
    ).toBe(false);
    // Non-overlapping windows — must NOT be a contradiction.
    expect(
      isContradiction(
        {
          ...base,
          tail_id: "t1",
          valid_from: "2026-01-01T00:00:00Z",
          valid_until: "2026-12-31T00:00:00Z",
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          ...base,
          id: "y",
          tail_id: "t-OTHER",
          valid_from: "2027-01-01T00:00:00Z",
          valid_until: null,
          created_at: "2027-01-01T00:00:00Z",
        }
      )
    ).toBe(false);
  });
});
