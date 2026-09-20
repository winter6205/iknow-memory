/**
 * Embedding generation rotate T3 — query embed bound to the ACTIVE pair.
 *
 * While a rotate is open the operator setting may already describe the
 * INCOMING generation (the boot guard only lets that boot when the rotate
 * is open). The retrieve query vector must still be embedded with the
 * ACTIVE pair — active vectors and an incoming-model query would rank in a
 * foreign cosine space. The env embedder is used UNCHANGED whenever
 * desired == active, and for unwired hosts / pre-ledger stores (state
 * null); the secondary embedder for the active pair comes from the same
 * SlotEmbeddingSource seam T2's persist path uses.
 */
import { describe, expect, it } from "vitest";

import { assembleRetrievalResult } from "../../src/core/retrieval/index.js";
import { modeCReportFirstArm } from "../../src/core/retrieval/mode-c-arm.js";
import type {
  AssembleArgs,
  AssembleDeps,
} from "../../src/core/retrieval/index.js";
import type { SlotEmbeddingSource } from "../../src/core/embed-slots.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import type {
  CommunityIndexStateRow,
  CommunitySummaryRow,
  CommunitySummaryStorage,
} from "../../src/core/retrieval/types.js";
import {
  COMMUNITY_INDEX_STATUS,
  type EmbeddingGenerationState,
} from "../../src/core/types.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";

const DIM = 8;

/** Deterministic marker embedder: every slot carries the tag's char sum. */
function tagEmbedder(tag: string, onCall?: () => void): EmbeddingClient {
  const marker = [...tag].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return {
    available: true,
    modelId: tag,
    async embed(texts: string[]): Promise<number[][]> {
      onCall?.();
      return texts.map(() => new Array<number>(DIM).fill(marker));
    },
  };
}

/** Marker values the assertions compare against: m1 → 158, "2" → 50. */
const M1 = 158;
const M2 = 159;

function openRotateState(
  overrides: Partial<EmbeddingGenerationState> = {}
): EmbeddingGenerationState {
  return {
    activeSlot: "embedding",
    active: { model: "m1", dimensions: DIM },
    incomingSlot: "embedding_g2",
    incoming: { model: "m2", dimensions: DIM },
    rotateMode: "dual_write",
    rollbackSlot: null,
    rollback: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** MemoryBackend + a recorded search seam + an optional cached generation. */
function recordingStorage(
  state: EmbeddingGenerationState | null | undefined
): { storage: MemoryBackend; searches: number[][] } {
  const base = new MemoryBackend(DIM);
  const searches: number[][] = [];
  const storage = Object.create(base, {
    search: {
      enumerable: true,
      configurable: true,
      writable: true,
      value: async (embedding: number[]) => {
        searches.push([...embedding]);
        return [];
      },
    },
    ...(state === undefined
      ? {}
      : {
          getGenerationState: {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => state,
          },
        }),
  }) as MemoryBackend;
  return { storage, searches };
}

function slotSource(
  envTag: string,
  desiredModel: string
): {
  source: SlotEmbeddingSource;
  built: string[];
  activeCalls: { count: number };
} {
  const built: string[] = [];
  const activeCalls = { count: 0 };
  const source: SlotEmbeddingSource = {
    embedder: tagEmbedder(envTag),
    desired: { model: desiredModel, dimensions: DIM },
    buildEmbedder: (pair) => {
      built.push(pair.model ?? "none");
      return tagEmbedder(pair.model ?? "none", () => {
        activeCalls.count += 1;
      });
    },
  };
  return { source, built, activeCalls };
}

function baseArgs(overrides: Partial<AssembleArgs> = {}): AssembleArgs {
  return {
    query: "alpha report",
    validAt: "2026-06-01T00:00:00Z",
    limit: 5,
    ...overrides,
  };
}

describe("query embed binding — assembler uses the ACTIVE pair (T3)", () => {
  it("embeds with the active-pair embedder when env targets the incoming generation", async () => {
    const { storage, searches } = recordingStorage(openRotateState());
    const { source, built } = slotSource("m2", "m2");

    await assembleRetrievalResult(baseArgs(), {
      embedder: source.embedder,
      storage,
      slotEmbedding: source,
    } satisfies AssembleDeps);

    // Exactly one secondary build: the ACTIVE pair, not the incoming one.
    expect(built).toEqual(["m1"]);
    // The active-pair (m1) marker must reach the vector arm; the env
    // incoming-model (m2) vector must never be searched with.
    expect(searches).toHaveLength(1);
    expect(searches[0]).toEqual(new Array<number>(DIM).fill(M1));
  });

  it("uses the env embedder unchanged when desired == active", async () => {
    const state = openRotateState({ active: { model: "m2", dimensions: DIM } });
    const { storage, searches } = recordingStorage(state);
    const { source, built } = slotSource("m2", "m2");

    await assembleRetrievalResult(baseArgs(), {
      embedder: source.embedder,
      storage,
      slotEmbedding: source,
    } satisfies AssembleDeps);

    expect(built).toEqual([]);
    // env marker: no secondary embedder, no re-wrap.
    expect(searches[0]).toEqual(new Array<number>(DIM).fill(M2));
  });

  it("passes the env embedder through with no slot source wired (memory mode / unwired hosts)", async () => {
    const { storage, searches } = recordingStorage(openRotateState());
    const embedder = tagEmbedder("m2");

    await assembleRetrievalResult(baseArgs(), {
      embedder,
      storage,
    } satisfies AssembleDeps);

    expect(searches[0]).toEqual(new Array<number>(DIM).fill(M2));
  });

  it("pre-ledger state (null) keeps the env embedder", async () => {
    const { storage, searches } = recordingStorage(null);
    const { source, built } = slotSource("m2", "m2");

    await assembleRetrievalResult(baseArgs(), {
      embedder: source.embedder,
      storage,
      slotEmbedding: source,
    } satisfies AssembleDeps);

    expect(built).toEqual([]);
    expect(searches[0]).toEqual(new Array<number>(DIM).fill(M2));
  });
});

// ─── mode C ────────────────────────────────────────────────────────────────

const READY: CommunityIndexStateRow = {
  status: COMMUNITY_INDEX_STATUS.READY,
  failure_code: null,
};

function reportRows(): CommunitySummaryRow[] {
  return [
    { id: "sum-1", communityId: "com-1", summary: "alpha community", score: 0.9 },
  ];
}

function vectorSeam(
  rows: CommunitySummaryRow[],
  onSearch: (embedding: number[]) => void
): CommunitySummaryStorage {
  return {
    getCommunitySummaryByCommunityId: async () => undefined,
    searchCommunitySummaries: async (embedding) => {
      onSearch([...embedding]);
      return rows;
    },
  };
}

describe("query embed binding — mode C report vector arm (T3)", () => {
  it("ranks reports on the ACTIVE pair and still embeds the query once through the window fill", async () => {
    const base = new MemoryBackend(DIM);
    await base.setCommunityIndexState(READY);
    const seen: number[][] = [];
    const { source, built, activeCalls } = slotSource("m2", "m2");
    const storage = Object.create(base, {
      communitySummaries: {
        enumerable: true,
        configurable: true,
        writable: true,
        value: vectorSeam(reportRows(), (embedding) => seen.push(embedding)),
      },
      getGenerationState: {
        enumerable: true,
        configurable: true,
        writable: true,
        value: () => openRotateState(),
      },
      search: {
        enumerable: true,
        configurable: true,
        writable: true,
        value: async (embedding: number[]) => {
          seen.push([...embedding]);
          return [];
        },
      },
    }) as MemoryBackend;

    await modeCReportFirstArm(baseArgs({ limit: 3 }), {
      embedder: source.embedder,
      storage,
      slotEmbedding: source,
    } satisfies AssembleDeps);

    expect(built).toEqual(["m1"]);
    // Both vector consumers (report arm + window fill) share ONE active-pair
    // embedding: the single-embed-per-retrieve memo survives the C drop.
    expect(activeCalls.count).toBe(1);
    expect(seen).toHaveLength(2);
    for (const vector of seen) {
      expect(vector).toEqual(new Array<number>(DIM).fill(M1));
    }
  });
});
