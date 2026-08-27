/**
 * Baseline report: shape, rendering and durable write
 * (specs/retrieve-p5.md SC6, plus the SC9 concurrent class).
 *
 * The baseline is git-tracked and diffed by humans, which drives two
 * decisions:
 *
 *   - **Nothing volatile in the payload.** No timestamp, no host name, no
 *     duration. A field that changes on every run turns every diff into
 *     noise and makes "byte-stable second run" untestable. Provenance is
 *     carried by the fixture VERSIONS instead, which only change when
 *     someone edits a fixture on purpose.
 *   - **The file is replaced, never edited in place.** Two overlapping
 *     runs must not be able to splice their output together, so the
 *     writer renames a fully-written temp file over the target. `rename`
 *     within one directory is atomic on POSIX and on Windows' `MoveFileEx`
 *     path that Node uses, so a reader sees the old file or the new one.
 */
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { BaselineWriteError } from "./errors.js";

/** One gold query's recorded outcome. */
export interface BaselineQuery {
  id: string;
  query: string;
  /** Fused chunk ids at rank 1..5 (fewer when retrieve returned fewer). */
  top5: string[];
  pAt5: number;
  rAt5: number;
}

export interface BaselineReport {
  /** Schema tag, so a later format change is detectable in a diff. */
  schema: "iknow-retrieve-p5/v1";
  /** `version` of the gold fixture that was scored. */
  gold: string;
  /** `version` of the seed corpus that was searched. */
  corpus: string;
  /** Which retrieval arms actually ran, e.g. `vector+bm25`. */
  armSet: string;
  queryCount: number;
  meanPAt5: number;
  meanRAt5: number;
  queries: BaselineQuery[];
}

/**
 * Arms the eval reports on, in the order they appear in an arm-set
 * string, paired with the debug key the retrieval orchestrator emits for
 * each. `vector` has no entry because it always runs.
 */
const OPTIONAL_ARM_DEBUG_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["bm25", "bm25Hits"],
  ["graph", "graphHits"],
];

/**
 * Derive the arm set from the retrieval envelope's own debug payload.
 *
 * Deliberately NOT recomputed from config + backend seams: that would be
 * a second copy of the orchestrator's arm gates, free to drift from the
 * arms that actually ran and silently mislabel every baseline. The
 * orchestrator emits one `<arm>Hits` key per arm it ran — presence, not
 * value — and an absent debug payload means no optional arm ran at all.
 */
export function armSetFromDebug(
  debug: Record<string, unknown> | undefined
): string {
  const arms = ["vector"];
  if (debug !== undefined) {
    for (const [arm, key] of OPTIONAL_ARM_DEBUG_KEYS) {
      if (key in debug) arms.push(arm);
    }
  }
  return arms.join("+");
}

/**
 * Render the report to the exact bytes that go on disk.
 *
 * Field order comes from the literal below rather than from the input
 * object, so a caller that builds the report in a different order still
 * produces an identical file.
 */
export function renderBaseline(report: BaselineReport): string {
  const ordered = {
    schema: report.schema,
    gold: report.gold,
    corpus: report.corpus,
    armSet: report.armSet,
    queryCount: report.queryCount,
    meanPAt5: report.meanPAt5,
    meanRAt5: report.meanRAt5,
    queries: report.queries.map((entry) => ({
      id: entry.id,
      query: entry.query,
      top5: entry.top5,
      pAt5: entry.pAt5,
      rAt5: entry.rAt5,
    })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Distinguishes concurrent writers inside one process. */
let tempSeq = 0;

/**
 * Write `body` to `path` atomically.
 *
 * The temp file is created in the TARGET's directory, not in the OS temp
 * dir: `rename` is only atomic within a filesystem, and a cross-device
 * rename would fall back to a copy — exactly the tearing this avoids.
 */
export async function writeBaselineAtomic(
  path: string,
  body: string
): Promise<void> {
  const dir = dirname(path);
  tempSeq += 1;
  const temp = join(dir, `.baseline-${process.pid}-${tempSeq}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(temp, body, "utf8");
    await rename(temp, path);
  } catch (err) {
    await removeQuietly(temp);
    throw new BaselineWriteError(
      `failed to write eval baseline "${path}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Drop the temp file after a failed write. A failure here is logged into
 * nothing on purpose: the caller is already throwing the error the
 * operator needs, and the temp file's presence is not the problem they
 * came to solve. The common case — the temp file was never created — is
 * indistinguishable from a real unlink failure at this layer.
 */
async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // EXIT: 主错误由调用方抛出；此处仅确保清理不会掩盖它
    return;
  }
}
