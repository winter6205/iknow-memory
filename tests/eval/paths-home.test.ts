/**
 * Retrieve-eval baseline writes follow IKNOW_MEMORY_HOME.
 * Gold and corpus stay the committed repo fixtures.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CORPUS_PATH,
  DEFAULT_GOLD_PATH,
  REPO_ROOT,
  defaultBaselinePath,
} from "../../src/core/eval/paths.ts";

const dirs: string[] = [];

afterEach(() => {
  delete process.env.IKNOW_MEMORY_HOME;
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("eval default paths", () => {
  it("writes the baseline under IKNOW_MEMORY_HOME and leaves gold and corpus in the repo", () => {
    const home = mkdtempSync(join(tmpdir(), "iknow-eval-paths-"));
    dirs.push(home);
    const previous = process.env.IKNOW_MEMORY_HOME;
    process.env.IKNOW_MEMORY_HOME = home;
    try {
      const baseline = defaultBaselinePath();
      expect(baseline.startsWith(home)).toBe(true);
      expect(baseline).toBe(join(home, "eval", "baseline", "retrieve-p5.json"));
      expect(DEFAULT_GOLD_PATH).toBe(
        join(REPO_ROOT, "eval", "gold", "retrieve-v1.json")
      );
      expect(DEFAULT_CORPUS_PATH).toBe(
        join(REPO_ROOT, "eval", "corpus", "retrieve-v1.json")
      );
      expect(DEFAULT_GOLD_PATH.startsWith(home)).toBe(false);
      expect(DEFAULT_CORPUS_PATH.startsWith(home)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.IKNOW_MEMORY_HOME;
      else process.env.IKNOW_MEMORY_HOME = previous;
    }
  });
});
