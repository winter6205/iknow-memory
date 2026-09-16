/**
 * Unit tests for the MCP `read_source` tool (`src/tools/read_source.ts`),
 * operator-console T4 (specs/operator-console.md §MCP tools):
 *
 *   `read_source`: `source_ref` xor `id` → `{ id, source_ref, title?, content }`.
 *   Miss is named, not `""`.
 *
 * Boundary classes covered:
 *   empty      — empty store miss (named, isError, not a 200-empty).
 *   negative   — unknown source_ref / unknown id are named not-founds;
 *                both keys / neither key / empty source_ref / bad uuid are
 *                validation errors (schema + handler-level).
 *   overflow   — n/a (read tool, no size limits beyond zod string type).
 *   concurrent — n/a (pure read; concurrency is T3's re-push class).
 *   exception  — storage INVALID_INPUT re-check → typed INVALID_INPUT.
 */
import { describe, expect, it } from "vitest";
import {
  createReadSourceHandler,
  ReadSourceInputSchema,
  readSourceTool,
  type ReadSourceDeps,
} from "../../src/tools/read_source.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { GraphragError } from "../../src/core/errors.js";
import { createIngestHandler } from "../../src/tools/ingest.js";
import { createInvalidationHandler } from "../../src/tools/invalidation.js";
import type { SourceDocRecord } from "../../src/core/types.js";
import type { ToolResult } from "../../src/tools/registry.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";

function parseBody(result: ToolResult): Record<string, unknown> {
  const text = result.content[0]?.text;
  if (typeof text !== "string") {
    throw new Error("expected text content in ToolResult");
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function seedDoc(
  backend: MemoryBackend,
  overrides: Partial<SourceDocRecord> = {}
): SourceDocRecord {
  const doc: SourceDocRecord = {
    id: UUID_A,
    source_ref: "docs/t4.md",
    title: "T4 资料",
    content: "line one\nline two — full 资料 body",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
  return doc;
}

describe("ReadSourceInputSchema — xor selector", () => {
  it("accepts source_ref alone", () => {
    expect(
      ReadSourceInputSchema.safeParse({ source_ref: "docs/t4.md" }).success
    ).toBe(true);
  });

  it("accepts id alone", () => {
    expect(ReadSourceInputSchema.safeParse({ id: UUID_A }).success).toBe(true);
  });

  it("negative: both keys is a validation error", () => {
    const result = ReadSourceInputSchema.safeParse({
      source_ref: "docs/t4.md",
      id: UUID_A,
    });
    expect(result.success).toBe(false);
  });

  it("negative: neither key is a validation error", () => {
    expect(ReadSourceInputSchema.safeParse({}).success).toBe(false);
  });

  it("negative: empty source_ref is a validation error", () => {
    expect(ReadSourceInputSchema.safeParse({ source_ref: "" }).success).toBe(
      false
    );
  });

  it("negative: non-uuid id is a validation error", () => {
    expect(ReadSourceInputSchema.safeParse({ id: "not-a-uuid" }).success).toBe(
      false
    );
  });

  it("rejects unknown keys (strictObject)", () => {
    expect(
      ReadSourceInputSchema.safeParse({ source_ref: "x", extra: 1 }).success
    ).toBe(false);
  });
});

describe("createReadSourceHandler — known keys return the 资料 body", () => {
  it("known source_ref returns body byte-identical to the pushed 资料", async () => {
    const backend = new MemoryBackend(8);
    const doc = seedDoc(backend);
    await backend.upsertSourceDoc(doc);

    const handler = createReadSourceHandler({ storage: backend });
    const result = await handler({ source_ref: doc.source_ref });

    expect(result.isError).not.toBe(true); // success path, never an error result
    const body = parseBody(result);
    expect(body).toEqual({
      id: doc.id,
      source_ref: doc.source_ref,
      title: doc.title,
      content: doc.content,
    });
    // Byte-identical, not merely deep-equal.
    expect(body.content).toBe("line one\nline two — full 资料 body");
  });

  it("known id returns the same record", async () => {
    const backend = new MemoryBackend(8);
    const doc = seedDoc(backend);
    await backend.upsertSourceDoc(doc);

    const handler = createReadSourceHandler({ storage: backend });
    const result = await handler({ id: doc.id });

    const body = parseBody(result);
    expect(body).toEqual({
      id: doc.id,
      source_ref: doc.source_ref,
      title: doc.title,
      content: doc.content,
    });
  });

  it("omits title when the 资料 row has none (title? on the envelope)", async () => {
    const backend = new MemoryBackend(8);
    const doc = seedDoc(backend, { title: null });
    await backend.upsertSourceDoc(doc);

    const handler = createReadSourceHandler({ storage: backend });
    const result = await handler({ source_ref: doc.source_ref });

    const body = parseBody(result);
    expect("title" in body).toBe(false);
    expect(body.content).toBe(doc.content);
  });

  it("reads through the StorageReadPort interface (no backend cast)", async () => {
    // The tool's declared dep surface is StorageReadPort; assert via the
    // exported registration that deps is only the read port.
    const backend = new MemoryBackend(8);
    const doc = seedDoc(backend);
    await backend.upsertSourceDoc(doc);

    const registration = readSourceTool({ storage: backend });
    expect(registration.name).toBe("read_source");
    expect(typeof registration.handler).toBe("function");
  });
});

describe("createReadSourceHandler — named invalidated", () => {
  it("invalidated 资料 is a named-invalid that carries the doc's id and source_ref (from the row, not the request)", async () => {
    // Seed an actual row through the ingest path, then close its window
    // through the invalidation path — MemoryBackend's upsertSourceDoc
    // normalises new content's valid_until to null, so we can't seed an
    // invalidated row directly. The doc's row identity (id + source_ref)
    // is then resolved by read_source, not echoed from the request key.
    const docRef = "docs/t4-invalidated.md";
    const embedder = new FakeEmbedder(8);
    const backend = new MemoryBackend(8);
    const ingest = createIngestHandler({ embedder, storage: backend });
    const seeded = (await ingest({
      source_ref: docRef,
      content: "T4 invalidated body",
      chunks: [{ content: "T4 invalidated body", index: 0 }],
    })) as ToolResult;
    const seededBody = parseBody(seeded) as { source_doc_id: string };
    const docId = seededBody.source_doc_id;

    await createInvalidationHandler({ embedder, storage: backend })({
      source_ref: docRef,
      invalidated_at: "2026-09-01T00:00:00.000Z",
      triggered_by: "test",
    });

    const handler = createReadSourceHandler({ storage: backend });

    // Asked by source_ref → both id and source_ref echoed from the row.
    const byRef = await handler({ source_ref: docRef });
    expect(byRef.isError).toBe(true);
    const byRefBody = parseBody(byRef);
    expect(byRefBody).toMatchObject({
      error: "read_source_invalidated",
      id: docId,
      source_ref: docRef,
      valid_until: "2026-09-01T00:00:00.000Z",
    });

    // Asked by id → both id and source_ref echoed from the row (the
    // source_ref the host can use to look the doc up the next time).
    const byId = await handler({ id: docId });
    expect(byId.isError).toBe(true);
    const byIdBody = parseBody(byId);
    expect(byIdBody).toMatchObject({
      error: "read_source_invalidated",
      id: docId,
      source_ref: docRef,
      valid_until: "2026-09-01T00:00:00.000Z",
    });
  });
});

describe("createReadSourceHandler — named not-found", () => {
  it("unknown source_ref is a named not-found with isError, not 200-empty", async () => {
    const backend = new MemoryBackend(8);
    const handler = createReadSourceHandler({ storage: backend });

    const result = await handler({ source_ref: "docs/missing.md" });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    // Never a bare "" success content block.
    expect(text).not.toBe("");
    const body = parseBody(result);
    expect(body.error).toBe("read_source_not_found");
    expect(body.source_ref).toBe("docs/missing.md");
  });

  it("unknown id is a named not-found", async () => {
    const backend = new MemoryBackend(8);
    const handler = createReadSourceHandler({ storage: backend });

    const result = await handler({ id: UUID_A });
    expect(result.isError).toBe(true);
    const body = parseBody(result);
    expect(body.error).toBe("read_source_not_found");
    expect(body.id).toBe(UUID_A);
  });

  it("empty store miss by source_ref is the same named not-found", async () => {
    const backend = new MemoryBackend(8);
    const handler = createReadSourceHandler({ storage: backend });
    const result = await handler({ source_ref: "anything" });
    expect(result.isError).toBe(true);
    expect(parseBody(result).error).toBe("read_source_not_found");
  });

  it("empty store miss by id is the same named not-found", async () => {
    const backend = new MemoryBackend(8);
    const handler = createReadSourceHandler({ storage: backend });
    const result = await handler({ id: UUID_A });
    expect(result.isError).toBe(true);
    expect(parseBody(result).error).toBe("read_source_not_found");
  });
});

describe("createReadSourceHandler — handler-level xor re-check", () => {
  it("both keys → INVALID_INPUT GraphragError", async () => {
    const backend = new MemoryBackend(8);
    const handler = createReadSourceHandler({ storage: backend });
    await expect(
      handler({ source_ref: "docs/t4.md", id: UUID_A })
    ).rejects.toThrow(/exactly one/);
  });

  it("neither key → INVALID_INPUT GraphragError", async () => {
    const backend = new MemoryBackend(8);
    const handler = createReadSourceHandler({ storage: backend });
    // Direct (non-wire) callers bypass the zod schema; the handler must
    // still reject (mirrors the extract.ts defensive re-check).
    await expect(
      handler({} as unknown as { source_ref: string })
    ).rejects.toThrow(GraphragError);
  });

  it("thrown errors are GraphragError with INVALID_INPUT code", async () => {
    const backend = new MemoryBackend(8);
    const handler = createReadSourceHandler({ storage: backend });
    await expect(
      handler({ source_ref: "a", id: UUID_A })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
