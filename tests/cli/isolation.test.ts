/**
 * Isolation guard for the extraction+merge bounded contexts.
 *
 * Success Criterion #14 (specs/p0-extraction.md §Success Criteria):
 * `src/index.ts` and every `src/tools/*.ts` file must NOT import from
 * `src/core/extraction/*` or `src/core/entities/merge`.
 *
 * The MCP server stays ingest+retrieve only — extraction is an offline CLI
 * trigger, never an MCP tool. This test enforces that architectural boundary
 * at the source level so any future import slips at code-review time.
 *
 * Why regex instead of an AST parse: this is a negative assertion on file
 * imports. AST parsing would work, but regex over import statements is
 * sufficient because:
 *   - ESM in this project uses `from "../core/extraction/..."` form only
 *     (no dynamic imports, no namespace aliases that escape the path).
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
const FORBIDDEN_PATTERNS: RegExp[] = [
  // from "../core/extraction/..." or from "../../core/extraction/..."
  /from\s+["'][^"']*core\/extraction\//,
  // from "../core/entities/merge" (only the merge module is forbidden;
  // entities/types and entities/resolve are used elsewhere legitimately)
  /from\s+["'][^"']*core\/entities\/merge["']/,
  // from "../core/entities/merge.js"
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

describe("isolation guard (Success Criterion #14)", () => {
  const targets = ["src/index.ts", ...collectSources("src/tools")];

  it.each(targets)("%s has no forbidden imports", (relPath) => {
    const abs = join(ROOT, relPath);
    const src = readFileSync(abs, "utf8");
    const hits: string[] = [];
    for (const re of FORBIDDEN_PATTERNS) {
      const match = src.match(re);
      if (match) hits.push(match[0]);
    }
    if (hits.length > 0) {
      throw new Error(
        `${relPath} imports from a forbidden module: ${hits.join("; ")}. ` +
          `Extraction and merge are CLI-only — the MCP server must stay ` +
          `unaware of them (Success Criterion #14).`
      );
    }
    expect(hits).toEqual([]);
  });
});
