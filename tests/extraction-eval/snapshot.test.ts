/**
 * Frozen chunk snapshot loader (specs/p0-eval.md A5, A9, SC8).
 *
 * The snapshot is the ruler every extraction-F1 number is measured
 * against, so every way it can be wrong fails typed and loud here rather
 * than quietly shifting the baseline: a file outside the frozen 10–40
 * band, a duplicate chunk id, a blank chunk body, or an unreadable file.
 *
 * Everything runs off in-memory payloads and temp files — no live LLM,
 * no network, no Postgres.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadChunkSnapshot,
  parseChunkSnapshot,
} from "../../src/core/extraction-eval/snapshot.js";
import { ChunkSnapshotError } from "../../src/core/extraction-eval/errors.js";
import {
  SNAPSHOT_MAX_CHUNKS,
  SNAPSHOT_MIN_CHUNKS,
} from "../../src/core/extraction-eval/types.js";

const scratchDirs: string[] = [];

function scratchFile(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-extraction-eval-snapshot-"));
  scratchDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  return path;
}

function snapshotOf(chunkCount: number): unknown {
  return {
    id: "extraction-snapshot-test-v1",
    chunks: Array.from({ length: chunkCount }, (_, i) => ({
      id: `chunk-${i + 1}`,
      content: `Alice works for Acme in sentence ${i + 1}.`,
      source_ref: `doc-a#${i + 1}`,
    })),
  };
}

/** Catch and return the thrown value so a test can assert on its type. */
function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe("chunk snapshot size band (SC8)", () => {
  it(`accepts the ${SNAPSHOT_MIN_CHUNKS}-chunk lower bound`, () => {
    const snapshot = parseChunkSnapshot(
      snapshotOf(SNAPSHOT_MIN_CHUNKS),
      "inline"
    );

    expect(snapshot.chunks).toHaveLength(SNAPSHOT_MIN_CHUNKS);
    expect(snapshot.id).toBe("extraction-snapshot-test-v1");
  });

  it(`accepts the ${SNAPSHOT_MAX_CHUNKS}-chunk upper bound`, () => {
    const snapshot = parseChunkSnapshot(
      snapshotOf(SNAPSHOT_MAX_CHUNKS),
      "inline"
    );

    expect(snapshot.chunks).toHaveLength(SNAPSHOT_MAX_CHUNKS);
  });

  it(`rejects ${SNAPSHOT_MIN_CHUNKS - 1} chunks as below the frozen band`, () => {
    const err = capture(() =>
      parseChunkSnapshot(snapshotOf(SNAPSHOT_MIN_CHUNKS - 1), "inline")
    );

    expect(err).toBeInstanceOf(ChunkSnapshotError);
    expect((err as ChunkSnapshotError).code).toBe("SNAPSHOT_SIZE_OUT_OF_RANGE");
    expect((err as ChunkSnapshotError).message).toContain(
      String(SNAPSHOT_MIN_CHUNKS)
    );
    expect((err as ChunkSnapshotError).message).toContain(
      String(SNAPSHOT_MAX_CHUNKS)
    );
  });

  it(`rejects ${SNAPSHOT_MAX_CHUNKS + 1} chunks as above the frozen band`, () => {
    const err = capture(() =>
      parseChunkSnapshot(snapshotOf(SNAPSHOT_MAX_CHUNKS + 1), "inline")
    );

    expect(err).toBeInstanceOf(ChunkSnapshotError);
    expect((err as ChunkSnapshotError).code).toBe("SNAPSHOT_SIZE_OUT_OF_RANGE");
  });

  it("reports a chunk-less snapshot as empty rather than out of range", () => {
    const err = capture(() => parseChunkSnapshot(snapshotOf(0), "inline"));

    expect(err).toBeInstanceOf(ChunkSnapshotError);
    expect((err as ChunkSnapshotError).code).toBe("SNAPSHOT_EMPTY");
  });
});

describe("chunk snapshot content validation", () => {
  it("rejects a snapshot without a non-blank id", () => {
    const raw = snapshotOf(SNAPSHOT_MIN_CHUNKS) as { id: string };
    raw.id = "   ";

    const err = capture(() => parseChunkSnapshot(raw, "inline"));

    expect(err).toBeInstanceOf(ChunkSnapshotError);
    expect((err as ChunkSnapshotError).code).toBe("SNAPSHOT_MALFORMED");
  });

  it("rejects a chunk whose text is blank", () => {
    const raw = snapshotOf(SNAPSHOT_MIN_CHUNKS) as {
      chunks: Array<{ content: string }>;
    };
    raw.chunks[3]!.content = "   ";

    const err = capture(() => parseChunkSnapshot(raw, "inline"));

    expect(err).toBeInstanceOf(ChunkSnapshotError);
    expect((err as ChunkSnapshotError).code).toBe("SNAPSHOT_CHUNK_INVALID");
    expect((err as ChunkSnapshotError).message).toContain("chunk-4");
  });

  it("rejects a chunk with no source reference", () => {
    const raw = snapshotOf(SNAPSHOT_MIN_CHUNKS) as {
      chunks: Array<Record<string, unknown>>;
    };
    delete raw.chunks[0]!["source_ref"];

    const err = capture(() => parseChunkSnapshot(raw, "inline"));

    expect(err).toBeInstanceOf(ChunkSnapshotError);
    expect((err as ChunkSnapshotError).code).toBe("SNAPSHOT_CHUNK_INVALID");
  });

  it("rejects a duplicate chunk id and names it", () => {
    const raw = snapshotOf(SNAPSHOT_MIN_CHUNKS) as {
      chunks: Array<{ id: string }>;
    };
    raw.chunks[5]!.id = raw.chunks[2]!.id;

    const err = capture(() => parseChunkSnapshot(raw, "inline"));

    expect(err).toBeInstanceOf(ChunkSnapshotError);
    expect((err as ChunkSnapshotError).code).toBe(
      "SNAPSHOT_DUPLICATE_CHUNK_ID"
    );
    expect((err as ChunkSnapshotError).message).toContain("chunk-3");
  });

  it("rejects a payload whose chunks key is not an array", () => {
    const err = capture(() =>
      parseChunkSnapshot({ id: "s1", chunks: {} }, "inline")
    );

    expect(err).toBeInstanceOf(ChunkSnapshotError);
    expect((err as ChunkSnapshotError).code).toBe("SNAPSHOT_MALFORMED");
  });
});

describe("chunk snapshot file reading", () => {
  it("loads a well-formed snapshot file from disk", () => {
    const path = scratchFile(
      "snapshot.json",
      JSON.stringify(snapshotOf(SNAPSHOT_MIN_CHUNKS))
    );

    const snapshot = loadChunkSnapshot(path);

    expect(snapshot.chunks).toHaveLength(SNAPSHOT_MIN_CHUNKS);
    expect(snapshot.chunks[0]!.content).toContain("Alice works for Acme");
  });

  it("reports a missing snapshot file as a typed error, not a raw ENOENT", () => {
    const err = capture(() =>
      loadChunkSnapshot(join(tmpdir(), "no-such-snapshot.json"))
    );

    expect(err).toBeInstanceOf(ChunkSnapshotError);
    expect((err as ChunkSnapshotError).code).toBe("SNAPSHOT_FILE_MISSING");
  });

  it("rejects a zero-byte snapshot file and names the path", () => {
    const path = scratchFile("snapshot.json", "");

    const err = capture(() => loadChunkSnapshot(path));

    expect(err).toBeInstanceOf(ChunkSnapshotError);
    expect((err as ChunkSnapshotError).code).toBe("SNAPSHOT_FILE_EMPTY");
    expect((err as ChunkSnapshotError).message).toContain(path);
  });

  it("rejects a snapshot file that is not JSON", () => {
    const path = scratchFile("snapshot.json", "{not json");

    const err = capture(() => loadChunkSnapshot(path));

    expect(err).toBeInstanceOf(ChunkSnapshotError);
    expect((err as ChunkSnapshotError).code).toBe("SNAPSHOT_MALFORMED");
  });
});
