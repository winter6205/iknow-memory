/**
 * 档 A arm unit tests (specs/search-mode-retrieve.md, ADR-0060).
 *
 * Contract under test: A is lexical-first over in-window children, and a
 * child hit contributes the PARENT (抽图窗) body as the citable
 * `chunks[]` text — never the child alone. The child span survives at most
 * as metadata on the parent entry (single SoR, no second ranking source).
 *
 * Every case runs offline against MemoryBackend (in-process BM25 + ledger
 * source-doc rows), the same fake seam the rest of the retrieval suite uses.
 */
import { describe, it, expect } from "vitest";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { modeAParentWindowArm } from "../../src/core/retrieval/mode-a-arm.js";
import type {
  AssembleArgs,
  AssembleDeps,
} from "../../src/core/retrieval/index.js";
import type {
  RetrievedChunk,
  SearchOptions,
  SourceDocRecord,
  StorageBackend,
} from "../../src/core/types.js";
import type { ChunkRecord } from "../../src/core/types.js";

const TEST_DIM = 8;

/** Metadata shape the A arm attaches to parent hits (structural cast — the
 * envelope is JSON-parsed in the handler-level tests; here we read it off
 * the in-memory envelope). */
interface ParentWindowMetadata {
  kind: "parent-window";
  sourceDocId: string;
  children: Array<{ chunkId: string; ordinal: number | null; score: number }>;
}

function unitAxisEmbedding(): number[] {
  const v = new Array<number>(TEST_DIM).fill(0);
  v[0] = 1;
  return v;
}

function makeDoc(
  patch: Partial<SourceDocRecord> & { id: string; content: string }
): SourceDocRecord {
  return {
    source_ref: patch.source_ref ?? `src/${patch.id}`,
    title: patch.title ?? null,
    created_at: patch.created_at ?? "2024-01-01T00:00:00Z",
    ...patch,
  };
}

function makeChild(
  patch: Partial<ChunkRecord> & { id: string; content: string }
): ChunkRecord {
  return {
    embedding: unitAxisEmbedding(),
    source_ref: patch.source_ref ?? `src/${patch.source_doc_id ?? "none"}`,
    metadata: {},
    valid_from: "2024-01-01T00:00:00Z",
    valid_until: null,
    created_at: "2024-01-01T00:00:00Z",
    ...patch,
  };
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

function metadataOf(chunk: unknown): ParentWindowMetadata {
  return (chunk as { metadata: ParentWindowMetadata }).metadata;
}

describe("modeAParentWindowArm (档 A, child hit → parent body)", () => {
  it("returns the parent 抽图窗 body as chunk text for a child lexical hit", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    const parentBody =
      "PARENT WINDOW BODY: the full extract window that contains alpha terms and more context.";
    await backend.upsertSourceDoc(
      makeDoc({ id: "doc-1", source_ref: "src/one", content: parentBody })
    );
    // The pushed chunk row IS the child (fast.ts): its content is only a
    // slice of the parent body, and it back-points via source_doc_id.
    await backend.upsert([
      makeChild({
        id: "c1",
        content: "a child slice about alpha terms",
        source_ref: "src/one",
        source_doc_id: "doc-1",
        ordinal: 0,
      }),
    ]);

    const envelope = await modeAParentWindowArm(
      baseArgs({ query: "alpha" }),
      baseDeps({ storage: backend })
    );

    expect(envelope.chunks).toHaveLength(1);
    const hit = envelope.chunks[0]!;
    // Citable body is the PARENT, not the child slice.
    expect(hit.content).toBe(parentBody);
    // The parent's 资料 id is the citation key (ADR-0060: "use that id").
    expect(hit.id).toBe("doc-1");
    expect(hit.source_ref).toBe("src/one");
    expect(metadataOf(hit).kind).toBe("parent-window");
    expect(metadataOf(hit).sourceDocId).toBe("doc-1");
    expect(metadataOf(hit).children).toEqual([
      { chunkId: "c1", ordinal: 0, score: hit.score },
    ]);
    // Child hit found → healthy envelope.
    expect(envelope.degraded).toBeUndefined();
  });

  it("never surfaces the child-only text as the citable body", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsertSourceDoc(
      makeDoc({ id: "doc-1", content: "parent body alpha" })
    );
    await backend.upsert([
      makeChild({
        id: "c1",
        content: "child slice alpha ONLY",
        source_doc_id: "doc-1",
        ordinal: 0,
      }),
    ]);
    const envelope = await modeAParentWindowArm(
      baseArgs({ query: "alpha" }),
      baseDeps({ storage: backend })
    );
    const joined = envelope.chunks.map((c) => c.content).join("\n");
    expect(joined).not.toContain("child slice alpha ONLY");
    expect(joined).toContain("parent body alpha");
  });

  it("deduplicates multiple children of one parent into a single parent hit", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsertSourceDoc(
      makeDoc({ id: "doc-1", content: "parent body spans both slices" })
    );
    await backend.upsert([
      makeChild({
        id: "c1",
        content: "first slice alpha",
        source_doc_id: "doc-1",
        ordinal: 0,
      }),
      makeChild({
        id: "c2",
        content: "second slice beta",
        source_doc_id: "doc-1",
        ordinal: 1,
      }),
    ]);

    const envelope = await modeAParentWindowArm(
      baseArgs({ query: "alpha beta" }),
      baseDeps({ storage: backend })
    );

    // Minimal reasonable spec-undefined choice: one entry per parent, the
    // best-ranked child wins the position/score, every contributing child
    // stays visible as span metadata.
    expect(envelope.chunks).toHaveLength(1);
    const hit = envelope.chunks[0]!;
    expect(hit.id).toBe("doc-1");
    const children = metadataOf(hit).children;
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.chunkId).sort()).toEqual(["c1", "c2"]);
    expect(children.map((c) => c.ordinal).sort()).toEqual([0, 1]);
    // Children are listed in child-rank order: the first one carries the
    // (higher) score of the pair.
    expect(children[0]!.score).toBeGreaterThanOrEqual(children[1]!.score);
  });

  it("orders parents by their best-ranked child", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsertSourceDoc(
      makeDoc({ id: "doc-strong", content: "strong parent body" })
    );
    await backend.upsertSourceDoc(
      makeDoc({ id: "doc-weak", content: "weak parent body" })
    );
    await backend.upsert([
      // tf 3 on a short child clearly outranks tf 1 on a long child.
      makeChild({
        id: "c-strong",
        content: "alpha alpha alpha",
        source_doc_id: "doc-strong",
        ordinal: 0,
      }),
      makeChild({
        id: "c-weak",
        content: "alpha one two three four five six seven eight",
        source_doc_id: "doc-weak",
        ordinal: 0,
      }),
    ]);

    const envelope = await modeAParentWindowArm(
      baseArgs({ query: "alpha" }),
      baseDeps({ storage: backend })
    );

    expect(envelope.chunks.map((c) => c.id)).toEqual([
      "doc-strong",
      "doc-weak",
    ]);
    expect(envelope.chunks[0]!.content).toBe("strong parent body");
  });

  it("applies limit AFTER parent dedup (overflow class)", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    for (const [i, docId] of ["d1", "d2", "d3"].entries()) {
      await backend.upsertSourceDoc(
        makeDoc({ id: docId, content: `parent body ${docId} alpha` })
      );
      await backend.upsert([
        makeChild({
          id: `c${i}`,
          content: `child slice ${i} alpha`,
          source_doc_id: docId,
          ordinal: 0,
        }),
      ]);
    }

    const envelope = await modeAParentWindowArm(
      baseArgs({ query: "alpha", limit: 2 }),
      baseDeps({ storage: backend })
    );

    expect(envelope.chunks).toHaveLength(2);
    for (const hit of envelope.chunks) {
      expect(hit.content).toContain("parent body");
    }
  });

  it("truncates to limit even when many children share few parents", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsertSourceDoc(
      makeDoc({ id: "doc-1", content: "only parent body alpha" })
    );
    await backend.upsert([
      makeChild({
        id: "c1",
        content: "alpha one",
        source_doc_id: "doc-1",
        ordinal: 0,
      }),
      makeChild({
        id: "c2",
        content: "alpha two",
        source_doc_id: "doc-1",
        ordinal: 1,
      }),
    ]);
    const envelope = await modeAParentWindowArm(
      baseArgs({ query: "alpha", limit: 1 }),
      baseDeps({ storage: backend })
    );
    expect(envelope.chunks).toHaveLength(1);
    expect(envelope.chunks[0]!.id).toBe("doc-1");
    // Both contributing children stay visible even though one slot remains.
    expect(metadataOf(envelope.chunks[0]!).children).toHaveLength(2);
  });

  it("skips a parentless child and degrades instead of citing it child-only", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsertSourceDoc(
      makeDoc({ id: "doc-1", content: "good parent body" })
    );
    await backend.upsert([
      makeChild({
        id: "c-good",
        content: "matched slice alpha",
        source_doc_id: "doc-1",
        ordinal: 0,
      }),
      // Legacy row written before the back-pointer columns exist.
      makeChild({ id: "c-legacy", content: "another alpha slice" }),
    ]);

    const envelope = await modeAParentWindowArm(
      baseArgs({ query: "alpha" }),
      baseDeps({ storage: backend })
    );

    // The resolvable parent still answers...
    expect(envelope.chunks.map((c) => c.id)).toEqual(["doc-1"]);
    // ...but the parentless child NEVER appears as its own citable body.
    const joined = envelope.chunks.map((c) => c.content).join("\n");
    expect(joined).not.toContain("another alpha slice");
    // ...and the partial parent failure is named, not silent.
    expect(envelope.degraded).toBe(true);
    expect(envelope.degraded_reasons).toContain(
      "parent_window:attempted-and-failed"
    );
  });

  it("returns no chunks and names the missing lexical seam when the backend cannot rank", async () => {
    // A bare vector-only StorageBackend: no searchLexical at all.
    const vectorOnly = {
      upsert: async () => [],
      search: async () => [],
      close: async () => {},
      upsertSourceDoc: async (doc: SourceDocRecord) => doc,
      deleteChunksForSourceDoc: async () => {},
      listChunksBySourceDoc: async () => [],
      markSourceDocReady: async () => {},
      recordSourceDocFailure: async () => {},
    } satisfies StorageBackend;

    const envelope = await modeAParentWindowArm(
      baseArgs(),
      baseDeps({ storage: vectorOnly })
    );

    expect(envelope.chunks).toEqual([]);
    expect(envelope.degraded).toBe(true);
    expect(envelope.degraded_reasons).toContain("keyword_bm25:unattempted");
  });

  it("turns a lexical-arm throw into keyword_bm25 attempted-and-failed, not a crash", async () => {
    const lexical = {
      async searchLexical(): Promise<RetrievedChunk[]> {
        throw new Error("cluster unreachable");
      },
    };
    const envelope = await modeAParentWindowArm(
      baseArgs(),
      baseDeps({
        storage: new MemoryBackend(TEST_DIM),
        lexical: lexical as unknown as AssembleDeps["lexical"],
      })
    );
    expect(envelope.chunks).toEqual([]);
    expect(envelope.degraded).toBe(true);
    expect(envelope.degraded_reasons).toContain(
      "keyword_bm25:attempted-and-failed"
    );
  });

  it("turns a parent-lookup throw into parent_window attempted-and-failed with no child-only answer", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsertSourceDoc(
      makeDoc({ id: "doc-1", content: "parent body alpha" })
    );
    await backend.upsert([
      makeChild({
        id: "c1",
        content: "child alpha",
        source_doc_id: "doc-1",
        ordinal: 0,
      }),
    ]);
    // Same ledger, failing parent seam: the throw must not be papered over
    // by citing the child text as if it were a parent.
    const failingStorage = Object.create(backend, {
      parentWindowsByChunkIds: {
        async value() {
          throw new Error("ledger read failed");
        },
      },
    }) as MemoryBackend;

    const envelope = await modeAParentWindowArm(
      baseArgs({ query: "alpha" }),
      baseDeps({ storage: failingStorage })
    );

    expect(envelope.chunks).toEqual([]);
    expect(envelope.degraded).toBe(true);
    expect(envelope.degraded_reasons).toContain(
      "parent_window:attempted-and-failed"
    );
  });

  it("treats a backend without the parent seam as unattempted, never child-only", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsert([
      makeChild({ id: "c1", content: "child alpha" }),
    ]);
    const vectorOnlyWithLexical = Object.create(backend, {
      parentWindowsByChunkIds: { value: undefined },
    }) as MemoryBackend;

    const envelope = await modeAParentWindowArm(
      baseArgs({ query: "alpha" }),
      baseDeps({ storage: vectorOnlyWithLexical })
    );

    expect(envelope.chunks).toEqual([]);
    expect(envelope.degraded).toBe(true);
    expect(envelope.degraded_reasons).toContain("parent_window:unattempted");
  });

  it("leaves a lexical miss an un-degraded empty answer (found-nothing is not a failure)", async () => {
    const backend = new MemoryBackend(TEST_DIM);
    await backend.upsert([
      makeChild({
        id: "c1",
        content: "child about beta",
        source_doc_id: "doc-1",
        ordinal: 0,
      }),
    ]);
    const envelope = await modeAParentWindowArm(
      baseArgs({ query: "zzz-nomatch" }),
      baseDeps({ storage: backend })
    );
    expect(envelope).toEqual({ chunks: [] });
  });

  it("prefers the wired lexical backend over the storage one and forwards exact-match filters", async () => {
    const seen: Array<SearchOptions["filters"]> = [];
    const recordingLexical = {
      async searchLexical(
        _query: string,
        opts: SearchOptions
      ): Promise<RetrievedChunk[]> {
        seen.push(opts.filters);
        return [];
      },
    };
    const backend = new MemoryBackend(TEST_DIM);
    await modeAParentWindowArm(
      baseArgs({ query: "alpha", filters: { source_ref: "docs/a.md" } }),
      baseDeps({
        storage: backend,
        lexical: recordingLexical as unknown as AssembleDeps["lexical"],
      })
    );
    // The handler strips search_mode before dispatch; the arm receives and
    // forwards only real match filters.
    expect(seen).toEqual([{ source_ref: "docs/a.md" }]);
  });
});
