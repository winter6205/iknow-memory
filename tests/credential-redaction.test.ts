import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { warnPgUnavailable } from "./integration/pg-test-harness.js";

const TESTS_ROOT = fileURLToPath(new URL(".", import.meta.url));
const DIAGNOSTIC_SINK_PATTERN =
  /(?:console\.(?:warn|error|log|info|debug)|throw\s+new\s+Error|skipLoudly)\s*\(/g;
const RAW_CONNECTION_INTERPOLATION_PATTERN =
  /\$\{\s*(?:BASE_DB_URL|DB_URL|connectionString|SETTINGS\.uri)\s*\}/;

async function discoverTestFiles(): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(file);
      } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        files.push(file);
      }
    }
  }

  await visit(TESTS_ROOT);
  return files.sort();
}

function findUnsafeDiagnosticInterpolations(source: string): number[] {
  const findings: number[] = [];
  for (const match of source.matchAll(DIAGNOSTIC_SINK_PATTERN)) {
    const start = match.index ?? 0;
    const end = source.indexOf(");", start);
    const call = source.slice(start, end === -1 ? start + 1000 : end + 2);
    if (RAW_CONNECTION_INTERPOLATION_PATTERN.test(call)) {
      findings.push(start);
    }
  }
  return findings;
}

function lineNumberAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

describe("test diagnostic credential redaction", () => {
  it("finds no raw connection interpolation in diagnostic sinks", async () => {
    const findings: string[] = [];

    for (const file of await discoverTestFiles()) {
      const source = await readFile(file, "utf8");
      for (const offset of findUnsafeDiagnosticInterpolations(source)) {
        findings.push(
          `${relative(TESTS_ROOT, file)}:${lineNumberAt(source, offset)}`
        );
      }
    }

    expect(findings).toEqual([]);
  });

  it("does not emit a planted password through the shared warning", () => {
    const secret = "planted-password";
    const output: string[] = [];
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementation((message?: unknown) => {
        output.push(String(message));
      });

    try {
      warnPgUnavailable({
        label: "credential-redaction-test",
        testPath: "tests/credential-redaction.test.ts",
        expectedCommand: "npx vitest run tests/credential-redaction.test.ts",
        connectionString: `postgresql://test-user:${secret}@localhost/postgres`,
        error: new Error(`connection failed for ${secret}`),
        requiresVector: false,
      });
    } finally {
      warn.mockRestore();
    }

    expect(output.join("\n")).not.toContain(secret);
  });
});
