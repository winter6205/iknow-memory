/**
 * graph-backfill CLI unit tests (specs/neo4j-graph-arm.md T2, SC1–SC2).
 *
 * Covered here, all without a live Neo4j:
 *   - idempotence: a second run projects the same node/edge set and creates
 *     nothing new (the MERGE contract is what makes the re-run safe)
 *   - loud skip: Neo4j configured but unreachable → exit 3, nothing written,
 *     a Validation block on stderr instead of a silent success
 *   - `--dry-run` and `--reconcile` never open Neo4j at all
 *   - chunks are never read and never projected (ADR-0001)
 *   - retired entities and their edges stay out of the graph
 *
 * The fake pool implements the CLI's keyset pagination for real (id > cursor,
 * LIMIT n), so a multi-batch run is exercised rather than assumed.
 */
import { describe, it, expect } from "vitest";

import {
  parseArgs,
  runCli,
  type BackfillClient,
  type BackfillDeps,
} from "../../src/cli/graph-backfill.js";
import {
  GraphUnavailableError,
  type GraphEdge,
  type GraphNode,
  type GraphWriter,
} from "../../src/core/graph/types.js";

const ALICE = "11111111-1111-4111-8111-111111111111";
const ACME = "22222222-2222-4222-8222-222222222222";
const BOB = "33333333-3333-4333-8333-333333333333";
const RETIRED = "44444444-4444-4444-8444-444444444444";
const TRIPLE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TRIPLE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TRIPLE_RETIRED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

interface EntityRow {
  id: string;
  canonical_name: string;
  type: string;
  retired: boolean;
}

interface TripleRow {
  id: string;
  head_id: string;
  tail_id: string;
  relation_norm: string;
  confidence: number;
  valid_from: Date | null;
  valid_until: Date | null;
}

function entityRow(
  id: string,
  canonicalName: string,
  over: { retired?: boolean; type?: string } = {}
): EntityRow {
  return {
    id,
    canonical_name: canonicalName,
    type: over.type ?? "person",
    retired: over.retired ?? false,
  };
}

function tripleRow(
  id: string,
  headId: string,
  tailId: string,
  over: { validUntil?: Date | null } = {}
): TripleRow {
  return {
    id,
    head_id: headId,
    tail_id: tailId,
    relation_norm: "works_for",
    confidence: 0.9,
    valid_from: new Date("2026-08-01T00:00:00.000Z"),
    valid_until: over.validUntil ?? null,
  };
}

const ENTITIES = [
  entityRow(ALICE, "Alice Smith"),
  entityRow(ACME, "Acme Corp", { type: "system" }),
  entityRow(BOB, "Bob Jones"),
  entityRow(RETIRED, "Old Alias", { retired: true }),
];

const TRIPLES = [
  tripleRow(TRIPLE_A, ALICE, ACME),
  tripleRow(TRIPLE_B, BOB, ACME),
  tripleRow(TRIPLE_RETIRED, RETIRED, ACME),
];

/**
 * Fake Postgres that answers the CLI's two keyset-paginated scans and records
 * every statement, so "never touched chunks" is assertable.
 */
class FakeClient implements BackfillClient {
  queries: string[] = [];
  valuesList: unknown[][] = [];
  constructor(
    private readonly entities: EntityRow[] = ENTITIES,
    private readonly triples: TripleRow[] = TRIPLES
  ) {}

  async query(text: string, values: unknown[] = []) {
    this.queries.push(text);
    this.valuesList.push(values);
    if (/FROM entities/.test(text)) {
      return { rows: page(liveEntities(this.entities), values) };
    }
    if (/FROM triples/.test(text)) {
      return { rows: page(liveTriples(this.entities, this.triples), values) };
    }
    return { rows: [] };
  }
  release(): void {}
}

function liveEntities(entities: EntityRow[]): EntityRow[] {
  return entities.filter((e) => !e.retired).sort(byId);
}

/** Edges whose two endpoints are both live — the CLI's JOIN, in memory. */
function liveTriples(entities: EntityRow[], triples: TripleRow[]): TripleRow[] {
  const live = new Set(liveEntities(entities).map((e) => e.id));
  return triples
    .filter((t) => live.has(t.head_id) && live.has(t.tail_id))
    .sort(byId);
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** `[cursor, limit]` keyset slice, matching the CLI's WHERE id > $1 LIMIT $2. */
function page<T extends { id: string }>(rows: T[], values: unknown[]): T[] {
  const cursor = String(values[0] ?? "");
  const limit = Number(values[1] ?? rows.length);
  return rows.filter((r) => r.id > cursor).slice(0, limit);
}

class FakeWriter implements GraphWriter {
  nodes: GraphNode[] = [];
  edges: GraphEdge[] = [];
  constraintCalls = 0;
  closed = 0;
  async ensureConstraints(): Promise<void> {
    this.constraintCalls += 1;
  }
  async mergeNodes(nodes: readonly GraphNode[]): Promise<void> {
    this.nodes.push(...nodes);
  }
  async mergeEdges(edges: readonly GraphEdge[]): Promise<void> {
    this.edges.push(...edges);
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}

interface Logged {
  msg: string;
  fields: Record<string, unknown> | undefined;
}

function recordingLogger(lines: Logged[]) {
  return {
    level: "info" as const,
    debug: () => {},
    info: (msg: string, fields?: Record<string, unknown>) =>
      void lines.push({ msg, fields }),
    warn: (msg: string, fields?: Record<string, unknown>) =>
      void lines.push({ msg, fields }),
    error: (msg: string, fields?: Record<string, unknown>) =>
      void lines.push({ msg, fields }),
  };
}

interface Harness {
  client: FakeClient;
  writer: FakeWriter;
  lines: Logged[];
  deps: BackfillDeps;
  connects: number;
}

function harness(
  over: { client?: FakeClient; connectGraph?: () => Promise<GraphWriter> } = {}
): Harness {
  const client = over.client ?? new FakeClient();
  const writer = new FakeWriter();
  const lines: Logged[] = [];
  const h = {
    client,
    writer,
    lines,
    connects: 0,
    deps: {} as BackfillDeps,
  };
  h.deps = {
    pool: {
      async connect() {
        return client;
      },
      async end() {},
    },
    dims: 8,
    logger: recordingLogger(lines),
    connectGraph: async () => {
      h.connects += 1;
      if (over.connectGraph) return over.connectGraph();
      return writer;
    },
  };
  return h;
}

function fieldsOf(lines: Logged[], msg: string): Record<string, unknown> {
  const line = lines.find((l) => l.msg === msg);
  expect(line, `no "${msg}" line in ${JSON.stringify(lines)}`).toBeDefined();
  return line!.fields ?? {};
}

describe("graph-backfill flag parsing", () => {
  it("rejects an unknown flag with a usage error (exit 2)", async () => {
    const h = harness();
    expect(await runCli(["--nope"], h.deps)).toBe(2);
    expect(h.client.queries).toEqual([]);
    expect(h.connects).toBe(0);
  });

  it("--batch-size requires a positive integer", () => {
    expect(parseArgs(["--batch-size", "0"])).toEqual({
      ok: false,
      error: "--batch-size requires a positive integer",
    });
    expect(parseArgs(["--batch-size", "500"])).toMatchObject({ ok: true });
  });

  it("--dry-run and --reconcile are mutually exclusive", () => {
    expect(parseArgs(["--dry-run", "--reconcile"])).toEqual({
      ok: false,
      error: "--dry-run and --reconcile are mutually exclusive",
    });
  });
});

describe("graph-backfill projects the live ledger (SC2)", () => {
  it("merges every live entity as a node and every live triple as an edge", async () => {
    const h = harness();

    const code = await runCli(["--batch-size", "2"], h.deps);

    expect(code).toBe(0);
    expect(h.writer.constraintCalls).toBe(1);
    expect(h.writer.nodes).toEqual([
      { id: ALICE, canonicalName: "Alice Smith", type: "person" },
      { id: ACME, canonicalName: "Acme Corp", type: "system" },
      { id: BOB, canonicalName: "Bob Jones", type: "person" },
    ]);
    expect(h.writer.edges).toEqual([
      {
        id: TRIPLE_A,
        headId: ALICE,
        tailId: ACME,
        relationNorm: "works_for",
        confidence: 0.9,
        validFrom: "2026-08-01T00:00:00.000Z",
        validUntil: null,
      },
      {
        id: TRIPLE_B,
        headId: BOB,
        tailId: ACME,
        relationNorm: "works_for",
        confidence: 0.9,
        validFrom: "2026-08-01T00:00:00.000Z",
        validUntil: null,
      },
    ]);
    expect(fieldsOf(h.lines, "graph-backfill-complete")).toMatchObject({
      nodes: 3,
      edges: 2,
    });
    expect(h.writer.closed).toBe(1);
  });

  it("re-running projects the identical set — the backfill is idempotent", async () => {
    const first = harness();
    const second = harness();

    expect(await runCli([], first.deps)).toBe(0);
    expect(await runCli([], second.deps)).toBe(0);

    expect(second.writer.nodes).toEqual(first.writer.nodes);
    expect(second.writer.edges).toEqual(first.writer.edges);
    // Nodes are keyed by the ledger id, so a repeat MERGE updates in place
    // instead of minting a second node.
    expect(new Set(second.writer.nodes.map((n) => n.id)).size).toBe(
      second.writer.nodes.length
    );
    expect(new Set(second.writer.edges.map((e) => e.id)).size).toBe(
      second.writer.edges.length
    );
  });

  it("leaves retired entities and their edges out of the graph", async () => {
    const h = harness();

    await runCli([], h.deps);

    expect(h.writer.nodes.map((n) => n.id)).not.toContain(RETIRED);
    expect(h.writer.edges.map((e) => e.id)).not.toContain(TRIPLE_RETIRED);
    const entityScan = h.client.queries.find((q) => /FROM entities/.test(q))!;
    expect(entityScan).toMatch(/retired = false/);
  });

  it("never reads or projects chunks (ADR-0001)", async () => {
    const h = harness();

    await runCli([], h.deps);

    expect(h.client.queries.filter((q) => /\bchunks\b/.test(q))).toEqual([]);
    for (const node of h.writer.nodes) {
      expect(Object.keys(node).sort()).toEqual(["canonicalName", "id", "type"]);
    }
    for (const edge of h.writer.edges) {
      expect(Object.keys(edge)).not.toContain("sourceChunkId");
    }
  });

  it("pages the scans instead of loading the whole ledger at once", async () => {
    const h = harness();

    await runCli(["--batch-size", "1"], h.deps);

    const entityScans = h.client.valuesList.filter((_, i) =>
      /FROM entities/.test(h.client.queries[i] ?? "")
    );
    // 3 live entities at 1 per page = 3 full pages + 1 empty terminator.
    expect(entityScans).toHaveLength(4);
    expect(entityScans.every((v) => v[1] === 1)).toBe(true);
    expect(h.writer.nodes).toHaveLength(3);
  });
});

describe("graph-backfill loud-skips an unreachable Neo4j (SC2)", () => {
  it("exits 3 and writes nothing when the driver cannot connect", async () => {
    const h = harness({
      connectGraph: async () => {
        throw new GraphUnavailableError(
          "neo4j://localhost:7687",
          new Error("ECONNREFUSED")
        );
      },
    });

    const code = await runCli([], h.deps);

    expect(code).toBe(3);
    expect(h.writer.nodes).toEqual([]);
    expect(h.writer.edges).toEqual([]);
    expect(fieldsOf(h.lines, "graph-backfill-skipped")).toMatchObject({
      reason: "neo4j-unreachable",
    });
  });

  it("a mid-run Neo4j failure also exits 3 rather than reporting success", async () => {
    const h = harness();
    h.writer.mergeEdges = async () => {
      throw new GraphUnavailableError(
        "neo4j://localhost:7687",
        new Error("connection reset")
      );
    };

    const code = await runCli([], h.deps);

    expect(code).toBe(3);
    expect(h.lines.map((l) => l.msg)).not.toContain("graph-backfill-complete");
  });
});

describe("graph-backfill --dry-run", () => {
  it("counts what it would project, opens no Neo4j connection, writes nothing", async () => {
    const h = harness();

    const code = await runCli(["--dry-run"], h.deps);

    expect(code).toBe(0);
    expect(h.connects).toBe(0);
    expect(fieldsOf(h.lines, "graph-backfill-plan")).toMatchObject({
      entities: 3,
      triples: 2,
    });
    const writes = h.client.queries.filter((q) =>
      /^\s*(INSERT|UPDATE|DELETE)\s/i.test(q)
    );
    expect(writes).toEqual([]);
  });
});

describe("graph-backfill --reconcile", () => {
  it("re-arms one pending outbox intent per live subject without touching Neo4j", async () => {
    const h = harness();

    const code = await runCli(["--reconcile"], h.deps);

    expect(code).toBe(0);
    expect(h.connects).toBe(0);
    const emits: unknown[][] = [];
    for (let i = 0; i < h.client.queries.length; i += 1) {
      if (/INSERT INTO projection_outbox/.test(h.client.queries[i] ?? "")) {
        emits.push(h.client.valuesList[i]!);
      }
    }
    expect(emits.map((v) => [v[1], v[2]])).toEqual([
      ["entity", ALICE],
      ["entity", ACME],
      ["entity", BOB],
      ["triple", TRIPLE_A],
      ["triple", TRIPLE_B],
    ]);
    expect(fieldsOf(h.lines, "graph-reconcile-complete")).toMatchObject({
      entities: 3,
      triples: 2,
    });
  });

  it("is re-runnable: the emit tolerates an already-pending subject", async () => {
    const h = harness();

    expect(await runCli(["--reconcile"], h.deps)).toBe(0);
    expect(await runCli(["--reconcile"], h.deps)).toBe(0);

    const emitSql = h.client.queries.find((q) =>
      /INSERT INTO projection_outbox/.test(q)
    )!;
    expect(emitSql).toMatch(/ON CONFLICT[\s\S]*DO NOTHING/);
  });
});
