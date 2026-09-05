/**
 * Isolation guard for the extraction+merge bounded contexts.
 *
 * Historical note: specs/p0-extraction.md SC14 forbade the MCP server from
 * importing `src/core/extraction/*` at all ("extraction is an offline CLI
 * trigger, never an MCP tool"). The MCP tool surface round REVERSED that
 * boundary by design: specs/mcp-tool-surface.md (assumption 9 / Does #2)
 * makes `extract` an MCP tool running the SAME lifted core pipeline
 * (`src/core/extraction`), and its SC13 sets the hard boundary that replaced
 * the old one — `src/tools` must never import `src/cli` (the CLI keeps only
 * flags, exit codes and operator reports; the MCP tool and the CLI are two
 * callers of one core module).
 *
 * This test enforces the CURRENT boundary at the source level so any future
 * import slip fails at test time:
 *   - every `src/tools/*.ts` file must NOT import from `src/cli/*`
 *     (SC13 of specs/mcp-tool-surface.md). `src/index.ts` is NOT in this
 *     target set: the stdio entry legitimately imports the CLI's
 *     `stdio-entry` argv parser;
 *   - `src/index.ts` and every `src/tools/*.ts` file must NOT import
 *     `src/core/entities/merge` directly (entity merging is an internal of
 *     the extraction capability — callers go through the pipeline module,
 *     never around it).
 *
 * Why regex instead of an AST parse: this is a negative assertion on file
 * imports. AST parsing would work, but regex over import statements is
 * sufficient because:
 *   - ESM in this project uses `from "../cli/..."` form only (no dynamic
 *     imports, no namespace aliases that escape the path).
 *   - The forbid-set is a literal path prefix; no alias resolution needed.
 *   - Regex reads in 2 lines; an AST dependency is one more thing to keep
 *     working.
 * The regex anchors on `from` + quoted path so a string literal inside a
 * comment or test name won't false-positive.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

/** SC13: the tool surface never reaches into the CLI. */
const CLI_IMPORT = /from\s+["'][^"']*\/cli\//;
/** Entity merging is pipeline-internal; no caller goes around it. */
const MERGE_IMPORT = [
  /from\s+["'][^"']*core\/entities\/merge["']/,
  /from\s+["'][^"']*core\/entities\/merge\.js["']/,
];

function collectSources(relDir: string): string[] {
  const dir = join(ROOT, relDir);
  const entries = readdirSync(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".ts")) {
      out.push(join(relDir, e.name));
    }
  }
  return out;
}

describe("isolation guard (SC13, specs/mcp-tool-surface.md)", () => {
  const toolSources = collectSources("src/tools");

  it.each(toolSources)("%s has no src/cli imports (SC13)", (relPath) => {
    const src = readFileSync(join(ROOT, relPath), "utf8");
    const hit = src.match(CLI_IMPORT);
    if (hit) {
      throw new Error(
        `${relPath} imports from src/cli: ${hit[0]}. src/tools must be a ` +
          `reverse-dependency-free caller of src/core/extraction (SC13 of ` +
          `specs/mcp-tool-surface.md) — flags, exit codes and operator ` +
          `reports stay in the CLI.`
      );
    }
    expect(hit).toBeNull();
  });

  it.each(["src/index.ts", ...toolSources])(
    "%s does not import the merge module directly",
    (relPath) => {
      const src = readFileSync(join(ROOT, relPath), "utf8");
      const hits = MERGE_IMPORT.map((re) => src.match(re)).filter(
        (m) => m !== null
      );
      if (hits.length > 0) {
        throw new Error(
          `${relPath} imports the entity merge module directly: ${hits
            .map((m) => m[0])
            .join("; ")}. Merging is internal to the extraction capability — ` +
            `call it through src/core/extraction, never around it.`
        );
      }
      expect(hits).toEqual([]);
    }
  );
});
