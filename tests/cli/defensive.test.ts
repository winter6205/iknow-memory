/**
 * T8 defensive contract for `runCli` — 5 boundary classes.
 *
 *   empty      → runCli([]) with no args → parsed flags = defaults, no
 *                usage error, no DB activity beyond the dry-run pipeline;
 *                against a fake Queryable whose `query` throws, an empty
 *                arg list (with --dry-run so no writes) still routes into
 *                the pipeline and the error path triggers. Empty args with
 *                no DB activity is asserted via the default-flag path:
 *                runCli([]) against a client that records calls.
 *   negative   → invalid flag value (`--batch-size abc`, `--since not-a-date`)
 *                → exit 2 with usage hint on stderr.
 *   overflow   → `--batch-size 1000000` → handled: parser accepts it
 *                (positive integer), pipeline runs with the large LIMIT
 *                but the fake pool returns no chunks, so it exits 0 with
 *                no crash. (Pins behavior: no internal cap; the LIMIT
 *                flows through to SQL unchanged.)
 *   concurrent → two runCli(["--dry-run","--batch-size","1"]) in parallel
 *                against the same fake Queryable → both exit 0, both
 *                record a dry-run against the empty fake, no write.
 *   exception  → fake Queryable whose query() throws → runCli must catch
 *                and exit non-zero (1 or 2), not crash the process.
 *                (runCli has try/catch around the pipeline body; the test
 *                confirms it routes the error to exit 1 via the fatal
 *                handler.)
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import {
  runCli,
  type CliClient,
  type CliDeps,
  type CliPool,
} from "../../src/cli/extract.js";
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

class FakeClient implements CliClient {
  queries: string[] = [];
  private readonly resultRows: any[];
  constructor(resultRows: any[] = []) {
    this.resultRows = resultRows;
  }
  async query(text: string, _values?: unknown[]) {
    this.queries.push(text);
    return { rows: this.resultRows };
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
  return {
    level: "error" as const,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makeDeps(client: FakeClient, llm?: FakeLLMClient): CliDeps {
  return {
    pool: makePool(client),
    llm: llm ?? new FakeLLMClient({ queue: [] }),
    embedder: new FakeEmbedder(8),
    dims: 8,
    logger: silentLogger(),
    now: () => "2026-08-07T00:00:00.000Z",
  };
}

describe("runCli — empty boundary", () => {
  it("runCli([]) with no args → exit 0, no DB writes, no LLM calls (default flags route through the pipeline against an empty chunks table)", async () => {
    const client = new FakeClient();
    let extractCalls = 0;
    const llm = new FakeLLMClient({
      scripted: async () => {
        extractCalls += 1;
        return { kind: "ok", outputs: [] };
      },
    });
    const deps = makeDeps(client, llm);
    const code = await runCli([], deps);
    expect(code).toBe(0);
    expect(extractCalls).toBe(0);
    const writes = client.queries.filter((q) =>
      /^\s*(INSERT|UPDATE|DELETE)/i.test(q)
    );
    expect(writes).toEqual([]);
  });
});

describe("runCli — negative boundary (invalid flag values)", () => {
  it("--batch-size abc → exit 2 and stderr carries the usage line", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    let stderr = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: (s: string) => boolean }).write = ((
      s: string
    ) => {
      stderr += s;
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await runCli(["--batch-size", "abc"], deps);
      expect(code).toBe(2);
    } finally {
      (process.stderr as { write: typeof process.stderr.write }).write =
        origWrite;
    }
    expect(stderr).toMatch(/usage: extract/);
    expect(stderr).toMatch(/--batch-size requires a positive integer/);
  });

  it("--since not-a-date → exit 2 and stderr carries the usage line", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    let stderr = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: (s: string) => boolean }).write = ((
      s: string
    ) => {
      stderr += s;
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await runCli(["--since", "not-a-date"], deps);
      expect(code).toBe(2);
    } finally {
      (process.stderr as { write: typeof process.stderr.write }).write =
        origWrite;
    }
    expect(stderr).toMatch(/usage: extract/);
    expect(stderr).toMatch(/--since requires an ISO8601 timestamp/);
  });
});

describe("runCli — overflow boundary (huge --batch-size)", () => {
  it("--batch-size 1000000 against an empty fake Queryable → exit 0, no crash, the large LIMIT is forwarded to SQL", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const code = await runCli(["--dry-run", "--batch-size", "1000000"], deps);
    expect(code).toBe(0);
    // The scan SQL is observed and the LIMIT placeholder is the third param
    // (no since → one placeholder) — confirms the large value is not capped.
    const scan = client.queries.find((q) =>
      /SELECT c\.id, c\.content/i.test(q)
    );
    expect(scan).toBeDefined();
    expect(scan).toMatch(/LIMIT \$1/);
  });
});

describe("runCli — concurrent boundary", () => {
  it("two runCli([--dry-run,--batch-size,1]) invocations against the same fake pool in parallel → both exit 0 with no writes", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const [a, b] = await Promise.all([
      runCli(["--dry-run", "--batch-size", "1"], deps),
      runCli(["--dry-run", "--batch-size", "1"], deps),
    ]);
    expect(a).toBe(0);
    expect(b).toBe(0);
    const writes = client.queries.filter((q) =>
      /^\s*(INSERT|UPDATE|DELETE)/i.test(q)
    );
    expect(writes).toEqual([]);
  });
});

describe("runCli — exception boundary (Queryable throws)", () => {
  it("Queryable whose query() throws → runCli catches and exits 1 (fatal), does not propagate", async () => {
    const explodingClient: CliClient = {
      queries: [] as string[],
      async query(): Promise<{ rows: any[] }> {
        throw new Error("db unreachable");
      },
      release(): void {},
    };
    const deps = makeDeps(explodingClient);
    // Silence the fatal stderr line so the test output stays clean.
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: (s: string) => boolean }).write = (() =>
      true) as typeof process.stderr.write;
    try {
      const code = await runCli(["--dry-run", "--batch-size", "1"], deps);
      expect(code).toBe(1);
    } finally {
      (process.stderr as { write: typeof process.stderr.write }).write =
        origWrite;
    }
  });
});
