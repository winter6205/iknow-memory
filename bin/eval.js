#!/usr/bin/env node
/**
 * Shebang wrapper for `eval`. Resolves the compiled CLI entry point
 * regardless of whether the package is installed globally (npm bin) or
 * invoked from a checkout (node_modules resolution falls through to the
 * dist/ sibling).
 */
import("../dist/cli/eval.js").then(
  (mod) => mod.main(),
  (err) => {
    // eslint-disable-next-line no-console
    process.stderr.write(`eval: failed to load CLI: ${err.message}\n`);
    process.exit(1);
  }
);
