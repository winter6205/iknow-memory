/**
 * Frozen snapshot v1 fixture (specs/p0-eval.md A5, SC8; E-T8).
 *
 * The snapshot is committed to git (`gold-set/snapshot.json`) so the
 * extraction-F1 ruler stays comparable across runs — every bootstrap
 * run, every gold rebuild, every gate verdict pins to this file. The
 * 10–40 chunk band is enforced by the snapshot loader, so the suite
 * itself is the regression trip: a future snapshot that silently
 * grew past 40 (or shrank below 10) fails `loadChunkSnapshot` rather
 * than moving every baseline number without anyone noticing.
 *
 * Pure: no live LLM, no Postgres, no Neo4j.
 */
import { describe, it, expect } from "vitest";

import { loadChunkSnapshot } from "../../src/core/extraction-eval/snapshot.js";
import {
  SNAPSHOT_MAX_CHUNKS,
  SNAPSHOT_MIN_CHUNKS,
} from "../../src/core/extraction-eval/types.js";

const SNAPSHOT_PATH = "gold-set/snapshot.json";

describe("frozen chunk snapshot v1 fixture (A5 / SC8 / E-T8)", () => {
  it("loads the committed snapshot from the repo root", () => {
    const snapshot = loadChunkSnapshot(SNAPSHOT_PATH);

    expect(snapshot.id.length).toBeGreaterThan(0);
    expect(snapshot.id).not.toBe(" ");
  });

  it(`carries ${SNAPSHOT_MIN_CHUNKS}–${SNAPSHOT_MAX_CHUNKS} chunks inclusive`, () => {
    const snapshot = loadChunkSnapshot(SNAPSHOT_PATH);

    expect(snapshot.chunks.length).toBeGreaterThanOrEqual(SNAPSHOT_MIN_CHUNKS);
    expect(snapshot.chunks.length).toBeLessThanOrEqual(SNAPSHOT_MAX_CHUNKS);
  });

  it("stamps every chunk with non-blank id / content / source_ref", () => {
    const snapshot = loadChunkSnapshot(SNAPSHOT_PATH);

    for (const chunk of snapshot.chunks) {
      expect(chunk.id).toBeTypeOf("string");
      expect(chunk.id.trim().length).toBeGreaterThan(0);

      expect(chunk.content).toBeTypeOf("string");
      expect(chunk.content.trim().length).toBeGreaterThan(0);

      expect(chunk.source_ref).toBeTypeOf("string");
      expect(chunk.source_ref.trim().length).toBeGreaterThan(0);
    }
  });

  it("uses chunk ids that are unique across the snapshot", () => {
    // SC8: a duplicate chunk id would make gold provenance ambiguous.
    const snapshot = loadChunkSnapshot(SNAPSHOT_PATH);
    const seen = new Set<string>();
    for (const chunk of snapshot.chunks) {
      expect(seen.has(chunk.id)).toBe(false);
      seen.add(chunk.id);
    }
  });
});
