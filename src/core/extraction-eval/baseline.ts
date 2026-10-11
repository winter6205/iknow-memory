/**
 * Extraction-eval baseline append + steady-state + atomic write
 * (specs/p0-eval.md A2, A10, SC12, SC13, SC16).
 *
 * Owns the `gold-set/baseline.json` lifecycle:
 *
 *   A2   Bootstrap records the three axes — no threshold consulted.
 *   A10  Atomic write via temp + rename, default path under `gold-set/`,
 *        optional env override for the directory.
 *   SC12 append records three axes; the refuse-until-lock helper gates the
 *        release gate until operator commits a locked thresholds file.
 *   SC13 adjacent F1 delta ≤ 0.05 reports ready-to-lock; the boundary is
 *        exported so callers can tune it.
 *   SC16 two concurrent appends leave a parseable baseline JSON containing
 *        both runs (a brief cooperative lock serialises the
 *        read-modify-write so neither writer can read a half-applied
 *        state; the rename is still atomic on POSIX even if the writer
 *        dies between write and rename).
 *
 * Deliberate non-goals for this slice: no LLM call, no clock dependency
 * (callers stamp `recordedAt`), no gate logic (`hasLockedThresholds` is
 * only the boolean pill E-T5 will pill). The CLI in E-T6 wires the
 * `--bootstrap` flag to `appendBaseline` and the gate flags to E-T5.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { defaultEvalOutputDir } from "../../config/memory-home.js";

/** Default path (relative to the directory the caller passes). */
export const DEFAULT_BASELINE_FILENAME = "baseline.json";
/** Filename the locked thresholds are persisted under. */
export const DEFAULT_THRESHOLDS_FILENAME = "thresholds.json";
/** Lock file suffix — kept hidden so `ls` ignores it. */
const LOCK_SUFFIX = ".lock";
/** Temp-file prefix for the atomic rename dance. */
const TEMP_PREFIX = ".tmp-";

/** Optional environment override for the gold-set directory (A10). */
const ENV_GOLD_SET_DIR = "GOLD_SET_DIR";

/**
 * Single-axis record: the three values a bootstrap run stamps per
 * chunk snapshot (A2, SC12). All three are kept in [0, 1].
 */
export interface BaselineAxes {
  /** Micro-F1 across the gold/prediction match (SC4). */
  f1: number;
  /** Fraction of predicted triples whose relation_norm is a vocab term (SC5). */
  schemaRate: number;
  /** Fraction of predicted triples whose evidence span is a substring (SC6). */
  hallucinationRate: number;
}

/**
 * One bootstrap record. The triple `(snapshotId, modelId, promptHash)`
 * is the ruler identity — the same triple from a stale gold model
 * returns a different baseline curve, not a continuation (A7 / A9).
 */
export interface BaselineEntry {
  snapshotId: string;
  modelId: string;
  promptHash: string;
  axes: BaselineAxes;
  /** ISO 8601 timestamp supplied by the caller — keeps the module clock-free. */
  recordedAt: string;
}

/** Key the PR / Release gates use to look up "the latest baseline I trust". */
export interface BaselineKey {
  snapshotId: string;
  modelId: string;
  promptHash: string;
}

/** Operator-locked absolute thresholds, the refuse-until-lock companion to the baseline. */
export interface LockedThresholds {
  f1Minimum: number;
  schemaRateMinimum: number;
  hallucinationRateMaximum: number;
}

/** SC13 default — adjacent Bootstrap F1 delta at or below this is ready-to-lock. */
export const READY_TO_LOCK_DELTA = 0.05;

/* ------------------------------------------------------------------------ */
/* File path resolution (A10)                                              */
/* ------------------------------------------------------------------------ */

/**
 * Resolve the baseline file path inside `dir`. When `dir` is empty or
 * missing, falls back to the `GOLD_SET_DIR` env override, and finally
 * to the documented default `gold-set/`.
 *
 * Tests should never rely on the env — pass `dir` explicitly.
 */
export function baselineFilePath(dir?: string): string {
  return join(resolveGoldSetDir(dir), DEFAULT_BASELINE_FILENAME);
}

/** Same fallback chain as `baselineFilePath`, but for the thresholds file. */
export function thresholdsFilePath(dir?: string): string {
  return join(resolveGoldSetDir(dir), DEFAULT_THRESHOLDS_FILENAME);
}

function resolveGoldSetDir(dir?: string): string {
  const explicit = dir?.trim() ?? "";
  if (explicit !== "") return explicit;
  const fromEnv = process.env[ENV_GOLD_SET_DIR]?.trim() ?? "";
  if (fromEnv !== "") return fromEnv;
  return defaultEvalOutputDir();
}

/* ------------------------------------------------------------------------ */
/* Single-writer read helpers                                              */
/* ------------------------------------------------------------------------ */

/**
 * Read every baseline entry on disk. Returns `[]` if no baseline file
 * exists yet — a missing file is the bootstrap signal, not an error
 * (SC12 / SC13). A malformed file is a corruption signal and is
 * surfaced as a thrown error so the operator intervenes; the atomic
 * write guarantees the file is never truncated mid-write.
 */
export function readBaseline(dir: string): readonly BaselineEntry[] {
  const path = baselineFilePath(dir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (isMissingFile(err)) return [];
    throw err;
  }
  if (raw.trim() === "") return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new BaselineFileError(
      `baseline file "${path}" must contain a JSON array, got ${describe(parsed)}`,
      "BASELINE_MALFORMED"
    );
  }
  const entries: BaselineEntry[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    entries.push(parseBaselineEntry(parsed[i], i, path));
  }
  return entries;
}

/** Read locked thresholds, or `null` if no thresholds file is on disk. */
export function readThresholds(dir: string): LockedThresholds | null {
  const path = thresholdsFilePath(dir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (isMissingFile(err)) return null;
    throw err;
  }
  if (raw.trim() === "") return null;
  const parsed: unknown = JSON.parse(raw);
  return parseLockedThresholds(parsed, path);
}

/* ------------------------------------------------------------------------ */
/* SC12 bootstrap helper                                                   */
/* ------------------------------------------------------------------------ */

/** SC12 / A2: any bootstrap record on disk means Bootstrap is engaged. */
export function bootstrapExists(dir: string): boolean {
  return readBaseline(dir).length > 0;
}

/** SC12: refuse-until-lock — release gate cannot run until thresholds are committed. */
export function hasLockedThresholds(dir: string): boolean {
  return readThresholds(dir) !== null;
}

/* ------------------------------------------------------------------------ */
/* Query (no mutation)                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Most recent `BaselineEntry` whose ruler identity matches `key`.
 * Returns `null` when nothing matches — the gate distinguishes "no
 * data" (pass with a heads-up) from "old data" (compare), so this
 * branch is named explicitly in the type.
 *
 * "Most recent" orders by `recordedAt` descending, breaking ties by
 * append order so two entries stamped at the same wall-clock time
 * still resolve deterministically.
 */
export function latestBaseline(
  dir: string,
  key: BaselineKey
): BaselineEntry | null {
  const candidates = readBaseline(dir).filter(
    (entry) =>
      entry.snapshotId === key.snapshotId &&
      entry.modelId === key.modelId &&
      entry.promptHash === key.promptHash
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  return candidates[0]!;
}

/* ------------------------------------------------------------------------ */
/* SC13 steady state                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Steady-state boundary check (SC13): a Bootstrap run is
 * `ready-to-lock` when either there is no previous record for the same
 * ruler identity, or the absolute F1 delta against the previous record
 * is at or below the boundary (default 0.05).
 *
 * The boundary is a parameter rather than a constant so future tuning
 * never silently widens the SC13 contract: a call site that wants a
 * stricter trip wires its own number.
 */
export function isReadyToLock(
  prev: BaselineEntry | null,
  next: BaselineAxes,
  boundary: number = READY_TO_LOCK_DELTA
): boolean {
  if (prev === null) return true;
  return Math.abs(next.f1 - prev.axes.f1) <= boundary;
}

/* ------------------------------------------------------------------------ */
/* SC16 atomic concurrent writes                                           */
/* ------------------------------------------------------------------------ */

/** Lock acquisition tuning — defaults are kept conservative; CI bumps them if needed. */
export interface AppendOptions {
  /** Total ms to keep retrying before giving up with `BASELINE_LOCK_TIMEOUT`. Default 5000. */
  lockTimeoutMs?: number;
  /** Sleep between lock retries (ms). Default 10. */
  lockRetryMs?: number;
}

/**
 * Atomically append one baseline record (A2, A10, SC16).
 *
 *   1. Acquire a cooperative lock on `dir/.baseline.lock` so two
 *      concurrent writers cannot both observe the same pre-state and
 *      clobber each other on the way out.
 *   2. Read the existing array, validate every entry already on disk
 *      (defensive — a hand-edited file should not cause us to write
 *      a malformed array forward), append the new entry.
 *   3. Write to `baseline.json.tmp-<pid>-<nonce>`, then `rename` to
 *      `baseline.json`. POSIX rename is atomic within the same
 *      filesystem, so a process killed mid-write leaves the existing
 *      baseline file intact.
 *   4. Release the lock.
 *
 * `entry` is validated up-front; an invalid entry throws without
 * touching disk.
 */
export async function appendBaseline(
  dir: string,
  entry: BaselineEntry,
  opts: AppendOptions = {}
): Promise<void> {
  assertBaselineEntry(entry);
  const release = await acquireLock(lockfilePath(dir), opts);
  try {
    const existing = readBaseline(dir);
    const updated: BaselineEntry[] = [...existing, entry];
    atomicWriteJson(baselineFilePath(dir), updated);
  } finally {
    release();
  }
}

/**
 * Atomically write the locked thresholds file. Used by the CLI to
 * commit operator-locked values; the gate then refuses to run until
 * `hasLockedThresholds` returns true.
 */
export async function writeThresholds(
  dir: string,
  thresholds: LockedThresholds
): Promise<void> {
  assertLockedThresholds(thresholds);
  const release = await acquireLock(thresholdsLockfilePath(dir), {});
  try {
    atomicWriteJson(thresholdsFilePath(dir), thresholds);
  } finally {
    release();
  }
}

/* ------------------------------------------------------------------------ */
/* Internal: lock acquisition                                              */
/* ------------------------------------------------------------------------ */

/**
 * Spin-acquire a cooperative lock by `openSync(..., "wx")` — atomic
 * create-or-fail. Returns a release callback that unlinks the lockfile.
 * The release callback is safe to call more than once and safe to call
 * after the lockfile has already been removed by an external sweep.
 */
async function acquireLock(
  lockPath: string,
  opts: AppendOptions
): Promise<() => void> {
  const timeoutMs = opts.lockTimeoutMs ?? 5000;
  const retryMs = opts.lockRetryMs ?? 10;
  const deadline = Date.now() + timeoutMs;

  // Ensure the parent directory exists. mkdirSync with recursive:true is
  // a no-op if the directory is already there.
  mkdirSync(dirnameOf(lockPath), { recursive: true });

  while (Date.now() <= deadline) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx");
      // Stash the holder's pid in the lockfile so an operator running
      // `ls -la` after a crashed runner can spot the orphan.
      writeFileSync(fd, `${process.pid}\n`);
      // The fd is only here to claim the inode. Subsequent readers do
      // not need it; the lockfile's existence is the lock.
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Lock is held by someone — back off and retry.
      await sleep(retryMs);
      continue;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // best-effort close
        }
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        unlinkSync(lockPath);
      } catch {
        // The lockfile may already be gone (e.g. operator cleanup). Best-effort.
      }
    };
  }
  throw new BaselineFileError(
    `could not acquire baseline lock "${lockPath}" within ${timeoutMs}ms — another writer is hung; refusing to append a half-readable baseline (specs/p0-eval.md SC16)`,
    "BASELINE_LOCK_TIMEOUT"
  );
}

/* ------------------------------------------------------------------------ */
/* Internal: atomic JSON write                                             */
/* ------------------------------------------------------------------------ */

/**
 * Write `value` as pretty-printed JSON to a temp file in `dir`, then
 * rename over `path`. The temp filename embeds pid + a monotonic
 * counter so two writers cannot pick the same temp name even when
 * their PIDs collide (the counter is per-process and increments per
 * call within this module).
 */
function atomicWriteJson(path: string, value: unknown): void {
  const dir = dirnameOf(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${TEMP_PREFIX}${process.pid}-${nextNonce()}`);
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the leftover temp file. Failure here does
    // not shadow the original error.
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

let nonce = 0;
function nextNonce(): number {
  nonce = (nonce + 1) & 0xffff;
  return nonce;
}

/* ------------------------------------------------------------------------ */
/* Internal: parsing + validation                                         */
/* ------------------------------------------------------------------------ */

function parseBaselineEntry(
  raw: unknown,
  index: number,
  source: string
): BaselineEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BaselineFileError(
      `baseline entry [${index}] in "${source}" must be a JSON object, got ${describe(raw)}`,
      "BASELINE_MALFORMED"
    );
  }
  const entry = raw as Record<string, unknown>;
  const snapshotId = requireString(entry, "snapshotId", index, source);
  const modelId = requireString(entry, "modelId", index, source);
  const promptHash = requireString(entry, "promptHash", index, source);
  const recordedAt = requireString(entry, "recordedAt", index, source);
  assertIsoTimestamp(recordedAt, index, source);
  const axes = parseBaselineAxes(entry["axes"], index, source);
  return { snapshotId, modelId, promptHash, axes, recordedAt };
}

function parseBaselineAxes(
  raw: unknown,
  index: number,
  source: string
): BaselineAxes {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BaselineFileError(
      `baseline entry [${index}] in "${source}" has a non-object axes block, got ${describe(raw)}`,
      "BASELINE_MALFORMED"
    );
  }
  const obj = raw as Record<string, unknown>;
  const f1 = requireUnitInterval(obj, "f1", index, source);
  const schemaRate = requireUnitInterval(obj, "schemaRate", index, source);
  const hallucinationRate = requireUnitInterval(
    obj,
    "hallucinationRate",
    index,
    source
  );
  return { f1, schemaRate, hallucinationRate };
}

function parseLockedThresholds(raw: unknown, source: string): LockedThresholds {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BaselineFileError(
      `thresholds file "${source}" must be a JSON object, got ${describe(raw)}`,
      "BASELINE_MALFORMED"
    );
  }
  const obj = raw as Record<string, unknown>;
  return {
    f1Minimum: requireUnitInterval(obj, "f1Minimum", 0, source),
    schemaRateMinimum: requireUnitInterval(obj, "schemaRateMinimum", 0, source),
    hallucinationRateMaximum: requireUnitInterval(
      obj,
      "hallucinationRateMaximum",
      0,
      source
    ),
  };
}

function assertBaselineEntry(entry: BaselineEntry): void {
  if (
    typeof entry.snapshotId !== "string" ||
    entry.snapshotId.trim() === "" ||
    typeof entry.modelId !== "string" ||
    entry.modelId.trim() === "" ||
    typeof entry.promptHash !== "string" ||
    entry.promptHash.trim() === ""
  ) {
    throw new BaselineFileError(
      "baseline entry requires non-blank snapshotId, modelId, promptHash",
      "BASELINE_ENTRY_INVALID"
    );
  }
  if (typeof entry.recordedAt !== "string" || entry.recordedAt.trim() === "") {
    throw new BaselineFileError(
      "baseline entry requires a non-blank recordedAt",
      "BASELINE_ENTRY_INVALID"
    );
  }
  assertIsoTimestamp(entry.recordedAt, 0, "inline");
  requireUnitInterval(
    entry.axes as unknown as Record<string, unknown>,
    "f1",
    0,
    "inline"
  );
  requireUnitInterval(
    entry.axes as unknown as Record<string, unknown>,
    "schemaRate",
    0,
    "inline"
  );
  requireUnitInterval(
    entry.axes as unknown as Record<string, unknown>,
    "hallucinationRate",
    0,
    "inline"
  );
}

function assertLockedThresholds(t: LockedThresholds): void {
  const obj = t as unknown as Record<string, unknown>;
  requireUnitInterval(obj, "f1Minimum", 0, "inline");
  requireUnitInterval(obj, "schemaRateMinimum", 0, "inline");
  requireUnitInterval(obj, "hallucinationRateMaximum", 0, "inline");
}

function requireString(
  obj: Record<string, unknown>,
  field: string,
  index: number,
  source: string
): string {
  const value = obj[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new BaselineFileError(
      `baseline entry [${index}] in "${source}" requires a non-blank string field "${field}", got ${describe(value)}`,
      "BASELINE_MALFORMED"
    );
  }
  return value;
}

function requireUnitInterval(
  obj: Record<string, unknown>,
  field: string,
  index: number,
  source: string
): number {
  const value = obj[field];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new BaselineFileError(
      `baseline entry [${index}] in "${source}" requires field "${field}" to be a number in [0,1], got ${describe(value)}`,
      "BASELINE_MALFORMED"
    );
  }
  return value;
}

function assertIsoTimestamp(
  value: string,
  index: number,
  source: string
): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new BaselineFileError(
      `baseline entry [${index}] in "${source}" has an unparseable recordedAt "${value}" — must be an ISO 8601 timestamp`,
      "BASELINE_MALFORMED"
    );
  }
}

function isMissingFile(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return `${typeof value} ${JSON.stringify(value)}`;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return ".";
  return idx === 0 ? "/" : path.slice(0, idx);
}

function lockfilePath(dir: string): string {
  return join(dir, `${DEFAULT_BASELINE_FILENAME}${LOCK_SUFFIX}`);
}

function thresholdsLockfilePath(dir: string): string {
  return join(dir, `${DEFAULT_THRESHOLDS_FILENAME}${LOCK_SUFFIX}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/* ------------------------------------------------------------------------ */
/* Typed error                                                              */
/* ------------------------------------------------------------------------ */

export type BaselineFileErrorCode =
  "BASELINE_MALFORMED" | "BASELINE_ENTRY_INVALID" | "BASELINE_LOCK_TIMEOUT";

export class BaselineFileError extends Error {
  constructor(
    message: string,
    readonly code: BaselineFileErrorCode
  ) {
    super(message);
    this.name = "BaselineFileError";
  }
}
