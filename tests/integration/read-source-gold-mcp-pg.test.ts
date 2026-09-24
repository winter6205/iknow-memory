/**
 * Gold acceptance for the bounded `read_source` wire.
 *
 * One committed long 资料 is stored in real PostgreSQL 16 / pgvector and read
 * back through the real MCP stdio process until its cursor terminates, so the
 * ceilings are measured on the bytes a host actually receives rather than on an
 * in-process call. Loud-skip (and a hard failure under CI) when Postgres is
 * unreachable, per the shared harness.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Client as McpClient } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, it, expect } from "vitest";

import { PgvectorBackend } from "../../src/core/storage/pgvector-backend.js";
import {
  SOURCE_READ_MAX_LOCATOR_CODE_POINTS,
  SOURCE_READ_MAX_RESULT_BYTES,
  SOURCE_READ_MAX_TEXT_CODE_POINTS,
} from "../../src/tools/read_source.js";
import { createPgIntegrationHarness } from "./pg-test-harness.js";

const DIM = 32;
const SERVER_PATH = fileURLToPath(
  new URL("../../dist/index.js", import.meta.url)
);
const GOLD_PATH = fileURLToPath(
  new URL("../../eval/source-body/g4-long-source-v1.json", import.meta.url)
);

interface GoldFixture {
  version: string;
  source_ref: string;
  title: string;
  content: string;
  code_points: number;
  sha256: string;
}

const gold = JSON.parse(readFileSync(GOLD_PATH, "utf8")) as GoldFixture;

/** fin's canonical company locator: sorted keys, compact separators, and a
 *  string `version` (fin's `deserialize_source_ref` rejects a non-string one).
 *  Opaque to this repo — we only store and echo it. */
const locator = (
  documentId: string,
  unit: number,
  version: string | number
): string =>
  `{"document_id":"${documentId}","unit":${unit},"version":"${version}"}`;

const GOLD_REF = gold.source_ref;
const UNIT2_REF = locator("g4-bounded-read-handbook", 2, 3);
const VERSION4_REF = locator("g4-bounded-read-handbook", 1, 4);
const CLOSED_REF = locator("g4-bounded-read-handbook", 1, 5);

// An identity wide enough that the result-byte ceiling binds first, which the
// gold body alone cannot show: 8,000 code points never cost more than ~32 KiB
// when the locator is short.
const PROBE_REF = locator("\u{1F600}".repeat(900), 9, 9);
const PROBE_BODY = '"\\😀\n'.repeat(2_125);
const PROBE_CODE_POINTS = 8_500;

interface ReadBody {
  id?: string;
  source_ref?: string;
  content?: string;
  next_position?: number | null;
  error?: string;
}

interface WireCall {
  body: ReadBody;
  bytes: number;
  isError: boolean;
}

const codePoints = (text: string): number => Array.from(text).length;
const sha256Of = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const pgHarness = await createPgIntegrationHarness({
  label: "read-source-gold-mcp-pg",
  testPath: "tests/integration/read-source-gold-mcp-pg.test.ts",
  expectedCommand:
    "npx vitest run tests/integration/read-source-gold-mcp-pg.test.ts",
  schemaPrefix: "read_gold",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: true,
});
const {
  schema: SCHEMA,
  schemaConnectionString: SCHEMA_URL,
  describePg,
} = pgHarness;

const seeded = {
  goldId: randomUUID(),
  unit2Id: randomUUID(),
  version4Id: randomUUID(),
  closedId: randomUUID(),
  probeId: randomUUID(),
};

/** Actual measured output of the gold run, printed for the validation record. */
const record: Record<string, unknown> = { schema: SCHEMA };

async function callRead(
  client: McpClient,
  args: Record<string, unknown>
): Promise<WireCall> {
  const result = await client.callTool({
    name: "read_source",
    arguments: args,
  });
  const blocks = result.content as Array<{ type: string; text?: string }>;
  const text = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  return {
    body: JSON.parse(text) as ReadBody,
    bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
    isError: result.isError === true,
  };
}

async function connectServer(): Promise<{
  client: McpClient;
  close: () => Promise<void>;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      GRAPHRAG_MEMORY_STORAGE: "pgvector",
      GRAPHRAG_MEMORY_DB_URL: SCHEMA_URL,
      GRAPHRAG_MEMORY_EMBED_DIMENSIONS: String(DIM),
      GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: "2000",
      GRAPHRAG_MEMORY_LOG_LEVEL: "error",
      // Never dialled: this run reads a stored body, so no arm that needs a
      // credential or a cluster may start.
      GRAPHRAG_MEMORY_NEO4J_URI: "bolt://127.0.0.1:1",
      GRAPHRAG_MEMORY_EMBED_API_KEY: "",
      GRAPHRAG_MEMORY_VECTOR_API_KEY: "",
      GRAPHRAG_MEMORY_ANTHROPIC_API_KEY: "",
      GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "false",
      GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED: "false",
      // An empty home keeps the operator's setting.json out of the child's
      // config, so the embedding-generation boot guard sees this run's
      // dimensions and nothing else.
      HOME: mkdtempSync(join(tmpdir(), "iknow-read-gold-home-")),
      PATH: process.env.PATH ?? "",
    },
    stderr: "pipe",
  });
  const client = new McpClient(
    { name: "read-source-gold", version: "0.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return { client, close: () => client.close() };
}

describePg("read_source gold: real PostgreSQL + real MCP process", () => {
  let client: pg.Client | undefined;
  let backend: PgvectorBackend | undefined;
  let mcp: { client: McpClient; close: () => Promise<void> } | undefined;

  beforeAll(async () => {
    client = pgHarness.createClient(SCHEMA_URL);
    await client.connect();
    await pgHarness.resetSchema(client);
    backend = new PgvectorBackend(SCHEMA_URL, DIM, { annMaxDimensions: 2000 });
    const rows = [
      {
        id: seeded.goldId,
        source_ref: GOLD_REF,
        title: gold.title,
        content: gold.content,
      },
      {
        id: seeded.unit2Id,
        source_ref: UNIT2_REF,
        title: "同一文档的第二冻结单元",
        content: "第二单元的正文与第一单元不同，读取不得互相顶替。".repeat(3),
      },
      {
        id: seeded.version4Id,
        source_ref: VERSION4_REF,
        title: "同一冻结单元的新版本",
        content: "版本 4 的正文。".repeat(10),
      },
      {
        id: seeded.closedId,
        source_ref: CLOSED_REF,
        title: "已失效资料",
        content: "窗口已关闭，正文不得再作为权威返回。",
      },
      {
        id: seeded.probeId,
        source_ref: PROBE_REF,
        title: "字节上限探针",
        content: PROBE_BODY,
      },
    ];
    for (const row of rows) {
      await backend.upsertSourceDoc({
        ...row,
        created_at: "2026-03-02T00:00:00.000Z",
      });
    }
    await client.query(
      "UPDATE source_documents SET valid_until = $1 WHERE source_ref = $2",
      ["2026-09-01T00:00:00.000Z", CLOSED_REF]
    );
    mcp = await connectServer();
  });

  afterAll(async () => {
    await mcp?.close();
    await backend?.close();
    if (client) {
      await pgHarness.dropSchema(client);
      await client.end();
    }
  });

  it("persists the gold body under its canonical locator, untruncated", async () => {
    const stored = await client!.query(
      "SELECT id, source_ref, length(content) AS chars, md5(content) AS sum" +
        " FROM source_documents WHERE source_ref = $1",
      [GOLD_REF]
    );
    expect(stored.rowCount).toBe(1);
    const row = stored.rows[0] as { id: string; source_ref: string };
    expect(row.id).toBe(seeded.goldId);

    const full = await client!.query(
      "SELECT content FROM source_documents WHERE source_ref = $1",
      [GOLD_REF]
    );
    const persisted = (full.rows[0] as { content: string }).content;
    expect(codePoints(persisted)).toBe(gold.code_points);
    expect(sha256Of(persisted)).toBe(gold.sha256);
    record.persisted = {
      id: seeded.goldId,
      source_ref: GOLD_REF,
      code_points: gold.code_points,
      sha256: gold.sha256,
      unit2_id: seeded.unit2Id,
      version4_id: seeded.version4Id,
    };
  });

  it("walks the gold body to a terminal cursor and rebuilds it exactly", async () => {
    const slices: Array<{
      position: number;
      code_points: number;
      bytes: number;
    }> = [];
    const parts: string[] = [];
    let position = 0;
    let maxBytes = 0;
    let maxCodePoints = 0;

    for (let step = 0; step < 32; step += 1) {
      const call = await callRead(mcp!.client, {
        source_ref: GOLD_REF,
        position,
      });
      expect(call.isError).toBe(false);
      expect(call.body.error).toBeUndefined();
      expect(call.body.id).toBe(seeded.goldId);
      expect(call.body.source_ref).toBe(GOLD_REF);
      const taken = codePoints(call.body.content ?? "");
      expect(taken).toBeLessThanOrEqual(SOURCE_READ_MAX_TEXT_CODE_POINTS);
      expect(call.bytes).toBeLessThanOrEqual(SOURCE_READ_MAX_RESULT_BYTES);
      maxBytes = Math.max(maxBytes, call.bytes);
      maxCodePoints = Math.max(maxCodePoints, taken);
      slices.push({ position, code_points: taken, bytes: call.bytes });
      parts.push(call.body.content ?? "");
      if (call.body.next_position === null) {
        expect(position + taken).toBe(gold.code_points);
        position += taken;
        break;
      }
      expect(call.body.next_position).toBeGreaterThan(position);
      position = call.body.next_position as number;
    }
    expect(position).toBe(gold.code_points);

    const rebuilt = parts.join("");
    expect(rebuilt).toBe(gold.content);
    expect(sha256Of(rebuilt)).toBe(gold.sha256);
    record.gold_walk = {
      slices,
      slice_count: slices.length,
      max_slice_code_points: maxCodePoints,
      max_result_bytes: maxBytes,
      ceiling_code_points: SOURCE_READ_MAX_TEXT_CODE_POINTS,
      ceiling_result_bytes: SOURCE_READ_MAX_RESULT_BYTES,
      reconstruction: "byte-identical",
    };
  });

  it("resumes from any cursor the walk produced, not only from zero", async () => {
    const first = await callRead(mcp!.client, {
      source_ref: GOLD_REF,
      position: 0,
    });
    const mid = (first.body.next_position as number) - 500;
    const resumed = await callRead(mcp!.client, {
      source_ref: GOLD_REF,
      position: mid,
    });
    const expected = Array.from(gold.content)
      .slice(mid, mid + SOURCE_READ_MAX_TEXT_CODE_POINTS)
      .join("");
    expect(resumed.body.content).toBe(expected);
    expect(resumed.isError).toBe(false);
    record.mid_body_resume = { position: mid, bytes: resumed.bytes };
  });

  it("keeps one ceiling per result on the byte-bound probe", async () => {
    const slices: Array<{ code_points: number; bytes: number }> = [];
    const parts: string[] = [];
    let position = 0;
    let byteBound = false;

    for (let step = 0; step < 32; step += 1) {
      const call = await callRead(mcp!.client, {
        source_ref: PROBE_REF,
        position,
      });
      expect(call.isError).toBe(false);
      const taken = codePoints(call.body.content ?? "");
      expect(call.bytes).toBeLessThanOrEqual(SOURCE_READ_MAX_RESULT_BYTES);
      expect(taken).toBeLessThanOrEqual(SOURCE_READ_MAX_TEXT_CODE_POINTS);
      if (
        taken < SOURCE_READ_MAX_TEXT_CODE_POINTS &&
        call.body.next_position !== null
      ) {
        byteBound = true;
      }
      slices.push({ code_points: taken, bytes: call.bytes });
      parts.push(call.body.content ?? "");
      if (call.body.next_position === null) break;
      position = call.body.next_position as number;
    }

    expect(codePoints(PROBE_BODY)).toBe(PROBE_CODE_POINTS);
    expect(parts.join("")).toBe(PROBE_BODY);
    expect(byteBound).toBe(true);
    record.byte_ceiling_probe = {
      locator_code_points: codePoints(PROBE_REF),
      slices,
      ceiling_binded_on_bytes: byteBound,
      max_result_bytes: Math.max(...slices.map((s) => s.bytes)),
    };
  });

  it("cannot substitute another unit or version of the same document", async () => {
    const goldFirst = await callRead(mcp!.client, { source_ref: GOLD_REF });
    const unit2 = await callRead(mcp!.client, { source_ref: UNIT2_REF });
    const version4 = await callRead(mcp!.client, { source_ref: VERSION4_REF });

    expect(unit2.body.id).toBe(seeded.unit2Id);
    expect(version4.body.id).toBe(seeded.version4Id);
    expect(unit2.body.content).not.toBe(goldFirst.body.content);
    expect(version4.body.content).not.toBe(unit2.body.content);
    expect(unit2.body.next_position).toBeNull();
    expect(codePoints(unit2.body.content ?? "")).toBeLessThan(gold.code_points);
  });

  it("keeps missing and invalidated rows as distinct typed codes", async () => {
    const missing = await callRead(mcp!.client, {
      source_ref: locator("g4-bounded-read-handbook", 1, 99),
    });
    expect(missing.isError).toBe(true);
    expect(missing.body.error).toBe("read_source_not_found");

    const closed = await callRead(mcp!.client, { source_ref: CLOSED_REF });
    expect(closed.isError).toBe(true);
    expect(closed.body.error).toBe("read_source_invalidated");
    expect(closed.body.id).toBe(seeded.closedId);
    expect(closed.body.next_position).toBeUndefined();
    expect(closed.body.content).toBeUndefined();
    record.typed_misses = {
      not_found: missing.body.error,
      invalidated: closed.body.error,
    };
  });

  it("rejects out-of-domain cursors and oversized selectors structurally", async () => {
    const faults: string[] = [];
    for (const position of [-1, 2.5, gold.code_points + 1]) {
      const call = await callRead(mcp!.client, {
        source_ref: GOLD_REF,
        position,
      });
      expect(call.isError).toBe(true);
      expect(call.body.error).toBe("read_source_invalid_position");
      faults.push(call.body.error as string);
    }
    const oversized = await callRead(mcp!.client, {
      source_ref: locator(
        "x".repeat(SOURCE_READ_MAX_LOCATOR_CODE_POINTS + 1),
        1,
        1
      ),
    });
    expect(oversized.isError).toBe(true);
    expect(oversized.body.error).toBe("read_source_invalid_locator");
    expect(JSON.stringify(oversized.body)).not.toContain("x".repeat(64));
    record.input_faults = faults.concat(oversized.body.error);
  });

  it("agrees across concurrent reads of one frozen unit", async () => {
    const calls = await Promise.all(
      [0, 0, 1, 1].map((position) =>
        callRead(mcp!.client, { source_ref: GOLD_REF, position })
      )
    );
    const byPosition = new Map<number, string>();
    for (const call of calls) {
      expect(call.isError).toBe(false);
      const key = (call.body.next_position ?? "end") as number;
      const fingerprint = JSON.stringify(call.body);
      if (byPosition.has(key)) expect(byPosition.get(key)).toBe(fingerprint);
      byPosition.set(key, fingerprint);
    }
    expect(byPosition.size).toBe(2);
  });

  it("prints the measured gold run for the validation record", () => {
    record.measured_at = new Date().toISOString();
    process.stdout.write(
      `\nGOLD-RECORD ${JSON.stringify(record, null, 2)}\n\n`
    );
    expect(Object.keys(record)).toEqual(
      expect.arrayContaining([
        "persisted",
        "gold_walk",
        "byte_ceiling_probe",
        "typed_misses",
        "input_faults",
      ])
    );
  });
});
