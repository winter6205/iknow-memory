/**
 * Parse the argv for the `iknow-memory` stdio entry.
 *
 * Plan D0 I-T3: the entry is the MCP stdio server. The only accepted
 * shapes are `iknow-memory` and `iknow-memory serve` (alias). Anything
 * else is a named failure — the bin must not silently spin up an MCP
 * session when an operator mistypes a subcommand, because that would
 * look like a hang to every downstream observer.
 *
 * `extract`, `consolidate`, and `eval` each have their own dedicated bin
 * entries (`bin/extract.js` etc.); they are explicitly NOT accepted as
 * positional args here. An operator who runs `iknow-memory extract` is
 * either confused (most likely — the right command is just `extract`)
 * or trying to chain CLIs (which we do not support); either way the
 * rejection is loud and named.
 */
export type StdioEntryMode = "stdio";

export type ParsedStdioEntry =
  { ok: true; mode: StdioEntryMode } | { ok: false; error: string };

const USAGE = "usage: iknow-memory [serve]";

export function parseStdioEntry(argv: readonly string[]): ParsedStdioEntry {
  if (argv.length === 0) return { ok: true, mode: "stdio" };
  if (argv.length === 1 && argv[0] === "serve") {
    return { ok: true, mode: "stdio" };
  }
  return {
    ok: false,
    error: `unknown argument "${argv[0] ?? ""}" (${USAGE})`,
  };
}
