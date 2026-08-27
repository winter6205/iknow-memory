/**
 * Gold + corpus fixture loading (specs/retrieve-p5.md T1, SC3 and the
 * SC9 empty / overflow classes).
 *
 * A baseline number is only worth recording if the fixture behind it is
 * frozen and self-consistent, so every way a fixture can be wrong fails
 * typed and loud here rather than quietly producing a plausible P@5:
 *   - an empty / unreadable / malformed file
 *   - a gold set outside the 8–15 query band (A8)
 *   - a query with no text, a duplicate id, or an empty relevant set
 *   - a gold id that names a chunk the frozen corpus does not contain
 *
 * The in-repo fixtures are read through the same loaders the CLI uses, so
 * `npm test` is the validate step SC3 asks for.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GOLD_MAX_QUERIES,
  GOLD_MIN_QUERIES,
  loadGoldSet,
  parseGoldSet,
} from "../../src/core/eval/gold.js";
import { loadCorpus, parseCorpus } from "../../src/core/eval/corpus.js";
import {
  CorpusFixtureError,
  GoldFixtureError,
} from "../../src/core/eval/errors.js";
import {
  DEFAULT_CORPUS_PATH,
  DEFAULT_GOLD_PATH,
} from "../../src/core/eval/paths.js";

const scratchDirs: string[] = [];

function scratchFile(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-eval-gold-"));
  scratchDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  return path;
}

function goldQueries(count: number): unknown {
  return {
    version: "test-v1",
    corpus: "test-corpus-v1",
    queries: Array.from({ length: count }, (_, i) => ({
      id: `q${i + 1}`,
      query: `question ${i + 1}`,
      relevant: [`c-${i + 1}`],
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

describe("in-repo frozen fixtures (SC3)", () => {
  it("holds between 8 and 15 gold queries inclusive", () => {
    const gold = loadGoldSet(DEFAULT_GOLD_PATH);

    expect(gold.queries.length).toBeGreaterThanOrEqual(GOLD_MIN_QUERIES);
    expect(gold.queries.length).toBeLessThanOrEqual(GOLD_MAX_QUERIES);
  });

  it("gives every gold query a unique id and non-empty relevant set", () => {
    const gold = loadGoldSet(DEFAULT_GOLD_PATH);

    const ids = gold.queries.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const query of gold.queries) {
      expect(query.query.trim().length).toBeGreaterThan(0);
      expect(query.relevant.length).toBeGreaterThan(0);
    }
  });

  it("only marks chunk ids the frozen corpus actually contains", () => {
    const gold = loadGoldSet(DEFAULT_GOLD_PATH);
    const corpus = loadCorpus(DEFAULT_CORPUS_PATH);
    const known = new Set(corpus.chunks.map((chunk) => chunk.id));

    const dangling = gold.queries
      .flatMap((q) => q.relevant)
      .filter((id) => !known.has(id));

    expect(dangling).toEqual([]);
  });

  it("names the corpus the gold was written against", () => {
    const gold = loadGoldSet(DEFAULT_GOLD_PATH);
    const corpus = loadCorpus(DEFAULT_CORPUS_PATH);

    expect(gold.corpus).toBe(corpus.version);
  });

  it("keeps at least 5 corpus chunks so a top-5 window can be filled", () => {
    const corpus = loadCorpus(DEFAULT_CORPUS_PATH);

    expect(corpus.chunks.length).toBeGreaterThanOrEqual(5);
  });
});

describe("gold fixture — empty class (SC9)", () => {
  it("rejects a zero-byte gold file and names the path", () => {
    const path = scratchFile("gold.json", "");

    const err = capture(() => loadGoldSet(path));

    expect(err).toBeInstanceOf(GoldFixtureError);
    expect((err as GoldFixtureError).code).toBe("GOLD_FILE_EMPTY");
    expect((err as GoldFixtureError).message).toContain(path);
  });

  it("rejects a gold file with an empty query list", () => {
    const err = capture(() => parseGoldSet(goldQueries(0), "inline"));

    expect(err).toBeInstanceOf(GoldFixtureError);
    expect((err as GoldFixtureError).code).toBe("GOLD_EMPTY");
  });

  it("rejects a query whose relevant set is empty", () => {
    const raw = goldQueries(GOLD_MIN_QUERIES) as {
      queries: Array<{ id: string; relevant: string[] }>;
    };
    raw.queries[2]!.relevant = [];

    const err = capture(() => parseGoldSet(raw, "inline"));

    expect(err).toBeInstanceOf(GoldFixtureError);
    expect((err as GoldFixtureError).code).toBe("GOLD_RELEVANT_EMPTY");
    expect((err as GoldFixtureError).message).toContain("q3");
  });

  it("rejects a query with a blank question string", () => {
    const raw = goldQueries(GOLD_MIN_QUERIES) as {
      queries: Array<{ id: string; query: string }>;
    };
    raw.queries[0]!.query = "   ";

    const err = capture(() => parseGoldSet(raw, "inline"));

    expect(err).toBeInstanceOf(GoldFixtureError);
    expect((err as GoldFixtureError).code).toBe("GOLD_QUERY_INVALID");
  });
});

describe("gold fixture — overflow / size class (SC3, SC9)", () => {
  it(`rejects ${GOLD_MIN_QUERIES - 1} queries as below the band`, () => {
    const err = capture(() =>
      parseGoldSet(goldQueries(GOLD_MIN_QUERIES - 1), "inline")
    );

    expect(err).toBeInstanceOf(GoldFixtureError);
    expect((err as GoldFixtureError).code).toBe("GOLD_SIZE_OUT_OF_RANGE");
    expect((err as GoldFixtureError).message).toContain(
      String(GOLD_MAX_QUERIES)
    );
  });

  it(`rejects ${GOLD_MAX_QUERIES + 1} queries as above the band`, () => {
    const err = capture(() =>
      parseGoldSet(goldQueries(GOLD_MAX_QUERIES + 1), "inline")
    );

    expect(err).toBeInstanceOf(GoldFixtureError);
    expect((err as GoldFixtureError).code).toBe("GOLD_SIZE_OUT_OF_RANGE");
  });

  it("accepts both ends of the band", () => {
    expect(
      parseGoldSet(goldQueries(GOLD_MIN_QUERIES), "inline").queries
    ).toHaveLength(GOLD_MIN_QUERIES);
    expect(
      parseGoldSet(goldQueries(GOLD_MAX_QUERIES), "inline").queries
    ).toHaveLength(GOLD_MAX_QUERIES);
  });
});

describe("gold fixture — malformed class", () => {
  it("rejects a duplicate query id", () => {
    const raw = goldQueries(GOLD_MIN_QUERIES) as {
      queries: Array<{ id: string }>;
    };
    raw.queries[4]!.id = raw.queries[1]!.id;

    const err = capture(() => parseGoldSet(raw, "inline"));

    expect(err).toBeInstanceOf(GoldFixtureError);
    expect((err as GoldFixtureError).code).toBe("GOLD_QUERY_INVALID");
    expect((err as GoldFixtureError).message).toContain("q2");
  });

  it("rejects a file that is not JSON", () => {
    const path = scratchFile("gold.json", "{not json");

    const err = capture(() => loadGoldSet(path));

    expect(err).toBeInstanceOf(GoldFixtureError);
    expect((err as GoldFixtureError).code).toBe("GOLD_MALFORMED");
  });

  it("rejects a payload whose queries key is not an array", () => {
    const err = capture(() =>
      parseGoldSet({ version: "v", corpus: "c", queries: {} }, "inline")
    );

    expect(err).toBeInstanceOf(GoldFixtureError);
    expect((err as GoldFixtureError).code).toBe("GOLD_MALFORMED");
  });

  it("reports a missing file as a typed fixture error, not a raw ENOENT", () => {
    const err = capture(() => loadGoldSet(join(tmpdir(), "no-such-gold.json")));

    expect(err).toBeInstanceOf(GoldFixtureError);
    expect((err as GoldFixtureError).code).toBe("GOLD_FILE_MISSING");
  });
});

describe("corpus fixture", () => {
  it("loads the frozen corpus with unique chunk ids", () => {
    const corpus = loadCorpus(DEFAULT_CORPUS_PATH);

    const ids = corpus.chunks.map((chunk) => chunk.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const chunk of corpus.chunks) {
      expect(chunk.content.trim().length).toBeGreaterThan(0);
      expect(chunk.source_ref.length).toBeGreaterThan(0);
    }
  });

  it("rejects an empty chunk list", () => {
    const err = capture(() =>
      parseCorpus({ version: "v", chunks: [] }, "inline")
    );

    expect(err).toBeInstanceOf(CorpusFixtureError);
    expect((err as CorpusFixtureError).code).toBe("CORPUS_EMPTY");
  });

  it("rejects a duplicate chunk id", () => {
    const chunk = {
      id: "c-1",
      content: "hello",
      source_ref: "doc#1",
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_until: null,
    };

    const err = capture(() =>
      parseCorpus({ version: "v", chunks: [chunk, { ...chunk }] }, "inline")
    );

    expect(err).toBeInstanceOf(CorpusFixtureError);
    expect((err as CorpusFixtureError).code).toBe("CORPUS_DUPLICATE_CHUNK_ID");
    expect((err as CorpusFixtureError).message).toContain("c-1");
  });

  it("rejects a chunk with no content", () => {
    const err = capture(() =>
      parseCorpus(
        {
          version: "v",
          chunks: [
            {
              id: "c-1",
              content: "  ",
              source_ref: "doc#1",
              valid_from: "2026-01-01T00:00:00.000Z",
              valid_until: null,
            },
          ],
        },
        "inline"
      )
    );

    expect(err).toBeInstanceOf(CorpusFixtureError);
    expect((err as CorpusFixtureError).code).toBe("CORPUS_CHUNK_INVALID");
  });

  it("reports a missing corpus file as a typed fixture error", () => {
    const err = capture(() =>
      loadCorpus(join(tmpdir(), "no-such-corpus.json"))
    );

    expect(err).toBeInstanceOf(CorpusFixtureError);
    expect((err as CorpusFixtureError).code).toBe("CORPUS_FILE_MISSING");
  });
});
