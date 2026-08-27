/**
 * Boundary guards for the evaluation capability
 * (specs/retrieve-p5.md SC4, SC7, SC8, SC11).
 *
 * Four negative assertions that no behavioural test can make, because
 * each is about what the code must NOT reach for:
 *
 *   - **SC11 isolation.** Nothing in the eval CLI's module graph pulls in
 *     the Neo4j driver or the Postgres client, so an offline scorer
 *     cannot write to the graph or the ledger even by accident. Checked
 *     transitively, not just on the entry file — a direct-import-only
 *     scan would miss a driver imported one hop away.
 *   - **SC4 same fusion path.** The CLI imports the production
 *     orchestrator and does not carry its own copy of RRF.
 *   - **SC7 no new MCP surface.** The server entry and the MCP tools stay
 *     unaware that an evaluation capability exists.
 *   - **SC8 no new IR dependency.** The harness is hand-rolled on purpose;
 *     a `ranx` / `ir-datasets` / `pytrec_eval` style runtime dependency is
 *     exactly what the spec rules out.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

const EVAL_CLI = "src/cli/eval-retrieve.ts";

/** `from "x"`, `import "x"` and `import("x")` in one pass. */
const SPECIFIER_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function toRepoRelative(fromFile: string, specifier: string): string {
  const abs = resolve(dirname(join(ROOT, fromFile)), specifier);
  return relative(ROOT, abs.replace(/\.js$/, ".ts")).split("\\").join("/");
}

/**
 * Walk the relative-import graph from `entry` and report every file it
 * reaches plus every bare (package) specifier anywhere in that graph.
 */
function moduleGraph(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const rel = queue.pop()!;
    if (files.has(rel) || !existsSync(join(ROOT, rel))) continue;
    files.add(rel);
    const src = readFileSync(join(ROOT, rel), "utf8");
    for (const match of src.matchAll(SPECIFIER_RE)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) queue.push(toRepoRelative(rel, specifier));
      else bare.add(specifier);
    }
  }
  return { files, bare };
}

function evalCapabilitySources(): string[] {
  const dir = join(ROOT, "src", "core", "eval");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `src/core/eval/${name}`);
}

function mcpSurfaceSources(): string[] {
  const dir = join(ROOT, "src", "tools");
  return [
    "src/index.ts",
    ...readdirSync(dir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `src/tools/${name}`),
  ];
}

describe("eval CLI isolation (SC11)", () => {
  const graph = moduleGraph(EVAL_CLI);

  it("reaches the retrieval orchestrator, so the guard is scanning something", () => {
    // A walk that silently resolved nothing would pass every negative
    // assertion below. Pin the two files that must be in the graph.
    expect(graph.files.has("src/core/retrieval/index.ts")).toBe(true);
    expect(graph.files.has("src/core/eval/score.ts")).toBe(true);
  });

  it("never loads the Neo4j driver anywhere in its module graph", () => {
    expect([...graph.bare].filter((s) => s.includes("neo4j"))).toEqual([]);
  });

  it("never loads the Postgres client anywhere in its module graph", () => {
    expect(
      [...graph.bare].filter((s) => s === "pg" || s.startsWith("pg/"))
    ).toEqual([]);
  });

  it("never reaches the graph projection context", () => {
    expect(
      [...graph.files].filter((f) => f.startsWith("src/core/graph/"))
    ).toEqual([]);
  });

  it("imports no iknow runtime module", () => {
    expect([...graph.bare].filter((s) => s.includes("iknow"))).toEqual([]);
    expect(
      [...graph.files].filter(
        (f) => !f.startsWith("src/") && !f.startsWith("eval/")
      )
    ).toEqual([]);
  });
});

describe("eval capability stays out of the graph context (SC11)", () => {
  it.each(evalCapabilitySources())(
    "%s imports no graph or driver module",
    (rel) => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      const forbidden = [
        /from\s+["'][^"']*core\/graph\//,
        /from\s+["']neo4j-driver["']/,
        /from\s+["']pg["']/,
      ];
      const hits = forbidden.flatMap((re) => src.match(re) ?? []);

      expect(hits).toEqual([]);
    }
  );
});

describe("eval CLI uses the production fusion path (SC4)", () => {
  const cliSource = readFileSync(join(ROOT, EVAL_CLI), "utf8");

  it("imports assembleRetrievalResult from the retrieval orchestrator", () => {
    expect(cliSource).toMatch(
      /import\s*\{\s*assembleRetrievalResult\s*\}\s*from\s+["']\.\.\/core\/retrieval\/index\.js["']/
    );
  });

  it("carries no copy of the RRF fuser", () => {
    const rrfImporters = [EVAL_CLI, ...evalCapabilitySources()].filter((rel) =>
      /rrfFuse|retrieval\/rrf/.test(readFileSync(join(ROOT, rel), "utf8"))
    );

    expect(rrfImporters).toEqual([]);
  });
});

describe("no new MCP surface (SC7)", () => {
  it.each(mcpSurfaceSources())(
    "%s does not import the eval capability",
    (rel) => {
      const src = readFileSync(join(ROOT, rel), "utf8");

      expect(src).not.toMatch(/from\s+["'][^"']*core\/eval\//);
      expect(src).not.toMatch(/from\s+["'][^"']*cli\/eval-retrieve/);
    }
  );
});

describe("no new IR dependency (SC8)", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };

  /** Information-retrieval eval frameworks the spec rules out (SC8). */
  const IR_FRAMEWORK_RE = /^(ir[-_]|ranx|trec|beir|pyserini|rank[-_]eval)/i;

  it("adds no IR evaluation framework to dependencies", () => {
    expect(
      Object.keys(pkg.dependencies).filter((d) => IR_FRAMEWORK_RE.test(d))
    ).toEqual([]);
  });

  it("adds no IR evaluation framework to devDependencies either", () => {
    expect(
      Object.keys(pkg.devDependencies).filter((d) => IR_FRAMEWORK_RE.test(d))
    ).toEqual([]);
  });

  it("exposes the harness as an npm script instead", () => {
    expect(pkg.scripts["eval:retrieve"]).toBe("node dist/cli/eval-retrieve.js");
  });
});
