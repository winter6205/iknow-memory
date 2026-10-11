/**
 * Baseline append, steady-state, atomic write (specs/p0-eval.md A2, A10,
 * SC12, SC13, SC16).
 *
 * Bootstrap is the only operation this module owns until the release
 * gate locks absolute thresholds: append three axes per chunk snapshot,
 * no gold model is rewritten, no threshold is consulted. The behaviours
 * below are the test-bed that locks A2 / A10 / SC12 / SC13 / SC16 into
 * the suite so an extraction-F1 series stays comparable run-to-run.
 *
 * Spec axes under test:
 *   A2  Bootstrap records three axes only — no thresholds are applied.
 *   A10 Atomic write via temp + rename, default path `gold-set/baseline.json`,
 *       optional env override.
 *   SC12 append records three axes; release gate refuses until thresholds
 *       are locked (helper only — the full gate is E-T5).
 *   SC13 adjacent F1 delta ≤ 0.05 reports ready-to-lock; delta > 0.05
 *       keeps Bootstrap. The 0.05 boundary is asserted both ways
 *       (0.0499 passes, 0.0501 fails).
 *   SC16 two concurrent `--bootstrap` writers leave valid JSON containing
 *       both runs (never a truncated JSON file).
 *
 * No live LLM, no clock dependency — `recordedAt` is supplied by the
 * caller so tests stay deterministic.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendBaseline,
  baselineFilePath,
  bootstrapExists,
  DEFAULT_BASELINE_FILENAME,
  hasLockedThresholds,
  isReadyToLock,
  latestBaseline,
  readBaseline,
  readThresholds,
  writeThresholds,
  type BaselineEntry,
  type BaselineKey,
  type LockedThresholds,
} from "../../src/core/extraction-eval/index.js";

const scratchDirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-extraction-eval-baseline-"));
  scratchDirs.push(dir);
  return dir;
}

function defaultKey(suffix = ""): BaselineKey {
  return {
    snapshotId: `snapshot-v1${suffix}`,
    modelId: "extract-family/model-1",
    promptHash: "sha256:abc123",
  };
}

function axesFor(f1: number): BaselineEntry["axes"] {
  return { f1, schemaRate: 0.9, hallucinationRate: 0.05 };
}

function baseline(
  key: BaselineKey,
  axes: BaselineEntry["axes"],
  recordedAt: string
): BaselineEntry {
  return {
    snapshotId: key.snapshotId,
    modelId: key.modelId,
    promptHash: key.promptHash,
    axes,
    recordedAt,
  };
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

/** Catch the rejection so a test can assert on it. */
async function captureAppend(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

describe("baseline — file path resolution (A10)", () => {
  it("defaults to the memory home gold-set when no dir is given", () => {
    const previousHome = process.env.IKNOW_MEMORY_HOME;
    const previousGold = process.env.GOLD_SET_DIR;
    const home = freshDir();
    delete process.env.GOLD_SET_DIR;
    process.env.IKNOW_MEMORY_HOME = home;
    try {
      expect(baselineFilePath("")).toBe(
        join(home, "gold-set", DEFAULT_BASELINE_FILENAME)
      );
    } finally {
      if (previousHome === undefined) delete process.env.IKNOW_MEMORY_HOME;
      else process.env.IKNOW_MEMORY_HOME = previousHome;
      if (previousGold === undefined) delete process.env.GOLD_SET_DIR;
      else process.env.GOLD_SET_DIR = previousGold;
    }
  });

  it("joins an explicit dir with the default filename", () => {
    expect(baselineFilePath("custom-dir")).toBe(
      join("custom-dir", DEFAULT_BASELINE_FILENAME)
    );
  });
});

describe("readBaseline (A2, SC13)", () => {
  it("returns an empty array when the baseline file does not exist", () => {
    const dir = freshDir();
    expect(readBaseline(dir)).toEqual([]);
  });
});

describe("appendBaseline — single-writer round trip (A2, A10)", () => {
  it("persists the three axes and recordedAt", async () => {
    const dir = freshDir();
    const entry = baseline(defaultKey(), axesFor(0.7), "2026-08-30T00:00:00Z");

    await appendBaseline(dir, entry);

    const stored = readBaseline(dir);
    expect(stored).toEqual([entry]);
  });

  it("appends rather than overwrites across multiple calls", async () => {
    const dir = freshDir();
    const first = baseline(defaultKey(), axesFor(0.5), "2026-08-29T00:00:00Z");
    const second = baseline(
      defaultKey(),
      axesFor(0.55),
      "2026-08-30T00:00:00Z"
    );

    await appendBaseline(dir, first);
    await appendBaseline(dir, second);

    const stored = readBaseline(dir);
    expect(stored).toEqual([first, second]);
  });

  it("writes to a different baseline file in a different dir", async () => {
    const dirA = freshDir();
    const dirB = freshDir();
    const entryA = baseline(
      defaultKey("a"),
      axesFor(0.5),
      "2026-08-29T00:00:00Z"
    );
    const entryB = baseline(
      defaultKey("b"),
      axesFor(0.6),
      "2026-08-30T00:00:00Z"
    );

    await appendBaseline(dirA, entryA);
    await appendBaseline(dirB, entryB);

    expect(readBaseline(dirA)).toEqual([entryA]);
    expect(readBaseline(dirB)).toEqual([entryB]);
  });

  it("leaves the existing baseline file intact when append fails mid-write (atomic, A10)", async () => {
    const dir = freshDir();
    const original = baseline(
      defaultKey(),
      axesFor(0.5),
      "2026-08-29T00:00:00Z"
    );
    await appendBaseline(dir, original);

    // Append a malformed entry: F1 outside [0,1] is rejected before any
    // write happens, so the existing baseline on disk must stay parseable.
    const invalid = baseline(
      defaultKey(),
      { f1: -0.1, schemaRate: 0.9, hallucinationRate: 0.05 },
      "2026-08-30T00:00:00Z"
    );

    const err = await captureAppend(() => appendBaseline(dir, invalid));
    expect(err).toBeDefined();
    // The existing entry is still on disk and still parseable.
    expect(readBaseline(dir)).toEqual([original]);
  });
});

describe("appendBaseline — accepts only well-formed entries", () => {
  it("rejects a baseline entry whose F1 is outside [0,1]", async () => {
    const dir = freshDir();
    const bad = baseline(
      defaultKey(),
      { f1: 1.5, schemaRate: 0.9, hallucinationRate: 0.05 },
      "2026-08-30T00:00:00Z"
    );

    expect(await captureAppend(() => appendBaseline(dir, bad))).toBeDefined();
  });

  it("rejects a baseline entry whose schemaRate is outside [0,1]", async () => {
    const dir = freshDir();
    const bad = baseline(
      defaultKey(),
      { f1: 0.5, schemaRate: -0.01, hallucinationRate: 0.05 },
      "2026-08-30T00:00:00Z"
    );

    expect(await captureAppend(() => appendBaseline(dir, bad))).toBeDefined();
  });

  it("rejects a baseline entry whose hallucinationRate is outside [0,1]", async () => {
    const dir = freshDir();
    const bad = baseline(
      defaultKey(),
      { f1: 0.5, schemaRate: 0.9, hallucinationRate: 1.2 },
      "2026-08-30T00:00:00Z"
    );

    expect(await captureAppend(() => appendBaseline(dir, bad))).toBeDefined();
  });

  it("rejects a baseline entry with a non-ISO recordedAt", async () => {
    const dir = freshDir();
    const bad = baseline(defaultKey(), axesFor(0.5), "yesterday");

    expect(await captureAppend(() => appendBaseline(dir, bad))).toBeDefined();
  });

  it("rejects a baseline entry with a blank snapshotId / modelId / promptHash", async () => {
    const dir = freshDir();
    const bad: BaselineEntry = {
      snapshotId: "",
      modelId: "m",
      promptHash: "p",
      axes: axesFor(0.5),
      recordedAt: "2026-08-30T00:00:00Z",
    };

    expect(await captureAppend(() => appendBaseline(dir, bad))).toBeDefined();
  });
});

describe("latestBaseline + bootstrapExists (SC12, SC13)", () => {
  it("returns null when no entries exist", () => {
    const dir = freshDir();
    expect(latestBaseline(dir, defaultKey())).toBeNull();
  });

  it("returns null when entries exist but none match the key", async () => {
    const dir = freshDir();
    const entry = baseline(
      defaultKey("-other"),
      axesFor(0.5),
      "2026-08-29T00:00:00Z"
    );
    await appendBaseline(dir, entry);
    expect(latestBaseline(dir, defaultKey())).toBeNull();
  });

  it("returns the only entry when the key matches", async () => {
    const dir = freshDir();
    const entry = baseline(defaultKey(), axesFor(0.5), "2026-08-29T00:00:00Z");
    await appendBaseline(dir, entry);

    expect(latestBaseline(dir, defaultKey())).toEqual(entry);
  });

  it("returns the most recent recordedAt when multiple entries share a key", async () => {
    const dir = freshDir();
    const early = baseline(defaultKey(), axesFor(0.4), "2026-08-29T00:00:00Z");
    const later = baseline(defaultKey(), axesFor(0.7), "2026-08-30T00:00:00Z");
    await appendBaseline(dir, early);
    await appendBaseline(dir, later);

    expect(latestBaseline(dir, defaultKey())).toEqual(later);
  });

  it("ignores entries whose snapshotId or modelId differs", async () => {
    const dir = freshDir();
    const matching = baseline(
      defaultKey(),
      axesFor(0.5),
      "2026-08-30T00:00:00Z"
    );
    const differentSnapshot = baseline(
      { ...defaultKey(), snapshotId: "snapshot-v2" },
      axesFor(0.6),
      "2026-08-30T01:00:00Z"
    );
    const differentModel = baseline(
      { ...defaultKey(), modelId: "extract-family/model-2" },
      axesFor(0.7),
      "2026-08-30T02:00:00Z"
    );
    await appendBaseline(dir, differentSnapshot);
    await appendBaseline(dir, differentModel);
    await appendBaseline(dir, matching);

    expect(latestBaseline(dir, defaultKey())).toEqual(matching);
  });

  it("bootstrapExists returns false on a fresh directory", () => {
    const dir = freshDir();
    expect(bootstrapExists(dir)).toBe(false);
  });

  it("bootstrapExists flips to true as soon as one entry is appended", async () => {
    const dir = freshDir();
    const before = bootstrapExists(dir);
    await appendBaseline(
      dir,
      baseline(defaultKey(), axesFor(0.5), "2026-08-30T00:00:00Z")
    );
    const after = bootstrapExists(dir);

    expect(before).toBe(false);
    expect(after).toBe(true);
  });
});

describe("isReadyToLock — SC13 0.05 boundary, both ways", () => {
  it("reports ready-to-lock when there is no previous entry (first record)", () => {
    expect(isReadyToLock(null, axesFor(0.5))).toBe(true);
  });

  it("reports ready-to-lock when the F1 delta is 0 (identical run)", () => {
    const prev = baseline(defaultKey(), axesFor(0.6), "2026-08-29T00:00:00Z");
    expect(isReadyToLock(prev, axesFor(0.6))).toBe(true);
  });

  it("reports ready-to-lock at the inclusive boundary 0.0499", () => {
    const prev = baseline(defaultKey(), axesFor(0.6), "2026-08-29T00:00:00Z");
    expect(isReadyToLock(prev, axesFor(0.6 + 0.0499))).toBe(true);
  });

  it("does NOT report ready-to-lock when the delta is 0.0501", () => {
    const prev = baseline(defaultKey(), axesFor(0.6), "2026-08-29T00:00:00Z");
    expect(isReadyToLock(prev, axesFor(0.6 + 0.0501))).toBe(false);
  });

  it("does NOT report ready-to-lock when the delta is 0.06", () => {
    const prev = baseline(defaultKey(), axesFor(0.6), "2026-08-29T00:00:00Z");
    expect(isReadyToLock(prev, axesFor(0.66))).toBe(false);
  });

  it("honors the boundary value when supplied (parameterization for tunable)", () => {
    const prev = baseline(defaultKey(), axesFor(0.6), "2026-08-29T00:00:00Z");
    // Exact 0.04 delta: a stricter 0.03 boundary makes it NOT ready-to-lock.
    expect(isReadyToLock(prev, axesFor(0.64), 0.03)).toBe(false);
    // The default 0.05 still treats an exact 0.04 delta as ready-to-lock.
    expect(isReadyToLock(prev, axesFor(0.64), 0.05)).toBe(true);
  });
});

describe("appendBaseline — SC16 atomic concurrent writes", () => {
  it("keeps both records when two appends race on a shared baseline file", async () => {
    const dir = freshDir();
    const entryA = baseline(
      defaultKey("a"),
      axesFor(0.5),
      "2026-08-30T00:00:00Z"
    );
    const entryB = baseline(
      defaultKey("b"),
      axesFor(0.6),
      "2026-08-30T01:00:00Z"
    );

    await Promise.all([
      appendBaseline(dir, entryA),
      appendBaseline(dir, entryB),
    ]);

    const stored = readBaseline(dir);
    // Sorted by recordedAt so the assertion doesn't depend on writer order.
    const sorted = [...stored].sort((a, b) =>
      a.recordedAt.localeCompare(b.recordedAt)
    );
    expect(sorted).toEqual([entryA, entryB]);
  });

  it("leaves a parseable baseline JSON even when many writers race", async () => {
    const dir = freshDir();
    const writes = Array.from({ length: 8 }, (_, i) =>
      appendBaseline(
        dir,
        baseline(
          { ...defaultKey(), snapshotId: `snapshot-v1-${i}` },
          axesFor(0.5 + i * 0.01),
          new Date(Date.UTC(2026, 7, 30, 0, i)).toISOString()
        )
      )
    );

    await Promise.all(writes);

    const stored = readBaseline(dir);
    // All eight entries survive — the lock serializes appendBaseline, so
    // no read-modify-write ever sees a half-applied state.
    expect(stored).toHaveLength(8);
    // And the file is well-formed (parseable into BaselineEntries).
    for (const e of stored) {
      expect(typeof e.axes.f1).toBe("number");
      expect(e.axes.f1).toBeGreaterThanOrEqual(0);
      expect(e.axes.f1).toBeLessThanOrEqual(1);
    }
  });
});

describe("thresholds — refuse-until-lock helper (SC12, A2)", () => {
  it("reports no locked thresholds on a fresh directory", () => {
    const dir = freshDir();
    expect(hasLockedThresholds(dir)).toBe(false);
    expect(readThresholds(dir)).toBeNull();
  });

  it("reports locked thresholds once a thresholds file has been written", async () => {
    const dir = freshDir();
    const t: LockedThresholds = {
      f1Minimum: 0.85,
      schemaRateMinimum: 0.9,
      hallucinationRateMaximum: 0.1,
    };

    await writeThresholds(dir, t);

    expect(hasLockedThresholds(dir)).toBe(true);
    expect(readThresholds(dir)).toEqual(t);
  });

  it("round-trips thresholds through writeThresholds → readThresholds", async () => {
    const dir = freshDir();
    const t: LockedThresholds = {
      f1Minimum: 0.82,
      schemaRateMinimum: 0.95,
      hallucinationRateMaximum: 0.08,
    };

    await writeThresholds(dir, t);

    expect(readThresholds(dir)).toEqual(t);
  });
});
