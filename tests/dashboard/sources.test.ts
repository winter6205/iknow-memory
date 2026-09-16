/**
 * dashboard-api 资料 list + detail (operator-console T6).
 *
 * GET /api/sources — summary page (no content body: list is on-demand).
 * GET /api/sources/:id — full body detail. Unknown id is typed NOT_FOUND;
 * storage failure is 503 STORAGE_ERROR, never an empty list.
 * Opening detail must not invoke the embedder (read port only).
 */
import { describe, expect, it, vi } from "vitest";

import { MemoryBackend } from "../../src/core/storage/memory-backend.js";
import { GraphragError } from "../../src/core/errors.js";
import {
  SOURCE_DOC_COLLECTION_NAME,
  SOURCE_DOC_STATUS,
  type ChunkRecord,
  type SourceDocRecord,
} from "../../src/core/types.js";

import { boot, fetchJson, memoryDeps, stubReadPort } from "./helpers.js";
import type { DashboardServerDeps } from "../../src/dashboard-api/index.js";

const UUID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CHUNK_DIM = 8;

const DOC_A: SourceDocRecord = {
  id: UUID_A,
  source_ref: "docs/first.md",
  title: "第一条",
  content: "full body one",
  created_at: "2026-01-01T00:00:00.000Z",
};

const DOC_B: SourceDocRecord = {
  id: UUID_B,
  source_ref: "docs/second.md",
  title: null,
  content: "full body two",
  created_at: "2026-01-02T00:00:00.000Z",
};

/** The four 资料页 fields (corpus-ready retrieve T3) as the wire publishes them. */
function pageFields(
  status: string,
  chunkCount: number,
  failureCode: string | null = null
): Record<string, unknown> {
  return {
    collection: SOURCE_DOC_COLLECTION_NAME,
    status,
    failure_code: failureCode,
    chunk_count: chunkCount,
  };
}

function chunkOf(
  patch: Partial<ChunkRecord> & { id: string; source_doc_id: string }
): ChunkRecord {
  return {
    id: patch.id,
    content: patch.content ?? `content of ${patch.id}`,
    embedding: new Array<number>(CHUNK_DIM).fill(0.5),
    source_ref: patch.source_ref ?? "docs/first.md",
    metadata: patch.metadata ?? {},
    valid_from: patch.valid_from ?? "2026-01-01T00:00:00.000Z",
    valid_until: patch.valid_until ?? null,
    created_at: patch.created_at ?? "2026-01-01T00:00:00.000Z",
    source_doc_id: patch.source_doc_id,
    ordinal: patch.ordinal ?? 0,
  };
}

async function seedTwoDocs(deps: DashboardServerDeps): Promise<void> {
  const storage = deps.storage as MemoryBackend;
  for (const doc of [DOC_A, DOC_B]) {
    await storage.upsertSourceDoc({ ...doc });
  }
}

describe("dashboard-api GET /api/sources", () => {
  it("returns an empty page for an empty ledger", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/sources`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
  });

  it("lists summaries in creation order WITHOUT content bodies", async () => {
    const deps = memoryDeps();
    await seedTwoDocs(deps);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(`${baseUrl}/api/sources`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [
        {
          id: UUID_A,
          source_ref: "docs/first.md",
          title: "第一条",
          created_at: "2026-01-01T00:00:00.000Z",
          valid_until: null,
          ...pageFields(SOURCE_DOC_STATUS.IN_PROGRESS, 0),
        },
        {
          id: UUID_B,
          source_ref: "docs/second.md",
          title: null,
          created_at: "2026-01-02T00:00:00.000Z",
          valid_until: null,
          ...pageFields(SOURCE_DOC_STATUS.IN_PROGRESS, 0),
        },
      ],
      total: 2,
      limit: 20,
      offset: 0,
    });
  });

  it("publishes the four 资料页 fields: 集合 / 身份 / 状态 / 成功块数", async () => {
    const deps = memoryDeps();
    await seedTwoDocs(deps);
    const storage = deps.storage as MemoryBackend;
    await storage.upsert([
      chunkOf({ id: "c1", source_doc_id: UUID_A, ordinal: 0 }),
      chunkOf({ id: "c2", source_doc_id: UUID_A, ordinal: 1 }),
    ]);
    await storage.markSourceDocReady(UUID_A);
    await storage.recordSourceDocFailure("docs/second.md", "CONTENT_TOO_LARGE");

    const { baseUrl } = await boot(deps);
    const res = await fetchJson(`${baseUrl}/api/sources`);
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<Record<string, unknown>> };
    const [first, second] = body.items;
    // 集合 name + 资料 identity.
    expect(first).toMatchObject({
      collection: SOURCE_DOC_COLLECTION_NAME,
      source_ref: "docs/first.md",
    });
    // 状态 + 成功块数: 就绪 with the derived count.
    expect(first).toMatchObject({
      status: SOURCE_DOC_STATUS.READY,
      chunk_count: 2,
      failure_code: null,
    });
    // 失败 is visible with its stable code, count stays derived (0).
    expect(second).toMatchObject({
      status: SOURCE_DOC_STATUS.FAILED,
      failure_code: "CONTENT_TOO_LARGE",
      chunk_count: 0,
    });
  });

  it("shows a zero-chunk 资料 as 进行中, never 就绪", async () => {
    // Boundary: a 资料 row exists but no chunk row ever landed. CONTEXT
    // 资料集合 defines 就绪 as status ready AND count ≥ 1 — the page must
    // not claim ready on a count of zero.
    const deps = memoryDeps();
    await seedTwoDocs(deps);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(`${baseUrl}/api/sources`);
    const body = res.body as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({
      status: SOURCE_DOC_STATUS.IN_PROGRESS,
      chunk_count: 0,
    });
    expect(
      body.items.some((item) => item["status"] === SOURCE_DOC_STATUS.READY)
    ).toBe(false);
  });

  it("honours limit/offset query params", async () => {
    const deps = memoryDeps();
    await seedTwoDocs(deps);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(`${baseUrl}/api/sources?limit=1&offset=1`);
    expect(res.status).toBe(200);
    const body = res.body as {
      items: unknown[];
      total: number;
      offset: number;
    };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(2);
    expect(body.offset).toBe(1);
  });

  it("returns an empty items page (200) when offset is past the end", async () => {
    // Pagination beyond the ledger is a legal page, not an error — the
    // same semantic the /api/chunks surface pins (chunks.test.ts).
    const deps = memoryDeps();
    await seedTwoDocs(deps);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(`${baseUrl}/api/sources?offset=99`);
    expect(res.status).toBe(200);
    const body = res.body as {
      items: unknown[];
      total: number;
      offset: number;
    };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(2);
    expect(body.offset).toBe(99);
  });

  it("rejects a negative offset with 400 INVALID_INPUT", async () => {
    // parseOffset allows 0 but not negatives; the wire answer is the
    // standard typed envelope, never a 500.
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/sources?offset=-1`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  it("rejects illegal limit with 400 INVALID_INPUT", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(`${baseUrl}/api/sources?limit=0`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  it("maps a StorageReadPort failure to 503 STORAGE_ERROR, not an empty list", async () => {
    const failingStorage = stubReadPort({
      async listSourceDocs(): Promise<never> {
        throw new GraphragError("postgres unavailable", "STORAGE_ERROR");
      },
    });
    const { baseUrl } = await boot({
      ...memoryDeps(),
      storage: failingStorage as unknown as DashboardServerDeps["storage"],
    });
    const res = await fetchJson(`${baseUrl}/api/sources`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: { code: "STORAGE_ERROR", message: "postgres unavailable" },
    });
  });
});

describe("dashboard-api GET /api/sources/:id", () => {
  it("returns the full 资料 body including content for a known id", async () => {
    const deps = memoryDeps();
    await seedTwoDocs(deps);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(`${baseUrl}/api/sources/${UUID_A}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: UUID_A,
      source_ref: "docs/first.md",
      title: "第一条",
      content: "full body one",
      created_at: "2026-01-01T00:00:00.000Z",
      valid_until: null,
      ...pageFields(SOURCE_DOC_STATUS.IN_PROGRESS, 0),
    });
  });

  it("publishes the four fields on the detail path too", async () => {
    const deps = memoryDeps();
    await seedTwoDocs(deps);
    const storage = deps.storage as MemoryBackend;
    await storage.upsert([chunkOf({ id: "c1", source_doc_id: UUID_A })]);
    await storage.markSourceDocReady(UUID_A);

    const { baseUrl } = await boot(deps);
    const res = await fetchJson(`${baseUrl}/api/sources/${UUID_A}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      collection: SOURCE_DOC_COLLECTION_NAME,
      status: SOURCE_DOC_STATUS.READY,
      chunk_count: 1,
      failure_code: null,
    });
  });

  it("returns 404 NOT_FOUND for an unknown id", async () => {
    const { baseUrl } = await boot();
    const res = await fetchJson(
      `${baseUrl}/api/sources/cccccccc-cccc-cccc-cccc-cccccccccccc`
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("returns 400 INVALID_INPUT for a blank id path", async () => {
    const deps = memoryDeps();
    await seedTwoDocs(deps);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(`${baseUrl}/api/sources/%20%20`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  it("does not invoke the embedder on the open-detail path", async () => {
    const deps = memoryDeps();
    const embedSpy = vi.spyOn(deps.embedder, "embed");
    await seedTwoDocs(deps);
    const { baseUrl } = await boot(deps);

    const list = await fetchJson(`${baseUrl}/api/sources`);
    const detail = await fetchJson(`${baseUrl}/api/sources/${UUID_A}`);
    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("does not invoke the embedder on the list path either", async () => {
    const deps = memoryDeps();
    const embedSpy = vi.spyOn(deps.embedder, "embed");
    await seedTwoDocs(deps);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(`${baseUrl}/api/sources?limit=1`);
    expect(res.status).toBe(200);
    expect(embedSpy).not.toHaveBeenCalled();
  });
});
