/**
 * extract → projection_outbox emit (specs/neo4j-graph-arm.md T2, SC3).
 *
 * The contract under test is transactional, so the assertions are about
 * ORDER as much as content: every intent the chunk emits must sit between
 * that chunk's `BEGIN` and its `COMMIT`, and an emit that throws must take
 * the whole chunk down with it (`ROLLBACK`, exit 2) rather than leaving
 * ledger rows Neo4j will never hear about.
 *
 * A recording fake pool keeps this a unit test — the same shape
 * tests/cli/extract.unit.test.ts uses. Real-Postgres proof that the outbox
 * row and the ledger rows commit or vanish together lives in
 * tests/integration/extract-outbox-pg.test.ts.
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";

import { runCli, type CliClient, type CliDeps } from "../../src/cli/extract.js";
import { FakeLLMClient } from "../../src/core/extraction/llm-client.js";
import { FakeEmbedder } from "../../src/core/embedder.js";

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

const CHUNK_ID = "00000000-0000-4000-8000-000000000000";

const ALICE_OUTPUT = {
  head: "Alice Smith",
  headType: "person",
  relationRaw: "works at",
  relationNorm: "MEMBER_OF",
  tail: "Acme Corp",
  tailType: "organization",
  description: "Alice Smith works at Acme Corp",
  evidenceSpan: "Alice Smith works at Acme Corp",
  confidence: 0.9,
};

class FakeClient implements CliClient {
  queries: string[] = [];
  valuesList: unknown[][] = [];
  /** SQL fragment whose query should throw, simulating a write failure. */
  failOn?: string;
  async query(text: string, values?: unknown[]) {
    this.queries.push(text);
    this.valuesList.push(values ?? []);
    if (this.failOn && text.includes(this.failOn)) {
      throw new Error(`simulated failure on ${this.failOn}`);
    }
    return { rows: /FROM chunks c/.test(text) ? [scannedChunk()] : [] };
  }
  release(): void {}
}

function scannedChunk() {
  return { id: CHUNK_ID, content: "Alice Smith works at Acme Corp." };
}

function silentLogger() {
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
    pool: {
      async connect() {
        return client;
      },
      async end() {},
    },
    llm,
    embedder: new FakeEmbedder(8),
    dims: 8,
    logger: silentLogger(),
    now: () => "2026-08-26T00:00:00.000Z",
  };
}

function okLlm(outputs: unknown[]) {
  return new FakeLLMClient({
    scripted: async () => ({ kind: "ok" as const, outputs: outputs as never }),
  });
}

/** Run one chunk through the write path; returns the recording client. */
async function runOneChunk(
  llm: FakeLLMClient,
  over: { failOn?: string } = {}
): Promise<{ client: FakeClient; code: number }> {
  const client = new FakeClient();
  if (over.failOn !== undefined) client.failOn = over.failOn;
  const code = await runCli(["--batch-size", "1"], makeDeps(client, llm));
  return { client, code };
}

/** Bound values of every query whose SQL matches `pattern`, in order. */
function boundValuesFor(client: FakeClient, pattern: RegExp): unknown[][] {
  const out: unknown[][] = [];
  for (let i = 0; i < client.queries.length; i += 1) {
    if (pattern.test(client.queries[i] ?? "")) out.push(client.valuesList[i]!);
  }
  return out;
}

/** Indexes into `client.queries` of every query matching `pattern`. */
function indexesOf(client: FakeClient, pattern: RegExp): number[] {
  const out: number[] = [];
  for (let i = 0; i < client.queries.length; i += 1) {
    if (pattern.test(client.queries[i] ?? "")) out.push(i);
  }
  return out;
}

/** `(subject_kind, subject_id)` of every intent the run emitted. */
function emittedSubjects(client: FakeClient): Array<[string, string]> {
  return boundValuesFor(client, /INSERT INTO projection_outbox/).map((v) => [
    v[1] as string,
    v[2] as string,
  ]);
}

describe("extract emits projection intents inside the chunk transaction (SC3)", () => {
  it("emits one pending intent per touched entity and triple", async () => {
    const { client, code } = await runOneChunk(okLlm([ALICE_OUTPUT]));
    expect(code).toBe(0);

    const entityIds = boundValuesFor(client, /INSERT INTO entities/).map(
      (v) => v[0] as string
    );
    const tripleIds = boundValuesFor(client, /INSERT INTO triples/).map(
      (v) => v[0] as string
    );
    expect(entityIds).toHaveLength(2);
    expect(tripleIds).toHaveLength(1);

    expect(emittedSubjects(client)).toEqual([
      ["entity", entityIds[0]!],
      ["entity", entityIds[1]!],
      ["triple", tripleIds[0]!],
    ]);
  });

  it("writes the intents as 'pending' and tolerates a duplicate subject", async () => {
    const { client } = await runOneChunk(okLlm([ALICE_OUTPUT]));

    const sql = client.queries.find((q) =>
      /INSERT INTO projection_outbox/.test(q)
    )!;
    expect(sql).toContain("'pending'");
    // The partial UNIQUE index is the idempotency guard; without DO NOTHING a
    // second intent for a still-pending subject would roll back the chunk.
    expect(sql).toMatch(/ON CONFLICT[\s\S]*DO NOTHING/);
  });

  it("never emits a chunk as a projection subject", async () => {
    const { client } = await runOneChunk(okLlm([ALICE_OUTPUT]));

    const kinds = emittedSubjects(client).map(([kind]) => kind);
    expect(kinds).not.toContain("chunk");
    expect(new Set(kinds)).toEqual(new Set(["entity", "triple"]));
    expect(emittedSubjects(client).map(([, id]) => id)).not.toContain(CHUNK_ID);
  });

  it("emits between the chunk's BEGIN and its COMMIT", async () => {
    const { client } = await runOneChunk(okLlm([ALICE_OUTPUT]));

    const begins = indexesOf(client, /^BEGIN$/);
    const commits = indexesOf(client, /^COMMIT$/);
    const emits = indexesOf(client, /INSERT INTO projection_outbox/);
    // The bootstrap runs its own BEGIN/COMMIT first; the chunk's are last.
    const chunkBegin = begins.at(-1)!;
    const chunkCommit = commits.at(-1)!;
    expect(emits.length).toBeGreaterThan(0);
    for (const at of emits) {
      expect(at).toBeGreaterThan(chunkBegin);
      expect(at).toBeLessThan(chunkCommit);
    }
  });

  it("emits nothing for a chunk whose extraction failed", async () => {
    const llm = new FakeLLMClient({
      scripted: async () => ({
        kind: "failed" as const,
        errorCode: "5xx",
        errorMsg: "upstream refused",
      }),
    });
    const { client, code } = await runOneChunk(llm);

    expect(code).toBe(0); // mark-and-continue
    expect(emittedSubjects(client)).toEqual([]);
  });

  it("a failing emit rolls the whole chunk back (exit 2, no COMMIT)", async () => {
    const { client, code } = await runOneChunk(okLlm([ALICE_OUTPUT]), {
      failOn: "INSERT INTO projection_outbox",
    });

    expect(code).toBe(2);
    const rollbacks = indexesOf(client, /^ROLLBACK$/);
    expect(rollbacks).toHaveLength(1);
    // The chunk's own COMMIT never ran: the only COMMIT is the bootstrap's,
    // which precedes the chunk's BEGIN.
    const commits = indexesOf(client, /^COMMIT$/);
    const chunkBegin = indexesOf(client, /^BEGIN$/).at(-1)!;
    expect(commits.every((at) => at < chunkBegin)).toBe(true);
    // The record was never marked succeeded either.
    expect(boundValuesFor(client, /SET status = 'succeeded'/)).toEqual([]);
  });
});
