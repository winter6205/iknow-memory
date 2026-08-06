/**
 * Unit tests for `runCli` (T6):
 *   - Unknown flag → exit code 2.
 *   - `--dry-run --batch-size 1` against an empty chunks table → exit 0,
 *     and no INSERT/UPDATE/DELETE rows touch the DB (writes = none).
 *   - `--list-unmapped` → no LLM call, exit 0.
 *
 * The fake pool records every query so assertions can assert "zero INSERTs"
 * without any real Postgres or subprocess involvement.
 */
import { describe, it, expect } from "vitest";

import {
  runCli,
  type CliClient,
  type CliPool,
  type CliDeps,
} from "../../src/cli/extract.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import { FakeEmbedder } from "../../src/core/embedder.js";

class FakeClient implements CliClient {
  queries: string[] = [];
  valuesList: unknown[][] = [];
  /** Optional per-query row override; receives the SQL text. */
  rowsOverride?: (text: string) => unknown[];
  async query(text: string, values?: unknown[]) {
    this.queries.push(text);
    // Always push (even when undefined) so valuesList[i] stays in lockstep
    // with queries[i] — queries without bound params still occupy a slot.
    this.valuesList.push(values ?? []);
    const rows = this.rowsOverride ? this.rowsOverride(text) : [];
    return { rows };
  }
  release(): void {}
}

function makePool(client: FakeClient): CliPool {
  return {
    async connect() {
      return client;
    },
    async end() {},
  };
}

function silentLogger() {
  // Silence the stderr-bound lines the CLI writes under --list-unmapped /
  // pipeline completion so the test output stays clean.
  return {
    level: "error" as const,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makeDeps(client: FakeClient, llm: FakeLLMClient): CliDeps {
  return {
    pool: makePool(client),
    llm,
    embedder: new FakeEmbedder(8),
    dims: 8,
    logger: silentLogger(),
    now: () => "2026-08-07T00:00:00.000Z",
  };
}

describe("runCli — flag parsing", () => {
  it("unknown flag → exit code 2", async () => {
    const client = new FakeClient();
    const llm = new FakeLLMClient({ queue: [] });
    const deps = makeDeps(client, llm);
    const code = await runCli(["--no-such-flag"], deps);
    expect(code).toBe(2);
  });

  it("--batch-size requires a positive integer; otherwise exit 2", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client, new FakeLLMClient({ queue: [] }));
    const code = await runCli(["--batch-size", "abc"], deps);
    expect(code).toBe(2);
  });

  it("--since requires ISO8601; otherwise exit 2", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client, new FakeLLMClient({ queue: [] }));
    const code = await runCli(["--since", "not-a-date"], deps);
    expect(code).toBe(2);
  });
});

describe("runCli --dry-run", () => {
  it("writes no rows and exits 0 against an empty chunks table", async () => {
    const client = new FakeClient();
    // Scripted FakeLLMClient that records a call counter; we expect zero calls
    // here because the scan returns no chunks so extractChunk is never invoked.
    let extractCalls = 0;
    const llm = new FakeLLMClient({
      scripted: async () => {
        extractCalls += 1;
        return { kind: "ok", outputs: [] };
      },
    });
    const deps = makeDeps(client, llm);
    const code = await runCli(["--dry-run", "--batch-size", "1"], deps);
    expect(code).toBe(0);
    expect(extractCalls).toBe(0);

    // Zero writes: no INSERT, UPDATE, or DELETE statements observed.
    const writes = client.queries.filter((q) =>
      /^\s*(INSERT|UPDATE|DELETE)/i.test(q)
    );
    expect(writes).toEqual([]);
  });
});

describe("runCli --list-unmapped", () => {
  it("does not invoke the LLM and exits 0", async () => {
    const client = new FakeClient();
    let extractCalls = 0;
    const llm = new FakeLLMClient({
      scripted: async () => {
        extractCalls += 1;
        return { kind: "ok", outputs: [] };
      },
    });
    const deps = makeDeps(client, llm);
    const code = await runCli(["--list-unmapped"], deps);
    expect(code).toBe(0);
    expect(extractCalls).toBe(0);
  });
});

describe("entity-type normalization through the pipeline (CR High #2)", () => {
  it("persists a CHECK-safe type when the LLM emits 'Organization'", async () => {
    const client = new FakeClient();
    const llm = new FakeLLMClient({
      scripted: async () => ({
        kind: "ok" as const,
        // Realistic LLM output: open-string, capitalized, non-listed type that
        // would previously violate the DDL CHECK and roll back the chunk.
        outputs: [
          {
            head: "Alice",
            headType: "Organization", // → concept
            relationRaw: "works at",
            relationNorm: "MEMBER_OF",
            tail: "Acme",
            tailType: "Location", // → system
            description: "Alice works at Acme",
            evidenceSpan: "Alice works at Acme",
            confidence: 0.9,
          },
        ],
      }),
    });
    // The scan must return one chunk so persistOutputs runs.
    client.rowsOverride = (text) =>
      /FROM chunks c/.test(text)
        ? [{ id: "00000000-0000-4000-8000-000000000000", content: "x" }]
        : [];

    const deps = makeDeps(client, llm);
    const code = await runCli(["--batch-size", "1"], deps);

    expect(code).toBe(0);

    // Capture the INSERT INTO entities … VALUES calls and assert the persisted
    // type is in the closed CHECK set (never the raw "Organization"). Queries
    // and valuesList are pushed in lockstep so we can zip them.
    const entityInserts: unknown[][] = [];
    for (let i = 0; i < client.queries.length; i += 1) {
      if (client.queries[i]?.includes("INSERT INTO entities")) {
        entityInserts.push(client.valuesList[i] ?? []);
      }
    }
    expect(entityInserts.length).toBeGreaterThanOrEqual(2);
    const closedSet = ["person", "concept", "system", "event"];
    for (const values of entityInserts) {
      const type = values[2] as string; // (id, canonical_name, type, …)
      expect(closedSet).toContain(type);
    }
    // The wonky types were folded to their mapped families.
    const persistedTypes = entityInserts.map((v) => v[2]);
    expect(persistedTypes).toContain("concept"); // Organization
    expect(persistedTypes).toContain("system"); // Location
  });
});
