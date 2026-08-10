/**
 * Isolation guard for the spec-3 retrieval bounded context.
 *
 * Mirrors `tests/cli/isolation.test.ts` (spec-2) for the graph-rag retrieval
 * boundary. Per `plans/p0-integration.md` §Isolation guard: only
 * `src/tools/retrieve.ts` and `src/core/retrieval/index.ts` (internal) are
 * allowed to import from `src/core/retrieval/*`. The MCP server entry
 * (`src/index.ts`), the ingest tool (`src/tools/ingest.ts`), and the offline
 * CLI (`src/cli/extract.ts`) must NOT — the ingestion / extraction paths
 * stay unaware of the new retrieval surface.
 *
 * Why regex instead of an AST parse: see isolation.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * Any `from ".../core/retrieval/..."` import. Anchored on `from` + a quoted
 * path so a string literal inside a comment or test name won't false
 * positive.
 */
const FORBIDDEN_PATTERNS: RegExp[] = [/from\s+["'][^"']*core\/retrieval\//];

/**
 * Target files that must stay free of retrieval-bound imports. Note this
 * is narrower than the spec-2 isolation guard (which scans all of
 * `src/tools/`): `src/tools/retrieve.ts` legitimately consumes the
 * retrieval context as the tool's own pipeline, so it is excluded
 * here. The plan's success criterion is the form "everywhere except
 * the retrieve tool and the retrieval/ folder itself".
 */
const TARGETS = [
  "src/index.ts",
  "src/tools/ingest.ts",
  "src/cli/extract.ts",
] as const;

describe("retrieval isolation guard (spec-3 bounded context)", () => {
  it.each(TARGETS)("%s has no import from src/core/retrieval/*", (relPath) => {
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
          `Retrieval is the MCP retrieve tool's private pipeline; the ` +
          `server entry, ingest path, and CLI must stay unaware of it.`
      );
    }
    expect(hits).toEqual([]);
  });

  it("no target file imports from src/core/retrieval/* (global scan)", () => {
    // Redundant with the per-file test above, but a single catch-all
    // assertion makes the blast radius obvious in a test failure summary:
    // operators see "0 total" rather than a long per-file list.
    let total = 0;
    for (const relPath of TARGETS) {
      const src = readFileSync(join(ROOT, relPath), "utf8");
      for (const re of FORBIDDEN_PATTERNS) {
        total += (src.match(re) ?? []).length;
      }
    }
    expect(total).toBe(0);
  });
});
