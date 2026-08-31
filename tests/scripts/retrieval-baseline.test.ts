import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "check-retrieval-baseline.ts");
const REAL_SPEC = join(ROOT, "specs", "retrieval-stack.md");

type RunResult = {
  status: number | null;
  output: string;
};

function runCheck(...paths: string[]): RunResult {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", SCRIPT, ...paths],
    {
      cwd: ROOT,
      encoding: "utf8",
    }
  );
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

function withTempDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "iknow-memory-retrieval-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeFixture(
  directory: string,
  name: string,
  content: string
): string {
  const path = join(directory, name);
  writeFileSync(path, content, "utf8");
  return path;
}

function hashesIn(output: string): string[] {
  return output.match(/\b[a-f0-9]{64}\b/g) ?? [];
}

describe("cross-repo retrieval baseline drift check", () => {
  it("accepts the real retrieval spec against an identical copy", () => {
    withTempDirectory((directory) => {
      const copy = join(directory, "retrieval-stack-copy.md");
      writeFileSync(copy, readFileSync(REAL_SPEC));

      const result = runCheck(REAL_SPEC, copy);

      expect(result.status).toBe(0);
      expect(result.output).toContain("OK:");
      expect(hashesIn(result.output)).toHaveLength(2);
      expect(hashesIn(result.output)[0]).toBe(hashesIn(result.output)[1]);
    });
  });

  it("compares only the section body when surrounding files differ", () => {
    withTempDirectory((directory) => {
      const first = writeFixture(
        directory,
        "first.md",
        [
          "# First document",
          "",
          "## 跨仓对齐基线",
          "",
          "shared baseline body",
          "",
          "## First-only section",
          "different surrounding content",
        ].join("\n")
      );
      const second = writeFixture(
        directory,
        "second.md",
        [
          "# Second document",
          "different preamble",
          "",
          "## 跨仓对齐基线",
          "",
          "shared baseline body",
          "",
          "## Second-only section",
          "another surrounding body",
        ].join("\n")
      );

      const result = runCheck(first, second);

      expect(result.status).toBe(0);
      expect(result.output).toContain("OK:");
    });
  });

  it("prints both hashes and fails after one byte of section drift", () => {
    withTempDirectory((directory) => {
      const first = writeFixture(
        directory,
        "first.md",
        "## 跨仓对齐基线\n\nshared baseline body\n\n## Next\n"
      );
      const second = writeFixture(
        directory,
        "second.md",
        "## 跨仓对齐基线\n\nshared baseline bodx\n\n## Next\n"
      );

      const result = runCheck(first, second);
      const hashes = hashesIn(result.output);

      expect(result.status).toBe(1);
      expect(result.output).toContain("FAIL:");
      expect(hashes).toHaveLength(2);
      expect(hashes[0]).not.toBe(hashes[1]);
    });
  });

  it("detects one byte of drift in the first section body too", () => {
    withTempDirectory((directory) => {
      const first = writeFixture(
        directory,
        "first.md",
        "## 跨仓对齐基线\n\nshared baseline bodx\n\n## Next\n"
      );
      const second = writeFixture(
        directory,
        "second.md",
        "## 跨仓对齐基线\n\nshared baseline body\n\n## Next\n"
      );

      const result = runCheck(first, second);
      const hashes = hashesIn(result.output);

      expect(result.status).toBe(1);
      expect(result.output).toContain("FAIL:");
      expect(hashes).toHaveLength(2);
      expect(hashes[0]).not.toBe(hashes[1]);
    });
  });

  it("rejects a missing spec file with a named error", () => {
    withTempDirectory((directory) => {
      const valid = writeFixture(
        directory,
        "valid.md",
        "## 跨仓对齐基线\n\nbaseline\n\n## Next\n"
      );

      const result = runCheck(valid, join(directory, "missing.md"));

      expect(result.status).toBe(1);
      expect(result.output).toMatch(/SpecFileError/);
      expect(result.output).toMatch(/missing\.md/);
    });
  });

  it("rejects an absent baseline section with a named error", () => {
    withTempDirectory((directory) => {
      const valid = writeFixture(
        directory,
        "valid.md",
        "## 跨仓对齐基线\n\nbaseline\n\n## Next\n"
      );
      const absent = writeFixture(
        directory,
        "absent.md",
        "# No shared baseline\n\n## Other section\ncontent\n"
      );

      const result = runCheck(valid, absent);

      expect(result.status).toBe(1);
      expect(result.output).toMatch(/SectionNotFoundError/);
      expect(result.output).toMatch(/absent\.md/);
    });
  });

  it("rejects an empty baseline section with a named error", () => {
    withTempDirectory((directory) => {
      const empty = writeFixture(
        directory,
        "empty.md",
        "## 跨仓对齐基线\n\n## Next\n"
      );
      const valid = writeFixture(
        directory,
        "valid.md",
        "## 跨仓对齐基线\n\nbaseline\n\n## Next\n"
      );

      const result = runCheck(empty, valid);

      expect(result.status).toBe(1);
      expect(result.output).toMatch(/EmptySectionError/);
      expect(result.output).toMatch(/empty\.md/);
    });
  });

  it("requires both section paths at runtime", () => {
    const result = runCheck();

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/ArgumentError/);
  });
});

const SPECIFIER_RE = /(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/g;

function toRepoRelative(fromFile: string, specifier: string): string {
  const absolute = resolve(dirname(join(ROOT, fromFile)), specifier);
  return relative(ROOT, absolute.replace(/\.js$/, ".ts")).split("\\").join("/");
}

function moduleGraph(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const relativePath = queue.pop()!;
    if (files.has(relativePath) || !existsSync(join(ROOT, relativePath))) {
      continue;
    }

    files.add(relativePath);
    const source = readFileSync(join(ROOT, relativePath), "utf8");
    for (const match of source.matchAll(SPECIFIER_RE)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) {
        queue.push(toRepoRelative(relativePath, specifier));
      } else {
        bare.add(specifier);
      }
    }
  }

  return { files, bare };
}

describe("retrieval baseline check isolation", () => {
  it("does not reach the MCP server entry transitively", () => {
    const graph = moduleGraph("scripts/check-retrieval-baseline.ts");

    expect(graph.files.has("src/index.ts")).toBe(false);
    expect([...graph.files].filter((file) => file.startsWith("src/"))).toEqual(
      []
    );
  });

  it("does not hard-code either repository spec path", () => {
    const source = readFileSync(SCRIPT, "utf8");

    expect(source).not.toContain("specs/retrieval-stack.md");
    expect(source).not.toContain("specs/corpus-retrieval.md");
  });

  it("publishes the check through npm scripts", () => {
    const packageJson = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8")
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["check:retrieval-baseline"]).toBe(
      "tsx scripts/check-retrieval-baseline.ts"
    );
  });
});
