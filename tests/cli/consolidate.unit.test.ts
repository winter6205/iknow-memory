import { describe, expect, it } from "vitest";

import {
  parseArgs,
  runCli,
  type ConsolidateClient,
  type ConsolidateDeps,
} from "../../src/cli/consolidate.js";

class FakeClient implements ConsolidateClient {
  queries: string[] = [];
  valuesList: unknown[][] = [];

  constructor(
    private readonly rows: unknown[],
    private readonly updatedId = "old-fact"
  ) {}

  async query(text: string, values?: unknown[]) {
    this.queries.push(text);
    this.valuesList.push(values ?? []);
    if (/SELECT[\s\S]*FROM triples/i.test(text)) return { rows: this.rows };
    if (/UPDATE triples/i.test(text)) return { rows: [{ id: this.updatedId }] };
    if (/INSERT INTO projection_outbox/i.test(text)) {
      return { rows: [{ id: "outbox-intent" }] };
    }
    return { rows: [] };
  }

  release(): void {}
}

function makeDeps(client: FakeClient): ConsolidateDeps {
  return {
    pool: {
      async connect() {
        return client;
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
    now: () => "2026-08-28T00:00:00.000Z",
  };
}

const FACTS = [
  {
    id: "old-fact",
    head_id: "head",
    tail_id: "old-tail",
    relation_norm: "works_for",
    confidence: 0.8,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_until: null,
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "new-fact",
    head_id: "head",
    tail_id: "new-tail",
    relation_norm: "works_for",
    confidence: 0.9,
    valid_from: "2026-08-01T00:00:00.000Z",
    valid_until: null,
    created_at: "2026-08-02T00:00:00.000Z",
  },
];

describe("consolidate CLI", () => {
  it("defaults to dry-run", () => {
    expect(parseArgs([])).toEqual({
      ok: true,
      flags: { dryRun: true, apply: false },
    });
  });

  it("dry-run reports candidates without writing", async () => {
    const client = new FakeClient(FACTS);

    expect(await runCli([], makeDeps(client))).toBe(0);
    expect(client.queries).toHaveLength(1);
    expect(client.queries[0]).toMatch(/SELECT[\s\S]*FROM triples/i);
    expect(
      client.queries.some((query) => /BEGIN|INSERT|UPDATE|DELETE/i.test(query))
    ).toBe(false);
  });

  it("apply points the old fact to the replacement and closes its validity", async () => {
    const client = new FakeClient(FACTS);

    expect(await runCli(["--apply"], makeDeps(client))).toBe(0);
    const updateIndex = client.queries.findIndex((query) =>
      /UPDATE triples/i.test(query)
    );
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(client.queries[updateIndex]).toContain("superseded_by");
    expect(client.queries[updateIndex]).toContain("valid_window");
    expect(client.valuesList[updateIndex]).toEqual([
      "old-fact",
      "new-fact",
      "2026-08-28T00:00:00.000Z",
    ]);
    expect(
      client.queries.some((query) =>
        /INSERT INTO projection_outbox/i.test(query)
      )
    ).toBe(true);
  });
});
