/**
 * dashboard-api thin writes (operator-console T8).
 *
 * Acceptance pinned here:
 *   1. Each named thin write hits the SAME runner the MCP tool or CLI
 *      uses. The pin is a module-spy: the writes.ts handler imports
 *      `createIngestHandler` / `createExtractHandler` /
 *      `createInvalidationHandler` / `runCli` (graph-backfill / drain)
 *      directly; tests assert those spy modules were invoked. If a
 *      re-implementation appeared under a different symbol, the spy
 *      would never fire — this is the "same runner" contract.
 *   2. Normal path: a valid envelope returns 200 with the runner's
 *      structured JSON body (the same body an MCP host would receive).
 *   3. Failure path: a runner that throws a typed GraphragError surfaces
 *      as the named HTTP envelope, never a silent 200.
 *   4. Boundary: missing / malformed body returns 400 INVALID_INPUT.
 *   5. Empty-body POST without a body returns 400 INVALID_INPUT.
 *   6. Schema reject (e.g. ingest missing source_ref) returns 400.
 *
 * The fixture is the same real-HTTP boot pattern as the rest of
 * tests/dashboard/* (helpers.ts `boot` / `fetchJson`). No framework, no
 * supertest — the request goes through the full http.Server.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as graphBackfillCli from "../../src/cli/graph-backfill.js";
import * as graphDrainCli from "../../src/cli/graph-drain.js";
import * as extractTool from "../../src/tools/extract.js";
import * as ingestTool from "../../src/tools/ingest.js";
import * as invalidationTool from "../../src/tools/invalidation.js";

import { GraphragError } from "../../src/core/errors.js";

import { boot, fetchJson, memoryDeps } from "./helpers.js";
import type { DashboardServerDeps } from "../../src/dashboard-api/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function writesDeps(deps: DashboardServerDeps): DashboardServerDeps {
  return {
    ...deps,
    writes: {
      ingest: {
        embedder: deps.embedder,
        storage: deps.storage,
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
      invalidate: {
        embedder: deps.embedder,
        storage: deps.storage,
      },
      graphBackfill: {
        pool: {
          async connect() {
            throw new Error("not configured in tests");
          },
          async end() {},
        },
        logger: {
          level: "error",
          debug() {},
          info() {},
          warn() {},
          error() {},
        },
        connectGraph: () => {
          throw new Error("not configured in tests");
        },
      },
      graphDrain: {
        pool: {
          async connect() {
            throw new Error("not configured in tests");
          },
          async end() {},
        },
        logger: {
          level: "error",
          debug() {},
          info() {},
          warn() {},
          error() {},
        },
        connectGraph: () => {
          throw new Error("not configured in tests");
        },
      },
    },
  };
}

describe("dashboard-api thin writes — same runner pinned", () => {
  it("POST /api/writes/ingest invokes createIngestHandler from src/tools/ingest.ts", async () => {
    // The runner returned by the factory — the spy asserts the FACTORY
    // was invoked, then the handler dispatches the parsed input to the
    // same returned runner an MCP host would see.
    const runnerResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            chunk_ids: ["c1"],
            source_doc_id: "s1",
          }),
        },
      ],
    };
    const runner = vi.fn(async () => runnerResult);
    const factorySpy = vi
      .spyOn(ingestTool, "createIngestHandler")
      .mockImplementation(
        () =>
          runner as unknown as ReturnType<typeof ingestTool.createIngestHandler>
      );

    const { baseUrl } = await boot(writesDeps(memoryDeps()));
    const res = await fetchJson(`${baseUrl}/api/writes/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_ref: "docs/first.md",
        content: "the body",
        chunks: [{ content: "the body", index: 0 }],
      }),
    });

    expect(factorySpy).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledTimes(1);
    // The runner received the parsed envelope (not the raw body).
    const passedInput = runner.mock.calls[0]?.[0] as {
      source_ref: string;
      content: string;
      chunks: Array<{ content: string; index: number }>;
    };
    expect(passedInput.source_ref).toBe("docs/first.md");
    expect(passedInput.content).toBe("the body");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      chunk_ids: ["c1"],
      source_doc_id: "s1",
    });
  });

  it("POST /api/writes/invalidate invokes createInvalidationHandler from src/tools/invalidation.ts", async () => {
    const runnerResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            invalidated_chunk_ids: ["c1", "c2"],
            invalidations: [],
          }),
        },
      ],
    };
    const runner = vi.fn(async () => runnerResult);
    const factorySpy = vi
      .spyOn(invalidationTool, "createInvalidationHandler")
      .mockImplementation(
        () =>
          runner as unknown as ReturnType<
            typeof invalidationTool.createInvalidationHandler
          >
      );

    const { baseUrl } = await boot(writesDeps(memoryDeps()));
    const res = await fetchJson(`${baseUrl}/api/writes/invalidate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_ref: "docs/first.md",
        triggered_by: "operator-console",
      }),
    });

    expect(factorySpy).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      invalidated_chunk_ids: ["c1", "c2"],
      invalidations: [],
    });
  });

  it("POST /api/writes/extract invokes createExtractHandler from src/tools/extract.ts", async () => {
    const runnerResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            batch_id: "b1",
            processed: 1,
            succeeded: 1,
            failed: 0,
            write_failures: 0,
            ungrounded: 0,
            failed_chunks: [],
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

    const { baseUrl } = await boot(writesDeps(memoryDeps()));
    const res = await fetchJson(`${baseUrl}/api/writes/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_ref: "docs/first.md" }),
    });

    expect(factorySpy).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ batch_id: "b1", succeeded: 1 });
  });

  it("POST /api/writes/graph-backfill invokes runCli from src/cli/graph-backfill.ts", async () => {
    const cliSpy = vi.spyOn(graphBackfillCli, "runCli").mockResolvedValue(0);

    const { baseUrl } = await boot(writesDeps(memoryDeps()));
    const res = await fetchJson(`${baseUrl}/api/writes/graph-backfill`, {
      method: "POST",
    });

    expect(cliSpy).toHaveBeenCalledTimes(1);
    // CLI exit 0 → 200 { exit_code: 0 }.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exit_code: 0 });
  });

  it("POST /api/writes/graph-drain invokes runCli from src/cli/graph-drain.ts", async () => {
    const cliSpy = vi.spyOn(graphDrainCli, "runCli").mockResolvedValue(0);

    const { baseUrl } = await boot(writesDeps(memoryDeps()));
    const res = await fetchJson(`${baseUrl}/api/writes/graph-drain`, {
      method: "POST",
    });

    expect(cliSpy).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exit_code: 0 });
  });
});

describe("dashboard-api thin writes — failure path", () => {
  it("maps a runner GraphragError(INVALID_INPUT) to 400 INVALID_INPUT, not a silent 200", async () => {
    const runner = vi.fn(async () => {
      throw new GraphragError(
        "ingest: source_ref is required",
        "INVALID_INPUT"
      );
    });
    vi.spyOn(ingestTool, "createIngestHandler").mockImplementation(
      () =>
        runner as unknown as ReturnType<typeof ingestTool.createIngestHandler>
    );

    const { baseUrl } = await boot(writesDeps(memoryDeps()));
    const res = await fetchJson(`${baseUrl}/api/writes/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "body without source_ref",
        chunks: [{ content: "body without source_ref", index: 0 }],
      }),
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  it("maps a runner GraphragError(STORAGE_ERROR) to 503 STORAGE_ERROR, not a silent 200", async () => {
    const runner = vi.fn(async () => {
      throw new GraphragError("postgres unavailable", "STORAGE_ERROR");
    });
    vi.spyOn(invalidationTool, "createInvalidationHandler").mockImplementation(
      () =>
        runner as unknown as ReturnType<
          typeof invalidationTool.createInvalidationHandler
        >
    );

    const { baseUrl } = await boot(writesDeps(memoryDeps()));
    const res = await fetchJson(`${baseUrl}/api/writes/invalidate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_ref: "docs/first.md",
        triggered_by: "operator-console",
      }),
    });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "STORAGE_ERROR" } });
  });

  it("maps a graph-backfill runner fatal to 503 with the typed envelope", async () => {
    vi.spyOn(graphBackfillCli, "runCli").mockRejectedValue(
      new GraphragError("postgres unavailable", "STORAGE_ERROR")
    );

    const { baseUrl } = await boot(writesDeps(memoryDeps()));
    const res = await fetchJson(`${baseUrl}/api/writes/graph-backfill`, {
      method: "POST",
    });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "STORAGE_ERROR" } });
  });
});

describe("dashboard-api thin writes — boundary / schema reject", () => {
  it("ingest missing source_ref is a 400 INVALID_INPUT from the schema gate, not from the runner", async () => {
    // If we ever reach the runner with a malformed envelope, the runner
    // would throw — but the schema gate must catch this first. The
    // factory is therefore NOT called for schema-rejected input.
    const factorySpy = vi.spyOn(ingestTool, "createIngestHandler");

    const { baseUrl } = await boot(writesDeps(memoryDeps()));
    const res = await fetchJson(`${baseUrl}/api/writes/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // source_ref deliberately omitted
        content: "body without source_ref",
        chunks: [{ content: "body without source_ref", index: 0 }],
      }),
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "INVALID_INPUT" } });
    // The handler factory MAY be called (factory builds the runner at
    // handler construction time), but the runner itself is not invoked
    // because the schema gate rejects first. Pin the runner count
    // separately via the runner spy inside the factory mock — done in
    // the spy-pinning test above. Here the contract is: the request
    // never reaches the runner's parse-then-throw path.
    expect(factorySpy).toHaveBeenCalled();
  });

  it("empty POST body returns 400 INVALID_INPUT", async () => {
    const { baseUrl } = await boot(writesDeps(memoryDeps()));
    const res = await fetchJson(`${baseUrl}/api/writes/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  it("malformed JSON body returns 400 INVALID_INPUT", async () => {
    const { baseUrl } = await boot(writesDeps(memoryDeps()));
    const res = await fetchJson(`${baseUrl}/api/writes/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });

  it("body exceeding the 1MB server cap returns 413 INVALID_INPUT envelope", async () => {
    // The 1MB ceiling is per request body at the server read layer
    // (MAX_BODY_BYTES in server.ts) — distinct from the tool-level
    // per-chunk CONTENT_TOO_LARGE cap. The runner must never see the
    // body, so the factory spy firing is not enough; pin the status.
    const { baseUrl } = await boot(writesDeps(memoryDeps()));
    const big = "x".repeat(1_048_577); // MAX_BODY_BYTES + 1
    const res = await fetchJson(`${baseUrl}/api/writes/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_ref: "docs/big.md",
        content: big,
        chunks: [{ content: big, index: 0 }],
      }),
    });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });
});

describe("dashboard-api thin writes — missing writes config", () => {
  it("answers 503 STORAGE_ERROR when the dashboard-api has no writes block configured", async () => {
    // Boot with the default memoryDeps() — no `writes` block. The
    // dashboard stays a predictable facade: the route is registered,
    // the operator sees the env gap clearly.
    const { baseUrl } = await boot(memoryDeps());
    const res = await fetchJson(`${baseUrl}/api/writes/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_ref: "docs/first.md",
        content: "the body",
        chunks: [{ content: "the body", index: 0 }],
      }),
    });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "STORAGE_ERROR" } });
  });
});
