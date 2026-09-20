/**
 * specs/contextual-wrap-embed.md — chunk embed-time wrap.
 *
 * Contract: when embedding a chunk, a non-empty parent 资料 `title` is
 * prepended to the EMBEDDER INPUT only (`title\nslice`). The stored chunk
 * `content` and 资料 `content` stay the pushed bytes; retrieve query
 * embeddings stay the raw query; the wrap is not keyed on entity type;
 * MCP envelopes gain no wrap-instruction field (schemas stay strict).
 */
import { describe, expect, it } from "vitest";

import { embedTextForSlice } from "../src/core/embed-log.js";
import { IngestInputSchema, createIngestHandler } from "../src/tools/ingest.js";
import { PushInputSchema, createPushHandler } from "../src/tools/push.js";
import {
  RetrieveInputSchema,
  createRetrieveHandler,
} from "../src/tools/retrieve.js";
import { FakeEmbedder, type EmbeddingClient } from "../src/core/embedder.js";
import { MemoryBackend } from "../src/core/storage/memory-backend.js";
import { GraphragError } from "../src/core/errors.js";

const TEST_DIM = 32;

/** FakeEmbedder twin that records every embed call's `texts` array. */
function countingEmbedder(dim: number): {
  embedder: EmbeddingClient;
  embeddedTexts: () => string[];
} {
  const inner = new FakeEmbedder(dim);
  const calls: string[][] = [];
  const embedder: EmbeddingClient = {
    embed: async (texts) => {
      calls.push([...texts]);
      return inner.embed(texts);
    },
  };
  return { embedder, embeddedTexts: () => calls.flat() };
}

describe("embedTextForSlice — wrap helper", () => {
  it("prepends the title then the slice with a newline delimiter", () => {
    expect(embedTextForSlice("Acme", "raised funds")).toBe(
      "Acme\nraised funds"
    );
  });

  it("returns the slice verbatim for a null or undefined title", () => {
    expect(embedTextForSlice(null, "raised funds")).toBe("raised funds");
    expect(embedTextForSlice(undefined, "raised funds")).toBe("raised funds");
  });

  it("treats an empty or whitespace-only title as absent", () => {
    expect(embedTextForSlice("", "raised funds")).toBe("raised funds");
    expect(embedTextForSlice("   ", "raised funds")).toBe("raised funds");
    expect(embedTextForSlice("\t\n ", "raised funds")).toBe("raised funds");
  });

  it("is pure and never varies with anything but title and slice text", () => {
    // The helper has exactly two parameters — no entity-type-ish input —
    // and same inputs produce the same output across calls.
    expect(embedTextForSlice.length).toBe(2);
    expect(embedTextForSlice("person", "x")).toBe(
      embedTextForSlice("person", "x")
    );
    expect(embedTextForSlice("person", "x")).toBe("person\nx");
  });
});

describe("ingest — wrap on the embed input only", () => {
  const titledEnvelope = {
    source_ref: "docs/acme-ingest.md",
    content: "alpha middle omega",
    chunks: [
      { content: "alpha", index: 0 },
      { content: "middle", index: 1 },
      { content: "omega", index: 2 },
    ],
    title: "Acme",
    // An entity-type-ish metadata key must not change the wrap.
    metadata: { entity_type: "company" },
  };

  it("embeds `title\\nslice` for every slice of a titled envelope", async () => {
    const { embedder, embeddedTexts } = countingEmbedder(TEST_DIM);
    const handler = createIngestHandler({
      embedder,
      storage: new MemoryBackend(TEST_DIM),
    });
    await handler(titledEnvelope);
    expect(embeddedTexts()).toEqual([
      "Acme\nalpha",
      "Acme\nmiddle",
      "Acme\nomega",
    ]);
  });

  it("stores the pushed bytes verbatim in chunks and the 资料 row", async () => {
    const { embedder } = countingEmbedder(TEST_DIM);
    const storage = new MemoryBackend(TEST_DIM);
    const handler = createIngestHandler({ embedder, storage });
    await handler(titledEnvelope);

    const doc = await storage.getSourceDoc(titledEnvelope.source_ref);
    expect(doc.ok).toBe(true);
    if (!doc.ok) throw new Error("expected source doc");
    expect(doc.value.title).toBe("Acme");
    expect(doc.value.content).toBe("alpha middle omega");

    const chunks = await storage.listChunksBySourceDoc(doc.value.id);
    expect(chunks.map((c) => c.content)).toEqual(["alpha", "middle", "omega"]);
  });

  it("embeds the raw slice when the envelope has no title", async () => {
    const { embedder, embeddedTexts } = countingEmbedder(TEST_DIM);
    const handler = createIngestHandler({
      embedder,
      storage: new MemoryBackend(TEST_DIM),
    });
    await handler({
      source_ref: "docs/untitled.md",
      content: "hello world",
      chunks: [{ content: "hello world", index: 0 }],
    });
    expect(embeddedTexts()).toEqual(["hello world"]);
  });

  it("keeps the embed hard-fail: a throwing embedder writes nothing for a titled envelope", async () => {
    const storage = new MemoryBackend(TEST_DIM);
    const handler = createIngestHandler({
      embedder: {
        embed: async () => {
          throw new GraphragError(
            "embedding request failed",
            "EMBEDDING_FAILED"
          );
        },
      },
      storage,
    });
    await expect(handler(titledEnvelope)).rejects.toMatchObject({
      code: "EMBEDDING_FAILED",
    });
    const doc = await storage.getSourceDoc(titledEnvelope.source_ref);
    expect(doc).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});

describe("push — wrap on the embed input only", () => {
  const titledEnvelope = {
    source_ref: "docs/acme-push.md",
    content: "alpha middle omega",
    chunks: [
      { content: "alpha", index: 0 },
      { content: "middle", index: 1 },
      { content: "omega", index: 2 },
    ],
    title: "Acme",
    metadata: { kind: "doc" },
    valid_from: "2024-01-01T00:00:00Z",
    valid_until: "2024-12-31T00:00:00Z",
  };

  it("embeds `title\\nslice` for every slice of a titled envelope", async () => {
    const { embedder, embeddedTexts } = countingEmbedder(TEST_DIM);
    const handler = createPushHandler({
      embedder,
      storage: new MemoryBackend(TEST_DIM),
    });
    await handler(titledEnvelope);
    expect(embeddedTexts()).toEqual([
      "Acme\nalpha",
      "Acme\nmiddle",
      "Acme\nomega",
    ]);
  });

  it("stores the pushed bytes verbatim in chunks and the 资料 row", async () => {
    const { embedder } = countingEmbedder(TEST_DIM);
    const storage = new MemoryBackend(TEST_DIM);
    const handler = createPushHandler({ embedder, storage });
    await handler(titledEnvelope);

    const doc = await storage.getSourceDoc(titledEnvelope.source_ref);
    expect(doc.ok).toBe(true);
    if (!doc.ok) throw new Error("expected source doc");
    expect(doc.value.title).toBe("Acme");
    expect(doc.value.content).toBe("alpha middle omega");

    const chunks = await storage.listChunksBySourceDoc(doc.value.id);
    expect(chunks.map((c) => c.content)).toEqual(["alpha", "middle", "omega"]);
  });

  it("embeds the raw slice when the envelope has no title", async () => {
    const { embedder, embeddedTexts } = countingEmbedder(TEST_DIM);
    const handler = createPushHandler({
      embedder,
      storage: new MemoryBackend(TEST_DIM),
    });
    await handler({
      source_ref: "docs/untitled-push.md",
      content: "hello world",
      chunks: [{ content: "hello world", index: 0 }],
      metadata: { kind: "doc" },
      valid_from: "2024-01-01T00:00:00Z",
      valid_until: "2024-12-31T00:00:00Z",
    });
    expect(embeddedTexts()).toEqual(["hello world"]);
  });
});

describe("retrieve — query embed stays unwrapped (T3)", () => {
  it("calls embed with the raw query even when a titled 资料 is in the ledger", async () => {
    const ingestSide = countingEmbedder(TEST_DIM);
    const storage = new MemoryBackend(TEST_DIM);
    await createIngestHandler({ embedder: ingestSide.embedder, storage })({
      source_ref: "docs/acme-query.md",
      content: "raised funds",
      chunks: [{ content: "raised funds", index: 0 }],
      title: "Acme",
    });

    const querySide = countingEmbedder(TEST_DIM);
    const retrieve = createRetrieveHandler({
      embedder: querySide.embedder,
      storage,
    });
    const query = "raised funds";
    await retrieve({ query });

    const texts = querySide.embeddedTexts();
    expect(texts).toContain(query);
    expect(texts).not.toContain(`Acme\n${query}`);
  });
});

describe("MCP schemas gain no wrap-instruction field (T3)", () => {
  it("ingest rejects any wrap-ish unknown key (strictObject)", () => {
    const result = IngestInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "body",
      chunks: [{ content: "body", index: 0 }],
      wrap_instruction: true,
    });
    expect(result.success).toBe(false);
  });

  it("push rejects any wrap-ish unknown key (strictObject)", () => {
    const result = PushInputSchema.safeParse({
      source_ref: "docs/x.md",
      content: "body",
      chunks: [{ content: "body", index: 0 }],
      metadata: { kind: "doc" },
      valid_from: "2024-01-01T00:00:00Z",
      valid_until: "2024-12-31T00:00:00Z",
      wrap_instruction: true,
    });
    expect(result.success).toBe(false);
  });

  it("retrieve rejects any wrap-ish unknown key (strictObject)", () => {
    const result = RetrieveInputSchema.safeParse({
      query: "raised funds",
      wrap_instruction: true,
    });
    expect(result.success).toBe(false);
  });

  it("titled ingest and push envelopes still parse (title is the existing field)", () => {
    expect(
      IngestInputSchema.safeParse({
        source_ref: "docs/x.md",
        content: "body",
        chunks: [{ content: "body", index: 0 }],
        title: "Acme",
      }).success
    ).toBe(true);
    expect(
      PushInputSchema.safeParse({
        source_ref: "docs/x.md",
        content: "body",
        chunks: [{ content: "body", index: 0 }],
        metadata: { kind: "doc" },
        valid_from: "2024-01-01T00:00:00Z",
        valid_until: "2024-12-31T00:00:00Z",
        title: "Acme",
      }).success
    ).toBe(true);
  });
});
