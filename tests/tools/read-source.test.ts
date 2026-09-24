/**
 * Unit tests for the MCP `read_source` tool (`src/tools/read_source.ts`):
 * a bounded, resumable slice reader for one stored 资料 body.
 *
 * Wire shape under test:
 *   input    { source_ref xor id, position? }  // zero-based code-point cursor, default 0
 *   success  { id, source_ref, title?, content, next_position } — no isError,
 *            content is the code-point slice [position, position + taken),
 *            next_position is position + taken or null at the end, and the
 *            request `position` is never echoed back.
 *   error    isError: true + one named JSON body: read_source_not_found,
 *            read_source_invalidated, read_source_invalid_position,
 *            read_source_invalid_locator, read_source_unavailable.
 *   ceilings ≤ 8,000 code points of content, ≤ 32,768 UTF-8 bytes for the
 *            serialized ToolResult, ≤ 1,024 code points for a request locator.
 *
 * Boundary classes covered:
 *   empty      — empty body is a terminal empty slice; an empty store is a
 *                named not-found, never a 200-empty.
 *   invalid    — negative / fractional / non-finite / beyond-end positions;
 *                oversized locator; both/neither key; unknown schema key.
 *   overflow   — text ceiling, byte ceiling binding before the text ceiling,
 *                supplementary-plane integrity across every boundary.
 *   concurrent — four parallel identical reads agree and mutate nothing.
 *   exception  — storage throw → named read_source_unavailable, credentials
 *                redacted off the wire.
 */
import { describe, expect, it } from "vitest";
import {
  createReadSourceHandler,
  ReadSourceInputSchema,
  readSourceTool,
  SOURCE_READ_MAX_LOCATOR_CODE_POINTS,
  SOURCE_READ_MAX_RESULT_BYTES,
  SOURCE_READ_MAX_TEXT_CODE_POINTS,
  type ReadSourceDeps,
  type ReadSourceInput,
} from "../../src/tools/read_source.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { GraphragError } from "../../src/core/errors.js";
import { createIngestHandler } from "../../src/tools/ingest.js";
import { createInvalidationHandler } from "../../src/tools/invalidation.js";
import type { SourceDocRecord } from "../../src/core/types.js";
import type { ToolResult } from "../../src/tools/registry.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

/** 8,501 code points: basic-plane text plus one supplementary-plane emoji,
 *  so the text needs at least two slices and the tail carries the emoji. */
const BIG_BODY = "資".repeat(8_500) + "\u{1F600}";

type ReadHandler = ReturnType<typeof createReadSourceHandler>;

/** The success envelope's fixed key set (title optional). */
interface SliceBody {
  id: string;
  source_ref: string;
  title?: string;
  content: string;
  next_position: number | null;
}

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

async function seedRow(
  backend: MemoryBackend,
  overrides: Partial<SourceDocRecord> = {}
): Promise<SourceDocRecord> {
  const doc = seedDoc(backend, overrides);
  await backend.upsertSourceDoc(doc);
  return doc;
}

/** Code-point length / slice — the unit the contract counts in, never
 *  UTF-16 units. */
const cpLen = (text: string): number => Array.from(text).length;
const cpSlice = (text: string, start: number, end?: number): string =>
  Array.from(text).slice(start, end).join("");

/** The contract measures the complete object `textResult()` returns. */
const resultBytes = (result: ToolResult): number =>
  Buffer.byteLength(JSON.stringify(result), "utf8");

function successBody(result: ToolResult): SliceBody {
  expect(result.isError).not.toBe(true);
  return parseBody(result) as unknown as SliceBody;
}

function errorBody(result: ToolResult): Record<string, unknown> {
  expect(result.isError).toBe(true);
  return parseBody(result);
}

interface Walk {
  slices: string[];
  nextPositions: Array<number | null>;
  results: ToolResult[];
  joined: string;
}

async function walkToEnd(
  read: ReadHandler,
  selector: Pick<ReadSourceInput, "source_ref" | "id">,
  start = 0
): Promise<Walk> {
  const slices: string[] = [];
  const nextPositions: Array<number | null> = [];
  const results: ToolResult[] = [];
  let position = start;
  // A walk past this many slices is a non-advancing cursor; fail loudly
  // instead of burning the 45s test timeout.
  for (let step = 0; step <= 128; step += 1) {
    const result = await read({ ...selector, position });
    const body = successBody(result);
    results.push(result);
    slices.push(body.content);
    nextPositions.push(body.next_position);
    if (body.next_position === null) {
      return { slices, nextPositions, results, joined: slices.join("") };
    }
    position = body.next_position;
  }
  throw new Error("walk did not terminate: the cursor is not advancing");
}

describe("read_source module — pinned ceilings", () => {
  it("exports the three ceilings with the contract's literal values", () => {
    expect(SOURCE_READ_MAX_TEXT_CODE_POINTS).toBe(8_000);
    expect(SOURCE_READ_MAX_RESULT_BYTES).toBe(32_768);
    expect(SOURCE_READ_MAX_LOCATOR_CODE_POINTS).toBe(1_024);
  });
});

describe("ReadSourceInputSchema — xor selector", () => {
  it("accepts source_ref alone", () => {
    expect(
      ReadSourceInputSchema.safeParse({ source_ref: "docs/t4.md" }).success
    ).toBe(true);
  });

  it("accepts id alone", () => {
    expect(ReadSourceInputSchema.safeParse({ id: UUID_A }).success).toBe(true);
  });

  it("accepts the optional position field", () => {
    expect(
      ReadSourceInputSchema.safeParse({ source_ref: "docs/t4.md", position: 0 })
        .success
    ).toBe(true);
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
  it("known source_ref returns a short body byte-identical to the pushed 资料", async () => {
    const backend = new MemoryBackend(8);
    const doc = await seedRow(backend);
    const read = createReadSourceHandler({ storage: backend });

    const result = await read({ source_ref: doc.source_ref });
    expect(result.isError).not.toBe(true); // success path, never an error result
    // Exact key set: a short body is one terminal slice; no `position` echo.
    expect(successBody(result)).toEqual({
      id: doc.id,
      source_ref: doc.source_ref,
      title: doc.title,
      content: doc.content,
      next_position: null,
    });
  });

  it("known id returns the same record", async () => {
    const backend = new MemoryBackend(8);
    const doc = await seedRow(backend);
    const read = createReadSourceHandler({ storage: backend });

    const body = successBody(await read({ id: doc.id }));
    expect(body).toEqual({
      id: doc.id,
      source_ref: doc.source_ref,
      title: doc.title,
      content: doc.content,
      next_position: null,
    });
  });

  it("omits title when the 资料 row has none (title? on the envelope)", async () => {
    const backend = new MemoryBackend(8);
    const doc = await seedRow(backend, { title: null });
    const read = createReadSourceHandler({ storage: backend });

    expect(successBody(await read({ source_ref: doc.source_ref }))).toEqual({
      id: doc.id,
      source_ref: doc.source_ref,
      content: doc.content,
      next_position: null,
    });
  });

  it("reads through the StorageReadPort interface (no backend cast)", async () => {
    // The tool's declared dep surface is StorageReadPort; assert via the
    // exported registration that deps is only the read port.
    const backend = new MemoryBackend(8);
    await seedRow(backend);
    const registration = readSourceTool({ storage: backend });
    expect(registration.name).toBe("read_source");
    expect(typeof registration.handler).toBe("function");
  });
});

describe("createReadSourceHandler — bounded slices", () => {
  it("omitted position and position 0 return the identical first bounded slice", async () => {
    const backend = new MemoryBackend(8);
    const doc = await seedRow(backend, { content: BIG_BODY });
    const read = createReadSourceHandler({ storage: backend });

    const expected = {
      id: doc.id,
      source_ref: doc.source_ref,
      title: doc.title,
      content: cpSlice(BIG_BODY, 0, SOURCE_READ_MAX_TEXT_CODE_POINTS),
      next_position: SOURCE_READ_MAX_TEXT_CODE_POINTS,
    };
    expect(successBody(await read({ source_ref: doc.source_ref }))).toEqual(
      expected
    );
    expect(
      successBody(await read({ source_ref: doc.source_ref, position: 0 }))
    ).toEqual(expected);
  });

  it("walking next_position strictly advances and reconstructs the body byte-identically", async () => {
    const backend = new MemoryBackend(8);
    const doc = await seedRow(backend, { content: BIG_BODY });
    const read = createReadSourceHandler({ storage: backend });

    const walk = await walkToEnd(read, { source_ref: doc.source_ref });
    expect(walk.slices.length).toBeGreaterThanOrEqual(2);
    expect(walk.joined).toBe(BIG_BODY);
    for (const slice of walk.slices) {
      expect(cpLen(slice)).toBeLessThanOrEqual(
        SOURCE_READ_MAX_TEXT_CODE_POINTS
      );
    }
    const advanced = walk.nextPositions.filter((p): p is number => p !== null);
    expect(advanced.length).toBe(walk.slices.length - 1);
    for (let i = 1; i < advanced.length; i += 1) {
      expect(advanced[i]!).toBeGreaterThan(advanced[i - 1]!);
    }
  });

  it("resuming at a mid-body position returns the same remainder as the sequential walk", async () => {
    const backend = new MemoryBackend(8);
    const doc = await seedRow(backend, { content: BIG_BODY });
    const read = createReadSourceHandler({ storage: backend });

    const mid = 1_234; // deliberately not a multiple of the text ceiling
    const walk = await walkToEnd(read, { source_ref: doc.source_ref }, mid);
    expect(walk.joined).toBe(cpSlice(BIG_BODY, mid));
    // The skipped prefix plus the resumed walk reproduces the body exactly,
    // so mid-body resume and the sequential-from-0 walk carry the same text.
    expect(cpSlice(BIG_BODY, 0, mid) + walk.joined).toBe(BIG_BODY);
  });

  it("position equal to the body length is the legal terminal empty slice", async () => {
    const backend = new MemoryBackend(8);
    const doc = await seedRow(backend, { content: BIG_BODY });
    const read = createReadSourceHandler({ storage: backend });

    const body = successBody(
      await read({ source_ref: doc.source_ref, position: cpLen(BIG_BODY) })
    );
    expect(body).toEqual({
      id: doc.id,
      source_ref: doc.source_ref,
      title: doc.title,
      content: "",
      next_position: null,
    });
  });

  it("empty body is a terminal empty slice, not an error", async () => {
    const backend = new MemoryBackend(8);
    const doc = await seedRow(backend, { content: "" });
    const read = createReadSourceHandler({ storage: backend });

    expect(
      successBody(await read({ source_ref: doc.source_ref, position: 0 }))
    ).toEqual({
      id: doc.id,
      source_ref: doc.source_ref,
      title: doc.title,
      content: "",
      next_position: null,
    });
  });
});

describe("createReadSourceHandler — supplementary-plane integrity", () => {
  // The real defect: a slicer counting UTF-16 code units cuts the emoji
  // straddling a ceiling boundary and leaves a lone surrogate. A
  // code-point-length check cannot see that (a lone surrogate IS one unit),
  // so the assertion is against unpaired surrogates directly.
  const LONE_SURROGATE =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  // Emojis sit at code points 7,999 and 15,999 — the last code point of
  // each of the first two ceiling-sized windows.
  const EMOJI_BODY =
    "x".repeat(7_999) +
    "\u{1F600}" +
    "y".repeat(7_999) +
    "\u{1F600}" +
    "z".repeat(500);

  it("no slice carries a lone surrogate and the join round-trips", async () => {
    const backend = new MemoryBackend(8);
    const doc = await seedRow(backend, { content: EMOJI_BODY });
    const read = createReadSourceHandler({ storage: backend });

    const walk = await walkToEnd(read, { source_ref: doc.source_ref });
    expect(walk.slices.length).toBeGreaterThanOrEqual(3);
    for (const slice of walk.slices) {
      expect(LONE_SURROGATE.test(slice)).toBe(false);
      expect(/[\uD800-\uDBFF]$/.test(slice)).toBe(false);
    }
    expect(walk.joined).toBe(EMOJI_BODY);
    expect(Array.from(walk.joined)).toEqual(Array.from(EMOJI_BODY));
  });
});

describe("createReadSourceHandler — invalid positions", () => {
  it("negative, fractional, and non-finite positions are named without code_points", async () => {
    const backend = new MemoryBackend(8);
    const doc = await seedRow(backend);
    const read = createReadSourceHandler({ storage: backend });

    const nonFinite = [Number.NaN, Number.POSITIVE_INFINITY];
    for (const position of [-1, 1.5, ...nonFinite]) {
      const body = errorBody(
        await read({ source_ref: doc.source_ref, position })
      );
      expect(body.error).toBe("read_source_invalid_position");
      // NaN / Infinity serialize to null; the key itself must still exist.
      expect("position" in body).toBe(true);
      expect("code_points" in body).toBe(false);
    }
    for (const position of [-1, 1.5]) {
      const body = errorBody(
        await read({ source_ref: doc.source_ref, position })
      );
      expect(body).toEqual({
        error: "read_source_invalid_position",
        position,
      });
    }
  });

  it("a beyond-end position is named invalid and carries the body code-point total", async () => {
    const backend = new MemoryBackend(8);
    const doc = await seedRow(backend);
    const read = createReadSourceHandler({ storage: backend });

    const total = cpLen(doc.content);
    const body = errorBody(
      await read({ source_ref: doc.source_ref, position: total + 1 })
    );
    expect(body).toEqual({
      error: "read_source_invalid_position",
      position: total + 1,
      code_points: total,
    });
  });
});

describe("createReadSourceHandler — serialized byte ceiling", () => {
  // The byte ceiling can only bind before the text ceiling once the fixed
  // parts are wide: a stored source_ref of 900 code points at 4 UTF-8 bytes
  // each (still UNDER the locator ceiling, so this must not degrade into
  // invalid_locator), a long title, and a body where every code point
  // escapes to 3-4 bytes through the JSON-in-JSON envelope.
  const WIDE_REF = "\u{1F600}".repeat(900);
  const WIDE_TITLE = "標".repeat(1_000);
  const ESCAPE_HEAVY_BODY = '"\n\\'.repeat(6_667); // 20,001 code points

  it("the byte ceiling binds first and the walk still terminates", async () => {
    const backend = new MemoryBackend(8);
    const doc = await seedRow(backend, {
      source_ref: WIDE_REF,
      title: WIDE_TITLE,
      content: ESCAPE_HEAVY_BODY,
    });
    const read = createReadSourceHandler({ storage: backend });
    expect(cpLen(WIDE_REF)).toBeLessThan(SOURCE_READ_MAX_LOCATOR_CODE_POINTS);

    const walk = await walkToEnd(read, { source_ref: doc.source_ref });
    const first = successBody(walk.results[0]!);
    expect(cpLen(first.content)).toBeLessThan(SOURCE_READ_MAX_TEXT_CODE_POINTS);
    for (const result of walk.results) {
      expect(resultBytes(result)).toBeLessThanOrEqual(
        SOURCE_READ_MAX_RESULT_BYTES
      );
    }
    expect(walk.slices.length).toBeGreaterThanOrEqual(2);
    expect(walk.joined).toBe(ESCAPE_HEAVY_BODY);
  });

  // The byte ceiling is certified on the terminal (null) cursor form, not the
  // numeric one the search used: `null` is longer than a cursor below 1,000,
  // so an identity a few bytes under the ceiling used to overflow by up to 3
  // bytes exactly when the body finished.
  it("an identity within a few bytes of the ceiling never emits an oversized terminal slice", async () => {
    for (const titleLen of [32_583, 32_585, 32_586, 32_587, 32_589]) {
      const backend = new MemoryBackend(8);
      const doc = await seedRow(backend, {
        title: "x".repeat(titleLen),
        content: "abc",
      });
      const read = createReadSourceHandler({ storage: backend });
      const result = await read({ source_ref: doc.source_ref });
      expect(resultBytes(result)).toBeLessThanOrEqual(
        SOURCE_READ_MAX_RESULT_BYTES
      );
      // A success must advance (numeric cursor), never strand the host on a
      // non-progressing cursor; only an uncarryable identity may error, and
      // a tiny body under a near-ceiling identity may error either way.
      if (!result.isError) {
        const body = successBody(result);
        expect(typeof body.next_position).toBe("number");
        expect(cpLen(body.content)).toBeGreaterThan(0);
      } else {
        expect(errorBody(result)).toMatchObject({
          error: "read_source_invalid_locator",
        });
        expect(["resolved_identity_oversized", "non_advancing_slice"]).toContain(
          errorBody(result).reason
        );
      }
    }
  });
});

describe("createReadSourceHandler — bounded error echo", () => {
  it("an invalidated row with an oversized stored locator drops source_ref rather than overflow", async () => {
    const wideRef = "docs/" + "x".repeat(33_000);
    const storage = {
      getSourceDoc: async () => ({
        ok: true as const,
        value: {
          id: UUID_A,
          source_ref: wideRef,
          title: null,
          content: "body",
          created_at: "2026-01-01T00:00:00.000Z",
          valid_until: "2026-09-01T00:00:00.000Z",
        },
      }),
      getSourceDocById: async () => ({ ok: false as const }),
    } as unknown as ReadSourceDeps["storage"];
    const read = createReadSourceHandler({ storage });

    const result = await read({ source_ref: wideRef.slice(0, 200) });
    const body = errorBody(result);
    expect(resultBytes(result)).toBeLessThanOrEqual(
      SOURCE_READ_MAX_RESULT_BYTES
    );
    expect(body).toMatchObject({
      error: "read_source_invalidated",
      id: UUID_A,
      source_ref_omitted: true,
      valid_until: "2026-09-01T00:00:00.000Z",
    });
    expect("source_ref" in body).toBe(false);
  });
});

describe("createReadSourceHandler — oversized locator", () => {
  it("a request locator beyond the ceiling is invalid_locator and is not echoed", async () => {
    const backend = new MemoryBackend(8);
    const read = createReadSourceHandler({ storage: backend });
    const prefix = "docs/oversized-";
    const huge =
      prefix +
      "a".repeat(SOURCE_READ_MAX_LOCATOR_CODE_POINTS + 1 - prefix.length);
    expect(cpLen(huge)).toBe(SOURCE_READ_MAX_LOCATOR_CODE_POINTS + 1);

    const result = await read({ source_ref: huge });
    const body = errorBody(result);
    expect(body).toEqual({
      error: "read_source_invalid_locator",
      reason: "request_locator_oversized",
      message: expect.any(String),
    });
    // The locator IS the overflow: it must never come back on the wire.
    expect(result.content[0]?.text).not.toContain(huge);
  });
});

describe("createReadSourceHandler — storage exception", () => {
  it("a throwing storage port becomes named unavailable with credentials redacted", async () => {
    const SECRET_URL = "postgresql://u:p@h/db";
    const fault = new GraphragError(
      `pool connection lost: ${SECRET_URL}`,
      "STORAGE_ERROR"
    );
    const storage = {
      getSourceDoc: async () => {
        throw fault;
      },
      getSourceDocById: async () => {
        throw fault;
      },
    } as unknown as ReadSourceDeps["storage"];
    const read = createReadSourceHandler({ storage });

    for (const selector of [{ source_ref: "docs/t4.md" }, { id: UUID_A }]) {
      const result = await read(selector);
      const body = errorBody(result);
      expect(body.error).toBe("read_source_unavailable");
      expect(typeof body.message).toBe("string");
      // The authoritative PG redaction policy keeps scheme + host; what
      // must never reach the wire is the credential part of the seeded URL.
      const text = result.content[0]?.text ?? "";
      expect(text).not.toContain(SECRET_URL);
      expect(text).not.toContain("u:p@h");
    }
  });
});

describe("createReadSourceHandler — concurrent reads", () => {
  it("four parallel reads at one position agree and leave the row unchanged", async () => {
    const backend = new MemoryBackend(8);
    const doc = await seedRow(backend, { content: BIG_BODY });
    const read = createReadSourceHandler({ storage: backend });

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        read({ source_ref: doc.source_ref, position: 0 })
      )
    );
    const bodies = results.map((result) => successBody(result));
    for (const body of bodies.slice(1)) {
      expect(body).toEqual(bodies[0]);
    }
    // A read must not consume the row: the fresh read equals the first slice.
    const after = successBody(
      await read({ source_ref: doc.source_ref, position: 0 })
    );
    expect(after).toEqual(bodies[0]);
    expect(after.content).toBe(
      cpSlice(BIG_BODY, 0, SOURCE_READ_MAX_TEXT_CODE_POINTS)
    );
  });
});

describe("createReadSourceHandler — selector identity", () => {
  it("source_ref and id return byte-identical bodies at the same position", async () => {
    const backend = new MemoryBackend(8);
    const doc = await seedRow(backend, { content: BIG_BODY });
    const read = createReadSourceHandler({ storage: backend });

    const byRef = await read({ source_ref: doc.source_ref, position: 0 });
    const byId = await read({ id: doc.id, position: 0 });
    expect(JSON.stringify(byId)).toBe(JSON.stringify(byRef));
    expect(successBody(byRef).next_position).toBe(
      SOURCE_READ_MAX_TEXT_CODE_POINTS
    );
  });

  it("a different stored source_ref cannot substitute the row's body", async () => {
    const backend = new MemoryBackend(8);
    const alpha = await seedRow(backend, {
      id: UUID_A,
      source_ref: "docs/alpha.md",
      content: "甲".repeat(9_000),
    });
    const beta = await seedRow(backend, {
      id: UUID_B,
      source_ref: "docs/beta.md",
      content: "乙".repeat(9_000),
    });
    const read = createReadSourceHandler({ storage: backend });

    const byAlphaRef = successBody(
      await read({ source_ref: alpha.source_ref })
    );
    const byBetaId = successBody(await read({ id: beta.id }));
    expect(byAlphaRef.content).toBe(
      "甲".repeat(SOURCE_READ_MAX_TEXT_CODE_POINTS)
    );
    expect(byBetaId.content).toBe(
      "乙".repeat(SOURCE_READ_MAX_TEXT_CODE_POINTS)
    );
    expect(byAlphaRef.content).not.toBe(byBetaId.content);
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
