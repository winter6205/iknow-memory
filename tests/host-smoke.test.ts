/**
 * host-smoke: a real MCP Host over stdio.
 *
 * Proves (per wayfinder map #1 / T-007 task #79, stdio Host):
 *   (a) stdio JSON-RPC handshake: initialize / initialized under a real
 *       MCP client (v2 @modelcontextprotocol/client's Client +
 *       StdioClientTransport spawning our dist/index.js).
 *   (b) tool discovery: tools/list returns ingest + invalidate + push
 *       + retrieve.
 *   (c) tool call: tools/call round-trips the documented text shape.
 *   (d) negative input: empty query -> isError:true result (v2 wraps
 *       input-validation failures as a tool result, not a JSON-RPC error).
 *   (e) concurrent clients: two clients against one server each complete.
 *   (f) zod4 JSON Schema: the retrieve inputSchema carries minLength:1
 *       (zod v4 maps .min(1) to minLength, not the v3 minimum), proving
 *       the 3.25 -> 4.2 upgrade did not silently drop the constraint.
 *   (g) host-agnostic decoupling (negative check): the dist artifact's
 *       runtime imports do NOT include anything from the iknow repo.
 *
 * NOT proven yet (gated on T-005 / #36): the HTTP transport equivalent of
 * every stdio check above. The stdio end-to-end round-trip (a4) is covered
 * once stage 1 wires ingest + retrieve.
 *
 * Why v2 lets the transport own the child process: in v1 we hand-spawned
 * the server and handed its stdio to StdioClientTransport, but the v1
 * transport's close() did not manage the externally-spawned child, so
 * the server never exited (5s SIGKILL safety net). v2's
 * StdioClientTransport takes command/args/env and runs the child
 * internally with a proper close lifecycle (stdin.end -> SIGTERM ->
 * SIGKILL + explicit pipe-handle disposal).
 *
 * Why spawn the compiled dist/index.js (not `tsx src/index.ts`): the
 * compiled artifact is what Claude Code launches in production.
 * Exercising it exercises the wire contract end-to-end.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { afterEach, describe, expect, test } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const distEntry = path.join(pkgRoot, "dist", "index.js");

/**
 * Env-var keys pinned to empty string in the child's environment so
 * `readEnv` (process.env > `.env.local`) cannot fall through to a developer
 * `.env.local` and silently select 9router / Postgres / Neo4j.
 *
 * Blank values collapse to "absent" in `readTrimmed` / UnavailableEmbedder.
 * Deleting the keys is not enough: missing keys read the file.
 */
const HOST_SMOKE_SCRUBBED_ENV_KEYS = [
  "GRAPHRAG_MEMORY_DB_URL",
  "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS",
  "GRAPHRAG_MEMORY_EMBED_API_KEY",
  "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV",
  "GRAPHRAG_MEMORY_VECTOR_API_KEY",
  "GRAPHRAG_MEMORY_ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GRAPHRAG_MEMORY_RERANK_API_KEY_ENV",
  "MINIMAX_API_KEY",
  "GRAPHRAG_MEMORY_JEV_API_KEY",
  "TYPESAFE_API_KEY",
  "NINE_ROUTER_KEY",
  // A parent Neo4j URI / rerank URL must not leak into the child; both are
  // replaced below with the values this suite pins (ADR-0006).
  "GRAPHRAG_MEMORY_NEO4J_URI",
  "GRAPHRAG_MEMORY_NEO4J_USER",
  "GRAPHRAG_MEMORY_NEO4J_PASSWORD",
  "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_URL",
  "GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED",
] as const;

/**
 * Build the child-process env: pinned to memory storage with unavailable
 * embeddings, inheriting everything else from the parent. Without this, a developer
 * machine with `NINE_ROUTER_KEY` exported would silently pay for embeddings
 * during `npm test`, and an accidental `GRAPHRAG_MEMORY_STORAGE=pgvector`
 * would crash with "no Postgres available" instead of running deterministically.
 */
function hostSmokeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.HOME = mkdtempSync(path.join(tmpdir(), "iknow-host-smoke-home-"));
  env["GRAPHRAG_MEMORY_STORAGE"] = "memory";
  // GRAPHRAG_MEMORY_EMBED_DIMENSIONS is always required; the smoke suite
  // runs without an embedding credential (keys blanked below), so any
  // positive integer works.
  env["GRAPHRAG_MEMORY_EMBED_DIMENSIONS"] = "1536";
  for (const key of HOST_SMOKE_SCRUBBED_ENV_KEYS) env[key] = "";
  env["GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS"] = "2000";
  // ADR-0006 fail-start: a default-on graph child without any URI refuses
  // to boot. The suite's assertions expect the graph capability present
  // but unattempted (graph_ppr:unattempted), so pin a controlled dummy URI
  // instead of switching the arm off. It is never dialed: the child's
  // MemoryBackend has no neo4jArmSeed seam, so the arm cannot start.
  env["GRAPHRAG_MEMORY_NEO4J_URI"] = "bolt://127.0.0.1:1";
  // Rerank has no corpus to permute over stdio smoke traffic; explicit off
  // is the ADR-0006-legal way to boot without a rerank URL.
  env["GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED"] = "false";
  // ADR-0007: the precision layer is default-on with no ES address here, so
  // the child takes the same explicit-off escape hatch — the smoke suite
  // never exercises the lexical arm, and materializing it would attempt a
  // nonexistent cluster.
  env["GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED"] = "false";
  return env;
}

/**
 * Parameters a real reference host (Claude Code) would use to launch this
 * server. v2's StdioClientTransport takes these and owns the child process
 * for its full lifecycle.
 */
function serverParams() {
  if (!existsSync(distEntry)) {
    throw new Error(
      `dist entry not found: ${distEntry} - run \`npm run build --workspace iknow-memory\` first`
    );
  }
  return {
    command: process.execPath,
    args: [distEntry],
    env: hostSmokeEnv(),
    stderr: "pipe" as const,
  };
}

/**
 * Connect a fresh client to a freshly-spawned server. Each test owns its
 * own (client, transport) pair so failures in one cannot leak into the
 * next; afterEach closes them.
 */
async function connectClient(): Promise<Client> {
  const transport = new StdioClientTransport(serverParams());
  const client = new Client(
    { name: "host-smoke", version: "0.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return client;
}

describe("host-smoke: real stdio MCP client against built server", () => {
  // Each test registers its client here so afterEach can close it even on
  // assertion failure (otherwise the spawned server would leak).
  const clients: Client[] = [];
  afterEach(async () => {
    while (clients.length > 0) {
      await clients.pop()!.close();
    }
  });

  test(
    "handshake returns iknow-memory serverInfo",
    { timeout: 30_000 },
    async () => {
      const client = await connectClient();
      clients.push(client);

      const serverInfo = client.getServerVersion();
      expect(serverInfo?.name).toBe("iknow-memory");
      expect(serverInfo?.version).toBeDefined();
    }
  );

  test(
    "tools/list returns ingest, invalidate, push, extract, read_source, and retrieve with object inputSchemas",
    { timeout: 30_000 },
    async () => {
      const client = await connectClient();
      clients.push(client);

      const { tools } = await client.listTools();
      // specs/mcp-tool-surface.md Catalog + operator-console T4: exactly
      // these write/read tools over the wire. `echo` is archived; the
      // invalidation tool answers to `invalidate`; `extract` runs the
      // lifted core pipeline; `read_source` serves one bounded, resumable
      // slice of a 资料 body rather than the whole text.
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "extract",
        "ingest",
        "invalidate",
        "poll_index_job",
        "push",
        "read_source",
        "retrieve",
        "submit_index_job",
      ]);
      expect(names).not.toContain("echo");
      expect(names).not.toContain("invalidation");

      for (const tool of tools) {
        expect((tool.inputSchema as { type?: string }).type).toBe("object");
        expect(tool.description.length).toBeGreaterThan(0);
      }
    }
  );

  test(
    "tools/call extract answers the typed no-database error over stdio",
    { timeout: 30_000 },
    async () => {
      // The smoke child runs memory storage with no GRAPHRAG_MEMORY_DB_URL:
      // extract must fail as a typed tool result (not crash the server),
      // and the error must be Host-readable without CLI-flag wording.
      const client = await connectClient();
      clients.push(client);

      const result = await client.callTool({
        name: "extract",
        arguments: { source_ref: "host-smoke-extract-no-db" },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      expect(text).toMatch(/GRAPHRAG_MEMORY_DB_URL/);
      expect(text).not.toMatch(/--dry-run/);
    }
  );

  test(
    "tools/call retrieve round-trips a JSON chunks envelope as text content",
    { timeout: 30_000 },
    async () => {
      const client = await connectClient();
      clients.push(client);

      const result = await client.callTool({
        name: "retrieve",
        arguments: { query: "ping from host-smoke" },
      });
      expect(result.isError).not.toBe(true);

      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      // Empty store: "no results" is a valid, well-formed answer.
      const payload = JSON.parse(text) as { chunks: unknown[] };
      expect(Array.isArray(payload.chunks)).toBe(true);
    }
  );

  test(
    "empty query returns isError:true result (v2 semantics)",
    { timeout: 30_000 },
    async () => {
      const client = await connectClient();
      clients.push(client);

      // v2 wraps input-validation failures as a CallToolResult with
      // isError:true (tool-result semantics), NOT a JSON-RPC error that
      // rejects the promise. v1 rejected; the schema's min(1) still fires.
      const bad = await client.callTool({
        name: "retrieve",
        arguments: { query: "" },
      });
      expect(bad.isError).toBe(true);

      const badText = (bad.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      expect(badText).toMatch(/non-empty|validation/i);
    }
  );

  test(
    "concurrent clients each complete a tools/call",
    { timeout: 30_000 },
    async () => {
      // Two independent clients against two independent server processes,
      // both calling retrieve in parallel. A transport/event-loop
      // regression (the v1 teardown-hang class) would surface as a hang
      // or timeout.
      const [a, b] = await Promise.all([connectClient(), connectClient()]);
      clients.push(a, b);

      const [ra, rb] = await Promise.all([
        a.callTool({ name: "retrieve", arguments: { query: "from-A" } }),
        b.callTool({ name: "retrieve", arguments: { query: "from-B" } }),
      ]);
      expect(ra.isError).not.toBe(true);
      expect(rb.isError).not.toBe(true);
    }
  );

  test(
    "zod4 emits minLength:1 on retrieve inputSchema (3.25 -> 4.2 regression guard)",
    { timeout: 30_000 },
    async () => {
      // zod v3 mapped .min(1) on a string to `minimum` (wrong keyword for
      // strings); zod v4 maps it to `minLength`. If the 3.25 -> 4.2 upgrade
      // silently downgraded the schema, this catches it. We read the wire
      // shape the server actually advertises (the SDK converts the Zod
      // object to JSON Schema on tools/list), not the Zod object directly.
      const client = await connectClient();
      clients.push(client);

      const { tools } = await client.listTools();
      const retrieve = tools.find((t) => t.name === "retrieve")!;
      const queryProp = (
        retrieve.inputSchema as { properties?: Record<string, unknown> }
      ).properties?.query as { minLength?: number; type?: string } | undefined;
      expect(queryProp?.type).toBe("string");
      expect(queryProp?.minLength).toBe(1);
    }
  );

  test(
    "a4: missing embeddings degrade retrieve over the real stdio transport",
    { timeout: 60_000 },
    async () => {
      // The transport still exercises the Host-facing ingest/retrieve
      // contract, while T12 forbids production pseudo-vectors.
      const client = await connectClient();
      clients.push(client);

      const ingested = await client.callTool({
        name: "ingest",
        arguments: {
          content: "张三于2024年创办了公司A，公司位于北京。",
          source_ref: "test-bio.md",
        },
      });
      expect(ingested.isError).toBe(true);

      const retrieved = await client.callTool({
        name: "retrieve",
        arguments: { query: "张三创办了什么公司" },
      });
      expect(retrieved.isError).not.toBe(true);
      const retrieveBody = (
        retrieved.content as Array<{ type: string; text?: string }>
      )
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      const retrievePayload = JSON.parse(retrieveBody) as {
        chunks: unknown[];
        degraded?: true;
        degraded_reasons?: string[];
      };
      expect(retrievePayload.chunks).toEqual([]);
      expect(retrievePayload.degraded).toBe(true);
      expect(retrievePayload.degraded_reasons).toContain("vector:unattempted");
    }
  );

  test(
    "planted Neo4j URI is scrubbed while missing embeddings degrade the child",
    { timeout: 60_000 },
    async () => {
      const planted = {
        GRAPHRAG_MEMORY_NEO4J_URI: "bolt://127.0.0.1:1",
        GRAPHRAG_MEMORY_NEO4J_USER: "neo4j",
        GRAPHRAG_MEMORY_NEO4J_PASSWORD: "planted-not-a-real-secret",
      };
      const saved = new Map<string, string | undefined>();
      for (const [k, v] of Object.entries(planted)) {
        saved.set(k, process.env[k]);
        process.env[k] = v;
      }

      try {
        const client = await connectClient();
        clients.push(client);

        const ingested = await client.callTool({
          name: "ingest",
          arguments: {
            content: "Host-smoke planted-URI marker sentence.",
            source_ref: "host-smoke-neo4j-scrub.md",
          },
        });
        expect(ingested.isError).toBe(true);

        const retrieved = await client.callTool({
          name: "retrieve",
          arguments: { query: "planted-URI marker" },
        });
        expect(retrieved.isError).not.toBe(true);
        const retrieveBody = (
          retrieved.content as Array<{ type: string; text?: string }>
        )
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("");
        const retrievePayload = JSON.parse(retrieveBody) as {
          degraded?: true;
          degraded_reasons?: string[];
        };
        expect(retrievePayload.degraded).toBe(true);
        expect(retrievePayload.degraded_reasons).toContain(
          "vector:unattempted"
        );
        expect(retrievePayload.degraded_reasons).toContain(
          "graph_ppr:unattempted"
        );
      } finally {
        for (const [k, v] of saved) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }
  );

  test(
    "spawned server selects UnavailableEmbedder when credentials are scrubbed",
    { timeout: 30_000 },
    async () => {
      // If a host or CI runner exports an embedding key, the child must still
      // use the unavailable typed embedder because hostSmokeEnv scrubs it.
      // Planting a key in the parent makes this isolation check deterministic.
      const planted = {
        GRAPHRAG_MEMORY_EMBED_API_KEY: "planted-not-a-real-secret",
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "planted-not-a-real-secret",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://example.invalid/v1",
        GRAPHRAG_MEMORY_EMBED_MODEL: "planted-model",
      };
      const saved = new Map<string, string | undefined>();
      for (const [k, v] of Object.entries(planted)) {
        saved.set(k, process.env[k]);
        process.env[k] = v;
      }

      // The server announces its embedder choice on stderr at construction
      // ("server constructed ... embedder: unavailable | 9router"). stdout is the
      // JSON-RPC transport, so stderr is the only observation seam.
      let stderrText = "";
      try {
        const transport = new StdioClientTransport(serverParams());
        const client = new Client(
          { name: "host-smoke-embedder", version: "0.0.0" },
          { capabilities: {} }
        );
        await client.connect(transport);
        clients.push(client);
        transport.stderr?.on("data", (buf: Buffer) => {
          stderrText += buf.toString("utf8");
        });
        // The construction line is emitted before connect() resolves, but
        // the stderr pipe is only drained once a listener attaches; one
        // retrieve round-trip is enough to flush it.
        await client.callTool({ name: "retrieve", arguments: { query: "x" } });
      } finally {
        for (const [k, v] of saved) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }

      expect(stderrText).toMatch(/"embedder":"unavailable"/);
      expect(stderrText).not.toMatch(/"embedder":"9router"/);
    }
  );

  test("host-agnostic: built artifact does not import from iknow runtime", () => {
    // Imports survive tsc into `from "..."` / `require("...")` statements,
    // so a literal grep is sufficient proof. Anchor on the import/require
    // keyword to avoid matching string literals that merely MENTION a
    // forbidden path in comments (a bare /shared\/schema/ regex did that,
    // false-positive-matching the doc comment in dist/index.js).
    const src = readFileSync(distEntry, "utf8");
    expect(src).not.toMatch(/from\s+["']\.\.\/\.\.\/src\b/);
    expect(src).not.toMatch(/from\s+["']\.\.\/\.\.\/\.\.\/src\b/);
    expect(src).not.toMatch(/require\(["']\.\.\/\.\.\/src\b/);
    expect(src).not.toMatch(/from\s+["'][^"']*shared\/schema/);
    expect(src).not.toMatch(/from\s+["'][^"']*config\/env/);
  });
});
