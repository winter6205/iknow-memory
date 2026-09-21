/**
 * dashboard-api maintenance lane (extract-verify T3).
 *
 * Acceptance pinned here:
 *   1. GET /api/maintenance/failed shows the SAME rows as core
 *      `listFailed()`: the pin is a module spy on records.ts (same posture
 *      as the writes.test.ts "same runner" pins) and the chunk-id set of
 *      the HTTP body must equal the spy's rows.
 *   2. POST promote / discard delegate to core `promoteRecord` /
 *      `discardRecord` — module spies, no dashboard-side SQL.
 *   3. Typed refusals (PromotionRefusedError / DiscardRefusedError, both
 *      INVALID_INPUT) surface as the writes.ts envelope convention: 400
 *      INVALID_INPUT, never a silent 200.
 *   4. Re-extract rides the existing extract thin write: POST
 *      /api/writes/extract with chunk_ids reaches createExtractHandler's
 *      runner verbatim (judge-before-persist is inherent to that runner).
 *   5. Missing maintenance deps answer typed 503 — the route table stays
 *      predictable across env states.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as actionsModule from "../../src/core/extraction/actions.js";
import * as recordsModule from "../../src/core/extraction/records.js";
import * as extractTool from "../../src/tools/extract.js";
import {
  DiscardRefusedError,
  PromotionRefusedError,
} from "../../src/core/extraction/actions.js";
import type { ExtractClient } from "../../src/tools/extract.js";

import { boot, fetchJson, memoryDeps } from "./helpers.js";
import type { DashboardServerDeps } from "../../src/dashboard-api/index.js";

const CHUNK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHUNK_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REC_A = "11111111-1111-4111-8111-111111111111";
const REC_B = "22222222-2222-4222-8222-222222222222";
const BATCH_A = "33333333-3333-4333-8333-333333333333";

function failedRow(over: Record<string, unknown>) {
  return {
    id: REC_A,
    batch_id: BATCH_A,
    chunk_id: CHUNK_A,
    status: "failed",
    error_code: "JUDGE_REJECTED",
    error_msg: "triple not grounded in chunk",
    proposed_payload: { triples: [], verdicts: [] },
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:00:05.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    discarded_at: null,
    triples_count: null,
    unmapped_count: null,
    ...over,
  };
}

/** Fake leased client — records/actions run behind spies in these tests. */
let releasedClients = 0;

function fakeClient(
  onChunksRead?: (values: unknown[]) => { rows: unknown[] }
): ExtractClient {
  return {
    async query(text: string, values: unknown[]) {
      if (onChunksRead && text.includes("FROM chunks WHERE id IN")) {
        return onChunksRead(values);
      }
      return { rows: [] };
    },
    release() {
      releasedClients += 1;
    },
  };
}

afterEach(() => {
  releasedClients = 0;
});

function maintenanceDeps(
  deps: DashboardServerDeps = memoryDeps(),
  onChunksRead?: (values: unknown[]) => { rows: unknown[] }
): DashboardServerDeps {
  return {
    ...deps,
    writes: {
      maintenance: {
        pool: { connect: async () => fakeClient(onChunksRead) },
        embedder: deps.embedder,
      },
      extract: {
        llmEnv: {
          authToken: "test-llm-token",
          baseUrl: undefined,
          model: undefined,
        },
        embedderEnv: {
          apiKey: "test-embed-key",
          baseUrl: "http://embed.test",
          model: "embed-test",
          dimensions: 8,
        },
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/maintenance/failed — same list as listFailed()", () => {
  it("invokes records.ts listFailed and returns its chunk ids", async () => {
    const rows = [
      failedRow({}),
      failedRow({
        id: REC_B,
        chunk_id: null,
        error_code: "JUDGE_DOWN",
        error_msg: "judge unreachable",
        proposed_payload: null,
      }),
    ];
    const listSpy = vi
      .spyOn(recordsModule, "listFailed")
      .mockResolvedValue(rows);

    const { baseUrl } = await boot(maintenanceDeps());
    const res = await fetchJson(`${baseUrl}/api/maintenance/failed`);

    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    const items = (res.body as { items: Array<Record<string, unknown>> })
      .items;
    expect(items.map((r) => r.chunk_id)).toEqual(rows.map((r) => r.chunk_id));
    expect(items[0]).toMatchObject({
      id: REC_A,
      batch_id: BATCH_A,
      error_code: "JUDGE_REJECTED",
      error_msg: "triple not grounded in chunk",
      has_proposal: true,
      created_at: "2026-01-01T00:00:00.000Z",
    });
    // No proposal payload on the row → the review affordance is off, and
    // the payload itself never travels over the wire.
    expect(items[1]).toMatchObject({ id: REC_B, has_proposal: false });
    expect(items[1].proposed_payload).toBeUndefined();
  });

  it("links each row to its 资料 via ONE batched chunk read", async () => {
    let chunkReads = 0;
    const deps = maintenanceDeps(memoryDeps(), (values) => {
      chunkReads += 1;
      // The handler must ask for both chunk ids in a single IN-list.
      expect(new Set(values)).toEqual(new Set([CHUNK_A, CHUNK_C]));
      return {
        rows: [
          {
            id: CHUNK_A,
            source_ref: "test://a",
            source_doc_id: "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa",
          },
        ],
      };
    });
    vi.spyOn(recordsModule, "listFailed").mockResolvedValue([
      failedRow({}),
      failedRow({ id: REC_B, chunk_id: CHUNK_C }),
    ]);

    const { baseUrl } = await boot(deps);
    const res = await fetchJson(`${baseUrl}/api/maintenance/failed`);
    const items = (res.body as { items: Array<Record<string, unknown>> })
      .items;
    expect(chunkReads).toBe(1);
    expect(items[0].source_ref).toBe("test://a");
    expect(items[0].source_doc_id).toBe(
      "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa"
    );
    // A chunk the ledger no longer has (true not-found) links nowhere, but
    // the row still lists — same rows as listFailed().
    expect(items[1].source_ref).toBeNull();
    expect(items[1].source_doc_id).toBeNull();
  });

  it("a link-read outage lists rows unlinked with a 200, never a crash", async () => {
    const deps = maintenanceDeps(memoryDeps(), () => {
      throw new Error("connection reset");
    });
    vi.spyOn(recordsModule, "listFailed").mockResolvedValue([failedRow({})]);
    const { baseUrl } = await boot(deps);
    const res = await fetchJson(`${baseUrl}/api/maintenance/failed`);
    expect(res.status).toBe(200);
    const items = (res.body as { items: Array<Record<string, unknown>> })
      .items;
    expect(items[0]).toMatchObject({ id: REC_A, source_ref: null });
  });

  it("answers 503 STORAGE_ERROR when maintenance deps are not configured", async () => {
    const { baseUrl } = await boot(memoryDeps());
    const res = await fetchJson(`${baseUrl}/api/maintenance/failed`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "STORAGE_ERROR" } });
  });
});

describe("POST /api/maintenance/promote — same core runner as CLI", () => {
  it("delegates to actions.ts promoteRecord with the record id", async () => {
    const promoteSpy = vi
      .spyOn(actionsModule, "promoteRecord")
      .mockResolvedValue(undefined);

    const { baseUrl } = await boot(maintenanceDeps());
    const res = await fetchJson(`${baseUrl}/api/maintenance/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ record_id: REC_A }),
    });

    expect(promoteSpy).toHaveBeenCalledTimes(1);
    const [persistDeps, usedClient, recordId] = promoteSpy.mock
      .calls[0] as unknown as [object, ExtractClient, string];
    expect(usedClient).toBeTruthy();
    expect(recordId).toBe(REC_A);
    expect(persistDeps).toMatchObject({ embedder: expect.anything() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ promoted: true, record_id: REC_A });
    expect(releasedClients).toBe(1);
  });

  it("maps a PromotionRefusedError to 400 INVALID_INPUT", async () => {
    vi.spyOn(actionsModule, "promoteRecord").mockRejectedValue(
      new PromotionRefusedError(`record ${REC_A} was discarded`)
    );
    const { baseUrl } = await boot(maintenanceDeps());
    const res = await fetchJson(`${baseUrl}/api/maintenance/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ record_id: REC_A }),
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: { code: "INVALID_INPUT", message: expect.stringContaining("discarded") },
    });
  });

  it("rejects a missing or malformed record_id at the schema gate", async () => {
    const promoteSpy = vi.spyOn(actionsModule, "promoteRecord");
    const { baseUrl } = await boot(maintenanceDeps());
    for (const body of ["{}", '{"record_id":"not-a-uuid"}']) {
      const res = await fetchJson(`${baseUrl}/api/maintenance/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: "INVALID_INPUT" } });
    }
    expect(promoteSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/maintenance/discard — same core runner as CLI", () => {
  it("delegates to actions.ts discardRecord with the record id", async () => {
    const discardSpy = vi
      .spyOn(actionsModule, "discardRecord")
      .mockResolvedValue(undefined);

    const { baseUrl } = await boot(maintenanceDeps());
    const res = await fetchJson(`${baseUrl}/api/maintenance/discard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ record_id: REC_A }),
    });

    expect(discardSpy).toHaveBeenCalledTimes(1);
    expect(discardSpy.mock.calls[0]?.[1]).toBe(REC_A);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ discarded: true, record_id: REC_A });
  });

  it("maps a DiscardRefusedError to 400 INVALID_INPUT", async () => {
    vi.spyOn(actionsModule, "discardRecord").mockRejectedValue(
      new DiscardRefusedError("only failed records can be discarded")
    );
    const { baseUrl } = await boot(maintenanceDeps());
    const res = await fetchJson(`${baseUrl}/api/maintenance/discard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ record_id: REC_A }),
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
  });
});

describe("re-extract — the failed chunk rides the extract thin write", () => {
  it("POST /api/writes/extract with chunk_ids reaches the extract runner", async () => {
    const runnerResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            batch_id: BATCH_A,
            processed: 1,
            succeeded: 0,
            failed: 1,
            write_failures: 0,
            ungrounded: 0,
            failed_chunks: [
              { chunk_id: CHUNK_A, error_code: "JUDGE_REJECTED", error_msg: "still ungrounded" },
            ],
          }),
        },
      ],
    };
    const runner = vi.fn(async () => runnerResult);
    const factorySpy = vi
      .spyOn(extractTool, "createExtractHandler")
      .mockImplementation(
        () =>
          runner as unknown as ReturnType<
            typeof extractTool.createExtractHandler
          >
      );

    const { baseUrl } = await boot(maintenanceDeps());
    const res = await fetchJson(`${baseUrl}/api/writes/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chunk_ids: [CHUNK_A] }),
    });

    expect(factorySpy).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0]).toEqual({ chunk_ids: [CHUNK_A] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ batch_id: BATCH_A, failed: 1 });
  });
});
