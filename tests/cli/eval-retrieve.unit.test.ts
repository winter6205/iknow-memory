/**
 * Eval CLI unit tests (specs/retrieve-p5.md T2 — SC4, SC5, SC6, SC9
 * exception/overflow classes, SC11; specs/retrieve-graph-priority.md
 * SC8 — arm set under graph-priority).
 *
 * Everything runs on FakeEmbedder + MemoryBackend, so the suite needs no
 * Postgres, no Neo4j and no network. The frozen offline evaluator explicitly
 * disables production-only graph and rerank adapters for byte stability.
 *
 * The load-bearing assertion is SC4: the CLI must score the SAME fused
 * ranking the MCP `retrieve` tool would return, not a private
 * reimplementation of RRF. That is proved by running the CLI with its
 * default (uninjected) assembler and comparing its recorded top-5 against
 * a direct `assembleRetrievalResult` call on an identically seeded store.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFileSync } from "node:fs";

import {
  parseArgs,
  runCli,
  runCliFromEnv,
  type EvalDeps,
} from "../../src/cli/eval-retrieve.js";
import { setSettingHomeForTests } from "../../src/config.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import { seedCorpus } from "../../src/core/eval/seed.js";
import { loadCorpus, loadGoldSet } from "../../src/core/eval/index.js";
import {
  DEFAULT_CORPUS_PATH,
  DEFAULT_GOLD_PATH,
} from "../../src/core/eval/paths.js";
import type {
  EntityChunkRow,
  GraphRanker,
  Neo4jArmStorage,
  RankedEntity,
  RetrieveConfig,
} from "../../src/core/retrieval/types.js";
import type { Logger } from "../../src/logging.js";

const DIM = 16;
const VALID_AT = "2026-06-01T00:00:00.000Z";

/** Frozen offline-evaluator config; production defaults are default-on. */
const RETRIEVE_CONFIG: RetrieveConfig = {
  w_vec: 0.7,
  w_bm25: 0.15,
  w_graph: 0.15,
  bm25Enabled: true,
  graphEnabled: false,
  rerankEnabled: false,
  entityLinkTopK: 8,
  candidateCap: 50,
  graphArmFloor: 3,
};

const GRAPH_RETRIEVE_CONFIG: RetrieveConfig = {
  ...RETRIEVE_CONFIG,
  graphEnabled: true,
};

const scratchDirs: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-eval-cli-"));
  scratchDirs.push(dir);
  return dir;
}

function silentLogger(): Logger {
  const noop = (): void => {};
  return { level: "error", debug: noop, info: noop, warn: noop, error: noop };
}

function makeDeps(over: Partial<EvalDeps> = {}): EvalDeps {
  return {
    embedder: new FakeEmbedder(DIM),
    storage: new MemoryBackend(DIM),
    retrieveConfig: RETRIEVE_CONFIG,
    logger: silentLogger(),
    ...over,
  };
}

function baseArgv(outPath: string, extra: string[] = []): string[] {
  return [
    "--gold",
    DEFAULT_GOLD_PATH,
    "--corpus",
    DEFAULT_CORPUS_PATH,
    "--out",
    outPath,
    "--valid-at",
    VALID_AT,
    ...extra,
  ];
}

interface BaselineFile {
  schema: string;
  gold: string;
  corpus: string;
  armSet: string;
  queryCount: number;
  meanPAt5: number;
  meanRAt5: number;
  queries: Array<{
    id: string;
    query: string;
    top5: string[];
    pAt5: number;
    rAt5: number;
  }>;
}

function readBaseline(path: string): BaselineFile {
  return JSON.parse(readFileSync(path, "utf8")) as BaselineFile;
}

/** Capture stderr for the run and give it back as one string. */
function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe("parseArgs", () => {
  it("defaults every path to the frozen in-repo artifact", () => {
    const parsed = parseArgs([]);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.flags.goldPath).toBe(DEFAULT_GOLD_PATH);
    expect(parsed.flags.corpusPath).toBe(DEFAULT_CORPUS_PATH);
  });

  it("rejects an unknown flag", () => {
    const parsed = parseArgs(["--nope"]);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("--nope");
  });

  it("rejects a non-positive limit", () => {
    expect(parseArgs(["--limit", "0"]).ok).toBe(false);
    expect(parseArgs(["--limit", "abc"]).ok).toBe(false);
  });

  it("rejects a flag that is missing its value", () => {
    expect(parseArgs(["--gold"]).ok).toBe(false);
  });
});

describe("eval CLI — no-URI run succeeds (SC5)", () => {
  it("exits 0 and records a two-arm run when no graph ranker is wired", async () => {
    const out = join(scratchDir(), "baseline.json");

    const code = await runCli(baseArgv(out), makeDeps());

    expect(code).toBe(0);
    expect(readBaseline(out).armSet).toBe("vector+bm25");
  });

  it("records a three-arm run when a graph ranker and seam are wired", async () => {
    const out = join(scratchDir(), "baseline.json");
    const storage = new MemoryBackend(DIM) as MemoryBackend & {
      neo4jArmSeed: Neo4jArmStorage;
    };
    storage.neo4jArmSeed = {
      async seedEntitiesByEmbedding(): Promise<
        Array<{ id: string; canonical_name: string }>
      > {
        return [{ id: "e-1", canonical_name: "fusion" }];
      },
      async chunksByEntityIds(): Promise<EntityChunkRow[]> {
        return [
          {
            entity_id: "e-1",
            id: "c-rrf-fusion",
            content: "reciprocal rank fusion",
            source_ref: "notes/hybrid-retrieval#rrf",
            valid_from: "2026-01-01T00:00:00.000Z",
            valid_until: null,
          },
        ];
      },
    };
    const graphRanker: GraphRanker = {
      async rankEntities(): Promise<RankedEntity[]> {
        return [{ id: "e-1", score: 1 }];
      },
    };

    const code = await runCli(
      baseArgv(out),
      makeDeps({
        storage,
        graphRanker,
        retrieveConfig: GRAPH_RETRIEVE_CONFIG,
      })
    );

    expect(code).toBe(0);
    expect(readBaseline(out).armSet).toBe("vector+bm25+graph");
  });
});

describe("eval CLI — graph-priority arm set (SC8)", () => {
  /**
   * A graph arm that maps one chunk id the seeded corpus does not
   * contain, so its contribution is unmistakable in the recorded ranking.
   */
  function graphWiring(chunkId: string): {
    storage: MemoryBackend;
    graphRanker: GraphRanker;
  } {
    const storage = new MemoryBackend(DIM) as MemoryBackend & {
      neo4jArmSeed: Neo4jArmStorage;
    };
    storage.neo4jArmSeed = {
      async seedEntitiesByEmbedding(): Promise<
        Array<{ id: string; canonical_name: string }>
      > {
        return [{ id: "e-1", canonical_name: "fusion" }];
      },
      async chunksByEntityIds(): Promise<EntityChunkRow[]> {
        return [
          {
            entity_id: "e-1",
            id: chunkId,
            content: "a chunk only the graph arm can reach",
            source_ref: "notes/graph-priority#lead",
            valid_from: "2026-01-01T00:00:00.000Z",
            valid_until: null,
          },
        ];
      },
    };
    return {
      storage,
      graphRanker: {
        async rankEntities(): Promise<RankedEntity[]> {
          return [{ id: "e-1", score: 1 }];
        },
      },
    };
  }

  it("records the graph arm's own order at the head, with vector+BM25 only filling", async () => {
    const withGraphOut = join(scratchDir(), "with-graph.json");
    const withoutGraphOut = join(scratchDir(), "without-graph.json");
    const { storage, graphRanker } = graphWiring("c-graph-lead");

    await runCli(
      baseArgv(withGraphOut),
      makeDeps({
        storage,
        graphRanker,
        retrieveConfig: GRAPH_RETRIEVE_CONFIG,
      })
    );
    await runCli(baseArgv(withoutGraphOut), makeDeps());

    const withGraph = readBaseline(withGraphOut);
    const withoutGraph = readBaseline(withoutGraphOut);
    expect(withGraph.armSet).toBe("vector+bm25+graph");
    for (const entry of withGraph.queries) {
      const fused = withoutGraph.queries.find((q) => q.id === entry.id);
      // Graph hit leads and the fused list is pushed down one slot
      // unchanged: the graph arm never re-weighted that fusion, which is
      // what a 0.7/0.15/0.15 three-arm vote would have done.
      expect(entry.top5[0]).toBe("c-graph-lead");
      expect(entry.top5.slice(1)).toEqual(fused?.top5.slice(0, 4));
    }
  });

  it("refuses to publish a baseline when the wired graph arm degraded", async () => {
    const out = join(scratchDir(), "baseline.json");
    writeFileSync(out, '{"kept":true}\n', "utf8");
    const { storage } = graphWiring("c-graph-lead");
    const stderr = captureStderr();

    const code = await runCli(
      baseArgv(out),
      makeDeps({
        storage,
        retrieveConfig: GRAPH_RETRIEVE_CONFIG,
        graphRanker: {
          async rankEntities(): Promise<RankedEntity[]> {
            throw new Error("neo4j sidecar unreachable");
          },
        },
      })
    );
    stderr.restore();

    // An arm that was attempted and failed did not run: recording
    // `vector+bm25+graph` here would label a fallback-RRF baseline as a
    // graph-led one, and the P@5 drop would read as a retrieval
    // regression instead of an outage.
    expect(code).toBe(1);
    expect(stderr.text()).toContain("eval-retrieve failed:");
    expect(stderr.text()).toContain("q01-autovacuum");
    expect(stderr.text()).toContain("neo4j sidecar unreachable");
    expect(readFileSync(out, "utf8")).toBe('{"kept":true}\n');
  });
});

describe("eval CLI — baseline contents (SC6)", () => {
  it("writes per-query top5 / pAt5 / rAt5 for every gold query", async () => {
    const out = join(scratchDir(), "baseline.json");
    const gold = loadGoldSet(DEFAULT_GOLD_PATH);

    await runCli(baseArgv(out), makeDeps());
    const baseline = readBaseline(out);

    expect(baseline.queries.map((q) => q.id)).toEqual(
      gold.queries.map((q) => q.id)
    );
    expect(baseline.queryCount).toBe(gold.queries.length);
    for (const entry of baseline.queries) {
      expect(entry.top5.length).toBeLessThanOrEqual(5);
      expect(entry.pAt5).toBeGreaterThanOrEqual(0);
      expect(entry.pAt5).toBeLessThanOrEqual(1);
      expect(entry.rAt5).toBeGreaterThanOrEqual(0);
      expect(entry.rAt5).toBeLessThanOrEqual(1);
    }
  });

  it("stamps the fixture versions it scored so a diff is explainable", async () => {
    const out = join(scratchDir(), "baseline.json");

    await runCli(baseArgv(out), makeDeps());
    const baseline = readBaseline(out);

    expect(baseline.gold).toBe(loadGoldSet(DEFAULT_GOLD_PATH).version);
    expect(baseline.corpus).toBe(loadCorpus(DEFAULT_CORPUS_PATH).version);
  });

  it("produces byte-identical output on a second run", async () => {
    const out = join(scratchDir(), "baseline.json");

    await runCli(baseArgv(out), makeDeps());
    const first = readFileSync(out, "utf8");
    await runCli(baseArgv(out), makeDeps());
    const second = readFileSync(out, "utf8");

    expect(second).toBe(first);
  });

  it("finds at least one relevant chunk overall, so the harness is not inert", async () => {
    const out = join(scratchDir(), "baseline.json");

    await runCli(baseArgv(out), makeDeps());

    expect(readBaseline(out).meanPAt5).toBeGreaterThan(0);
  });
});

describe("eval CLI — same fusion path as MCP retrieve (SC4)", () => {
  it("records exactly what assembleRetrievalResult returns", async () => {
    const out = join(scratchDir(), "baseline.json");
    const gold = loadGoldSet(DEFAULT_GOLD_PATH);
    const corpus = loadCorpus(DEFAULT_CORPUS_PATH);

    // The CLI is given NO assembler override, so it uses the production
    // one it imports.
    await runCli(baseArgv(out), makeDeps());
    const baseline = readBaseline(out);

    // Same seed, same query, same config — straight through the tool's
    // own orchestrator.
    const embedder = new FakeEmbedder(DIM);
    const storage = new MemoryBackend(DIM);
    await seedCorpus(corpus, embedder, storage);
    for (const goldQuery of gold.queries.slice(0, 3)) {
      const envelope = await assembleRetrievalResult(
        { query: goldQuery.query, validAt: VALID_AT, limit: 10 },
        { embedder, storage, retrieveConfig: RETRIEVE_CONFIG }
      );
      const expected = envelope.chunks.slice(0, 5).map((chunk) => chunk.id);
      const recorded = baseline.queries.find((q) => q.id === goldQuery.id);

      expect(recorded?.top5).toEqual(expected);
    }
  });
});

describe("eval CLI — overflow (SC9)", () => {
  it("scores at rank 5 even when the caller asks retrieve for 100", async () => {
    const wide = join(scratchDir(), "wide.json");
    const narrow = join(scratchDir(), "narrow.json");

    await runCli(baseArgv(wide, ["--limit", "100"]), makeDeps());
    await runCli(baseArgv(narrow), makeDeps());

    const wideQueries = readBaseline(wide).queries;
    const narrowQueries = readBaseline(narrow).queries;
    for (const entry of wideQueries) {
      expect(entry.top5.length).toBeLessThanOrEqual(5);
    }
    expect(wideQueries.map((q) => q.top5)).toEqual(
      narrowQueries.map((q) => q.top5)
    );
  });
});

describe("eval CLI — exception class (SC9)", () => {
  it("fails loudly with the query name when the assembler throws", async () => {
    const out = join(scratchDir(), "baseline.json");
    writeFileSync(out, '{"kept":true}\n', "utf8");
    const stderr = captureStderr();

    const code = await runCli(
      baseArgv(out),
      makeDeps({
        assemble: async () => {
          throw new Error("graph engine exploded");
        },
      })
    );
    stderr.restore();

    expect(code).toBe(1);
    expect(stderr.text()).toContain("graph engine exploded");
    expect(stderr.text()).toContain("q01-autovacuum");
    // No silent empty result: the pre-existing baseline is still there.
    expect(readFileSync(out, "utf8")).toBe('{"kept":true}\n');
  });

  it("never writes an empty top5 list in place of a failed query", async () => {
    const out = join(scratchDir(), "baseline.json");
    const stderr = captureStderr();

    const code = await runCli(
      baseArgv(out),
      makeDeps({
        assemble: async () => {
          throw new Error("boom");
        },
      })
    );
    stderr.restore();

    expect(code).toBe(1);
    expect(() => readFileSync(out, "utf8")).toThrow();
  });
});

describe("eval CLI — empty / malformed fixtures (SC9)", () => {
  it("exits 1 and leaves the baseline alone for an empty gold file", async () => {
    const dir = scratchDir();
    const out = join(dir, "baseline.json");
    const emptyGold = join(dir, "gold.json");
    writeFileSync(out, '{"kept":true}\n', "utf8");
    writeFileSync(emptyGold, "", "utf8");
    const stderr = captureStderr();

    const code = await runCli(
      ["--gold", emptyGold, "--corpus", DEFAULT_CORPUS_PATH, "--out", out],
      makeDeps()
    );
    stderr.restore();

    expect(code).toBe(1);
    expect(stderr.text()).toContain(emptyGold);
    expect(readFileSync(out, "utf8")).toBe('{"kept":true}\n');
  });

  it("exits 1 with a named cause for a missing corpus file", async () => {
    const dir = scratchDir();
    const out = join(dir, "baseline.json");
    const stderr = captureStderr();

    const code = await runCli(
      [
        "--gold",
        DEFAULT_GOLD_PATH,
        "--corpus",
        join(dir, "nope.json"),
        "--out",
        out,
      ],
      makeDeps()
    );
    stderr.restore();

    expect(code).toBe(1);
    expect(stderr.text()).toContain("nope.json");
  });

  it("exits 2 on a usage error without touching storage", async () => {
    const stderr = captureStderr();

    const code = await runCli(["--bogus"], makeDeps());
    stderr.restore();

    expect(code).toBe(2);
    expect(stderr.text()).toContain("usage:");
  });
});

/**
 * ADR-0006: eval and the server share the same `loadEnv()` switches.
 *
 * specs/graph-rerank-boot-and-evidence.md SC4: the CLI source must not
 * assign `graphEnabled: false` / `rerankEnabled: false`; a default-on env
 * keeps both flags true; a default-on env without the deps fails exactly
 * as the server does (ConfigError → exit 1); an explicit env-off keeps
 * the offline two-arm run working.
 */
describe("eval CLI — loadEnv switches (SC4, ADR-0006)", () => {
  // Spec-4 SC4: a grep-level guard. The historical bug was the literal
  // hardcoded spread-override in runCliFromEnv; asserting its absence in
  // the source prevents a regression the behavioral tests below could
  // only catch indirectly.
  it("source contains no hardcoded graphEnabled/rerankEnabled false override", () => {
    const source = readFileSync(
      join(process.cwd(), "src/cli/eval-retrieve.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/graphEnabled\s*:\s*false/);
    expect(source).not.toMatch(/rerankEnabled\s*:\s*false/);
  });

  /**
   * Save / restore the env vars runCliFromEnv's loadEnv reads. Blanking
   * (not deleting) masks a developer's `.env.local` the same way
   * tests/config.test.ts does. Only the deps-present case needs the
   * module's real assembler run; the deps-missing case fails before any
   * embedding or seeding happens.
   */
  const ENV_KEYS = [
    "GRAPHRAG_MEMORY_EMBED_DIMENSIONS",
    "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS",
    "GRAPHRAG_MEMORY_EMBED_BASE_URL",
    "GRAPHRAG_MEMORY_EMBED_MODEL",
    "GRAPHRAG_MEMORY_EMBED_API_KEY",
    "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV",
    "GRAPHRAG_MEMORY_VECTOR_API_KEY",
    "GRAPHRAG_MEMORY_ANTHROPIC_API_KEY",
    "NINE_ROUTER_KEY",
    "GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED",
    "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED",
    "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL",
    "GRAPHRAG_MEMORY_NEO4J_URI",
    "GRAPHRAG_MEMORY_NEO4J_USER",
    "GRAPHRAG_MEMORY_NEO4J_PASSWORD",
    // ADR-0007 fail-start: the default-on precision layer refuses to boot
    // without an address, so the family is scrubbed / supplied below.
    "GRAPHRAG_MEMORY_ES_URL",
    "GRAPHRAG_MEMORY_ES_NODE",
  ] as const;

  function withEnv(
    patch: Record<string, string | undefined>,
    fn: () => Promise<void>
  ): Promise<void> {
    const saved = new Map<string, string | undefined>();
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      process.env[key] = "";
    }
    for (const [key, value] of Object.entries(patch)) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const settingHome = mkdtempSync(join(tmpdir(), "iknow-eval-setting-"));
    setSettingHomeForTests(settingHome);
    return fn().finally(() => {
      setSettingHomeForTests(null);
      rmSync(settingHome, { recursive: true, force: true });
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }

  it("fails with exit 1 + config-error message on a default-on env without deps", async () => {
    await withEnv(
      {
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "16",
        GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "2000",
      },
      async () => {
        const stderr = captureStderr();
        try {
          const code = await runCliFromEnv([]);
          expect(code).toBe(1);
          // The message names the graph switch + URI: fail-start, not a
          // silent two-arm run.
          expect(stderr.text()).toContain("eval-retrieve config error:");
          expect(stderr.text()).toContain(
            "GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED"
          );
          expect(stderr.text()).toContain("GRAPHRAG_MEMORY_NEO4J_URI");
        } finally {
          stderr.restore();
        }
      }
    );
  });

  it("keeps both retrieval flags true on a default-on env with deps present", async () => {
    // Behavioral: the config flows from the REAL loadEnv() through
    // runCliFromEnv into the assembler's deps. The injected assemble spy
    // captures the flags then aborts the run on the first query, so no
    // graph arm or rerank endpoint is ever contacted; the EnvError sentinel
    // surfaces via the CLI's typed assembler-failure path (exit 1).
    let captured: RetrieveConfig | undefined;
    await withEnv(
      {
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "16",
        GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "2000",
        GRAPHRAG_MEMORY_NEO4J_URI: "bolt://localhost:7687",
        GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL: "https://rerank.example.test/v1/",
        // ADR-0007: the default-on precision layer needs its address too.
        GRAPHRAG_MEMORY_ES_URL: "http://es.example.test:9200",
        // All three switches left unset: default-on env (the SC4 subject).
        GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED: undefined,
        GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: undefined,
      },
      async () => {
        const out = join(scratchDir(), "baseline.json");
        const stderr = captureStderr();
        try {
          const code = await runCliFromEnv(baseArgv(out), {
            assemble: async (_args, deps) => {
              captured = deps.retrieveConfig;
              throw new Error("flags propagation asserted");
            },
          });
          expect(
            captured,
            "assembler must be reached with env config"
          ).toBeDefined();
          expect(captured?.graphEnabled).toBe(true);
          expect(captured?.rerankEnabled).toBe(true);
          // The stub throw maps to the CLI's typed assembler-failure path.
          expect(code).toBe(1);
          expect(stderr.text()).toContain("flags propagation asserted");
        } finally {
          stderr.restore();
        }
      }
    );
  });

  it("runs the offline two-arm baseline when the env explicitly offs both switches", async () => {
    await withEnv(
      {
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "16",
        GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "2000",
        GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED: "false",
        GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "false",
        // ADR-0007: the two-arm baseline still runs the lexical arm, so the
        // precision layer keeps its address (explicit off would change the
        // arm set this test pins).
        GRAPHRAG_MEMORY_ES_URL: "http://es.example.test:9200",
      },
      async () => {
        const out = join(scratchDir(), "baseline.json");
        const code = await runCliFromEnv(baseArgv(out));
        expect(code).toBe(0);
        expect(readBaseline(out).armSet).toBe("vector+bm25");
      }
    );
  });
});
