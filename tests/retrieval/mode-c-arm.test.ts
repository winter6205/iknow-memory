/**
 * 档 C arm unit tests (plans/search-mode-retrieve.md T3, fin ADR-0070,
 * specs/search-mode-retrieve.md assumption 4 + SC4).
 *
 * Contract under test: C is report-first. Community report text ES runs in
 * PARALLEL with report vectors (the two arms of ADR-0070); the hits are
 * community summary rows; after at least one report hit the answer may drop
 * to citable 抽图窗 (windows) — never the other way around ("C must not
 * become ES the windows and ignore reports"). A not-ready community index
 * is the TYPED `community_summary_index_failure` exit, not a silent empty
 * and not a healthy miss.
 *
 * Live C-ready needs graph-index plan T5; these fixtures are the
 * MemoryBackend + fake summary seams the ticket pins. The B-path fail-open
 * regression stays covered by tests/retrieval/community-summary.test.ts,
 * which this ticket must not weaken.
 */
import { describe, it, expect } from "vitest";
import { FakeEmbedder, UnavailableEmbedder } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { modeCReportFirstArm } from "../../src/core/retrieval/mode-c-arm.js";
import { COMMUNITY_SUMMARY_INDEX_FAILURE } from "../../src/core/types.js";
import { COMMUNITY_INDEX_STATUS } from "../../src/core/types.js";
import type {
  AssembleArgs,
  AssembleDeps,
} from "../../src/core/retrieval/index.js";
import type {
  CommunityIndexStateRow,
  CommunitySummaryRow,
  CommunitySummaryStorage,
} from "../../src/core/retrieval/types.js";
import type { ChunkRecord, StorageBackend } from "../../src/core/types.js";
import { GraphragError } from "../../src/core/errors.js";

const TEST_DIM = 8;
const READY: CommunityIndexStateRow = {
  status: COMMUNITY_INDEX_STATUS.READY,
  failure_code: null,
};

function reportRows(): CommunitySummaryRow[] {
  return [
    {
      id: "sum-1",
      communityId: "com-1",
      summary: "alpha community report",
      score: 0.9,
    },
    {
      id: "sum-2",
      communityId: "com-2",
      summary: "beta community report",
      score: 0.8,
    },
  ];
}

/** The report-embedding (vectors) arm double. */
function vectorSeam(
  rows: CommunitySummaryRow[],
  error?: Error
): CommunitySummaryStorage {
  return {
    getCommunitySummaryByCommunityId: async (communityId) =>
      rows.find((row) => row.communityId === communityId),
    searchCommunitySummaries: async () => {
      if (error !== undefined) throw error;
      return rows;
    },
  };
}

/** The report-text lexical (ES) arm double. */
class FakeReportLexical {
  calls: Array<{ query: string; limit: number }> = [];
  constructor(
    private readonly rows: CommunitySummaryRow[],
    private readonly error?: Error
  ) {}
  async searchCommunitySummariesLexical(
    query: string,
    limit: number
  ): Promise<CommunitySummaryRow[]> {
    if (this.error !== undefined) throw this.error;
    this.calls.push({ query, limit });
    return this.rows;
  }
}

/** Attach a communitySummaries seam to a backend without touching it. */
function withVectorSeam(
  backend: MemoryBackend,
  seam: CommunitySummaryStorage
): MemoryBackend {
  return Object.create(backend, {
    communitySummaries: {
      enumerable: true,
      configurable: true,
      writable: true,
      value: seam,
    },
  }) as MemoryBackend;
}

async function readyBackend(): Promise<MemoryBackend> {
  const backend = new MemoryBackend(TEST_DIM);
  await backend.setCommunityIndexState(READY);
  return backend;
}

function baseArgs(overrides: Partial<AssembleArgs> = {}): AssembleArgs {
  return {
    query: "alpha",
    validAt: "2024-06-01T00:00:00Z",
    limit: 10,
    ...overrides,
  };
}

function baseDeps(overrides: Partial<AssembleDeps> = {}): AssembleDeps {
  return {
    embedder: new FakeEmbedder(TEST_DIM),
    storage: new MemoryBackend(TEST_DIM),
    ...overrides,
  };
}

describe("modeCReportFirstArm readiness gate (typed community_summary_index_failure)", () => {
  it("rejects typed when the state row reports the pinned failure code", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.setCommunityIndexState({
      status: COMMUNITY_INDEX_STATUS.FAILED,
      failure_code: COMMUNITY_SUMMARY_INDEX_FAILURE,
    });
    await expect(
      modeCReportFirstArm(
        baseArgs(),
        baseDeps({ storage: backend })
      )
    ).rejects.toThrow(RegExp(COMMUNITY_SUMMARY_INDEX_FAILURE));
  });

  it("rejects with a GraphragError, so the MCP adapter surfaces the token", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.setCommunityIndexState({
      status: COMMUNITY_INDEX_STATUS.FAILED,
      failure_code: COMMUNITY_SUMMARY_INDEX_FAILURE,
    });
    await expect(
      modeCReportFirstArm(baseArgs(), baseDeps({ storage: backend }))
    ).rejects.toBeInstanceOf(GraphragError);
  });

  for (const status of [
    COMMUNITY_INDEX_STATUS.STALE,
    COMMUNITY_INDEX_STATUS.IN_PROGRESS,
  ]) {
    it(`rejects typed when the status is "${status}" (partial community success does not open C)`, async () => {
      const backend = new MemoryBackend(TEST_DIM);
      await backend.setCommunityIndexState({
        status,
        failure_code: null,
      });
      await expect(
        modeCReportFirstArm(baseArgs(), baseDeps({ storage: backend }))
      ).rejects.toThrow(RegExp(COMMUNITY_SUMMARY_INDEX_FAILURE));
    });
  }

  it("rejects typed when no state row exists (the job never ran is not-ready, not empty)", async () => {
    await expect(
      modeCReportFirstArm(
        baseArgs(),
        baseDeps({ storage: new MemoryBackend(TEST_DIM) })
      )
    ).rejects.toThrow(RegExp(COMMUNITY_SUMMARY_INDEX_FAILURE));
  });

  it("rejects typed when the backend has no readiness seam at all (missing evidence is not readiness)", async () => {
    const seamless: StorageBackend = {
      upsert: async () => [],
      search: async () => [],
      close: async () => {},
    };
    await expect(
      modeCReportFirstArm(baseArgs(), baseDeps({ storage: seamless }))
    ).rejects.toThrow(RegExp(COMMUNITY_SUMMARY_INDEX_FAILURE));
  });

  it("fails closed typed when the state read itself throws (never a silent B)", async () => {
    const backend = await readyBackend();
    const throwing = Object.create(backend, {
      getCommunityIndexState: {
        enumerable: true,
        configurable: true,
        writable: true,
        value: async () => {
          throw new Error("ledger read failed");
        },
      },
    }) as MemoryBackend;
    await expect(
      modeCReportFirstArm(baseArgs(), baseDeps({ storage: throwing }))
    ).rejects.toThrow(RegExp(COMMUNITY_SUMMARY_INDEX_FAILURE));
  });

  it("fails closed typed when ready status contradicts a carried failure_code", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.setCommunityIndexState({
      status: COMMUNITY_INDEX_STATUS.READY,
      failure_code: COMMUNITY_SUMMARY_INDEX_FAILURE,
    });
    await expect(
      modeCReportFirstArm(baseArgs(), baseDeps({ storage: backend }))
    ).rejects.toThrow(RegExp(COMMUNITY_SUMMARY_INDEX_FAILURE));
  });
});

describe("modeCReportFirstArm report-first (C-ready)", () => {
  it("ranks summary rows from BOTH report arms (ES ∥ vectors eligible)", async () => {
    const backend = await readyBackend();
    const lexical = new FakeReportLexical(reportRows());
    const envelope = await modeCReportFirstArm(
      baseArgs({ query: "alpha" }),
      baseDeps({
        storage: withVectorSeam(backend, vectorSeam(reportRows())),
        lexical: lexical as unknown as AssembleDeps["lexical"],
      })
    );

    // Hits are the summary rows themselves.
    expect(envelope.chunks.map((c) => c.id)).toEqual(["sum-1", "sum-2"]);
    expect(envelope.chunks.map((c) => c.content)).toEqual([
      "alpha community report",
      "beta community report",
    ]);
    for (const hit of envelope.chunks) {
      expect(hit.metadata).toMatchObject({ kind: "community-summary" });
    }
    expect(envelope.chunks[0]!.source_ref).toBe("community/com-1");
    // Agreement of two arms is signal: the rank-1-in-both row strictly
    // outscores the rank-2-in-both row under the shared RRF curve.
    expect(envelope.chunks[0]!.score).toBeGreaterThan(
      envelope.chunks[1]!.score
    );
    // Both arms ran clean → healthy, not degraded.
    expect(envelope.degraded).toBeUndefined();
  });

  it("starts the two report arms in parallel, not sequentially", async () => {
    const backend = await readyBackend();
    const lexical = new FakeReportLexical(reportRows());
    // The vectors arm observes whether the lexical arm has already been
    // entered; a sequential arm structure would see `false` here.
    let lexicalStarted = false;
    const seam: CommunitySummaryStorage = {
      getCommunitySummaryByCommunityId: async () => undefined,
      searchCommunitySummaries: async () => {
        expect(lexicalStarted).toBe(true);
        return reportRows();
      },
    };
    const originalLexical = lexical.searchCommunitySummariesLexical.bind(
      lexical
    );
    const racingLexical = {
      searchCommunitySummariesLexical: async (q: string, l: number) => {
        lexicalStarted = true;
        return originalLexical(q, l);
      },
    };
    const envelope = await modeCReportFirstArm(
      baseArgs(),
      baseDeps({
        storage: withVectorSeam(backend, seam),
        lexical: racingLexical as unknown as AssembleDeps["lexical"],
      })
    );
    expect(envelope.chunks).toHaveLength(2);
  });

  it("keeps the vectors arm eligible when no ES report seam exists (ES is optional, reports are not windows)", async () => {
    const backend = await readyBackend();
    const envelope = await modeCReportFirstArm(
      baseArgs(),
      baseDeps({
        storage: withVectorSeam(backend, vectorSeam(reportRows())),
      })
    );
    expect(envelope.chunks.map((c) => c.id)).toEqual(["sum-1", "sum-2"]);
    expect(envelope.degraded).toBeUndefined();
  });

  it("keeps the ES arm eligible when the embedder has no credentials", async () => {
    const backend = await readyBackend();
    const lexical = new FakeReportLexical(reportRows());
    const envelope = await modeCReportFirstArm(
      // Drop is off here so this case isolates the report arms: with no
      // credentials the window fill would honestly name its own
      // vector:unattempted, which is the drop path's message, not C's.
      baseArgs({ filters: { c_drop_windows: "0" } }),
      baseDeps({
        embedder: new UnavailableEmbedder(),
        storage: withVectorSeam(backend, vectorSeam(reportRows())),
        lexical: lexical as unknown as AssembleDeps["lexical"],
      })
    );
    expect(envelope.chunks.map((c) => c.id)).toEqual(["sum-1", "sum-2"]);
    // An unconfigured provider skips the vector arm; the ES arm still
    // answers the 档 — this is not the typed not-ready exit.
    expect(envelope.degraded).toBeUndefined();
  });

  it("names community_report:attempted-and-failed when the ES arm throws but vectors serve", async () => {
    const backend = await readyBackend();
    const lexical = new FakeReportLexical([], new Error("cluster down"));
    const envelope = await modeCReportFirstArm(
      baseArgs(),
      baseDeps({
        storage: withVectorSeam(backend, vectorSeam(reportRows())),
        lexical: lexical as unknown as AssembleDeps["lexical"],
      })
    );
    expect(envelope.chunks.map((c) => c.id)).toEqual(["sum-1", "sum-2"]);
    expect(envelope.degraded).toBe(true);
    expect(envelope.degraded_reasons).toContain(
      "community_report:attempted-and-failed"
    );
  });

  it("degrades without throwing when BOTH report arms throw (transient failure ≠ not-ready)", async () => {
    const backend = await readyBackend();
    const lexical = new FakeReportLexical([], new Error("cluster down"));
    const envelope = await modeCReportFirstArm(
      baseArgs(),
      baseDeps({
        storage: withVectorSeam(
          backend,
          vectorSeam([], new Error("summary read failed"))
        ),
        lexical: lexical as unknown as AssembleDeps["lexical"],
      })
    );
    expect(envelope.chunks).toEqual([]);
    expect(envelope.degraded).toBe(true);
    expect(envelope.degraded_reasons).toContain(
      "community_report:attempted-and-failed"
    );
  });

  it("names community_report:unattempted when no report arm can run at all", async () => {
    // Ready state, no lexical seam, no summary seam, no credentials:
    // C cannot answer and must not look like a healthy miss.
    const backend = await readyBackend();
    const envelope = await modeCReportFirstArm(
      baseArgs(),
      baseDeps({ embedder: new UnavailableEmbedder(), storage: backend })
    );
    expect(envelope.chunks).toEqual([]);
    expect(envelope.degraded).toBe(true);
    expect(envelope.degraded_reasons).toContain(
      "community_report:unattempted"
    );
  });

  it("treats a ready generation with zero summaries as a healthy miss", async () => {
    const backend = await readyBackend();
    const envelope = await modeCReportFirstArm(
      baseArgs(),
      baseDeps({
        storage: withVectorSeam(backend, vectorSeam([])),
        lexical: new FakeReportLexical(
          []
        ) as unknown as AssembleDeps["lexical"],
      })
    );
    // READY proves the last swap was complete; an empty generation with no
    // matching reports is the same healthy stay as B's zero-hit arms.
    expect(envelope).toEqual({ chunks: [] });
  });
});

describe("modeCReportFirstArm drop to citable windows", () => {
  async function backendWithChunks(): Promise<MemoryBackend> {
    const backend = await readyBackend();
    const chunk = (id: string, content: string): ChunkRecord => ({
      id,
      content,
      embedding: new Array<number>(TEST_DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
      source_ref: `src/${id}`,
      metadata: {},
      valid_from: "2024-01-01T00:00:00Z",
      valid_until: null,
      created_at: "2024-01-01T00:00:00Z",
    });
    await backend.upsert([
      chunk("w-1", "window one about alpha"),
      chunk("w-2", "window two about alpha"),
    ]);
    return backend;
  }

  it("leads with summary rows and fills the remaining slots with windows by default", async () => {
    const backend = await backendWithChunks();
    const envelope = await modeCReportFirstArm(
      baseArgs({ limit: 3 }),
      baseDeps({
        storage: withVectorSeam(backend, vectorSeam(reportRows())),
      })
    );
    expect(envelope.chunks).toHaveLength(3);
    // Reports lead: the citable summaries keep the front.
    expect(envelope.chunks.slice(0, 2).map((c) => c.id)).toEqual([
      "sum-1",
      "sum-2",
    ]);
    for (const hit of envelope.chunks.slice(0, 2)) {
      expect(hit.metadata).toMatchObject({ kind: "community-summary" });
    }
    // The drop slot carries a citable window chunk, not another report.
    const windowHit = envelope.chunks[2]!;
    expect(windowHit.id).toMatch(/^w-/);
    expect(windowHit.metadata).toBeUndefined();
    expect(envelope.degraded).toBeUndefined();
  });

  it("skips the drop entirely when filters.c_drop_windows=0", async () => {
    const backend = await backendWithChunks();
    const envelope = await modeCReportFirstArm(
      baseArgs({ limit: 10, filters: { c_drop_windows: "0" } }),
      baseDeps({
        storage: withVectorSeam(backend, vectorSeam(reportRows())),
      })
    );
    expect(envelope.chunks.map((c) => c.id)).toEqual(["sum-1", "sum-2"]);
  });

  it("never drops to windows when there is no report hit (windows alone are not C)", async () => {
    const backend = await backendWithChunks();
    const envelope = await modeCReportFirstArm(
      baseArgs({ query: "alpha" }),
      baseDeps({
        storage: withVectorSeam(backend, vectorSeam([])),
      })
    );
    // Reports found nothing → the drop precondition (≥1 report hit) fails
    // and no window may masquerade as a C answer.
    expect(envelope.chunks).toEqual([]);
  });

  it("keeps c_drop_windows out of the window assembly's exact-match filters", async () => {
    const backend = await backendWithChunks();
    const seen: Array<Record<string, string> | undefined> = [];
    const recording = Object.create(backend, {
      search: {
        enumerable: true,
        configurable: true,
        writable: true,
        value: async (embedding: number[], opts: { filters?: Record<string, string> }) => {
          seen.push(opts.filters);
          return [];
        },
      },
    }) as MemoryBackend;
    await modeCReportFirstArm(
      baseArgs({
        limit: 3,
        filters: { c_drop_windows: "1", source_ref: "src/w-1" },
      }),
      baseDeps({
        storage: withVectorSeam(recording, vectorSeam(reportRows())),
      })
    );
    // The routing key never reaches a backend (it would become an ES term
    // clause); the real match filter is forwarded untouched.
    expect(seen.length).toBeGreaterThan(0);
    for (const filters of seen) {
      expect(filters).not.toHaveProperty("c_drop_windows");
      expect(filters).not.toHaveProperty("search_mode");
      expect(filters?.source_ref).toBe("src/w-1");
    }
  });

  it("caps the combined answer at limit when reports overflow it", async () => {
    const backend = await backendWithChunks();
    const envelope = await modeCReportFirstArm(
      baseArgs({ limit: 1 }),
      baseDeps({
        storage: withVectorSeam(backend, vectorSeam(reportRows())),
      })
    );
    expect(envelope.chunks).toHaveLength(1);
    expect(envelope.chunks[0]!.id).toBe("sum-1");
  });

  it("names window_fill:attempted-and-failed when the drop assembly throws, and the reports still answer", async () => {
    const backend = await readyBackend();
    const failingSearch = Object.create(backend, {
      search: {
        enumerable: true,
        configurable: true,
        writable: true,
        value: async () => {
          throw new Error("vector store down");
        },
      },
    }) as MemoryBackend;
    const envelope = await modeCReportFirstArm(
      baseArgs({ limit: 3 }),
      baseDeps({
        storage: withVectorSeam(failingSearch, vectorSeam(reportRows())),
      })
    );
    // The reports already earned the answer — the failed fill degrades,
    // it never destroys them and never types like the not-ready exit.
    expect(envelope.chunks.map((c) => c.id)).toEqual(["sum-1", "sum-2"]);
    expect(envelope.degraded).toBe(true);
    expect(envelope.degraded_reasons).toContain(
      "window_fill:attempted-and-failed"
    );
  });

  it("embeds the query once even though the drop reuses the full assembler", async () => {
    const backend = await backendWithChunks();
    let embedCalls = 0;
    const counting = {
      available: true as const,
      async embed(texts: string[]): Promise<number[][]> {
        embedCalls += 1;
        return texts.map(() =>
          new Array<number>(TEST_DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0))
        );
      },
    };
    await modeCReportFirstArm(
      baseArgs({ limit: 3 }),
      baseDeps({
        embedder: counting as unknown as AssembleDeps["embedder"],
        storage: withVectorSeam(backend, vectorSeam(reportRows())),
      })
    );
    expect(embedCalls).toBe(1);
  });
});
