#!/usr/bin/env node
import("../dist/cli/consolidate.js").then(
  (mod) => mod.main(),
  (err) => {
    process.stderr.write(`consolidate: failed to load CLI: ${err.message}\n`);
    process.exit(1);
  }
);
