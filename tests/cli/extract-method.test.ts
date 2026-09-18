/**
 * T1 (graph-index-standard-fast): extract CLI `--method` / `--source-ref`.
 *
 * Pins the version-spine surface of the CLI:
 *   - `--method standard|fast` and `--source-ref REF` parse; anything else is
 *     a usage error (exit 2), consistent with the file's flag-conflict doctrine.
 *   - `--source-ref` swaps the pending scan for the per-source selector.
 *   - the requested method reaches the shared pipeline seam: standard routes
 *     to the LLM, the sealed fast leg fails per chunk (mark-and-continue, so
 *     exit stays 0) without ever dialing the LLM.
 *
 * Same no-live-DB posture as extract.unit.test.ts: a recording FakeClient.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  parseArgs,
  runCli,
  type CliClient,
  type CliDeps,
  type CliPool,
} from "../../src/cli/extract.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import { FakeEmbedder } from "../../src/core/embedder.js";
import { FAST_EXTRACT_UNIMPLEMENTED_CODE } from "../../src/core/extraction/method.js";

const ANN_MAX_DIMENSIONS_VAR = "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS";
const savedAnnMaxDimensions = process.env[ANN_MAX_DIMENSIONS_VAR];

beforeAll(() => {
  process.env[ANN_MAX_DIMENSIONS_VAR] = "2000";
});

afterAll(() => {
  if (savedAnnMaxDimensions === undefined) {
    delete process.env[ANN_MAX_DIMENSIONS_VAR];
  } else {
    process.env[ANN_MAX_DIMENSIONS_VAR] = savedAnnMaxDimensions;
  }
});

class FakeClient implements CliClient {
  queries: string[] = [];
  valuesList: unknown[][] = [];
  rowsOverride?: (text: string) => unknown[];
  async query(text: string, values?: unknown[]) {
    this.queries.push(text);
    this.valuesList.push(values ?? []);
    const rows = this.rowsOverride ? this.rowsOverride(text) : [];
    return { rows };
  }
  release(): void {}
}

function makeDeps(client: FakeClient, llm: FakeLLMClient): CliDeps {
  const pool: CliPool = {
    async connect() {
      return client;
    },
    async end() {},
  };
  return {
    pool,
    llm,
    embedder: new FakeEmbedder(8),
    dims: 8,
    logger: {
      level: "error",
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    now: () => "2026-09-01T00:00:00.000Z",
  };
}

const CHUNK_ROW = {
  id: "00000000-0000-4000-8000-000000000001",
  content: "Alice works at Acme Corp.",
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

describe("--method / --source-ref parsing", () => {
  it("accepts the two method values", () => {
    expect(parseArgs(["--method", "standard"])).toMatchObject({
      ok: true,
      flags: { method: "standard" },
    });
    expect(parseArgs(["--method", "fast"])).toMatchObject({
      ok: true,
      flags: { method: "fast" },
    });
  });

  it("method defaults to null (the pipeline reads that as standard)", () => {
    expect(parseArgs([])).toMatchObject({ ok: true, flags: { method: null } });
  });

  it("rejects an unknown method value", () => {
    expect(parseArgs(["--method", "turbo"])).toMatchObject({ ok: false });
    expect(parseArgs(["--method"])).toMatchObject({ ok: false });
  });

  it("accepts --source-ref and rejects an empty or missing value", () => {
    expect(parseArgs(["--source-ref", "doc-1"])).toMatchObject({
      ok: true,
      flags: { sourceRef: "doc-1" },
    });
    expect(parseArgs(["--source-ref", ""])).toMatchObject({ ok: false });
    expect(parseArgs(["--source-ref"])).toMatchObject({ ok: false });
  });

  it("unknown method on the wire exits 2 without touching the connection", async () => {
    const client = new FakeClient();
    const code = await runCli(
      ["--method", "turbo"],
      makeDeps(client, new FakeLLMClient({ queue: [] }))
    );
    expect(code).toBe(2);
    expect(client.queries).toEqual([]);
  });
});

describe("flag conflicts with report modes (usage error, exit 2)", () => {
  const cases: string[][] = [
    ["--method", "fast", "--list-unmapped"],
    ["--method", "fast", "--list-failed"],
    ["--method", "fast", "--backfill-embeddings"],
    ["--source-ref", "doc-1", "--list-unmapped"],
    ["--source-ref", "doc-1", "--list-failed"],
    ["--source-ref", "doc-1", "--since", "2026-01-01T00:00:00Z"],
    ["--source-ref", "doc-1", "--only-failed"],
  ];

  for (const argv of cases) {
    it(`${argv.join(" ")} → 2`, async () => {
      const client = new FakeClient();
      const code = await runCli(
        argv,
        makeDeps(client, new FakeLLMClient({ queue: [] }))
      );
      expect(code).toBe(2);
      expect(client.queries).toEqual([]);
    });
  }
});

describe("runCli --source-ref selector", () => {
  it("scans pending chunks by source_ref and records standard on success", async () => {
    const client = new FakeClient();
    client.rowsOverride = (text) =>
      /FROM chunks c/.test(text) ? [CHUNK_ROW] : [];
    const llm = new FakeLLMClient({
      queue: [{ kind: "ok", outputs: [GROUNDED_OUTPUT] }],
    });

    const code = await runCli(
      ["--source-ref", "doc-1", "--batch-size", "1"],
      makeDeps(client, llm)
    );

    expect(code).toBe(0);
    const scan = client.queries.find((q) => q.includes("c.source_ref = $1"));
    expect(scan, "source_ref scan not emitted").toBeDefined();
    // The success leg claims the version for the default method.
    const recordIdx = client.queries.findIndex((q) =>
      q.includes("UPDATE source_documents")
    );
    expect(recordIdx).toBeGreaterThanOrEqual(0);
    expect(client.valuesList[recordIdx]).toEqual([CHUNK_ROW.id, "standard"]);
  });
});

describe("runCli --method fast (sealed)", () => {
  it("fails each chunk with FAST_EXTRACT_UNIMPLEMENTED without an LLM call; exit stays 0 (mark-and-continue)", async () => {
    const client = new FakeClient();
    client.rowsOverride = (text) =>
      /FROM chunks c/.test(text) ? [CHUNK_ROW] : [];
    // Empty queue: any LLM call throws "queue exhausted".
    const llm = new FakeLLMClient({ queue: [] });

    const code = await runCli(
      ["--method", "fast", "--batch-size", "1"],
      makeDeps(client, llm)
    );

    expect(code).toBe(0);
    const failedIdx = client.queries.findIndex((q) =>
      q.includes("SET status = 'failed'")
    );
    expect(failedIdx).toBeGreaterThanOrEqual(0);
    expect(client.valuesList[failedIdx]).toContain(
      FAST_EXTRACT_UNIMPLEMENTED_CODE
    );
    // The sealed leg never records a method onto the version.
    expect(
      client.queries.find((q) => q.includes("UPDATE source_documents"))
    ).toBeUndefined();
  });

  it("--method fast --dry-run reports the would-fail leg, dials no LLM, writes nothing", async () => {
    const client = new FakeClient();
    client.rowsOverride = (text) =>
      /FROM chunks c/.test(text) ? [CHUNK_ROW] : [];
    const llm = new FakeLLMClient({ queue: [] });

    const code = await runCli(
      ["--method", "fast", "--dry-run", "--batch-size", "1"],
      makeDeps(client, llm)
    );

    expect(code).toBe(0);
    const writes = client.queries.filter((q) =>
      /^\s*(INSERT|UPDATE|DELETE)\s/i.test(q)
    );
    expect(writes).toEqual([]);
  });
});
