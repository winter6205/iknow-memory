/**
 * Eval-stack CLI unit tests (specs/es-precision-layer.md SC-7).
 *
 * The CLI surface is tested via `runCli(argv, deps)` with an injected
 * `AblationRunner` so the suite needs no embedder, no storage and no
 * retrieval backend. Three contracts are pinned here:
 *
 *   - **Argument parsing**: defaults, every flag, mutually exclusive
 *     flags, and usage-error exit (2).
 *   - **Runner injection**: the runner sees every (config, repeat)
 *     cell, the report aggregates its samples, and an injected failure
 *     surfaces as a typed error with the offending configuration id.
 *   - **Render determinism + loud-skip exit code**: a successful run
 *     writes the same JSON / Markdown bytes twice; `--loud-skip` makes
 *     a successful run exit 3 instead of 0.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ABLATION_CAPABILITY_KEYS,
  type AblationCapability,
  type AblationConfig,
} from "../../src/core/eval/ablation-matrix.js";
import {
  parseArgs,
  runCli,
  translateCapabilities,
  type AblationRunner,
  type AblationRunnerSample,
  type EvalStackDeps,
} from "../../src/cli/eval-stack.js";
import type { Logger } from "../../src/logging.js";

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */

function silentLogger(): Logger {
  const noop = (): void => {};
  return { level: "error", debug: noop, info: noop, warn: noop, error: noop };
}

const scratchDirs: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-eval-stack-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
}

interface Fixtures {
  dir: string;
  goldPath: string;
  corpusPath: string;
  outPath: string;
}

/**
 * Minimal but valid fixtures — 10 queries inside the SC8 8–15 band,
 * matching corpus version. The corpus shape matches what
 * `core/eval/corpus.ts` parses; chunk ids exist so any real runner
 * can score against them.
 */
function writeFixtures(): Fixtures {
  const dir = scratchDir();
  const corpusPath = join(dir, "corpus.json");
  const goldPath = join(dir, "gold.json");
  const outPath = join(dir, "matrix");
  const corpus = {
    version: "test-corpus-v1",
    chunks: Array.from({ length: 10 }, (_, i) => ({
      id: `c-${i + 1}`,
      content: `chunk content ${i + 1}`,
      source_ref: `doc/${i + 1}`,
      metadata: {},
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_until: null,
    })),
  };
  const gold = {
    version: "test-gold-v1",
    corpus: "test-corpus-v1",
    queries: Array.from({ length: 10 }, (_, i) => ({
      id: `q-${i + 1}`,
      query: `query ${i + 1}`,
      relevant: [`c-${i + 1}`],
    })),
  };
  writeFileSync(corpusPath, JSON.stringify(corpus), "utf8");
  writeFileSync(goldPath, JSON.stringify(gold), "utf8");
  return { dir, goldPath, corpusPath, outPath };
}

/** A runner that returns whatever the factory decides. */
function scriptedRunner(
  factory: (config: AblationConfig, repeat: number) => AblationRunnerSample
): AblationRunner {
  return async ({ config, repeat }) => factory(config, repeat);
}

/** A runner that always returns a constant sample. */
function constantRunner(sample: AblationRunnerSample): AblationRunner {
  return async () => sample;
}

/* ------------------------------------------------------------------------ */
/* parseArgs                                                                */
/* ------------------------------------------------------------------------ */

describe("parseArgs — defaults", () => {
  it("refuses an empty argv because no --out was supplied", () => {
    const parsed = parseArgs([]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/--out/);
  });
});

describe("parseArgs — flags", () => {
  it("accepts --out as the canonical entry point", () => {
    const parsed = parseArgs(["--out", "/tmp/x"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.flags.jsonOutPath).toBe("/tmp/x.json");
    expect(parsed.flags.mdOutPath).toBe("/tmp/x.md");
    expect(parsed.flags.repeats).toBe(3);
    expect(parsed.flags.limit).toBe(10);
  });

  it("accepts --json-out and --md-out independently", () => {
    const parsed = parseArgs([
      "--json-out",
      "/tmp/x.json",
      "--md-out",
      "/tmp/x.md",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.flags.jsonOutPath).toBe("/tmp/x.json");
    expect(parsed.flags.mdOutPath).toBe("/tmp/x.md");
  });

  it("rejects a non-positive --repeat", () => {
    expect(parseArgs(["--out", "/tmp/x", "--repeat", "0"]).ok).toBe(false);
    expect(parseArgs(["--out", "/tmp/x", "--repeat", "-1"]).ok).toBe(false);
    expect(parseArgs(["--out", "/tmp/x", "--repeat", "abc"]).ok).toBe(false);
  });

  it("rejects a non-positive --limit", () => {
    expect(parseArgs(["--out", "/tmp/x", "--limit", "0"]).ok).toBe(false);
  });

  it("rejects a flag missing its value", () => {
    expect(parseArgs(["--out"]).ok).toBe(false);
  });

  it("rejects an unknown flag", () => {
    const parsed = parseArgs(["--out", "/tmp/x", "--bogus"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("--bogus");
  });

  it("rejects --single combined with --repeat (mutually exclusive)", () => {
    const parsed = parseArgs([
      "--out",
      "/tmp/x",
      "--single",
      "all-on",
      "--repeat",
      "2",
    ]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/mutually exclusive|--repeat|--single/);
  });

  it("rejects an empty --single id", () => {
    expect(parseArgs(["--out", "/tmp/x", "--single"]).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* runCli — exit codes                                                      */
/* ------------------------------------------------------------------------ */

describe("runCli — exit codes", () => {
  it("exits 0 on a successful run", async () => {
    const fix = writeFixtures();
    const code = await runCli(
      [
        "--out",
        fix.outPath,
        "--gold",
        fix.goldPath,
        "--corpus",
        fix.corpusPath,
      ],
      {
        runner: constantRunner({ meanPAt5: 0.5, meanRAt5: 0.5 }),
        logger: silentLogger(),
      }
    );
    expect(code).toBe(0);
  });

  it("exits 2 on usage error without touching the runner", async () => {
    const runner = vi.fn<AblationRunner>();
    const stderr = captureStderr();

    const code = await runCli(["--bogus"], {
      runner,
      logger: silentLogger(),
    });

    stderr.restore();
    expect(code).toBe(2);
    expect(stderr.text()).toContain("usage:");
    expect(runner).not.toHaveBeenCalled();
  });

  it("exits 1 when the runner throws", async () => {
    const fix = writeFixtures();
    const stderr = captureStderr();

    const code = await runCli(
      [
        "--out",
        fix.outPath,
        "--gold",
        fix.goldPath,
        "--corpus",
        fix.corpusPath,
      ],
      {
        runner: async () => {
          throw new Error("engine down");
        },
        logger: silentLogger(),
      }
    );

    stderr.restore();
    expect(code).toBe(1);
    expect(stderr.text()).toContain("engine down");
  });

  it("exits 3 with --loud-skip even on a successful run", async () => {
    const fix = writeFixtures();

    const code = await runCli(
      [
        "--out",
        fix.outPath,
        "--gold",
        fix.goldPath,
        "--corpus",
        fix.corpusPath,
        "--loud-skip",
      ],
      {
        runner: constantRunner({ meanPAt5: 0.5, meanRAt5: 0.5 }),
        logger: silentLogger(),
      }
    );

    expect(code).toBe(3);
  });
});

/* ------------------------------------------------------------------------ */
/* Runner injection — happy path                                            */
/* ------------------------------------------------------------------------ */

describe("runCli — runner injection", () => {
  it("invokes the runner 10 configurations × N repeats", async () => {
    const fix = writeFixtures();
    const calls: Array<{ id: string; repeat: number }> = [];
    const runner: AblationRunner = async ({ config, repeat }) => {
      calls.push({ id: config.id, repeat });
      return { meanPAt5: 0.5, meanRAt5: 0.5 };
    };

    await runCli(
      [
        "--out",
        fix.outPath,
        "--gold",
        fix.goldPath,
        "--corpus",
        fix.corpusPath,
        "--repeat",
        "1",
      ],
      { runner, logger: silentLogger() }
    );

    expect(calls).toHaveLength(10);
    const ids = new Set(calls.map((c) => c.id));
    expect(ids).toContain("all-on");
    expect(ids).toContain("all-off");
    for (const key of ABLATION_CAPABILITY_KEYS) {
      expect(ids).toContain(`off-${key}`);
    }
    for (const call of calls) {
      expect(call.repeat).toBe(1);
    }
  });

  it("writes byte-identical JSON + Markdown on a second run", async () => {
    const fix = writeFixtures();
    const deps: EvalStackDeps = {
      runner: constantRunner({ meanPAt5: 0.5, meanRAt5: 0.5 }),
      logger: silentLogger(),
    };
    const argv = [
      "--out",
      fix.outPath,
      "--gold",
      fix.goldPath,
      "--corpus",
      fix.corpusPath,
      "--repeat",
      "1",
    ];
    await runCli(argv, deps);
    const json1 = readFileSync(`${fix.outPath}.json`, "utf8");
    const md1 = readFileSync(`${fix.outPath}.md`, "utf8");
    await runCli(argv, deps);
    const json2 = readFileSync(`${fix.outPath}.json`, "utf8");
    const md2 = readFileSync(`${fix.outPath}.md`, "utf8");
    expect(json2).toBe(json1);
    expect(md2).toBe(md1);
  });

  it("zeros the all-on baseline percentage change and surfaces per-config changes", async () => {
    const fix = writeFixtures();
    // Baseline (all-on) returns 0.5; every single-off returns 0.25
    // so every non-baseline row reports -50% P@5.
    const runner: AblationRunner = async ({ config }) => {
      if (config.id === "all-on") {
        return { meanPAt5: 0.5, meanRAt5: 1.0 };
      }
      return { meanPAt5: 0.25, meanRAt5: 0.5 };
    };

    await runCli(
      [
        "--out",
        fix.outPath,
        "--gold",
        fix.goldPath,
        "--corpus",
        fix.corpusPath,
        "--repeat",
        "1",
      ],
      { runner, logger: silentLogger() }
    );

    const json = JSON.parse(readFileSync(`${fix.outPath}.json`, "utf8")) as {
      configs: Array<{
        id: string;
        median: { meanPAt5: number; meanRAt5: number };
        percentageChange: { meanPAt5: number; meanRAt5: number };
      }>;
    };
    const baseline = json.configs.find((c) => c.id === "all-on");
    expect(baseline?.percentageChange).toEqual({ meanPAt5: 0, meanRAt5: 0 });
    const offVector = json.configs.find((c) => c.id === "off-vector");
    expect(offVector?.percentageChange.meanPAt5).toBe(-50);
    expect(offVector?.median.meanPAt5).toBe(0.25);
  });
});

/* ------------------------------------------------------------------------ */
/* Single-config mode                                                      */
/* ------------------------------------------------------------------------ */

describe("runCli — single-config mode", () => {
  it("runs only the requested configuration id", async () => {
    const fix = writeFixtures();
    const calls: string[] = [];
    const runner: AblationRunner = async ({ config }) => {
      calls.push(config.id);
      return { meanPAt5: 0.5, meanRAt5: 0.5 };
    };

    await runCli(
      [
        "--out",
        fix.outPath,
        "--gold",
        fix.goldPath,
        "--corpus",
        fix.corpusPath,
        "--single",
        "off-vector",
      ],
      { runner, logger: silentLogger() }
    );

    expect(calls).toEqual(["off-vector"]);
  });

  it("rejects an unknown configuration id", async () => {
    const fix = writeFixtures();
    const stderr = captureStderr();

    const code = await runCli(
      [
        "--out",
        fix.outPath,
        "--gold",
        fix.goldPath,
        "--corpus",
        fix.corpusPath,
        "--single",
        "off-nope",
      ],
      {
        runner: constantRunner({ meanPAt5: 0, meanRAt5: 0 }),
        logger: silentLogger(),
      }
    );

    stderr.restore();
    expect(code).toBe(1);
    expect(stderr.text()).toContain("off-nope");
  });
});

/* ------------------------------------------------------------------------ */
/* translateCapabilities — capability → RetrieveConfig                      */
/* ------------------------------------------------------------------------ */

describe("translateCapabilities", () => {
  const base = {
    preset: "balanced" as const,
    rrfK: 60,
    w_vec: 0.7,
    w_bm25: 0.15,
    w_graph: 0.15,
    bm25Enabled: true,
    graphEnabled: true,
    rerankEnabled: true,
    entityLinkTopK: 8,
    candidateCap: 50,
    neighborWidth: 0,
    graphArmFloor: 3,
  };

  const allOn: Record<AblationCapability, boolean> = {
    vector: true,
    keyword_bm25: true,
    cjk_segmentation: true,
    phrase: true,
    field_boost: true,
    graph_ppr: true,
    rrf: true,
    rerank: true,
  };

  it("maps every §B4 key onto its orchestrator field", () => {
    const result = translateCapabilities(allOn, base);
    expect(result.bm25Enabled).toBe(true);
    expect(result.graphEnabled).toBe(true);
    expect(result.rerankEnabled).toBe(true);
    expect(result.cjkSegmentationEnabled).toBe(true);
    expect(result.phraseEnabled).toBe(true);
    expect(result.fieldBoostEnabled).toBe(true);
  });

  it("turns off keyword_bm25 → bm25Enabled = false", () => {
    const result = translateCapabilities(
      { ...allOn, keyword_bm25: false },
      base
    );
    expect(result.bm25Enabled).toBe(false);
  });

  it("turns off rrf by zeroing cross-arm weights", () => {
    const result = translateCapabilities({ ...allOn, rrf: false }, base);
    expect(result.w_vec).toBe(1);
    expect(result.w_bm25).toBe(0);
    expect(result.w_graph).toBe(0);
  });

  it("leaves vector=off to the runner (no config knob throws)", () => {
    // `vector` is not a RetrieveConfig field; the production runner
    // expresses it by swapping in UnavailableEmbedder. The translation
    // itself must not throw so the off-vector / all-off rows stay
    // runnable and their degraded behavior measurable (SC-23 D2).
    const result = translateCapabilities({ ...allOn, vector: false }, base);
    expect(result.bm25Enabled).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* CLI isolation — does not import from src/tools/, src/index, etc.        */
/* ------------------------------------------------------------------------ */

describe("eval-stack CLI isolation", () => {
  it("does not import from src/tools or src/index", () => {
    // The grep guard mirrors tests/cli/eval.unit.test.ts SC3 / A14,
    // applied here to the new CLI. The runner port imports from
    // `src/core/retrieval` (the production assembler) — that one is
    // intentionally allowed and is the only retrieval import.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const cliPath = join(
      import.meta.dirname,
      "..",
      "..",
      "src",
      "cli",
      "eval-stack.ts"
    );
    const src = readFileSync(cliPath, "utf8");
    const forbidden: RegExp[] = [
      /from\s+["'][^"']*src\/tools\//,
      /from\s+["'][^"']*src\/index(?:\.js)?["']/,
    ];
    const hits: string[] = [];
    for (const re of forbidden) {
      const m = src.match(re);
      if (m) hits.push(m[0]);
    }
    if (hits.length > 0) {
      throw new Error(
        `src/cli/eval-stack.ts imports from a forbidden module: ${hits.join("; ")}. ` +
          `The retrieval eval CLI must stay isolated from Host/MCP surfaces (specs/retrieve-p5.md SC3, A14).`
      );
    }
    expect(hits).toEqual([]);
  });
});
