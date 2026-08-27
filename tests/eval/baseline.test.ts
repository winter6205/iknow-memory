/**
 * Baseline rendering + atomic write (specs/retrieve-p5.md SC6 and the
 * SC9 concurrent class).
 *
 * Two properties matter here and neither is about retrieval:
 *
 *   - **Byte stability.** The baseline is git-tracked and diffed by
 *     humans, so rendering the same numbers twice must produce the same
 *     bytes — no clock, no map iteration order, no float formatting
 *     surprise.
 *   - **No torn file.** The Testing Strategy makes the implementer pick
 *     between an exclusive lock and an atomic write and then test the
 *     choice. The choice is write-temp-then-rename, so the test is:
 *     overlap several writers against one reader and prove every read
 *     saw one writer's complete output, never a splice of two.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  armSetFromDebug,
  renderBaseline,
  writeBaselineAtomic,
  type BaselineReport,
} from "../../src/core/eval/baseline.js";
import { BaselineWriteError } from "../../src/core/eval/errors.js";

const scratchDirs: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-eval-baseline-"));
  scratchDirs.push(dir);
  return dir;
}

function report(): BaselineReport {
  return {
    schema: "iknow-retrieve-p5/v1",
    gold: "retrieve-gold-v1",
    corpus: "retrieve-corpus-v1",
    armSet: "vector+bm25",
    queryCount: 2,
    meanPAt5: 0.30000000000000004,
    meanRAt5: 0.75,
    queries: [
      { id: "q1", query: "one", top5: ["a", "b"], pAt5: 0.2, rAt5: 0.5 },
      { id: "q2", query: "two", top5: ["c"], pAt5: 0.4, rAt5: 1 },
    ],
  };
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe("renderBaseline (SC6 byte stability)", () => {
  it("renders the same report to the same bytes every time", () => {
    expect(renderBaseline(report())).toBe(renderBaseline(report()));
  });

  it("round-trips through JSON without losing a field", () => {
    const parsed: unknown = JSON.parse(renderBaseline(report()));

    expect(parsed).toEqual(report());
  });

  it("ends with a newline so the file is a well-formed text file", () => {
    expect(renderBaseline(report()).endsWith("\n")).toBe(true);
  });
});

describe("armSetFromDebug (SC5 arm-set recording)", () => {
  it("reports vector only when the assembler ran no optional arm", () => {
    expect(armSetFromDebug(undefined)).toBe("vector");
  });

  it("reports two arms when only the lexical arm reported hits", () => {
    expect(armSetFromDebug({ vectorHits: 3, bm25Hits: 0 })).toBe("vector+bm25");
  });

  it("reports three arms when the graph arm also ran", () => {
    expect(armSetFromDebug({ vectorHits: 3, bm25Hits: 2, graphHits: 1 })).toBe(
      "vector+bm25+graph"
    );
  });

  it("reads arm participation from the key, not from the hit count", () => {
    // An arm that ran and found nothing still ran: recording it as absent
    // would make an empty-result arm indistinguishable from a skipped one.
    expect(armSetFromDebug({ vectorHits: 0, graphHits: 0 })).toBe(
      "vector+graph"
    );
  });
});

describe("writeBaselineAtomic (SC9 concurrent)", () => {
  it("creates the target directory when it does not exist yet", async () => {
    const path = join(scratchDir(), "nested", "deeper", "baseline.json");

    await writeBaselineAtomic(path, renderBaseline(report()));

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(report());
  });

  it("never lets a reader observe a spliced file while writers overlap", async () => {
    const dir = scratchDir();
    const path = join(dir, "baseline.json");
    // Payloads big enough that a non-atomic write would be split across
    // several filesystem writes, and distinct enough that a splice of two
    // is impossible to mistake for either one.
    const payloads = Array.from(
      { length: 8 },
      (_, i) =>
        `${JSON.stringify({ writer: i, pad: String(i).repeat(300_000) })}\n`
    );
    // Seed the file first so the reader never races file creation and
    // therefore never needs to swallow an ENOENT.
    writeFileSync(path, payloads[0]!, "utf8");

    let reading = true;
    const observed: string[] = [];
    const reader = (async () => {
      while (reading) {
        observed.push(readFileSync(path, "utf8"));
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    await Promise.all(payloads.map((body) => writeBaselineAtomic(path, body)));
    reading = false;
    await reader;

    expect(observed.length).toBeGreaterThan(0);
    for (const seen of observed) {
      expect(payloads).toContain(seen);
    }
    expect(payloads).toContain(readFileSync(path, "utf8"));
  });

  it("leaves no temp files behind after concurrent writes", async () => {
    const dir = scratchDir();
    const path = join(dir, "baseline.json");

    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        writeBaselineAtomic(path, `{"writer":${i}}\n`)
      )
    );

    expect(readdirSync(dir)).toEqual(["baseline.json"]);
  });
});

describe("writeBaselineAtomic — failure is typed", () => {
  it("raises BaselineWriteError when the target path is unusable", async () => {
    const dir = scratchDir();
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "i am a file", "utf8");

    await expect(
      writeBaselineAtomic(join(blocker, "baseline.json"), "{}\n")
    ).rejects.toBeInstanceOf(BaselineWriteError);
  });

  it("names the path and the underlying cause in the message", async () => {
    const dir = scratchDir();
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "i am a file", "utf8");
    const target = join(blocker, "baseline.json");

    let thrown: unknown;
    try {
      await writeBaselineAtomic(target, "{}\n");
    } catch (err) {
      thrown = err;
    }

    expect((thrown as BaselineWriteError).message).toContain(target);
    expect((thrown as BaselineWriteError).message.length).toBeGreaterThan(
      target.length
    );
  });

  it("leaves an existing baseline untouched when the write fails", async () => {
    const dir = scratchDir();
    const path = join(dir, "baseline.json");
    writeFileSync(path, '{"kept":true}\n', "utf8");

    // A directory cannot be renamed over a file, so the rename step fails
    // after the temp write has already succeeded — the case that would
    // truncate the baseline if the writer wrote in place.
    await expect(writeBaselineAtomic(dir, "{}\n")).rejects.toBeInstanceOf(
      BaselineWriteError
    );
    expect(readFileSync(path, "utf8")).toBe('{"kept":true}\n');
  });
});
