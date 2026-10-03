/**
 * QP4 wire proof — a structured refusal must survive the real MCP boundary as
 * structure, not prose and not an empty success.
 *
 * Why an in-process linked transport instead of a schema-level call: the
 * property under test is the *serialization* decision in the server's tool
 * adapter (which envelope a thrown StructuredQueryError becomes). Only a real
 * `tools/call` round trip exercises that, and the in-process pattern from
 * tests/index.test.ts keeps it free of a build step, a child process, the
 * network, and Postgres.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../../src/index.js";
import { setSettingHomeForTests } from "../../src/config.js";
import { STRUCTURED_QUERY_SCHEMA } from "../../src/core/structured/request.js";
import { STRUCTURED_ERROR_SCHEMA } from "../../src/core/structured/errors.js";

/**
 * Construct a server with the stage 1 env vars forced to their defaults.
 *
 * Copied from tests/index.test.ts: `loadEnv()` reads `process.env` at
 * construction time, so a developer machine (or CI secret) with a real
 * embedding key or ledger DSN would otherwise boot a networked server — or
 * throw ConfigError — instead of the offline memory path these tests need.
 * `process.env[k] = ""` (not `delete`) also masks `.env.local`, matching the
 * `maskDotenvLocal` convention noted in that file.
 */
const ENV_KEYS = [
  "GRAPHRAG_MEMORY_STORAGE",
  "GRAPHRAG_MEMORY_DB_URL",
  "GRAPHRAG_MEMORY_EMBED_DIMENSIONS",
  "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS",
  "GRAPHRAG_MEMORY_EMBED_BASE_URL",
  "GRAPHRAG_MEMORY_EMBED_MODEL",
  "GRAPHRAG_MEMORY_EMBED_API_KEY",
  "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV",
  "GRAPHRAG_MEMORY_VECTOR_API_KEY",
  "NINE_ROUTER_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GRAPHRAG_MEMORY_RERANK_API_KEY_ENV",
  "MINIMAX_API_KEY",
  "GRAPHRAG_MEMORY_JEV_API_KEY",
  "TYPESAFE_API_KEY",
  "GRAPHRAG_MEMORY_ANTHROPIC_API_KEY",
  "GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED",
  "GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED",
  // No ledger DSN: the sql tier here is the not-provisioned exit, so a
  // structured refusal can only come from the structured boundary itself.
  "FIN_BUSINESS_LEDGER_URL",
] as const;

async function createOfflineServer(): Promise<ReturnType<typeof createServer>> {
  const saved = new Map<string, string | undefined>();
  for (const k of ENV_KEYS) {
    saved.set(k, process.env[k]);
    process.env[k] = "";
  }
  process.env["GRAPHRAG_MEMORY_EMBED_DIMENSIONS"] = "1536";
  process.env["GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS"] = "2000";
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_GRAPH_ENABLED"] = "false";
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_RERANK_ENABLED"] = "false";
  process.env["GRAPHRAG_MEMORY_RETRIEVAL_BM25_ENABLED"] = "false";
  const settingHome = mkdtempSync(join(tmpdir(), "iknow-structured-setting-"));
  setSettingHomeForTests(settingHome);
  try {
    return await createServer();
  } finally {
    setSettingHomeForTests(null);
    rmSync(settingHome, { recursive: true, force: true });
    for (const [k, v] of saved) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  }
}

async function connectInProcess(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = await createOfflineServer();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "structured-wire-test", version: "0.0.0" },
    { capabilities: {} }
  );
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Concatenate the text content blocks of a tools/call result. */
function textOf(result: { content: unknown }): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

interface StructuredErrorEnvelope {
  schema: string;
  schema_version: number;
  error: { code: string; retryable: boolean };
}

function validRequest(patch: Record<string, unknown> = {}): Record<
  string,
  unknown
> {
  return {
    schema: STRUCTURED_QUERY_SCHEMA,
    schema_version: 1,
    subject: "entity",
    operation: "list",
    ...patch,
  };
}

/** Call retrieve with a structured request and parse the refusal envelope. */
async function refuseStructured(
  client: Client,
  request: unknown,
  filters: Record<string, unknown> = { search_mode: "sql" }
): Promise<{ result: { isError?: boolean }; envelope: StructuredErrorEnvelope }> {
  const result = (await client.callTool({
    name: "retrieve",
    arguments: {
      query: "acme contracts",
      filters: { ...filters, structured_query: request },
    },
  })) as { isError?: boolean };
  return { result, envelope: JSON.parse(textOf(result)) };
}

describe("retrieve — structured refusal over the real MCP boundary", () => {
  it("returns a parseable iknow.structured_error envelope for a valid request on the sql tier", async () => {
    const { client, close } = await connectInProcess();
    try {
      const { result, envelope } = await refuseStructured(
        client,
        validRequest({ filters: [{ field: "type", op: "eq", value: "person" }] })
      );
      expect(result.isError).toBe(true);
      expect(envelope).toEqual({
        schema: "iknow.structured_error",
        schema_version: 1,
        error: { code: "structured_search_unavailable", retryable: true },
      });
    } finally {
      await close();
    }
  });

  it("serializes each refusal class as its own non-retryable code", async () => {
    const { client, close } = await connectInProcess();
    try {
      const cases: Array<{ request: unknown; code: string }> = [
        {
          request: validRequest({ subject: "document" }),
          code: "unsupported_subject",
        },
        {
          request: validRequest({ operation: "delete" }),
          code: "unsupported_operation",
        },
        {
          request: validRequest({ sql: "SELECT 1" }),
          code: "malformed_structured_query",
        },
        {
          request: validRequest({ schema: "iknow.other" }),
          code: "unsupported_structured_schema",
        },
        {
          request: validRequest({
            filters: [{ field: "id", op: "eq", value: "nope" }],
          }),
          code: "invalid_value",
        },
        {
          request: validRequest({
            filters: [
              {
                field: "canonical_name",
                op: "eq",
                value: "x".repeat(33 * 1024),
              },
            ],
          }),
          code: "request_too_large",
        },
      ];
      for (const { request, code } of cases) {
        const { envelope } = await refuseStructured(client, request);
        expect(envelope.error.code).toBe(code);
        expect(envelope.error.retryable).toBe(false);
      }
    } finally {
      await close();
    }
  });

  it("refuses a structured request on a tier other than sql", async () => {
    const { client, close } = await connectInProcess();
    try {
      // No search_mode: the request defaults to the graph tier, which cannot
      // widen or narrow into the structured one.
      const { result, envelope } = await refuseStructured(
        client,
        validRequest(),
        {}
      );
      expect(result.isError).toBe(true);
      expect(envelope.error.code).toBe("malformed_structured_query");
    } finally {
      await close();
    }
  });

  it("never answers a structured refusal as an empty successful envelope", async () => {
    const { client, close } = await connectInProcess();
    try {
      const { result, envelope } = await refuseStructured(
        client,
        validRequest()
      );
      expect(result.isError).toBe(true);
      // Neither the legacy retrieve envelope nor a bare list: no chunks, no
      // database_rows, no result array — a typed refusal only.
      expect(envelope).not.toHaveProperty("chunks");
      expect(envelope).not.toHaveProperty("database_rows");
      expect(Object.keys(envelope).sort()).toEqual([
        "error",
        "schema",
        "schema_version",
      ]);
      expect(textOf(result)).not.toMatch(/"chunks"/);
    } finally {
      await close();
    }
  });

  it("keeps the same refusal when the request rides a real natural-language query", async () => {
    // The outer descriptive query may describe the request; it must not change
    // the typed outcome.
    const { client, close } = await connectInProcess();
    try {
      const result = (await client.callTool({
        name: "retrieve",
        arguments: {
          query: "list every person mentioned in the acme contract corpus",
          filters: { search_mode: "sql", structured_query: validRequest() },
        },
      })) as { isError?: boolean };
      expect(result.isError).toBe(true);
      expect(JSON.parse(textOf(result)).error.code).toBe(
        "structured_search_unavailable"
      );
    } finally {
      await close();
    }
  });

  it("still answers an ordinary sql retrieve with its own not-provisioned exit", async () => {
    // Control: the structured envelope did not hijack the legacy SQL refusal.
    const { client, close } = await connectInProcess();
    try {
      const result = (await client.callTool({
        name: "retrieve",
        arguments: { query: "acme", filters: { search_mode: "sql" } },
      })) as { isError?: boolean };
      expect(result.isError).toBe(true);
      const body = JSON.parse(textOf(result));
      expect(body.error).toBe("real_db_not_wired");
      expect(body.schema).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("adds no new model-facing tool for structured search", async () => {
    const { client, close } = await connectInProcess();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "extract",
        "ingest",
        "invalidate",
        "poll_index_job",
        "push",
        "read_source",
        "retrieve",
        "submit_index_job",
      ]);
      const retrieve = tools.find((t) => t.name === "retrieve");
      // The structured request rides the existing filters map, so `filters` is
      // an object whose values are not string-only. The ADVERTISED value schema
      // is pinned here because that advertisement is what a host reads: if the
      // value union ever collapses back to an unconstrained value, the published
      // JSON Schema would stop saying values are strings and a schema-only host
      // would believe `filters` accepts anything.
      const properties = (
        retrieve?.inputSchema as {
          properties?: {
            filters?: {
              type?: string;
              additionalProperties?: unknown;
            };
          };
        }
      ).properties;
      expect(properties?.filters?.type).toBe("object");
      expect(properties?.filters?.additionalProperties).toMatchObject({
        anyOf: [
          { type: "string" },
          { type: "object" },
        ],
      });
      // The outer object stays strict: an unknown top-level key is still a
      // parse error, not a silently stripped field.
      expect(
        (retrieve?.inputSchema as { additionalProperties?: unknown })
          .additionalProperties
      ).toBe(false);
    } finally {
      await close();
    }
  });
});
