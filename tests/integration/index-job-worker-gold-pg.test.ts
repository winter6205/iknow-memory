/**
 * Gold acceptance for the durable index-job WORKER.
 *
 * The invariant: a claimed job runs extract -> projection drain -> community
 * detect + summarize + swap through the existing capabilities and publishes
 * exactly one lease-guarded terminal state, so a worker restart or a retried
 * delivery can neither lose the durable request nor report success before the
 * required stages finish (`specs/corpus-index-job-orchestration.md`,
 * Decision 3 and the worker's published literals).
 *
 * Every boundary that claim rests on is REAL here, not a fake:
 *  - PostgreSQL 16 + pgvector from `docker-compose.yml`, per-run isolated schema
 *    (`pg-test-harness`), which is the ledger's own system of record;
 *  - the submit/poll/C-readiness wire through a REAL stdio MCP child process
 *    (`node dist/index.js`), never an in-process handler call;
 *  - the worker itself as a REAL child process (`node dist/cli/index-job-worker.js`
 *    after `npm run build`), so a `kill -9` is a real process death and the
 *    reclaim is a real second process;
 *  - the live Neo4j (+GDS), Elasticsearch (+analysis-ik), embedding and LLM
 *    endpoints for the C-ready case W1.
 *
 * Determinism without a fake: two Neo4j endpoints are used as controlled seams.
 * `BLACK_HOLE_NEO4J_URI` (TEST-NET-1, RFC 5737) makes the projection stage block
 * on the driver's connect timeout, which is the window W2 kills inside and W6
 * observes the serialization lock through. `REFUSED_NEO4J_URI` answers
 * ECONNREFUSED in milliseconds, so the same stage fails fast and types
 * `NEO4J_UNAVAILABLE`. Neither stands in for a claim about a
 * healthy service: the healthy Neo4j/ES/LLM path is W1, and it is gated on those
 * services answering.
 *
 * Case gating (specs/corpus-index-job-orchestration.md — `npm test` stays
 * green without live services; AGENTS.md — a required dependency is never turned
 * into a green skip):
 *  - the whole file rides `describePg`, which loud-skips locally and HARD-FAILS
 *    under CI when Postgres is unreachable;
 *  - the file additionally needs the real embedding endpoint, because every case
 *    starts with a real `push`; without the key it loud-skips with the Validation
 *    block (no CI lane provisions an embedding secret, so no lane can claim it);
 *  - only W1 needs live Neo4j + ES + LLM, and only W1 skips when one of them does
 *    not answer — W2-W6 never lose coverage because of it;
 *  - W1 also honors an explicit opt-in: with `GRAPHRAG_MEMORY_GOLD_REQUIRE=1` a
 *    missing W1 dependency is a hard failure instead of a skip, which is what a
 *    CI lane that DOES provision Neo4j/ES/LLM must set so it cannot go green by
 *    skipping.
 *
 * Expected values come from the spec and from independent recomputation (the same
 * pure derivations `push`/`submit` use, recomputed here) plus SQL read-back — not
 * from the code under test's own claims. Nothing here touches `src/`.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import neo4j, { type Driver } from "neo4j-driver";
import { Client as McpClient } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, it, expect } from "vitest";

import {
  computeChunkId,
  computeContentIdentity,
} from "../../src/tools/ingest.js";
import {
  JOB_SERIALIZATION_KEY,
  LOCK_ACQUIRE_SQL,
  LOCK_RELEASE_SQL,
} from "../../src/cli/index-job-worker.js";
import { advisoryLockKey } from "../../src/core/storage/schema-lock.js";
import { INDEX_JOB_STATUS } from "../../src/core/types.js";
import { FAST_EMPTY_GRAPH_CODE } from "../../src/core/extraction/fast.js";
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  ELASTICSEARCH_URL_VAR,
} from "../../src/config.js";
import { ElasticsearchPrecisionLayer } from "../../src/core/storage/elasticsearch-precision.js";
import {
  createPgIntegrationHarness,
  redactPgConnectionString,
  redactPgDiagnostic,
} from "./pg-test-harness.js";
import { probeElasticsearch } from "./es-test-harness.js";
import { egressEnv } from "./egress-env.js";

// ---------------------------------------------------------------------------
// Real-service configuration. Only NAMES are read here; the values stay in the
// process environment and are never logged.
// ---------------------------------------------------------------------------

/** The committed `.env.example` embed block: push persists real vectors. */
const DIM = 1536;
const ANN_MAX_DIMENSIONS = 2000;
const EMBED_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const EMBED_MODEL = "embedding-3";
const EMBED_KEY_ENV = "GRAPHRAG_MEMORY_EMBED_API_KEY";

const NEO4J_URI_ENV = "GRAPHRAG_MEMORY_NEO4J_URI";
const NEO4J_USER_ENV = "GRAPHRAG_MEMORY_NEO4J_USER";
const NEO4J_PASSWORD_ENV = "GRAPHRAG_MEMORY_NEO4J_PASSWORD";
/** The identity `docker-compose.yml` serves: a child with a URI to dial still
 *  needs a pair, and Neo4j refuses an unauthenticated bolt handshake. */
const NEO4J_USER_DEFAULT = "neo4j";
const NEO4J_PASSWORD_DEFAULT = "iknow-memory-dev";
const ES_URL = process.env[ELASTICSEARCH_URL_VAR] ?? "http://localhost:9200";
/** LLM secret: the repo's own name, with the ambient Anthropic var as its alias. */
const LLM_TOKEN =
  process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
const LLM_BASE_URL =
  process.env.GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL ??
  process.env.ANTHROPIC_BASE_URL ??
  DEFAULT_LLM_BASE_URL;
const LLM_MODEL =
  process.env.GRAPHRAG_MEMORY_ANTHROPIC_MODEL ?? DEFAULT_LLM_MODEL;
const REQUIRE_W1 = process.env.GRAPHRAG_MEMORY_GOLD_REQUIRE === "1";

const SERVER_PATH = fileURLToPath(
  new URL("../../dist/index.js", import.meta.url)
);
const WORKER_PATH = fileURLToPath(
  new URL("../../dist/cli/index-job-worker.js", import.meta.url)
);

const TEST_PATH = "tests/integration/index-job-worker-gold-pg.test.ts";
const EXPECTED_COMMAND =
  "npm run build && GRAPHRAG_MEMORY_DB_URL=<compose pg dsn> " +
  `${EMBED_KEY_ENV}=… ${NEO4J_URI_ENV}=bolt://localhost:7687 ` +
  `${NEO4J_USER_ENV}=… ${NEO4J_PASSWORD_ENV}=… ${ELASTICSEARCH_URL_VAR}=http://localhost:9200 ` +
  "GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL=… GRAPHRAG_MEMORY_ANTHROPIC_MODEL=… " +
  `npx vitest run ${TEST_PATH}`;

/**
 * The projection target of a worker that must NOT answer inside the stage.
 * Both seams are TEST-NET / loopback addresses measured on this box:
 *  - `bolt://192.0.2.1:7687` (RFC 5737 TEST-NET-1) has nothing serving the
 *    Bolt protocol, so the driver sits on it for seconds before the stage
 *    answers — the in-stage window W2 kills inside and W6 observes the job
 *    lock through. How long it sits is this box's routing, not the product's:
 *    measured here at 5 014 ms (`Connection was closed by server`) and at
 *    30 008 ms on an earlier network, so neither case waits on a fixed number;
 *  - `bolt://127.0.0.1:1` is refused at once, so the same stage fails fast and
 *    types the projection's own `NEO4J_UNAVAILABLE`.
 */
const BLACK_HOLE_NEO4J_URI = "bolt://192.0.2.1:7687";
const REFUSED_NEO4J_URI = "bolt://127.0.0.1:1";
/** An LLM endpoint that cannot be reached: a standard leg could only fail here. */
const UNREACHABLE_LLM_BASE_URL = "http://192.0.2.1:1";
/**
 * Hard ceiling on the import-time LLM dial. Vitest collects this file under its
 * `tests` include, so even the scrubbed-env `npm test` pass imports it and
 * would otherwise pay an ambient egress proxy's latency — or hang — before the
 * gating flags can be computed. A bounded dial degrades to "not ready,
 * loud-skip" fast; the probe needs an answer to gate on, not a full completion.
 */
const LLM_PROBE_TIMEOUT_MS = 5_000;

const pgHarness = await createPgIntegrationHarness({
  label: "index-job-worker-gold-pg",
  testPath: TEST_PATH,
  expectedCommand: EXPECTED_COMMAND,
  schemaPrefix: "index_worker_gold",
  defaultConnectionString: "postgresql://postgres@localhost/postgres",
  requiresVector: true,
});
const {
  schema: SCHEMA,
  schemaConnectionString: SCHEMA_URL,
  describePg,
} = pgHarness;

/** Per-run ES index names, so the shared cluster is only touched by this run. */
const ES_PREFIX = `iknow-gold-${SCHEMA.slice(-12)}`;
const ES_CHUNK_INDEX = `${ES_PREFIX}-chunks`;
const ES_ENTITY_INDEX = `${ES_PREFIX}-entities`;
const ES_SUMMARY_INDEX = `${ES_PREFIX}-summaries`;
/**
 * The precision layer's 5 s default covers a steady-state write, not this
 * suite's first one: that call creates the index with its `analysis-ik` mapping
 * and then waits for a refresh to publish it, which was measured crossing 5 000
 * ms on a loaded box (`push precision index failed: … is unavailable: Request
 * timed out`). The legs under test are the job's stages, so the client budget
 * is widened instead of letting a cold-start write decide a case.
 */
const ES_REQUEST_TIMEOUT_MS = "20000";

function warnNotRun(reason: string, cases: string): void {
  console.warn(`\n[index-job-worker-gold] ${reason}\n`);
  console.warn(
    "Validation:\n" +
      `- Not run: ${TEST_PATH} (${cases})\n` +
      `- Expected command: ${EXPECTED_COMMAND}\n` +
      `- Blocking issue: ${reason}\n`
  );
}

// --- live-boundary probes for W1 (measured here, never assumed) -------------
const esProbe = await probeElasticsearch(ES_URL);

async function probeNeo4j(): Promise<{ available: boolean; error?: string }> {
  const uri = process.env[NEO4J_URI_ENV];
  if (uri === undefined || uri.trim() === "") {
    return { available: false, error: `${NEO4J_URI_ENV} is not set` };
  }
  const user = process.env[NEO4J_USER_ENV];
  const password = process.env[NEO4J_PASSWORD_ENV];
  const driver = neo4j.driver(
    uri,
    user !== undefined && password !== undefined
      ? neo4j.auth.basic(user, password)
      : undefined
  );
  try {
    await driver.verifyConnectivity();
    return { available: true };
  } catch (err) {
    return {
      available: false,
      error: `${uri} did not answer: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await driver.close().catch(() => {});
  }
}

const neo4jProbe = await probeNeo4j();

/**
 * Whether the configured LLM route actually answers ONE completion.
 *
 * Presence of a secret is not availability: a proxy can hold a key and still
 * answer `404 model_not_found` for every model, and then no chunk of any method
 * can clear the judge gate (judge.ts dials for every non-empty proposal, fast
 * included). This is measured because the whole file's extract stage depends on
 * it, not only W1.
 */
async function probeLlm(): Promise<{ available: boolean; error?: string }> {
  const key = (LLM_TOKEN ?? "").trim();
  if (key === "") return { available: false, error: "no LLM secret is set" };
  try {
    const res = await fetch(`${LLM_BASE_URL.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      signal: AbortSignal.timeout(LLM_PROBE_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 8,
        messages: [{ role: "user", content: "reply with the word ok" }],
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200).replace(/\s+/g, " ");
      return {
        available: false,
        error: `${LLM_BASE_URL} answered HTTP ${res.status} for ${LLM_MODEL}: ${detail}`,
      };
    }
    return { available: true };
  } catch (err) {
    return {
      available: false,
      error: `${LLM_BASE_URL} did not answer: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const llmProbe = await probeLlm();
const EMBED_READY = (process.env[EMBED_KEY_ENV] ?? "").trim().length > 0;
/** Every case whose extract stage must clear the judge gate needs this. */
const JUDGE_READY = EMBED_READY && llmProbe.available;
const W1_READY = JUDGE_READY && esProbe.available && neo4jProbe.available;

if (EMBED_READY === false) {
  console.warn(
    `\n[index-job-worker-gold] ${EMBED_KEY_ENV} is not set — every case starts with a real push, which persists real vectors\n`
  );
  console.warn(
    "Validation:\n" +
      `- Not run: ${TEST_PATH} (all cases)\n` +
      `- Expected command: ${EXPECTED_COMMAND}\n` +
      `- Blocking issue: missing ${EMBED_KEY_ENV} for the real embedding endpoint\n`
  );
}
if (EMBED_READY && !JUDGE_READY) {
  warnNotRun(
    `no answering LLM for the judge gate every extracted chunk must clear: ${llmProbe.error}`,
    "W2 W5 W6 W1"
  );
}
if (JUDGE_READY && !W1_READY) {
  warnNotRun(
    neo4jProbe.available === false
      ? `no live Neo4j for the projection + GDS summary stage: ${neo4jProbe.error}`
      : `no live Elasticsearch for the precision layer: ${ES_URL}`,
    "W1"
  );
}
if (REQUIRE_W1 && !W1_READY) {
  // A lane that declares the W1 dependencies must fail rather than skip green.
  throw new Error(
    `GRAPHRAG_MEMORY_GOLD_REQUIRE=1 but W1's live dependencies are unavailable (neo4j=${neo4jProbe.available} es=${esProbe.available} llm=${llmProbe.available} embed=${EMBED_READY})`
  );
}

// ---------------------------------------------------------------------------
// Committed corpus fixture. Chinese 资料 bodies; what is unique per case is the
// (source_ref, content_identity) pair, not the text — `chunks.id` is derived
// from that pair, so a body may repeat across sources. `W2/W5/W6` need their
// extract leg to PASS so a later stage is observable, so those bodies are
// written for the fast leg and the judge gate together, as the note above
// `W2_BODY` records. `W4` keeps a rich body because no stage ever runs for it,
// and `W3` is the stopword-only 资料 that the fast method must refuse
// (`FAST_EMPTY_GRAPH`, specs/graph-index-standard-fast.md assumption 4).
// ---------------------------------------------------------------------------

const W3_SRC = "corpus/index-worker-gold/w3-fast-empty";
const W3_BODY = "总之，鉴于此，乃因其故，并于其间，或其所以。";

const W2_SRC = "corpus/index-worker-gold/w2-restart";
/**
 * Every relation in these bodies is one explicit clause over two entities that
 * never nest inside each other. The judge gates each chunk closed — an
 * ungrounded proposal is `JUDGE_REJECTED`, and its job is terminal — so a body
 * like "湖图平台的蓝湖科技" hands W2/W5/W6 to the judge's coin flip: the case
 * needs the extract leg to survive to the projection stage, and a possessive
 * phrase asserts nothing it can ground.
 *
 * Two clauses, not one: a single sentence leaves the fast leg one candidate
 * edge, and a one-edge set is pruned against its own percentile, so the graph
 * that survives is a coin flip. Measured — "蓝湖科技发布湖图平台。" published
 * `FAST_EMPTY_GRAPH` while "张伟任职于蓝湖科技。" reached the drain.
 */
const W2_BODY = "张伟任职于蓝湖科技。制造客户使用湖图平台。";

const W4_SRC = "corpus/index-worker-gold/w4-identity-drift";
const W4_BODY_A =
  "项目纪要：蓝湖科技承接湖图平台建设，张伟担任项目负责人，华东区提供制造客户名单。";
const W4_BODY_B =
  "项目纪要修订版：蓝湖科技承接湖图平台建设，李娜接任项目负责人，华东区追加三家制造客户。";

const W5_SRC = "corpus/index-worker-gold/w5-one-active";
const W5_BODY_A = "张伟任职于蓝湖科技。制造客户使用湖图平台。";
const W5_BODY_B = "李娜任职于蓝湖科技。制造客户使用湖图平台。";

const W6_SRC_1 = "corpus/index-worker-gold/w6-serial-first";
const W6_BODY_1 = "王强任职于蓝湖科技。制造客户使用湖图平台。";
const W6_SRC_2 = "corpus/index-worker-gold/w6-serial-second";
const W6_BODY_2 = "孙丽任职于蓝湖科技。制造客户使用湖图平台。";

const W1_SRC = "corpus/index-worker-gold/w1-c-ready";
const W1_BODY =
  "蓝湖科技是一家知识图谱公司，总部设在上海。" +
  "张伟任职于蓝湖科技，职务是首席科学家。" +
  "蓝湖科技在2024年发布湖图平台。" +
  "制造客户使用湖图平台。";
const W1_QUERY = "蓝湖科技 湖图平台 制造客户 张伟";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface WireResult {
  body: Record<string, unknown>;
  isError: boolean;
}

interface McpHandle {
  client: McpClient;
  /** The server's own stderr — the only place a fail-open mirror reports. */
  stderr: () => string;
  close: () => Promise<void>;
}

interface RawToolResult {
  content?: unknown;
  isError?: boolean;
}

/** Measured facts of this run, printed at the end for the validation record. */
const record: Record<string, unknown> = { schema: SCHEMA };

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

/** Parse a tool body, naming the call when it is not JSON — the same rule the
 * submit/poll wire gold (`index-job-gold-mcp-pg.test.ts`) pins. */
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
    metadata: { doc: "index-worker-gold" },
    valid_from: "2026-01-01T00:00:00Z",
    valid_until: "2099-01-01T00:00:00Z",
  };
}

/**
 * A refused push is a blocked gold run (the embedder is a real dependency).
 *
 * The only transient class worth re-asking is the transport fault: the live
 * embedding endpoint answers `fetch failed` on a dropped connection, and `push`
 * is idempotent for one body (chunk and identity are derived, not generated),
 * so a retry cannot double-write. Any other refusal is the endpoint's own
 * verdict and fails immediately with it.
 */
const PUSH_TRANSPORT_FAULT =
  /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i;
const PUSH_ATTEMPTS = 4;
const PUSH_RETRY_BASE_MS = 2_000;

async function pushDocument(
  client: McpClient,
  sourceRef: string,
  body: string
): Promise<WireResult> {
  let lastText = "";
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
    const result = (await client.callTool({
      name: "push",
      arguments: pushArgs(sourceRef, body),
    })) as RawToolResult;
    if (result.isError !== true) return parseWire(result, "push");
    lastText = wireText(result);
    if (!PUSH_TRANSPORT_FAULT.test(lastText)) break;
    if (attempt < PUSH_ATTEMPTS) await sleep(PUSH_RETRY_BASE_MS * attempt);
  }
  throw new Error(
    `push of "${sourceRef}" was refused by the real endpoint: ${JSON.stringify(lastText)}`
  );
}

/**
 * Env shared by every child: an isolated HOME so no operator config leaks in,
 * and this run's Postgres schema as the only store.
 */
function childEnv(
  extra: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: mkdtempSync(join(tmpdir(), "iknow-index-worker-gold-home-")),
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
    GRAPHRAG_MEMORY_ES_REQUEST_TIMEOUT_MS: ES_REQUEST_TIMEOUT_MS,
    ...egressEnv(),
    ...extra,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === "") delete env[key];
  }
  return env;
}

/**
 * The infrastructure keys every child of this run shares: the lexical arm
 * (address plus this run's three per-run index names) and the rerank switch.
 * Defined once because the two kinds of child must answer to the SAME arm —
 * the wire mirror-writes a pushed chunk into Elasticsearch and the job's own
 * stages later read that same store, so a per-call-site copy could let a case
 * run its stages on a lexical arm the write never landed on. `liveLexical` is
 * off for every case whose retrieve leg does not need `analysis-ik`.
 */
function infraEnv(liveLexical: boolean): Record<string, string> {
  return {
    GRAPHRAG_MEMORY_ES_URL: liveLexical ? ES_URL : "",
    GRAPHRAG_MEMORY_ES_CHUNK_INDEX: liveLexical ? ES_CHUNK_INDEX : "",
    GRAPHRAG_MEMORY_ES_ENTITY_INDEX: liveLexical ? ES_ENTITY_INDEX : "",
    GRAPHRAG_MEMORY_ES_SUMMARY_INDEX: liveLexical ? ES_SUMMARY_INDEX : "",
    GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED: liveLexical ? "true" : "false",
    GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED: "false",
  };
}

/**
 * The MCP wire process. The non-C-ready cases run with the lexical arm off and
 * a Neo4j address that answers nothing — submit/poll are pure Postgres reads,
 * and the case that needs the real sidecar (W1) gets the real one. Only the
 * Neo4j target is spelled here: an unset operator value stays unset, because a
 * URI with no pair is the product's own no-auth configuration.
 */
function wireEnv(live: boolean): Record<string, string> {
  return childEnv({
    ...infraEnv(live),
    GRAPHRAG_MEMORY_NEO4J_URI: live
      ? (process.env[NEO4J_URI_ENV] ?? "")
      : REFUSED_NEO4J_URI,
    GRAPHRAG_MEMORY_NEO4J_USER: live
      ? (process.env[NEO4J_USER_ENV] ?? "")
      : NEO4J_USER_DEFAULT,
    GRAPHRAG_MEMORY_NEO4J_PASSWORD: live
      ? (process.env[NEO4J_PASSWORD_ENV] ?? "")
      : NEO4J_PASSWORD_DEFAULT,
  });
}

async function connectServer(name: string, live = false): Promise<McpHandle> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: wireEnv(live),
    stderr: "pipe",
  });
  // The pipe exists from the constructor, so nothing the boot writes is lost.
  let stderr = "";
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const client = new McpClient(
    { name, version: "0.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return { client, stderr: () => stderr, close: () => client.close() };
}

/**
 * What the wire process itself reported, for a failure message that names the
 * boundary that broke. A fail-open mirror answers only here, so without it an
 * empty lexical arm is indistinguishable from a dropped write.
 */
function serverFault(handle: McpHandle): string {
  return redactPgDiagnostic(handle.stderr(), SCHEMA_URL).slice(-400);
}

interface WorkerHandle {
  child: ChildProcessByStdio<null, Readable, Readable>;
  pid: number;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Live children still running when a case ends; killed in afterAll. */
const openWorkers = new Set<WorkerHandle>();

/**
 * Start the worker as its OWN process. Nothing here is in-process: the claim,
 * the stages, the lock and the terminal publish all happen inside the child, so
 * a `kill -9` is a real crash and a restart is a real second process.
 */
function startWorker(
  args: string[],
  opts: { neo4jUri: string; llmBaseUrl?: string; liveInfra?: boolean }
): WorkerHandle {
  const child = spawn(process.execPath, [WORKER_PATH, ...args], {
    cwd: join(fileURLToPath(new URL(".", import.meta.url)), "..", ".."),
    env: childEnv({
      ...infraEnv(opts.liveInfra ?? false),
      // Per-case on purpose: the target is the seam that decides which stage
      // arm is observable (black hole, refused, or the real projection). Its
      // credential pair falls back to the compose default because the drain
      // has to authenticate to dial any of the three.
      GRAPHRAG_MEMORY_NEO4J_URI: opts.neo4jUri,
      GRAPHRAG_MEMORY_NEO4J_USER:
        process.env[NEO4J_USER_ENV] ?? NEO4J_USER_DEFAULT,
      GRAPHRAG_MEMORY_NEO4J_PASSWORD:
        process.env[NEO4J_PASSWORD_ENV] ?? NEO4J_PASSWORD_DEFAULT,
      // The worker's own credential guard runs at process start, before any
      // stage: even a fast-only run refuses to boot without an LLM secret
      // (`buildLlmClient(..., {extraction: true})`). It is never a fake.
      ANTHROPIC_AUTH_TOKEN: LLM_TOKEN ?? "",
      GRAPHRAG_MEMORY_ANTHROPIC_BASE_URL: opts.llmBaseUrl ?? LLM_BASE_URL,
      GRAPHRAG_MEMORY_ANTHROPIC_MODEL: LLM_MODEL,
    }),
    stdio: ["ignore", "pipe", "pipe"] as const,
  });
  const pid = child.pid as number;
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const handle = {
    child,
    pid,
    // stdout is only recorded for the fatal-report cases; never a secret.
    stderr: () => `${stderr}${stdout ? `\n[stdout] ${stdout}` : ""}`,
    exited,
  };
  openWorkers.add(handle);
  child.once("close", () => openWorkers.delete(handle));
  return handle;
}

async function runWorkerToExit(
  args: string[],
  opts: { neo4jUri: string; llmBaseUrl?: string; liveInfra?: boolean }
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}> {
  const handle = startWorker(args, opts);
  const outcome = await handle.exited;
  return { ...outcome, stderr: handle.stderr() };
}

/**
 * The graph the C-ready case measures must be only this run's. Detection is
 * database-wide in Neo4j CE and the summary job keeps one connected component,
 * so a leftover node from another suite can silently shrink what is measured.
 */
async function expectNoForeignGraphNodes(): Promise<void> {
  const driver: Driver = neo4j.driver(
    process.env[NEO4J_URI_ENV] as string,
    neo4j.auth.basic(
      process.env[NEO4J_USER_ENV] as string,
      process.env[NEO4J_PASSWORD_ENV] as string
    )
  );
  try {
    const session = driver.session();
    const nodes = await session.run(
      "MATCH (n) WHERE n:Entity OR n:Community RETURN count(n) AS n"
    );
    await session.close();
    const held = Number(nodes.records[0]?.get("n").low ?? 0);
    if (held > 0) {
      throw new Error(
        `gold W1 needs a Neo4j instance holding no :Entity / :Community node;` +
          ` ${held} left over from an earlier run`
      );
    }
  } finally {
    await driver.close();
  }
}

/**
 * Refreshed count, so a just-written index is not measured as empty because
 * Elasticsearch has not opened a reader yet.
 */
async function esDocCount(index: string): Promise<number> {
  await fetch(`${ES_URL}/${index}/_refresh`, { method: "POST" });
  const body = (await fetch(`${ES_URL}/${index}/_count`).then((r) =>
    r.json()
  )) as { count?: number };
  return Number(body.count ?? 0);
}

function ms(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  // A number here is already an epoch: re-parsing it through
  // `new Date(String(n))` reads a leading 4-digit run as a year and answers
  // Invalid Date, so a numeric timestamp must be returned as-is.
  if (typeof value === "number") return Number.isNaN(value) ? null : value;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function iso(value: unknown): string | null {
  const epoch = ms(value);
  return epoch === null ? null : new Date(epoch).toISOString();
}

async function jobRow(
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
    "SELECT status, content_identity, extract_method FROM source_documents" +
      " WHERE source_ref = $1",
    [sourceRef]
  );
  return res.rows[0] as Record<string, unknown>;
}

/** The legs the extract stage sealed for this source, newest first. A job that
 * settles `failed` on a live endpoint is only diagnosable from what the
 * pipeline itself recorded. */
async function extractFailureEvidence(
  client: pg.Client,
  sourceRef: string
): Promise<string> {
  const res = await client.query(
    "SELECT error_code, error_msg FROM extraction_records r" +
      "  JOIN chunks c ON c.id = r.chunk_id" +
      " WHERE c.source_ref = $1 AND r.status = 'failed'" +
      " ORDER BY r.started_at DESC LIMIT 3",
    [sourceRef]
  );
  const rows = res.rows as Array<{
    error_code: string | null;
    error_msg: string | null;
  }>;
  if (rows.length === 0) return "no sealed extraction failure record";
  return rows
    .map((r) => `${String(r.error_code)} ${clip(String(r.error_msg ?? ""))}`)
    .join(" | ");
}

/** The codes this source's extract leg sealed, so a job's code can be
 * attributed to the leg it actually stopped in. */
async function extractLegCodes(
  client: pg.Client,
  sourceRef: string
): Promise<string[]> {
  const res = await client.query(
    "SELECT DISTINCT r.error_code FROM extraction_records r" +
      "  JOIN chunks c ON c.id = r.chunk_id" +
      " WHERE c.source_ref = $1 AND r.status = 'failed'" +
      "   AND r.error_code IS NOT NULL",
    [sourceRef]
  );
  return (res.rows as Array<{ error_code: string }>).map((r) => r.error_code);
}

/** The extract stage's own trail for one 资料: what it saw and what it wrote. */
async function extractStageEvidence(
  client: pg.Client,
  sourceRef: string
): Promise<string> {
  const chunks = await countWhere(
    client,
    "SELECT count(*)::int AS n FROM chunks WHERE source_ref = $1",
    [sourceRef]
  );
  // Orphans (`chunk_id IS NULL`) are part of the trail: a chunk row deleted
  // after its extraction stamps its record NULL by FK, so an inner join alone
  // would read "never extracted" for a chunk that was extracted and replaced.
  const res = await client.query(
    "SELECT r.status, r.error_code, r.triples_count," +
      " (r.chunk_id IS NULL) AS orphan" +
      "  FROM extraction_records r" +
      " WHERE r.chunk_id IS NULL" +
      "   OR r.chunk_id IN (SELECT id FROM chunks WHERE source_ref = $1)" +
      " ORDER BY r.started_at LIMIT 8",
    [sourceRef]
  );
  const rows = res.rows as Array<Record<string, unknown>>;
  const mine = rows.filter((r) => r.orphan === false);
  const orphans = rows.filter((r) => r.orphan === true);
  const shape = (r: Record<string, unknown>) =>
    `${String(r.status)}/${String(r.error_code ?? "-")}/t${String(r.triples_count)}`;
  return (
    `chunks=${chunks} records=[${mine.map(shape).join(" ")}]` +
    ` orphans=[${orphans.map(shape).join(" ")}]`
  );
}

async function countWhere(
  client: pg.Client,
  sql: string,
  values: unknown[]
): Promise<number> {
  const res = await client.query(sql, values);
  return Number(res.rows[0]?.n ?? 0);
}

/** One chunk as the store holds it: its derived id plus its insert timestamp,
 *  rendered in UTC so the pair is a plain comparable string. */
interface ChunkStamp {
  id: string;
  created_at: string;
}

/** The comparison key the no-re-chunk property is asserted on. */
function chunkStamp(chunk: ChunkStamp): string {
  return `${chunk.id}@${chunk.created_at}`;
}

/** The chunks one 资料 holds, ordered deterministically, each as its
 *  `(id, created_at)` pair. A worker run compared against these pairs is the
 *  job-boundary evidence for the no-re-chunk property. The id set ALONE cannot
 *  witness it: `chunks.id` is derived from the `(source_ref,
 *  content_identity)` pair, so a worker that deleted and re-inserted the same
 *  slices would reproduce the identical ids and an id-only comparison would
 *  still pass. `created_at` is stamped by the write itself, so a re-insert
 *  moves it and the pair changes. */
async function chunkStampsFor(
  client: pg.Client,
  sourceRef: string
): Promise<ChunkStamp[]> {
  const res = await client.query(
    "SELECT id::text AS id," +
      " to_char(created_at AT TIME ZONE 'UTC'," +
      ' \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS created_at' +
      " FROM chunks WHERE source_ref = $1" +
      " ORDER BY ordinal NULLS LAST, id",
    [sourceRef]
  );
  return res.rows as ChunkStamp[];
}

/** What the drain was asked to project, per subject kind and status. */
async function intentTally(client: pg.Client): Promise<string> {
  const res = await client.query(
    "SELECT subject_kind, status, count(*)::int AS n FROM projection_outbox" +
      " GROUP BY 1, 2 ORDER BY 1, 2"
  );
  return res.rows
    .map(
      (r: { subject_kind: string; status: string; n: number }) =>
        `${r.subject_kind}/${r.status}:${r.n}`
    )
    .join(" ");
}

/**
 * The ledger's own account of entity rows the graph did not answer for: both
 * tombstone flags, whether a triple names the row as an endpoint, and whether
 * an intent does.
 */
async function entityLedgerState(
  client: pg.Client,
  ids: readonly string[]
): Promise<string> {
  if (ids.length === 0) return "none";
  const res = await client.query(
    "SELECT e.id::text AS id, e.retired," +
      "       e.merged_into IS NOT NULL AS merged," +
      "       (SELECT count(*)::int FROM triples t" +
      "         WHERE t.head_id = e.id OR t.tail_id = e.id) AS triple_ends," +
      "       (SELECT count(*)::int FROM projection_outbox o" +
      "         WHERE o.subject_kind = 'entity' AND o.subject_id = e.id)" +
      "         AS intents" +
      "  FROM entities e WHERE e.id = ANY($1::uuid[]) ORDER BY 1",
    [[...ids]]
  );
  return res.rows
    .map(
      (r: {
        id: string;
        retired: boolean;
        merged: boolean;
        triple_ends: number;
        intents: number;
      }) =>
        `${r.id} retired=${r.retired} merged=${r.merged}` +
        ` tripleEnds=${r.triple_ends} intents=${r.intents}`
    )
    .join("; ");
}

/** The job's serialization lock as Postgres itself reports it. */
interface LockSample {
  holders: number[];
  waiters: number[];
}

/** The worker's own derivation, so the key it locks and the key this witness
 *  addresses cannot drift apart. */
const LOCK_KEY_ARG = advisoryLockKey(JOB_SERIALIZATION_KEY).toString();

/**
 * The witness has to address the key the way PostgreSQL stores it: `classid`
 * carries the high half of the 64-bit key and `objid` the low half, so no
 * single column identifies the lock any more than the name string does.
 * The database predicate is load-bearing for the same reason — `pg_locks`
 * reports another database's grant of an identical key too (measured on this
 * box), and counting such a holder would decide this case's serialization
 * claim by something outside this run's own store.
 */
const ADVISORY_LOCK_SQL =
  "SELECT l.pid, l.granted FROM pg_locks l" +
  " WHERE l.locktype = $1" +
  "   AND l.database = (SELECT d.oid FROM pg_database d" +
  "                      WHERE d.datname = current_database())" +
  "   AND l.classid::bigint = (($2::bigint >> 32) & 4294967295)" +
  "   AND l.objid::bigint = ($2::bigint & 4294967295)";

async function sampleLocks(client: pg.Client): Promise<LockSample> {
  const res = await client.query(ADVISORY_LOCK_SQL, ["advisory", LOCK_KEY_ARG]);
  const holders: number[] = [];
  const waiters: number[] = [];
  for (const row of res.rows as Array<{ pid: number; granted: boolean }>) {
    (row.granted ? holders : waiters).push(Number(row.pid));
  }
  return { holders, waiters };
}

async function waitUntil(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 150,
  describe?: () => Promise<string>
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      const observed = describe === undefined ? "" : ` [${await describe()}]`;
      throw new Error(
        `${label}: condition not met within ${timeoutMs}ms${observed}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** The recorded Fast switch, as `method.ts` records it after a fast chunk lands. */
async function recordFastSwitch(
  client: pg.Client,
  sourceRef: string
): Promise<void> {
  await client.query(
    "UPDATE source_documents SET extract_method = 'fast' WHERE source_ref = $1",
    [sourceRef]
  );
}

function sleep(msValue: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, msValue));
}

/**
 * A child's stderr is evidence worth keeping, and it is also the one place a
 * thrown DSN or key could reach the report — so every excerpt passes through
 * here first. The values themselves never leave the process environment.
 */
function redactSecrets(value: string): string {
  const secrets: (string | undefined)[] = [
    process.env[EMBED_KEY_ENV],
    process.env.ANTHROPIC_AUTH_TOKEN,
    process.env.ANTHROPIC_API_KEY,
    process.env[NEO4J_PASSWORD_ENV],
    SCHEMA_URL,
    pgHarness.connectionString,
  ];
  let out = value;
  for (const secret of secrets) {
    if (secret !== undefined && secret.length > 5) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out.replace(/postgres(?:ql)?:\/\/\S+/g, (url) =>
    redactPgConnectionString(url)
  );
}

/** Tail-clipped, secret-free excerpt of a child's output. */
function clip(value: string, max = 600): string {
  const clean = redactSecrets(value).trim();
  if (clean.length <= max) return clean;
  return `…${clean.slice(-max)}`;
}

/**
 * How long a case waits for the extract leg to commit its chunk. The leg ends
 * with live embedding calls, and an endpoint connect timeout costs ~10.5s each,
 * so the window has to cover several of them before it is fair to call the
 * worker stuck.
 */
const STAGE_OBSERVATION_WINDOW_MS = 180_000;

/**
 * Wait until a real worker child demonstrably sits inside the projection stage
 * of `jobId`: the ledger row is claimed (`started_at` set) AND the extract leg
 * has committed this source's `extraction_records` row — the last write before
 * `drainProjection()` opens its Neo4j connection. A row that reaches a terminal
 * status before that window opens is a measurement, not a window, so it fails
 * loudly with its own code and the child's output instead of burning the clock.
 */
async function waitIntoProjectionStage(
  client: pg.Client,
  handle: WorkerHandle,
  jobId: string,
  sourceRef: string,
  timeoutMs = STAGE_OBSERVATION_WINDOW_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await jobRow(client, jobId);
    const status = row.status;
    // `in_progress` is the only word that still means this worker owns the row.
    if (status !== undefined && status !== INDEX_JOB_STATUS.IN_PROGRESS) {
      throw new Error(
        `worker (pid ${handle.pid}) settled ${jobId} as ${String(status)}` +
          ` failure_code=${JSON.stringify(row.failure_code)}` +
          ` [${await extractFailureEvidence(client, sourceRef)}] before the` +
          ` projection stage was observable; stderr: ${clip(handle.stderr())}`
      );
    }
    if (status !== undefined && row.started_at != null) {
      const records = await countWhere(
        client,
        "SELECT count(*)::int AS n FROM extraction_records r" +
          "  JOIN chunks c ON c.id = r.chunk_id WHERE c.source_ref = $1",
        [sourceRef]
      );
      if (records > 0) return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `worker (pid ${handle.pid}) did not reach the projection stage for` +
          ` ${jobId} within ${timeoutMs}ms; last row` +
          ` ${clip(JSON.stringify(row))}; stderr: ${clip(handle.stderr())}`
      );
    }
    await sleep(150);
  }
}

describePg(
  "index-job worker gold: real PostgreSQL + real MCP + real worker process",
  () => {
    let sql: pg.Client | undefined;
    let wire: McpHandle | undefined;
    /** Neo4j subjects this run projected, removed again on teardown. */
    let projectedEntityIds: string[] = [];
    let esLayer: ElasticsearchPrecisionLayer | undefined;

    beforeAll(async () => {
      if (!EMBED_READY) {
        throw new Error(
          `${EMBED_KEY_ENV} must be present: every case pushes a real 资料 through` +
            " the real embedding endpoint. A missing embedding dependency is a blocked" +
            " gold run, not a pass."
        );
      }
      sql = pgHarness.createClient(SCHEMA_URL);
      await sql.connect();
      await pgHarness.resetSchema(sql);
      // Connecting the MCP child bootstraps the schema (buildDeps initializes
      // before the transport serves), so the ledger exists before any submit.
      wire = await connectServer("index-job-worker-gold");
      // Built here rather than in the C-ready case: teardown deletes this run's
      // three indices, and a case that never ran must not leave them behind.
      if (esProbe.available) {
        esLayer = new ElasticsearchPrecisionLayer({
          node: ES_URL,
          username: undefined,
          password: undefined,
          apiKey: undefined,
          chunkIndex: ES_CHUNK_INDEX,
          entityIndex: ES_ENTITY_INDEX,
          summaryIndex: ES_SUMMARY_INDEX,
          requestTimeoutMs: Number(ES_REQUEST_TIMEOUT_MS),
        });
      }
    }, 90_000);

    afterAll(async () => {
      for (const handle of openWorkers) {
        handle.child.kill("SIGKILL");
        await handle.exited.catch(() => {});
      }
      openWorkers.clear();
      if (projectedEntityIds.length > 0) {
        const uri = process.env[NEO4J_URI_ENV];
        const user = process.env[NEO4J_USER_ENV];
        const password = process.env[NEO4J_PASSWORD_ENV];
        if (uri !== undefined && user !== undefined && password !== undefined) {
          const driver: Driver = neo4j.driver(
            uri,
            neo4j.auth.basic(user, password)
          );
          try {
            const session = driver.session();
            await session.run(
              "UNWIND $ids AS id MATCH (e:Entity {id: id}) DETACH DELETE e",
              { ids: projectedEntityIds }
            );
            await session.close();
          } finally {
            await driver.close();
          }
        }
      }
      if (esLayer !== undefined) {
        try {
          await esLayer.deleteChunkIndex();
          await esLayer.deleteEntityIndex();
          await esLayer.deleteSummaryIndex();
        } finally {
          await esLayer.close();
        }
      }
      await wire?.close();
      if (sql) {
        await pgHarness.dropSchema(sql);
        await sql.end();
      }
    }, 120_000);

    // A case whose extract stage must produce graph facts needs an answering
    // LLM: the judge gate dials for every non-empty proposal, so with no route
    // the job seals `failed` before the projection stage and the case would
    // measure nothing. That is a blocked dependency, so the case loud-skips and
    // the run prints the Validation block instead.
    const itJudged = JUDGE_READY ? it : it.skip;

    // -------------------------------------------------------------------------
    // W3 — stage failure through the RECORDED Fast switch.
    // -------------------------------------------------------------------------
    it("W3 stage failure: the recorded fast switch publishes FAST_EMPTY_GRAPH verbatim and leaves C not-ready", async () => {
      const identity = computeContentIdentity(W3_BODY);
      const pushed = await pushDocument(wire!.client, W3_SRC, W3_BODY);
      expect(pushed.body.content_identity).toBe(identity);
      await recordFastSwitch(sql!, W3_SRC);
      expect((await sourceRow(sql!, W3_SRC)).extract_method).toBe("fast");

      const submitted = await callTool(wire!.client, "submit_index_job", {
        source_ref: W3_SRC,
        content_identity: identity,
      });
      expect(submitted.isError).toBe(false);
      const jobId = String(submitted.body.job_id);
      expect(jobId).toBe(computeChunkId(W3_SRC, identity));

      // Pin 档 C to a positive non-ready fact first, so "C stayed not ready"
      // below can never be satisfied by a row that was simply missing.
      await sql!.query(
        "INSERT INTO community_index_state (id, status, failure_code) VALUES (1," +
          " 'in_progress', NULL) ON CONFLICT (id) DO UPDATE SET status =" +
          " 'in_progress', failure_code = NULL"
      );

      // The worker's LLM endpoint is unreachable and its Neo4j refuses: a
      // standard leg could only ever report a network or projection code here,
      // so `FAST_EMPTY_GRAPH` is proof the runner read the recorded switch.
      const run = await runWorkerToExit(["--once"], {
        neo4jUri: REFUSED_NEO4J_URI,
        llmBaseUrl: UNREACHABLE_LLM_BASE_URL,
      });
      // A typed stage failure is a SETTLED job, so the worker exits 0; only an
      // unpublished outcome exits 1.
      expect(run.code).toBe(0);
      const row = await jobRow(sql!, jobId);
      expect(row.status).toBe(INDEX_JOB_STATUS.FAILED);
      expect(row.failure_code).toBe(FAST_EMPTY_GRAPH_CODE);
      expect(row.started_at).not.toBeNull();
      expect(row.finished_at).not.toBeNull();

      // Persisted pipeline evidence, read back independently of the ledger.
      const failedRecords = await countWhere(
        sql!,
        "SELECT count(*)::int AS n FROM extraction_records r" +
          "  JOIN chunks c ON c.id = r.chunk_id" +
          " WHERE c.source_ref = $1 AND r.status = 'failed'" +
          "   AND r.error_code = $2",
        [W3_SRC, FAST_EMPTY_GRAPH_CODE]
      );
      expect(failedRecords).toBeGreaterThanOrEqual(1);
      expect(
        await countWhere(
          sql!,
          "SELECT count(*)::int AS n FROM entities WHERE retired = false",
          []
        )
      ).toBe(0);
      expect(
        await countWhere(
          sql!,
          "SELECT count(*)::int AS n FROM projection_outbox",
          []
        )
      ).toBe(0);

      // C readiness is read through the poll wire, not only via SQL.
      const fresh = await connectServer("index-job-worker-gold-w3-poll");
      try {
        const polled = await callTool(fresh.client, "poll_index_job", {
          job_id: jobId,
        });
        expect(polled.isError).toBe(false);
        expect(polled.body.status).toBe("failed");
        expect(polled.body.failure_code).toBe(FAST_EMPTY_GRAPH_CODE);
        // The pinned marker is exactly what a FRESH MCP process still reports:
        // the failed stage left C where it found it, and never ready.
        expect(polled.body.community_index_state).toEqual({
          status: "in_progress",
          failure_code: null,
        });
        record.w3 = {
          source_ref: W3_SRC,
          content_identity: identity,
          job_id: jobId,
          worker_exit: run.code,
          job_status: row.status,
          failure_code: row.failure_code,
          started_at: iso(row.started_at),
          finished_at: iso(row.finished_at),
          fast_failed_records: failedRecords,
          community_index_state: polled.body.community_index_state,
          worker_stderr_tail: run.stderr.slice(-300),
        };
      } finally {
        await fresh.close();
      }
    }, 180_000);

    // -------------------------------------------------------------------------
    // W4 — identity drift: the queued version is stale, and no stage ran.
    // -------------------------------------------------------------------------
    it("W4 identity drift: a superseded content version publishes stale with no stage and no failure code", async () => {
      const identityA = computeContentIdentity(W4_BODY_A);
      const identityB = computeContentIdentity(W4_BODY_B);
      const pushedA = await pushDocument(wire!.client, W4_SRC, W4_BODY_A);
      expect(pushedA.body.content_identity).toBe(identityA);
      const submitted = await callTool(wire!.client, "submit_index_job", {
        source_ref: W4_SRC,
        content_identity: identityA,
      });
      const jobId = String(submitted.body.job_id);
      expect(jobId).toBe(computeChunkId(W4_SRC, identityA));
      expect(submitted.body.status).toBe("in_progress");
      expect(submitted.body.started_at).toBeNull();

      // A second push of the same source_ref is a new content version: the
      // queued job now names text that is no longer current.
      const pushedB = await pushDocument(wire!.client, W4_SRC, W4_BODY_B);
      expect(pushedB.body.content_identity).toBe(identityB);
      const srcAfterB = await sourceRow(sql!, W4_SRC);
      expect(srcAfterB.content_identity).toBe(identityB);
      expect(srcAfterB.status).toBe("ready");

      // A corpus-C marker: the runner must not move it, because no stage ran.
      await sql!.query(
        "INSERT INTO community_index_state (id, status, failure_code) VALUES (1," +
          " 'in_progress', NULL) ON CONFLICT (id) DO UPDATE SET status =" +
          " 'in_progress', failure_code = NULL"
      );

      const run = await runWorkerToExit(["--once"], {
        neo4jUri: REFUSED_NEO4J_URI,
        llmBaseUrl: UNREACHABLE_LLM_BASE_URL,
      });
      const row = await jobRow(sql!, jobId);
      expect(row.status).toBe(INDEX_JOB_STATUS.STALE);
      expect(row.failure_code).toBeNull();
      expect(row.content_identity).toBe(identityA);
      expect(row.started_at).not.toBeNull();
      expect(row.finished_at).not.toBeNull();

      // No stage ran: the extract leg writes an extraction_records row per
      // chunk it touches, the projection writes intents. Neither exists.
      expect(
        await countWhere(
          sql!,
          "SELECT count(*)::int AS n FROM extraction_records r" +
            "  JOIN chunks c ON c.id = r.chunk_id WHERE c.source_ref = $1",
          [W4_SRC]
        )
      ).toBe(0);
      expect(
        await countWhere(
          sql!,
          "SELECT count(*)::int AS n FROM projection_outbox",
          []
        )
      ).toBe(0);

      // Per-source TEXT readiness is a separate fact and stayed `ready`.
      const srcAfterRun = await sourceRow(sql!, W4_SRC);
      expect(srcAfterRun.status).toBe("ready");
      const community = (
        await sql!.query(
          "SELECT status, failure_code FROM community_index_state WHERE id = 1"
        )
      ).rows[0];
      expect(community).toEqual({ status: "in_progress", failure_code: null });

      const fresh = await connectServer("index-job-worker-gold-w4-poll");
      try {
        const polled = await callTool(fresh.client, "poll_index_job", {
          job_id: jobId,
        });
        expect(polled.body.status).toBe("stale");
        expect(polled.body.failure_code).toBeNull();
        expect(polled.body.community_index_state).toEqual({
          status: "in_progress",
          failure_code: null,
        });
        // And the new text version is retrievable while its job is stale:
        // push readiness never waits for the graph.
        const found = await callTool(fresh.client, "retrieve", {
          query: W4_BODY_B,
          limit: 5,
        });
        const hits = (found.body.chunks ?? []) as Array<{
          source_ref: string;
        }>;
        expect(hits.map((h) => h.source_ref)).toContain(W4_SRC);
        record.w4 = {
          source_ref: W4_SRC,
          content_identity_queued: identityA,
          content_identity_current: identityB,
          job_id: jobId,
          worker_exit: run.code,
          job_status: row.status,
          failure_code: row.failure_code,
          started_at: iso(row.started_at),
          finished_at: iso(row.finished_at),
          source_documents_status: srcAfterRun.status,
          community_index_state: polled.body.community_index_state,
          retrieve_returned_source_ref: hits.map((h) => h.source_ref),
        };
      } finally {
        await fresh.close();
      }
    }, 180_000);

    // -------------------------------------------------------------------------
    // W2 — worker restart: a killed worker's running job is reclaimed and settles.
    // -------------------------------------------------------------------------
    itJudged(
      "W2 worker restart: kill -9 inside the drain, the row stays in_progress, a second worker re-claims the same job and settles it",
      async () => {
        const identity = computeContentIdentity(W2_BODY);
        await pushDocument(wire!.client, W2_SRC, W2_BODY);
        // The Fast switch is recorded so the extract leg needs no model: this
        // case is about the durable request, and W3 already owns the fast leg.
        await recordFastSwitch(sql!, W2_SRC);

        const submitted = await callTool(wire!.client, "submit_index_job", {
          source_ref: W2_SRC,
          content_identity: identity,
        });
        const jobId = String(submitted.body.job_id);
        const before = await jobRow(sql!, jobId);
        expect(before.started_at).toBeNull();

        // Worker A: real process, blocked inside the projection stage.
        const workerA = startWorker(["--once"], {
          neo4jUri: BLACK_HOLE_NEO4J_URI,
        });
        try {
          // The kill must land inside the hanging drain, so wait for the last
          // write before it (the extract leg's record row), not just the claim.
          await waitIntoProjectionStage(sql!, workerA, jobId, W2_SRC);
          // Inside the stage: durable, running, and NOT settled early.
          const observed: string[] = [];
          for (let i = 0; i < 8; i += 1) {
            const row = await jobRow(sql!, jobId);
            observed.push(String(row.status));
            await new Promise((resolve) => setTimeout(resolve, 120));
          }
          expect(observed).toContain(INDEX_JOB_STATUS.IN_PROGRESS);
          expect(observed).not.toContain(INDEX_JOB_STATUS.READY);
          const running = await jobRow(sql!, jobId);
          const startedAtA = ms(running.started_at);
          expect(running.status).toBe(INDEX_JOB_STATUS.IN_PROGRESS);
          expect(running.finished_at).toBeNull();
          expect(running.failure_code).toBeNull();

          workerA.child.kill("SIGKILL");
          const killed = await workerA.exited;
          expect(killed.signal).toBe("SIGKILL");

          // The durable request survived the crash: same row, still running,
          // no terminal state written by a process that died mid-stage.
          const afterKill = await jobRow(sql!, jobId);
          expect(afterKill.status).toBe(INDEX_JOB_STATUS.IN_PROGRESS);
          expect(ms(afterKill.started_at)).toBe(startedAtA);
          expect(afterKill.finished_at).toBeNull();

          // Worker B: a different process, lease window open, so the stalled row
          // is claimable again and this job finally settles.
          const workerB = await runWorkerToExit(
            ["--once", "--stalled-after", "1"],
            { neo4jUri: REFUSED_NEO4J_URI }
          );
          const settled = await jobRow(sql!, jobId);
          expect(settled.status).toBe(INDEX_JOB_STATUS.FAILED);
          // The refused port is a connect failure, which the drain names with
          // its own typed code rather than the generic drain failure one.
          expect(settled.failure_code).toBe("NEO4J_UNAVAILABLE");
          expect(ms(settled.created_at)).toBe(ms(before.created_at));
          expect(ms(settled.started_at)).toBeGreaterThan(startedAtA as number);
          expect(settled.finished_at).not.toBeNull();

          const fresh = await connectServer("index-job-worker-gold-w2-poll");
          try {
            const polled = await callTool(fresh.client, "poll_index_job", {
              job_id: jobId,
            });
            expect(polled.body.status).toBe("failed");
            expect(polled.body.failure_code).toBe(settled.failure_code);
            const community = polled.body.community_index_state as {
              status: string;
            } | null;
            expect(community).not.toBeNull();
            expect(community!.status).not.toBe("ready");
            record.w2 = {
              source_ref: W2_SRC,
              content_identity: identity,
              job_id: jobId,
              worker_a_pid: workerA.pid,
              worker_a_killed_by: "SIGKILL",
              observed_statuses_before_kill: observed,
              started_at_worker_a: iso(afterKill.started_at),
              row_after_kill: {
                status: afterKill.status,
                finished_at: afterKill.finished_at,
                failure_code: afterKill.failure_code,
              },
              worker_b_exit: workerB.code,
              terminal: {
                status: settled.status,
                failure_code: settled.failure_code,
                created_at: iso(settled.created_at),
                started_at: iso(settled.started_at),
                finished_at: iso(settled.finished_at),
              },
              community_index_state: community ?? null,
              worker_b_stderr: workerB.stderr.slice(-400),
            };
          } finally {
            await fresh.close();
          }
        } finally {
          // Only when the kill above somehow didn't happen: a closed child is
          // already out of the registry.
          if (openWorkers.has(workerA)) {
            workerA.child.kill("SIGKILL");
            await workerA.exited.catch(() => {});
          }
        }
      },
      420_000
    );

    // -------------------------------------------------------------------------
    // W5 — one active job per source, while a worker really holds the job.
    // -------------------------------------------------------------------------
    itJudged(
      "W5 one-active-per-source: a second content version is refused with active_job_id while a worker holds the job running",
      async () => {
        const identityA = computeContentIdentity(W5_BODY_A);
        const identityB = computeContentIdentity(W5_BODY_B);
        await pushDocument(wire!.client, W5_SRC, W5_BODY_A);
        await recordFastSwitch(sql!, W5_SRC);
        const submitted = await callTool(wire!.client, "submit_index_job", {
          source_ref: W5_SRC,
          content_identity: identityA,
        });
        const jobId = String(submitted.body.job_id);

        const worker = startWorker(["--once"], {
          neo4jUri: BLACK_HOLE_NEO4J_URI,
        });
        try {
          await waitIntoProjectionStage(sql!, worker, jobId, W5_SRC);
          const running = await jobRow(sql!, jobId);
          // Queued-vs-running is `started_at`, never a fifth word, so this is
          // the arm the refusal below has to name: a live, claimed row.
          expect(running.status).toBe(INDEX_JOB_STATUS.IN_PROGRESS);
          expect(running.started_at).not.toBeNull();
          expect(running.finished_at).toBeNull();

          // A new content version pushed and submitted while that job is running.
          const pushedB = await pushDocument(wire!.client, W5_SRC, W5_BODY_B);
          expect(pushedB.body.content_identity).toBe(identityB);
          const sourceAfterPush = await sourceRow(sql!, W5_SRC);
          expect(sourceAfterPush.status).toBe("ready");
          const conflict = await callTool(wire!.client, "submit_index_job", {
            source_ref: W5_SRC,
            content_identity: identityB,
          });
          expect(conflict.isError).toBe(true);
          expect(conflict.body.error).toBe("index_job_in_progress");
          expect(conflict.body.active_job_id).toBe(jobId);

          // The readiness facts the ledger keeps separate, read beside the
          // refusal: corpus-level C must not have turned ready because a
          // source's job started, and the newly pushed text version must stay
          // retrievable while that job is held open by a worker that dies.
          const polled = await callTool(wire!.client, "poll_index_job", {
            job_id: jobId,
          });
          expect(polled.isError).toBe(false);
          // The same live row the refusal named, as the wire answers it: the
          // ledger and the poll cannot drift onto different words.
          expect(polled.body.status).toBe("in_progress");
          expect(polled.body.started_at).not.toBeNull();
          expect((await jobRow(sql!, jobId)).status).toBe(
            INDEX_JOB_STATUS.IN_PROGRESS
          );
          // A running job never writes `source_documents.status`: the text
          // version stays exactly what its own push left it, so per-source text
          // readiness and the job's state remain two answers.
          const sourceWhileRunning = await sourceRow(sql!, W5_SRC);
          expect(sourceWhileRunning.status).toBe("ready");
          expect(sourceWhileRunning.status).toBe(sourceAfterPush.status);
          const community = polled.body.community_index_state as {
            status: string;
          } | null;
          expect(community).not.toBeNull();
          expect(community!.status).not.toBe("ready");
          const found = await callTool(wire!.client, "retrieve", {
            query: W5_BODY_B,
            limit: 10,
          });
          const hits = (found.body.chunks ?? []) as Array<{
            source_ref: string;
          }>;
          expect(
            hits.map((h) => h.source_ref),
            `${W5_SRC}: a second content version stopped being retrievable` +
              ` while the first version's job was still running;` +
              ` poll answered ${JSON.stringify(polled.body)}`
          ).toContain(W5_SRC);

          record.w5 = {
            source_ref: W5_SRC,
            content_identity_active: identityA,
            content_identity_second: identityB,
            active_job_id: jobId,
            worker_pid: worker.pid,
            started_at: iso(running.started_at),
            status_at_conflict: running.status,
            conflict_body: conflict.body,
            poll_status: polled.body.status,
            community_index_state: community,
            source_documents_status: sourceWhileRunning.status,
            retrieve_returned_source_ref: hits.map((h) => h.source_ref),
          };
        } finally {
          worker.child.kill("SIGKILL");
          await worker.exited.catch(() => {});
        }
      },
      420_000
    );

    // -------------------------------------------------------------------------
    // W6 — serialization: two real worker processes, one job lock.
    // -------------------------------------------------------------------------
    itJudged(
      "W6 serialization: two concurrent workers never hold the job lock together, and the second job's stages start only after the first published",
      async () => {
        const identity1 = computeContentIdentity(W6_BODY_1);
        const identity2 = computeContentIdentity(W6_BODY_2);
        await pushDocument(wire!.client, W6_SRC_1, W6_BODY_1);
        await pushDocument(wire!.client, W6_SRC_2, W6_BODY_2);
        await recordFastSwitch(sql!, W6_SRC_1);
        await recordFastSwitch(sql!, W6_SRC_2);
        const job1 = computeChunkId(W6_SRC_1, identity1);
        const job2 = computeChunkId(W6_SRC_2, identity2);
        for (const [sourceRef, contentIdentity] of [
          [W6_SRC_1, identity1],
          [W6_SRC_2, identity2],
        ] as const) {
          const submitted = await callTool(wire!.client, "submit_index_job", {
            source_ref: sourceRef,
            content_identity: contentIdentity,
          });
          expect(submitted.isError).toBe(false);
        }

        // Contention here is scheduled, not raced: the test takes the worker's OWN
        // serialization lock on its own connection, so both workers demonstrably
        // claim a job and then queue behind a holder they cannot dislodge.
        // pg_locks is the witness for both the wait and the handoff.
        const sampler = pgHarness.createClient(SCHEMA_URL);
        await sampler.connect();
        const holder = pgHarness.createClient(SCHEMA_URL);
        await holder.connect();
        const holderBackend = Number(
          (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid
        );
        await holder.query(LOCK_ACQUIRE_SQL, [LOCK_KEY_ARG]);
        const samples: Array<{
          at: string;
          holders: number[];
          waiters: number[];
        }> = [];
        let sampling = true;
        const sampleLoop = (async () => {
          while (sampling) {
            const { holders, waiters } = await sampleLocks(sampler);
            if (holders.length > 0 || waiters.length > 0) {
              samples.push({
                at: new Date().toISOString(),
                holders,
                waiters,
              });
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        })();

        const workerA = startWorker(["--once"], {
          neo4jUri: BLACK_HOLE_NEO4J_URI,
        });
        const workerB = startWorker(["--once"], {
          neo4jUri: BLACK_HOLE_NEO4J_URI,
        });
        let exitA: { code: number | null; signal: NodeJS.Signals | null };
        let exitB: { code: number | null; signal: NodeJS.Signals | null };
        /** Carried out of the teardown: every count below is derived from the
         *  loop's own samples, so its fault must be named before them. */
        let samplerFault: unknown;
        try {
          await waitUntil(
            "both workers queued behind the held job lock",
            async () => (await sampleLocks(sampler)).waiters.length === 2,
            60_000,
            100
          );
          // The claim precedes the lock, so both rows are running and started
          // while their stages are still held off by another backend — and
          // neither is settled, which is the durable-request half of the claim.
          for (const jobId of [job1, job2]) {
            const claimed = await jobRow(sql!, jobId);
            expect(claimed.status, jobId).toBe(INDEX_JOB_STATUS.IN_PROGRESS);
            expect(claimed.started_at, jobId).not.toBeNull();
            expect(claimed.finished_at, jobId).toBeNull();
          }
          await holder.query(LOCK_RELEASE_SQL, [LOCK_KEY_ARG]);
          [exitA, exitB] = await Promise.all([workerA.exited, workerB.exited]);
        } finally {
          sampling = false;
          samplerFault = await sampleLoop.then(
            () => undefined,
            (err: unknown) => err
          );
          await holder.end();
          await sampler.end();
        }
        // Asserted before the sample-derived counts: a rejected sampler leaves
        // `samples` short, and that must read as the connection fault it was
        // instead of as a holder-count that failed to serialize.
        expect(
          samplerFault,
          `the pg_locks sampler loop rejected: ${
            samplerFault instanceof Error
              ? samplerFault.message
              : String(samplerFault)
          }`
        ).toBeUndefined();
        // Both workers ran a job to a published terminal outcome, so neither is
        // an "unsettled" exit 1 and neither needed killing.
        expect(exitA.signal).toBeNull();
        expect(exitB.signal).toBeNull();
        expect([exitA.code, exitB.code]).toEqual([0, 0]);
        const maxHolders = samples.reduce(
          (max, sample) => Math.max(max, sample.holders.length),
          0
        );
        const workerHolderBackends = new Set(
          samples
            .flatMap((s) => s.holders)
            .filter((pid) => pid !== holderBackend)
        );
        const blockedSamples = samples.filter(
          (s) => s.holders.length === 1 && s.waiters.length >= 1
        );
        // The test takes the lock before either worker starts, so the first
        // grant it sampled should be its own backend. That is a claim about
        // the samples, so the samples decide it: recorded as measured instead
        // of asserted, since a poll can only ever report what it happened to
        // see. `first_granted_sample` below is what makes a false reading
        // diagnosable without re-running the case.
        const firstGrantedSample = samples.find((s) => s.holders.length > 0);
        const heldByTestBackendFirst =
          firstGrantedSample !== undefined &&
          firstGrantedSample.holders.length === 1 &&
          firstGrantedSample.holders[0] === holderBackend;
        const row1 = await jobRow(sql!, job1);
        const row2 = await jobRow(sql!, job2);
        // Every sampled grant, with the row each holder settled: the lock
        // witness is a poll of a live catalog view, so the report has to say
        // what the jobs actually cost, not just what the poll happened to see.
        const holderCounts = new Map<number, number>();
        for (const pid of samples.flatMap((s) => s.holders)) {
          holderCounts.set(pid, (holderCounts.get(pid) ?? 0) + 1);
        }
        const lockLog =
          `samples=${samples.length} granted=${maxHolders} workerHolders=${workerHolderBackends.size}` +
          ` contended=${blockedSamples.length}` +
          ` holderCounts=${JSON.stringify([...holderCounts])}` +
          ` firstGranted=${JSON.stringify(firstGrantedSample ?? null)}` +
          ` testBackend=${holderBackend}` +
          ` rows=${JSON.stringify([row1, row2])}`;
        expect(maxHolders, lockLog).toBe(1);
        expect(workerHolderBackends.size, lockLog).toBe(2);
        expect(blockedSamples.length, lockLog).toBeGreaterThan(0);

        expect(row1.status).toBe(INDEX_JOB_STATUS.FAILED);
        expect(row2.status).toBe(INDEX_JOB_STATUS.FAILED);
        // Measured leg-attributable: the code must name the leg the job
        // actually stopped in. The black-hole port decides the drain arm, but a
        // refused LLM or embedding endpoint fails the extract leg first, and
        // then the job honestly carries that leg's own code.
        for (const [ref, row] of [
          [W6_SRC_1, row1],
          [W6_SRC_2, row2],
        ] as const) {
          const legCodes = await extractLegCodes(sql!, ref);
          if (legCodes.length > 0) {
            expect(
              legCodes,
              `${ref}: the job must carry the extract leg's own code`
            ).toContain(String(row.failure_code));
          } else {
            expect(
              row.failure_code,
              `${ref}: a clean extract leg must stop in the unreachable drain`
            ).toBe("NEO4J_UNAVAILABLE");
          }
        }
        // Without this the case could pass with both jobs dead in the extract
        // leg, before the lock's subject stage ever ran.
        expect([row1.failure_code, row2.failure_code], lockLog).toContain(
          "NEO4J_UNAVAILABLE"
        );

        // Persisted ordering: the job that settled second did its extract leg
        // AFTER the first one published its outcome — the stages did not interleave.
        const first =
          ms(row1.finished_at)! <= ms(row2.finished_at)! ? row1 : row2;
        const second = first === row1 ? row2 : row1;
        const secondExtractAt = await firstExtractWrittenAt(
          sql!,
          String(second.source_ref)
        );
        expect(secondExtractAt).not.toBeNull();
        expect(secondExtractAt!).toBeGreaterThan(ms(first.finished_at)!);

        // Corpus-level C and per-source text readiness beside the job rows:
        // serialization must not have to merge them (decision 3 item 5), and
        // both jobs failing in the drain is exactly the state where C stays
        // not-ready while the text of both sources is still answerable.
        const readiness: Array<Record<string, unknown>> = [];
        for (const [jobId, sourceRef, body] of [
          [job1, W6_SRC_1, W6_BODY_1],
          [job2, W6_SRC_2, W6_BODY_2],
        ] as const) {
          const polled = await callTool(wire!.client, "poll_index_job", {
            job_id: jobId,
          });
          expect(polled.isError).toBe(false);
          expect(polled.body.status, jobId).toBe("failed");
          const community = polled.body.community_index_state as {
            status: string;
          } | null;
          expect(community, jobId).not.toBeNull();
          expect(community!.status, jobId).not.toBe("ready");
          const found = await callTool(wire!.client, "retrieve", {
            query: body,
            limit: 10,
          });
          const hits = (found.body.chunks ?? []) as Array<{
            source_ref: string;
          }>;
          expect(
            hits.map((h) => h.source_ref),
            `${sourceRef}: a serialized job that failed must leave its text` +
              ` retrievable; poll answered ${JSON.stringify(polled.body)}`
          ).toContain(sourceRef);
          readiness.push({
            job_id: jobId,
            source_ref: sourceRef,
            poll_status: polled.body.status,
            community_index_state: community,
            source_documents_status: (await sourceRow(sql!, sourceRef)).status,
            retrieve_returned_source_ref: hits.map((h) => h.source_ref),
          });
        }

        record.w6 = {
          workers: [workerA.pid, workerB.pid],
          jobs: [
            {
              job_id: job1,
              source_ref: W6_SRC_1,
              content_identity: identity1,
              started_at: iso(row1.started_at),
              finished_at: iso(row1.finished_at),
              failure_code: row1.failure_code,
            },
            {
              job_id: job2,
              source_ref: W6_SRC_2,
              content_identity: identity2,
              started_at: iso(row2.started_at),
              finished_at: iso(row2.finished_at),
              failure_code: row2.failure_code,
            },
          ],
          lock_samples_taken: samples.length,
          max_concurrent_granted_holders: maxHolders,
          distinct_worker_holder_backends: [...workerHolderBackends],
          lock_held_by_the_test_backend_first: heldByTestBackendFirst,
          first_granted_sample: firstGrantedSample ?? null,
          test_holder_backend: holderBackend,
          samples_with_a_blocked_waiter: blockedSamples.length,
          first_to_finish: {
            job_id: first.job_id,
            finished_at: iso(first.finished_at),
          },
          second_job_extract_record_written_at: iso(secondExtractAt),
          readiness,
        };
      },
      300_000
    );

    // -------------------------------------------------------------------------
    // W1 — the headline: C-ready end to end through every real boundary.
    // -------------------------------------------------------------------------
    const itW1 = W1_READY ? it : it.skip;
    itW1(
      "W1 C-ready end to end: real MCP push + submit, real worker process, real Neo4j/GDS + ES + LLM, poll from a fresh MCP process",
      async () => {
        const identity = computeContentIdentity(W1_BODY);
        // Preflight: the summary stage detects on the whole database and keeps
        // only its largest connected component, so a shared instance holding
        // foreign nodes could drop this fixture's component and still answer a
        // complete empty generation — a green run that measured nothing.
        await expectNoForeignGraphNodes();
        // Push and submit through a live-wired MCP process (ES on: the chunk is
        // double-written into this run's own index).
        const live = await connectServer("index-job-worker-gold-w1-wire", true);
        let jobId = "";
        let chunksBeforeRun: ChunkStamp[] = [];
        try {
          const pushed = await pushDocument(live.client, W1_SRC, W1_BODY);
          expect(pushed.body.content_identity).toBe(identity);
          // Measured at its own boundary before it is leaned on: `push` mirrors
          // the chunk into ES best-effort, so a dropped mirror stays a successful
          // push and surfaces only as the server's own line.
          const mirrored = await esDocCount(ES_CHUNK_INDEX);
          expect(
            mirrored,
            `push did not mirror ${W1_SRC} into ${ES_CHUNK_INDEX}; ` +
              `server said: ${serverFault(live)}`
          ).toBeGreaterThanOrEqual(1);
          const submitted = await callTool(live.client, "submit_index_job", {
            source_ref: W1_SRC,
            content_identity: identity,
          });
          jobId = String(submitted.body.job_id);
          expect(submitted.body.status).toBe("in_progress");
          expect(submitted.body.started_at).toBeNull();

          // The chunks the push wrote, captured before the worker runs, are the
          // pairs the finished job is compared against below (the spec's
          // "re-chunks nothing" at the job's own boundary, not inherited from
          // the splitter's suites). Pinned non-empty first so that comparison
          // cannot pass vacuously on two empty sets.
          chunksBeforeRun = await chunkStampsFor(sql!, W1_SRC);
          expect(
            chunksBeforeRun.length,
            `push wrote no chunk row for ${W1_SRC} before the worker ran`
          ).toBeGreaterThan(0);

          // Text is searchable while the graph job is only queued.
          const early = await callTool(live.client, "retrieve", {
            query: W1_QUERY,
            limit: 5,
          });
          const earlyHits = (early.body.chunks ?? []) as Array<{
            source_ref: string;
          }>;
          expect(
            earlyHits.map((h) => h.source_ref),
            `retrieve answered ${JSON.stringify(early.body).slice(0, 400)}` +
              ` for ${W1_SRC} with ${mirrored} chunk doc(s) in` +
              ` ${ES_CHUNK_INDEX}; server said: ${serverFault(live)}`
          ).toContain(W1_SRC);
        } finally {
          await live.close();
        }

        // The transition log, sampled from OUTSIDE the worker process.
        const transitions: Array<{
          at: string;
          job: string;
          started: string | null;
          community: string | null;
        }> = [];
        let workerExited = false;
        const watch = (async () => {
          const client = pgHarness.createClient(SCHEMA_URL);
          await client.connect();
          // Safety net only: the real stop condition is "worker gone AND this
          // separate connection has read the terminal row".
          const deadline = Date.now() + 540_000;
          try {
            for (;;) {
              const job = await jobRow(client, jobId);
              const state = (
                await client.query(
                  "SELECT status, failure_code FROM community_index_state" +
                    " WHERE id = 1"
                )
              ).rows[0];
              if (job.status === undefined) break;
              transitions.push({
                at: new Date().toISOString(),
                job: String(job.status),
                started: ms(job.started_at) === null ? null : "running",
                community: state === undefined ? null : String(state.status),
              });
              const terminal = job.status !== INDEX_JOB_STATUS.IN_PROGRESS;
              if ((workerExited && terminal) || Date.now() > deadline) break;
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
          } finally {
            await client.end();
          }
        })();

        const run = await runWorkerToExit(["--once"], {
          neo4jUri: process.env[NEO4J_URI_ENV] ?? "",
          liveInfra: true,
        });
        workerExited = true;
        await watch;

        const row = await jobRow(sql!, jobId);
        expect(
          row.status,
          `failure_code=${String(row.failure_code)}` +
            ` [${await extractFailureEvidence(sql!, W1_SRC)}]` +
            ` transitions=${JSON.stringify(transitions)}` +
            ` stderr: ${clip(run.stderr)}`
        ).toBe(INDEX_JOB_STATUS.READY);
        expect(row.failure_code).toBeNull();
        expect(row.started_at).not.toBeNull();
        expect(row.finished_at).not.toBeNull();
        expect(run.code).toBe(0);

        // The worker re-chunked nothing: every chunk row the push wrote is
        // still there with the same `(id, created_at)` pair, so a worker that
        // deleted and re-inserted the same derived slices is witnessed even
        // though it reproduces the identical id set. If it drifts, the
        // diagnostic names the added/dropped ids and both stamp lists.
        const chunksAfterRun = await chunkStampsFor(sql!, W1_SRC);
        const stampsBefore = chunksBeforeRun.map(chunkStamp);
        const stampsAfter = chunksAfterRun.map(chunkStamp);
        expect(
          stampsAfter,
          `the worker re-chunked ${W1_SRC}:` +
            ` before(${stampsBefore.length})=[${stampsBefore.join(",")}]` +
            ` after(${stampsAfter.length})=[${stampsAfter.join(",")}]` +
            ` added=[${chunksAfterRun
              .filter((c) => !chunksBeforeRun.some((b) => b.id === c.id))
              .map(chunkStamp)
              .join(",")}]` +
            ` dropped=[${chunksBeforeRun
              .filter((b) => !chunksAfterRun.some((c) => c.id === b.id))
              .map(chunkStamp)
              .join(",")}]`
        ).toEqual(stampsBefore);

        // Graph rows really persisted in Postgres, and the outbox is drained.
        const entities = await countWhere(
          sql!,
          "SELECT count(*)::int AS n FROM entities WHERE retired = false",
          []
        );
        const triples = await countWhere(
          sql!,
          "SELECT count(*)::int AS n FROM triples",
          []
        );
        const graphEvidence = `extract: ${await extractStageEvidence(
          sql!,
          W1_SRC
        )} worker: ${clip(run.stderr)}`;
        expect(entities, graphEvidence).toBeGreaterThan(0);
        expect(triples, graphEvidence).toBeGreaterThan(0);
        const succeeded = await countWhere(
          sql!,
          "SELECT count(*)::int AS n FROM extraction_records r" +
            "  JOIN chunks c ON c.id = r.chunk_id" +
            " WHERE c.source_ref = $1 AND r.status = 'succeeded'",
          [W1_SRC]
        );
        expect(succeeded).toBeGreaterThan(0);
        expect(
          await countWhere(
            sql!,
            "SELECT count(*)::int AS n FROM projection_outbox WHERE status <> 'done'",
            []
          )
        ).toBe(0);

        // The projection landed in Neo4j, judged by the read-side convention the
        // product uses everywhere: `retired = false` AND `merged_into IS NULL`.
        // Whether the projection predicate should be that or only
        // `retired = false` is not reconciled yet, so the merged-away side is
        // measured into the record below and asserted on nothing: the run keeps
        // the fact instead of freezing either answer.
        const entityRows = (
          await sql!.query(
            "SELECT id::text AS id, merged_into IS NOT NULL AS merged" +
              " FROM entities WHERE retired = false"
          )
        ).rows as { id: string; merged: boolean }[];
        projectedEntityIds = entityRows.map((r) => r.id);
        const survivors = entityRows.filter((r) => !r.merged).map((r) => r.id);
        const mergedLosers = entityRows.length - survivors.length;
        const mergedAwayIds = (
          await sql!.query(
            "SELECT id::text AS id FROM entities WHERE merged_into IS NOT NULL"
          )
        ).rows.map((r: { id: string }) => r.id);
        const drainedIntents = await intentTally(sql!);
        const driver = neo4j.driver(
          process.env[NEO4J_URI_ENV] as string,
          neo4j.auth.basic(
            process.env[NEO4J_USER_ENV] as string,
            process.env[NEO4J_PASSWORD_ENV] as string
          )
        );
        let matchedNodeIds: string[] = [];
        let graphEdges = 0;
        let mergedAwayNodes = 0;
        try {
          const session = driver.session();
          const nodes = await session.run(
            "UNWIND $ids AS id MATCH (e:Entity {id: id}) RETURN collect(e.id) AS ids",
            { ids: survivors }
          );
          matchedNodeIds = (nodes.records[0]?.get("ids") ?? []) as string[];
          const mergedNodes = await session.run(
            "UNWIND $ids AS id MATCH (e:Entity {id: id}) RETURN collect(e.id) AS ids",
            { ids: mergedAwayIds }
          );
          mergedAwayNodes = (
            (mergedNodes.records[0]?.get("ids") ?? []) as string[]
          ).length;
          const edges = await session.run(
            "MATCH (a:Entity)-[r:RELATION]->(b:Entity)" +
              " WHERE a.id IN $ids OR b.id IN $ids RETURN count(r) AS n",
            { ids: survivors }
          );
          graphEdges = Number(edges.records[0]?.get("n").low ?? 0);
          await session.close();
        } finally {
          await driver.close();
        }
        const graphNodes = matchedNodeIds.length;
        const unprojected = survivors.filter(
          (id) => !matchedNodeIds.includes(id)
        );
        expect(
          unprojected,
          `live entities with no projected node; intents=${drainedIntents};` +
            ` ledger: ${await entityLedgerState(sql!, unprojected)}`
        ).toEqual([]);
        expect(graphNodes).toBe(survivors.length);
        // Postgres had triples, so the projected graph must carry their edges.
        expect(graphEdges, `triples=${triples}`).toBeGreaterThan(0);

        // The atomic swap wrote a real summary generation, in PG and in ES.
        const summaries = await countWhere(
          sql!,
          "SELECT count(*)::int AS n FROM community_summaries",
          []
        );
        expect(summaries).toBeGreaterThan(0);
        const chunkDocs = await esDocCount(ES_CHUNK_INDEX);
        const summaryDocs = await esDocCount(ES_SUMMARY_INDEX);
        expect(chunkDocs).toBeGreaterThan(0);
        expect(summaryDocs).toBeGreaterThanOrEqual(1);

        // Poll + retrieve from a genuinely FRESH MCP process.
        const fresh = await connectServer(
          "index-job-worker-gold-w1-poll",
          true
        );
        let polled: WireResult;
        let retrieved: WireResult;
        try {
          polled = await callTool(fresh.client, "poll_index_job", {
            job_id: jobId,
          });
          retrieved = await callTool(fresh.client, "retrieve", {
            query: W1_QUERY,
            limit: 5,
          });
        } finally {
          await fresh.close();
        }
        expect(polled.isError).toBe(false);
        expect(polled.body.status).toBe("ready");
        expect(polled.body.failure_code).toBeNull();
        expect(polled.body.started_at).not.toBeNull();
        expect(polled.body.finished_at).not.toBeNull();
        expect(polled.body.community_index_state).toEqual({
          status: "ready",
          failure_code: null,
        });
        const hits = (retrieved.body.chunks ?? []) as Array<{
          source_ref: string;
        }>;
        expect(hits.map((h) => h.source_ref)).toContain(W1_SRC);

        // No sample ever showed the job published `ready` beside a C that was not
        // ready — the single terminal publish is after the swap commits.
        const premature = transitions.filter(
          (t) => t.job === INDEX_JOB_STATUS.READY && t.community !== "ready"
        );
        expect(premature).toEqual([]);

        record.w1 = {
          source_ref: W1_SRC,
          content_identity: identity,
          job_id: jobId,
          worker_exit: run.code,
          worker_stderr_tail: run.stderr.slice(-300),
          transitions,
          terminal: {
            status: row.status,
            started_at: iso(row.started_at),
            finished_at: iso(row.finished_at),
            failure_code: row.failure_code,
          },
          postgres: {
            entities,
            merged_losers: mergedLosers,
            merged_away_rows: mergedAwayIds.length,
            merged_away_with_nodes: mergedAwayNodes,
            triples,
            succeeded_records: succeeded,
            community_summaries: summaries,
            projection_intents: drainedIntents,
            chunks_before_worker: chunksBeforeRun.length,
            chunks_after_worker: chunksAfterRun.length,
          },
          neo4j: {
            projected_nodes: graphNodes,
            relation_edges: graphEdges,
          },
          elasticsearch: {
            chunk_index: ES_CHUNK_INDEX,
            chunk_docs: chunkDocs,
            summary_alias: ES_SUMMARY_INDEX,
            summary_docs: summaryDocs,
          },
          poll: {
            status: polled.body.status,
            community_index_state: polled.body.community_index_state,
          },
          retrieve_source_refs: hits.map((h) => h.source_ref),
          llm_model: LLM_MODEL,
        };
      },
      600_000
    );

    it("prints the measured gold run for the validation record", () => {
      record.measured_at = new Date().toISOString();
      process.stdout.write(
        `\nGOLD-RECORD ${JSON.stringify(record, null, 2)}\n\n`
      );
      const recorded = ["w3", "w4", ...(JUDGE_READY ? ["w2", "w5", "w6"] : [])];
      expect(Object.keys(record)).toEqual(expect.arrayContaining(recorded));
      if (W1_READY) expect(Object.keys(record)).toContain("w1");
    });
  }
);

/** When this source's first chunk got its extraction record (stage evidence). */
async function firstExtractWrittenAt(
  client: pg.Client,
  sourceRef: string
): Promise<number | null> {
  const res = await client.query(
    "SELECT min(r.created_at) AS at FROM extraction_records r" +
      "  JOIN chunks c ON c.id = r.chunk_id WHERE c.source_ref = $1",
    [sourceRef]
  );
  return ms(res.rows[0]?.at);
}
