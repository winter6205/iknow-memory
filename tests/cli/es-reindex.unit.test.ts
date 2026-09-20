/**
 * es-reindex CLI unit tests (plans/es-precision-layer.md T8).
 *
 * The CLI is a recovery tool: drop + re-create the two derived ES indexes
 * from the live Postgres ledger. Covered here, all without a live PG or
 * ES:
 *   - flag parsing (unknown flag → exit 2; --batch-size validated)
 *   - `--dry-run` counts both ledger sweeps and never opens the indexer
 *   - default mode pages both sweeps (boundary at exactly 1000 and 1001
 *     rows, mirroring the precision layer's bulk batch size)
 *   - retired entities stay out of the projection (live-only rule, same
 *     as the graph backfill)
 *   - chunk rows are read from `chunks`; entity rows are read from
 *     `entities` joined with `entity_aliases`
 *   - PG writes are not attempted (read-only contract on the source of
 *     truth)
 *   - a missing ES block in env → exit 1, typed ConfigError surface on
 *     stderr (this CLI treats an unconfigured ES as operator mistake, not
 *     as a loud-skip — see module header for the rationale)
 */
import { describe, expect, it, vi } from "vitest";

import {
  parseArgs,
  runCli,
  type ReindexClient,
  type ReindexDeps,
} from "../../src/cli/es-reindex.js";
import type { ElasticsearchConfig, GraphragEnv } from "../../src/config.js";
import type {
  ChunkRecord,
  PrecisionIndexer,
  EntityIndexRecord,
} from "../../src/core/storage/elasticsearch-precision.js";

const CHUNK_A = "11111111-1111-4111-8111-111111111111";
const CHUNK_B = "22222222-2222-4222-8222-222222222222";
const CHUNK_C = "33333333-3333-4333-8333-333333333333";
const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACME = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RETIRED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const VALID_FROM = "2026-08-01T00:00:00.000Z";

interface ChunkRow {
  id: string;
  content: string;
  source_ref: string;
  metadata: Record<string, unknown>;
  valid_from: Date;
  valid_until: Date | null;
  created_at: Date;
}

interface EntityRow {
  id: string;
  canonical_name: string;
  type: string;
  retired: boolean;
}

interface AliasRow {
  entity_id: string;
  alias: string;
}

/**
 * Frozen ledger fixture: 3 chunks + 2 live entities + 1 retired entity +
 * 2 alias rows for ALICE. Retired rows must stay out of every ES projection.
 */
const CHUNKS: ChunkRow[] = [
  {
    id: CHUNK_A,
    content: "alpha content",
    source_ref: "doc-1",
    metadata: { topic: "alpha" },
    valid_from: new Date(VALID_FROM),
    valid_until: null,
    created_at: new Date(VALID_FROM),
  },
  {
    id: CHUNK_B,
    content: "beta content",
    source_ref: "doc-2",
    metadata: {},
    valid_from: new Date(VALID_FROM),
    valid_until: null,
    created_at: new Date(VALID_FROM),
  },
  {
    id: CHUNK_C,
    content: "gamma content",
    source_ref: "doc-3",
    metadata: {},
    valid_from: new Date(VALID_FROM),
    valid_until: null,
    created_at: new Date(VALID_FROM),
  },
];

const ENTITIES: EntityRow[] = [
  { id: ALICE, canonical_name: "Alice Smith", type: "person", retired: false },
  { id: ACME, canonical_name: "Acme Corp", type: "system", retired: false },
  { id: RETIRED, canonical_name: "Old Alias", type: "person", retired: true },
];

const ALIASES: AliasRow[] = [
  { entity_id: ALICE, alias: "alice" },
  { entity_id: ALICE, alias: "Al" },
];

/** Build a `GraphragEnv` with only the slots the reindex reads. */
function makeEnv(
  over: { dbUrl?: string; elasticsearch?: ElasticsearchConfig } = {}
): GraphragEnv {
  const dbUrl = over.dbUrl ?? "postgres://localhost/test";
  const elasticsearch =
    over.elasticsearch ??
    ({
      node: "http://localhost:9200",
      chunkIndex: "iknow-memory-chunks",
      entityIndex: "iknow-memory-entities",
      username: undefined,
      password: undefined,
      apiKey: undefined,
      requestTimeoutMs: 5_000,
    } satisfies ElasticsearchConfig);
  return {
    logLevel: "info",
    storage: "pgvector",
    dbUrl,
    embedBaseUrl: undefined,
    embedModel: undefined,
    embedDimensions: 8,
    pgvectorAnnMaxDimensions: 2048,
    ingestBatchLimit: 100,
    pgvectorPoolMax: 4,
    pgvectorConnectionWaitTimeoutMs: 5_000,
    embedApiKey: undefined,
    retrieval: {
      preset: "balanced",
      rrfK: 60,
      w_vec: 1,
      w_bm25: 1,
      w_graph: 0.15,
      k1: 1.2,
      b: 0.75,
      bm25Enabled: true,
      cjkSegmentationEnabled: true,
      phraseEnabled: true,
      fieldBoostEnabled: true,
      fieldBoosts: { content: 1 },
      rrfEnabled: true,
      vectorEnabled: true,
      graphEnabled: true,
      nodeEmbeddingEnabled: false,
      rerankEnabled: false,
      waitForDrainEnabled: false,
      waitForDrainTimeoutMs: 5_000,
      entityLinkTopK: 10,
      candidateCap: 100,
      neighborWidth: 1,
      graphArmFloor: 3,
    },
    neo4j: undefined,
    elasticsearch,
    rerank: undefined,
    rerankUrl: undefined,
    jev: undefined,
    // Required on GraphragEnv since the ADR-0009 default flip; this fake
    // env never threads it (the reindex CLI does not extract).
    extractWriteTimeSupersede: true,
  };
}

/**
 * Fake Postgres answering the two keyset scans + the alias join. The CLI's
 * SQL must match its expectations (`FROM chunks`, `FROM entities LEFT JOIN
 * entity_aliases`), so the SQL the tests run against IS the SQL under test.
 */
class FakeClient implements ReindexClient {
  queries: string[] = [];
  valuesList: unknown[][] = [];
  chunks: ChunkRow[] = [];
  entities: EntityRow[] = [];
  aliases: AliasRow[] = [];
  constructor(init?: {
    chunks?: ChunkRow[];
    entities?: EntityRow[];
    aliases?: AliasRow[];
  }) {
    this.chunks = (init?.chunks ?? CHUNKS).map((r) => ({ ...r }));
    this.entities = (init?.entities ?? ENTITIES).map((r) => ({ ...r }));
    this.aliases = (init?.aliases ?? ALIASES).map((r) => ({ ...r }));
  }

  async query(text: string, values: unknown[] = []) {
    this.queries.push(text);
    this.valuesList.push(values);
    if (/FROM chunks/.test(text)) {
      return { rows: pageChunks(this.chunks, values) };
    }
    if (/FROM entities/.test(text)) {
      return { rows: pageEntities(this.entities, this.aliases, values) };
    }
    return { rows: [] };
  }
  release(): void {}
}

function pageChunks(rows: ChunkRow[], values: unknown[]): ChunkRow[] {
  const cursor = String(values[0] ?? "");
  const limit = Number(values[1] ?? rows.length);
  return rows.filter((r) => r.id > cursor).slice(0, limit);
}

function pageEntities(
  entities: EntityRow[],
  aliases: AliasRow[],
  values: unknown[]
): Array<EntityRow & { aliases: string[] }> {
  const cursor = String(values[0] ?? "");
  const limit = Number(values[1] ?? entities.length);
  const live = entities
    .filter((e) => !e.retired && e.id > cursor)
    .slice(0, limit);
  return live.map((e) => ({
    ...e,
    aliases: aliases.filter((a) => a.entity_id === e.id).map((a) => a.alias),
  }));
}

/**
 * Fake precision indexer that models the real delete-then-index semantics:
 * `index*` accumulates into the index maps (upsert by id), `delete*Index`
 * wipes the corresponding map, and `rebuild*` = delete + index. Without
 * delete modeling, a CLI bug that calls `rebuildChunks` per page would be
 * invisible here — exactly the multi-page data-loss bug this fake exists
 * to expose.
 */
class FakeIndexer implements PrecisionIndexer {
  chunkCalls: ChunkRecord[][] = [];
  entityCalls: EntityIndexRecord[][] = [];
  deleteChunkCalls = 0;
  deleteEntityCalls = 0;
  /** Current simulated index contents, keyed by document id. */
  chunkIndex = new Map<string, ChunkRecord>();
  entityIndex = new Map<string, EntityIndexRecord>();
  closed = 0;

  async indexChunks(chunks: readonly ChunkRecord[]): Promise<void> {
    this.chunkCalls.push([...chunks]);
    for (const c of chunks) this.chunkIndex.set(c.id, c);
  }
  async indexEntities(entities: readonly EntityIndexRecord[]): Promise<void> {
    this.entityCalls.push([...entities]);
    for (const e of entities) this.entityIndex.set(e.id, e);
  }
  async rebuildChunks(chunks: readonly ChunkRecord[]): Promise<void> {
    await this.deleteChunkIndex();
    await this.indexChunks(chunks);
  }
  async rebuildEntities(entities: readonly EntityIndexRecord[]): Promise<void> {
    await this.deleteEntityIndex();
    await this.indexEntities(entities);
  }
  async deleteChunkIndex(): Promise<void> {
    this.deleteChunkCalls += 1;
    this.chunkIndex.clear();
  }
  async deleteEntityIndex(): Promise<void> {
    this.deleteEntityCalls += 1;
    this.entityIndex.clear();
  }
  async invalidateSourceRef(): Promise<void> {}
  async analyze(): Promise<string[]> {
    return [];
  }
  async searchLexical(): Promise<never[]> {
    return [];
  }
  async searchEntities(): Promise<never[]> {
    return [];
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}

interface Logged {
  msg: string;
  fields: Record<string, unknown> | undefined;
}

function recordingLogger(lines: Logged[]) {
  return {
    level: "info" as const,
    debug: () => {},
    info: (msg: string, fields?: Record<string, unknown>) =>
      void lines.push({ msg, fields }),
    warn: (msg: string, fields?: Record<string, unknown>) =>
      void lines.push({ msg, fields }),
    error: (msg: string, fields?: Record<string, unknown>) =>
      void lines.push({ msg, fields }),
  };
}

interface Harness {
  client: FakeClient;
  indexer: FakeIndexer;
  lines: Logged[];
  opens: number;
  deps: ReindexDeps;
}

function harness(
  over: {
    client?: FakeClient;
    indexer?: FakeIndexer;
    openIndexer?: ReindexDeps["openIndexer"];
  } = {}
): Harness {
  const client = over.client ?? new FakeClient();
  const indexer = over.indexer ?? new FakeIndexer();
  const lines: Logged[] = [];
  const h: Harness = {
    client,
    indexer,
    lines,
    opens: 0,
    deps: {} as ReindexDeps,
  };
  h.deps = {
    pool: {
      async connect() {
        return client;
      },
      async end() {},
    },
    logger: recordingLogger(lines),
    openIndexer: async (_env, _es) => {
      h.opens += 1;
      if (over.openIndexer) return over.openIndexer(_env, _es);
      return indexer;
    },
  };
  return h;
}

function fieldsOf(lines: Logged[], msg: string): Record<string, unknown> {
  const line = lines.find((l) => l.msg === msg);
  expect(line, `no "${msg}" line in ${JSON.stringify(lines)}`).toBeDefined();
  return line!.fields ?? {};
}

describe("es-reindex flag parsing", () => {
  it("rejects an unknown flag with a usage error (exit 2)", async () => {
    const h = harness();
    expect(await runCli(["--nope"], h.deps, makeEnv())).toBe(2);
    expect(h.client.queries).toEqual([]);
    expect(h.opens).toBe(0);
  });

  it("--batch-size requires a positive integer", () => {
    expect(parseArgs(["--batch-size", "0"])).toEqual({
      ok: false,
      error: "--batch-size requires a positive integer",
    });
    expect(parseArgs(["--batch-size", "-1"])).toEqual({
      ok: false,
      error: "--batch-size requires a positive integer",
    });
    expect(parseArgs(["--batch-size", "500"])).toMatchObject({ ok: true });
  });
});

describe("es-reindex --dry-run", () => {
  it("counts both ledger sweeps and never opens the indexer", async () => {
    const h = harness();

    const code = await runCli(["--dry-run"], h.deps, makeEnv());

    expect(code).toBe(0);
    expect(h.opens).toBe(0);
    expect(fieldsOf(h.lines, "es-reindex-plan")).toMatchObject({
      chunks: 3,
      entities: 2,
    });
    // PG is read-only: no INSERT/UPDATE/DELETE was issued.
    const writes = h.client.queries.filter((q) =>
      /^\s*(INSERT|UPDATE|DELETE)\s/i.test(q)
    );
    expect(writes).toEqual([]);
  });

  it("excludes retired entities from the count", async () => {
    const h = harness();
    expect(await runCli(["--dry-run"], h.deps, makeEnv())).toBe(0);
    expect(fieldsOf(h.lines, "es-reindex-plan")).toMatchObject({
      entities: 2,
    });
    const entityScan = h.client.queries.find((q) => /FROM entities/.test(q))!;
    expect(entityScan).toMatch(/retired = false/);
  });
});

describe("es-reindex default mode", () => {
  it("wipes each index once up front, then pages with index* upserts", async () => {
    const h = harness();

    const code = await runCli(["--batch-size", "2"], h.deps, makeEnv());

    expect(code).toBe(0);
    // One delete per index, before the sweep — never per page.
    expect(h.indexer.deleteChunkCalls).toBe(1);
    expect(h.indexer.deleteEntityCalls).toBe(1);
    // All chunks flattened: 2 + 1 page sizes.
    const indexedChunks = h.indexer.chunkCalls.flat();
    expect(indexedChunks).toHaveLength(3);
    expect(indexedChunks.map((c) => c.id).sort()).toEqual(
      [CHUNK_A, CHUNK_B, CHUNK_C].sort()
    );
    const indexedEntities = h.indexer.entityCalls.flat();
    expect(indexedEntities).toHaveLength(2);
    expect(indexedEntities.map((e) => e.id).sort()).toEqual(
      [ACME, ALICE].sort()
    );
    // ALICE pulls its two alias rows into the projection.
    const alice = indexedEntities.find((e) => e.id === ALICE)!;
    expect(alice.canonical_name).toBe("Alice Smith");
    expect([...alice.aliases].sort()).toEqual(["Al", "alice"]);
    expect(fieldsOf(h.lines, "es-reindex-complete")).toMatchObject({
      chunks: 3,
      entities: 2,
    });
    expect(h.indexer.closed).toBe(1);
  });

  it("pages the chunk sweep instead of loading the whole ledger at once", async () => {
    const h = harness();
    expect(await runCli(["--batch-size", "1"], h.deps, makeEnv())).toBe(0);
    const chunkScans = h.client.valuesList.filter((_, i) =>
      /FROM chunks/.test(h.client.queries[i] ?? "")
    );
    // 3 chunks at 1 per page = 3 full pages + 1 empty terminator.
    expect(chunkScans).toHaveLength(4);
    expect(chunkScans.every((v) => v[1] === 1)).toBe(true);
  });

  it("pages the entity sweep with the same keyset cursor", async () => {
    const h = harness();
    expect(await runCli(["--batch-size", "1"], h.deps, makeEnv())).toBe(0);
    const entityScans = h.client.valuesList.filter((_, i) =>
      /FROM entities/.test(h.client.queries[i] ?? "")
    );
    // 2 live entities at 1 per page = 2 full pages + 1 empty terminator.
    expect(entityScans).toHaveLength(3);
    // Cursors must be strictly ascending.
    const cursors = entityScans.map((v) => String(v[0]));
    expect(cursors[0]).toBe("00000000-0000-0000-0000-000000000000");
    expect(cursors[1]).toBe(ALICE);
    expect(cursors[2]).toBe(ACME);
  });

  it("treats a 1001-row ledger as two bulk batches (no row lost)", async () => {
    // 1001 chunks means page 1 = 1000, page 2 = 1. The first page hits the
    // BULK_BATCH_SIZE boundary at exactly 1000; the second proves the loop
    // does not terminate at the boundary.
    const chunks: ChunkRow[] = Array.from({ length: 1001 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      content: `chunk ${i}`,
      source_ref: `doc-${i}`,
      metadata: {},
      valid_from: new Date(VALID_FROM),
      valid_until: null,
      created_at: new Date(VALID_FROM),
    }));
    const client = new FakeClient({ chunks });
    const h = harness({ client });

    expect(await runCli(["--batch-size", "1000"], h.deps, makeEnv())).toBe(0);

    // 2 pages of chunks: 1000 + 1, then terminator = 0.
    const indexed = h.indexer.chunkCalls.flat();
    expect(indexed).toHaveLength(1001);
    expect(new Set(indexed.map((c) => c.id)).size).toBe(1001);
  });

  it("treats an exact-1000 ledger as a single bulk batch (terminator detected)", async () => {
    // Page returns 1000 rows. The loop must NOT continue — it sees the
    // returned length is NOT less than the limit, but the next page returns
    // 0 rows and the loop exits. This guards against an off-by-one where a
    // full page mistakenly advances the cursor past the last row.
    const chunks: ChunkRow[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      content: `chunk ${i}`,
      source_ref: `doc-${i}`,
      metadata: {},
      valid_from: new Date(VALID_FROM),
      valid_until: null,
      created_at: new Date(VALID_FROM),
    }));
    const client = new FakeClient({ chunks });
    const h = harness({ client });

    expect(await runCli(["--batch-size", "1000"], h.deps, makeEnv())).toBe(0);

    expect(h.indexer.chunkCalls).toHaveLength(1);
    expect(h.indexer.chunkCalls[0]).toHaveLength(1000);
  });

  it("keeps page-1 documents alive after page 2 is written (multi-page regression)", async () => {
    // Regression for the per-page rebuild bug: calling `rebuildChunks`
    // (delete-then-index) per page makes page 2's delete erase page 1's
    // documents, so the final index only ever contains the last page. The
    // fake indexer models index contents, so after a multi-page run the
    // simulated chunk index must hold EVERY row from every page —
    // including page 1's CHUNK_A / CHUNK_B after CHUNK_C lands.
    const h = harness();

    const code = await runCli(["--batch-size", "2"], h.deps, makeEnv());

    expect(code).toBe(0);
    // Two real chunk pages (2 + 1 rows) were written before the empty
    // terminator; every row from every page must still be in the index.
    expect(h.indexer.chunkIndex.size).toBe(3);
    expect([...h.indexer.chunkIndex.keys()].sort()).toEqual(
      [CHUNK_A, CHUNK_B, CHUNK_C].sort()
    );
    // Same guarantee for entities (1 + 1 rows across two pages).
    expect(h.indexer.entityIndex.size).toBe(2);
    expect([...h.indexer.entityIndex.keys()].sort()).toEqual(
      [ACME, ALICE].sort()
    );
    // The one pre-sweep wipe happened before any page was indexed; a
    // per-page rebuild would have surfaced here as 2 deletes and a
    // 1-document index.
    expect(h.indexer.deleteChunkCalls).toBe(1);
    expect(h.indexer.deleteEntityCalls).toBe(1);
  });

  it("does not use the per-page rebuild path (rebuild* stays uncallled)", async () => {
    // The CLI must call indexChunks/indexEntities, never
    // rebuildChunks/rebuildEntities, so the delete-then-index semantics
    // cannot leak into the sweep. Assert by making rebuild throw.
    const h = harness();
    h.indexer.rebuildChunks = async () => {
      throw new Error("rebuildChunks must not be called per page");
    };
    h.indexer.rebuildEntities = async () => {
      throw new Error("rebuildEntities must not be called per page");
    };

    expect(await runCli(["--batch-size", "2"], h.deps, makeEnv())).toBe(0);
  });

  it("never writes to Postgres (read-only contract on the source of truth)", async () => {
    const h = harness();
    expect(await runCli([], h.deps, makeEnv())).toBe(0);
    const writes = h.client.queries.filter((q) =>
      /^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\s/i.test(q)
    );
    expect(writes).toEqual([]);
  });

  it("catches a thrown openIndexer as exit 1 and logs the error", async () => {
    const h = harness({
      openIndexer: async () => {
        throw new Error("ES cluster offline");
      },
    });

    const code = await runCli([], h.deps, makeEnv());

    expect(code).toBe(1);
    expect(fieldsOf(h.lines, "es-reindex-fatal")).toMatchObject({
      error: "ES cluster offline",
    });
  });

  it("catches a mid-run indexer throw as exit 1 without closing twice", async () => {
    const h = harness();
    h.indexer.indexEntities = async () => {
      throw new Error("ES bulk failed");
    };

    expect(await runCli([], h.deps, makeEnv())).toBe(1);

    expect(fieldsOf(h.lines, "es-reindex-fatal")).toMatchObject({
      error: "ES bulk failed",
    });
    // The CLI's `finally` still ran — indexer.close() must be called once.
    expect(h.indexer.closed).toBe(1);
    // The "complete" log line must NOT appear, since the run aborted.
    expect(
      h.lines.find((l) => l.msg === "es-reindex-complete")
    ).toBeUndefined();
  });
});

describe("es-reindex env wiring", () => {
  it("runCliFromEnv rejects a missing GRAPHRAG_MEMORY_DB_URL as exit 1", async () => {
    // The static import at the top of this file already cached the
    // es-reindex -> config module edge, and vi.doMock only rewrites the
    // registry for edges resolved *after* it runs. Without resetModules()
    // the dynamic import below returns the cached module and runCliFromEnv
    // runs the real loadEnv(), reading the developer's .env.local — the
    // assertion then passes or fails depending on the machine. A sentinel
    // message (not producible by config.ts) makes the mock path provable.
    const mockMessage = "SENTINEL-DB-URL: mocked missing db url";
    let loadEnvCalls = 0;
    vi.resetModules();
    // Spy on stderr to keep test output clean; captured text is asserted
    // below to prove the mock path ran.
    const output: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        output.push(String(chunk));
        return true;
      });
    try {
      vi.doMock("../../src/config.js", async () => {
        // The thrown error must come from *this* graph's config module:
        // after resetModules() the statically imported ConfigError is a
        // different class identity, so runCliFromEnv's `instanceof` check
        // would miss it and rethrow instead of returning 1.
        const actual = await vi.importActual<
          typeof import("../../src/config.js")
        >("../../src/config.js");
        return {
          ...actual,
          loadEnv: () => {
            loadEnvCalls += 1;
            throw new actual.ConfigError(mockMessage);
          },
        };
      });
      try {
        const { runCliFromEnv } = await import("../../src/cli/es-reindex.js");
        expect(await runCliFromEnv([])).toBe(1);
        // Direct evidence the mocked loadEnv ran, and that the exit-1
        // surface carries the mock's own message rather than a real config
        // error from .env.local.
        expect(loadEnvCalls).toBe(1);
        expect(output.join("")).toContain(mockMessage);
      } finally {
        vi.doUnmock("../../src/config.js");
      }
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("runCliFromEnv rejects a missing GRAPHRAG_MEMORY_ES_URL as exit 1", async () => {
    // resetModules() is required here too: without it the first test's
    // mocked config stays in the registry and this dynamic import would
    // reuse that stale mock.
    let loadEnvCalls = 0;
    vi.resetModules();
    const output: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        output.push(String(chunk));
        return true;
      });
    try {
      vi.doMock("../../src/config.js", async () => {
        const actual = await vi.importActual<
          typeof import("../../src/config.js")
        >("../../src/config.js");
        return {
          ...actual,
          loadEnv: () => {
            loadEnvCalls += 1;
            // `makeEnv`'s override merges with `??`, so passing
            // `elasticsearch: undefined` would fall back to its default
            // block; overwrite the field directly to model "no ES block".
            return { ...makeEnv(), elasticsearch: undefined };
          },
        };
      });
      try {
        const { runCliFromEnv } = await import("../../src/cli/es-reindex.js");
        expect(await runCliFromEnv([])).toBe(1);
        expect(loadEnvCalls).toBe(1);
        // This sentence is written only by runCliFromEnv's
        // `env.elasticsearch === undefined` branch; neither loadEnv() nor
        // the fatal-error path can produce it, so it discriminates the
        // mocked env from the real one.
        expect(output.join("")).toContain(
          "GRAPHRAG_MEMORY_ES_URL is required to rebuild the precision layer"
        );
      } finally {
        vi.doUnmock("../../src/config.js");
      }
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
