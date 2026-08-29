/**
 * Provenance-strict gold loader (specs/p0-eval.md A5, A7, A9, SC8, SC11).
 *
 * SC11 is the whole point of this loader: a gold triple that cannot say
 * which model produced it, under which prompt hash, from which snapshot
 * chunk, with which raw output and which filter verdict, is not gold —
 * it is an unlabelled number. Every missing or contradictory provenance
 * field is a typed error naming the offending triple, never a lenient
 * default that would let a stale gold model's leftovers keep scoring.
 *
 * The suite is pure in-memory / temp-file: no gold LLM, no network.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertGoldMatchesSnapshot,
  loadGoldSet,
  parseGoldSet,
} from "../../src/core/extraction-eval/gold.js";
import { parseChunkSnapshot } from "../../src/core/extraction-eval/snapshot.js";
import { ExtractionGoldError } from "../../src/core/extraction-eval/errors.js";
import { SNAPSHOT_MIN_CHUNKS } from "../../src/core/extraction-eval/types.js";
import { UNMAPPED } from "../../src/core/extraction/vocabulary.js";

const GOLD_MODEL = "gold-family-b/model-1";
const PROMPT_HASH = "sha256:2f1c0b";

const scratchDirs: string[] = [];

function scratchFile(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-extraction-eval-gold-"));
  scratchDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  return path;
}

function goldTriple(index: number): Record<string, unknown> {
  return {
    head: `Alice ${index}`,
    relation_norm: "works_for",
    tail: `Acme ${index}`,
    evidence_span: `Alice ${index} works for Acme ${index}.`,
    confidence: 0.9,
    provenance: {
      model_id: GOLD_MODEL,
      prompt_hash: PROMPT_HASH,
      chunk_id: `chunk-${index}`,
      raw_output: `{"head":"Alice ${index}","relation":"works for"}`,
      filter_verdict: "accept",
    },
  };
}

function goldSetOf(tripleCount: number): Record<string, unknown> {
  return {
    snapshot_id: "extraction-snapshot-test-v1",
    gold_model: GOLD_MODEL,
    prompt_hash: PROMPT_HASH,
    triples: Array.from({ length: tripleCount }, (_, i) => goldTriple(i + 1)),
  };
}

function snapshotOf(chunkCount: number): unknown {
  return {
    id: "extraction-snapshot-test-v1",
    chunks: Array.from({ length: chunkCount }, (_, i) => ({
      id: `chunk-${i + 1}`,
      content: `Alice ${i + 1} works for Acme ${i + 1}.`,
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

describe("gold set happy path", () => {
  it("loads a fully provenanced gold set and keeps every field", () => {
    const gold = parseGoldSet(goldSetOf(2), "inline");

    expect(gold.snapshot_id).toBe("extraction-snapshot-test-v1");
    expect(gold.gold_model).toBe(GOLD_MODEL);
    expect(gold.prompt_hash).toBe(PROMPT_HASH);
    expect(gold.triples).toHaveLength(2);
    expect(gold.triples[0]!.provenance).toEqual({
      model_id: GOLD_MODEL,
      prompt_hash: PROMPT_HASH,
      chunk_id: "chunk-1",
      raw_output: '{"head":"Alice 1","relation":"works for"}',
      filter_verdict: "accept",
    });
  });

  it("loads a gold set from disk", () => {
    const path = scratchFile("gold.json", JSON.stringify(goldSetOf(3)));

    const gold = loadGoldSet(path);

    expect(gold.triples).toHaveLength(3);
    expect(gold.triples[2]!.provenance.chunk_id).toBe("chunk-3");
  });

  it("keeps a rejected triple with its filter reason", () => {
    const raw = goldSetOf(1);
    const triple = (raw["triples"] as Array<Record<string, unknown>>)[0]!;
    triple["provenance"] = {
      ...(triple["provenance"] as Record<string, unknown>),
      filter_verdict: "reject",
      filter_reason: "no-grounding",
    };

    const gold = parseGoldSet(raw, "inline");

    expect(gold.triples[0]!.provenance.filter_verdict).toBe("reject");
    expect(gold.triples[0]!.provenance.filter_reason).toBe("no-grounding");
  });

  it("records the sampling seed when the gold run reported one", () => {
    const raw = goldSetOf(1);
    const triple = (raw["triples"] as Array<Record<string, unknown>>)[0]!;
    triple["provenance"] = {
      ...(triple["provenance"] as Record<string, unknown>),
      seed: 7,
    };

    const gold = parseGoldSet(raw, "inline");

    expect(gold.triples[0]!.provenance.seed).toBe(7);
  });

  it("accepts a gold set with no triples so the scorer decides what empty gold means", () => {
    const gold = parseGoldSet(goldSetOf(0), "inline");

    expect(gold.triples).toEqual([]);
  });

  it("accepts the UNMAPPED sentinel as a gold relation", () => {
    const raw = goldSetOf(1);
    (raw["triples"] as Array<Record<string, unknown>>)[0]!["relation_norm"] =
      UNMAPPED;

    const gold = parseGoldSet(raw, "inline");

    expect(gold.triples[0]!.relation_norm).toBe(UNMAPPED);
  });
});

describe("gold provenance strictness (SC11)", () => {
  it("rejects a triple with no provenance block at all", () => {
    const raw = goldSetOf(1);
    delete (raw["triples"] as Array<Record<string, unknown>>)[0]!["provenance"];

    const err = capture(() => parseGoldSet(raw, "inline"));

    expect(err).toBeInstanceOf(ExtractionGoldError);
    expect((err as ExtractionGoldError).code).toBe("GOLD_PROVENANCE_MISSING");
    expect((err as ExtractionGoldError).message).toContain("provenance");
  });

  const requiredFields = [
    "model_id",
    "prompt_hash",
    "chunk_id",
    "raw_output",
    "filter_verdict",
  ] as const;

  for (const field of requiredFields) {
    it(`rejects a triple whose provenance omits ${field}`, () => {
      const raw = goldSetOf(1);
      const provenance = (raw["triples"] as Array<Record<string, unknown>>)[0]![
        "provenance"
      ] as Record<string, unknown>;
      delete provenance[field];

      const err = capture(() => parseGoldSet(raw, "inline"));

      expect(err).toBeInstanceOf(ExtractionGoldError);
      expect((err as ExtractionGoldError).code).toBe("GOLD_PROVENANCE_MISSING");
      expect((err as ExtractionGoldError).message).toContain(field);
    });
  }

  it("rejects a filter verdict outside accept / reject", () => {
    const raw = goldSetOf(1);
    const provenance = (raw["triples"] as Array<Record<string, unknown>>)[0]![
      "provenance"
    ] as Record<string, unknown>;
    provenance["filter_verdict"] = "probably-fine";

    const err = capture(() => parseGoldSet(raw, "inline"));

    expect(err).toBeInstanceOf(ExtractionGoldError);
    expect((err as ExtractionGoldError).code).toBe("GOLD_PROVENANCE_INVALID");
  });

  it("rejects a triple stamped by a different model than the gold set header", () => {
    const raw = goldSetOf(1);
    const provenance = (raw["triples"] as Array<Record<string, unknown>>)[0]![
      "provenance"
    ] as Record<string, unknown>;
    provenance["model_id"] = "gold-family-c/model-9";

    const err = capture(() => parseGoldSet(raw, "inline"));

    expect(err).toBeInstanceOf(ExtractionGoldError);
    expect((err as ExtractionGoldError).code).toBe("GOLD_PROVENANCE_MISMATCH");
    expect((err as ExtractionGoldError).message).toContain(
      "gold-family-c/model-9"
    );
  });

  it("rejects a triple stamped with a stale prompt hash", () => {
    const raw = goldSetOf(1);
    const provenance = (raw["triples"] as Array<Record<string, unknown>>)[0]![
      "provenance"
    ] as Record<string, unknown>;
    provenance["prompt_hash"] = "sha256:stale";

    const err = capture(() => parseGoldSet(raw, "inline"));

    expect(err).toBeInstanceOf(ExtractionGoldError);
    expect((err as ExtractionGoldError).code).toBe("GOLD_PROVENANCE_MISMATCH");
  });

  it("rejects a gold set whose header omits the gold model id", () => {
    const raw = goldSetOf(1);
    delete raw["gold_model"];

    const err = capture(() => parseGoldSet(raw, "inline"));

    expect(err).toBeInstanceOf(ExtractionGoldError);
    expect((err as ExtractionGoldError).code).toBe("GOLD_MALFORMED");
  });
});

describe("gold triple field validation", () => {
  it("rejects a relation outside the extraction vocabulary", () => {
    const raw = goldSetOf(1);
    (raw["triples"] as Array<Record<string, unknown>>)[0]!["relation_norm"] =
      "employs_but_casually";

    const err = capture(() => parseGoldSet(raw, "inline"));

    expect(err).toBeInstanceOf(ExtractionGoldError);
    expect((err as ExtractionGoldError).code).toBe("GOLD_TRIPLE_INVALID");
    expect((err as ExtractionGoldError).message).toContain(
      "employs_but_casually"
    );
  });

  it("rejects a triple with a blank head", () => {
    const raw = goldSetOf(1);
    (raw["triples"] as Array<Record<string, unknown>>)[0]!["head"] = "  ";

    const err = capture(() => parseGoldSet(raw, "inline"));

    expect(err).toBeInstanceOf(ExtractionGoldError);
    expect((err as ExtractionGoldError).code).toBe("GOLD_TRIPLE_INVALID");
  });

  it("rejects a triple with a blank evidence span", () => {
    const raw = goldSetOf(1);
    (raw["triples"] as Array<Record<string, unknown>>)[0]!["evidence_span"] =
      "";

    const err = capture(() => parseGoldSet(raw, "inline"));

    expect(err).toBeInstanceOf(ExtractionGoldError);
    expect((err as ExtractionGoldError).code).toBe("GOLD_TRIPLE_INVALID");
  });

  it("rejects a confidence below 0", () => {
    const raw = goldSetOf(1);
    (raw["triples"] as Array<Record<string, unknown>>)[0]!["confidence"] = -0.1;

    const err = capture(() => parseGoldSet(raw, "inline"));

    expect(err).toBeInstanceOf(ExtractionGoldError);
    expect((err as ExtractionGoldError).code).toBe("GOLD_TRIPLE_INVALID");
  });

  it("rejects a confidence above 1", () => {
    const raw = goldSetOf(1);
    (raw["triples"] as Array<Record<string, unknown>>)[0]!["confidence"] = 1.2;

    const err = capture(() => parseGoldSet(raw, "inline"));

    expect(err).toBeInstanceOf(ExtractionGoldError);
    expect((err as ExtractionGoldError).code).toBe("GOLD_TRIPLE_INVALID");
  });

  it("accepts confidence at both ends of [0,1]", () => {
    const raw = goldSetOf(2);
    const triples = raw["triples"] as Array<Record<string, unknown>>;
    triples[0]!["confidence"] = 0;
    triples[1]!["confidence"] = 1;

    const gold = parseGoldSet(raw, "inline");

    expect(gold.triples.map((t) => t.confidence)).toEqual([0, 1]);
  });

  it("rejects a payload whose triples key is not an array", () => {
    const raw = goldSetOf(1);
    raw["triples"] = {};

    const err = capture(() => parseGoldSet(raw, "inline"));

    expect(err).toBeInstanceOf(ExtractionGoldError);
    expect((err as ExtractionGoldError).code).toBe("GOLD_MALFORMED");
  });
});

describe("gold set file reading", () => {
  it("reports a missing gold file as a typed error, not a raw ENOENT", () => {
    const err = capture(() => loadGoldSet(join(tmpdir(), "no-such-gold.json")));

    expect(err).toBeInstanceOf(ExtractionGoldError);
    expect((err as ExtractionGoldError).code).toBe("GOLD_FILE_MISSING");
  });

  it("rejects a zero-byte gold file and names the path", () => {
    const path = scratchFile("gold.json", "");

    const err = capture(() => loadGoldSet(path));

    expect(err).toBeInstanceOf(ExtractionGoldError);
    expect((err as ExtractionGoldError).code).toBe("GOLD_FILE_EMPTY");
    expect((err as ExtractionGoldError).message).toContain(path);
  });

  it("rejects a gold file that is not JSON", () => {
    const path = scratchFile("gold.json", "{not json");

    const err = capture(() => loadGoldSet(path));

    expect(err).toBeInstanceOf(ExtractionGoldError);
    expect((err as ExtractionGoldError).code).toBe("GOLD_MALFORMED");
  });
});

describe("gold set against its frozen snapshot", () => {
  it("accepts gold whose triples all point into the named snapshot", () => {
    const snapshot = parseChunkSnapshot(snapshotOf(SNAPSHOT_MIN_CHUNKS), "s");
    const gold = parseGoldSet(goldSetOf(4), "inline");

    expect(() => assertGoldMatchesSnapshot(gold, snapshot)).not.toThrow();
  });

  it("rejects gold built against a different snapshot id", () => {
    const raw = snapshotOf(SNAPSHOT_MIN_CHUNKS) as { id: string };
    raw.id = "extraction-snapshot-test-v2";
    const snapshot = parseChunkSnapshot(raw, "s");
    const gold = parseGoldSet(goldSetOf(1), "inline");

    const err = capture(() => assertGoldMatchesSnapshot(gold, snapshot));

    expect(err).toBeInstanceOf(ExtractionGoldError);
    expect((err as ExtractionGoldError).code).toBe("GOLD_SNAPSHOT_MISMATCH");
    expect((err as ExtractionGoldError).message).toContain(
      "extraction-snapshot-test-v2"
    );
  });

  it("rejects a gold triple pointing at a chunk the snapshot does not contain", () => {
    const snapshot = parseChunkSnapshot(snapshotOf(SNAPSHOT_MIN_CHUNKS), "s");
    const raw = goldSetOf(1);
    const provenance = (raw["triples"] as Array<Record<string, unknown>>)[0]![
      "provenance"
    ] as Record<string, unknown>;
    provenance["chunk_id"] = "chunk-999";
    const gold = parseGoldSet(raw, "inline");

    const err = capture(() => assertGoldMatchesSnapshot(gold, snapshot));

    expect(err).toBeInstanceOf(ExtractionGoldError);
    expect((err as ExtractionGoldError).code).toBe("GOLD_CHUNK_UNKNOWN");
    expect((err as ExtractionGoldError).message).toContain("chunk-999");
  });
});
