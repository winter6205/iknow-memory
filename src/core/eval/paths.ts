/**
 * Default on-disk locations for the evaluation capability's artifacts.
 *
 * Spelled once here so the CLI, the loaders and the tests cannot drift
 * apart. All three live under `eval/` at the repo root — git-tracked, as
 * SC6 requires of the baseline, and outside `src/` so `tsc --outDir dist`
 * never copies or shadows them.
 *
 * Resolution is relative to this module rather than `process.cwd()`, so
 * `npm run eval:retrieve` behaves the same from a subdirectory. The
 * three-level climb is identical for both layouts the module ships in:
 * `src/core/eval/` and `dist/core/eval/`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Git-tracked baseline the runner writes (SC6). */
export const DEFAULT_BASELINE_PATH = join(
  REPO_ROOT,
  "eval",
  "baseline",
  "retrieve-p5.json"
);
