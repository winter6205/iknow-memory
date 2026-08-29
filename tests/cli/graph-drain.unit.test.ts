/**
 * graph-drain CLI unit tests (specs/neo4j-graph-arm.md T3, SC4).
 *
 * The drain is the second half of the projection outbox: T2 emits intents
 * inside the extract transaction, this CLI applies them to Neo4j and moves
 * each one to `done` or `failed`.
 *
 * Covered here, all on a fake Postgres and a fake `GraphWriter` so no live
 * database of either kind is needed:
 *   - pending → done with a `processed_at`, and the MERGE that earned it
 *   - an edge's endpoints are projected even when their own intent is not in
 *     the batch (MERGE_EDGES MATCHes endpoints, it does not create them)
 *   - failure: `attempts` bumped, `last_error` recorded, exit 3, retryable
 *   - re-drain is a no-op; an empty queue is a no-op
 *   - a subject the ledger no longer answers for is reported, not retried
 *     forever
 *   - `--dry-run` / `--retry-failed` never open Neo4j
 *   - chunks are never read and never projected (ADR-0001, SC1)
 *
 * The fake answers the CLI's own statements by pattern, so the SQL under test
 * is the SQL the assertions run against.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import {
  parseArgs,
  runCli,
  type DrainDeps,
} from "../../src/cli/graph-drain.js";
import {
  GraphUnavailableError,
  type GraphEdge,
  type GraphNode,
  type GraphWriter,
} from "../../src/core/graph/types.js";

const ALICE = "11111111-1111-4111-8111-111111111111";
const ACME = "22222222-2222-4222-8222-222222222222";
const RETIRED = "33333333-3333-4333-8333-333333333333";
const TRIPLE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TRIPLE_RETIRED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VALID_FROM = new Date("2026-08-01T00:00:00.000Z");

type Status = "pending" | "done" | "failed";
type Kind = "entity" | "triple";

interface OutboxRow {
  id: string;
  subject_kind: Kind;
  subject_id: string;
  status: Status;
  attempts: number;
  last_error: string | null;
  created_at: string;
  processed_at: string | null;
}

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

let intentSeq = 0;

function intent(
  kind: Kind,
  subjectId: string,
  over: Partial<OutboxRow> = {}
): OutboxRow {
  intentSeq += 1;
  return {
    id: `0000${String(intentSeq).padStart(4, "0")}-0000-4000-8000-000000000000`,
    subject_kind: kind,
    subject_id: subjectId,
    status: "pending",
    attempts: 0,
    last_error: null,
    // Same instant for every fixture intent: one extract transaction stamps
    // all of its intents with the transaction's `now()`, which is the tie the
    // claim's `subject_kind` ordering exists to break.
    created_at: "2026-08-26T00:00:00.000Z",
    processed_at: null,
    ...over,
  };
}

const LEDGER_ENTITIES: EntityRow[] = [
  { id: ALICE, canonical_name: "Alice Smith", type: "person", retired: false },
  { id: ACME, canonical_name: "Acme Corp", type: "system", retired: false },
  { id: RETIRED, canonical_name: "Old Alias", type: "person", retired: true },
];

const LEDGER_TRIPLES: TripleRow[] = [
  {
    id: TRIPLE,
    head_id: ALICE,
    tail_id: ACME,
    relation_norm: "works_for",
    confidence: 0.9,
    valid_from: VALID_FROM,
    valid_until: null,
  },
  {
    id: TRIPLE_RETIRED,
    head_id: RETIRED,
    tail_id: ACME,
    relation_norm: "works_for",
    confidence: 0.9,
    valid_from: VALID_FROM,
    valid_until: null,
  },
];

/**
 * In-memory stand-in for the ledger + `projection_outbox`. It implements the
 * claim's ordering and limit, the live-row filters, and the status
 * transitions, so ordering and idempotence are exercised rather than assumed.
 */
class FakeDb {
  outbox: OutboxRow[] = [];
  entities: EntityRow[] = LEDGER_ENTITIES.map((e) => ({ ...e }));
  triples: TripleRow[] = LEDGER_TRIPLES.map((t) => ({ ...t }));
  queries: string[] = [];
  private clock = 0;

  async query(text: string, values: unknown[] = []) {
    this.queries.push(text);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };
    if (/^\s*CREATE\s/i.test(text)) return { rows: [] };
    if (/^\s*WITH newest/i.test(text)) return { rows: this.reArm() };
    if (/^\s*SELECT status, count/i.test(text)) return { rows: this.counts() };
    if (/^\s*SELECT[\s\S]*FROM projection_outbox/i.test(text)) {
      return { rows: this.claim(Number(values[0])) };
    }
    if (/UPDATE projection_outbox[\s\S]*status = 'done'/i.test(text)) {
      return { rows: this.mark(values[0] as string[], "done", null) };
    }
    if (/UPDATE projection_outbox[\s\S]*status = 'failed'/i.test(text)) {
      return {
        rows: this.mark(values[0] as string[], "failed", values[1] as string),
      };
    }
    if (/FROM entities/i.test(text)) {
      const ids = new Set(values[0] as string[]);
      return {
        rows: this.entities.filter((e) => !e.retired && ids.has(e.id)),
      };
    }
    if (/FROM triples/i.test(text)) {
      const ids = new Set(values[0] as string[]);
      const live = new Set(
        this.entities.filter((e) => !e.retired).map((e) => e.id)
      );
      return {
        rows: this.triples.filter(
          (t) => ids.has(t.id) && live.has(t.head_id) && live.has(t.tail_id)
        ),
      };
    }
    throw new Error(`FakeDb: unmatched statement ${text}`);
  }

  release(): void {}

  byStatus(status: Status): OutboxRow[] {
    return this.outbox.filter((r) => r.status === status);
  }

  find(id: string): OutboxRow {
    const row = this.outbox.find((r) => r.subject_id === id);
    expect(row, `no intent for subject ${id}`).toBeDefined();
    return row!;
  }

  /** `ORDER BY created_at, subject_kind, id LIMIT $1` over pending rows. */
  private claim(limit: number): OutboxRow[] {
    return this.byStatus("pending")
      .slice()
      .sort((a, b) =>
        cmp(
          [a.created_at, a.subject_kind, a.id],
          [b.created_at, b.subject_kind, b.id]
        )
      )
      .slice(0, limit);
  }

  private mark(
    ids: string[],
    status: Status,
    lastError: string | null
  ): OutboxRow[] {
    const target = new Set(ids);
    const hit = this.outbox.filter((r) => target.has(r.id));
    this.clock += 1;
    for (const row of hit) {
      row.status = status;
      row.attempts += 1;
      row.last_error = lastError;
      row.processed_at = `2026-08-26T00:00:0${this.clock}.000Z`;
    }
    return hit;
  }

  /** Newest failed intent per subject, unless one is already pending. */
  private reArm(): OutboxRow[] {
    const pending = new Set(
      this.byStatus("pending").map((r) => `${r.subject_kind}:${r.subject_id}`)
    );
    const newest = new Map<string, OutboxRow>();
    for (const row of this.byStatus("failed")) {
      const key = `${row.subject_kind}:${row.subject_id}`;
      if (pending.has(key)) continue;
      const seen = newest.get(key);
      if (!seen || seen.created_at <= row.created_at) newest.set(key, row);
    }
    for (const row of newest.values()) {
      row.status = "pending";
      row.last_error = null;
      row.processed_at = null;
    }
    return [...newest.values()];
  }

  private counts(): { status: Status; count: number }[] {
    const out = new Map<Status, number>();
    for (const row of this.outbox) {
      out.set(row.status, (out.get(row.status) ?? 0) + 1);
    }
    return [...out].map(([status, count]) => ({ status, count }));
  }
}

function cmp(a: string[], b: string[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

class FakeWriter implements GraphWriter {
  nodes: GraphNode[] = [];
  edges: GraphEdge[] = [];
  deletedNodeIds: string[] = [];
  deletedEdgeIds: string[] = [];
  /** Every mergeNodes / mergeEdges call, in order. */
  calls: string[] = [];
  constraintCalls = 0;
  closed = 0;
  async ensureConstraints(): Promise<void> {
    this.constraintCalls += 1;
  }
  async mergeNodes(nodes: readonly GraphNode[]): Promise<void> {
    this.calls.push("nodes");
    this.nodes.push(...nodes);
  }
  async mergeEdges(edges: readonly GraphEdge[]): Promise<void> {
    this.calls.push("edges");
    this.edges.push(...edges);
  }
  async deleteNodes(ids: readonly string[]): Promise<void> {
    this.deletedNodeIds.push(...ids);
  }
  async deleteEdges(ids: readonly string[]): Promise<void> {
    this.deletedEdgeIds.push(...ids);
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}

interface Logged {
  msg: string;
  fields: Record<string, unknown> | undefined;
}

interface Harness {
  db: FakeDb;
  writer: FakeWriter;
  lines: Logged[];
  deps: DrainDeps;
  connects: number;
}

function harness(
  over: { connectGraph?: () => Promise<GraphWriter> } = {}
): Harness {
  const db = new FakeDb();
  const writer = new FakeWriter();
  const lines: Logged[] = [];
  const push = (msg: string, fields?: Record<string, unknown>) =>
    void lines.push({ msg, fields });
  const h: Harness = {
    db,
    writer,
    lines,
    connects: 0,
    deps: {} as DrainDeps,
  };
  h.deps = {
    pool: {
      async connect() {
        return db;
      },
      async end() {},
    },
    logger: {
      level: "info",
      debug: () => {},
      info: push,
      warn: push,
      error: push,
    },
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

const unreachable = () =>
  new GraphUnavailableError(
    "neo4j://localhost:7687",
    new Error("ECONNREFUSED")
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("graph-drain flag parsing", () => {
  it("rejects an unknown flag with a usage error (exit 2)", async () => {
    const h = harness();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(await runCli(["--nope"], h.deps)).toBe(2);

    expect(h.db.queries).toEqual([]);
    expect(h.connects).toBe(0);
  });

  it("--batch-size requires a positive integer", () => {
    expect(parseArgs(["--batch-size", "0"])).toEqual({
      ok: false,
      error: "--batch-size requires a positive integer",
    });
    expect(parseArgs(["--batch-size", "50"])).toMatchObject({ ok: true });
  });

  it("--dry-run and --retry-failed are mutually exclusive", () => {
    expect(parseArgs(["--dry-run", "--retry-failed"])).toEqual({
      ok: false,
      error: "--dry-run and --retry-failed are mutually exclusive",
    });
  });
});

describe("graph-drain applies pending intents (SC4)", () => {
  it("MERGEs the entity and marks the intent done with a processed_at", async () => {
    const h = harness();
    h.db.outbox.push(intent("entity", ALICE));

    const code = await runCli([], h.deps);

    expect(code).toBe(0);
    expect(h.writer.constraintCalls).toBe(1);
    expect(h.writer.nodes).toEqual([
      { id: ALICE, canonicalName: "Alice Smith", type: "person" },
    ]);
    expect(h.db.find(ALICE)).toMatchObject({
      status: "done",
      attempts: 1,
      last_error: null,
    });
    expect(h.db.find(ALICE).processed_at).not.toBeNull();
    expect(fieldsOf(h.lines, "graph-drain-complete")).toMatchObject({
      intents: 1,
      nodes: 1,
      edges: 0,
      unresolved: 0,
    });
    expect(h.writer.closed).toBe(1);
  });

  it("projects an edge with both endpoints, even without their own intents", async () => {
    // MERGE_EDGES MATCHes its endpoints instead of creating them, so a triple
    // intent alone must still carry its nodes or the edge is silently lost.
    const h = harness();
    h.db.outbox.push(intent("triple", TRIPLE));

    expect(await runCli([], h.deps)).toBe(0);

    expect(h.writer.nodes.map((n) => n.id).sort()).toEqual(
      [ALICE, ACME].sort()
    );
    expect(h.writer.edges).toEqual([
      {
        id: TRIPLE,
        headId: ALICE,
        tailId: ACME,
        relationNorm: "works_for",
        confidence: 0.9,
        validFrom: "2026-08-01T00:00:00.000Z",
        validUntil: null,
      },
    ]);
    // Nodes before edges: the reverse order would MATCH nothing.
    expect(h.writer.calls).toEqual(["nodes", "edges"]);
    expect(h.db.find(TRIPLE).status).toBe("done");
  });

  it("claims a whole extract transaction's intents nodes-first", async () => {
    const h = harness();
    h.db.outbox.push(
      intent("triple", TRIPLE),
      intent("entity", ALICE),
      intent("entity", ACME)
    );

    expect(await runCli(["--batch-size", "1"], h.deps)).toBe(0);

    // All three share one created_at, so 'entity' < 'triple' is what puts the
    // nodes in the earlier batches.
    expect(h.writer.calls).toEqual([
      "nodes",
      "edges",
      "nodes",
      "edges",
      "nodes",
      "edges",
    ]);
    expect(h.writer.nodes.slice(0, 2).map((n) => n.id)).toEqual([ALICE, ACME]);
    expect(h.db.byStatus("done")).toHaveLength(3);
    expect(fieldsOf(h.lines, "graph-drain-complete")).toMatchObject({
      intents: 3,
      batches: 3,
    });
  });

  it("MERGEs inside the claiming transaction and commits after", async () => {
    const h = harness();
    h.db.outbox.push(intent("entity", ALICE));

    await runCli([], h.deps);

    const claim = h.db.queries.find((q) => /FROM projection_outbox/.test(q))!;
    // Concurrent drains: the second one steps over locked rows instead of
    // re-projecting the same subject.
    expect(claim).toMatch(/FOR UPDATE SKIP LOCKED/);
    const shape = h.db.queries.filter((q) =>
      /^(BEGIN|COMMIT|ROLLBACK)$/.test(q)
    );
    expect(shape).toEqual(["BEGIN", "COMMIT", "BEGIN", "COMMIT"]);
    expect(h.db.queries).not.toContain("ROLLBACK");
  });

  it("never reads or projects chunks (ADR-0001, SC1)", async () => {
    const h = harness();
    h.db.outbox.push(intent("entity", ALICE), intent("triple", TRIPLE));

    await runCli([], h.deps);

    expect(h.db.queries.filter((q) => /\bchunks\b/.test(q))).toEqual([]);
    for (const node of h.writer.nodes) {
      expect(Object.keys(node).sort()).toEqual(["canonicalName", "id", "type"]);
    }
  });
});

describe("graph-drain is safe to re-run (SC4)", () => {
  it("an empty queue is a no-op", async () => {
    const h = harness();

    expect(await runCli([], h.deps)).toBe(0);

    expect(h.writer.nodes).toEqual([]);
    expect(h.writer.calls).toEqual([]);
    expect(fieldsOf(h.lines, "graph-drain-complete")).toMatchObject({
      intents: 0,
      batches: 0,
    });
  });

  it("a second drain claims nothing: done intents are not re-projected", async () => {
    const h = harness();
    h.db.outbox.push(intent("entity", ALICE), intent("triple", TRIPLE));

    expect(await runCli([], h.deps)).toBe(0);
    const afterFirst = h.writer.nodes.length + h.writer.edges.length;
    expect(await runCli([], h.deps)).toBe(0);

    expect(h.writer.nodes.length + h.writer.edges.length).toBe(afterFirst);
    expect(h.db.byStatus("done")).toHaveLength(2);
    expect(h.db.find(ALICE).attempts).toBe(1);
  });

  it("re-enqueuing a done subject drains it again in place", async () => {
    const h = harness();
    h.db.outbox.push(intent("entity", ALICE));
    await runCli([], h.deps);

    // What the extract path does when the same entity changes again.
    h.db.outbox.push(
      intent("entity", ALICE, { created_at: "2026-08-27T00:00:00.000Z" })
    );
    expect(await runCli([], h.deps)).toBe(0);

    expect(h.db.byStatus("done")).toHaveLength(2);
    // Same node id twice: the MERGE key is the ledger id, so the graph holds
    // one node however many times it is projected.
    expect(h.writer.nodes.map((n) => n.id)).toEqual([ALICE, ALICE]);
  });
});

describe("graph-drain reports failure and stays retryable (SC4)", () => {
  it("marks the in-flight batch failed with attempts + last_error, exit 3", async () => {
    const h = harness();
    h.db.outbox.push(intent("entity", ALICE));
    h.writer.mergeNodes = async () => {
      throw unreachable();
    };
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await runCli([], h.deps);

    expect(code).toBe(3);
    const row = h.db.find(ALICE);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("ECONNREFUSED");
    expect(row.processed_at).not.toBeNull();
    expect(h.db.queries).toContain("ROLLBACK");
    expect(fieldsOf(h.lines, "graph-drain-skipped")).toMatchObject({
      reason: "neo4j-unreachable",
    });
    expect(h.lines.map((l) => l.msg)).not.toContain("graph-drain-complete");
    expect(String(stderr.mock.calls[0]?.[0])).toContain("Validation:");
  });

  it("leaves the queue pending when Neo4j refuses the connection", async () => {
    const h = harness({
      connectGraph: async () => Promise.reject(unreachable()),
    });
    h.db.outbox.push(intent("entity", ALICE));
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(await runCli([], h.deps)).toBe(3);

    // Nothing was attempted, so nothing is a failed attempt.
    expect(h.db.find(ALICE)).toMatchObject({
      status: "pending",
      attempts: 0,
      last_error: null,
    });
  });

  it("--retry-failed re-arms a failed intent for the next drain", async () => {
    const h = harness();
    h.db.outbox.push(intent("entity", ALICE));
    h.writer.mergeNodes = async () => {
      throw unreachable();
    };
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await runCli([], h.deps)).toBe(3);

    expect(await runCli(["--retry-failed"], h.deps)).toBe(0);
    expect(fieldsOf(h.lines, "graph-drain-retry-armed")).toMatchObject({
      rearmed: 1,
    });
    expect(h.db.find(ALICE)).toMatchObject({
      status: "pending",
      last_error: null,
      processed_at: null,
    });

    const recovered = harness();
    recovered.db.outbox = h.db.outbox;
    expect(await runCli([], recovered.deps)).toBe(0);
    expect(h.db.find(ALICE)).toMatchObject({ status: "done", attempts: 2 });
  });

  it("--retry-failed opens no Neo4j connection", async () => {
    const h = harness();
    h.db.outbox.push(intent("entity", ALICE, { status: "failed" }));

    expect(await runCli(["--retry-failed"], h.deps)).toBe(0);

    expect(h.connects).toBe(0);
    expect(h.writer.nodes).toEqual([]);
  });
});

describe("graph-drain handles a subject the ledger dropped", () => {
  it("reports it, marks it done, and does not spin on it", async () => {
    const h = harness();
    h.db.outbox.push(
      intent("entity", RETIRED),
      intent("triple", TRIPLE_RETIRED)
    );

    const code = await runCli([], h.deps);

    expect(code).toBe(0);
    expect(h.writer.nodes).toEqual([]);
    expect(h.writer.edges).toEqual([]);
    expect(h.writer.deletedNodeIds).toEqual([RETIRED]);
    expect(h.writer.deletedEdgeIds).toEqual([TRIPLE_RETIRED]);
    expect(h.db.byStatus("done")).toHaveLength(2);
    expect(fieldsOf(h.lines, "graph-drain-complete")).toMatchObject({
      intents: 2,
      unresolved: 2,
    });
    expect(
      h.lines.filter((l) => l.msg === "graph-drain-subject-gone")
    ).toHaveLength(2);
  });
});

describe("graph-drain --dry-run", () => {
  it("reports the queue, opens no Neo4j connection, writes nothing", async () => {
    const h = harness();
    h.db.outbox.push(
      intent("entity", ALICE),
      intent("entity", ACME, { status: "failed", last_error: "boom" }),
      intent("triple", TRIPLE, { status: "done" })
    );

    const code = await runCli(["--dry-run"], h.deps);

    expect(code).toBe(0);
    expect(h.connects).toBe(0);
    expect(fieldsOf(h.lines, "graph-drain-plan")).toMatchObject({
      pending: 1,
      failed: 1,
      done: 1,
    });
    const writes = h.db.queries.filter((q) =>
      /^\s*(INSERT|UPDATE|DELETE)\s/i.test(q)
    );
    expect(writes).toEqual([]);
    expect(h.db.byStatus("pending")).toHaveLength(1);
  });
});
