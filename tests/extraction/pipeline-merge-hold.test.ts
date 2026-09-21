/**
 * A `human` gray-zone judge verdict settles the pair as an independent
 * failed `extraction_records` row on the maintenance lane (visible through
 * `listFailed()`, error code MERGE_GRAY_HOLD) while the chunk's own record
 * still succeeds and no `merged_into` is written.
 */
import { describe, it, expect } from "vitest";

import type { Queryable } from "../../src/core/extraction/records.js";
import {
  MERGE_GRAY_HOLD_CODE,
  listFailed,
} from "../../src/core/extraction/records.js";
import {
  processBatch,
  type ExtractPipelineDeps,
} from "../../src/core/extraction/pipeline.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import type { EmbeddingClient } from "../../src/core/embedder.js";
import type { GrayZoneJudge } from "../../src/core/entities/types.js";
import type { Logger } from "../../src/logging.js";

const SILENT_LOGGER: Logger = {
  level: "error",
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Distinct texts → orthogonal basis vectors; equal texts → cosine 1. */
class OrthogonalEmbedder implements EmbeddingClient {
  private readonly slots = new Map<string, number>();
  constructor(private readonly dimensions: number) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      if (!this.slots.has(text)) this.slots.set(text, this.slots.size);
      const vector = new Array<number>(this.dimensions).fill(0);
      vector[this.slots.get(text)! % this.dimensions] = 1;
      return vector;
    });
  }
}

interface HoldRow {
  id: string;
  batch_id: string;
  chunk_id: string | null;
  status: string;
  error_code: string | null;
  error_msg: string | null;
}

/**
 * Fake ledger that answers the entity/candidate reads with one live
 * "Alice Smith" row and tracks extraction_records rows so the hold lane is
 * asserted through the real `listFailed()` SQL contract.
 */
class FakeBatchClient implements Queryable {
  queries: string[] = [];
  valuesList: unknown[][] = [];
  records: HoldRow[] = [];

  async query(text: string, values: unknown[] = []): Promise<{ rows: any[] }> {
    this.queries.push(text);
    this.valuesList.push(values);
    if (text.includes("INSERT INTO extraction_records")) {
      const [id, batch_id, chunk_id] = values as [string, string, string];
      this.records.push({
        id,
        batch_id,
        chunk_id,
        status: "pending",
        error_code: null,
        error_msg: null,
      });
      return { rows: [] };
    }
    if (
      text.includes("UPDATE extraction_records") &&
      text.includes("status = 'failed'")
    ) {
      const [id, error_code, error_msg] = values as [string, string, string];
      const row = this.records.find((r) => r.id === id);
      if (row) {
        row.status = "failed";
        row.error_code = error_code;
        row.error_msg = error_msg;
      }
      return { rows: [] };
    }
    if (
      text.includes("UPDATE extraction_records") &&
      text.includes("status = 'succeeded'")
    ) {
      const [id] = values as [string];
      const row = this.records.find((r) => r.id === id);
      if (row) row.status = "succeeded";
      return { rows: [] };
    }
    if (text.includes("SELECT * FROM extraction_records")) {
      return {
        rows: this.records.filter(
          (r) => r.status === "failed" && r.error_code !== "SELF_LOOP_REJECTED"
        ),
      };
    }
    if (text.includes("FROM embedding_generation")) return { rows: [] };
    if (text.includes("FROM entities WHERE retired = false")) {
      return {
        rows: [
          {
            id: "alice-1",
            canonical_name: "Alice Smith",
            type: "person",
            embedding: null,
            description: "Alice Smith works at Acme Corp",
          },
        ],
      };
    }
    if (text.includes("SELECT merged_into FROM entities WHERE id = $1")) {
      return { rows: [{ merged_into: null }] };
    }
    if (text.includes("FROM source_documents")) return { rows: [] };
    if (text.includes("UPDATE source_documents")) return { rows: [] };
    if (text.includes("INSERT INTO entities")) return { rows: [] };
    if (text.includes("INSERT INTO entity_aliases")) return { rows: [] };
    if (
      text.includes("FROM triples") ||
      text.includes("INSERT INTO triples") ||
      text.includes("UPDATE triples")
    ) {
      return { rows: [] };
    }
    if (text.includes("INSERT INTO projection_outbox")) return { rows: [] };
    if (text.includes("UPDATE community_index_state")) return { rows: [] };
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim())) return { rows: [] };
    throw new Error(`unexpected query: ${text}`);
  }

  indexOf(fragment: string): number {
    return this.queries.findIndex((q) => q.includes(fragment));
  }
}

const GRAY_OUTPUT = {
  head: "Alicia Smith",
  headType: "person",
  relationRaw: "works at",
  relationNorm: "RELATED_TO",
  tail: "Acme Corp",
  tailType: "organization",
  description: "Alice Smith works at Acme Corp",
  evidenceSpan: "Alice Smith works at Acme Corp",
  confidence: 0.9,
};

describe("processBatch — human merge hold lands on the maintenance lane", () => {
  it("writes an independent MERGE_GRAY_HOLD failed record while the chunk still succeeds", async () => {
    const client = new FakeBatchClient();
    const judgeCalls: unknown[] = [];
    const mergeJudge: GrayZoneJudge = async (input) => {
      judgeCalls.push(input);
      return "human";
    };
    const deps: ExtractPipelineDeps = {
      llm: new FakeLLMClient({ queue: [{ kind: "ok", outputs: [GRAY_OUTPUT] }] }),
      embedder: new OrthogonalEmbedder(8),
      logger: SILENT_LOGGER,
      now: () => "2026-01-01T00:00:00.000Z",
      mergeJudge,
    };

    const summary = await processBatch(
      deps,
      client,
      [{ id: "chunk-1", content: "Alice Smith works at Acme Corp, reported Alicia Smith." }],
      { batchSize: 1 }
    );

    // The gray pair reached the judge at least once (head side).
    expect(judgeCalls.length).toBeGreaterThanOrEqual(1);
    // Human hold never merges: no merged_into write at all.
    expect(client.indexOf("UPDATE entities SET merged_into")).toBe(-1);
    // The chunk itself is a success; the hold is a SEPARATE failed row —
    // exactly one per held pair.
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
    const holdRows = client.records.filter(
      (r) => r.error_code === MERGE_GRAY_HOLD_CODE
    );
    expect(holdRows).toHaveLength(1);
    const failedHold = holdRows[0];
    expect(failedHold!.chunk_id).toBe("chunk-1");
    expect(failedHold!.status).toBe("failed");
    expect(failedHold!.error_msg).toContain("Alicia Smith");
    expect(failedHold!.error_msg).toContain("alice-1");
    const chunkRecord = client.records.find((r) => r.id !== failedHold!.id);
    expect(chunkRecord!.status).toBe("succeeded");

    // listFailed surfaces the hold on the same lane as extract failures.
    const lane = await listFailed(client);
    expect(lane.some((r) => r.error_code === MERGE_GRAY_HOLD_CODE)).toBe(true);
  });
});
