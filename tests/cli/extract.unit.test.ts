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
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";

import {
  loadEntities,
  parseArgs,
  runCli,
  type CliClient,
  type CliPool,
  type CliDeps,
} from "../../src/cli/extract.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import { FakeEmbedder, type EmbeddingClient } from "../../src/core/embedder.js";
import { computeEntityEmbeddingText } from "../../src/core/entities/embedding.js";
import { ALLOWED } from "../../src/core/extraction/vocabulary.js";

const ANN_MAX_DIMENSIONS_VAR = "GRAPHRAG_MEMORY_PGVECTOR_ANN_MAX_DIMENSIONS";
const savedAnnMaxDimensions = process.env[ANN_MAX_DIMENSIONS_VAR];

beforeAll(() => {
  process.env[ANN_MAX_DIMENSIONS_VAR] = "2000";
});

afterAll(() => {
  if (savedAnnMaxDimensions === undefined)
    delete process.env[ANN_MAX_DIMENSIONS_VAR];
  else process.env[ANN_MAX_DIMENSIONS_VAR] = savedAnnMaxDimensions;
});

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

  it("does not emit a PostgreSQL password in a direct fatal stderr path", async () => {
    const secret = "extract-postgres-secret";
    const client = new FakeClient();
    client.rowsOverride = () => {
      throw new Error(
        `driver failed for postgresql://ci-user:${secret}@db.example.test:5432/graph`
      );
    };
    const output: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        output.push(String(chunk));
        return true;
      });

    try {
      expect(
        await runCli(
          ["--dry-run"],
          makeDeps(client, new FakeLLMClient({ queue: [] }))
        )
      ).toBe(1);
    } finally {
      stderr.mockRestore();
    }

    expect(output.join("")).not.toContain(secret);
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

// ─── F2: mode-flag mutual exclusion (usage error, exit 2) ────────────────

/** Every pair the parser must refuse, with the message it must name it by. */
const MUTEX_PAIRS: Array<[string, string]> = [
  ["--dry-run", "--backfill-embeddings"],
  ["--list-unmapped", "--list-failed"],
  ["--list-unmapped", "--backfill-embeddings"],
  ["--list-failed", "--backfill-embeddings"],
];

describe("mutually exclusive flags are a usage error (F2)", () => {
  it("each conflicting pair exits 2 and touches no connection", async () => {
    for (const pair of MUTEX_PAIRS) {
      const client = new FakeClient();
      const deps = makeDeps(client, throwingLlm());

      expect(await runCli(pair, deps)).toBe(2);
      expect(await runCli([...pair].reverse(), deps)).toBe(2);
      expect(client.queries).toEqual([]);
    }
  });

  it("names both flags in the usage error rather than silently preferring one", () => {
    for (const [a, b] of MUTEX_PAIRS) {
      expect(parseArgs([a, b])).toEqual({
        ok: false,
        error: `${a} and ${b} are mutually exclusive`,
      });
    }
  });

  it("--dry-run alone still parses and writes nothing (unregressed)", async () => {
    const client = new FakeClient();
    scanOneChunk(client);
    const llm = new FakeLLMClient({
      scripted: async () => ({ kind: "ok" as const, outputs: [ALICE_OUTPUT] }),
    });

    const code = await runCli(
      ["--dry-run", "--batch-size", "1"],
      makeDeps(client, llm)
    );

    expect(code).toBe(0);
    const writes = client.queries.filter((q) =>
      /^\s*(INSERT|UPDATE|DELETE)\s/i.test(q)
    );
    expect(writes).toEqual([]);
  });

  it("each mode flag on its own is still accepted", () => {
    for (const flag of [
      "--dry-run",
      "--list-unmapped",
      "--list-failed",
      "--backfill-embeddings",
    ]) {
      expect(parseArgs([flag])).toMatchObject({ ok: true });
    }
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

// ─── T1: embedding + metadata.description + entity_aliases (G1/G4/G6) ────

/** Collect the bound values of every query whose SQL matches `pattern`. */
function boundValuesFor(client: FakeClient, pattern: RegExp): unknown[][] {
  const out: unknown[][] = [];
  for (let i = 0; i < client.queries.length; i += 1) {
    if (pattern.test(client.queries[i] ?? "")) {
      out.push(client.valuesList[i] ?? []);
    }
  }
  return out;
}

/** SQL text of the first query matching `pattern` (empty string when absent). */
function sqlFor(client: FakeClient, pattern: RegExp): string {
  return client.queries.find((q) => pattern.test(q)) ?? "";
}

const ALICE_OUTPUT = {
  head: "Alice Smith",
  headType: "person",
  relationRaw: "works at",
  relationNorm: "MEMBER_OF",
  tail: "Acme Corp",
  tailType: "system",
  description: "Alice Smith works at Acme Corp",
  evidenceSpan: "Alice Smith works at Acme Corp",
  confidence: 0.9,
};

/** One chunk to scan, so persistOutputs runs on the scripted output. */
function scanOneChunk(client: FakeClient, rows: unknown[] = []): void {
  client.rowsOverride = (text) =>
    /FROM chunks c/.test(text)
      ? [{ id: "00000000-0000-4000-8000-000000000000", content: "x" }]
      : /FROM entities/.test(text)
        ? rows
        : [];
}

describe("entity persistence writes the #6 Q1 embedding and the description", () => {
  it("INSERT INTO entities carries the embedding vector and metadata.description", async () => {
    const client = new FakeClient();
    scanOneChunk(client);
    const llm = new FakeLLMClient({
      scripted: async () => ({ kind: "ok" as const, outputs: [ALICE_OUTPUT] }),
    });
    const deps = makeDeps(client, llm);

    const code = await runCli(["--batch-size", "1"], deps);
    expect(code).toBe(0);

    const inserts = boundValuesFor(client, /INSERT INTO entities/);
    expect(inserts).toHaveLength(2); // head + tail

    // The vector is embedded from the SSOT text, never inline concatenation.
    const [expectedVector] = await new FakeEmbedder(8).embed([
      computeEntityEmbeddingText(ALICE_OUTPUT.head, ALICE_OUTPUT.description),
    ]);
    const headValues = inserts[0]!;
    expect(headValues[1]).toBe(ALICE_OUTPUT.head);
    expect(headValues[3]).toBe(`[${expectedVector!.join(",")}]`);
    expect(JSON.parse(headValues[4] as string)).toEqual({
      description: ALICE_OUTPUT.description,
    });

    // The column list and the pgvector cast must both be present, otherwise
    // the literal lands in `metadata` or Postgres rejects the text value.
    const sql = sqlFor(client, /INSERT INTO entities/);
    expect(sql).toContain("embedding");
    expect(sql).toContain("::vector");
  });

  it("embeds once per created entity and leaves an L0 survivor untouched (A8)", async () => {
    const client = new FakeClient();
    scanOneChunk(client, [
      {
        id: "11111111-1111-4111-8111-111111111111",
        canonical_name: "Alice Smith",
        type: "person",
        embedding: null,
        description: "Alice Smith works at Acme Corp",
      },
    ]);
    const llm = new FakeLLMClient({
      scripted: async () => ({ kind: "ok" as const, outputs: [ALICE_OUTPUT] }),
    });
    // The head merges into the survivor (L0) and the tail's type has no
    // candidate, so no gate embeds: every embed call belongs to an insert.
    const inner = new FakeEmbedder(8);
    let embedCalls = 0;
    const deps: CliDeps = {
      ...makeDeps(client, llm),
      embedder: {
        embed: async (texts: string[]) => {
          embedCalls += 1;
          return inner.embed(texts);
        },
      },
    };

    const code = await runCli(["--batch-size", "1"], deps);
    expect(code).toBe(0);

    // A8 first-write-wins: the L0 survivor keeps its row untouched — only the
    // tail entity is created, and it is embedded exactly once.
    const inserts = boundValuesFor(client, /INSERT INTO entities/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![1]).toBe(ALICE_OUTPUT.tail);
    expect(embedCalls).toBe(1);
    const updates = client.queries.filter((q) => /UPDATE entities/i.test(q));
    expect(updates).toEqual([]);
  });
});

describe("entity_aliases producer (A11)", () => {
  it("creation writes an alias_type='name' row that tolerates a re-insert", async () => {
    const client = new FakeClient();
    scanOneChunk(client);
    const llm = new FakeLLMClient({
      scripted: async () => ({ kind: "ok" as const, outputs: [ALICE_OUTPUT] }),
    });
    const deps = makeDeps(client, llm);

    const code = await runCli(["--batch-size", "1"], deps);
    expect(code).toBe(0);

    const aliases = boundValuesFor(client, /INSERT INTO entity_aliases/);
    expect(aliases.map((v) => [v[2], v[3]])).toEqual([
      [ALICE_OUTPUT.head, "name"],
      [ALICE_OUTPUT.tail, "name"],
    ]);
    // Each alias row carries its own minted PK, and the entity id it points at
    // is the id the entity INSERT used.
    const entityIds = boundValuesFor(client, /INSERT INTO entities/).map(
      (v) => v[0]
    );
    expect(aliases.map((v) => v[1])).toEqual(entityIds);

    const sql = sqlFor(client, /INSERT INTO entity_aliases/);
    expect(sql).toMatch(/ON CONFLICT \(entity_id, alias\) DO NOTHING/);
  });

  it("an L0 merge with a differing surface form writes an alias_type='variant' row", async () => {
    const client = new FakeClient();
    const survivorId = "11111111-1111-4111-8111-111111111111";
    scanOneChunk(client, [
      {
        id: survivorId,
        canonical_name: "Alice Smith",
        type: "person",
        embedding: null,
        description: "Alice Smith works at Acme Corp",
      },
    ]);
    const llm = new FakeLLMClient({
      scripted: async () => ({
        kind: "ok" as const,
        // Same normalized name (L0 merges), different surface form.
        outputs: [{ ...ALICE_OUTPUT, head: "alice   smith" }],
      }),
    });
    const deps = makeDeps(client, llm);

    const code = await runCli(["--batch-size", "1"], deps);
    expect(code).toBe(0);

    const aliases = boundValuesFor(client, /INSERT INTO entity_aliases/);
    expect(aliases.map((v) => [v[1], v[2], v[3]])).toContainEqual([
      survivorId,
      "alice   smith",
      "variant",
    ]);
  });

  it("an L0 merge with an identical surface form writes no variant row", async () => {
    const client = new FakeClient();
    scanOneChunk(client, [
      {
        id: "11111111-1111-4111-8111-111111111111",
        canonical_name: "Alice Smith",
        type: "person",
        embedding: null,
        description: "Alice Smith works at Acme Corp",
      },
    ]);
    const llm = new FakeLLMClient({
      scripted: async () => ({ kind: "ok" as const, outputs: [ALICE_OUTPUT] }),
    });
    const deps = makeDeps(client, llm);

    const code = await runCli(["--batch-size", "1"], deps);
    expect(code).toBe(0);

    const aliasTypes = boundValuesFor(client, /INSERT INTO entity_aliases/).map(
      (v) => v[3]
    );
    expect(aliasTypes).not.toContain("variant");
  });
});

describe("loadEntities read half (A13)", () => {
  it("returns the stored embedding and metadata description", async () => {
    const client = new FakeClient();
    client.rowsOverride = () => [
      {
        id: "11111111-1111-4111-8111-111111111111",
        canonical_name: "Alice Smith",
        type: "person",
        embedding: "[0.5,-0.25,0.125]",
        description: "Alice Smith works at Acme Corp",
      },
    ];

    const candidates = await loadEntities(client);

    expect(candidates).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        canonicalName: "Alice Smith",
        type: "person",
        description: "Alice Smith works at Acme Corp",
        embedding: [0.5, -0.25, 0.125],
      },
    ]);
  });

  it("omits the embedding for a row that has none and defaults the description", async () => {
    const client = new FakeClient();
    client.rowsOverride = () => [
      {
        id: "11111111-1111-4111-8111-111111111111",
        canonical_name: "Alice Smith",
        type: "person",
        embedding: null,
        description: null,
      },
    ];

    const candidates = await loadEntities(client);

    expect(candidates[0]?.embedding).toBeUndefined();
    expect(candidates[0]?.description).toBe("");
  });
});

// ─── F1: same-output head/tail merge-candidate mutual exclusion (SC6) ────

/**
 * Every text embeds to the same unit vector, so L2 clears its floor and L3
 * sees cosine 1.0 — the unconditional merge the self-loop regression needs.
 */
class ConstantEmbedder implements EmbeddingClient {
  constructor(private readonly dimensions: number) {}
  async embed(texts: string[]): Promise<number[][]> {
    const unit = new Array<number>(this.dimensions).fill(
      1 / Math.sqrt(this.dimensions)
    );
    return texts.map(() => [...unit]);
  }
}

/**
 * Serve the run its own already-INSERTed entity rows back through the
 * `loadEntities` SELECT (plus any pre-existing `seed` rows), so the tail of a
 * triple sees the head as a live merge candidate — the shape the self-loop
 * needs. The fake records each query before consulting this override, so the
 * head's INSERT is already visible by the time the tail's SELECT runs.
 */
function serveOwnEntityWrites(client: FakeClient, seed: unknown[] = []): void {
  client.rowsOverride = (text) => {
    if (/FROM chunks c/.test(text)) {
      return [{ id: "00000000-0000-4000-8000-000000000000", content: "x" }];
    }
    if (/^\s*SELECT[\s\S]*FROM entities/.test(text)) {
      return [...seed, ...insertedEntityRows(client)];
    }
    return [];
  };
}

/** The run's own `INSERT INTO entities` calls, shaped as loader rows. */
function insertedEntityRows(client: FakeClient): unknown[] {
  return boundValuesFor(client, /INSERT INTO entities/).map((v) => ({
    id: v[0],
    canonical_name: v[1],
    type: v[2],
    embedding: v[3],
    description: (JSON.parse(v[4] as string) as { description: string })
      .description,
  }));
}

/** Include persisted merge pointers when serving fake entity rows. */
function insertedEntityRowsWithMergePointers(client: FakeClient): unknown[] {
  return insertedEntityRows(client).map((row) => {
    const id = (row as { id: string }).id;
    const pointer = boundValuesFor(
      client,
      /UPDATE entities SET merged_into/
    ).find((values) => values[0] === id)?.[1];
    return { ...row, merged_into: pointer ?? null };
  });
}

/** Serve a survivor plus the rows written by the run, including pointers. */
function serveMergePersistenceRows(
  client: FakeClient,
  survivor: unknown
): void {
  client.rowsOverride = (text) => {
    if (/SELECT merged_into FROM entities WHERE id = \$1/.test(text)) {
      const id = client.valuesList.at(-1)?.[0];
      const rows = [survivor, ...insertedEntityRowsWithMergePointers(client)];
      return rows
        .filter((row) => (row as { id: string }).id === id)
        .map((row) => ({
          merged_into:
            (row as { merged_into?: string | null }).merged_into ?? null,
        }));
    }
    if (/FROM chunks c/.test(text)) {
      return [{ id: "00000000-0000-4000-8000-000000000000", content: "x" }];
    }
    if (/^\s*SELECT[\s\S]*FROM entities/.test(text)) {
      return [survivor, ...insertedEntityRowsWithMergePointers(client)];
    }
    return [];
  };
}

/** A live person row as `loadEntities` reads it back. */
function personRow(id: string, canonicalName: string) {
  return {
    id,
    canonical_name: canonicalName,
    type: "person",
    embedding: null,
    description: SELF_LOOP_OUTPUT.description,
  };
}

/** head and tail share a type AND the one description the LLM emitted. */
const SELF_LOOP_OUTPUT = {
  head: "Alice Smith",
  headType: "person",
  relationRaw: "mentors",
  relationNorm: "knows",
  tail: "Alicia Smith",
  tailType: "person",
  description: "Alice Smith mentors Alicia Smith on the billing platform",
  evidenceSpan: "Alice Smith mentors Alicia Smith",
  confidence: 0.9,
};

/** Run one output against `seed` live rows; returns the fake client. */
async function runOutput(
  output: typeof SELF_LOOP_OUTPUT,
  seed: unknown[] = []
): Promise<FakeClient> {
  const client = new FakeClient();
  serveOwnEntityWrites(client, seed);
  const llm = new FakeLLMClient({
    scripted: async () => ({
      kind: "ok" as const,
      outputs: [output],
    }),
  });
  const deps: CliDeps = {
    ...makeDeps(client, llm),
    embedder: new ConstantEmbedder(8),
  };
  const code = await runCli(["--batch-size", "1"], deps);
  expect(code).toBe(0);
  return client;
}

/** Run the self-loop output against `seed` live rows; returns the fake client. */
async function runSelfLoopOutput(seed: unknown[] = []): Promise<FakeClient> {
  return runOutput(SELF_LOOP_OUTPUT, seed);
}

/** `(head_id, tail_id)` of every triple the run upserted. */
function upsertedEndpoints(client: FakeClient): Array<[string, string]> {
  return boundValuesFor(client, /INSERT INTO triples/).map((v) => [
    v[1] as string,
    v[2] as string,
  ]);
}

const SURVIVOR_HEAD = "11111111-1111-4111-8111-111111111111";
const SURVIVOR_TAIL = "22222222-2222-4222-8222-222222222222";

describe("same-output head/tail are mutually exclusive merge candidates (SC6)", () => {
  it("a same-type tail sharing the head's description is created new, not merged", async () => {
    const client = await runSelfLoopOutput();

    // Both ends persist as their own row: the tail never collapses into the
    // head the L3 name+description cosine would otherwise merge it into.
    const inserts = boundValuesFor(client, /INSERT INTO entities/);
    expect(inserts.map((v) => v[1])).toEqual([
      SELF_LOOP_OUTPUT.head,
      SELF_LOOP_OUTPUT.tail,
    ]);
    expect(upsertedEndpoints(client)).toEqual([
      [inserts[0]![0] as string, inserts[1]![0] as string],
    ]);
  });

  it("the persisted triple never carries head_id = tail_id", async () => {
    const [[headId, tailId]] = upsertedEndpoints(await runSelfLoopOutput()) as [
      [string, string],
    ];

    expect(headId).not.toBe(tailId);
  });

  it("a tail whose head merged into a survivor does not reuse that survivor", async () => {
    // L0 merges the head into the live "Alice Smith"; the tail's candidate set
    // must then be empty, so it is created rather than folded into the head.
    const client = await runSelfLoopOutput([
      personRow(SURVIVOR_HEAD, SELF_LOOP_OUTPUT.head),
    ]);

    const inserts = boundValuesFor(client, /INSERT INTO entities/);
    expect(inserts.map((v) => v[1])).toEqual([SELF_LOOP_OUTPUT.tail]);
    expect(upsertedEndpoints(client)).toEqual([
      [SURVIVOR_HEAD, inserts[0]![0] as string],
    ]);
  });

  it("excludes only the head: the tail still merges into its own survivor", async () => {
    const client = await runSelfLoopOutput([
      personRow(SURVIVOR_HEAD, SELF_LOOP_OUTPUT.head),
      personRow(SURVIVOR_TAIL, SELF_LOOP_OUTPUT.tail),
    ]);

    expect(boundValuesFor(client, /INSERT INTO entities/)).toEqual([]);
    expect(upsertedEndpoints(client)).toEqual([[SURVIVOR_HEAD, SURVIVOR_TAIL]]);
  });
});

describe("merged_into is persisted for fuzzy merges (T5)", () => {
  it("stores loser → survivor and makes a second extract idempotent", async () => {
    const client = new FakeClient();
    serveMergePersistenceRows(
      client,
      personRow(SURVIVOR_HEAD, SELF_LOOP_OUTPUT.head)
    );
    const llm = new FakeLLMClient({
      scripted: async () => ({
        kind: "ok" as const,
        outputs: [
          {
            ...SELF_LOOP_OUTPUT,
            head: "Alicia Smith",
            tail: "Acme",
            tailType: "system",
          },
        ],
      }),
    });
    const deps: CliDeps = {
      ...makeDeps(client, llm),
      embedder: new ConstantEmbedder(8),
    };

    expect(await runCli(["--batch-size", "1"], deps)).toBe(0);

    const entityInserts = boundValuesFor(client, /INSERT INTO entities/);
    const loser = entityInserts.find((values) => values[1] === "Alicia Smith");
    expect(loser).toBeDefined();
    expect(
      boundValuesFor(client, /UPDATE entities SET merged_into/)
    ).toContainEqual([loser![0], SURVIVOR_HEAD]);
    expect(upsertedEndpoints(client)[0]?.[0]).toBe(SURVIVOR_HEAD);

    expect(await runCli(["--batch-size", "1"], deps)).toBe(0);

    // The existing loser pointer is followed; no duplicate loser or rewrite
    // is produced, and the triple still points to the canonical survivor.
    expect(
      boundValuesFor(client, /INSERT INTO entities/).filter(
        (values) => values[1] === "Alicia Smith"
      )
    ).toHaveLength(1);
    expect(
      boundValuesFor(client, /UPDATE entities SET merged_into/)
    ).toHaveLength(1);
    expect(upsertedEndpoints(client).at(-1)?.[0]).toBe(SURVIVOR_HEAD);
  });
});

describe("self-loop outputs are extract rejects (T4 / SC5)", () => {
  it("all self-loop outputs mark the chunk failed with SELF_LOOP_REJECTED (SC5)", async () => {
    const client = new FakeClient();
    scanOneChunk(client);
    const warnings: LoggedLine[] = [];
    const llm = new FakeLLMClient({
      scripted: async () => ({
        kind: "ok" as const,
        outputs: [
          {
            ...SELF_LOOP_OUTPUT,
            tail: SELF_LOOP_OUTPUT.head,
          },
        ],
      }),
    });
    const deps: CliDeps = {
      ...makeDeps(client, llm),
      logger: {
        ...silentLogger(),
        warn: (msg, fields) => warnings.push({ msg, fields }),
      },
    };

    const code = await runCli(["--batch-size", "1"], deps);

    expect(code).toBe(0);
    expect(boundValuesFor(client, /INSERT INTO entities/)).toEqual([]);
    expect(boundValuesFor(client, /INSERT INTO triples/)).toEqual([]);
    expect(boundValuesFor(client, /INSERT INTO projection_outbox/)).toEqual([]);
    expect(warnings).toContainEqual({
      msg: "triple-self-loop-rejected",
      fields: expect.objectContaining({
        chunkId: "00000000-0000-4000-8000-000000000000",
        head: SELF_LOOP_OUTPUT.head,
        tail: SELF_LOOP_OUTPUT.head,
        reason: "head-equals-tail",
      }),
    });
    // SC5: row-level reject — the chunk record is marked FAILED with the
    // SELF_LOOP_REJECTED sentinel, not succeeded. The 'failed' status + the
    // sentinel code is what --list-failed / --only-failed filter against.
    expect(boundValuesFor(client, /SET status = 'succeeded'/)).toEqual([]);
    const fails = boundValuesFor(client, /SET status = 'failed'/);
    expect(fails).toHaveLength(1);
    expect(fails[0]?.[1]).toBe("SELF_LOOP_REJECTED");
    expect(fails[0]?.[2]).toBe("all outputs were self-loops");
  });

  it("mixed outputs (one self-loop + one valid) succeed with one projection intent only", async () => {
    const client = new FakeClient();
    serveOwnEntityWrites(client);
    const warnings: LoggedLine[] = [];
    const llm = new FakeLLMClient({
      scripted: async () => ({
        kind: "ok" as const,
        outputs: [
          // Self-loop: dropped.
          { ...SELF_LOOP_OUTPUT, tail: SELF_LOOP_OUTPUT.head },
          // Valid triple: head and tail differ.
          { ...SELF_LOOP_OUTPUT, tail: "Acme Corp", tailType: "system" },
        ],
      }),
    });
    const deps: CliDeps = {
      ...makeDeps(client, llm),
      embedder: new ConstantEmbedder(8),
      logger: {
        ...silentLogger(),
        warn: (msg, fields) => warnings.push({ msg, fields }),
      },
    };

    const code = await runCli(["--batch-size", "1"], deps);
    expect(code).toBe(0);

    // Self-loop's warning logged; chunk as a whole still succeeds.
    expect(warnings.map((w) => w.msg)).toContain("triple-self-loop-rejected");

    // One triple upserted (the valid output); the self-loop never reaches the
    // dedup layer.
    expect(upsertedEndpoints(client)).toHaveLength(1);

    // One triple INSERT, three projection intents (head, tail, triple) for the
    // valid output. The self-loop contributes zero projection intents because
    // no graph edge exists for a discarded self-loop.
    const outbox = boundValuesFor(client, /INSERT INTO projection_outbox/);
    expect(outbox).toHaveLength(3);

    // The chunk is succeeded, not failed — the mixed chunk is NOT a reject.
    expect(boundValuesFor(client, /SET status = 'failed'/)).toEqual([]);
    const successes = boundValuesFor(client, /SET status = 'succeeded'/);
    expect(successes).toHaveLength(1);
    expect(successes[0]?.[1]).toBe(1);
    expect(successes[0]?.[2]).toBe(0);
  });

  it("does not re-extract a self-loop after a failed run with --only-failed (SC5)", async () => {
    const client = new FakeClient();
    let extractCalls = 0;
    let chunkScanCount = 0;
    client.rowsOverride = (text) => {
      if (/FROM chunks c/.test(text)) {
        chunkScanCount += 1;
        // Only the first chunk scan returns the chunk; every subsequent scan
        // (including --only-failed) returns empty so the LLM is never called
        // a second time. The WHERE clause is asserted below.
        return chunkScanCount === 1
          ? [{ id: "00000000-0000-4000-8000-000000000000", content: "x" }]
          : [];
      }
      if (/FROM entities/.test(text)) return [];
      return [];
    };
    const llm = new FakeLLMClient({
      scripted: async () => {
        extractCalls += 1;
        return {
          kind: "ok" as const,
          outputs: [{ ...SELF_LOOP_OUTPUT, tail: SELF_LOOP_OUTPUT.head }],
        };
      },
    });
    const deps = makeDeps(client, llm);

    expect(await runCli(["--batch-size", "1"], deps)).toBe(0);
    expect(await runCli(["--only-failed", "--batch-size", "1"], deps)).toBe(0);

    // The LLM ran exactly once. Even though the chunk has a failed extraction
    // record (SELF_LOOP_REJECTED), --only-failed skips it: there is no
    // re-extract path for a permanent reject.
    expect(extractCalls).toBe(1);
    const onlyFailedScan = client.queries.filter((query) =>
      /FROM chunks c/.test(query)
    )[1];
    expect(onlyFailedScan).toContain("status = 'failed'");
    // The WHERE clause also excludes the SELF_LOOP_REJECTED sentinel.
    expect(onlyFailedScan).toContain("SELF_LOOP_REJECTED");
  });

  it("persists same-normalized-name endpoints when their types differ", async () => {
    const client = await runOutput({
      ...SELF_LOOP_OUTPUT,
      tail: " alice   smith ",
      tailType: "system",
    });

    const inserts = boundValuesFor(client, /INSERT INTO entities/);
    expect(inserts.map((values) => values[1])).toEqual([
      SELF_LOOP_OUTPUT.head,
      " alice   smith ",
    ]);
    expect(upsertedEndpoints(client)).toEqual([
      [inserts[0]![0] as string, inserts[1]![0] as string],
    ]);
  });

  it("does not re-extract a self-loop after a successful run with --only-failed", async () => {
    const client = new FakeClient();
    let extractCalls = 0;
    let chunkScanCount = 0;
    client.rowsOverride = (text) => {
      if (/FROM chunks c/.test(text)) {
        chunkScanCount += 1;
        // Only the first chunk scan returns the chunk; every subsequent
        // scan (including --only-failed) returns empty. Under the new
        // SC5 contract an all-self-loop chunk is marked `failed` with
        // the SELF_LOOP_REJECTED sentinel, so the run never reaches
        // `succeeded` and the test no longer keys off `SET status =
        // 'succeeded'`.
        return chunkScanCount === 1
          ? [{ id: "00000000-0000-4000-8000-000000000000", content: "x" }]
          : [];
      }
      if (/FROM entities/.test(text)) return [];
      return [];
    };
    const llm = new FakeLLMClient({
      scripted: async () => {
        extractCalls += 1;
        return {
          kind: "ok" as const,
          outputs: [{ ...SELF_LOOP_OUTPUT, tail: SELF_LOOP_OUTPUT.head }],
        };
      },
    });
    const deps = makeDeps(client, llm);

    expect(await runCli(["--batch-size", "1"], deps)).toBe(0);
    expect(await runCli(["--only-failed", "--batch-size", "1"], deps)).toBe(0);

    expect(extractCalls).toBe(1);
    const onlyFailedScan = client.queries.filter((query) =>
      /FROM chunks c/.test(query)
    )[1];
    expect(onlyFailedScan).toContain("status = 'failed'");
  });
});

// ─── T2: A10 relation_norm trust policy before upsert (SC8) ──────────────

/**
 * FakeEmbedder's derived vectors sit around cosine 0.75 for any pair of texts,
 * above the cascade's 0.7 embedding floor, so it cannot express "no cascade
 * hit". This double reserves axis 0 for the vocabulary terms and projects
 * every other text off that axis: cosine(raw, ALLOWED[i]) is exactly 0, while
 * entity texts keep FakeEmbedder's spread.
 */
class VocabAxisEmbedder implements EmbeddingClient {
  private readonly fake: FakeEmbedder;
  constructor(private readonly dimensions: number) {
    this.fake = new FakeEmbedder(dimensions);
  }
  async embed(texts: string[]): Promise<number[][]> {
    const derived = await this.fake.embed(texts);
    return texts.map((text, i) =>
      ALLOWED.includes(text.trim().toLowerCase())
        ? vocabAxis(this.dimensions)
        : offVocabAxis(derived[i]!)
    );
  }
}

function vocabAxis(dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[0] = 1;
  return vector;
}

function offVocabAxis(vector: number[]): number[] {
  const projected = vector.map((v, i) => (i === 0 ? 0 : v));
  const norm = Math.hypot(...projected) || 1;
  return projected.map((v) => v / norm);
}

/** One extraction output; the relation fields are what the assertions read. */
function relationOutput(over: {
  relationRaw: string;
  relationNorm: string;
  head?: string;
  tail?: string;
}) {
  const head = over.head ?? "Dana Lee";
  const tail = over.tail ?? "Initech";
  return {
    head,
    headType: "person",
    relationRaw: over.relationRaw,
    relationNorm: over.relationNorm,
    tail,
    tailType: "system",
    description: `${head} ${over.relationRaw} ${tail}`,
    evidenceSpan: `${head} ${over.relationRaw} ${tail}`,
    confidence: 0.8,
  };
}

/** `(relation_raw, relation_norm)` of every triple the run upserted. */
function upsertedRelations(client: FakeClient): Array<[string, string]> {
  return boundValuesFor(client, /INSERT INTO triples/).map((v) => [
    v[3] as string,
    v[4] as string,
  ]);
}

/** Run one chunk whose single output carries the given relation fields. */
async function runOneRelation(over: {
  relationRaw: string;
  relationNorm: string;
}): Promise<FakeClient> {
  const client = new FakeClient();
  scanOneChunk(client);
  const llm = new FakeLLMClient({
    scripted: async () => ({
      kind: "ok" as const,
      outputs: [relationOutput(over)],
    }),
  });
  const deps: CliDeps = {
    ...makeDeps(client, llm),
    embedder: new VocabAxisEmbedder(8),
  };
  const code = await runCli(["--batch-size", "1"], deps);
  expect(code).toBe(0);
  return client;
}

describe("relation_norm is cascade-vetted before upsert (A10 / SC8)", () => {
  it("an invalid claim with a synonym-table hit persists the vocabulary term", async () => {
    const client = await runOneRelation({
      relationRaw: "works at",
      relationNorm: "WORKS_WITH",
    });

    expect(upsertedRelations(client)).toEqual([["works at", "works_for"]]);
  });

  it("an invalid claim with no cascade hit persists the UNMAPPED sentinel", async () => {
    const client = await runOneRelation({
      relationRaw: "mysteriously linked to",
      relationNorm: "WORKS_WITH",
    });

    expect(upsertedRelations(client)).toEqual([
      ["mysteriously linked to", "UNMAPPED"],
    ]);
  });

  it("a valid claim is kept instead of being re-derived from the raw form", async () => {
    // The raw form would cascade to `works_for`; the claim is in ALLOWED, so
    // the claim wins and the cascade never runs.
    const client = await runOneRelation({
      relationRaw: "works at",
      relationNorm: "knows",
    });

    expect(upsertedRelations(client)).toEqual([["works at", "knows"]]);
  });

  it("a case-insensitive claim persists as its canonical ALLOWED member", async () => {
    const client = await runOneRelation({
      relationRaw: "chats with",
      relationNorm: "Communicates_With",
    });

    expect(upsertedRelations(client)).toEqual([
      ["chats with", "communicates_with"],
    ]);
  });

  it("persists typed causal relation_norm values", async () => {
    const client = await runOneRelation({
      relationRaw: "prevented",
      relationNorm: "PREVENTED",
    });

    expect(upsertedRelations(client)).toEqual([["prevented", "prevented"]]);
  });

  it("relation_raw is stored exactly as received (#3 D3 audit fidelity)", async () => {
    const client = await runOneRelation({
      relationRaw: "  Works At  ",
      relationNorm: "WORKS_WITH",
    });

    expect(upsertedRelations(client)).toEqual([["  Works At  ", "works_for"]]);
  });

  it("the record's unmapped_count counts vetted sentinels, not claimed ones", async () => {
    const client = new FakeClient();
    scanOneChunk(client);
    const llm = new FakeLLMClient({
      scripted: async () => ({
        kind: "ok" as const,
        outputs: [
          // Claimed UNMAPPED, but the raw form has a synonym hit → mapped.
          relationOutput({
            relationRaw: "based in",
            relationNorm: "UNMAPPED",
            head: "Dana Lee",
            tail: "Berlin",
          }),
          // Claimed vocabulary term, but no cascade hit → sentinel.
          relationOutput({
            relationRaw: "mysteriously linked to",
            relationNorm: "WORKS_WITH",
            head: "Dana Lee",
            tail: "Initech",
          }),
        ],
      }),
    });
    const deps: CliDeps = {
      ...makeDeps(client, llm),
      embedder: new VocabAxisEmbedder(8),
    };

    const code = await runCli(["--batch-size", "1"], deps);
    expect(code).toBe(0);

    expect(upsertedRelations(client)).toEqual([
      ["based in", "located_in"],
      ["mysteriously linked to", "UNMAPPED"],
    ]);
    const marks = boundValuesFor(client, /SET status = 'succeeded'/);
    expect(marks).toHaveLength(1);
    // (id, triples_count, unmapped_count)
    expect(marks[0]![1]).toBe(2);
    expect(marks[0]![2]).toBe(1);
  });
});

// ─── T5: `--list-failed` CLI surface (G8 / A15 / SC11) ───────────────────

interface LoggedLine {
  msg: string;
  fields: Record<string, unknown> | undefined;
}

/** Logger that keeps every `info` line so the report content is assertable. */
function recordingLogger(lines: LoggedLine[]) {
  return {
    level: "info" as const,
    debug: () => {},
    info: (msg: string, fields?: Record<string, unknown>) =>
      void lines.push({ msg, fields }),
    warn: () => {},
    error: () => {},
  };
}

/** An LLM client that fails the test if the report path ever calls it. */
function throwingLlm(): FakeLLMClient {
  return new FakeLLMClient({
    scripted: async () => {
      throw new Error("--list-failed must not call the LLM");
    },
  });
}

/** Rows the fake pool returns for the `listFailed()` SELECT, created_at-ASC. */
function failedRow(over: {
  chunkId: string;
  batchId: string;
  errorCode: string;
  createdAt: string;
}) {
  return {
    id: `rec-${over.chunkId}`,
    batch_id: over.batchId,
    chunk_id: over.chunkId,
    status: "failed",
    error_code: over.errorCode,
    error_msg: `${over.errorCode} on ${over.chunkId}`,
    created_at: over.createdAt,
  };
}

const BATCH_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BATCH_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Serve `rows` to the extraction_records SELECT and nothing to any other. */
function serveFailedRows(client: FakeClient, rows: unknown[]): void {
  client.rowsOverride = (text) =>
    /FROM extraction_records/.test(text) ? rows : [];
}

describe("runCli --list-failed", () => {
  it("exits 0 without invoking the LLM (throwing FakeLLMClient)", async () => {
    const client = new FakeClient();
    serveFailedRows(client, []);
    const deps = makeDeps(client, throwingLlm());

    const code = await runCli(["--list-failed"], deps);

    expect(code).toBe(0);
  });

  it("empty result set exits 0 and writes no rows", async () => {
    const client = new FakeClient();
    serveFailedRows(client, []);
    const lines: LoggedLine[] = [];
    const deps: CliDeps = {
      ...makeDeps(client, throwingLlm()),
      logger: recordingLogger(lines),
    };

    const code = await runCli(["--list-failed"], deps);

    expect(code).toBe(0);
    expect(lines.map((l) => l.msg)).toEqual(["no-failed-records"]);
    const writes = client.queries.filter((q) =>
      /^\s*(INSERT|UPDATE|DELETE)\s/i.test(q)
    );
    expect(writes).toEqual([]);
  });

  it("prints chunk_id / batch_id / error_code / error_msg / created_at", async () => {
    const client = new FakeClient();
    serveFailedRows(client, [
      failedRow({
        chunkId: "chunk-old",
        batchId: BATCH_A,
        errorCode: "5xx",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
    ]);
    const lines: LoggedLine[] = [];
    const deps: CliDeps = {
      ...makeDeps(client, throwingLlm()),
      logger: recordingLogger(lines),
    };

    const code = await runCli(["--list-failed"], deps);

    expect(code).toBe(0);
    expect(lines).toEqual([
      {
        msg: "failed-record",
        fields: {
          chunk_id: "chunk-old",
          batch_id: BATCH_A,
          error_code: "5xx",
          error_msg: "5xx on chunk-old",
          created_at: "2026-08-01T00:00:00.000Z",
        },
      },
    ]);
  });

  it("orders newest first even though listFailed() returns created_at-ASC", async () => {
    const client = new FakeClient();
    serveFailedRows(client, [
      failedRow({
        chunkId: "chunk-old",
        batchId: BATCH_A,
        errorCode: "5xx",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      failedRow({
        chunkId: "chunk-mid",
        batchId: BATCH_A,
        errorCode: "4xx",
        createdAt: "2026-08-02T00:00:00.000Z",
      }),
      failedRow({
        chunkId: "chunk-new",
        batchId: BATCH_B,
        errorCode: "format",
        createdAt: "2026-08-03T00:00:00.000Z",
      }),
    ]);
    const lines: LoggedLine[] = [];
    const deps: CliDeps = {
      ...makeDeps(client, throwingLlm()),
      logger: recordingLogger(lines),
    };

    const code = await runCli(["--list-failed"], deps);

    expect(code).toBe(0);
    expect(lines.map((l) => l.fields?.chunk_id)).toEqual([
      "chunk-new",
      "chunk-mid",
      "chunk-old",
    ]);
  });

  it("--batch-id binds the uuid into the listFailed() filter", async () => {
    const client = new FakeClient();
    serveFailedRows(client, [
      failedRow({
        chunkId: "chunk-b",
        batchId: BATCH_B,
        errorCode: "5xx",
        createdAt: "2026-08-03T00:00:00.000Z",
      }),
    ]);
    const deps = makeDeps(client, throwingLlm());

    const code = await runCli(["--list-failed", "--batch-id", BATCH_B], deps);

    expect(code).toBe(0);
    const selects = boundValuesFor(client, /FROM extraction_records/);
    expect(selects).toEqual([[BATCH_B]]);
    expect(sqlFor(client, /FROM extraction_records/)).toContain(
      "batch_id = $1"
    );
  });

  it("excludes SELF_LOOP_REJECTED rows from the listFailed SELECT (SC5)", async () => {
    const client = new FakeClient();
    serveFailedRows(client, [
      failedRow({
        chunkId: "chunk-transient",
        batchId: BATCH_A,
        errorCode: "5xx",
        createdAt: "2026-08-04T00:00:00.000Z",
      }),
      failedRow({
        chunkId: "chunk-self-loop",
        batchId: BATCH_A,
        errorCode: "SELF_LOOP_REJECTED",
        createdAt: "2026-08-05T00:00:00.000Z",
      }),
    ]);
    const deps = makeDeps(client, throwingLlm());

    const code = await runCli(["--list-failed"], deps);

    expect(code).toBe(0);
    // The WHERE clause must hide SELF_LOOP_REJECTED rows: there is no
    // re-extract path for a permanent reject, so it would be misleading to
    // list it as "must re-extract" alongside transient failures (SC5).
    const sql = sqlFor(client, /FROM extraction_records/);
    expect(sql).toContain("SELF_LOOP_REJECTED");
    expect(sql).not.toContain("batch_id = $1");
  });

  it("--batch-id requires a UUID value; otherwise exit 2", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client, throwingLlm());

    expect(await runCli(["--list-failed", "--batch-id", "nope"], deps)).toBe(2);
    expect(await runCli(["--list-failed", "--batch-id"], deps)).toBe(2);
    expect(client.queries).toEqual([]);
    // Exit 2 for the right reason: the value is rejected, not the flag name.
    expect(parseArgs(["--list-failed", "--batch-id", "nope"])).toEqual({
      ok: false,
      error: "--batch-id requires a UUID",
    });
  });

  it("--batch-id without --list-failed is a usage error (exit 2)", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client, throwingLlm());

    const code = await runCli(["--batch-id", BATCH_A], deps);

    expect(code).toBe(2);
    expect(client.queries).toEqual([]);
    expect(parseArgs(["--batch-id", BATCH_A])).toEqual({
      ok: false,
      error: "--batch-id is only valid with --list-failed",
    });
  });
});

// ─── T6: `--backfill-embeddings` idempotent repair mode (A9 / SC5) ───────

const ENTITY_A = "11111111-1111-4111-8111-111111111111";
const ENTITY_B = "22222222-2222-4222-8222-222222222222";

/** A NULL-embedding row as the backfill scan reads it back. */
function nullEmbeddingRow(over: {
  id: string;
  canonicalName: string;
  description: string | null;
}) {
  return {
    id: over.id,
    canonical_name: over.canonicalName,
    type: "person",
    description: over.description,
  };
}

/**
 * Serve `rows` to the backfill scan and let every UPDATE report one row
 * updated through its RETURNING clause — the count the run output reports.
 */
function serveNullEmbeddingRows(client: FakeClient, rows: unknown[]): void {
  client.rowsOverride = (text) => {
    if (/^\s*SELECT[\s\S]*FROM entities/.test(text)) return rows;
    if (/^\s*UPDATE entities/.test(text)) return [{ id: "updated" }];
    return [];
  };
}

/** Embedder that records the text of every embed call. */
function recordingEmbedder(texts: string[]): EmbeddingClient {
  const inner = new FakeEmbedder(8);
  return {
    embed: async (batch: string[]) => {
      texts.push(...batch);
      return inner.embed(batch);
    },
  };
}

describe("runCli --backfill-embeddings", () => {
  it("exits 0 without invoking the LLM (throwing FakeLLMClient)", async () => {
    const client = new FakeClient();
    serveNullEmbeddingRows(client, [
      nullEmbeddingRow({
        id: ENTITY_A,
        canonicalName: "Alice Smith",
        description: "Alice Smith works at Acme Corp",
      }),
    ]);
    const deps: CliDeps = {
      ...makeDeps(
        client,
        new FakeLLMClient({
          scripted: async () => {
            throw new Error("--backfill-embeddings must not call the LLM");
          },
        })
      ),
    };

    const code = await runCli(["--backfill-embeddings"], deps);

    expect(code).toBe(0);
  });

  it("scans only live rows whose embedding IS NULL", async () => {
    const client = new FakeClient();
    serveNullEmbeddingRows(client, []);
    const deps = makeDeps(client, throwingLlm());

    await runCli(["--backfill-embeddings"], deps);

    const sql = sqlFor(client, /^\s*SELECT[\s\S]*FROM entities/);
    expect(sql).toMatch(/embedding IS NULL/);
    expect(sql).toMatch(/retired = false/);
  });

  it("UPDATEs each NULL-embedding row with the #6 Q1 SSOT vector", async () => {
    const client = new FakeClient();
    serveNullEmbeddingRows(client, [
      nullEmbeddingRow({
        id: ENTITY_A,
        canonicalName: "Alice Smith",
        description: "Alice Smith works at Acme Corp",
      }),
      nullEmbeddingRow({
        id: ENTITY_B,
        canonicalName: "Acme Corp",
        description: "Acme Corp runs the billing platform",
      }),
    ]);
    const embedded: string[] = [];
    const deps: CliDeps = {
      ...makeDeps(client, throwingLlm()),
      embedder: recordingEmbedder(embedded),
    };

    const code = await runCli(["--backfill-embeddings"], deps);
    expect(code).toBe(0);

    // The embed input is the SSOT text, never inline concatenation.
    expect(embedded).toEqual([
      computeEntityEmbeddingText(
        "Alice Smith",
        "Alice Smith works at Acme Corp"
      ),
      computeEntityEmbeddingText(
        "Acme Corp",
        "Acme Corp runs the billing platform"
      ),
    ]);

    const inner = new FakeEmbedder(8);
    const updates = boundValuesFor(client, /^\s*UPDATE entities/);
    expect(updates.map((v) => v[0])).toEqual([ENTITY_A, ENTITY_B]);
    for (let i = 0; i < updates.length; i += 1) {
      const [vector] = await inner.embed([embedded[i]!]);
      expect(updates[i]![1]).toBe(`[${vector!.join(",")}]`);
    }

    // The pgvector cast and the NULL guard both ride the UPDATE: without the
    // guard a concurrent writer's fresh embedding would be overwritten.
    const sql = sqlFor(client, /^\s*UPDATE entities/);
    expect(sql).toContain("::vector");
    expect(sql).toMatch(/embedding IS NULL/);
  });

  it("treats a missing description as the empty string", async () => {
    const client = new FakeClient();
    serveNullEmbeddingRows(client, [
      nullEmbeddingRow({
        id: ENTITY_A,
        canonicalName: "Alice Smith",
        description: null,
      }),
    ]);
    const embedded: string[] = [];
    const deps: CliDeps = {
      ...makeDeps(client, throwingLlm()),
      embedder: recordingEmbedder(embedded),
    };

    const code = await runCli(["--backfill-embeddings"], deps);

    expect(code).toBe(0);
    expect(embedded).toEqual([computeEntityEmbeddingText("Alice Smith", "")]);
    // The absent JSONB key is coalesced in SQL too, so a NULL never reaches
    // the embedder as the string "null".
    expect(sqlFor(client, /^\s*SELECT[\s\S]*FROM entities/)).toContain(
      "coalesce(metadata->>'description', '')"
    );
  });

  it("reports the backfilled count in the run output", async () => {
    const client = new FakeClient();
    serveNullEmbeddingRows(client, [
      nullEmbeddingRow({
        id: ENTITY_A,
        canonicalName: "Alice Smith",
        description: "Alice Smith works at Acme Corp",
      }),
      nullEmbeddingRow({
        id: ENTITY_B,
        canonicalName: "Acme Corp",
        description: "Acme Corp runs the billing platform",
      }),
    ]);
    const lines: LoggedLine[] = [];
    const deps: CliDeps = {
      ...makeDeps(client, throwingLlm()),
      logger: recordingLogger(lines),
    };

    const code = await runCli(["--backfill-embeddings"], deps);

    expect(code).toBe(0);
    expect(lines).toContainEqual({
      msg: "backfill-embeddings-complete",
      fields: { scanned: 2, backfilled: 2 },
    });
  });

  it("reports 0 backfilled and writes nothing when no embedding is NULL", async () => {
    const client = new FakeClient();
    serveNullEmbeddingRows(client, []);
    const lines: LoggedLine[] = [];
    const deps: CliDeps = {
      ...makeDeps(client, throwingLlm()),
      logger: recordingLogger(lines),
    };

    const code = await runCli(["--backfill-embeddings"], deps);

    expect(code).toBe(0);
    expect(lines).toContainEqual({
      msg: "backfill-embeddings-complete",
      fields: { scanned: 0, backfilled: 0 },
    });
    const writes = client.queries.filter((q) =>
      /^\s*(INSERT|UPDATE|DELETE)\s/i.test(q)
    );
    expect(writes).toEqual([]);
  });

  it("exits 1 when the embedder returns no vector for a scanned row", async () => {
    const client = new FakeClient();
    serveNullEmbeddingRows(client, [
      nullEmbeddingRow({
        id: ENTITY_A,
        canonicalName: "Alice Smith",
        description: "Alice Smith works at Acme Corp",
      }),
    ]);
    const deps: CliDeps = {
      ...makeDeps(client, throwingLlm()),
      embedder: { embed: async () => [] },
    };

    const code = await runCli(["--backfill-embeddings"], deps);

    expect(code).toBe(1);
    expect(boundValuesFor(client, /^\s*UPDATE entities/)).toEqual([]);
  });

  it("never fires inside a normal extraction run (A9)", async () => {
    const client = new FakeClient();
    scanOneChunk(client);
    const llm = new FakeLLMClient({
      scripted: async () => ({ kind: "ok" as const, outputs: [ALICE_OUTPUT] }),
    });
    const deps = makeDeps(client, llm);

    const code = await runCli(["--batch-size", "1"], deps);

    expect(code).toBe(0);
    expect(client.queries.filter((q) => /UPDATE entities/i.test(q))).toEqual(
      []
    );
    expect(parseArgs([])).toEqual({
      ok: true,
      flags: expect.objectContaining({ backfillEmbeddings: false }),
    });
  });

  it("is a flag of its own: --backfill-embeddings parses to true", async () => {
    expect(parseArgs(["--backfill-embeddings"])).toEqual({
      ok: true,
      flags: expect.objectContaining({ backfillEmbeddings: true }),
    });
    expect(parseArgs(["--backfill-embeddings", "--batch-id", BATCH_A])).toEqual(
      { ok: false, error: "--batch-id is only valid with --list-failed" }
    );
  });
});

// ─── T5: precision-layer entity projection (specs/es-precision-layer.md) ──

/** A recorded fake of the PrecisionIndexer write surface the CLI uses. */
class RecordingPrecision {
  indexed: unknown[][] = [];
  deleted: string[][] = [];
  indexError: unknown;
  deleteError: unknown;

  async indexEntities(entities: unknown[]): Promise<void> {
    if (this.indexError !== undefined) throw this.indexError;
    this.indexed.push(entities);
  }

  async deleteEntities(ids: string[]): Promise<void> {
    if (this.deleteError !== undefined) throw this.deleteError;
    this.deleted.push(ids);
  }
}

describe("extract → precision.indexEntities (T5 entity projection)", () => {
  it("unconfigured precision layer: no index call, run still succeeds", async () => {
    const client = new FakeClient();
    scanOneChunk(client);
    const llm = new FakeLLMClient({
      scripted: async () => ({ kind: "ok" as const, outputs: [ALICE_OUTPUT] }),
    });
    const deps = makeDeps(client, llm);

    const code = await runCli(["--batch-size", "1"], deps);

    expect(code).toBe(0);
  });

  it("configured precision layer: indexes the canonical name + full alias set after commit", async () => {
    const client = new FakeClient();
    scanOneChunk(client);
    // The post-commit projection read goes through the shared T5 helper
    // (`fetchEntityProjection`); the fake answers it with the two rows the
    // INSERTs above would have produced, each with its full alias set.
    const projectionRows = [
      {
        id: "id-head",
        canonical_name: ALICE_OUTPUT.head,
        type: "person",
        retired: false,
        aliases: [ALICE_OUTPUT.head],
      },
      {
        id: "id-tail",
        canonical_name: ALICE_OUTPUT.tail,
        type: "system",
        retired: false,
        aliases: [ALICE_OUTPUT.tail],
      },
    ];
    const baseRowsOverride = client.rowsOverride;
    client.rowsOverride = (text: string) =>
      /entity_aliases a ON a\.entity_id = e\.id/.test(text)
        ? projectionRows
        : baseRowsOverride
          ? baseRowsOverride(text)
          : [];
    const llm = new FakeLLMClient({
      scripted: async () => ({ kind: "ok" as const, outputs: [ALICE_OUTPUT] }),
    });
    const precision = new RecordingPrecision();
    const deps: CliDeps = { ...makeDeps(client, llm), precision };

    const code = await runCli(["--batch-size", "1"], deps);

    expect(code).toBe(0);
    expect(precision.indexed).toHaveLength(1);
    const records = precision.indexed[0] as Array<{
      canonical_name: string;
      aliases: string[];
    }>;
    // head + tail, each carrying its canonical name as an alias
    expect(records.map((r) => r.canonical_name)).toEqual([
      ALICE_OUTPUT.head,
      ALICE_OUTPUT.tail,
    ]);
    for (const record of records) {
      expect(record.aliases).toContain(record.canonical_name);
    }
    // The projection query is the shared T5 helper, not an ad-hoc SELECT.
    expect(
      client.queries.some((q) =>
        /entity_aliases a ON a\.entity_id = e\.id/.test(q)
      )
    ).toBe(true);
    // Indexing happens after COMMIT: no open transaction when it runs.
    expect(client.queries[client.queries.length - 1]).not.toBe("BEGIN");
  });

  it("ES index failure is fail-open: exit 0, authority rows unaffected", async () => {
    const client = new FakeClient();
    scanOneChunk(client);
    const llm = new FakeLLMClient({
      scripted: async () => ({ kind: "ok" as const, outputs: [ALICE_OUTPUT] }),
    });
    const precision = new RecordingPrecision();
    precision.indexError = new Error("entity index unavailable");
    const deps: CliDeps = { ...makeDeps(client, llm), precision };

    const code = await runCli(["--batch-size", "1"], deps);

    expect(code).toBe(0);
    expect(precision.indexed).toEqual([]);
    // The authority writes still happened (INSERT INTO entities fired).
    expect(boundValuesFor(client, /INSERT INTO entities/)).toHaveLength(2);
  });

  it("no delete fires on a plain create run", async () => {
    const client = new FakeClient();
    scanOneChunk(client);
    const llm = new FakeLLMClient({
      scripted: async () => ({ kind: "ok" as const, outputs: [ALICE_OUTPUT] }),
    });
    const precision = new RecordingPrecision();
    const deps: CliDeps = { ...makeDeps(client, llm), precision };

    await runCli(["--batch-size", "1"], deps);

    expect(precision.deleted).toEqual([]);
  });

  it("an L3 merge deletes the loser id from the entity index after commit", async () => {
    const client = new FakeClient();
    // Same shape as the "merged_into is persisted for fuzzy merges (T5)"
    // fixture: a live survivor plus an incoming head that only the L3
    // cosine can fold into it. ConstantEmbedder makes L3 see cosine 1.0.
    serveMergePersistenceRows(
      client,
      personRow(SURVIVOR_HEAD, SELF_LOOP_OUTPUT.head)
    );
    const llm = new FakeLLMClient({
      scripted: async () => ({
        kind: "ok" as const,
        outputs: [
          {
            ...SELF_LOOP_OUTPUT,
            head: "Alicia Smith",
            tail: "Acme",
            tailType: "system",
          },
        ],
      }),
    });
    const precision = new RecordingPrecision();
    const deps: CliDeps = {
      ...makeDeps(client, llm),
      embedder: new ConstantEmbedder(8),
      precision,
    };

    const code = await runCli(["--batch-size", "1"], deps);

    expect(code).toBe(0);
    const loser = boundValuesFor(client, /INSERT INTO entities/).find(
      (values) => values[1] === "Alicia Smith"
    );
    expect(loser).toBeDefined();
    expect(precision.deleted).toEqual([[loser![0]]]);
  });

  it("ES delete failure is fail-open: exit 0, merge already committed", async () => {
    const client = new FakeClient();
    serveMergePersistenceRows(
      client,
      personRow(SURVIVOR_HEAD, SELF_LOOP_OUTPUT.head)
    );
    const llm = new FakeLLMClient({
      scripted: async () => ({
        kind: "ok" as const,
        outputs: [
          {
            ...SELF_LOOP_OUTPUT,
            head: "Alicia Smith",
            tail: "Acme",
            tailType: "system",
          },
        ],
      }),
    });
    const precision = new RecordingPrecision();
    precision.deleteError = new Error("delete_by_query rejected");
    const deps: CliDeps = {
      ...makeDeps(client, llm),
      embedder: new ConstantEmbedder(8),
      precision,
    };

    const code = await runCli(["--batch-size", "1"], deps);

    expect(code).toBe(0);
    // The merge itself committed: the loser INSERT and the merged_into
    // UPDATE are both durable despite the ES-side delete failure. Two
    // entity INSERTs fire (the folded head loser + the fresh Acme tail).
    expect(boundValuesFor(client, /INSERT INTO entities/)).toHaveLength(2);
    expect(
      boundValuesFor(client, /UPDATE entities SET merged_into/)
    ).toHaveLength(1);
  });
});

// ─── T9 High-2 fix: runCliFromEnv production precision wiring ────────────────
// The extract CLI is a production entry point; when the env configures an ES
// block, `runCliFromEnv` must build an `ElasticsearchPrecisionLayer` (mirroring
// the server wiring in src/index.ts buildDeps) and inject it into CliDeps.
// Unconfigured ES stays `undefined` — a silent no-op for every precision call,
// matching the MCP push/ingest path. The fake Pool + mocked layer mean the
// assertions never touch a live Postgres or Elasticsearch.
describe("runCliFromEnv precision wiring (production entry point)", () => {
  function makeFakeEnv(
    elasticsearch: import("../../src/config.js").ElasticsearchConfig | undefined
  ): import("../../src/config.js").GraphragEnv {
    return {
      logLevel: "info",
      storage: "pgvector",
      dbUrl: "postgres://localhost/test",
      embedBaseUrl: undefined,
      embedModel: undefined,
      embedDimensions: 8,
      pgvectorAnnMaxDimensions: 2048,
      ingestBatchLimit: 100,
      pgvectorPoolMax: 4,
      pgvectorConnectionWaitTimeoutMs: 5000,
      embedApiKey: undefined,
      retrieval: {
        preset: "balanced",
        rrfK: 60,
        w_vec: 1,
        w_bm25: 1,
        w_graph: 0.15,
        k1: 1.4,
        b: 0.6,
        bm25Enabled: true,
        cjkSegmentationEnabled: true,
        phraseEnabled: true,
        fieldBoostEnabled: true,
        fieldBoosts: { content: 1 },
        rrfEnabled: true,
        vectorEnabled: true,
        graphEnabled: true,
        nodeEmbeddingEnabled: false,
        rerankEnabled: false,
        waitForDrainEnabled: false,
        waitForDrainTimeoutMs: 5000,
        entityLinkTopK: 10,
        candidateCap: 100,
        neighborWidth: 1,
        graphArmFloor: 3,
      },
      neo4j: undefined,
      elasticsearch,
      rerank: undefined,
      rerankUrl: undefined,
    };
  }

  const ES_CONFIG: import("../../src/config.js").ElasticsearchConfig = {
    node: "http://localhost:9200",
    chunkIndex: "iknow-memory-chunks",
    entityIndex: "iknow-memory-entities",
    username: undefined,
    password: undefined,
    apiKey: undefined,
    requestTimeoutMs: 5000,
  };

  function captureStderr(): { text: () => string; restore: () => void } {
    const chunks: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        chunks.push(String(chunk));
        return true;
      });
    return {
      text: () => chunks.join(""),
      restore: () => spy.mockRestore(),
    };
  }

  async function withMockedEnv(
    env: import("../../src/config.js").GraphragEnv
  ): Promise<{
    layerInstances: Array<{
      config: unknown;
      options: unknown;
      closed: number;
    }>;
  }> {
    const layerInstances: Array<{
      config: unknown;
      options: unknown;
      closed: number;
    }> = [];
    const stderr = captureStderr();
    vi.doMock("../../src/config.js", async () => {
      const actual = await vi.importActual<
        typeof import("../../src/config.js")
      >("../../src/config.js");
      return { ...actual, loadEnv: () => env };
    });
    // The Pool must never dial a real Postgres: replace `pg` with a fake
    // whose connect() answers the scan with zero rows so `--list-unmapped`
    // finishes immediately with exit 0.
    vi.doMock("pg", () => ({
      Pool: class {
        async connect() {
          return {
            query: async () => ({ rows: [] }),
            release: () => {},
          };
        }
        async end() {}
      },
    }));
    vi.doMock("../../src/core/storage/elasticsearch-precision.js", () => ({
      ElasticsearchPrecisionLayer: class {
        config: unknown;
        options: unknown;
        closed = 0;
        constructor(config: unknown, options: unknown) {
          this.config = config;
          this.options = options;
          layerInstances.push(this);
        }
        async close() {
          this.closed += 1;
        }
      },
    }));
    try {
      // Drop the statically-cached extract module so the dynamic import
      // re-evaluates it against the mocks above (vi.doMock only affects
      // imports after a module-registry reset).
      vi.resetModules();
      const mod = await import("../../src/cli/extract.js");
      await mod.runCliFromEnv(["--list-unmapped"]);
    } finally {
      stderr.restore();
      vi.doUnmock("../../src/config.js");
      vi.doUnmock("pg");
      vi.doUnmock("../../src/core/storage/elasticsearch-precision.js");
      vi.resetModules();
    }
    return { layerInstances };
  }

  it("builds an ElasticsearchPrecisionLayer from env.elasticsearch with k1/b from env.retrieval", async () => {
    const { layerInstances } = await withMockedEnv(makeFakeEnv(ES_CONFIG));

    expect(layerInstances).toHaveLength(1);
    expect(layerInstances[0]!.config).toEqual(ES_CONFIG);
    expect(layerInstances[0]!.options).toEqual({ k1: 1.4, b: 0.6 });
    // Resource cleanup: the layer is closed with the pool in `finally`.
    expect(layerInstances[0]!.closed).toBe(1);
  });

  it("leaves precision unconfigured (undefined) when env has no ES block", async () => {
    const { layerInstances } = await withMockedEnv(makeFakeEnv(undefined));

    // No precision layer was ever constructed, and the run still exits 0 —
    // the pipeline's precision calls are silent no-ops on the unconfigured
    // path (same posture as the MCP push/ingest wiring).
    expect(layerInstances).toHaveLength(0);
  });
});
