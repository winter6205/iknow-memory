import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger, writeStderr } from "../../src/logging.js";

describe("production logger credential redaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not emit a PostgreSQL password embedded in logger fields", () => {
    const secret = "logger-postgres-secret";
    const output: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });

    createLogger("debug").error("database driver failed", {
      error: `connect failed for postgresql://ci-user:${secret}@db.example.test:5432/graph`,
    });

    expect(output.join("")).not.toContain(secret);
  });

  it("does not emit a line-wrapped BOLT password", () => {
    const secret = "line-wrapped-bolt-secret";
    const output: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });

    createLogger("warn").warn("graph driver failed", {
      error: `Neo4j at bolt://neo4j-user:\n${secret}@db.example.test:7687 is unreachable`,
    });

    expect(output).toHaveLength(1);
    expect(output.join("")).toContain("db.example.test");
    expect(output.join("")).not.toContain(secret);
  });

  it("does not emit a line-wrapped BOLT password at the stderr boundary", () => {
    const secret = "direct-line-wrapped-bolt-secret";
    const output: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });

    writeStderr(
      `Neo4j at bolt://neo4j-user:\n${secret}@db.example.test:7687 is unreachable\n`
    );

    expect(output.join("")).not.toContain(secret);
  });
});
