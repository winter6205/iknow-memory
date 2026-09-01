#!/usr/bin/env node
/**
 * Shebang wrapper for the MCP stdio entry (`iknow-memory`).
 *
 * Plan D0 I-T3: this file is what fin's `DEFAULT_MCP_COMMAND =
 * ("iknow-memory",)` resolves to. It MUST be byte-stable (no extra
 * subcommand) so the host's command tuple lines up with the dist entry
 * to the letter.
 *
 * `extract`, `consolidate`, and `eval` each have their own bin entries;
 * they are not subcommands of this entry (parseStdioEntry rejects them).
 */
import("../dist/index.js").then(
  (mod) => mod.main(),
  (err) => {
    // eslint-disable-next-line no-console
    process.stderr.write(`iknow-memory: failed to load CLI: ${err.message}\n`);
    process.exit(1);
  }
);
