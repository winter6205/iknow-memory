#!/usr/bin/env node
/**
 * Shebang wrapper for `iknow-memory-config`. Resolves the compiled CLI
 * entry point regardless of whether the package is installed globally
 * (npm bin) or invoked from a checkout (node_modules resolution falls
 * through to the dist/ sibling).
 *
 * Operator-console T2: this bin is the home of the `iknow-memory-config`
 * setting CLI; it is intentionally NOT a subcommand of `iknow-memory`
 * (parseStdioEntry in src/cli/stdio-entry.ts rejects "config" so the
 * MCP server's argv parser stays stable for hosts that wire
 * `("iknow-memory",)`).
 */
import("../dist/cli/config.js").then(
  (mod) => mod.main(),
  (err) => {
    // eslint-disable-next-line no-console
    process.stderr.write(
      `iknow-memory-config: failed to load CLI: ${err.message}\n`
    );
    process.exit(1);
  }
);
