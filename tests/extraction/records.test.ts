import { describe, it, expect } from "vitest";
import {
  insertRecord,
  markSucceeded,
  markFailed,
  listFailed,
  type Queryable,
} from "../../src/core/extraction/records.js";

interface StoredRecord {
  id: string;
  batch_id: string;
  chunk_id: string | null;
  status: string;
  error_code: string | null;
  error_msg: string | null;
  triples_count: number;
  unmapped_count: number;
  started_at: string;
  finished_at: string | null;
  created_at: string;
}

function makeFakeClient(): {
  client: Queryable;
  rows: StoredRecord[];
  calls: Array<{ text: string; values: unknown[] }>;
} {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const rows: StoredRecord[] = [];
  let createdSeq = 0;
  return {
    rows,
    calls,
    client: {
      async query(text: string, values: unknown[]): Promise<{ rows: any[] }> {
        calls.push({ text, values });
        if (text.includes("INSERT INTO extraction_records")) {
          const [id, batch_id, chunk_id, started_at] = values as [
            string,
            string,
            string | null,
            string,
          ];
          rows.push({
            id,
            batch_id,
            chunk_id,
            status: "pending",
            error_code: null,
            error_msg: null,
            triples_count: 0,
            unmapped_count: 0,
            started_at,
            finished_at: null,
            created_at: `2026-01-0${++createdSeq}T00:00:00Z`,
          });
          return { rows: [] };
        }
        if (
          text.includes("UPDATE extraction_records") &&
          text.includes("status = 'succeeded'")
        ) {
          const [id, triples_count, unmapped_count] = values as [
            string,
            number,
            number,
          ];
          const row = rows.find((r) => r.id === id);
          if (row) {
            row.status = "succeeded";
            row.finished_at = "2026-01-01T01:00:00Z";
            row.triples_count = triples_count;
            row.unmapped_count = unmapped_count;
          }
          return { rows: [] };
        }
        if (
          text.includes("UPDATE extraction_records") &&
          text.includes("status = 'failed'")
        ) {
          const [id, error_code, error_msg] = values as [
            string,
            string,
            string,
          ];
          const row = rows.find((r) => r.id === id);
          if (row) {
            row.status = "failed";
            row.finished_at = "2026-01-01T01:00:00Z";
            row.error_code = error_code;
            row.error_msg = error_msg;
          }
          return { rows: [] };
        }
        if (text.includes("SELECT * FROM extraction_records")) {
          const params = (values as unknown[]).slice();
          const batchId = params[0] as string | undefined;
          const filtered = rows
            .filter((r) => r.status === "failed")
            // SC5: SELF_LOOP_REJECTED is a permanent reject — listFailed()
            // hides it so operators only see transient failures that need a
            // re-extract.
            .filter((r) => r.error_code !== "SELF_LOOP_REJECTED")
            .filter((r) => (batchId ? r.batch_id === batchId : true))
            .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
          return { rows: filtered };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    },
  };
}

describe("extraction_records", () => {
  it("insertRecord writes status='pending'", async () => {
    const f = makeFakeClient();
    await insertRecord(f.client, {
      id: "r1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]?.status).toBe("pending");
    expect(f.rows[0]?.finished_at).toBeNull();
  });

  it("markSucceeded sets status='succeeded', finished_at, and counts", async () => {
    const f = makeFakeClient();
    await insertRecord(f.client, {
      id: "r1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markSucceeded(f.client, "r1", { triplesCount: 3, unmappedCount: 1 });
    const row = f.rows[0];
    expect(row?.status).toBe("succeeded");
    expect(row?.finished_at).not.toBeNull();
    expect(row?.triples_count).toBe(3);
    expect(row?.unmapped_count).toBe(1);
  });

  it("markFailed sets status='failed' and records error code/msg", async () => {
    const f = makeFakeClient();
    await insertRecord(f.client, {
      id: "r1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailed(f.client, "r1", { code: "5xx", msg: "upstream 500" });
    const row = f.rows[0];
    expect(row?.status).toBe("failed");
    expect(row?.finished_at).not.toBeNull();
    expect(row?.error_code).toBe("5xx");
    expect(row?.error_msg).toBe("upstream 500");
  });

  it("listFailed returns only failed rows, ordered by created_at", async () => {
    const f = makeFakeClient();
    // Mix: one succeeded, two failed.
    await insertRecord(f.client, {
      id: "r1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markSucceeded(f.client, "r1", { triplesCount: 2, unmappedCount: 0 });
    await insertRecord(f.client, {
      id: "r2",
      batchId: "b1",
      chunkId: "chunk-2",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailed(f.client, "r2", { code: "5xx", msg: "boom" });
    await insertRecord(f.client, {
      id: "r3",
      batchId: "b1",
      chunkId: "chunk-3",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailed(f.client, "r3", { code: "4xx", msg: "bad" });
    const failed = await listFailed(f.client);
    expect(failed.map((r) => r.id)).toEqual(["r2", "r3"]);
  });

  it("listFailed filters by batchId when given", async () => {
    const f = makeFakeClient();
    await insertRecord(f.client, {
      id: "r1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailed(f.client, "r1", { code: "5xx", msg: "boom" });
    await insertRecord(f.client, {
      id: "r2",
      batchId: "b2",
      chunkId: "chunk-2",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailed(f.client, "r2", { code: "5xx", msg: "boom" });
    const b1 = await listFailed(f.client, { batchId: "b1" });
    const b2 = await listFailed(f.client, { batchId: "b2" });
    expect(b1.map((r) => r.id)).toEqual(["r1"]);
    expect(b2.map((r) => r.id)).toEqual(["r2"]);
  });

  it("listFailed hides SELF_LOOP_REJECTED rows (SC5)", async () => {
    const f = makeFakeClient();
    await insertRecord(f.client, {
      id: "r1",
      batchId: "b1",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailed(f.client, "r1", { code: "5xx", msg: "boom" });
    await insertRecord(f.client, {
      id: "r2",
      batchId: "b1",
      chunkId: "chunk-2",
      startedAt: "2026-01-01T00:00:00Z",
    });
    // SC5: SELF_LOOP_REJECTED is a permanent reject — there is no
    // re-extract path for it, so listing it as "must re-extract" would be
    // misleading. listFailed() hides it by error_code.
    await markFailed(f.client, "r2", {
      code: "SELF_LOOP_REJECTED",
      msg: "all outputs were self-loops",
    });
    const failed = await listFailed(f.client);
    expect(failed.map((r) => r.id)).toEqual(["r1"]);
    // The WHERE clause carries the exclusion so the DB applies the filter,
    // not the caller.
    const listCall = f.calls.find((c) =>
      c.text.includes("SELECT * FROM extraction_records")
    );
    expect(listCall?.text).toContain("SELF_LOOP_REJECTED");
  });

  it("batch_id aggregation: two records in the same batch are both retrievable", async () => {
    const f = makeFakeClient();
    await insertRecord(f.client, {
      id: "r1",
      batchId: "shared-batch",
      chunkId: "chunk-1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markSucceeded(f.client, "r1", { triplesCount: 5, unmappedCount: 0 });
    await insertRecord(f.client, {
      id: "r2",
      batchId: "shared-batch",
      chunkId: "chunk-2",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await markFailed(f.client, "r2", { code: "5xx", msg: "boom" });
    const all = await listFailed(f.client, { batchId: "shared-batch" });
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe("r2");
    // Both rows exist in the table under the same batch_id.
    expect(f.rows.filter((r) => r.batch_id === "shared-batch")).toHaveLength(2);
  });
});
