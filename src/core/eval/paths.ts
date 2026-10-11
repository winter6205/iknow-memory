/**
 * Default on-disk locations for the evaluation capability's artifacts.
 *
 * Gold and corpus stay under `eval/` at the repo root. The baseline
 * file is a write; its default path is under the memory home.
 *
 * Resolution of the fixture paths is relative to this module rather than
 * `process.cwd()`, so `npm run eval:retrieve` finds the same gold and
 * corpus from a subdirectory. The three-level climb is identical for
 * both layouts the module ships in: `src/core/eval/` and `dist/core/eval/`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { memoryHomeDirectory } from "../../config/memory-home.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repo root — the parent of `src/` / `dist/`. */
export const REPO_ROOT = join(HERE, "..", "..", "..");

/** Frozen gold: query → relevant chunk ids (8–15 queries, A8). */
export const DEFAULT_GOLD_PATH = join(
  REPO_ROOT,
  "eval",
  "gold",
  "retrieve-v1.json"
);

/** Frozen seed corpus the gold ids point into. */
export const DEFAULT_CORPUS_PATH = join(
  REPO_ROOT,
  "eval",
  "corpus",
  "retrieve-v1.json"
);

/** Default write path for the retrieve-eval baseline. */
export function defaultBaselinePath(): string {
  return join(
    memoryHomeDirectory(null),
    "eval",
    "baseline",
    "retrieve-p5.json"
  );
}
