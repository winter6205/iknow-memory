/**
 * Gold acceptance for the durable corpus index-job wire (T2).
 *
 * `submit_index_job` / `poll_index_job` are exercised through the REAL stdio
 * MCP process (`node dist/index.js`) against a REAL PostgreSQL 16 / pgvector,
 * with per-run schema isolation from `pg-test-harness` — never an in-process
 * handler call. The headline is the restart arm: a job queued by one server
 * process is read back by a DIFFERENT process pointed at the same schema, so
 * durability is proven across a process boundary rather than assumed.
 *
 * Expected values are derived independently of the tool wherever the tool is
 * not the thing under test: content identity and job id are recomputed here
 * with the same pure derivations `push`/`submit` use, and persisted state is
 * read back with harness SQL. Where a scenario's headline IS the published
 * identity, the submit takes the value the response returned and the
 * recomputed one stays as the cross-check on it. Loud-skip (hard fail under
 * CI) when Postgres is unreachable, per the shared harness.
 */
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Client as McpClient } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, it, expect } from "vitest";

import {
  computeChunkId,
  computeContentIdentity,
  computeSourceDocId,
} from "../../src/tools/ingest.js";
import { createPgIntegrationHarness } from "./pg-test-harness.js";

// The real Zhipu embedding-3 config from .env.example: push embeds over the
// wire, so the child must dial a real embedder whose returned dimension
// matches the bootstrapped vector column (probed: this API honours 1536).
const DIM = 1536;
const ANN_MAX_DIMENSIONS = 2000;
const EMBED_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const EMBED_MODEL = "embedding-3";
const EMBED_KEY_ENV = "GRAPHRAG_MEMORY_EMBED_API_KEY";

const SERVER_PATH = fileURLToPath(
  new URL("../../dist/index.js", import.meta.url)
);

const pgHarness = await createPgIntegrationHarness({
  label: "index-job-gold-mcp-pg",
  testPath: "tests/integration/index-job-gold-mcp-pg.test.ts",
  expectedCommand:
    "npx vitest run tests/integration/index-job-gold-mcp-pg.test.ts",
  schemaPrefix: "index_gold",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: true,
});
const {
  schema: SCHEMA,
  schemaConnectionString: SCHEMA_URL,
  describePg,
} = pgHarness;

// Three distinct 资料 bodies so identity/version arms never alias each other.
const SRC1 = "corpus/index-gold/annual-report";
const SRC1_BODY = "公司 2024 年度报告正文：营收稳定增长，研发投入持续加码。";
const SRC1_BODY_V2 =
  "公司 2024 年度报告修订版：追加了第四季度分部数据与风险提示。";
const SRC2 = "corpus/index-gold/handbook";
const SRC2_BODY = "运维手册：索引作业为持久队列项，提交不等于抽取完成。";
const SRC2_IDENTITY = computeContentIdentity(SRC2_BODY);
const SRC2_JOB_ID = computeChunkId(SRC2, SRC2_IDENTITY);
const NEVER_PUSHED = "corpus/index-gold/never-pushed";
const BOGUS_JOB_ID = randomUUID();

interface WireResult {
  body: Record<string, unknown>;
  isError: boolean;
}

interface McpHandle {
  client: McpClient;
  close: () => Promise<void>;
}

interface RawToolResult {
  content?: unknown;
  isError?: boolean;
}

/** Measured outputs of this gold run, printed masked at the end. */
const record: Record<string, unknown> = { schema: SCHEMA };

/** The text blocks of a tool result, concatenated as the host reads them. */
function wireText(result: RawToolResult): string {
  const blocks = (result.content ?? []) as Array<{
    type: string;
    text?: string;
  }>;
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/**
 * Parse a tool body, naming the call when it is not JSON.
 *
 * A handler that throws without a structured failure token — an embedder
 * hiccup is the live one — answers with a PLAIN TEXT isError block. Parsing
 * that straight would surface a bare SyntaxError from inside `JSON.parse` and
 * read as a contract break in the tool under test rather than as the external
 * dependency it actually is.
 */
function parseWire(result: RawToolResult, call: string): WireResult {
  const text = wireText(result);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `${call}: expected a JSON tool body, got ${
        result.isError === true ? "an isError" : "a non-error"
      } result with text ${JSON.stringify(text)} (parse cause: ${String(cause)})`
    );
  }
  return {
    body: body as Record<string, unknown>,
    isError: result.isError === true,
  };
}

async function callTool(
  client: McpClient,
  name: string,
  args: Record<string, unknown>
): Promise<WireResult> {
  const result = (await client.callTool({
    name,
    arguments: args,
  })) as RawToolResult;
  return parseWire(result, name);
}

function pushArgs(sourceRef: string, body: string): Record<string, unknown> {
  return {
    source_ref: sourceRef,
    content: body,
    chunks: [{ content: body, index: 0 }],
    metadata: { doc: "t2-gold" },
    valid_from: "2026-01-01T00:00:00Z",
    valid_until: "2099-01-01T00:00:00Z",
  };
}

/**
 * Push and require the success body, naming a failed push as what it is.
 *
 * Every scenario below depends on the document having landed; an embedder
 * outage is a blocked gold run, so it is reported as such instead of
 * degrading into a parse error.
 */
async function pushDocument(
  client: McpClient,
  sourceRef: string,
  body: string
): Promise<WireResult> {
  const result = (await client.callTool({
    name: "push",
    arguments: pushArgs(sourceRef, body),
  })) as RawToolResult;
  if (result.isError === true) {
    throw new Error(
      `push of "${sourceRef}" was refused by the real embedder ` +
        `(embedding_error): ${JSON.stringify(wireText(result))}`
    );
  }
  return parseWire(result, "push");
}

/** Spawn a real MCP child against this run's schema; keys pass through, never
 *  logged. A boot failure rejects the connect, so a bad config is loud. */
async function connectServer(name: string): Promise<McpHandle> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      GRAPHRAG_MEMORY_STORAGE: "pgvector",
      GRAPHRAG_MEMORY_DB_URL: SCHEMA_URL,
      GRAPHRAG_MEMORY_EMBED_API_KEY: process.env[EMBED_KEY_ENV] ?? "",
      GRAPHRAG_MEMORY_EMBED_BASE_URL: EMBED_BASE_URL,
      GRAPHRAG_MEMORY_EMBED_MODEL: EMBED_MODEL,
      GRAPHRAG_MEMORY_EMBED_DIMENSIONS: String(DIM),
      GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS: String(ANN_MAX_DIMENSIONS),
      GRAPHRAG_MEMORY_LOG_LEVEL: "error",
      GRAPHRAG_MEMORY_VECTOR_API_KEY: "",
      GRAPHRAG_MEMORY_ANTHROPIC_API_KEY: "",
      GRAPHRAG_MEMORY_NEO4J_URI: "bolt://127.0.0.1:1",
      GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "false",
      GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED: "false",
      HOME: mkdtempSync(join(tmpdir(), "iknow-index-gold-home-")),
      PATH: process.env.PATH ?? "",
    },
    stderr: "pipe",
  });
  const client = new McpClient(
    { name, version: "0.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return { client, close: () => client.close() };
}

async function pollPersistedJob(
  client: pg.Client,
  jobId: string
): Promise<Record<string, unknown>> {
  const res = await client.query(
    "SELECT job_id, source_ref, content_identity, status, created_at, started_at," +
      " finished_at, failure_code FROM index_jobs WHERE job_id = $1",
    [jobId]
  );
  return res.rows[0] as Record<string, unknown>;
}

async function sourceRow(
  client: pg.Client,
  sourceRef: string
): Promise<Record<string, unknown>> {
  const res = await client.query(
    "SELECT status, content_identity FROM source_documents WHERE source_ref = $1",
    [sourceRef]
  );
  return res.rows[0] as Record<string, unknown>;
}

describePg("index-job gold: real PostgreSQL + real MCP process", () => {
  let sql: pg.Client | undefined;
  let mcp: McpHandle | undefined;

  beforeAll(async () => {
    if (!process.env[EMBED_KEY_ENV]) {
      throw new Error(
        `${EMBED_KEY_ENV} must be present so push can embed over the real wire; ` +
          "a missing embedding dependency is a blocked gold run, not a pass"
      );
    }
    sql = pgHarness.createClient(SCHEMA_URL);
    await sql.connect();
    await pgHarness.resetSchema(sql);
    // Connecting the child bootstraps the schema (buildDeps runs initialize()
    // before the transport serves), so seeding happens against real tables.
    mcp = await connectServer("index-job-gold");
    await sql.query(
      "INSERT INTO source_documents (id, source_ref, content, status, content_identity)" +
        " VALUES ($1, $2, $3, 'ready', $4)",
      [computeSourceDocId(SRC2), SRC2, SRC2_BODY, SRC2_IDENTITY]
    );
  });

  afterAll(async () => {
    await mcp?.close();
    if (sql) {
      await pgHarness.dropSchema(sql);
      await sql.end();
    }
  });

  it("1 push persists content_identity; submit queues a durable job poll reads", async () => {
    const expectedIdentity = computeContentIdentity(SRC1_BODY);
    const pushed = await pushDocument(mcp!.client, SRC1, SRC1_BODY);
    // push stays write-only for jobs: its response carries its own id fields
    // plus the identity it stored, and nothing else.
    expect(pushed.isError).toBe(false);
    expect(Object.keys(pushed.body).sort()).toEqual([
      "chunk_ids",
      "content_identity",
      "source_doc_id",
    ]);
    expect(pushed.body).not.toHaveProperty("job_id");
    expect(pushed.body).not.toHaveProperty("reused");

    const afterPush = await sourceRow(sql!, SRC1);
    expect(afterPush.content_identity).toBe(expectedIdentity);
    expect(afterPush.status).toBe("ready");
    // The published value equals both the independently recomputed identity
    // and the stored column — that is the seam's discoverability half: the
    // Host forms the submit pair from the response, not from the hash.
    expect(pushed.body.content_identity).toBe(expectedIdentity);

    const submitted = await callTool(mcp!.client, "submit_index_job", {
      source_ref: SRC1,
      content_identity: String(pushed.body.content_identity),
    });
    expect(submitted.isError).toBe(false);
    expect(submitted.body).toMatchObject({
      job_id: computeChunkId(SRC1, expectedIdentity),
      source_ref: SRC1,
      content_identity: expectedIdentity,
      status: "in_progress",
      started_at: null,
      reused: false,
    });
    const jobId = String(submitted.body.job_id);
    const row = await pollPersistedJob(sql!, jobId);
    expect(row.started_at).toBeNull();
    expect(row.finished_at).toBeNull();
    expect(row.status).toBe("in_progress");

    const polled = await callTool(mcp!.client, "poll_index_job", {
      job_id: jobId,
    });
    expect(polled.isError).toBe(false);
    expect(polled.body).toMatchObject({
      job_id: jobId,
      status: "in_progress",
      started_at: null,
    });
    record.scenario1 = {
      source_ref: SRC1,
      content_identity: expectedIdentity,
      job_id: jobId,
    };
  });

  it("2 restart arm: a job queued by one process is read by a fresh process", async () => {
    const a = await connectServer("index-job-gold-restart-a");
    const b = await (async () => {
      try {
        const submitted = await callTool(a.client, "submit_index_job", {
          source_ref: SRC2,
          content_identity: SRC2_IDENTITY,
        });
        expect(submitted.body.job_id).toBe(SRC2_JOB_ID);
        expect(submitted.body.reused).toBe(false);
      } finally {
        // Kill the process that enqueued the job: durability must outlive it.
        await a.close();
      }
      // A genuinely new server process, pointed at the same schema/db.
      return connectServer("index-job-gold-restart-b");
    })();
    try {
      const polled = await callTool(b.client, "poll_index_job", {
        job_id: SRC2_JOB_ID,
      });
      expect(polled.isError).toBe(false);
      expect(polled.body).toMatchObject({
        job_id: SRC2_JOB_ID,
        source_ref: SRC2,
        content_identity: SRC2_IDENTITY,
        status: "in_progress",
        started_at: null,
        finished_at: null,
        failure_code: null,
      });
      const persisted = await pollPersistedJob(sql!, SRC2_JOB_ID);
      expect(persisted.status).toBe("in_progress");
      expect(String(persisted.created_at)).not.toBe("null");
      record.scenario2 = {
        job_id: SRC2_JOB_ID,
        survived_restart: true,
        persisted_created_at: String(persisted.created_at),
      };
    } finally {
      await b.close();
    }
  });

  it("3 idempotency: a re-submit joins the same job, exactly one row", async () => {
    const second = await callTool(mcp!.client, "submit_index_job", {
      source_ref: SRC2,
      content_identity: SRC2_IDENTITY,
    });
    expect(second.isError).toBe(false);
    expect(second.body.job_id).toBe(SRC2_JOB_ID);
    expect(second.body.reused).toBe(true);
    const count = await sql!.query(
      "SELECT count(*)::int AS n FROM index_jobs WHERE job_id = $1",
      [SRC2_JOB_ID]
    );
    const bySource = await sql!.query(
      "SELECT count(*)::int AS n FROM index_jobs WHERE source_ref = $1",
      [SRC2]
    );
    expect(count.rows[0].n).toBe(1);
    expect(bySource.rows[0].n).toBe(1);
    record.scenario3 = { job_id: SRC2_JOB_ID, rows_for_pair: count.rows[0].n };
  });

  it("4 typed errors over the wire: unknown source, identity mismatch, unknown job", async () => {
    const unknownSource = await callTool(mcp!.client, "submit_index_job", {
      source_ref: NEVER_PUSHED,
      content_identity: "sha256:none",
    });
    expect(unknownSource.isError).toBe(true);
    expect(unknownSource.body.error).toBe("index_job_unknown_source");

    const mismatch = await callTool(mcp!.client, "submit_index_job", {
      source_ref: SRC1,
      content_identity: "sha256:wrong-version",
    });
    expect(mismatch.isError).toBe(true);
    expect(mismatch.body.error).toBe("index_job_identity_mismatch");

    const unknownJob = await callTool(mcp!.client, "poll_index_job", {
      job_id: BOGUS_JOB_ID,
    });
    expect(unknownJob.isError).toBe(true);
    expect(unknownJob.body.error).toBe("index_job_unknown_job");
    expect(unknownJob.body.job_id).toBe(BOGUS_JOB_ID);
    record.scenario4 = {
      unknown_source: unknownSource.body.error,
      mismatch: mismatch.body.error,
      unknown_job: unknownJob.body.error,
    };
  });

  it("5 non-falsification: submit/poll never rewrite source status or 档 C state", async () => {
    await sql!.query(
      "INSERT INTO community_index_state (id, status, failure_code) VALUES (1, 'stale', NULL)" +
        " ON CONFLICT (id) DO UPDATE SET status = 'stale', failure_code = NULL"
    );
    const submitted = await callTool(mcp!.client, "submit_index_job", {
      source_ref: SRC1,
      content_identity: computeContentIdentity(SRC1_BODY),
    });
    const jobId = String(submitted.body.job_id);

    const polled = await callTool(mcp!.client, "poll_index_job", {
      job_id: jobId,
    });
    // Two distinct facts: the job is queued while the C singleton stays stale.
    expect(polled.body.status).toBe("in_progress");
    expect(polled.body.community_index_state).toEqual({
      status: "stale",
      failure_code: null,
    });

    const src = await sourceRow(sql!, SRC1);
    const community = await sql!.query(
      "SELECT status, failure_code FROM community_index_state WHERE id = 1"
    );
    expect(src.status).toBe("ready");
    expect(community.rows[0]).toEqual({ status: "stale", failure_code: null });
    record.scenario5 = {
      source_status: src.status,
      community_status: community.rows[0].status,
    };
  });

  it("6 conflict: a second content version is refused while job1 is active", async () => {
    const v2Identity = computeContentIdentity(SRC1_BODY_V2);
    const pushed = await pushDocument(mcp!.client, SRC1, SRC1_BODY_V2);
    expect(pushed.isError).toBe(false);
    expect(pushed.body.content_identity).toBe(v2Identity);
    expect((await sourceRow(sql!, SRC1)).content_identity).toBe(v2Identity);

    const conflict = await callTool(mcp!.client, "submit_index_job", {
      source_ref: SRC1,
      content_identity: String(pushed.body.content_identity),
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.body.error).toBe("index_job_in_progress");
    expect(conflict.body.active_job_id).toBe(
      computeChunkId(SRC1, computeContentIdentity(SRC1_BODY))
    );
    record.scenario6 = { active_job_id: conflict.body.active_job_id };
  });

  it("prints the measured gold run for the validation record", () => {
    record.measured_at = new Date().toISOString();
    process.stdout.write(
      `\nGOLD-RECORD ${JSON.stringify(record, null, 2)}\n\n`
    );
    expect(Object.keys(record)).toEqual(
      expect.arrayContaining([
        "scenario1",
        "scenario2",
        "scenario3",
        "scenario4",
        "scenario5",
        "scenario6",
      ])
    );
  });
});
