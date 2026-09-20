#!/usr/bin/env node
/**
 * Shebang wrapper for `embed-rotate`. Resolves the compiled CLI entry
 * point like bin/extract.js.
 */
import("../dist/cli/embed-rotate.js").then(
  (mod) => mod.main(),
  (err) => {
    // eslint-disable-next-line no-console
    process.stderr.write(`embed-rotate: failed to load CLI: ${err.message}\n`);
    process.exit(1);
  }
);
