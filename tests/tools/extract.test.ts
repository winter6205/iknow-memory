/**
 * Unit tests for the MCP extract tool (`src/tools/extract.ts`), covering the
 * five boundary classes of specs/mcp-tool-surface.md §Testing Strategy:
 *
 *   empty      — source_ref with zero pending chunks → success with zeros;
 *                empty chunk_ids → validation error.
 *   negative   — both selectors; neither selector (schema + handler-level).
 *   overflow   — chunk_ids over the batch cap → typed error before any dial;
 *                source_ref with more pending than the cap → processed count
 *                plus `more_pending: true` (no silent truncation).
 *   concurrent — two overlapping extract calls on distinct chunks via one
 *                shared pool: each call owns its connection, and the
 *                per-chunk transactions never interleave across calls.
 *   exception  — missing LLM / embedding credentials → typed
 *                ExtractNotConfiguredError and no fake writes (SC9); one
 *                failing chunk does not abort its sibling (mark-and-continue),
 *                including the write-failure leg that leaves no
 *                extraction_records row behind.
 *
 * The handler is driven with fakes (FakeQueryable pool + FakeLLMClient +
 * FakeEmbedder) the same way tests/extraction/pipeline.test.ts drives the
 * lifted core pipeline — the tool only adds the selector contract, the cap
 * and the error mapping on top of it.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  createExtractHandler,
  ExtractBatchLimitExceededError,
  ExtractInputSchema,
  ExtractNotConfiguredError,
  type ExtractClient,
  type ExtractDeps,
} from "../../src/tools/extract.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { ConfigError } from "../../src/config.js";
import type { Logger } from "../../src/logging.js";
import type { ToolResult } from "../../src/tools/registry.js";

// upSchemaBootstrap reads the ANN ceiling from the env at call time; the server
// path always has it (loadEnv requires it to boot), so pin it for the tests.
process.env["GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS"] = "2000";

const TEST_DIM = 8;

const SILENT_LOGGER: Logger = {
  level: "error",
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const GROUNDED_OUTPUT = {
  head: "Alice",
  headType: "person",
  relationRaw: "works at",
  relationNorm: "RELATED_TO",
  tail: "Acme Corp",
  tailType: "system",
  description: "Alice works at Acme Corp",
  evidenceSpan: "Alice works at Acme Corp",
  confidence: 0.9,
};

/** Recording fake Queryable; rows are chosen per SQL text. */
class FakeQueryable implements ExtractClient {
  queries: string[] = [];
  valuesList: unknown[][] = [];
  rowsFor: (text: string) => any[] = () => [];
  /**
   * When set, the FIRST query containing this fragment throws
   * (simulating a transient write error on one chunk's transaction);
   * later matching queries succeed, so a second chunk is unaffected.
   */
  failOn: string | undefined;

  async query(text: string, values: unknown[] = []) {
    this.queries.push(text);
    this.valuesList.push(values);
    if (this.failOn !== undefined && text.includes(this.failOn)) {
      const fragment = this.failOn;
      this.failOn = undefined;
      throw new Error(`simulated write failure on: ${fragment}`);
    }
    return { rows: this.rowsFor(text) };
  }

  release(): void {}

  /** Index of the first query containing `fragment`, or -1. */
  indexOf(fragment: string): number {
    return this.queries.findIndex((q) => q.includes(fragment));
  }

  /** Last index of a query containing `fragment`, or -1. */
  lastIndexOf(fragment: string): number {
    for (let i = this.queries.length - 1; i >= 0; i -= 1) {
      if (this.queries[i]!.includes(fragment)) return i;
    }
    return -1;
  }

  /** Every value ever bound on this connection, flattened. */
  flatValues(): unknown[] {
    return this.valuesList.flat();
  }

  /** Values bound by write statements only (INSERT / UPDATE / DELETE). */
  writeBoundValues(): unknown[] {
    return this.queries.flatMap((q, i) =>
      /\bINSERT INTO\b|\bUPDATE\b|\bDELETE\b/.test(q)
        ? (this.valuesList[i] ?? [])
        : []
    );
  }
}

interface Harness {
  deps: ExtractDeps;
  clients: FakeQueryable[];
  llm: FakeLLMClient;
}

/**
 * Build handler deps over a fake pool. Each connect() leases the next
 * prepared FakeQueryable, so concurrent calls own distinct connections —
 * the pool-level analogue of the per-chunk transaction isolation the core
 * pipeline already guarantees within one call.
 *
 * `injectClients` (default true) threads the fake LLM/embedder through the
 * handler's test seam so no network is dialed; the credential-guard tests
 * pass `injectClients: false` to exercise the real guard path instead.
 */
function makeHarness(opts: {
  llm: FakeLLMClient;
  rowsFor?: (clientIndex: number, text: string) => any[];
  clientCount?: number;
  batchLimit?: number;
  injectClients?: boolean;
}): Harness {
  const clients: FakeQueryable[] = [];
  const count = opts.clientCount ?? 1;
  for (let i = 0; i < count; i += 1) {
    const client = new FakeQueryable();
    client.rowsFor = (text: string) =>
      opts.rowsFor ? opts.rowsFor(i, text) : [];
    clients.push(client);
  }
  const queue = [...clients];
  const deps: ExtractDeps = {
    llmEnv: { authToken: "test-token" },
    embedderEnv: {
      apiKey: "test-key",
      baseUrl: "https://embed.test/v1",
      model: "test-model",
      dimensions: TEST_DIM,
    },
    pool: {
      connect: vi.fn(async () => queue.shift()!),
    },
    logger: SILENT_LOGGER,
    now: () => "2026-01-01T00:00:00.000Z",
    ...(opts.batchLimit !== undefined ? { batchLimit: opts.batchLimit } : {}),
    ...(opts.injectClients === false
      ? {}
      : { llm: opts.llm, embedder: new FakeEmbedder(TEST_DIM) }),
  };
  return { deps, clients, llm: opts.llm };
}

/** Parse the JSON text body of a ToolResult. */
function parseBody(result: ToolResult): {
  batch_id: string;
  processed: number;
  succeeded: number;
  failed: number;
  write_failures: number;
  ungrounded: number;
  failed_chunks: Array<{
    chunk_id: string;
    error_code: string;
    error_msg: string;
  }>;
  more_pending?: true;
  missing_chunk_ids?: string[];
} {
  const text = result.content[0]?.text;
  if (typeof text !== "string") {
    throw new Error("expected text content in ToolResult");
  }
  return JSON.parse(text);
}

const UUID_A = "0f0a3f8e-1c2b-4d5e-8f90-1a2b3c4d5e6f";
const UUID_B = "1f0a3f8e-1c2b-4d5e-8f90-1a2b3c4d5e6f";
const UUID_C = "2f0a3f8e-1c2b-4d5e-8f90-1a2b3c4d5e6f";

describe("ExtractInputSchema — xor selector contract (wire validation)", () => {
  it("empty: an empty chunk_ids array is a validation error", () => {
    const result = ExtractInputSchema.safeParse({
      chunk_ids: [],
      source_ref: undefined,
    });
    expect(result.success).toBe(false);
  });

  it("negative: both selectors is a validation error", () => {
    const result = ExtractInputSchema.safeParse({
      chunk_ids: [UUID_A],
      source_ref: "doc-1",
    });
    expect(result.success).toBe(false);
  });

  it("negative: neither selector is a validation error", () => {
    const result = ExtractInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("negative: an empty source_ref string is a validation error", () => {
    const result = ExtractInputSchema.safeParse({ source_ref: "" });
    expect(result.success).toBe(false);
  });

  it("negative: non-UUID chunk_ids entries are a validation error", () => {
    const result = ExtractInputSchema.safeParse({
      chunk_ids: ["not-a-uuid"],
    });
    expect(result.success).toBe(false);
  });

  it("negative: unknown keys are rejected (strict schema)", () => {
    const result = ExtractInputSchema.safeParse({
      source_ref: "doc-1",
      since: "2026-01-01T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("accepts exactly one selector", () => {
    expect(ExtractInputSchema.safeParse({ source_ref: "doc-1" }).success).toBe(
      true
    );
    expect(ExtractInputSchema.safeParse({ chunk_ids: [UUID_A] }).success).toBe(
      true
    );
  });
});

describe("createExtractHandler — empty class", () => {
  it("source_ref with zero pending chunks succeeds with zeros", async () => {
    const { deps, clients } = makeHarness({
      llm: new FakeLLMClient({ queue: [] }),
      rowsFor: () => [], // no pending chunks for the source
    });
    const handler = createExtractHandler(deps);

    const result = await handler({ source_ref: "doc-404" });
    const body = parseBody(result);

    expect(result.isError).toBeUndefined();
    expect(body.processed).toBe(0);
    expect(body.succeeded).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.write_failures).toBe(0);
    expect(body.ungrounded).toBe(0);
    expect(body.failed_chunks).toEqual([]);
    expect(body.more_pending).toBeUndefined();
    // Zero work: no extraction record was inserted on this connection.
    expect(clients[0]!.indexOf("INSERT INTO extraction_records")).toBe(-1);
  });
});

describe("createExtractHandler — negative class (handler-level xor)", () => {
  it("both selectors → INVALID_INPUT GraphragError", async () => {
    const { deps } = makeHarness({ llm: new FakeLLMClient({ queue: [] }) });
    const handler = createExtractHandler(deps);

    await expect(
      handler({ chunk_ids: [UUID_A], source_ref: "doc-1" })
    ).rejects.toThrow(/exactly one selector/);
  });

  it("neither selector → INVALID_INPUT GraphragError", async () => {
    const { deps } = makeHarness({ llm: new FakeLLMClient({ queue: [] }) });
    const handler = createExtractHandler(deps);

    // Cast: the wire schema already rejects this; the handler must not
    // trust a direct caller either.
    await expect(
      handler({} as unknown as { source_ref: string })
    ).rejects.toThrow(/exactly one selector/);
  });
});

describe("createExtractHandler — overflow class", () => {
  it("chunk_ids over the batch cap → typed error before any database dial", async () => {
    const { deps, clients } = makeHarness({
      llm: new FakeLLMClient({ queue: [] }),
      batchLimit: 2,
    });
    const handler = createExtractHandler(deps);

    const promise = handler({ chunk_ids: [UUID_A, UUID_B, UUID_C] });
    await expect(promise).rejects.toBeInstanceOf(
      ExtractBatchLimitExceededError
    );
    await expect(promise).rejects.toMatchObject({
      code: "BATCH_LIMIT_EXCEEDED",
      actualCount: 3,
      limit: 2,
    });
    await expect(promise).rejects.toThrow(/exceeds limit 2/);
    // No connection was leased, so nothing could have been written.
    expect(
      (deps.pool as NonNullable<ExtractDeps["pool"]>).connect
    ).not.toHaveBeenCalled();
    expect(clients[0]!.queries).toHaveLength(0);
  });

  it("source_ref with more pending than the cap reports processed + more_pending", async () => {
    const { deps, clients } = makeHarness({
      llm: new FakeLLMClient({
        queue: [
          { kind: "ok", outputs: [GROUNDED_OUTPUT] },
          { kind: "ok", outputs: [GROUNDED_OUTPUT] },
        ],
      }),
      rowsFor: (_clientIndex, text) =>
        text.includes("c.source_ref = $1")
          ? [
              { id: UUID_A, content: "Alice works at Acme Corp." },
              { id: UUID_B, content: "Bob works at Beta Corp." },
              { id: UUID_C, content: "Carol works at Gamma Corp." },
            ]
          : [],
      batchLimit: 2,
    });
    const handler = createExtractHandler(deps);

    const result = await handler({ source_ref: "doc-1" });
    const body = parseBody(result);

    // Capped at the limit; the third pending chunk remains.
    expect(body.processed).toBe(2);
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.more_pending).toBe(true);
    // Only the two capped chunks were handed to the pipeline.
    expect(clients[0]!.flatValues()).not.toContain(UUID_C);
  });
});

describe("createExtractHandler — exception class (mark-and-continue)", () => {
  it("one chunk fails extraction, its sibling still succeeds; counts reflect both", async () => {
    const { deps, clients } = makeHarness({
      llm: new FakeLLMClient({
        queue: [
          { kind: "ok", outputs: [GROUNDED_OUTPUT] },
          { kind: "5xx", message: "provider down" },
        ],
      }),
      rowsFor: (_clientIndex, text) =>
        text.includes("WHERE c.id IN")
          ? [
              { id: UUID_A, content: "Alice works at Acme Corp." },
              { id: UUID_B, content: "Bob works at Beta Corp." },
            ]
          : [],
    });
    const handler = createExtractHandler(deps);

    const result = await handler({ chunk_ids: [UUID_A, UUID_B] });
    const body = parseBody(result);

    expect(body.processed).toBe(2);
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.write_failures).toBe(0);
    expect(body.failed_chunks).toEqual([
      {
        chunk_id: UUID_B,
        error_code: "5xx",
        error_msg: "provider down",
      },
    ]);
    // Mark-and-continue: the failed sibling still committed its own record.
    expect(clients[0]!.indexOf("ROLLBACK")).toBe(-1);
    expect(clients[0]!.flatValues()).toContain(UUID_A);
    expect(clients[0]!.flatValues()).toContain(UUID_B);
  });

  it("a write-failure chunk rolls back and is reported with WRITE_FAILURE while its sibling commits", async () => {
    const { deps, clients } = makeHarness({
      llm: new FakeLLMClient({
        queue: [
          { kind: "ok", outputs: [GROUNDED_OUTPUT] },
          { kind: "ok", outputs: [GROUNDED_OUTPUT] },
        ],
      }),
      rowsFor: (_clientIndex, text) =>
        text.includes("WHERE c.id IN")
          ? [
              { id: UUID_A, content: "Alice works at Acme Corp." },
              { id: UUID_B, content: "Bob works at Beta Corp." },
            ]
          : [],
    });
    // Second chunk's entity write explodes after the record insert —
    // the whole chunk transaction rolls back (no failed row survives).
    clients[0]!.failOn = "INSERT INTO entities";
    const handler = createExtractHandler(deps);

    const result = await handler({ chunk_ids: [UUID_A, UUID_B] });
    const body = parseBody(result);

    expect(body.processed).toBe(2);
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.write_failures).toBe(1);
    expect(body.failed_chunks).toEqual([
      {
        chunk_id: UUID_A,
        error_code: "WRITE_FAILURE",
        error_msg: "simulated write failure on: INSERT INTO entities",
      },
    ]);
    expect(clients[0]!.indexOf("ROLLBACK")).toBeGreaterThanOrEqual(0);
  });

  it("missing LLM credential → typed error before any dial, no fake writes", async () => {
    const { deps, clients } = makeHarness({
      llm: new FakeLLMClient({ queue: [] }),
      injectClients: false, // the guard path itself is under test
    });
    const noTokenDeps: ExtractDeps = {
      ...deps,
      llmEnv: { authToken: undefined },
    };
    const handler = createExtractHandler(noTokenDeps);

    const promise = handler({ source_ref: "doc-1" });
    await expect(promise).rejects.toBeInstanceOf(ExtractNotConfiguredError);
    await expect(promise).rejects.toBeInstanceOf(ConfigError);
    await expect(promise).rejects.toThrow(/ANTHROPIC_AUTH_TOKEN/);
    // The core guard's CLI-flag wording must not reach the Host.
    await expect(promise).rejects.not.toThrow(/--dry-run/);
    // No connection was leased and no fake pipeline ran (SC9).
    expect(
      (noTokenDeps.pool as NonNullable<ExtractDeps["pool"]>).connect
    ).not.toHaveBeenCalled();
    expect(clients[0]!.queries).toHaveLength(0);
  });

  it("missing embedding credentials → typed error before any dial, no fake vectors", async () => {
    const { deps, clients } = makeHarness({
      llm: new FakeLLMClient({ queue: [] }),
      injectClients: false, // the guard path itself is under test
    });
    const noEmbedDeps: ExtractDeps = {
      ...deps,
      embedderEnv: {
        apiKey: undefined,
        baseUrl: undefined,
        model: undefined,
        dimensions: TEST_DIM,
      },
    };
    const handler = createExtractHandler(noEmbedDeps);

    const promise = handler({ source_ref: "doc-1" });
    await expect(promise).rejects.toBeInstanceOf(ExtractNotConfiguredError);
    await expect(promise).rejects.toThrow(/embedding credentials/);
    await expect(promise).rejects.not.toThrow(/--dry-run/);
    expect(
      (noEmbedDeps.pool as NonNullable<ExtractDeps["pool"]>).connect
    ).not.toHaveBeenCalled();
    expect(clients[0]!.queries).toHaveLength(0);
  });

  it("no pool configured (no GRAPHRAG_MEMORY_DB_URL) → typed error, not a crash", async () => {
    const deps: ExtractDeps = {
      llmEnv: { authToken: "test-token" },
      embedderEnv: {
        apiKey: "test-key",
        baseUrl: "https://embed.test/v1",
        model: "test-model",
        dimensions: TEST_DIM,
      },
      logger: SILENT_LOGGER,
    };
    const handler = createExtractHandler(deps);

    await expect(handler({ source_ref: "doc-1" })).rejects.toThrow(
      /GRAPHRAG_MEMORY_DB_URL/
    );
  });
});

describe("createExtractHandler — chunk_ids selector (missing ids)", () => {
  it("unknown ids are reported in missing_chunk_ids and never processed", async () => {
    const { deps, clients } = makeHarness({
      llm: new FakeLLMClient({
        queue: [{ kind: "ok", outputs: [GROUNDED_OUTPUT] }],
      }),
      rowsFor: (_clientIndex, text) =>
        text.includes("WHERE c.id IN")
          ? [{ id: UUID_A, content: "Alice works at Acme Corp." }]
          : [],
    });
    const handler = createExtractHandler(deps);

    const result = await handler({
      chunk_ids: [UUID_A, UUID_B, UUID_B], // duplicate unknown id collapses
    });
    const body = parseBody(result);

    expect(body.processed).toBe(1);
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.missing_chunk_ids).toEqual([UUID_B]);
    // The unknown id never reached any write (it is only bound by the
    // SELECT that looked it up).
    expect(clients[0]!.writeBoundValues()).not.toContain(UUID_B);
    expect(clients[0]!.writeBoundValues()).toContain(UUID_A);
  });
});

describe("createExtractHandler — concurrent class", () => {
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("two overlapping calls on distinct chunks run isolated per-connection transactions", async () => {
    // Two prepared connections behind one shared pool: each extract call
    // leases its own, mirroring two pg pool clients. Within one call the
    // core pipeline already isolates chunks per transaction; this proves
    // the same holds ACROSS two overlapping tool calls (no shared client,
    // no scrambled statement streams).
    const chunkContent = (id: string) => `${id}: Alice works at Acme Corp.`;
    const { deps, clients } = makeHarness({
      llm: new FakeLLMClient({
        scripted: async () => ({
          kind: "ok" as const,
          outputs: [
            {
              ...GROUNDED_OUTPUT,
              evidenceSpan: "Alice works at Acme Corp",
            },
          ],
        }),
      }),
      rowsFor: (clientIndex, text) =>
        text.includes("WHERE c.id IN")
          ? [
              {
                id: clientIndex === 0 ? UUID_A : UUID_B,
                content: chunkContent(clientIndex === 0 ? UUID_A : UUID_B),
              },
            ]
          : [],
      clientCount: 2,
    });
    const handler = createExtractHandler(deps);

    const [resultA, resultB] = await Promise.all([
      handler({ chunk_ids: [UUID_A] }),
      handler({ chunk_ids: [UUID_B] }),
    ]);
    const bodyA = parseBody(resultA);
    const bodyB = parseBody(resultB);

    expect(bodyA.processed).toBe(1);
    expect(bodyA.succeeded).toBe(1);
    expect(bodyA.failed).toBe(0);
    expect(bodyB.processed).toBe(1);
    expect(bodyB.succeeded).toBe(1);
    expect(bodyB.failed).toBe(0);

    // Each connection saw exactly one self-consistent chunk transaction
    // (delimited by the LAST BEGIN/COMMIT — the first call's connection
    // also ran the memoized schema bootstrap with its own transaction)
    // and never the other call's chunk id.
    for (const [client, ownId, otherId] of [
      [clients[0]!, UUID_A, UUID_B],
      [clients[1]!, UUID_B, UUID_A],
    ] as const) {
      const begin = client.lastIndexOf("BEGIN");
      const record = client.indexOf("INSERT INTO extraction_records");
      const commit = client.lastIndexOf("COMMIT");
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(begin < record && record < commit).toBe(true);
      expect(client.flatValues()).toContain(ownId);
      expect(client.flatValues()).not.toContain(otherId);
      // Transactions balance and nothing rolled back.
      expect(client.queries.filter((q) => q === "BEGIN")).toHaveLength(
        client.queries.filter((q) => q === "COMMIT").length
      );
      expect(client.indexOf("ROLLBACK")).toBe(-1);
    }
  });
});
